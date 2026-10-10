import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
import { pollUntil } from "./poll";

// Lectura **independiente** de la red Stellar desde la suite (contrato de la Ola 3 §14): lo que
// la API dice que emitió o ancló se comprueba contra el RPC público, sin pasar por el backend.
//
// - Solo lectura y **sin claves**: las funciones del contrato se leen por simulación
//   (`simulateTransaction`), que no firma ni envía nada; las transacciones, con `getTransaction`.
// - Solo direcciones públicas: las que devuelve la API (`GET /v1/public/chain/registry`, la
//   identidad de la bodega, los `ChainTxRef`).
// - El RPC guarda unos 7 días de historial: se lee lo que la ejecución acaba de confirmar.

/** RPC público de testnet (Stellar Development Foundation); sin credenciales. */
export const DEFAULT_STELLAR_RPC_URL = "https://soroban-testnet.stellar.org";

/** RPC de la red del entorno: `E2E_STELLAR_RPC_URL` (por defecto, el público de testnet). */
export const STELLAR_RPC_URL = (process.env.E2E_STELLAR_RPC_URL?.trim() || DEFAULT_STELLAR_RPC_URL).replace(/\/+$/, "");

/** Lo que la suite comprueba de una transacción leída de la red. */
export interface TransactionFacts {
  /** Cuenta de origen (la interna, si es un *fee bump*). */
  source: string;
  /** Memo `MEMO_HASH` en hexadecimal (los 32 bytes de la huella anclada), o `null` si no lo lleva. */
  memoHashHex: string | null;
  /** Número de operaciones. */
  operations: number;
}

/** Origen y memo de un sobre de transacción (`envelopeXdr` en base64). */
export function transactionFacts(envelopeXdr: string, networkPassphrase: string): TransactionFacts {
  const parsed = TransactionBuilder.fromXdr(envelopeXdr, networkPassphrase);
  const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
  const memo = tx.memo;
  const value: unknown = memo.value;
  const memoHashHex =
    memo.type === "hash" && value instanceof Uint8Array
      ? Buffer.from(value).toString("hex")
      : memo.type === "hash" && typeof value === "string"
        ? Buffer.from(value, "base64").toString("hex")
        : null;
  return { source: tx.source, memoHashHex, operations: tx.operations.length };
}

/** Los 32 bytes de una huella SHA-256 en hexadecimal → base64 (como los muestra algún explorador). */
export function hashHexToBase64(hex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("La huella debe ser SHA-256 en hexadecimal (64 caracteres)");
  return Buffer.from(hex, "hex").toString("base64");
}

/** Valor devuelto por una función de lectura, ya como número, texto o booleano de JavaScript. */
function plain(value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

interface RawTransaction {
  status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  ledger?: number;
  envelopeXdr?: string;
}

export interface ConfirmedTransaction extends TransactionFacts {
  hash: string;
  ledger: number;
}

export class ChainReader {
  private readonly server: rpc.Server;

  constructor(
    readonly networkPassphrase: string,
    readonly rpcUrl: string = STELLAR_RPC_URL,
  ) {
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  }

  /**
   * Lee una función del contrato por simulación. `source` es cualquier cuenta que exista en la red
   * (la de la bodega): la simulación no gasta su saldo ni su secuencia, y no se firma nada.
   */
  async read(contract: string, source: string, fn: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(new Account(source, "0"), {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(new Contract(contract).call(fn, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}() de ${contract}: ${sim.error}`);
    if (rpc.Api.isSimulationRestore(sim)) {
      throw new Error(`${fn}() de ${contract}: hay entradas archivadas que restaurar`);
    }
    if (!sim.result) throw new Error(`${fn}() de ${contract}: la simulación no devolvió ningún valor`);
    return plain(scValToNative(sim.result.retval));
  }

  private async readNumber(contract: string, source: string, fn: string, ...args: xdr.ScVal[]): Promise<number> {
    const value = await this.read(contract, source, fn, ...args);
    if (typeof value !== "number") throw new Error(`${fn}() de ${contract} no devolvió un número: ${String(value)}`);
    return value;
  }

  /** `total_minted()`: NFT emitidos por el contrato de la bodega (incluye los quemados). */
  totalMinted(contract: string, source: string): Promise<number> {
    return this.readNumber(contract, source, "total_minted");
  }

  /** `balance(cuenta)`: NFT a nombre de `account` en el contrato. */
  balance(contract: string, account: string): Promise<number> {
    return this.readNumber(contract, account, "balance", new Address(account).toScVal());
  }

  /** `owner_of(id)`: dueño del NFT (falla si no existe o está quemado). */
  async ownerOf(contract: string, source: string, tokenId: number): Promise<string> {
    return String(await this.read(contract, source, "owner_of", nativeToScVal(tokenId, { type: "u32" })));
  }

  /** `symbol()`: el prefijo de lote de la bodega. */
  async symbol(contract: string, source: string): Promise<string> {
    return String(await this.read(contract, source, "symbol"));
  }

  /** `paused()`: contrato pausado en la red. */
  async paused(contract: string, source: string): Promise<boolean> {
    return (await this.read(contract, source, "paused")) === true;
  }

  /** `getTransaction` sin decodificar por el SDK (solo se interpreta el sobre). */
  private async rawTransaction(hash: string): Promise<RawTransaction> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`getTransaction → HTTP ${response.status}`);
    const body = (await response.json()) as { result?: RawTransaction; error?: { message?: string } };
    if (!body.result) throw new Error(`getTransaction: ${body.error?.message ?? "respuesta sin resultado"}`);
    return body.result;
  }

  /**
   * Espera a que el RPC conozca la transacción (puede ir unos segundos por detrás del backend) y
   * devuelve su origen y su memo. Una transacción `FAILED` en la red corta la espera.
   */
  async confirmedTransaction(hash: string, timeoutMs = 60_000): Promise<ConfirmedTransaction> {
    const found = await pollUntil(
      () => this.rawTransaction(hash),
      (tx) => tx.status === "SUCCESS",
      {
        what: `transacción ${hash.slice(0, 8)}… confirmada en el RPC`,
        timeoutMs,
        intervalMs: 2_000,
        describe: (tx) => tx.status,
        failed: (tx) => (tx.status === "FAILED" ? "la red la registra como FAILED" : null),
      },
    );
    if (!found.envelopeXdr || found.ledger === undefined) {
      throw new Error(`getTransaction ${hash}: SUCCESS sin sobre o sin ledger`);
    }
    return { hash, ledger: found.ledger, ...transactionFacts(found.envelopeXdr, this.networkPassphrase) };
  }
}

export interface ExplorerCheck {
  status: number;
  /** El explorador respondió con la página (2xx) o la protegió de robots (401, 403 o 429). */
  reachable: boolean;
  /** Respondió con contenido (2xx). */
  ok: boolean;
}

/**
 * Pide la página del explorador que devuelve el backend (`explorerUrl`). El explorador es de un
 * tercero y puede frenar a los robots: 401, 403 y 429 cuentan como "responde" (`reachable`) pero
 * no como `ok`; un 404 o un 5xx, no.
 */
export async function checkExplorerUrl(url: string, timeoutMs = 30_000): Promise<ExplorerCheck> {
  if (!/^https:\/\//.test(url)) throw new Error(`explorerUrl no es https: ${url}`);
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "drinks-on-chain-e2e" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.body?.cancel();
  const ok = response.status >= 200 && response.status < 300;
  return { status: response.status, ok, reachable: ok || [401, 403, 429].includes(response.status) };
}

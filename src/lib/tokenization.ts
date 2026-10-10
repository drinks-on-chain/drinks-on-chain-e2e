import type { ApiClient } from "./api";
import { pollUntil } from "./poll";

// API de la Ola 3 (contrato plan/contratos/o3-tokenizacion.md; manda el OpenAPI del backend):
// identidad de la bodega en la red, solicitudes de tokenización, colecciones y emisiones, anclaje
// del expediente y conciliación. Tipos con lo que usan los recorridos y esperas con tope para lo
// que confirma la red (testnet cierra un ledger cada pocos segundos; el worker va por detrás).

/** Rutas de la Ola 3 que el recorrido H3 necesita desplegadas (`missingRoutes`). */
export const H3_ROUTES = [
  "/.well-known/stellar.toml",
  "/v1/public/chain/registry",
  "/v1/public/lots/{lotCode}/verification",
  "/v1/organizations/current/chain-account",
  "/v1/platform/wineries/{id}/chain-account",
  "/v1/lots/{id}/tokenization",
  "/v1/lots/{id}/tokenization-requests",
  "/v1/tokenization-requests/{id}",
  "/v1/tokenization-requests/{id}/resubmit",
  "/v1/collections/{id}",
  "/v1/platform/tokenization-requests",
  "/v1/platform/tokenization-requests/{id}/take",
  "/v1/platform/tokenization-requests/{id}/request-changes",
  "/v1/platform/tokenization-requests/{id}/approve",
  "/v1/platform/collections/{id}",
  "/v1/platform/collections/{id}/publish",
  "/v1/platform/collections/{id}/pause",
  "/v1/platform/collections/{id}/resume",
  "/v1/platform/collections/{id}/tokens",
  "/v1/platform/chain/reconciliation/runs",
  "/v1/platform/chain/reconciliation/runs/{id}",
  "/v1/platform/chain/alerts",
] as const;

/**
 * Tope de cada espera a la red (identidad, emisión, anclaje, conciliación): `E2E_CHAIN_WAIT_MS`,
 * por defecto 4 minutos. El objetivo del backend es confirmar una emisión en menos de 60 s (p95);
 * el tope es generoso porque la cola del worker y testnet varían.
 */
export const CHAIN_WAIT_MS =
  Number(process.env.E2E_CHAIN_WAIT_MS) > 0 ? Number(process.env.E2E_CHAIN_WAIT_MS) : 240_000;

export type ChainIdentityStatus = "NOT_PROVISIONED" | "PROVISIONING" | "ACTIVE" | "FAILED" | "PAUSED";

export interface ChainTxRef {
  id: string;
  kind: string;
  status: "PENDING" | "BUILDING" | "SUBMITTED" | "CONFIRMED" | "RETRYING" | "FAILED";
  network: string;
  txHash: string | null;
  explorerUrl: string | null;
  ledger: number | null;
  lastError: { code?: string; message?: string } | null;
}

export interface WineryChainIdentity {
  wineryId: string;
  network: string;
  status: ChainIdentityStatus;
  account: { address: string; explorerUrl: string | null } | null;
  contract: {
    address: string;
    explorerUrl: string | null;
    name: string;
    symbol: string;
    operatorAddress: string;
    paused: boolean;
  } | null;
  lastError: { code?: string; message?: string } | null;
}

export interface TokenCounts {
  minted: number;
  available: number;
  sold: number;
  burned: number;
}

export interface DossierAnchor {
  status: "PENDING" | "SUBMITTED" | "ANCHORED" | "FAILED";
  network: string;
  account: string;
  memoHashHex: string;
  txHash: string | null;
  ledger: number | null;
  explorerUrl: string | null;
  verifiedAt?: string | null;
}

export interface WineryChainAccountView {
  identity: WineryChainIdentity;
  totals: TokenCounts;
  byLot: { lotId: string; name: string; collectionId: string; quota: number; counts: TokenCounts }[];
  recentTransactions: ChainTxRef[];
}

export interface PublicChainRegistry {
  network: string;
  networkPassphrase: string;
  platform: { operationsAccount: string | null; anchorAccount: string | null };
  wineries: {
    slug: string;
    tradeName: string;
    symbol: string;
    account: string;
    contract: string;
    accountExplorerUrl: string | null;
    contractExplorerUrl: string | null;
    paused: boolean;
  }[];
}

export type TokenizationRequestStatus =
  "SUBMITTED" | "IN_REVIEW" | "CHANGES_REQUESTED" | "APPROVED" | "REJECTED" | "WITHDRAWN";

export interface TokenizationRequest {
  id: string;
  lotId: string;
  kind: "INITIAL" | "QUOTA_INCREASE";
  status: TokenizationRequestStatus;
  quantity: number;
  resultingQuota: number;
  collectionId: string | null;
}

export interface MintRange {
  firstTokenId: number;
  lastTokenId: number;
  firstBottleNumber: number;
  lastBottleNumber: number;
}

export interface Mint {
  id: string;
  sequence: number;
  quantity: number;
  status: "PENDING" | "IN_PROGRESS" | "CONFIRMED" | "FAILED";
  lotArg: string;
  ranges: MintRange[];
  transactions: ChainTxRef[];
}

export interface Collection {
  id: string;
  lotId: string;
  status: "MINTING" | "READY" | "PUBLISHED" | "PAUSED" | "CLOSED";
  mintStatus: Mint["status"];
  saleState: "PRESALE" | "ON_SALE" | "SOLD_OUT" | null;
  quota: number;
  pendingMintQuantity: number;
  counts: TokenCounts;
  contract: { address: string; explorerUrl: string | null };
  redeemable: boolean;
  mints: Mint[];
  anchor: DossierAnchor | null;
}

export interface ReconciliationRun {
  id: string;
  scope: "ALL" | "CONTRACT" | "COLLECTION";
  subjectId: string | null;
  trigger: string;
  depth: "LIGHT" | "FULL";
  status: "RUNNING" | "OK" | "DIFFERENCES" | "ERROR";
  checks: number;
  issuesOpened: number;
  alerts?: { id: string; code: string; level: string; message: string }[];
}

/**
 * Por qué el entorno aún no puede emitir ni anclar, según su registro público (o `null` si está
 * listo): el backend de la Ola 3 puede estar desplegado con la cadena sin configurar (sin cuentas
 * de plataforma ni código del contrato; las escrituras responden 409 `CHN_DISABLED`).
 */
export function registryProblem(
  registry: Pick<PublicChainRegistry, "platform"> & { wasmHash?: string | null },
): string | null {
  const missing = [
    registry.platform.operationsAccount ? null : "cuenta de operaciones",
    registry.platform.anchorAccount ? null : "cuenta de anclaje",
    registry.wasmHash ? null : "código del contrato (wasmHash)",
  ].filter((m): m is string => m !== null);
  return missing.length > 0 ? `el registro público no tiene ${missing.join(", ")}` : null;
}

/** `registryProblem` del entorno (`GET /v1/public/chain/registry`, sin sesión). */
export async function chainProblem(client: ApiClient): Promise<string | null> {
  const result = await client.raw<PublicChainRegistry & { wasmHash?: string | null }>(
    "GET",
    "/v1/public/chain/registry",
  );
  if (!result.ok || !result.data) return `GET /v1/public/chain/registry → ${result.status}`;
  return registryProblem(result.data);
}

const txSummary = (txs: readonly ChainTxRef[]) =>
  txs.map((t) => `${t.kind} ${t.status}${t.lastError?.code ? ` (${t.lastError.code})` : ""}`).join(", ") || "ninguna";

/**
 * Espera a que la identidad de la bodega en la red esté `ACTIVE` (cuenta y contrato confirmados y
 * leídos de vuelta, contrato §3.1). `path` es la vista de la bodega
 * (`/v1/organizations/current/chain-account`) o la de plataforma
 * (`/v1/platform/wineries/{id}/chain-account`). `FAILED` corta la espera.
 */
export async function waitForChainIdentity(
  client: ApiClient,
  path: string,
  timeoutMs = CHAIN_WAIT_MS,
): Promise<WineryChainAccountView> {
  return pollUntil(
    () => client.get<WineryChainAccountView>(path),
    (view) => view.identity.status === "ACTIVE" && !!view.identity.account && !!view.identity.contract,
    {
      what: "identidad de la bodega en la red ACTIVE",
      timeoutMs,
      intervalMs: 4_000,
      describe: (view) =>
        `${view.identity.status}${view.identity.lastError?.code ? ` (${view.identity.lastError.code})` : ""}`,
      failed: (view) =>
        view.identity.status === "FAILED"
          ? `el aprovisionamiento falló (${view.identity.lastError?.code ?? "sin código"})`
          : null,
    },
  );
}

/** Colección por la API de plataforma. */
export const platformCollection = (platform: ApiClient, id: string) =>
  platform.get<Collection>(`/v1/platform/collections/${id}`);

/**
 * Espera a que la colección tenga `minted` NFT emitidos y confirmados (todas sus emisiones
 * `CONFIRMED`, ninguna pendiente). Una emisión `FAILED` corta la espera con su error.
 */
export async function waitForMinted(
  platform: ApiClient,
  collectionId: string,
  minted: number,
  timeoutMs = CHAIN_WAIT_MS,
): Promise<Collection> {
  return pollUntil(
    () => platformCollection(platform, collectionId),
    (c) =>
      c.mintStatus === "CONFIRMED" &&
      c.status !== "MINTING" &&
      c.pendingMintQuantity === 0 &&
      c.counts.minted === minted &&
      c.mints.every((m) => m.status === "CONFIRMED"),
    {
      what: `emisión confirmada (${minted} NFT) de la colección`,
      timeoutMs,
      intervalMs: 4_000,
      describe: (c) =>
        `${c.status}, emisión ${c.mintStatus}, ${c.counts.minted} emitidos, ${c.pendingMintQuantity} pendientes; transacciones: ${txSummary(c.mints.flatMap((m) => m.transactions))}`,
      failed: (c) =>
        c.mintStatus === "FAILED" ? `la emisión falló (${txSummary(c.mints.flatMap((m) => m.transactions))})` : null,
    },
  );
}

/**
 * Comprueba las emisiones confirmadas de una colección contra las cantidades esperadas, en orden
 * (`[100, 50]` = inicial de 100 y ampliación de 50). Devuelve los problemas encontrados (vacío si
 * todo cuadra): cada emisión confirmada y con su cantidad; números de botella 1…cuota sin huecos
 * (la ampliación empieza en la cuota anterior + 1, contrato §6.1); e ids de la red continuos
 * dentro de cada emisión y entre emisiones consecutivas.
 */
export function mintProblems(mints: readonly Mint[], expected: readonly number[]): string[] {
  const problems: string[] = [];
  const ordered = [...mints].sort((a, b) => a.sequence - b.sequence);
  if (ordered.length !== expected.length) {
    problems.push(`se esperaban ${expected.length} emisiones y hay ${ordered.length}`);
  }
  let nextBottle = 1;
  let nextToken: number | null = null;
  ordered.forEach((mint, index) => {
    const label = `emisión ${mint.sequence}`;
    const quantity = expected[index];
    if (mint.sequence !== index + 1) problems.push(`${label}: se esperaba la secuencia ${index + 1}`);
    if (mint.status !== "CONFIRMED") problems.push(`${label}: está ${mint.status}`);
    if (quantity !== undefined && mint.quantity !== quantity) {
      problems.push(`${label}: ${mint.quantity} NFT en lugar de ${quantity}`);
    }
    if (mint.ranges.length === 0) problems.push(`${label}: sin rangos`);
    let covered = 0;
    for (const range of mint.ranges) {
      const bottles = range.lastBottleNumber - range.firstBottleNumber + 1;
      const tokens = range.lastTokenId - range.firstTokenId + 1;
      if (bottles !== tokens || bottles < 1) {
        problems.push(`${label}: el rango de botellas (${bottles}) no coincide con el de ids (${tokens})`);
      }
      if (range.firstBottleNumber !== nextBottle) {
        problems.push(`${label}: empieza en la botella ${range.firstBottleNumber} y se esperaba la ${nextBottle}`);
      }
      if (nextToken !== null && range.firstTokenId !== nextToken) {
        problems.push(`${label}: empieza en el id ${range.firstTokenId} y se esperaba el ${nextToken} (ids continuos)`);
      }
      nextBottle = range.lastBottleNumber + 1;
      nextToken = range.lastTokenId + 1;
      covered += bottles;
    }
    if (mint.ranges.length > 0 && covered !== mint.quantity) {
      problems.push(`${label}: sus rangos cubren ${covered} botellas de ${mint.quantity}`);
    }
  });
  return problems;
}

/** Primera transacción confirmada de una emisión (la del primer trozo), con hash y enlace. */
export function mintTransaction(mint: Mint | undefined): ChainTxRef & { txHash: string; explorerUrl: string } {
  const tx = mint?.transactions.find((t) => t.status === "CONFIRMED" && t.txHash && t.explorerUrl);
  if (!tx?.txHash || !tx.explorerUrl) {
    throw new Error(`La emisión ${mint?.sequence ?? "?"} no tiene una transacción confirmada con hash y explorerUrl`);
  }
  return { ...tx, txHash: tx.txHash, explorerUrl: tx.explorerUrl };
}

interface LotWithStage {
  stage: string;
}
interface DossierWithAnchor {
  status: "OPEN" | "CLOSED";
  hash: string | null;
  anchor: DossierAnchor | null;
}

/**
 * Espera a que el expediente cerrado quede anclado en la red (contrato §7.2): anclaje `ANCHORED`
 * con su transacción y lote `ANCHORED`. `member` es una sesión de la bodega. Un anclaje `FAILED`
 * corta la espera (se reintenta desde el back office).
 */
export async function waitForAnchor(
  member: ApiClient,
  lotId: string,
  timeoutMs = CHAIN_WAIT_MS,
): Promise<{ stage: string; hash: string; anchor: DossierAnchor & { txHash: string; explorerUrl: string } }> {
  const found = await pollUntil(
    async () => ({
      lot: await member.get<LotWithStage>(`/v1/lots/${lotId}`),
      dossier: await member.get<DossierWithAnchor>(`/v1/lots/${lotId}/dossier`),
    }),
    ({ lot, dossier }) =>
      lot.stage === "ANCHORED" &&
      dossier.anchor?.status === "ANCHORED" &&
      !!dossier.anchor.txHash &&
      !!dossier.anchor.explorerUrl,
    {
      what: "expediente anclado en la red y lote ANCHORED",
      timeoutMs,
      intervalMs: 4_000,
      describe: ({ lot, dossier }) => `lote ${lot.stage}, anclaje ${dossier.anchor?.status ?? "sin crear"}`,
      failed: ({ dossier }) => (dossier.anchor?.status === "FAILED" ? "el anclaje falló en la red" : null),
    },
  );
  const anchor = found.dossier.anchor;
  if (!anchor?.txHash || !anchor.explorerUrl || !found.dossier.hash) throw new Error("Anclaje sin transacción");
  return {
    stage: found.lot.stage,
    hash: found.dossier.hash,
    anchor: { ...anchor, txHash: anchor.txHash, explorerUrl: anchor.explorerUrl },
  };
}

/** Espera a que una conciliación termine (deja de estar `RUNNING`) y la devuelve con sus alertas. */
export async function waitForReconciliation(
  platform: ApiClient,
  runId: string,
  timeoutMs = CHAIN_WAIT_MS,
): Promise<ReconciliationRun> {
  return pollUntil(
    () => platform.get<ReconciliationRun>(`/v1/platform/chain/reconciliation/runs/${runId}`),
    (run) => run.status !== "RUNNING",
    {
      what: "conciliación terminada",
      timeoutMs,
      intervalMs: 4_000,
      describe: (run) => `${run.status}, ${run.checks} comprobaciones`,
    },
  );
}

/** PNG de 1 × 1 válido (el backend reconoce las imágenes por su firma de bytes). */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

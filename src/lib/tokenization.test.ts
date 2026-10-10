import { describe, expect, it } from "vitest";
import {
  H3_ROUTES,
  mintProblems,
  mintTransaction,
  registryProblem,
  TINY_PNG,
  type ChainTxRef,
  type Mint,
} from "./tokenization";

const tx = (over: Partial<ChainTxRef> = {}): ChainTxRef => ({
  id: "tx-1",
  kind: "MINT_BATCH",
  status: "CONFIRMED",
  network: "TESTNET",
  txHash: "a".repeat(64),
  explorerUrl: `https://explorador.example/tx/${"a".repeat(64)}`,
  ledger: 1234,
  lastError: null,
  ...over,
});

const mint = (sequence: number, quantity: number, firstBottle: number, firstToken: number, over: Partial<Mint> = {}) =>
  ({
    id: `mint-${sequence}`,
    sequence,
    quantity,
    status: "CONFIRMED",
    lotArg: "ABC-L2026-001",
    ranges: [
      {
        firstBottleNumber: firstBottle,
        lastBottleNumber: firstBottle + quantity - 1,
        firstTokenId: firstToken,
        lastTokenId: firstToken + quantity - 1,
      },
    ],
    transactions: [tx()],
    ...over,
  }) satisfies Mint;

describe("mintProblems", () => {
  it("acepta la emisión inicial de 100 y la ampliación de 50 con botellas 101–150 e ids continuos", () => {
    expect(mintProblems([mint(1, 100, 1, 0), mint(2, 50, 101, 100)], [100, 50])).toEqual([]);
    // Los ids de la red pueden empezar en otro número: lo que importa es que sigan.
    expect(mintProblems([mint(2, 50, 101, 107), mint(1, 100, 1, 7)], [100, 50])).toEqual([]);
  });

  it("acepta una emisión partida en trozos consecutivos", () => {
    const chunks = mint(1, 5, 1, 0, {
      ranges: [
        { firstBottleNumber: 1, lastBottleNumber: 3, firstTokenId: 0, lastTokenId: 2 },
        { firstBottleNumber: 4, lastBottleNumber: 5, firstTokenId: 3, lastTokenId: 4 },
      ],
    });
    expect(mintProblems([chunks], [5])).toEqual([]);
  });

  it("señala ids que no siguen a los de la emisión anterior", () => {
    expect(mintProblems([mint(1, 100, 1, 0), mint(2, 50, 101, 200)], [100, 50])).toEqual([
      "emisión 2: empieza en el id 200 y se esperaba el 100 (ids continuos)",
    ]);
  });

  it("señala botellas que no empiezan en la cuota anterior + 1", () => {
    expect(mintProblems([mint(1, 100, 1, 0), mint(2, 50, 1, 100)], [100, 50])).toEqual([
      "emisión 2: empieza en la botella 1 y se esperaba la 101",
    ]);
  });

  it("señala cantidades, estados y número de emisiones que no cuadran", () => {
    expect(mintProblems([mint(1, 100, 1, 0, { status: "IN_PROGRESS" })], [100, 50])).toEqual([
      "se esperaban 2 emisiones y hay 1",
      "emisión 1: está IN_PROGRESS",
    ]);
    expect(mintProblems([mint(1, 90, 1, 0)], [100])).toEqual(["emisión 1: 90 NFT en lugar de 100"]);
    expect(mintProblems([mint(1, 100, 1, 0, { ranges: [] })], [100])).toEqual(["emisión 1: sin rangos"]);
  });

  it("señala rangos que no cubren la cantidad o no casan botellas con ids", () => {
    const short = mint(1, 100, 1, 0, {
      ranges: [{ firstBottleNumber: 1, lastBottleNumber: 99, firstTokenId: 0, lastTokenId: 99 }],
    });
    expect(mintProblems([short], [100])).toEqual([
      "emisión 1: el rango de botellas (99) no coincide con el de ids (100)",
      "emisión 1: sus rangos cubren 99 botellas de 100",
    ]);
  });
});

describe("mintTransaction", () => {
  it("devuelve la transacción confirmada con hash y enlace", () => {
    const pending = tx({ id: "tx-0", status: "FAILED", txHash: null, explorerUrl: null });
    expect(mintTransaction(mint(1, 100, 1, 0, { transactions: [pending, tx()] })).id).toBe("tx-1");
  });

  it("falla con un mensaje claro si no hay ninguna", () => {
    expect(() => mintTransaction(mint(1, 100, 1, 0, { transactions: [tx({ status: "SUBMITTED" })] }))).toThrow(
      /emisión 1 no tiene una transacción confirmada/,
    );
    expect(() => mintTransaction(undefined)).toThrow(/emisión \?/);
  });
});

describe("constantes", () => {
  it("las rutas de H3 son rutas del backend sin repetir", () => {
    expect(new Set(H3_ROUTES).size).toBe(H3_ROUTES.length);
    for (const route of H3_ROUTES) expect(route).toMatch(/^\/(v1|\.well-known)\//);
  });

  it("la foto de prueba es un PNG", () => {
    expect(TINY_PNG.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});

describe("registryProblem", () => {
  const G = `G${"A".repeat(55)}`;

  it("un entorno con sus cuentas y el código del contrato está listo", () => {
    expect(
      registryProblem({ wasmHash: "e".repeat(64), platform: { operationsAccount: G, anchorAccount: G } }),
    ).toBeNull();
  });

  it("dice qué falta cuando la cadena está sin configurar", () => {
    expect(registryProblem({ wasmHash: null, platform: { operationsAccount: null, anchorAccount: null } })).toBe(
      "el registro público no tiene cuenta de operaciones, cuenta de anclaje, código del contrato (wasmHash)",
    );
    expect(registryProblem({ wasmHash: "e".repeat(64), platform: { operationsAccount: G, anchorAccount: null } })).toBe(
      "el registro público no tiene cuenta de anclaje",
    );
  });
});

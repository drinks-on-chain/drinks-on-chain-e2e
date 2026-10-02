import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bottleLeafHash,
  bottleProofRoot,
  merkleParent,
  merkleRootFromProof,
  sha256Hex,
  type MerkleStep,
} from "./merkle";

const bottles = [
  { serial: 1, code: "664TWFDA", salt: "00112233445566778899aabbccddeeff" },
  { serial: 2, code: "7T6BZK39", salt: "ffeeddccbbaa99887766554433221100" },
  { serial: 3, code: "K7M2Q9XM", salt: "0123456789abcdef0123456789abcdef" },
];
const leaves = bottles.map((b) => bottleLeafHash(b.serial, b.code, b.salt));
const [l1, l2, l3] = leaves as [string, string, string];
// Tres hojas: (1,2) se emparejan y la 3 sube tal cual.
const root = merkleParent(merkleParent(l1, l2), l3);

describe("merkle", () => {
  it("la hoja es SHA-256 del texto «serie:código:sal»", () => {
    expect(l1).toBe(createHash("sha256").update("1:664TWFDA:00112233445566778899aabbccddeeff").digest("hex"));
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("el padre se calcula sobre los bytes de los resúmenes, no sobre su texto hexadecimal", () => {
    const bytes = createHash("sha256")
      .update(Buffer.concat([Buffer.from(l1, "hex"), Buffer.from(l2, "hex")]))
      .digest("hex");
    const text = createHash("sha256")
      .update(l1 + l2)
      .digest("hex");
    expect(merkleParent(l1, l2)).toBe(bytes);
    expect(merkleParent(l1, l2)).not.toBe(text);
  });

  it("la prueba de cada botella reproduce la raíz", () => {
    const proofs: MerkleStep[][] = [
      [
        { side: "R", hash: l2 },
        { side: "R", hash: l3 },
      ],
      [
        { side: "L", hash: l1 },
        { side: "R", hash: l3 },
      ],
      [{ side: "L", hash: merkleParent(l1, l2) }],
    ];
    bottles.forEach((b, i) => {
      expect(bottleProofRoot(b.serial, b.code, { salt: b.salt, path: proofs[i] ?? [] })).toBe(root);
    });
  });

  it("otro código, otra serie u otro lado no dan la raíz", () => {
    const path: MerkleStep[] = [
      { side: "R", hash: l2 },
      { side: "R", hash: l3 },
    ];
    expect(bottleProofRoot(1, "664TWFDB", { salt: bottles[0]?.salt ?? "", path })).not.toBe(root);
    expect(bottleProofRoot(2, "664TWFDA", { salt: bottles[0]?.salt ?? "", path })).not.toBe(root);
    expect(merkleRootFromProof(l1, [{ side: "L", hash: l2 }, path[1] as MerkleStep])).not.toBe(root);
  });
});

import { createHash } from "node:crypto";

// Prueba Merkle de un código de botella frente al expediente cerrado de su lote (contrato de la
// Ola 2 §10 y §12.2), tal como la construye el backend (`sha256-merkle/serial-code-salt`):
//
// - Hoja: `SHA-256("{serie}:{código}:{sal}")` (texto UTF-8), en hexadecimal.
// - Padre: `SHA-256(izquierdo ‖ derecho)` sobre los **32 bytes** de cada resumen (no sobre su
//   texto hexadecimal). Un nodo sin pareja sube tal cual.
// - La prueba del pasaporte (`bottle.merkleProof`) trae la sal y los hermanos del camino, de la
//   hoja a la raíz, con el lado en que queda cada uno.
//
// El recorrido la recalcula por su cuenta para comprobar el dato real del backend, además de lo
// que pinta el visor.

export interface MerkleStep {
  /** `L`: el hermano va a la izquierda (`SHA-256(hermano ‖ actual)`); `R`: a la derecha. */
  side: "L" | "R";
  hash: string;
}

export interface MerkleProof {
  salt: string;
  path: MerkleStep[];
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();

/** SHA-256 en hexadecimal (huella del expediente canónico). */
export const sha256Hex = (data: Buffer | string) => sha256(data).toString("hex");

/** Hoja de una botella: `SHA-256("{serie}:{código}:{sal}")` en hexadecimal. */
export function bottleLeafHash(serial: number, code: string, salt: string): string {
  return sha256Hex(Buffer.from(`${serial}:${code}:${salt}`, "utf8"));
}

/** Padre de dos nodos (hexadecimal): SHA-256 de la concatenación de sus bytes. */
export function merkleParent(left: string, right: string): string {
  return sha256Hex(Buffer.concat([Buffer.from(left, "hex"), Buffer.from(right, "hex")]));
}

/** Raíz que resulta de subir desde `leaf` por el camino de la prueba. */
export function merkleRootFromProof(leaf: string, path: readonly MerkleStep[]): string {
  return path.reduce(
    (node, step) => (step.side === "L" ? merkleParent(step.hash, node) : merkleParent(node, step.hash)),
    leaf,
  );
}

/** Raíz Merkle que da la prueba de una botella (serie, código y prueba del pasaporte). */
export function bottleProofRoot(serial: number, code: string, proof: MerkleProof): string {
  return merkleRootFromProof(bottleLeafHash(serial, code, proof.salt), proof.path);
}

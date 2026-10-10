import { createHash } from "node:crypto";
import { Account, BASE_FEE, Keypair, Memo, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_STELLAR_RPC_URL, hashHexToBase64, transactionFacts } from "./stellar";

// Sin red: los sobres se construyen aquí con claves aleatorias de usar y tirar.

const hash = createHash("sha256").update("expediente de prueba").digest("hex");

/** Sobre como el del anclaje (contrato de la Ola 3 §7.1): `bumpSequence` sin efecto y `MEMO_HASH`. */
function anchorEnvelope(memo: Memo = Memo.hash(hash)) {
  const anchor = Keypair.random();
  const tx = new TransactionBuilder(new Account(anchor.publicKey(), "41"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "41" }))
    .addMemo(memo)
    .setTimeout(30)
    .build();
  tx.sign(anchor);
  return { anchor, tx, envelope: tx.toXdr() };
}

describe("transactionFacts", () => {
  it("devuelve la cuenta de origen y el memo de la huella en hexadecimal", () => {
    const { anchor, envelope } = anchorEnvelope();
    expect(transactionFacts(envelope, Networks.TESTNET)).toEqual({
      source: anchor.publicKey(),
      memoHashHex: hash,
      operations: 1,
    });
  });

  it("sin MEMO_HASH no hay huella (un memo de texto no cuenta)", () => {
    expect(transactionFacts(anchorEnvelope(Memo.text("hola")).envelope, Networks.TESTNET).memoHashHex).toBeNull();
    expect(transactionFacts(anchorEnvelope(Memo.none()).envelope, Networks.TESTNET).memoHashHex).toBeNull();
  });

  it("de un fee bump lee la transacción interna", () => {
    const { anchor, tx } = anchorEnvelope();
    const payer = Keypair.random();
    const bump = TransactionBuilder.buildFeeBumpTransaction(payer, BASE_FEE, tx, Networks.TESTNET);
    const facts = transactionFacts(bump.toXdr(), Networks.TESTNET);
    expect(facts).toMatchObject({ source: anchor.publicKey(), memoHashHex: hash });
  });
});

describe("hashHexToBase64", () => {
  it("convierte los 32 bytes de la huella", () => {
    expect(Buffer.from(hashHexToBase64(hash), "base64").toString("hex")).toBe(hash);
    expect(hashHexToBase64("00".repeat(32))).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  });

  it("rechaza lo que no es un SHA-256 en hexadecimal", () => {
    expect(() => hashHexToBase64("abc")).toThrow(/SHA-256/);
  });
});

describe("RPC por defecto", () => {
  it("es el público de testnet, sin credenciales en la URL", () => {
    expect(new URL(DEFAULT_STELLAR_RPC_URL)).toMatchObject({
      protocol: "https:",
      username: "",
      password: "",
      search: "",
    });
  });
});

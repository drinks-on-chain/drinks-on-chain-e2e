import { createHmac } from "node:crypto";

// Códigos TOTP (RFC 6238: HMAC-SHA1, 6 dígitos, pasos de 30 s) a partir de un secreto base32,
// como los genera la app de autenticación del personal de plataforma. Sin dependencias.

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;

/** Decodifica base32 (RFC 4648), tolerando espacios, minúsculas y relleno `=`. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, "").toUpperCase();
  if (!clean) throw new Error("Secreto TOTP vacío");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error(`Carácter no válido en el secreto base32: «${ch}»`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) para un contador. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(msg).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

/** Código TOTP de 6 dígitos para `secret` (base32) en el instante `now` (ms). */
export function totp(secret: string, now: number = Date.now(), digits = 6): string {
  return hotp(base32Decode(secret), Math.floor(now / 1000 / TOTP_STEP_SECONDS), digits);
}

/** Milisegundos que le quedan al código actual. */
export function totpRemainingMs(now: number = Date.now()): number {
  const step = TOTP_STEP_SECONDS * 1000;
  return step - (now % step);
}

/** Último código entregado por `freshTotp` para cada secreto (el backend no admite repetirlo). */
const lastIssued = new Map<string, string>();

/**
 * Código TOTP que seguirá valiendo al menos `marginMs` y que no se ha usado ya en este proceso con
 * el mismo secreto (un código TOTP es de un solo uso): si hace falta, espera al siguiente paso de
 * 30 s. Úsalo antes de teclear o enviar un código.
 */
export async function freshTotp(secret: string, marginMs = 3_000): Promise<string> {
  const key = secret.replace(/[\s=]/g, "").toUpperCase();
  for (;;) {
    const left = totpRemainingMs();
    if (left < marginMs) {
      await new Promise((r) => setTimeout(r, left + 200));
      continue;
    }
    const code = totp(key);
    if (lastIssued.get(key) !== code) {
      lastIssued.set(key, code);
      return code;
    }
    await new Promise((r) => setTimeout(r, left + 200));
  }
}

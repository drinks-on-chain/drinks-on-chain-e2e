import { randomBytes } from "node:crypto";

// Prefijo único por ejecución (plan/04 §5): todo lo que la suite crea en el entorno lleva este
// prefijo, así una ejecución nunca choca con otra ni con la semilla, y sus datos se reconocen.

const RUN_ID = /^e2e-\d{8}t\d{4}-[a-z0-9]{4,8}$/;

/** `e2e-<AAAAMMDD>t<HHMM>-<aleatorio>` en UTC, p. ej. `e2e-20260927t1630-k3v9q2`. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "t");
  const random = Array.from(randomBytes(6), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  return `e2e-${stamp}-${random}`;
}

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

/**
 * Prefijo de la ejecución en curso. `globalSetup` lo fija en `E2E_RUN_ID` para que todos los
 * workers compartan el mismo; también se puede fijar desde fuera para repetir una ejecución.
 */
export function currentRunId(): string {
  const fromEnv = process.env.E2E_RUN_ID?.trim().toLowerCase();
  if (fromEnv) {
    if (!isRunId(fromEnv)) throw new Error(`E2E_RUN_ID no tiene la forma e2e-AAAAMMDDtHHMM-xxxx: ${fromEnv}`);
    return fromEnv;
  }
  const id = newRunId();
  process.env.E2E_RUN_ID = id;
  return id;
}

/** Dominio reservado para pruebas (RFC 2606): los correos nunca salen del entorno. */
export const TEST_EMAIL_DOMAIN = "example.test";

/**
 * Correo de una persona creada por la ejecución: `<alias>+<runId>@example.test`. El alias
 * distingue a cada persona de un mismo recorrido (`duena`, `enologa`…).
 */
export function runEmail(runId: string, alias: string): string {
  const clean = alias
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "");
  if (!clean) throw new Error(`Alias de correo vacío: «${alias}»`);
  return `${clean}+${runId}@${TEST_EMAIL_DOMAIN}`;
}

/**
 * Nombre visible con el prefijo de la ejecución (bodegas, parcelas…): `<nombre> · <runId>`. El
 * nombre va delante porque el backend deriva de él cosas visibles (el prefijo de lote).
 */
export function runName(runId: string, name: string): string {
  return `${name} · ${runId}`;
}

/** NIT de prueba único por ejecución: 10 dígitos que empiezan por 9 (derivados del prefijo). */
export function runTaxId(runId: string, salt = ""): string {
  let hash = 0;
  for (const ch of `${runId}:${salt}`) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `9${String(hash % 1_000_000_000).padStart(9, "0")}`;
}

/**
 * Contraseña de las personas que crea una ejecución: `Pw-e2e-<aleatorio>` (≥ 10 caracteres, no
 * común). El prefijo `Pw-e2e-` permite que el filtro de secretos (`redact`) la oculte siempre.
 */
export function runPassword(): string {
  return `Pw-e2e-${randomBytes(9).toString("hex")}`;
}

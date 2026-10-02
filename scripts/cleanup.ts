/**
 * Limpia una o varias ejecuciones anteriores (por si su afterAll no llegó a correr):
 *
 *   pnpm cleanup e2e-20260927t1630-abcd [e2e-…]
 *
 * Con la sesión ADMIN de demo (E2E_PASSWORD y E2E_TOTP_SECRET en el entorno): bloquea las cuentas
 * de la ejecución, anula sus invitaciones y revoca con motivo sus bodegas, que así salen de la
 * lista pública (`GET /v1/public/wineries`). Con la sesión del dueño de la bodega de demostración
 * del recorrido H2: descarta los lotes de la ejecución que la API deja descartar (los de
 * expediente cerrado se quedan). Solo toca datos con el prefijo de la ejecución.
 */
import { DEMO_PASSWORD, DEMO_TOTP_SECRET } from "../src/config";
import { PLATFORM, WINERY } from "../src/fixtures/users";
import { ApiClient } from "../src/lib/api";
import { deactivateRunAccounts, discardRunLots, publicWineryNames, retireRunWineries } from "../src/lib/cleanup";
import { isRunId } from "../src/lib/run-id";

const runIds = process.argv
  .slice(2)
  .flatMap((arg) => arg.split(/[\s,]+/))
  .filter(Boolean);
if (runIds.length === 0 || !runIds.every(isRunId)) {
  throw new Error("Indica los prefijos de las ejecuciones: pnpm cleanup e2e-AAAAMMDDtHHMM-xxxx [e2e-…]");
}
if (!DEMO_PASSWORD || !DEMO_TOTP_SECRET) throw new Error("Faltan E2E_PASSWORD y E2E_TOTP_SECRET en el entorno");
process.env.E2E_RUN_ID = runIds[0];

const list = (items: string[]) => items.join(", ") || "ninguna";
let failed = false;

const admin = await ApiClient.create("limpieza");
try {
  await admin.login(PLATFORM.admin.email, DEMO_PASSWORD, DEMO_TOTP_SECRET);
  console.log(`Lista pública de bodegas antes: ${list(await publicWineryNames(admin))}`);
  for (const runId of runIds) {
    const reason = `Limpieza del recorrido E2E ${runId}`;
    console.log(`\n${runId}`);
    const accounts = await deactivateRunAccounts(admin, runId, reason);
    console.log(`  Cuentas bloqueadas: ${list(accounts.blocked)}`);
    console.log(`  Ya bloqueadas: ${list(accounts.alreadyBlocked)}`);
    console.log(`  Invitaciones anuladas: ${list(accounts.revokedInvitations)}`);
    const wineries = await retireRunWineries(admin, runId, reason);
    console.log(`  Bodegas revocadas: ${list(wineries.revoked)}`);
    console.log(`  Ya revocadas: ${list(wineries.alreadyRevoked)}`);
    if (accounts.remaining.length) {
      console.error(`  Cuentas que siguen activas: ${accounts.remaining.join(", ")}`);
      failed = true;
    }
    if (wineries.stillPublic.length) {
      console.error(`  Bodegas que siguen en la lista pública: ${wineries.stillPublic.join(", ")}`);
      failed = true;
    }
  }
  console.log(`\nLista pública de bodegas después: ${list(await publicWineryNames(admin))}`);
} finally {
  await admin.logout();
  await admin.dispose();
}

// Lotes de la ejecución en la bodega de demostración del recorrido H2 (la plataforma solo lee la
// trazabilidad: los descarta una persona de la bodega).
const owner = await ApiClient.create("limpieza de lotes");
try {
  await owner.login(WINERY.cintiOwner.email, DEMO_PASSWORD);
  for (const runId of runIds) {
    const lots = await discardRunLots(owner, runId, `Limpieza del recorrido E2E ${runId}`);
    console.log(`${runId} · lotes descartados: ${list(lots.discarded)}`);
    if (lots.kept.length) console.log(`${runId} · lotes con el expediente cerrado (se quedan): ${list(lots.kept)}`);
  }
} finally {
  await owner.logout();
  await owner.dispose();
}

if (failed) process.exitCode = 1;

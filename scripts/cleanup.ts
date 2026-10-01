/**
 * Bloquea las cuentas y anula las invitaciones de una ejecución anterior (por si su afterAll no
 * llegó a correr). Usa la sesión ADMIN de demo (E2E_PASSWORD y E2E_TOTP_SECRET en el entorno):
 *
 *   pnpm cleanup e2e-20260927t1630-abcd
 */
import { DEMO_PASSWORD, DEMO_TOTP_SECRET } from "../src/config";
import { PLATFORM } from "../src/fixtures/users";
import { ApiClient } from "../src/lib/api";
import { deactivateRunAccounts } from "../src/lib/cleanup";
import { isRunId } from "../src/lib/run-id";

const runId = process.argv[2] ?? "";
if (!isRunId(runId)) throw new Error("Indica el prefijo de la ejecución: pnpm cleanup e2e-AAAAMMDDtHHMM-xxxx");
if (!DEMO_PASSWORD || !DEMO_TOTP_SECRET) throw new Error("Faltan E2E_PASSWORD y E2E_TOTP_SECRET en el entorno");
process.env.E2E_RUN_ID = runId;
const admin = await ApiClient.create("limpieza");
try {
  await admin.login(PLATFORM.admin.email, DEMO_PASSWORD, DEMO_TOTP_SECRET);
  const r = await deactivateRunAccounts(admin, runId, `Limpieza del recorrido E2E ${runId}`);
  console.log(`Bloqueadas: ${r.blocked.join(", ") || "ninguna"}`);
  console.log(`Ya bloqueadas: ${r.alreadyBlocked.join(", ") || "ninguna"}`);
  console.log(`Invitaciones anuladas: ${r.revokedInvitations.join(", ") || "ninguna"}`);
  if (r.remaining.length) {
    console.error(`Siguen activas: ${r.remaining.join(", ")}`);
    process.exitCode = 1;
  }
} finally {
  await admin.logout();
  await admin.dispose();
}

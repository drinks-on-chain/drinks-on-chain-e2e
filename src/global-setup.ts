import type { FullConfig } from "@playwright/test";
import { API_ORIGIN } from "./config";
import { currentRunId } from "./lib/run-id";
import { transportFromEnv } from "./lib/mailbox";

// Fija el prefijo de la ejecución para todos los workers (E2E_RUN_ID) y deja constancia de contra
// qué se ejecuta. No imprime secretos: solo si están definidos.
export default function globalSetup(config: FullConfig) {
  const runId = currentRunId();
  const projects = config.projects.map((p) => `${p.name} → ${p.use.baseURL ?? "?"}`);
  const mail = transportFromEnv()?.kind ?? "sin buzón";
  console.log(
    [
      `E2E · ejecución ${runId}`,
      `  backend: ${API_ORIGIN}`,
      `  apps: ${projects.join(" · ")}`,
      `  buzón: ${mail} · E2E_PASSWORD ${process.env.E2E_PASSWORD ? "definida" : "sin definir"} · E2E_TOTP_SECRET ${process.env.E2E_TOTP_SECRET ? "definida" : "sin definir"}`,
    ].join("\n"),
  );
}

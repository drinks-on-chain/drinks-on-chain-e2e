import type { ApiClient, Page } from "./api";

// Limpieza de una ejecución. Solo toca lo que lleva el prefijo de la ejecución (`+<runId>@` en el
// correo, `· <runId>` al final del nombre de la bodega, `<runId>` en el nombre del lote); nunca la
// semilla, y siempre por la API (nada de borrar filas):
//
// - `deactivateRunAccounts`: ninguna cuenta creada por una prueba queda activa. Con una sesión
//   ADMIN de plataforma, bloquea la cuenta completa de cada persona de la ejecución (usuarios
//   internos y miembros de sus bodegas) y anula sus invitaciones pendientes.
// - `retireRunWineries`: ninguna bodega creada por una prueba queda en la lista pública
//   (`GET /v1/public/wineries` solo lista las `ACTIVE`). Con la misma sesión ADMIN, revoca con
//   motivo cada bodega de la ejecución (`POST /v1/platform/wineries/{id}/revoke`).
// - `discardRunLots`: con la sesión de una persona de la bodega de demostración (dueño o
//   enología), descarta los lotes de la ejecución que la API deja descartar. Un lote con el
//   expediente cerrado (`CERTIFIED`) es terminal: se queda, con el `runId` en el nombre.

/** Lo que la limpieza usa del cliente (así se prueba sin red). */
export type CleanupClient = Pick<ApiClient, "get" | "raw">;

interface PlatformUser {
  membershipId: string | null;
  userId: string | null;
  email: string;
  status: string;
  invitationId?: string | null;
  accountStatus?: string | null;
}

interface WinerySummary {
  id: string;
  tradeName: string;
  status: string;
}

interface PublicWinery {
  slug: string;
  tradeName: string;
}

interface Member {
  userId: string;
  email: string;
}

interface Invitation {
  id: string;
  email: string;
  status: string;
}

interface LotSummary {
  id: string;
  name: string;
  stage: string;
  lotCode: string | null;
}

export interface CleanupResult {
  blocked: string[];
  alreadyBlocked: string[];
  revokedInvitations: string[];
  /** Cuentas de la ejecución que siguen activas tras la limpieza (debe quedar vacío). */
  remaining: string[];
}

export interface WineryCleanupResult {
  /** Bodegas de la ejecución revocadas ahora (nombre comercial). */
  revoked: string[];
  /** Bodegas de la ejecución que ya estaban revocadas. */
  alreadyRevoked: string[];
  /** Bodegas de la ejecución que siguen en la lista pública tras la limpieza (debe quedar vacío). */
  stillPublic: string[];
}

export interface LotCleanupResult {
  /** Lotes de la ejecución descartados ahora (nombre). */
  discarded: string[];
  /** Lotes que la API no deja descartar (expediente cerrado): `<nombre> (<código de lote>)`. */
  kept: string[];
}

async function all<T>(client: CleanupClient, path: string, query: Record<string, string> = {}): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await client.get<Page<T>>(path, { ...query, limit: 100, offset });
    items.push(...page.items);
    if (page.items.length < 100 || items.length >= page.total) return items;
  }
}

/** Una bodega es de la ejecución si su nombre comercial es `<nombre> · <runId>` (`runName`). */
export const isRunWinery = (tradeName: string, runId: string) => tradeName.endsWith(` · ${runId}`);

/** Bodegas creadas por la ejecución, en cualquier estado (directorio de la plataforma). */
async function runWineries(admin: CleanupClient, runId: string): Promise<WinerySummary[]> {
  return (await all<WinerySummary>(admin, "/v1/platform/wineries", { q: runId })).filter((w) =>
    isRunWinery(w.tradeName, runId),
  );
}

/** Nombres comerciales de la lista pública de bodegas (la que pintan los sitios públicos). */
export async function publicWineryNames(client: CleanupClient): Promise<string[]> {
  return (await all<PublicWinery>(client, "/v1/public/wineries")).map((w) => w.tradeName);
}

export async function deactivateRunAccounts(
  admin: CleanupClient,
  runId: string,
  reason: string,
): Promise<CleanupResult> {
  const marker = `+${runId}@`.toLowerCase();
  const ours = (email: string) => email.toLowerCase().includes(marker);
  const result: CleanupResult = { blocked: [], alreadyBlocked: [], revokedInvitations: [], remaining: [] };
  const accounts = new Map<string, string>(); // userId → correo

  const block = async (userId: string, email: string) => {
    if (accounts.has(userId)) return;
    accounts.set(userId, email);
    const res = await admin.raw("POST", `/v1/platform/accounts/${userId}/block`, { body: { reason } });
    if (res.ok) result.blocked.push(email);
    else if (res.status === 409) result.alreadyBlocked.push(email);
    else throw new Error(`No se pudo bloquear la cuenta de ${email}: ${res.status} ${res.error?.code ?? ""}`);
  };
  const revoke = async (invitationId: string, email: string) => {
    const res = await admin.raw("POST", `/v1/invitations/${invitationId}/revoke`, { body: { reason } });
    if (res.ok) result.revokedInvitations.push(email);
    else if (res.status !== 409 && res.status !== 404) {
      throw new Error(`No se pudo anular la invitación de ${email}: ${res.status} ${res.error?.code ?? ""}`);
    }
  };

  // Usuarios internos de la ejecución (y sus invitaciones pendientes).
  for (const user of await all<PlatformUser>(admin, "/v1/platform/users")) {
    if (!ours(user.email)) continue;
    if (user.userId) await block(user.userId, user.email);
    else if (user.invitationId) await revoke(user.invitationId, user.email);
  }

  // Personas de las bodegas creadas por la ejecución (su nombre lleva el prefijo).
  for (const winery of await runWineries(admin, runId)) {
    for (const member of await all<Member>(admin, `/v1/platform/organizations/${winery.id}/members`)) {
      if (ours(member.email)) await block(member.userId, member.email);
    }
    const pending = await all<Invitation>(admin, `/v1/platform/organizations/${winery.id}/invitations`, {
      status: "PENDING",
    });
    for (const invitation of pending) if (ours(invitation.email)) await revoke(invitation.id, invitation.email);
  }

  // Comprobación: ninguna cuenta de la ejecución sigue activa.
  for (const [userId, email] of accounts) {
    const account = await admin.get<{ status: string }>(`/v1/platform/accounts/${userId}`);
    if (account.status !== "BLOCKED") result.remaining.push(email);
  }
  return result;
}

/**
 * Deja fuera de la lista pública las bodegas creadas por la ejecución: las revoca con motivo
 * (sesión ADMIN de plataforma). La revocación vale desde `INVITED`, `ACTIVE` y `SUSPENDED`, es
 * definitiva y anula las invitaciones pendientes, así que una bodega de prueba no puede volver a
 * la lista. Comprueba al final la lista pública.
 */
export async function retireRunWineries(
  admin: CleanupClient,
  runId: string,
  reason: string,
): Promise<WineryCleanupResult> {
  const result: WineryCleanupResult = { revoked: [], alreadyRevoked: [], stillPublic: [] };
  for (const winery of await runWineries(admin, runId)) {
    if (winery.status === "REVOKED") {
      result.alreadyRevoked.push(winery.tradeName);
      continue;
    }
    const res = await admin.raw("POST", `/v1/platform/wineries/${winery.id}/revoke`, { body: { reason } });
    if (res.ok) result.revoked.push(winery.tradeName);
    else {
      throw new Error(
        `No se pudo revocar la bodega ${winery.tradeName} (${winery.status}): ${res.status} ${res.error?.code ?? ""}`,
      );
    }
  }
  result.stillPublic = (await publicWineryNames(admin)).filter((name) => name.includes(runId));
  return result;
}

/** Etapas de las que un lote ya no sale: el expediente cerrado no se descarta (`TRC_LOT_TERMINAL`). */
const CLOSED_STAGES = new Set(["CERTIFIED", "ANCHORED"]);

/**
 * Descarta con motivo los lotes de la ejecución (su nombre lleva el `runId`) en la bodega de la
 * sesión `member` (dueño o enología). Los que ya tienen el expediente cerrado no se pueden
 * descartar: se devuelven en `kept`.
 */
export async function discardRunLots(member: CleanupClient, runId: string, reason: string): Promise<LotCleanupResult> {
  const result: LotCleanupResult = { discarded: [], kept: [] };
  const lots = (await all<LotSummary>(member, "/v1/lots", { q: runId })).filter((lot) => lot.name.includes(runId));
  for (const lot of lots) {
    const label = lot.lotCode ? `${lot.name} (${lot.lotCode})` : lot.name;
    if (lot.stage === "DISCARDED") continue;
    if (CLOSED_STAGES.has(lot.stage)) {
      result.kept.push(label);
      continue;
    }
    const res = await member.raw("POST", `/v1/lots/${lot.id}/discard`, { body: { reason } });
    if (res.ok) result.discarded.push(lot.name);
    else if (res.status === 409) result.kept.push(label);
    else throw new Error(`No se pudo descartar el lote ${lot.name}: ${res.status} ${res.error?.code ?? ""}`);
  }
  return result;
}

import type { ApiClient, Page } from "./api";

// Limpieza de una ejecución: ninguna cuenta creada por una prueba queda activa. Con una sesión
// ADMIN de plataforma, bloquea la cuenta completa de cada persona cuyo correo lleva el prefijo de
// la ejecución (usuarios internos y miembros de las bodegas creadas por la ejecución) y anula sus
// invitaciones pendientes. No toca nada de la semilla: solo lo que lleva `+<runId>@` o `<runId>`
// en el nombre de la bodega.

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

export interface CleanupResult {
  blocked: string[];
  alreadyBlocked: string[];
  revokedInvitations: string[];
  /** Cuentas de la ejecución que siguen activas tras la limpieza (debe quedar vacío). */
  remaining: string[];
}

async function all<T>(client: ApiClient, path: string, query: Record<string, string> = {}): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await client.get<Page<T>>(path, { ...query, limit: 100, offset });
    items.push(...page.items);
    if (page.items.length < 100 || items.length >= page.total) return items;
  }
}

export async function deactivateRunAccounts(admin: ApiClient, runId: string, reason: string): Promise<CleanupResult> {
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
  const wineries = (await all<WinerySummary>(admin, "/v1/platform/wineries", { q: runId })).filter((w) =>
    w.tradeName.includes(runId),
  );
  for (const winery of wineries) {
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

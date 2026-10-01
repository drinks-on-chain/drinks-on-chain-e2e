import { execFile } from "node:child_process";

// Buzón de pruebas: la API de Mailpit del entorno de desarrollo (plan/04 §5), donde el worker
// entrega los correos (invitaciones, verificación, recuperación). Mailpit solo escucha en
// 127.0.0.1 del servidor, así que se llega por uno de estos transportes:
//
// - `E2E_MAILPIT_URL`: HTTP directo (p. ej. un túnel `ssh -L 8025:127.0.0.1:8025`).
// - `E2E_MAILPIT_SSH=<destino ssh>` con `E2E_MAILPIT_SSH_MODE=api`: la llave de CI con comando
//   forzado en el servidor, que solo admite `GET /api/v1/<ruta>` y `DELETE /api/v1/messages`
//   (vaciar el buzón entero). No puede borrar correos sueltos.
// - `E2E_MAILPIT_SSH=<destino ssh>` con `E2E_MAILPIT_SSH_MODE=curl` (por defecto): una sesión
//   ssh normal que ejecuta `curl` contra 127.0.0.1:8025 en el servidor (uso local).
//
// `E2E_MAILPIT_SSH_KEY` (opcional) es la ruta de la llave privada. Nada de esto se imprime.

export interface MailAddress {
  Name: string;
  Address: string;
}

export interface MailSummary {
  ID: string;
  From: MailAddress | null;
  To: MailAddress[] | null;
  Subject: string;
  Created: string;
  Snippet?: string;
}

export interface MailMessage extends MailSummary {
  Text: string;
  HTML: string;
}

interface MessagesPage {
  total: number;
  messages_count?: number;
  messages: MailSummary[];
}

export interface MailpitTransport {
  readonly kind: "http" | "ssh-api" | "ssh-curl";
  get(path: string): Promise<unknown>;
  /** Borra correos concretos. `null` si el transporte no lo permite (llave restringida). */
  deleteIds: ((ids: string[]) => Promise<void>) | null;
  /** Vacía el buzón entero: solo en la limpieza final explícita (`pnpm mailbox purge`). */
  deleteAll(): Promise<void>;
}

/**
 * Codifica un valor de la query con el juego de caracteres que admite el comando forzado del
 * servidor (`[A-Za-z0-9/_.?=&%-]`): todo lo demás va en `%XX`.
 */
export function encodeQueryValue(value: string): string {
  return Array.from(new TextEncoder().encode(value), (b) => {
    const ch = String.fromCharCode(b);
    return /[A-Za-z0-9_.-]/.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

const SAFE_PATH = /^\/api\/v1\/[A-Za-z0-9/_.?=&%-]*$/;

function assertSafePath(path: string) {
  if (!SAFE_PATH.test(path)) throw new Error(`Ruta de Mailpit no admitida: ${path}`);
}

function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Mailpit devolvió algo que no es JSON en ${path} (${raw.slice(0, 120)})`);
  }
}

export function httpTransport(baseUrl: string): MailpitTransport {
  const base = baseUrl.replace(/\/+$/, "");
  const call = async (method: string, path: string, body?: unknown) => {
    assertSafePath(path);
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Mailpit ${method} ${path}: HTTP ${res.status}`);
    return res.text();
  };
  return {
    kind: "http",
    get: async (path) => parseJson(await call("GET", path), path),
    deleteIds: async (ids) => {
      await call("DELETE", "/api/v1/messages", { IDs: ids });
    },
    deleteAll: async () => {
      await call("DELETE", "/api/v1/messages");
    },
  };
}

export interface SshOptions {
  target: string;
  mode: "api" | "curl";
  keyPath?: string;
  /** Puerto de Mailpit en el servidor (modo curl). */
  remoteUrl?: string;
}

function ssh(opts: SshOptions, command: string): Promise<string> {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
  if (opts.keyPath) args.push("-i", opts.keyPath, "-o", "IdentitiesOnly=yes");
  args.push(opts.target, command);
  return new Promise((resolve, reject) => {
    execFile("ssh", args, { timeout: 45_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      // El mensaje de error no incluye la llave ni variables: solo la orden remota y stderr.
      if (error) reject(new Error(`ssh (${opts.mode}) «${command}» falló: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

export function sshTransport(opts: SshOptions): MailpitTransport {
  const remote = (opts.remoteUrl ?? "http://127.0.0.1:8025").replace(/\/+$/, "");
  if (opts.mode === "api") {
    return {
      kind: "ssh-api",
      get: async (path) => {
        assertSafePath(path);
        return parseJson(await ssh(opts, `GET ${path}`), path);
      },
      deleteIds: null,
      deleteAll: async () => {
        await ssh(opts, "DELETE /api/v1/messages");
      },
    };
  }
  const curl = (args: string) => ssh(opts, `curl -fsS --max-time 20 ${args}`);
  return {
    kind: "ssh-curl",
    get: async (path) => {
      assertSafePath(path);
      return parseJson(await curl(`'${remote}${path}'`), path);
    },
    deleteIds: async (ids) => {
      if (!ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id))) throw new Error("Id de correo no válido");
      const body = JSON.stringify({ IDs: ids });
      await curl(`-X DELETE -H 'Content-Type: application/json' -d '${body}' '${remote}/api/v1/messages'`);
    },
    deleteAll: async () => {
      await curl(`-X DELETE '${remote}/api/v1/messages'`);
    },
  };
}

/** Transporte según las variables de entorno, o `null` si no hay buzón configurado. */
export function transportFromEnv(env: NodeJS.ProcessEnv = process.env): MailpitTransport | null {
  const url = env.E2E_MAILPIT_URL?.trim();
  if (url) return httpTransport(url);
  const target = env.E2E_MAILPIT_SSH?.trim();
  if (!target) return null;
  const mode = env.E2E_MAILPIT_SSH_MODE?.trim() === "api" ? "api" : "curl";
  return sshTransport({
    target,
    mode,
    keyPath: env.E2E_MAILPIT_SSH_KEY?.trim() || undefined,
    remoteUrl: env.E2E_MAILPIT_REMOTE_URL?.trim() || undefined,
  });
}

const recipients = (m: MailSummary) => (m.To ?? []).map((a) => a.Address.toLowerCase());

/** Enlaces del correo en orden: primero los `href` del HTML, luego las URL del texto. */
export function extractLinks(message: Pick<MailMessage, "HTML" | "Text">): string[] {
  const decode = (s: string) =>
    s
      .replace(/&amp;/g, "&")
      .replace(/&#x3D;|&#61;/g, "=")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  const links: string[] = [];
  for (const m of (message.HTML || "").matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    const href = decode(m[2] ?? "").trim();
    if (/^https?:\/\//i.test(href)) links.push(href);
  }
  for (const m of (message.Text || "").matchAll(/https?:\/\/[^\s<>"')\]]+/gi))
    links.push(decode(m[0]).replace(/[.,;]+$/, ""));
  return [...new Set(links)];
}

/** Primer enlace del correo (o el primero que cumple `pattern`). */
export function firstLink(message: Pick<MailMessage, "HTML" | "Text">, pattern?: RegExp): string {
  const links = extractLinks(message);
  const link = pattern ? links.find((l) => pattern.test(l)) : links[0];
  if (!link) {
    throw new Error(`El correo no tiene ningún enlace${pattern ? ` que cumpla ${String(pattern)}` : ""}`);
  }
  return link;
}

/** Token de un enlace: el parámetro `token` o, si no hay, el último segmento de la ruta. */
export function tokenFromLink(link: string): string {
  const url = new URL(link);
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) return fromQuery;
  const last = url.pathname.split("/").filter(Boolean).pop();
  if (!last) throw new Error(`El enlace no lleva token: ${link}`);
  return decodeURIComponent(last);
}

export interface WaitOptions {
  /** Asunto esperado. */
  subject?: RegExp;
  /** Solo correos creados desde este instante (evita coger uno anterior al mismo destinatario). */
  since?: Date;
  timeoutMs?: number;
  pollMs?: number;
}

export class Mailbox {
  constructor(
    readonly transport: MailpitTransport,
    /** Prefijo de la ejecución: solo se borran los correos cuyos destinatarios lo llevan. */
    readonly runId?: string,
  ) {}

  /** Últimos correos (el más reciente primero). */
  async list(limit = 50): Promise<MailSummary[]> {
    const page = (await this.transport.get(`/api/v1/messages?limit=${limit}`)) as MessagesPage;
    return page.messages;
  }

  /** Correos cuyo destinatario es exactamente `to` (el más reciente primero). */
  async listFor(to: string, limit = 50): Promise<MailSummary[]> {
    const query = encodeQueryValue(`to:"${to}"`);
    const page = (await this.transport.get(`/api/v1/search?query=${query}&limit=${limit}`)) as MessagesPage;
    const wanted = to.toLowerCase();
    return page.messages.filter((m) => recipients(m).includes(wanted));
  }

  async get(id: string): Promise<MailMessage> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Id de correo no válido: ${id}`);
    return (await this.transport.get(`/api/v1/message/${id}`)) as MailMessage;
  }

  /** Espera el correo más reciente para `to` que cumpla las condiciones y lo devuelve completo. */
  async waitFor(to: string, options: WaitOptions = {}): Promise<MailMessage> {
    const { subject, since, timeoutMs = 60_000, pollMs = 2_000 } = options;
    const deadline = Date.now() + timeoutMs;
    let last: MailSummary[] = [];
    for (;;) {
      last = await this.listFor(to);
      const match = last.find(
        (m) => (!subject || subject.test(m.Subject)) && (!since || Date.parse(m.Created) >= since.getTime() - 1_000),
      );
      if (match) return this.get(match.ID);
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    const got = last.map((m) => `«${m.Subject}» (${m.Created})`).join(", ") || "ninguno";
    throw new Error(
      `No llegó ningún correo para ${to}${subject ? ` con asunto ${String(subject)}` : ""} en ${timeoutMs / 1000} s. Recibidos: ${got}`,
    );
  }

  /**
   * Espera el correo y devuelve su primer enlace. Con `link`, espera el correo más reciente que
   * **contenga** un enlace que cumpla el patrón: el backend puede enviar varios correos al mismo
   * destinatario en el mismo segundo (p. ej. la invitación del dueño y el aviso de solicitud
   * aprobada, que no lleva enlace) y el más reciente no siempre es el que se busca.
   */
  async waitForLink(to: string, options: WaitOptions & { link?: RegExp } = {}): Promise<string> {
    const { link, subject, since, timeoutMs = 60_000, pollMs = 2_000 } = options;
    if (!link) return firstLink(await this.waitFor(to, options));
    const deadline = Date.now() + timeoutMs;
    let last: MailSummary[] = [];
    for (;;) {
      last = await this.listFor(to);
      const candidates = last.filter(
        (m) => (!subject || subject.test(m.Subject)) && (!since || Date.parse(m.Created) >= since.getTime() - 1_000),
      );
      for (const candidate of candidates) {
        const found = extractLinks(await this.get(candidate.ID)).find((l) => link.test(l));
        if (found) return found;
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    const got = last.map((m) => `«${m.Subject}» (${m.Created})`).join(", ") || "ninguno";
    throw new Error(
      `No llegó ningún correo para ${to} con un enlace que cumpla ${String(link)} en ${timeoutMs / 1000} s. Recibidos: ${got}`,
    );
  }

  /**
   * Borra los correos de esta ejecución (destinatarios con `+<runId>@`) si el transporte lo
   * permite. Con la llave restringida de CI no se puede borrar correos sueltos: se dejan (Mailpit
   * rota los antiguos) y se devuelve `skipped`.
   */
  async cleanupRun(): Promise<{ deleted: number; skipped: boolean }> {
    if (!this.runId) return { deleted: 0, skipped: true };
    const deleteIds = this.transport.deleteIds;
    if (!deleteIds) return { deleted: 0, skipped: true };
    const marker = `+${this.runId}@`;
    const query = encodeQueryValue(`to:"${this.runId}"`);
    const page = (await this.transport.get(`/api/v1/search?query=${query}&limit=500`)) as MessagesPage;
    const ids = new Set(page.messages.filter((m) => recipients(m).some((a) => a.includes(marker))).map((m) => m.ID));
    if (ids.size === 0) return { deleted: 0, skipped: false };
    await deleteIds([...ids]);
    return { deleted: ids.size, skipped: false };
  }
}

/** Buzón configurado por entorno, o `null` si no hay transporte. */
export function mailboxFromEnv(runId?: string): Mailbox | null {
  const transport = transportFromEnv();
  return transport ? new Mailbox(transport, runId) : null;
}

export const MAILBOX_HELP =
  "Sin buzón: define E2E_MAILPIT_SSH (destino ssh, con E2E_MAILPIT_SSH_MODE=api para la llave de CI) o E2E_MAILPIT_URL.";

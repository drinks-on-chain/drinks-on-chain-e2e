import { request, type APIRequestContext, type APIResponse } from "@playwright/test";
import { API_ORIGIN } from "../config";
import { paceLogin } from "./login-pace";
import { freshTotp } from "./totp";

// Cliente directo contra el backend para preparar datos y comprobar estados sin pasar por una
// pantalla. Envía siempre `X-Client-App: API` (la bitácora registra la app de origen, contrato
// de la Ola 1 §7) y un `X-Correlation-ID` con el prefijo de la ejecución, para encontrar sus
// peticiones en los logs del backend. Guarda la cookie de renovación `doc_rt` como un navegador.

export interface FieldError {
  field: string | null;
  message: string;
}

export interface ErrorBody {
  code: string;
  message: string;
  details?: FieldError[] | null;
}

export interface Envelope<T> {
  success: boolean;
  statusCode: number;
  timestamp?: string;
  path?: string;
  data?: T;
  error?: ErrorBody;
}

export interface Membership {
  id: string;
  organizationId: string;
  organizationType: "PLATFORM" | "WINERY" | "PICKUP_POINT";
  organizationName: string;
  organizationStatus: string;
  role: string;
  status: "ACTIVE" | "BLOCKED" | "INVITED";
}

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  audience?: "STAFF" | "CONSUMER";
}

/** Forma del login (contrato de la Ola 0 §5), o el paso de segundo factor (Ola 1 §1). */
export interface LoginResult {
  user?: SessionUser;
  memberships?: Membership[];
  activeOrganizationId?: string | null;
  tokens?: { accessToken: string; tokenType: string; expiresIn: number; refreshToken?: string };
  mfa?: { required: boolean; enrolled: boolean; mfaToken: string };
  recoveryCodes?: string[];
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApiResult<T> {
  status: number;
  ok: boolean;
  data: T | undefined;
  error: ErrorBody | undefined;
  headers: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: ErrorBody | undefined,
  ) {
    super(`${method} ${path} → ${status}${body ? ` ${body.code}: ${body.message}` : ""}`);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  body?: unknown;
  query?: Query;
  headers?: Record<string, string>;
}

let correlation = 0;

export class ApiClient {
  private accessToken: string | null = null;
  /** Última forma del login (persona, membresías y organización activa). */
  session: LoginResult | null = null;
  /** Secreto TOTP inscrito por `login` para una persona que aún no lo tenía. */
  enrolledSecret: string | null = null;

  private constructor(
    readonly context: APIRequestContext,
    readonly label: string,
  ) {}

  /**
   * Cliente sin sesión. `label` identifica a la persona en los mensajes de error; `clientApp` es la
   * app de origen que registra la bitácora (`API` por defecto; `PUBLIC` para los formularios públicos).
   */
  static async create(label = "anónimo", origin: string = API_ORIGIN, clientApp = "API"): Promise<ApiClient> {
    const context = await request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { "X-Client-App": clientApp, Accept: "application/json" },
      ignoreHTTPSErrors: false,
    });
    return new ApiClient(context, label);
  }

  get token(): string | null {
    return this.accessToken;
  }

  /** Petición sin lanzar: devuelve estado, `data` o `error` del envoltorio y cabeceras. */
  async raw<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const runId = process.env.E2E_RUN_ID ?? "e2e";
    const headers: Record<string, string> = {
      "X-Correlation-ID": `${runId}-${String(++correlation).padStart(4, "0")}`,
      ...options.headers,
    };
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    const params = options.query
      ? Object.fromEntries(
          Object.entries(options.query)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => [k, String(v)]),
        )
      : undefined;
    const response: APIResponse = await this.context.fetch(path, {
      method,
      headers,
      params,
      data: options.body === undefined ? undefined : options.body,
      failOnStatusCode: false,
    });
    const text = await response.text();
    let envelope: Envelope<T> | undefined;
    try {
      envelope = text ? (JSON.parse(text) as Envelope<T>) : undefined;
    } catch {
      envelope = undefined;
    }
    return {
      status: response.status(),
      ok: response.ok(),
      data: envelope?.data,
      error: envelope?.error,
      headers: response.headers(),
    };
  }

  /** Petición que exige 2xx y devuelve `data`. */
  async call<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const result = await this.raw<T>(method, path, options);
    if (!result.ok) throw new ApiError(method, path, result.status, result.error);
    return result.data as T;
  }

  /**
   * `GET` que devuelve el cuerpo tal cual, sin interpretar el envoltorio (p. ej. los bytes
   * canónicos del expediente, que hay que recibir intactos para recalcular su huella).
   */
  async bytes(path: string): Promise<{ status: number; body: Buffer; headers: Record<string, string> }> {
    const runId = process.env.E2E_RUN_ID ?? "e2e";
    const headers: Record<string, string> = {
      "X-Correlation-ID": `${runId}-${String(++correlation).padStart(4, "0")}`,
    };
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    const response = await this.context.fetch(path, { method: "GET", headers, failOnStatusCode: false });
    return { status: response.status(), body: await response.body(), headers: response.headers() };
  }

  get<T = unknown>(path: string, query?: Query) {
    return this.call<T>("GET", path, { query });
  }

  post<T = unknown>(path: string, body: unknown = {}) {
    return this.call<T>("POST", path, { body });
  }

  patch<T = unknown>(path: string, body: unknown) {
    return this.call<T>("PATCH", path, { body });
  }

  private adopt(result: LoginResult): LoginResult {
    this.session = result;
    if (result.tokens?.accessToken) this.accessToken = result.tokens.accessToken;
    return result;
  }

  /**
   * Inicia sesión. Si el backend pide segundo factor (personal de plataforma) y hay secreto TOTP,
   * lo completa con un código generado; si la persona no lo tiene inscrito, lo inscribe y deja el
   * secreto nuevo en `enrolledSecret`.
   */
  async login(email: string, password: string, totpSecret?: string): Promise<LoginResult> {
    await paceLogin();
    const first = await this.call<LoginResult>("POST", "/v1/auth/login", { body: { email, password } });
    if (!first.mfa?.required) return this.adopt(first);
    const { mfaToken, enrolled } = first.mfa;
    if (enrolled) {
      if (!totpSecret) throw new Error(`${email} necesita un código TOTP y no hay secreto (E2E_TOTP_SECRET)`);
      const verify = async () =>
        this.raw<LoginResult>("POST", "/v1/auth/mfa/verify", {
          body: { mfaToken, code: await freshTotp(totpSecret) },
        });
      let verified = await verify();
      // Un código TOTP es de un solo uso y `freshTotp` solo recuerda los de este proceso: si otro
      // proceso (otro worker, la limpieza) acaba de usar el del paso actual, el backend lo rechaza.
      // Se repite una vez con el código del paso siguiente, sin otro inicio de sesión.
      if (!verified.ok && verified.status >= 400 && verified.status < 500) verified = await verify();
      if (!verified.ok || !verified.data) {
        throw new ApiError("POST", "/v1/auth/mfa/verify", verified.status, verified.error);
      }
      return this.adopt(verified.data);
    }
    const { secret } = await this.post<{ otpauthUrl: string; secret: string }>("/v1/auth/mfa/enroll", { mfaToken });
    this.enrolledSecret = secret;
    return this.adopt(
      await this.post<LoginResult>("/v1/auth/mfa/enroll/confirm", { mfaToken, code: await freshTotp(secret) }),
    );
  }

  /** Acepta una invitación sin sesión creando la cuenta; queda con la sesión de la persona. */
  async acceptInvitation(token: string, fullName: string, password: string): Promise<LoginResult> {
    return this.adopt(
      await this.post<LoginResult>(`/v1/invitations/${encodeURIComponent(token)}/accept`, { fullName, password }),
    );
  }

  async switchOrganization(organizationId: string): Promise<LoginResult> {
    return this.adopt(await this.post<LoginResult>("/v1/auth/switch-organization", { organizationId }));
  }

  /** Renueva con la cookie `doc_rt` (sin cuerpo). */
  async refresh(): Promise<ApiResult<LoginResult>> {
    const result = await this.raw<LoginResult>("POST", "/v1/auth/refresh");
    if (result.ok && result.data) this.adopt(result.data);
    return result;
  }

  async logout(): Promise<void> {
    await this.raw("POST", "/v1/auth/logout");
    this.accessToken = null;
    this.session = null;
  }

  async dispose(): Promise<void> {
    await this.context.dispose();
  }
}

/** Rutas del OpenAPI publicado por el backend (`/docs-json`, Swagger activo en desarrollo). */
export async function openApiPaths(origin: string = API_ORIGIN): Promise<Set<string>> {
  const context = await request.newContext({ baseURL: origin });
  try {
    const response = await context.get("/docs-json", { failOnStatusCode: false, timeout: 30_000 });
    if (!response.ok()) throw new Error(`GET ${origin}/docs-json → ${response.status()}`);
    const doc = (await response.json()) as { paths?: Record<string, unknown> };
    return new Set(Object.keys(doc.paths ?? {}));
  } finally {
    await context.dispose();
  }
}

/** Ruta sin los nombres de sus parámetros: `/v1/x/{id}` y `/v1/x/{token}` son la misma. */
export const normalizeRoute = (route: string) => route.replace(/\{[^}]+\}/g, "{}");

/** Rutas de `required` que el OpenAPI aún no declara (sin mirar el nombre de los parámetros). */
export async function missingRoutes(required: readonly string[], origin: string = API_ORIGIN): Promise<string[]> {
  const paths = new Set([...(await openApiPaths(origin))].map(normalizeRoute));
  return required.filter((r) => !paths.has(normalizeRoute(r)));
}

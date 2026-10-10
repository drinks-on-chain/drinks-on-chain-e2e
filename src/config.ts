// Configuración de la suite: todo sale de variables de entorno (nunca hosts ni secretos escritos en
// las pruebas). Ver la tabla de variables del README.

/** Backend de desarrollo (plan/03 §5). En la Ola 6, staging. */
export const DEV_API_ORIGIN = "https://136.243.223.39.sslip.io";

const trimSlash = (v: string) => v.trim().replace(/\/+$/, "");

/** Origen del backend: las apps lo usan como API_ORIGIN y las utilidades `api` lo llaman directamente. */
export const API_ORIGIN = trimSlash(process.env.E2E_API_ORIGIN || DEV_API_ORIGIN);

export type AppName = "erp" | "backoffice" | "marketplace" | "pos" | "bodegas";

export interface AppDef {
  name: AppName;
  /** Repo público de la organización `drinks-on-chain` (y carpeta hermana en el paraguas). */
  repo: string;
  /** Variable con la URL ya levantada de la app; si falta, `http://localhost:<port>`. */
  urlVar: string;
  /** Puerto local donde `scripts/apps.ts` la arranca con `next start` (el de desarrollo + 100). */
  port: number;
  /** Proyecto de Playwright activo. Los de olas futuras se activan con `E2E_ENABLE_<APP>=1`. */
  enabledByDefault: boolean;
  /** Recorridos (archivos de tests/) que arrancan en esta app. */
  specs: RegExp;
  /** Ruta con la que se sabe que la app ya responde (las apps con sesión, su login). */
  readyPath: string;
  /** Variables de build de la app contra el backend real (sin mocks). */
  buildEnv: (urls: Record<AppName, string>) => Record<string, string>;
}

const common = { NEXT_PUBLIC_MOCKS: "0", API_ORIGIN };

/**
 * `E2E_ERP_TOKENIZATION=1`: el ERP se construye con `NEXT_PUBLIC_ERP_TOKENIZATION=1` (pestaña
 * «Tokenización» del lote, solicitudes y bloque del panel). Lo exige el recorrido H3.
 */
export const ERP_TOKENIZATION = process.env.E2E_ERP_TOKENIZATION === "1";

export const APPS: Record<AppName, AppDef> = {
  erp: {
    name: "erp",
    repo: "drinks-on-chain-erp",
    urlVar: "E2E_URL_ERP",
    port: 3102,
    enabledByDefault: true,
    // H0, el recorrido de H2 por la interfaz del ERP (que termina en el visor del Marketplace) y
    // el de H3, que empieza con la dueña en el ERP y sigue en el Backoffice y el visor.
    specs: /(h0-.*|h2-recorrido|h3-.*)\.spec\.ts$/,
    readyPath: "/login",
    // La tokenización del ERP va detrás de una bandera hasta el cierre de la Ola 3: se construye
    // con ella solo si se pide (E2E_ERP_TOKENIZATION=1), para que H0–H2 sigan viendo el ERP de
    // siempre contra un backend que aún no tenga las rutas de la ola.
    buildEnv: () => ({ ...common, ...(ERP_TOKENIZATION ? { NEXT_PUBLIC_ERP_TOKENIZATION: "1" } : {}) }),
  },
  backoffice: {
    name: "backoffice",
    repo: "drinks-on-chain-backoffice",
    urlVar: "E2E_URL_BACKOFFICE",
    port: 3103,
    enabledByDefault: true,
    specs: /h1-.*\.spec\.ts$/,
    readyPath: "/login",
    buildEnv: (u) => ({ ...common, NEXT_PUBLIC_URL_ERP: u.erp }),
  },
  marketplace: {
    name: "marketplace",
    repo: "drinks-on-chain-marketplace",
    urlVar: "E2E_URL_MARKETPLACE",
    port: 3104,
    enabledByDefault: true,
    // El visor del pasaporte (H2) y, en la Ola 4, la compra.
    specs: /(h2-pasaporte|h4-.*)\.spec\.ts$/,
    // Sitio público sin sesión: no tiene /login.
    readyPath: "/",
    // Sin PROXY_SHARED_SECRET: el proxy de la app no firma la IP del visitante y el límite del
    // pasaporte público cuenta por la IP de quien ejecuta la suite.
    buildEnv: () => ({ ...common }),
  },
  pos: {
    name: "pos",
    repo: "drinks-on-chain-pos",
    urlVar: "E2E_URL_POS",
    port: 3105,
    enabledByDefault: false,
    specs: /h5-.*\.spec\.ts$/,
    readyPath: "/login",
    buildEnv: () => ({ ...common }),
  },
  bodegas: {
    name: "bodegas",
    repo: "drinks-on-chain-front",
    urlVar: "E2E_URL_BODEGAS",
    port: 3100,
    enabledByDefault: false,
    specs: /bodegas-.*\.spec\.ts$/,
    readyPath: "/",
    buildEnv: () => ({ API_ORIGIN }),
  },
};

export const APP_NAMES = Object.keys(APPS) as AppName[];

export function appUrl(app: AppName): string {
  const def = APPS[app];
  return trimSlash(process.env[def.urlVar] || `http://localhost:${def.port}`);
}

export function appUrls(): Record<AppName, string> {
  return Object.fromEntries(APP_NAMES.map((a) => [a, appUrl(a)])) as Record<AppName, string>;
}

export function appEnabled(app: AppName): boolean {
  const flag = process.env[`E2E_ENABLE_${app.toUpperCase()}`];
  if (flag === "1") return true;
  if (flag === "0") return false;
  return APPS[app].enabledByDefault;
}

/** Contraseña de las personas de demostración (SEED_DEMO_PASSWORD del backend). Nunca se imprime. */
export const DEMO_PASSWORD = process.env.E2E_PASSWORD ?? "";

/** Secreto TOTP (base32) del personal de plataforma de la semilla, cuando el backend exija 2FA. */
export const DEMO_TOTP_SECRET = (process.env.E2E_TOTP_SECRET ?? "").replace(/\s+/g, "").toUpperCase();

/** Token de captcha de prueba: Cloudflare Turnstile acepta este token con sus claves de prueba. */
export const CAPTCHA_TEST_TOKEN = process.env.E2E_CAPTCHA_TOKEN || "XXXX.DUMMY.TOKEN.XXXX";

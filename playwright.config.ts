import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import { APPS, APP_NAMES, appEnabled, appUrl, type AppName } from "./src/config";

// Un proyecto por aplicación (plan/04 §5). Cada recorrido de hito se asigna a la app donde
// empieza (APPS[app].specs) y abre las demás con el fixture `openApp`. Los proyectos de olas
// futuras (marketplace, pos, bodegas) existen pero están desactivados: E2E_ENABLE_<APP>=1.
//
// Las apps se levantan fuera (URL en E2E_URL_<APP>) o, con E2E_START_APPS=1, Playwright arranca
// `pnpm apps serve <app>` sobre el build que dejó `pnpm apps prepare` (ver README).

const CI = !!process.env.CI;
// En local, el Chrome instalado; en CI, el Chromium que instala Playwright.
const channel = CI ? undefined : (process.env.E2E_BROWSER_CHANNEL ?? "chrome");

const enabled = APP_NAMES.filter(appEnabled);

/** Apps que arranca Playwright: E2E_APPS (lista) o las activas sin URL propia. */
function appsToServe(): AppName[] {
  if (process.env.E2E_START_APPS !== "1") return [];
  const listed = process.env.E2E_APPS?.split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  const names = listed?.length ? (listed as AppName[]) : enabled.filter((a) => !process.env[APPS[a].urlVar]);
  for (const name of names) if (!APP_NAMES.includes(name)) throw new Error(`App desconocida en E2E_APPS: ${name}`);
  return names;
}

const webServer: PlaywrightTestConfig["webServer"] = appsToServe().map((app) => ({
  command: `pnpm apps serve ${app}`,
  url: `${appUrl(app)}/login`,
  reuseExistingServer: !CI,
  timeout: 120_000,
  stdout: "ignore",
  stderr: "pipe",
}));

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./src/global-setup.ts",
  // Contra un entorno compartido y con límites por IP (login 10/min): en serie y sin reintentos,
  // que cada intento suma inicios de sesión.
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS ?? 1),
  retries: 0,
  forbidOnly: CI,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: CI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    locale: "es-BO",
    timezoneId: "America/La_Paz",
    trace: CI ? "on" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: enabled.map((app) => ({
    name: app,
    testMatch: APPS[app].specs,
    use: { ...devices["Desktop Chrome"], channel, baseURL: appUrl(app) },
  })),
  webServer,
});

import { test as base, expect, type Page } from "@playwright/test";
import { DEMO_PASSWORD, appUrl, appUrls, type AppName } from "../config";
import { ApiClient } from "../lib/api";
import { Mailbox, mailboxFromEnv } from "../lib/mailbox";
import { currentRunId } from "../lib/run-id";

// `test` de la suite con los fixtures compartidos (plan/04 §5):
//
// - `runId`: prefijo de la ejecución (worker; el mismo en todos los workers vía E2E_RUN_ID).
// - `mailbox`: buzón de Mailpit (o `null` si no está configurado); al terminar borra solo los
//   correos de la ejecución cuando el transporte lo permite.
// - `api`: clientes directos contra el backend (`api.anonymous()`, `api.as(correo)`), cerrados al
//   terminar la prueba.
// - `apps`: URL de cada app; `openApp(app)`: página nueva en un contexto propio (otra persona,
//   sin cookies compartidas) con la URL base de esa app.

export interface ApiFactory {
  /** Cliente sin sesión (`clientApp`: `API` por defecto, `PUBLIC` para formularios públicos). */
  anonymous(label?: string, clientApp?: string): Promise<ApiClient>;
  /** Cliente con la sesión de `email` (contraseña de demo salvo que se indique otra). */
  as(email: string, options?: { password?: string; totpSecret?: string }): Promise<ApiClient>;
}

interface TestFixtures {
  api: ApiFactory;
  apps: Record<AppName, string>;
  openApp: (app: AppName) => Promise<Page>;
}

interface WorkerFixtures {
  runId: string;
  mailbox: Mailbox | null;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  runId: [
    // eslint-disable-next-line no-empty-pattern -- Playwright exige el patrón de objeto
    async ({}, use) => {
      await use(currentRunId());
    },
    { scope: "worker" },
  ],

  mailbox: [
    async ({ runId }, use) => {
      const box = mailboxFromEnv(runId);
      await use(box);
      if (box && process.env.E2E_KEEP_MAIL !== "1") await box.cleanupRun().catch(() => undefined);
    },
    { scope: "worker" },
  ],

  api: async ({ runId }, use) => {
    const clients: ApiClient[] = [];
    await use({
      anonymous: async (label, clientApp) => {
        const client = await ApiClient.create(label ?? `${runId} anónimo`, undefined, clientApp);
        clients.push(client);
        return client;
      },
      as: async (email, options = {}) => {
        const client = await ApiClient.create(email);
        clients.push(client);
        await client.login(email, options.password ?? DEMO_PASSWORD, options.totpSecret);
        return client;
      },
    });
    for (const client of clients) await client.dispose();
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright exige el patrón de objeto
  apps: async ({}, use) => {
    await use(appUrls());
  },

  openApp: async ({ browser, contextOptions, locale }, use) => {
    const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
    await use(async (app) => {
      const context = await browser.newContext({ ...contextOptions, locale, baseURL: appUrl(app) });
      contexts.push(context);
      return context.newPage();
    });
    for (const context of contexts) await context.close();
  },
});

export { expect };

/** Salta la prueba si falta la contraseña de las personas de demostración. */
export function needsDemoPassword() {
  test.skip(!DEMO_PASSWORD, "Falta E2E_PASSWORD (contraseña de las personas de demostración del backend).");
}

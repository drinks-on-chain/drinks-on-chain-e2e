import type { Page } from "@playwright/test";
import { API_ORIGIN, DEMO_PASSWORD } from "../src/config";
import { ALTOS_PARCEL, ORG, WINERY } from "../src/fixtures/users";
import { expect, needsDemoPassword, test } from "../src/fixtures/test";
import { MAILBOX_HELP } from "../src/lib/mailbox";
import { fillLogin, logout, settled, shellUser, trackErrors } from "../src/lib/page";

// H0 · Integración (PLAN-MAESTRO, hito H0): el ERP, construido sin mocks, inicia sesión, renueva
// con la cookie, cambia de organización y lista parcelas contra el backend de desarrollo; la API
// y el worker están sanos y el buzón de pruebas se lee con la llave restringida de CI.
//
// Solo lecturas: el 422 del perfil no guarda nada y no se crea ningún dato. Un solo worker (ver
// playwright.config.ts) para no rozar los límites del backend (login 10/min por IP).
//
// Lo que depende de que los datos del backend cumplan el contrato (panel y lista de parcelas) se
// comprueba con `expect.soft`: si falla, la prueba falla igual, pero sigue y comprueba el resto de
// la sesión (renovación, 422, cierre, cambio de organización) para informar de todo a la vez.

/** El panel del ERP cargó sus datos (sin ErrorState por contrato roto, red o servidor). */
async function softDashboard(page: Page) {
  await expect.soft(page.getByText("Tareas pendientes", { exact: true }), "panel con datos del backend").toBeVisible();
  await expect.soft(page.getByText("No se pudo cargar"), "panel sin ErrorState").toHaveCount(0);
}

const orgSelector = (page: Page) => page.getByRole("combobox", { name: "Organización activa" });

test("salud de la API y del worker", async ({ api }) => {
  const client = await api.anonymous();

  const ready = await client.raw<Record<string, unknown>>("GET", "/v1/health/ready");
  expect(ready.status, `GET ${API_ORIGIN}/v1/health/ready`).toBe(200);
  expect(ready.data).toMatchObject({ status: "ok", database: "connected", redis: "connected" });
  expect(["connected", "not_configured"]).toContain(ready.data?.storage);
  // El envoltorio devuelve siempre el id de correlación que se envió.
  expect(ready.headers["x-correlation-id"]).toMatch(/^e2e-/);

  const live = await client.raw<{ status: string; release: string | null }>("GET", "/v1/health/live");
  expect(live.status).toBe(200);
  test.info().annotations.push({ type: "release", description: live.data?.release ?? "sin RELEASE_SHA" });

  // El worker no expone HTTP: su latido llega a /health/ready cuando el backend lo publique
  // (campo `worker`). Mientras tanto, el correo de prueba entregado por la cola (prueba
  // siguiente) demuestra que el worker procesa la cola `email`.
  const worker = ready.data?.worker;
  if (worker === undefined) {
    test.info().annotations.push({
      type: "worker",
      description: "/v1/health/ready aún no informa del worker; se comprueba por el correo entregado por la cola",
    });
  }
  expect([undefined, "ok", "connected", "healthy"]).toContain(worker);
});

test("buzón de pruebas: el correo de prueba de Mailpit se lee con la llave del entorno", async ({ mailbox }) => {
  test.skip(!mailbox, MAILBOX_HELP);
  if (!mailbox) return;
  test.info().annotations.push({ type: "buzón", description: mailbox.transport.kind });

  const recent = await mailbox.list(20);
  expect(Array.isArray(recent)).toBe(true);

  // Correo que el worker envió por la cola `email` al preparar el entorno (O0-OPS-2).
  const candidates = await mailbox.listFor("dev@example.test");
  const probe = candidates.find((m) => /Correo de prueba de Drinks on Chain/.test(m.Subject));
  expect(probe, "correo de prueba para dev@example.test en Mailpit (lo envía el worker al desplegar)").toBeTruthy();
  if (!probe) return;
  const message = await mailbox.get(probe.ID);
  expect(message.From?.Address).toMatch(/^no-reply@/);
  expect(message.Text).toContain("la cola y el envío funcionan");
  expect(message.HTML).toContain("Drinks on Chain");
});

test("dueño de Altos: login, renovación tras recargar, parcelas, 422 por campo y cierre de sesión", async ({
  page,
}) => {
  needsDemoPassword();
  // El único error esperado es el 422 que se provoca en el perfil.
  const errors = trackErrors(page, [/^422 \/api\/v1\/users\/me$/]);

  await test.step("inicio de sesión a través de la reescritura /api/v1 (sin mocks)", async () => {
    const [login] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/v1/auth/login")),
      fillLogin(page, WINERY.altosOwner.email, DEMO_PASSWORD),
    ]);
    expect(login.status()).toBe(200);
    await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
    await expect(shellUser(page)).toContainText(WINERY.altosOwner.shellLabel);
    await settled(page);
    await softDashboard(page);
  });

  await test.step("la cookie de renovación doc_rt es de primera parte y HttpOnly", async () => {
    const cookie = (await page.context().cookies()).find((c) => c.name === "doc_rt");
    expect(cookie, "cookie doc_rt en el origen de la app").toBeTruthy();
    expect(cookie?.domain).toBe(new URL(page.url()).hostname);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe("/");
    // Nada de la sesión en el almacenamiento del navegador.
    const stored = await page.evaluate(() =>
      JSON.stringify([Object.entries(sessionStorage), Object.entries(localStorage)]),
    );
    expect(stored).not.toMatch(/token/i);
  });

  await test.step("la recarga mantiene la sesión (renovación con la cookie)", async () => {
    const [refresh] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/v1/auth/refresh")),
      page.reload(),
    ]);
    expect(refresh.status()).toBe(200);
    await expect(shellUser(page)).toContainText(WINERY.altosOwner.shellLabel);
    await settled(page);
  });

  await test.step("lista de parcelas desde el backend", async () => {
    const [list] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/terroirs" && r.request().method() === "GET"),
      page.getByRole("link", { name: "Origen y terroirs", exact: true }).first().click(),
    ]);
    expect(list.status()).toBe(200);
    const body = (await list.json()) as { data: { items: { name: string }[]; total: number } };
    expect(body.data.total).toBeGreaterThan(0);
    await expect(page.getByRole("heading", { level: 1, name: "Origen y terroirs" })).toBeVisible();
    await settled(page);
    await expect.soft(page.getByText("No se pudo cargar"), "lista de parcelas sin ErrorState").toHaveCount(0);
    await expect.soft(page.getByRole("link", { name: ALTOS_PARCEL }), "parcela de la semilla").toBeVisible();
  });

  await test.step("un 422 del backend marca el campo exacto (details[].field)", async () => {
    await shellUser(page).click();
    await page.getByRole("menuitem", { name: "Perfil" }).click();
    await expect(page.getByLabel("Teléfono")).toBeVisible();
    // 21 caracteres: el formulario lo admite y el backend lo rechaza (MaxLength 20). No se guarda.
    await page.getByLabel("Teléfono").fill("+59171234567890123456");
    const [rejected] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/v1/users/me") && r.request().method() === "PATCH"),
      page.getByRole("button", { name: "Guardar cambios" }).click(),
    ]);
    expect(rejected.status()).toBe(422);
    const body = (await rejected.json()) as { error: { details: { field: string | null }[] } };
    expect(body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: "phoneNumber" })]));
    await expect(page.getByLabel("Teléfono")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Nombre completo")).not.toHaveAttribute("aria-invalid", "true");
  });

  await test.step("cerrar sesión revoca la sesión: volver a la app pide login", async () => {
    await logout(page);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });

  expect(errors, "respuestas o errores inesperados").toEqual([]);
});

test("Sofía cambia de organización entre una bodega suspendida y una activa", async ({ page }) => {
  needsDemoPassword();
  // Casa Uriondo está SUSPENDED: el backend responde 403 ORG_NOT_ACTIVE a las rutas del ERP.
  const errors = trackErrors(page, [/^403 \/api\/v1\//]);
  await fillLogin(page, WINERY.sofia.email, DEMO_PASSWORD);
  await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
  await expect(orgSelector(page)).toBeVisible();

  // El backend recuerda la última organización usada: se parte de la que toque.
  if (!(await shellUser(page).textContent())?.includes(ORG.uriondo)) {
    await orgSelector(page).click();
    await page.getByRole("option", { name: new RegExp(ORG.uriondo) }).click();
  }
  await expect(shellUser(page)).toContainText(`Dirección · ${ORG.uriondo}`);
  await expect(page.getByRole("heading", { level: 1, name: "La bodega está suspendida" })).toBeVisible();

  const [switched] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/v1/auth/switch-organization")),
    (async () => {
      await orgSelector(page).click();
      await page.getByRole("option", { name: new RegExp(ORG.altos) }).click();
    })(),
  ]);
  expect(switched.status()).toBe(200);
  await expect(page.getByText(`Ahora trabajas en ${ORG.altos}.`, { exact: true })).toBeVisible();
  await expect(shellUser(page)).toContainText(WINERY.sofia.shellLabel);
  await settled(page);
  await softDashboard(page);

  // Permisos de la membresía activa (enóloga): lee las parcelas, no las da de alta.
  await page.getByRole("link", { name: "Origen y terroirs", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Origen y terroirs" })).toBeVisible();
  await settled(page);
  await expect.soft(page.getByRole("link", { name: ALTOS_PARCEL }), "parcela de la semilla").toBeVisible();
  await expect(page.getByRole("link", { name: "Nuevo terroir" })).toHaveCount(0);

  // La organización elegida sobrevive a la recarga (el refresco rotado en el cambio es el vigente).
  await page.reload();
  await expect(shellUser(page)).toContainText(WINERY.sofia.shellLabel);
  await logout(page);
  expect(errors, "respuestas o errores inesperados").toEqual([]);
});

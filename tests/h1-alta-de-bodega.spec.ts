import type { Page } from "@playwright/test";
import { CAPTCHA_TEST_TOKEN, DEMO_PASSWORD, DEMO_TOTP_SECRET } from "../src/config";
import { expect, needsDemoPassword, test } from "../src/fixtures/test";
import { ORG, PLATFORM } from "../src/fixtures/users";
import { ApiClient, missingRoutes, type LoginResult, type Membership, type Page as ListPage } from "../src/lib/api";
import { deactivateRunAccounts } from "../src/lib/cleanup";
import { MAILBOX_HELP, tokenFromLink } from "../src/lib/mailbox";
import { fillLogin, settled, shellUser, trackErrors } from "../src/lib/page";
import { runEmail, runName, runPassword, runTaxId } from "../src/lib/run-id";
import { freshTotp } from "../src/lib/totp";

// H1 · Alta de bodega (PLAN-MAESTRO, hito H1; contrato plan/contratos/o1-backoffice-y-bodegas.md):
//
//   administración invita a una persona de operaciones → acepta desde el correo (inscribe su TOTP)
//   → formulario público de solicitud (API, captcha de prueba) → verificación del correo →
//   operaciones toma y aprueba → el dueño acepta la invitación desde el correo y entra al ERP →
//   invita a una enóloga, que acepta → soporte bloquea a un operario y su sesión cae (401) →
//   alta directa de otra bodega → la bitácora del back office y la del dueño muestran los eventos.
//
// Todo lo que crea lleva el prefijo de la ejecución (correos `<alias>+<runId>@example.test`,
// nombres `… · <runId>`, NIT derivado); no toca a las personas ni a las bodegas de la semilla.
//
// Requiere O1-BE-1 desplegado: al empezar se consulta el OpenAPI del backend (/docs-json) y, si
// falta alguna ruta de la Etapa 1 (p. ej. contra otro entorno), la prueba se marca fixme con la
// lista de rutas que faltan en lugar de fallar.

const H1_ROUTES = [
  "/v1/auth/mfa/verify",
  "/v1/auth/mfa/enroll",
  "/v1/invitations/{token}",
  "/v1/invitations/{token}/accept",
  "/v1/platform/users",
  "/v1/public/winery-applications",
  "/v1/public/winery-applications/verify",
  "/v1/platform/winery-applications/{id}",
  "/v1/platform/winery-applications/{id}/take",
  "/v1/platform/winery-applications/{id}/approve",
  "/v1/platform/wineries",
  "/v1/platform/wineries/{id}",
  "/v1/organizations/current/invitations",
  "/v1/organizations/current/members",
  "/v1/platform/organizations/{organizationId}/members",
  "/v1/platform/organizations/{organizationId}/members/{membershipId}/block",
  "/v1/platform/audit",
  "/v1/organizations/current/audit",
] as const;

/** Contraseña de las personas que crea la ejecución (≥ 10 caracteres, no común). */
const NEW_PASSWORD = runPassword();

interface WinerySummary {
  id: string;
  tradeName: string;
  status: string;
  lotPrefix: string | null;
}

interface Member {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string;
  role: string;
  status: string;
}

interface AuditEvent {
  action: string;
  reason: string | null;
  actor: { viaPlatform: boolean } | null;
  organizationId: string | null;
}

/** Login del back office con el segundo factor (código generado con el secreto de la persona). */
async function backofficeLogin(page: Page, email: string, secret: string) {
  await fillLogin(page, email, DEMO_PASSWORD);
  await expect(page.getByRole("heading", { name: "Verificación en dos pasos" })).toBeVisible();
  await page.getByLabel("Código de verificación").fill(await freshTotp(secret));
  await expect(page.getByRole("heading", { name: "Tablero", level: 1 })).toBeVisible();
}

/** Ruta dentro de la app de un enlace de correo (el host del correo es el de la app desplegada). */
const appPath = (link: string) => {
  const url = new URL(link);
  return `${url.pathname}${url.search}`;
};

/** Acepta en el ERP una invitación de cuenta nueva desde el enlace del correo. */
async function acceptInErp(page: Page, link: string, fullName: string) {
  await page.goto(appPath(link));
  await expect(page.getByRole("heading", { name: "Crea tu cuenta" })).toBeVisible();
  await page.getByLabel("Nombre completo").fill(fullName);
  await page
    .getByLabel(/^Contraseña/)
    .first()
    .fill(NEW_PASSWORD);
  await page.getByLabel(/^Repite la contraseña/).fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Crear cuenta y entrar" }).click();
  await expect(page.getByText("Tareas pendientes", { exact: true })).toBeVisible({ timeout: 30_000 });
}

const erpNav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Navegación principal" }).getByRole("link", { name, exact: true }).click();

test.describe("H1 · de cero a bodega con equipo", () => {
  let missing: string[] = [];
  let openApiError: string | null = null;

  test.beforeAll(async () => {
    try {
      missing = await missingRoutes(H1_ROUTES);
    } catch (error) {
      openApiError = error instanceof Error ? error.message : String(error);
    }
  });

  // Al terminar (también si la prueba falla): ninguna cuenta creada por la ejecución queda activa.
  // Bloquea con la sesión ADMIN de demo la cuenta completa de cada persona `+<runId>@` y anula sus
  // invitaciones pendientes.
  test.afterAll(async ({ runId }) => {
    if (openApiError !== null || missing.length > 0 || !DEMO_PASSWORD || !DEMO_TOTP_SECRET) return;
    const admin = await ApiClient.create(`${runId} limpieza`);
    try {
      await admin.login(PLATFORM.admin.email, DEMO_PASSWORD, DEMO_TOTP_SECRET);
      const result = await deactivateRunAccounts(admin, runId, `Fin del recorrido E2E ${runId}`);
      console.log(
        `Limpieza ${runId}: ${result.blocked.length} cuenta(s) bloqueadas, ${result.alreadyBlocked.length} ya bloqueadas, ${result.revokedInvitations.length} invitación(es) anuladas`,
      );
      expect(result.remaining, "cuentas de la ejecución que siguen activas").toEqual([]);
    } finally {
      await admin.logout();
      await admin.dispose();
    }
  });

  test("superusuario → operaciones → solicitud → aprobación → dueño en el ERP → equipo → bloqueo → alta directa → bitácoras", async ({
    page,
    openApp,
    api,
    mailbox,
    runId,
  }) => {
    test.fixme(openApiError !== null, `No se pudo leer el OpenAPI del backend: ${openApiError ?? ""}`);
    test.fixme(
      missing.length > 0,
      `requiere O1-BE-1 desplegado: el OpenAPI de desarrollo aún no declara ${missing.join(", ")}`,
    );
    needsDemoPassword();
    test.skip(!mailbox, MAILBOX_HELP);
    test.skip(!DEMO_TOTP_SECRET, "Falta E2E_TOTP_SECRET (secreto TOTP del personal de plataforma de la semilla).");
    if (!mailbox) return;
    test.setTimeout(15 * 60_000);

    // Personas y datos de la ejecución.
    const ops = { email: runEmail(runId, "operaciones"), name: `Operaciones ${runId}` };
    const owner = { email: runEmail(runId, "duena"), name: `Dueña ${runId}` };
    const enologist = { email: runEmail(runId, "enologa"), name: `Enóloga ${runId}` };
    const operator = { email: runEmail(runId, "operario"), name: `Operario ${runId}` };
    const direct = { email: runEmail(runId, "dueno-directo"), name: `Dueño directo ${runId}` };
    const tradeName = runName(runId, "Bodega Norte");
    const directTradeName = runName(runId, "Bodega Sur");
    const blockReason = `Bloqueo de prueba ${runId}`;

    const adminErrors = trackErrors(page);
    let opsSecret = "";
    let applicationId = "";
    let wineryId = "";

    await test.step("administración invita a una persona de operaciones", async () => {
      await backofficeLogin(page, PLATFORM.admin.email, DEMO_TOTP_SECRET);
      await page.getByRole("link", { name: "Usuarios internos" }).click();
      await settled(page);
      await page.getByRole("button", { name: "Invitar usuario interno" }).click();
      const dialog = page.getByRole("dialog", { name: "Invitar a un usuario interno" });
      await dialog.getByLabel("Correo electrónico").fill(ops.email);
      await dialog.getByRole("combobox", { name: "Rol" }).click();
      await page.getByRole("option", { name: "Operaciones" }).click();
      await dialog.getByLabel("Motivo").fill(`Alta de operaciones para el recorrido ${runId}`);
      await dialog.getByRole("button", { name: "Enviar la invitación" }).click();
      await expect(page.getByText(`Invitación enviada a ${ops.email}.`, { exact: true })).toBeVisible();
    });

    const opsPage = await openApp("backoffice");
    const opsErrors = trackErrors(opsPage);

    await test.step("operaciones acepta desde el correo e inscribe su segundo factor", async () => {
      const link = await mailbox.waitForLink(ops.email, { link: /\/invitacion\// });
      await opsPage.goto(appPath(link));
      await opsPage.getByLabel("Nombre completo").fill(ops.name);
      await opsPage.getByRole("textbox", { name: "Contraseña", exact: true }).fill(NEW_PASSWORD);
      await opsPage.getByLabel("Repite la contraseña").fill(NEW_PASSWORD);
      await opsPage.getByRole("button", { name: "Crear la cuenta y aceptar" }).click();
      await expect(opsPage.getByRole("heading", { name: "Activa la verificación en dos pasos" })).toBeVisible();
      opsSecret = (await opsPage.getByLabel("Clave para escribirla a mano").inputValue()).replace(/\s+/g, "");
      expect(opsSecret).toMatch(/^[A-Z2-7]{16,}$/);
      await opsPage.getByLabel("Código de verificación").fill(await freshTotp(opsSecret));
      await opsPage.getByLabel("He guardado los códigos en un lugar seguro").check();
      await opsPage.getByRole("button", { name: "Entrar al back office" }).click();
      await expect(opsPage.getByRole("heading", { name: "Tablero", level: 1 })).toBeVisible();
      await expect(shellUser(opsPage)).toContainText(`Operaciones · ${ORG.platform}`);
    });

    await test.step("una bodega envía el formulario público y verifica su correo", async () => {
      const visitor = await api.anonymous(`${runId} formulario`, "PUBLIC");
      const created = await visitor.raw<{ id: string; status: string }>("POST", "/v1/public/winery-applications", {
        body: {
          legalName: `${tradeName} S.R.L.`,
          tradeName,
          taxId: runTaxId(runId, "solicitud"),
          category: "WINERY",
          region: "Valle Central de Tarija",
          contactName: owner.name,
          contactEmail: owner.email,
          contactPhone: null,
          message: `Solicitud de prueba ${runId}`,
          captchaToken: CAPTCHA_TEST_TOKEN,
          website: "",
        },
      });
      expect(created.status).toBe(202);
      expect(created.data?.status).toBe("UNVERIFIED");
      applicationId = created.data?.id ?? "";
      expect(applicationId).not.toBe("");

      // El backend responde 202 también cuando descarta la solicitud en silencio (campo trampa,
      // NIT ya registrado, > 3 envíos por correo o > 10 por IP en una hora): entonces no hay correo.
      const link = await mailbox
        .waitForLink(owner.email, { link: /\/unirse\/verificar\?token=/, timeoutMs: 90_000 })
        .catch((error: unknown) => {
          throw new Error(
            `${String(error)}. Si los logs del backend dicen «ignorada por el límite por correo o IP», esta IP ya envió 10 solicitudes en la última hora (p. ej. otras suites desde la misma máquina).`,
          );
        });
      const verified = await visitor.raw("POST", "/v1/public/winery-applications/verify", {
        body: { token: tokenFromLink(link) },
      });
      expect(verified.status).toBe(204);
    });

    await test.step("operaciones toma la solicitud y la aprueba", async () => {
      await opsPage.goto(`/solicitudes/${applicationId}`);
      await expect(opsPage.getByRole("heading", { name: tradeName, level: 1 })).toBeVisible();
      await opsPage.getByRole("button", { name: "Tomar la solicitud" }).click();
      await expect(
        opsPage.getByText("Solicitud tomada: ahora está en revisión y asignada a ti.", { exact: true }),
      ).toBeVisible();
      await opsPage.getByRole("button", { name: "Aprobar", exact: true }).click();
      const approve = opsPage.getByRole("dialog", { name: `Aprobar ${tradeName}` });
      await expect(approve.getByLabel("Correo del dueño")).toHaveValue(owner.email);
      await approve.getByRole("button", { name: "Aprobar y enviar la invitación" }).click();
      const notice = opsPage.getByRole("status").filter({ hasText: "Bodega creada e invitación enviada" });
      await expect(notice).toContainText(owner.email);
      await expect(opsPage.getByText("Aprobada", { exact: true }).first()).toBeVisible();
    });

    const ownerPage = await openApp("erp");
    const ownerErrors = trackErrors(ownerPage);

    await test.step("el dueño acepta la invitación desde el correo y entra al ERP", async () => {
      const link = await mailbox.waitForLink(owner.email, { link: /\/invitacion\// });
      await acceptInErp(ownerPage, link, owner.name);
      await expect(shellUser(ownerPage)).toContainText(`Dirección · ${tradeName}`);
    });

    // Comprobaciones por API con una sesión de operaciones (su propio TOTP, sin tocar la semilla).
    const opsApi = await api.as(ops.email, { password: NEW_PASSWORD, totpSecret: opsSecret });

    await test.step("la bodega queda ACTIVE con su prefijo de lote", async () => {
      const list = await opsApi.get<ListPage<WinerySummary>>("/v1/platform/wineries", { q: runId, limit: 20 });
      const winery = list.items.find((w) => w.tradeName === tradeName);
      expect(winery, `bodega ${tradeName} en el directorio`).toBeTruthy();
      wineryId = winery?.id ?? "";
      expect(winery?.status).toBe("ACTIVE");
      expect(winery?.lotPrefix).toMatch(/^[A-Z]{3,5}$/);
    });

    await test.step("el dueño invita a una enóloga y ella acepta desde el correo", async () => {
      await erpNav(ownerPage, "Equipo");
      await ownerPage.getByRole("button", { name: "Invitar" }).first().click();
      const dialog = ownerPage.getByRole("dialog", { name: "Invitar al equipo" });
      await dialog.getByLabel("Correo electrónico").fill(enologist.email);
      await dialog.getByRole("combobox", { name: "Rol en la bodega" }).click();
      await ownerPage.getByRole("option", { name: "Enología" }).click();
      await dialog.getByRole("button", { name: "Enviar invitación" }).click();
      await expect(ownerPage.getByText(`Invitación enviada a ${enologist.email}`, { exact: true })).toBeVisible();

      const enologistPage = await openApp("erp");
      const enologistErrors = trackErrors(enologistPage);
      const link = await mailbox.waitForLink(enologist.email, { link: /\/invitacion\// });
      await acceptInErp(enologistPage, link, enologist.name);
      await expect(shellUser(enologistPage)).toContainText(`Enología · ${tradeName}`);
      expect(enologistErrors, "errores en el ERP de la enóloga").toEqual([]);
    });

    const operatorPage = await openApp("erp");
    // Tras el bloqueo, sus peticiones responden 401: es lo que se prueba.
    const operatorErrors = trackErrors(operatorPage, [/^401 \/api\/v1\//, /^403 \/api\/v1\//]);
    const operatorApi = await api.anonymous(operator.email);
    // Sesión de API del dueño (una sola: cada inicio de sesión cuenta para el límite por IP).
    const ownerApi = await api.as(owner.email, { password: NEW_PASSWORD });

    await test.step("un operario se une al equipo (invitación del dueño por API) y entra al ERP", async () => {
      // El dueño invita por API: la pantalla de invitar ya se recorrió con la enóloga.
      await ownerApi.post("/v1/organizations/current/invitations", { email: operator.email, role: "OPERATOR" });
      const link = await mailbox.waitForLink(operator.email, { link: /\/invitacion\// });
      const accepted: LoginResult = await operatorApi.acceptInvitation(
        tokenFromLink(link),
        operator.name,
        NEW_PASSWORD,
      );
      expect(accepted.activeOrganizationId).toBe(wineryId);

      await fillLogin(operatorPage, operator.email, NEW_PASSWORD);
      await expect(operatorPage.getByText("Tareas pendientes", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(shellUser(operatorPage)).toContainText(`Operario · ${tradeName}`);
      expect((await operatorApi.raw("GET", "/v1/users/me")).status).toBe(200);
    });

    const supportPage = await openApp("backoffice");
    const supportErrors = trackErrors(supportPage);

    await test.step("soporte bloquea al operario en la bodega y su sesión cae", async () => {
      await backofficeLogin(supportPage, PLATFORM.support.email, DEMO_TOTP_SECRET);
      await supportPage.goto(`/bodegas/${wineryId}`);
      await expect(supportPage.getByRole("heading", { name: tradeName, level: 1 })).toBeVisible();
      await supportPage.getByRole("tab", { name: /Equipo/ }).click();
      const row = supportPage.getByRole("row").filter({ hasText: operator.name });
      await row.getByRole("button", { name: `Acciones de ${operator.name}` }).click();
      await supportPage.getByRole("menuitem", { name: "Bloquear en esta bodega" }).click();
      const block = supportPage.getByRole("alertdialog", { name: new RegExp(`Bloquear a ${operator.name}`) });
      await block.getByLabel("Motivo").fill(blockReason);
      await block.getByRole("button", { name: "Bloquear" }).click();
      await expect(
        supportPage.getByText(`${operator.name} quedó bloqueado en ${tradeName}.`, { exact: true }),
      ).toBeVisible();
      await expect(row).toContainText("Bloqueado por la plataforma");

      // Revocación inmediata (IAM-13): el acceso vigente deja de valer en la siguiente petición.
      const next = await operatorApi.raw("GET", "/v1/users/me");
      expect(next.status, "la siguiente petición del operario").toBe(401);
      // Y la renovación con su cookie tampoco devuelve la sesión.
      expect((await operatorApi.refresh()).status).toBe(401);
      // En el navegador, la siguiente navegación lo devuelve al login.
      await operatorPage.reload();
      await expect(operatorPage).toHaveURL(/\/login/, { timeout: 30_000 });
    });

    await test.step("operaciones da de alta otra bodega directamente", async () => {
      await opsPage.getByRole("link", { name: "Bodegas", exact: true }).click();
      await settled(opsPage);
      await opsPage.getByRole("link", { name: "Nueva bodega" }).click();
      await expect(opsPage.getByRole("heading", { name: "Nueva bodega", level: 1 })).toBeVisible();
      await opsPage.getByLabel("Razón social").fill(`${directTradeName} S.R.L.`);
      await opsPage.getByLabel("Nombre comercial").fill(directTradeName);
      await opsPage.getByRole("textbox", { name: "NIT", exact: true }).fill(runTaxId(runId, "alta-directa"));
      await opsPage.getByLabel("Región").fill("Valle de Cinti");
      await opsPage.getByRole("textbox", { name: "Correo de contacto", exact: true }).fill(direct.email);
      await opsPage.getByLabel("Nombre del dueño").fill(direct.name);
      await opsPage.getByLabel("Correo del dueño").fill(direct.email);
      await opsPage.getByLabel("Motivo").fill(`Alta directa del recorrido ${runId}`);
      await opsPage.getByRole("button", { name: "Dar de alta e invitar al dueño" }).click();
      await expect(
        opsPage.getByText(`${directTradeName} dada de alta. Invitación enviada a ${direct.email}.`, { exact: true }),
      ).toBeVisible();
      await expect(opsPage.getByText("Invitada", { exact: true }).first()).toBeVisible();
      // La invitación del dueño llega al buzón con el enlace al ERP.
      expect(await mailbox.waitForLink(direct.email, { link: /\/invitacion\// })).toMatch(/\/invitacion\//);
    });

    await test.step("la bitácora del back office muestra los eventos de la bodega", async () => {
      const events = await opsApi.get<ListPage<AuditEvent>>("/v1/platform/audit", {
        organizationId: wineryId,
        limit: 100,
      });
      const actions = events.items.map((e) => e.action);
      expect(
        actions.some((a) => /APPROV|ACTIVAT/.test(a)),
        `aprobación o activación en ${actions.join(", ")}`,
      ).toBe(true);
      expect(
        actions.some((a) => /INVIT/.test(a)),
        `invitaciones en ${actions.join(", ")}`,
      ).toBe(true);
      expect(events.items.some((e) => /BLOCK/.test(e.action) && e.reason === blockReason)).toBe(true);

      await opsPage.goto(`/bitacora?organizacion=${wineryId}`);
      await settled(opsPage);
      await expect(opsPage.getByRole("row").filter({ hasText: blockReason }).first()).toBeVisible();
    });

    await test.step("la bitácora del dueño muestra el bloqueo hecho por la plataforma", async () => {
      await erpNav(ownerPage, "Bitácora");
      await expect(ownerPage.getByRole("heading", { level: 1, name: "Bitácora de la bodega" })).toBeVisible();
      await expect(ownerPage.getByRole("row", { name: new RegExp(blockReason) })).toBeVisible();

      const own = await ownerApi.get<ListPage<AuditEvent>>("/v1/organizations/current/audit", { limit: 100 });
      const blocked = own.items.find((e) => /BLOCK/.test(e.action) && e.reason === blockReason);
      expect(blocked?.actor?.viaPlatform, "el bloqueo figura como hecho por la plataforma").toBe(true);
      const members = await ownerApi.get<ListPage<Member>>("/v1/organizations/current/members", { limit: 100 });
      expect(members.items.find((m) => m.email === operator.email)?.status).toBe("BLOCKED");
      expect(members.items.find((m) => m.email === enologist.email)?.role).toBe("ENOLOGIST");
      const memberships: Membership[] = ownerApi.session?.memberships ?? [];
      expect(memberships.find((m) => m.organizationId === wineryId)?.role).toBe("OWNER");
    });

    expect(adminErrors, "errores en el back office de administración").toEqual([]);
    expect(opsErrors, "errores en el back office de operaciones").toEqual([]);
    expect(ownerErrors, "errores en el ERP del dueño").toEqual([]);
    expect(supportErrors, "errores en el back office de soporte").toEqual([]);
    expect(operatorErrors, "errores en el ERP del operario").toEqual([]);
  });
});

import { readFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { DEMO_PASSWORD, DEMO_TOTP_SECRET } from "../src/config";
import { expect, needsDemoPassword, test } from "../src/fixtures/test";
import { PLATFORM } from "../src/fixtures/users";
import { ApiClient, missingRoutes } from "../src/lib/api";
import { deactivateRunAccounts, retireRunWineries } from "../src/lib/cleanup";
import { daysAgo } from "../src/lib/dates";
import { MAILBOX_HELP } from "../src/lib/mailbox";
import { fillLogin, settled, shellUser, trackErrors } from "../src/lib/page";
import { runEmail, runName, runPassword, runWineryName } from "../src/lib/run-id";
import {
  createParcel,
  createRunWinery,
  inviteTeam,
  prepareRestingSinganiLot,
  SINGANI_VARIETY,
  SMALL_BOTTLING,
  type RunPerson,
} from "../src/lib/run-winery";

// H2 · Recorrido entre aplicaciones (PLAN-MAESTRO, hito H2; contrato
// plan/contratos/o2-erp-confiable.md §18): el lote "Singani Gran Reserva 2026" de la parcela a los
// códigos de botella por la **interfaz del ERP**, con los intentos de elusión que el servidor
// rechaza y la pantalla explica, y el pasaporte real en el **visor del Marketplace**.
//
//   por la API: dos bodegas de la ejecución (la del recorrido, con dueña, enóloga, agrónomo y
//   operario; y una vecina), parcelas y tres lotes pequeños ya en reposo → por la API directa:
//   la plataforma no escribe, el grafo de otra bodega no existe, dos embotellados simultáneos de
//   dos bodegas no chocan → por la interfaz del ERP: la enóloga crea el lote → el operario pesa
//   18.400 kg (antes, de una parcela a 1.540 m: rechazado) → análisis de madurez → tanque con la
//   uva pendiente: rechazado → el agrónomo aprueba → tanque de 12.100 L, lectura, destino singani
//   → destilación cerrada (cortes mayores que la entrada: rechazados) → la plataforma cambia el
//   reposo mínimo de la bodega y el lote no se entera → vista previa (más botellas y más alcohol:
//   rechazados) y embotellado de 2.950 botellas → CSV de los códigos → segundo embotellado:
//   rechazado → expediente sin laboratorio: rechazado → laboratorio conforme → expediente
//   cerrado con huella → corrección posterior: rechazada → embotellar un lote con el reposo sin
//   cumplir: rechazado → el visor abre `/b/{lotCode}` y `/b/{código}` de una botella del CSV, y
//   el lote sin laboratorio de la bodega vecina con "No registrado".
//
// Todo es de la ejecución (`… · <runId>`, `+<runId>@`): al terminar se restablece el ajuste de
// configuración, se bloquean las cuentas y se revocan las dos bodegas (afterAll).
//
// Inicios de sesión: administración por la API (con TOTP) y tres por la interfaz (enóloga,
// operario y agrónomo, cada uno en su navegador); las sesiones de API de la bodega nacen al
// aceptar las invitaciones. `paceLogin` reparte los inicios de sesión bajo el límite por IP.

const H2_ROUTES = [
  "/v1/platform/wineries",
  "/v1/platform/settings/{key}/overrides",
  "/v1/platform/settings/{key}/overrides/reset",
  "/v1/organizations/current/invitations",
  "/v1/terroirs",
  "/v1/lots",
  "/v1/lots/{id}/graph",
  "/v1/lots/{id}/bottling/preview",
  "/v1/lots/{id}/bottling",
  "/v1/lots/{id}/bottle-codes/export",
  "/v1/lots/{id}/lab-analyses",
  "/v1/lots/{id}/dossier/close",
  "/v1/lots/{id}/corrections",
  "/v1/harvest-batches/{id}/maturity-analyses",
  "/v1/harvest-batches/{id}/phyto-decisions",
  "/v1/fermentation-tanks/{id}/complete",
  "/v1/production-batches/{id}/close",
  "/v1/public/passports/{code}",
] as const;

const REST_SETTING = "trazabilidad.singani.reposoMinimoDias";
const REGION = "Valle de Cinti";
const PARCEL = "Parcela Alta";
/** Parcela a 1.540 m: bajo los 1.600 m de la D.O. Singani (contrato §18). */
const LOW_PARCEL = "El Portillo";
const BOTTLES = 2950;
const SERIAL = 1234;

/** Contraseña de las personas que crea la ejecución (≥ 10 caracteres, no común). */
const NEW_PASSWORD = runPassword();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Aviso con el que la interfaz explica una regla que el servidor rechazó (lleva su código `TRC_…`). */
const ruleNotice = (scope: Page | Locator) => scope.getByTestId("rule-violation-notice");

const erpNav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Navegación principal" }).getByRole("link", { name, exact: true }).click();

/** Entra al ERP y espera el panel (el del operario son sus accesos directos). */
async function erpLogin(page: Page, person: RunPerson, shellLabel: string) {
  await fillLogin(page, person.email, NEW_PASSWORD);
  await expect(page.getByText("Tareas pendientes", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(shellUser(page)).toContainText(shellLabel);
}

/** Abre la ficha de un pesaje desde "Vendimia y laboratorio". */
async function openHarvest(page: Page, harvestCode: string) {
  await erpNav(page, "Vendimia y laboratorio");
  await page.getByRole("link", { name: harvestCode, exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: harvestCode })).toBeVisible({ timeout: 20_000 });
}

/** Sección del pasaporte del visor por su título. */
const section = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test.describe("H2 · del lote a la botella por el ERP, con el pasaporte en el Marketplace", () => {
  let missing: string[] = [];
  let openApiError: string | null = null;
  /** Bodega con el ajuste de reposo cambiado por el recorrido (se restablece al terminar). */
  let overriddenWinery: string | null = null;

  test.beforeAll(async () => {
    try {
      missing = await missingRoutes(H2_ROUTES);
    } catch (error) {
      openApiError = error instanceof Error ? error.message : String(error);
    }
  });

  // Al terminar (también si la prueba falla): el ajuste de configuración vuelve al estándar, las
  // cuentas quedan bloqueadas y las dos bodegas, revocadas (con sus lotes dentro).
  test.afterAll(async ({ runId }) => {
    if (openApiError !== null || missing.length > 0 || !DEMO_PASSWORD || !DEMO_TOTP_SECRET) return;
    const admin = await ApiClient.create(`${runId} limpieza`);
    try {
      await admin.login(PLATFORM.admin.email, DEMO_PASSWORD, DEMO_TOTP_SECRET);
      const reason = `Fin del recorrido E2E ${runId}`;
      if (overriddenWinery) {
        await admin.post(`/v1/platform/settings/${REST_SETTING}/overrides/reset`, {
          wineryIds: [overriddenWinery],
          reason,
        });
      }
      const accounts = await deactivateRunAccounts(admin, runId, reason);
      const wineries = await retireRunWineries(admin, runId, reason);
      console.log(
        `Limpieza ${runId}: ${accounts.blocked.length} cuenta(s) bloqueadas, ${wineries.revoked.length} bodega(s) revocadas`,
      );
      expect(accounts.remaining, "cuentas de la ejecución que siguen activas").toEqual([]);
      expect(wineries.stillPublic, "bodegas de la ejecución que siguen en la lista pública").toEqual([]);
    } finally {
      await admin.logout();
      await admin.dispose();
    }
  });

  test("bodega de la ejecución → lote singani por la interfaz del ERP con sus elusiones → expediente cerrado → pasaporte en el visor", async ({
    page,
    openApp,
    api,
    mailbox,
    runId,
  }) => {
    test.fixme(openApiError !== null, `No se pudo leer el OpenAPI del backend: ${openApiError ?? ""}`);
    test.fixme(
      missing.length > 0,
      `requiere O2-BE-1 desplegado: el OpenAPI de desarrollo aún no declara ${missing.join(", ")}`,
    );
    needsDemoPassword();
    test.skip(!mailbox, MAILBOX_HELP);
    test.skip(!DEMO_TOTP_SECRET, "Falta E2E_TOTP_SECRET (secreto TOTP del personal de plataforma de la semilla).");
    if (!mailbox) return;
    test.setTimeout(14 * 60_000);
    const startedAt = Date.now();
    const lap = (what: string) => {
      test
        .info()
        .annotations.push({ type: "tiempo", description: `${what}: ${Math.round((Date.now() - startedAt) / 1000)} s` });
    };

    // Bodegas, personas y lotes de la ejecución (alias y nombres propios de este recorrido).
    const tradeName = runWineryName(runId, "Destilería", 2);
    const neighbourName = runWineryName(runId, "Destilería", 3);
    const people = {
      owner: { email: runEmail(runId, "recorrido-duena"), name: `Dueña del recorrido ${runId}` },
      enologist: { email: runEmail(runId, "recorrido-enologa"), name: `Enóloga del recorrido ${runId}` },
      agronomist: { email: runEmail(runId, "recorrido-agronomo"), name: `Agrónomo del recorrido ${runId}` },
      operator: { email: runEmail(runId, "recorrido-operario"), name: `Operario del recorrido ${runId}` },
      neighbour: { email: runEmail(runId, "recorrido-vecina"), name: `Dueña vecina del recorrido ${runId}` },
    };
    const LOT = runName(runId, "Singani Gran Reserva 2026");
    const YOUNG_LOT = runName(runId, "Singani joven");
    const SPARE_LOT = runName(runId, "Singani de partida corta");
    const NEIGHBOUR_LOT = runName(runId, "Singani de la vecina");
    const suffix = runId.split("-").at(-1) ?? runId;
    const reason = `Recorrido E2E ${runId}`;

    // Sesiones de API: administración inicia sesión (TOTP); las personas de las bodegas quedan
    // con sesión al aceptar su invitación.
    const ownerApi = await api.anonymous(people.owner.email);
    const enologistApi = await api.anonymous(people.enologist.email);
    const agronomistApi = await api.anonymous(people.agronomist.email);
    const operatorApi = await api.anonymous(people.operator.email);
    const neighbourApi = await api.anonymous(people.neighbour.email);
    const visitor = await api.anonymous(`${runId} visitante`);
    const admin = await api.as(PLATFORM.admin.email, { totpSecret: DEMO_TOTP_SECRET });

    let wineryId = "";
    let neighbourId = "";
    let parcelId = "";
    let youngLot = { lotId: "", productionId: "", unlockDate: "", released: false };
    let spareLot = youngLot;
    let neighbourLot = youngLot;
    let neighbourLotCode = "";
    let lotId = "";
    let harvestCode = "";
    let lotCode = "";
    let hash = "";
    let bottleCode = "";
    let bottleFormatted = "";

    // ───────────────────────── Preparación por la API ─────────────────────────

    await test.step("la plataforma da de alta las dos bodegas de la ejecución; sus dueñas aceptan y la del recorrido forma su equipo", async () => {
      wineryId = await createRunWinery(admin, mailbox, {
        runId,
        tradeName,
        taxSalt: "recorrido",
        region: REGION,
        owner: people.owner,
        ownerClient: ownerApi,
        password: NEW_PASSWORD,
      });
      neighbourId = await createRunWinery(admin, mailbox, {
        runId,
        tradeName: neighbourName,
        taxSalt: "recorrido-vecina",
        region: REGION,
        owner: people.neighbour,
        ownerClient: neighbourApi,
        password: NEW_PASSWORD,
      });
      expect(neighbourId).not.toBe(wineryId);
      await inviteTeam(
        ownerApi,
        mailbox,
        [
          [enologistApi, people.enologist, "ENOLOGIST"],
          [agronomistApi, people.agronomist, "AGRONOMIST"],
          [operatorApi, people.operator, "OPERATOR"],
        ],
        NEW_PASSWORD,
      );
      test
        .info()
        .annotations.push({ type: "bodegas", description: `${tradeName} y ${neighbourName} (se revocan al terminar)` });
      lap("bodegas y equipo");
    });

    await test.step("parcelas (una apta y El Portillo a 1.540 m) y lotes pequeños en reposo: uno reciente y dos con el reposo cumplido", async () => {
      const parcel = await createParcel(ownerApi, { parcelName: PARCEL, altitudeMasl: 2350 });
      const low = await createParcel(ownerApi, { parcelName: LOW_PARCEL, altitudeMasl: 1540 });
      parcelId = parcel.id;
      // La aptitud D.O. la calcula el servidor (EA-03).
      expect({ apta: parcel.isDoEligible, portillo: low.isDoEligible }).toEqual({ apta: true, portillo: false });
      const neighbourParcel = await createParcel(neighbourApi, { parcelName: "Parcela Vecina", altitudeMasl: 2300 });

      // Destilación cerrada hace 5 días: le faltan 175 de reposo.
      youngLot = await prepareRestingSinganiLot(enologistApi, {
        name: YOUNG_LOT,
        parcelId,
        tankCode: `TK-J-${suffix}`,
        restEndDaysAgo: 5,
      });
      expect(youngLot.released, "candado del lote joven").toBe(false);
      spareLot = await prepareRestingSinganiLot(enologistApi, {
        name: SPARE_LOT,
        parcelId,
        tankCode: `TK-P-${suffix}`,
        restEndDaysAgo: 185,
      });
      neighbourLot = await prepareRestingSinganiLot(neighbourApi, {
        name: NEIGHBOUR_LOT,
        parcelId: neighbourParcel.id,
        tankCode: `TK-V-${suffix}`,
        restEndDaysAgo: 185,
      });
      expect([spareLot.released, neighbourLot.released], "candados de los lotes con el reposo cumplido").toEqual([
        true,
        true,
      ]);
      lap("parcelas y lotes de apoyo");
    });

    // ──────────────── Elusiones por la API directa (no se alcanzan desde la interfaz) ────────────────

    await test.step("API · la plataforma solo lee la trazabilidad (TRC_PLATFORM_READ_ONLY) y el grafo de otra bodega no existe (404)", async () => {
      // El ERP no ofrece ninguna escritura a la plataforma: solo se puede intentar por la API.
      const write = await admin.raw("POST", "/v1/lots", {
        query: { wineryId },
        body: { name: runName(runId, "Lote de la plataforma"), harvestYear: Number(daysAgo(0).slice(0, 4)) },
      });
      expect({ status: write.status, code: write.error?.code }).toEqual({
        status: 403,
        code: "TRC_PLATFORM_READ_ONLY",
      });

      // SE-07: una persona de otra bodega no ve el grafo (404, no 403: no revela que el lote existe).
      const foreign = await neighbourApi.raw("GET", `/v1/lots/${spareLot.lotId}/graph`);
      expect({ status: foreign.status, code: foreign.error?.code }).toEqual({ status: 404, code: "TRC_LOT_NOT_FOUND" });
      expect((await enologistApi.raw("GET", `/v1/lots/${spareLot.lotId}/graph`)).status).toBe(200);
      // La plataforma sí lo lee, indicando la bodega.
      expect((await admin.raw("GET", `/v1/lots/${spareLot.lotId}/graph`, { query: { wineryId } })).status).toBe(200);
    });

    await test.step("API · dos embotellados simultáneos de dos bodegas no chocan en el código de lote", async () => {
      // Dos peticiones a la vez no se pueden lanzar desde una pantalla: van por la API.
      const body = { ...SMALL_BOTTLING, bottlingDate: daysAgo(1) };
      const [ours, theirs] = await Promise.all([
        enologistApi.raw<{ lotCode: string }>("POST", `/v1/lots/${spareLot.lotId}/bottling`, { body }),
        neighbourApi.raw<{ lotCode: string }>("POST", `/v1/lots/${neighbourLot.lotId}/bottling`, { body }),
      ]);
      expect([ours.status, theirs.status], `${ours.error?.code ?? ""} ${theirs.error?.code ?? ""}`).toEqual([201, 201]);
      const [ourCode, theirCode] = [ours.data?.lotCode ?? "", theirs.data?.lotCode ?? ""];
      expect(ourCode).toMatch(/^[A-Z]{3,5}-\d{4}-SINGANI-001$/);
      expect(theirCode).toMatch(/^[A-Z]{3,5}-\d{4}-SINGANI-001$/);
      expect(ourCode, "códigos de lote distintos (prefijo de cada bodega)").not.toBe(theirCode);
      neighbourLotCode = theirCode;
      lap("elusiones por la API");
    });

    // ───────────────────────── Recorrido por la interfaz del ERP ─────────────────────────

    // La enóloga, en la página de la prueba; el operario y el agrónomo, cada uno en su navegador.
    const enologist = page;
    const enologistErrors = trackErrors(enologist, [
      /^422 \/api\/v1\/fermentation-tanks$/,
      /^422 \/api\/v1\/production-batches\/[\w-]+\/close$/,
      /^409 \/api\/v1\/lots\/[\w-]+\/bottling\/preview$/,
      /^422 \/api\/v1\/lots\/[\w-]+\/dossier\/close$/,
      /^409 \/api\/v1\/lots\/[\w-]+\/corrections$/,
    ]);
    const operator = await openApp("erp");
    const operatorErrors = trackErrors(operator, [/^422 \/api\/v1\/harvest-batches$/]);
    const agronomist = await openApp("erp");
    const agronomistErrors = trackErrors(agronomist);

    await test.step("ERP · la enóloga crea el lote singani: estimación 3.000, 75 cL, 40 %, e instantánea de reglas a la vista", async () => {
      await erpLogin(enologist, people.enologist, `Enología · ${tradeName}`);
      await erpNav(enologist, "Lotes");
      await enologist.getByRole("link", { name: "Nuevo lote" }).click();
      await expect(enologist.getByRole("heading", { name: "Nuevo lote" })).toBeVisible();
      await enologist.getByLabel("Nombre del lote").fill(LOT);
      await enologist.getByRole("combobox", { name: "Tipo de producto" }).click();
      await enologist.getByRole("option", { name: "Singani" }).click();
      await enologist.getByLabel("Botellas estimadas").fill("3.000");
      await enologist.getByLabel("Formato previsto").fill("75");
      await enologist.getByLabel("Grado previsto de la botella").fill("40");
      const [created] = await Promise.all([
        enologist.waitForResponse((r) => r.url().endsWith("/api/v1/lots") && r.request().method() === "POST"),
        enologist.getByRole("button", { name: "Crear lote" }).click(),
      ]);
      expect(created.status()).toBe(201);
      lotId = ((await created.json()) as { data: { id: string } }).data.id;
      await expect(enologist.getByRole("heading", { name: LOT })).toBeVisible({ timeout: 20_000 });
      const rules = enologist.getByLabel("Instantánea de reglas del lote");
      await expect(rules).toContainText("1.600 m s. n. m.");
      await expect(rules).toContainText(SINGANI_VARIETY);
      await expect(rules).toContainText("180 días");
      await expect(rules).toContainText("5 %");
      lap("lote creado");
    });

    await test.step("ERP · el operario pesa 18.400 kg de hace 200 días; desde El Portillo (1.540 m) el lote singani lo rechaza (TRC_DO_TERROIR_NOT_ELIGIBLE)", async () => {
      await erpLogin(operator, people.operator, tradeName);
      await erpNav(operator, "Vendimia y laboratorio");
      await operator.getByRole("link", { name: "Registrar ingreso" }).click();
      await operator.getByRole("combobox", { name: "Lote" }).click();
      await operator.getByRole("option", { name: new RegExp(escapeRe(LOT)) }).click();
      await operator.getByRole("combobox", { name: "Terroir de origen" }).click();
      await operator.getByRole("option", { name: new RegExp(escapeRe(LOW_PARCEL)) }).click();
      await operator.getByLabel("Fecha y hora de ingreso").fill(`${daysAgo(200)}T08:00`);
      await operator.getByLabel("Peso bruto").fill("18.550");
      await operator.getByLabel("Tara").fill("150");
      await operator.getByRole("button", { name: "Registrar ingreso" }).click();
      await expect(ruleNotice(operator)).toContainText("TRC_DO_TERROIR_NOT_ELIGIBLE", { timeout: 20_000 });

      // Con la parcela apta, el mismo pesaje entra al lote.
      await operator.getByRole("combobox", { name: "Terroir de origen" }).click();
      await operator.getByRole("option", { name: new RegExp(escapeRe(PARCEL)) }).click();
      const [created] = await Promise.all([
        operator.waitForResponse((r) => r.url().endsWith("/api/v1/harvest-batches") && r.request().method() === "POST"),
        operator.getByRole("button", { name: "Registrar ingreso" }).click(),
      ]);
      expect(created.status()).toBe(201);
      const heading = operator.getByRole("heading", { level: 1, name: /^HARV-/ });
      await expect(heading).toBeVisible({ timeout: 20_000 });
      harvestCode = ((await heading.textContent()) ?? "").trim();
      await expect(operator.getByText("18.400 kg").first()).toBeVisible();
      await expect(operator.getByText("Pendiente de inspección").first()).toBeVisible();
      // El operario pesa, no dictamina.
      await expect(operator.getByRole("button", { name: "Aprobar lote" })).toHaveCount(0);
      lap("pesaje");
    });

    await test.step("ERP · la enóloga registra el análisis de madurez; un tanque con la uva pendiente de dictamen se rechaza (TRC_PHYTO_NOT_APPROVED)", async () => {
      await openHarvest(enologist, harvestCode);
      await enologist.getByRole("button", { name: "Registrar análisis" }).click();
      const maturity = enologist.getByRole("dialog", { name: "Registrar análisis de madurez" });
      await maturity.getByLabel("Grados Brix").fill("23,4");
      await maturity.getByLabel("pH").fill("3,4");
      await maturity.getByLabel("Acidez total").fill("5,9");
      await maturity.getByLabel("Fecha y hora de la medición").fill(`${daysAgo(200)}T10:00`);
      await maturity.getByRole("button", { name: "Guardar análisis" }).click();
      await expect(enologist.getByText("Análisis registrado", { exact: true })).toBeVisible({ timeout: 20_000 });

      await erpNav(enologist, "Vinificación");
      await enologist.getByRole("link", { name: "Llenar tanque" }).click();
      await enologist.getByRole("checkbox", { name: harvestCode }).click();
      await enologist.getByLabel("Capacidad").fill("15000");
      await enologist.getByLabel("Volumen llenado").fill("12.100");
      await enologist.getByLabel("Fecha de inicio").fill(daysAgo(199));
      await enologist.getByRole("button", { name: "Llenar tanque" }).first().click();
      await expect(ruleNotice(enologist)).toContainText("TRC_PHYTO_NOT_APPROVED", { timeout: 20_000 });
    });

    await test.step("ERP · el agrónomo aprueba el dictamen fitosanitario", async () => {
      await erpLogin(agronomist, people.agronomist, `Agronomía · ${tradeName}`);
      await openHarvest(agronomist, harvestCode);
      await agronomist.getByRole("button", { name: "Aprobar lote" }).click();
      await agronomist.getByRole("dialog").getByRole("button", { name: "Sí, aprobar" }).click();
      await expect(agronomist.getByText("Lote aprobado").first()).toBeVisible({ timeout: 20_000 });
      await expect(agronomist.getByRole("list", { name: "Historial de dictámenes" })).toContainText("Agronomía");
      lap("análisis y dictamen");
    });

    await test.step("ERP · tanque de 12.100 L, lectura y fermentación completada con destino singani", async () => {
      await openHarvest(enologist, harvestCode);
      await enologist.getByRole("link", { name: "Llenar tanque" }).first().click();
      await expect(enologist.getByRole("checkbox", { name: harvestCode })).toBeChecked({ timeout: 20_000 });
      await enologist.getByLabel("Capacidad").fill("15000");
      await enologist.getByLabel("Volumen llenado").fill("12.100");
      await enologist.getByLabel("Fecha de inicio").fill(daysAgo(199));
      const [created] = await Promise.all([
        enologist.waitForResponse(
          (r) => r.url().endsWith("/api/v1/fermentation-tanks") && r.request().method() === "POST",
        ),
        enologist.getByRole("button", { name: "Llenar tanque" }).first().click(),
      ]);
      expect(created.status()).toBe(201);
      await expect(enologist.getByRole("heading", { level: 1, name: /^TK-/ })).toBeVisible({ timeout: 20_000 });
      await settled(enologist);

      await enologist.getByRole("button", { name: "Añadir registro diario" }).first().click();
      const log = enologist.getByRole("dialog", { name: "Añadir registro diario" });
      await log.getByLabel("Temperatura").fill("22,4");
      await log.getByLabel("Densidad").fill("1,012");
      await log.getByLabel("Fecha y hora").fill(`${daysAgo(197)}T09:00`);
      await log.getByRole("button", { name: "Guardar lectura" }).click();
      await expect(log).toBeHidden({ timeout: 20_000 });

      await enologist.getByRole("button", { name: "Completar fermentación" }).click();
      const decision = enologist.getByRole("dialog", { name: /Completar la fermentación de TK-/ });
      await decision.getByLabel("Fin de la fermentación").fill(daysAgo(195));
      await decision.getByRole("button", { name: /A destilación/ }).click();
      await decision.getByRole("checkbox").click();
      await decision.getByRole("button", { name: "Confirmar destino y completar" }).click();
      await expect(enologist.getByText("Destino: Destilación (singani)", { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      lap("fermentación");
    });

    await test.step("ERP · destilación cerrada con cabezas 120, corazón 1.500 al 60 % y colas 210 hace 190 días: reposo cumplido; cortes mayores que la entrada se rechazan (TRC_MASS_BALANCE_EXCEEDED)", async () => {
      await enologist.getByRole("link", { name: "Pasar a destilación" }).click();
      await expect(enologist.getByRole("heading", { name: "Registrar destilación" })).toBeVisible();
      await enologist.getByLabel("Alambique").fill(`Alambique E2E ${suffix}`);
      await enologist.getByLabel("Volumen de entrada").fill("12.100");
      await enologist.getByLabel("Inicio").fill(daysAgo(192));
      await enologist.getByRole("button", { name: "Abrir destilación" }).first().click();
      const close = enologist.getByRole("form", { name: "Cerrar destilación" });
      await expect(close).toBeVisible({ timeout: 20_000 });
      await close.getByLabel("Cabezas").fill("120");
      await close.getByRole("textbox", { name: "Corazón", exact: true }).fill("90.000");
      await close.getByLabel("Colas").fill("210");
      await close.getByLabel("Grado del corazón").fill("60");
      await close.getByLabel("Fin de la destilación").fill(daysAgo(190));
      await close.getByRole("button", { name: "Cerrar destilación" }).click();
      await expect(ruleNotice(close)).toContainText("TRC_MASS_BALANCE_EXCEEDED", { timeout: 20_000 });

      await close.getByRole("textbox", { name: "Corazón", exact: true }).fill("1.500");
      await close.getByRole("button", { name: "Cerrar destilación" }).click();
      await expect(enologist.getByText("Destilación cerrada", { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(enologist.getByText("Candado liberado")).toBeVisible({ timeout: 20_000 });
      lap("destilación");
    });

    await test.step("API · la plataforma sube el reposo mínimo de la bodega a 365 días a mitad de proceso: vale para los lotes nuevos, no para el del recorrido", async () => {
      // La configuración es del back office (otra app): el cambio se hace por la API de plataforma.
      const changed = await admin.raw<{ updated: number }>("PUT", `/v1/platform/settings/${REST_SETTING}/overrides`, {
        body: { wineryIds: [wineryId], value: 365, reason },
      });
      expect({ status: changed.status, updated: changed.data?.updated }, changed.error?.code).toEqual({
        status: 200,
        updated: 1,
      });
      overriddenWinery = wineryId;
      const later = await enologistApi.post<{ rules: { singani: { minRestDays: number } } }>("/v1/lots", {
        name: runName(runId, "Singani con la regla nueva"),
        harvestYear: Number(daysAgo(0).slice(0, 4)),
        productType: "SINGANI",
      });
      expect(later.rules.singani.minRestDays, "instantánea de un lote creado tras el cambio").toBe(365);
      const ours = await enologistApi.get<{ rules: { singani: { minRestDays: number } }; stage: string }>(
        `/v1/lots/${lotId}`,
      );
      expect(ours, "el lote del recorrido conserva su instantánea").toMatchObject({
        stage: "RESTING",
        rules: { singani: { minRestDays: 180 } },
      });
      // El embotellado del paso siguiente lo confirma: con 365 días el candado no estaría liberado.
    });

    await test.step("ERP · vista previa: más botellas y más alcohol de los que hay (TRC_BOTTLING_EXCEEDS_VOLUME, TRC_ALCOHOL_BALANCE_EXCEEDED); después, 2.950 botellas de 75 cL al 40 % con 750 L de agua", async () => {
      await enologist.getByRole("link", { name: "Pasar a embotellado" }).click();
      await expect(enologist.getByRole("heading", { name: `Embotellar ${LOT}` })).toBeVisible({ timeout: 20_000 });
      const preview = enologist.getByLabel("Vista previa del servidor");
      const submit = enologist.getByRole("button", { name: "Embotellar y generar códigos" });
      await enologist.getByLabel("Botellas llenadas").fill("3.100");
      await enologist.getByLabel("Grado alcohólico final").fill("45");
      await enologist.getByLabel("Adición de agua").fill("750");
      const notice = ruleNotice(preview);
      await expect(notice).toContainText("TRC_BOTTLING_EXCEEDS_VOLUME", { timeout: 20_000 });
      await expect(notice).toContainText("TRC_ALCOHOL_BALANCE_EXCEEDED");
      await expect(submit).toBeDisabled();

      await enologist.getByLabel("Grado alcohólico final").fill("40");
      await enologist.getByLabel("Botellas llenadas").fill("2.950");
      await expect(preview.getByText("Balance válido")).toBeVisible({ timeout: 20_000 });
      await expect(preview.locator('[data-meter="volume"]')).toContainText("2.212,5 L de 2.250 L");
      await expect(preview.locator('[data-meter="loss"]')).toContainText("1,67 %");
      await expect(preview.locator('[data-meter="alcohol"]')).toContainText("885 L embotellados de 900 L");
      const [bottled] = await Promise.all([
        enologist.waitForResponse(
          (r) => /\/api\/v1\/lots\/[\w-]+\/bottling$/.test(r.url()) && r.request().method() === "POST",
        ),
        (async () => {
          await submit.click();
          await enologist.getByRole("alertdialog").getByRole("button", { name: "Sí, embotellar" }).click();
        })(),
      ]);
      expect(bottled.status()).toBe(201);
      await expect(enologist).toHaveURL(/\?pestana=codigos$/, { timeout: 20_000 });
      lotCode = (
        (await enologist
          .getByText(/^[A-Z]{3,5}-\d{4}-SINGANI-\d{3}$/)
          .first()
          .textContent()) ?? ""
      ).trim();
      // El segundo código de lote de la bodega: el primero fue el del embotellado simultáneo.
      expect(lotCode).toMatch(/-SINGANI-002$/);
      await expect(enologist.getByText(`2.950 códigos activos en ${lotCode}`)).toBeVisible({ timeout: 20_000 });
      lap("embotellado");
    });

    await test.step("ERP · exportación CSV de los 2.950 códigos de botella", async () => {
      const table = enologist.getByRole("table", { name: `Códigos de botella de ${lotCode}` });
      await expect(table.getByRole("row")).toHaveCount(21, { timeout: 20_000 });
      const [csvResponse, download] = await Promise.all([
        enologist.waitForResponse((r) => r.url().includes("/bottle-codes/export?")),
        enologist.waitForEvent("download"),
        enologist.getByRole("button", { name: "Descargar CSV" }).click(),
      ]);
      expect(csvResponse.status()).toBe(200);
      expect(csvResponse.headers()["x-export-rows"]).toBe(String(BOTTLES));
      expect(download.suggestedFilename()).toBe(`codigos-${lotCode}-1-${BOTTLES}.csv`);
      const file = await download.path();
      // El CSV lleva BOM (lo abre una hoja de cálculo): se quita antes de leer la cabecera.
      const text = await readFile(file, "utf8");
      const csv = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trimEnd().split(/\r?\n/);
      expect(csv).toHaveLength(BOTTLES + 1);
      expect(csv[0]).toBe("serial,code,codeFormatted,qrUrl,lotCode,lotName,productType,bottlingDate");
      // La botella n.º 1.234, la que se abrirá en el visor.
      const row = (csv.find((line) => line.startsWith(`${SERIAL},`)) ?? "").split(",");
      [bottleCode = "", bottleFormatted = ""] = row.slice(1, 3);
      expect(bottleCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(row[4]).toBe(lotCode);
      expect(new Set(csv.slice(1).map((line) => line.split(",")[1])).size).toBe(BOTTLES);
    });

    await test.step("ERP · un lote ya embotellado no admite un segundo embotellado (TRC_LOT_ALREADY_BOTTLED)", async () => {
      // La interfaz ya no ofrece embotellarlo: se llega por la URL del formulario.
      await enologist.goto(`/lotes/${lotId}/embotellar`);
      await expect(enologist.getByText("Este lote ya está embotellado")).toBeVisible({ timeout: 30_000 });
      await enologist.getByLabel("Botellas llenadas").fill("100");
      await enologist.getByLabel("Grado alcohólico final").fill("40");
      const preview = enologist.getByLabel("Vista previa del servidor");
      await expect(ruleNotice(preview)).toContainText("TRC_LOT_ALREADY_BOTTLED", { timeout: 20_000 });
      await expect(enologist.getByRole("button", { name: "Embotellar y generar códigos" })).toBeDisabled();
    });

    await test.step("ERP · sin laboratorio el expediente no cierra (TRC_DOSSIER_NOT_READY)", async () => {
      await erpNav(enologist, "Lotes");
      await enologist.getByRole("searchbox", { name: "Buscar lote" }).fill("Gran Reserva");
      await enologist.getByRole("link", { name: LOT, exact: true }).click();
      await expect(enologist.getByRole("heading", { name: LOT })).toBeVisible({ timeout: 20_000 });
      await enologist.getByRole("tab", { name: "Expediente" }).click();
      const requirements = enologist.getByRole("list", { name: "Requisitos del expediente" });
      await expect(requirements.locator('[data-requirement="BOTTLED"]')).toHaveAttribute("data-met", "true", {
        timeout: 20_000,
      });
      await expect(requirements.locator('[data-requirement="LAB_CONFORMING"]')).toHaveAttribute("data-met", "false");
      await enologist.getByRole("button", { name: "Cerrar el expediente" }).click();
      await enologist.getByRole("alertdialog").getByRole("button", { name: "Sí, cerrar el expediente" }).click();
      await expect(ruleNotice(enologist)).toContainText("TRC_DOSSIER_NOT_READY", { timeout: 20_000 });
    });

    await test.step("ERP · laboratorio conforme: la conformidad la calcula el servidor (metanol en mg/100 mL a.a., cobre y grado)", async () => {
      await enologist.getByRole("tab", { name: "Laboratorio" }).click();
      await enologist.getByRole("button", { name: "Registrar análisis" }).click();
      const lab = enologist.getByRole("dialog", { name: "Registrar análisis de laboratorio" });
      await lab.getByRole("textbox", { name: "Laboratorio", exact: true }).fill(`Laboratorio E2E ${suffix}`);
      await lab.getByLabel("Código de acreditación").fill("IBMETRO-LE-042");
      await lab.getByLabel("Grado alcohólico real").fill("40,1");
      await lab.getByRole("textbox", { name: "Acidez total", exact: true }).fill("0,3");
      await lab.getByLabel("Acidez volátil").fill("0,1");
      await lab.getByLabel("Metanol (alcohol anhidro)").fill("85");
      await lab.getByLabel("Cobre").fill("2,1");
      await lab.getByLabel("Informe firmado del laboratorio").setInputFiles({
        name: `informe-${runId}.pdf`,
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\n%E2E recorrido H2\n"),
      });
      await expect(lab.getByRole("button", { name: "Quitar" })).toBeVisible({ timeout: 30_000 });
      await lab.getByRole("button", { name: "Guardar análisis" }).click();
      await expect(lab).toBeHidden({ timeout: 20_000 });
      await expect(enologist.getByTestId("lab-conformity")).toContainText("Conforme", { timeout: 20_000 });
      const checks = enologist.getByRole("table", { name: "Comprobaciones de la conformidad" });
      await expect(checks.getByRole("row", { name: /Metanol/ })).toContainText("Cumple");
      await expect(checks.getByRole("row", { name: /Cobre/ })).toContainText("Cumple");
    });

    await test.step("ERP · cierre del expediente con huella; una corrección posterior se rechaza (TRC_DOSSIER_CLOSED)", async () => {
      await enologist.getByRole("tab", { name: "Expediente" }).click();
      await expect(enologist.getByText("5 de 5 requisitos cumplidos")).toBeVisible({ timeout: 20_000 });
      const [closed] = await Promise.all([
        enologist.waitForResponse((r) => r.url().endsWith("/dossier/close")),
        (async () => {
          await enologist.getByRole("button", { name: "Cerrar el expediente" }).click();
          await enologist.getByRole("alertdialog").getByRole("button", { name: "Sí, cerrar el expediente" }).click();
        })(),
      ]);
      expect(closed.status()).toBeLessThan(300);
      await expect(enologist.getByText("Huella (SHA-256)")).toBeVisible({ timeout: 20_000 });
      await expect(enologist.getByText(/Raíz Merkle de los 2\.950 códigos de botella/)).toBeVisible();
      hash = (
        (await enologist
          .getByTitle(/^[0-9a-f]{64}$/)
          .first()
          .textContent()) ?? ""
      ).trim();
      expect(hash).toMatch(/^[0-9a-f]{64}$/);

      await enologist.getByRole("tab", { name: "Correcciones" }).click();
      await enologist.getByRole("button", { name: "Registrar corrección" }).click();
      const correction = enologist.getByRole("dialog", { name: "Registrar corrección" });
      await correction.getByRole("combobox", { name: "Registro que se corrige" }).click();
      await enologist.getByRole("option", { name: new RegExp(`Pesaje · ${escapeRe(harvestCode)}`) }).click();
      await correction.getByLabel("Peso bruto").fill("18.600");
      await correction.getByLabel("Motivo").fill(`${reason}: corrección tras el cierre`);
      await correction.getByRole("button", { name: "Registrar corrección" }).click();
      await expect(ruleNotice(correction)).toContainText("TRC_DOSSIER_CLOSED", { timeout: 20_000 });
      await correction.getByRole("button", { name: "Cancelar" }).click();
      lap("laboratorio y expediente");
    });

    await test.step("ERP · embotellar un lote con la destilación reciente: el reposo sin cumplir lo bloquea (TRC_LOCK_NOT_RELEASED)", async () => {
      await erpNav(enologist, "Envasado y QR");
      await enologist.getByRole("link", { name: "Nuevo embotellado" }).click();
      await expect(enologist.getByRole("heading", { name: "Nuevo embotellado" })).toBeVisible({ timeout: 20_000 });
      await enologist.getByRole("link", { name: `Embotellar ${YOUNG_LOT}` }).click();
      await expect(enologist.getByRole("heading", { name: `Embotellar ${YOUNG_LOT}` })).toBeVisible({
        timeout: 20_000,
      });
      await enologist.getByLabel("Botellas llenadas").fill("30");
      await enologist.getByLabel("Grado alcohólico final").fill("40");
      const preview = enologist.getByLabel("Vista previa del servidor");
      await expect(ruleNotice(preview)).toContainText("TRC_LOCK_NOT_RELEASED", { timeout: 20_000 });
      await expect(enologist.getByRole("button", { name: "Embotellar y generar códigos" })).toBeDisabled();
      lap("recorrido por el ERP");
    });

    // ───────────────────────── Pasaporte en el visor del Marketplace ─────────────────────────

    const visor = await openApp("marketplace");
    const visorErrors = trackErrors(visor);

    await test.step("Marketplace · /b/{lotCode}: el lote del ERP con su bodega, D.O., elaboración, laboratorio conforme y expediente cerrado con la huella", async () => {
      // El pasaporte público, por la API: los mismos datos que se registraron en el ERP.
      const passport = await visitor.get<{ timeline: { actorRole: string | null }[] }>(
        `/v1/public/passports/${lotCode}`,
      );
      expect(passport).toMatchObject({
        kind: "LOT",
        lotCode,
        name: LOT,
        stage: "CERTIFIED",
        winery: { tradeName, active: true },
        denomination: { status: "ELIGIBLE" },
        harvest: { phytosanitary: "APPROVED", maturity: { brixDegrees: 23.4, ph: 3.4, acidityGl: 5.9 } },
        distillation: { heartAbvPercent: 60, restMinDays: 180 },
        bottling: { bottles: BOTTLES, formatCl: 75, finalAbv: 40 },
        lab: { status: "CONFORMING" },
        dossier: { status: "CLOSED", hash },
      });
      expect([...new Set(passport.timeline.map((e) => e.actorRole))]).toEqual(
        expect.arrayContaining(["OPERATOR", "AGRONOMIST", "ENOLOGIST"]),
      );

      await visor.goto(`/b/${lotCode}`);
      await expect(visor.getByRole("heading", { level: 1, name: LOT })).toBeVisible({ timeout: 30_000 });
      await expect(visor.getByRole("link", { name: `Ver la página de ${tradeName}` })).toHaveText(tradeName);
      await expect(visor.getByText("Esta etiqueta identifica el lote")).toBeVisible();
      const dossier = section(visor, "Expediente del lote");
      await expect(dossier.getByText(/^Expediente cerrado el \d{1,2} \S+ \d{4}$/)).toBeVisible();
      await expect(dossier.getByTitle(hash)).toHaveText(`${hash.slice(0, 8)}…${hash.slice(-8)}`);
      const origin = section(visor, "Origen");
      await expect(origin.getByText(PARCEL, { exact: true })).toBeVisible();
      await expect(origin.getByText("Cumple la Denominación de Origen", { exact: true })).toBeVisible();
      const making = section(visor, "Elaboración");
      const stage = (name: string) =>
        making.getByRole("listitem").filter({ has: visor.getByRole("heading", { name, exact: true }) });
      await expect(stage("Vendimia")).toContainText("23,4 °Brix · pH 3,4 · acidez 5,9 g/L");
      // Lo que el recorrido no registró se dice, no se inventa: ningún tratamiento enológico.
      await expect(stage("Fermentación")).toContainText("Ninguno registrado");
      await expect(stage("Destilación y reposo")).toContainText("60 % vol");
      await expect(stage("Embotellado")).toContainText("2.950");
      const journey = section(visor, "Registro del lote");
      for (const role of ["Operación de bodega", "Agronomía", "Enología"]) await expect(journey).toContainText(role);
      await expect(section(visor, "Laboratorio").getByText("Conforme", { exact: true })).toBeVisible();
      await expect(visor.getByRole("main")).not.toContainText("@");
    });

    await test.step("Marketplace · /b/{código} de la botella n.º 1.234 del CSV: pertenece al expediente cerrado", async () => {
      await visor.goto(`/b/${bottleCode}`);
      await expect(visor.getByRole("heading", { level: 1, name: LOT })).toBeVisible({ timeout: 30_000 });
      await expect(visor.getByText("Botella n.º 1.234 de 2.950", { exact: true })).toBeVisible();
      await expect(visor.getByRole("main").getByText(bottleFormatted, { exact: true })).toBeVisible();
      await expect(visor.getByText("Este código pertenece al expediente cerrado")).toBeVisible({ timeout: 20_000 });
      await expect(visor.getByText("No pudimos confirmar este código")).toHaveCount(0);
    });

    await test.step('Marketplace · "No registrado" donde falta el dato: el lote de la bodega vecina, sin análisis de madurez ni laboratorio y con el expediente abierto', async () => {
      await visor.goto(`/b/${neighbourLotCode}`);
      await expect(visor.getByRole("heading", { level: 1, name: NEIGHBOUR_LOT })).toBeVisible({ timeout: 30_000 });
      await expect(visor.getByRole("link", { name: `Ver la página de ${neighbourName}` })).toBeVisible();
      const vendimia = section(visor, "Elaboración")
        .getByRole("listitem")
        .filter({ has: visor.getByRole("heading", { name: "Vendimia", exact: true }) });
      await expect(vendimia).toContainText("Aprobado");
      await expect(vendimia).toContainText("No registrado");
      const lab = section(visor, "Laboratorio");
      await expect(lab.getByText("No registrado", { exact: true })).toBeVisible();
      await expect(lab).toContainText("La bodega no registró un análisis de laboratorio de este lote.");
      await expect(section(visor, "Expediente del lote")).toContainText("Expediente abierto");
      lap("pasaporte en el visor");
    });

    expect(enologistErrors, "errores en el ERP de la enóloga").toEqual([]);
    expect(operatorErrors, "errores en el ERP del operario").toEqual([]);
    expect(agronomistErrors, "errores en el ERP del agrónomo").toEqual([]);
    expect(visorErrors, "errores en el visor").toEqual([]);
  });
});

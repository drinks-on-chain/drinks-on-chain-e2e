import type { Page } from "@playwright/test";
import { DEMO_PASSWORD, DEMO_TOTP_SECRET } from "../src/config";
import { expect, needsDemoPassword, test } from "../src/fixtures/test";
import { PLATFORM, WINERY } from "../src/fixtures/users";
import { ApiClient, missingRoutes, type ApiResult, type Page as ListPage } from "../src/lib/api";
import { deactivateRunAccounts, retireRunWineries } from "../src/lib/cleanup";
import { MAILBOX_HELP } from "../src/lib/mailbox";
import { backofficeLogin, erpLogin, erpNav, settled, trackErrors } from "../src/lib/page";
import { pollUntil } from "../src/lib/poll";
import { runEmail, runName, runPassword, runWineryName } from "../src/lib/run-id";
import { bottleSinganiLot, certifyLot, createParcel, createRunWinery, inviteTeam } from "../src/lib/run-winery";
import { ChainReader, checkExplorerUrl, hashHexToBase64, STELLAR_RPC_URL } from "../src/lib/stellar";
import {
  CHAIN_WAIT_MS,
  chainProblem,
  H3_ROUTES,
  mintProblems,
  mintTransaction,
  platformCollection,
  TINY_PNG,
  waitForAnchor,
  waitForChainIdentity,
  waitForMinted,
  waitForReconciliation,
  type Collection,
  type PublicChainRegistry,
  type TokenizationRequest,
  type WineryChainAccountView,
} from "../src/lib/tokenization";

// H3 · Tokenización en testnet (PLAN-MAESTRO, hito H3; contrato plan/contratos/o3-tokenizacion.md
// §14 con las «Precisiones de la apertura»; manda el OpenAPI del backend):
//
//   la plataforma da de alta la bodega de la ejecución → al activarse, su identidad en la red
//   (cuenta y contrato NFT en testnet) pasa a ACTIVE: se ve en el ERP («Cuenta de la bodega»), en
//   el Backoffice (pestaña «Cadena»), en el registro público y en `stellar.toml`, y se lee del
//   contrato por RPC → la dueña crea un lote singani (estimación 3.000) y autoriza 100 botellas
//   con nombre, descripción y una foto (antes, 3.100: rechazado) → operaciones toma la solicitud
//   en el Backoffice y pide cambios → la dueña añade la nota de cata y reenvía → operaciones
//   aprueba sin precio → la emisión se confirma: 100 NFT, leídos de la red por RPC (`total_minted`
//   y `balance` de la cuenta de la bodega) y con su transacción en el explorador → publicar,
//   pausar y reanudar → la dueña amplía a 150: segunda emisión con botellas 101–150 e ids
//   continuos → el lote se registra por la API hasta el embotellado y se cierra el expediente:
//   anclaje confirmado (memo = huella, leído de la red) y lote ANCHORED → el visor del Marketplace
//   abre `/b/{lotCode}`: anclado, huella recalculada en el navegador y las cuatro comprobaciones
//   en verde → conciliación completa desde el Backoffice: sin diferencias.
//
// Y las negativas que no rompen nada: cuota mayor que la estimación (interfaz), enóloga sin botón
// (interfaz y 403), segunda solicitud abierta, soporte no toma ni aprueba (403), publicar antes de
// confirmar la emisión, bajar la estimación por debajo de lo emitido, solicitud de otra bodega (404).
//
// **No usa Cinti Viejo ni nada de la semilla**: la bodega (con su cuenta y su contrato en
// testnet), sus personas y el lote son de la ejecución. Al terminar se bloquean las cuentas y se
// revoca la bodega (afterAll), lo que pausa su contrato en la red: es lo esperado.
//
// La lectura de la red es independiente del backend y sin claves: simulación por el RPC de testnet
// (`E2E_STELLAR_RPC_URL`) con las direcciones públicas que devuelve la API.
//
// Requiere la Ola 3 del backend desplegada (O3-BE) y el ERP construido con la tokenización
// (`E2E_ERP_TOKENIZATION=1` → `NEXT_PUBLIC_ERP_TOKENIZATION=1`): si el OpenAPI no declara las
// rutas, se marca fixme.
//
// Inicios de sesión: administración y soporte por la API (TOTP), operaciones en el Backoffice
// (TOTP), la dueña y la enóloga en el ERP, y el dueño de Altos de Calamuchita por la API (solo
// para una lectura que debe dar 404). `paceLogin` los reparte bajo el límite por IP.

const REGION = "Valle de Cinti";
const PARCEL = "Parcela Alta";
const LAB_NAME = "Laboratorio E2E ISO 17025";
const ESTIMATE = 3000;
const QUOTA = 100;
const INCREASE = 50;
const TOTAL = QUOTA + INCREASE;
const BOTTLES = 2950;
const CHANGES_MESSAGE = "Falta la nota de cata para la ficha de la colección.";
const TASTING_NOTES = "Nariz floral de moscatel; boca limpia y sedosa, de final largo.";

/** Contraseña de las personas que crea la ejecución (≥ 10 caracteres, no común). */
const NEW_PASSWORD = runPassword();

/** Códigos de un error de la API: el general y los de sus detalles (reglas `TOK_…`). */
const errorCodes = (result: ApiResult<unknown>) =>
  [result.error?.code, ...(result.error?.details ?? []).map((d) => d.code)].filter((c): c is string => !!c);

const requestPanel = (page: Page) => page.getByRole("group", { name: "Solicitud de tokenización" });
const collectionPanel = (page: Page) => page.getByRole("group", { name: "Colección y emisión" });
const lotState = (page: Page) => page.getByRole("group", { name: "Tokenización del lote" });
const anchorRegion = (page: Page) => page.getByRole("region", { name: "Anclaje en la red" });
const dataOf = async <T>(response: { json(): Promise<unknown> }) => ((await response.json()) as { data: T }).data;

/**
 * Resultado de intentar publicar una colección con la emisión aún sin confirmar: `false` si el
 * servidor lo rechazó con `TOK_MINT_NOT_CONFIRMED` (lo esperado) y `true` si llegó a publicarse
 * porque la red confirmó la emisión justo antes. Cualquier otra respuesta es un error.
 */
function publishedBeforeMintConfirmed(result: ApiResult<unknown>): boolean {
  if (result.ok) return true;
  const codes = errorCodes(result);
  if (result.status === 409 && codes.includes("TOK_MINT_NOT_CONFIRMED")) return false;
  throw new Error(
    `Publicar antes de confirmar la emisión: se esperaba 409 TOK_MINT_NOT_CONFIRMED y llegó ${result.status} ${codes.join(", ")}`,
  );
}

/** Operaciones publica la colección desde su ficha del Backoffice (confirmación incluida). */
async function publishFromBackoffice(ops: Page, available: number) {
  await ops.getByRole("button", { name: "Publicar", exact: true }).click();
  const publish = ops.getByRole("alertdialog", { name: "Publicar la colección" });
  await expect(publish).toContainText(`${available} NFT disponibles`);
  await publish.getByRole("button", { name: "Publicar" }).click();
  await expect(ops.getByText("Colección publicada.").first()).toBeVisible();
}

test.describe("H3 · tokenización en testnet: de la autorización al anclaje verificado", () => {
  let missing: string[] = [];
  let openApiError: string | null = null;
  /** Por qué el entorno aún no puede emitir ni anclar (cadena sin configurar), o `null`. */
  let chainNotReady: string | null = null;
  /** El recorrido llegó a crear datos (desde el alta de la bodega): hay que limpiar al terminar. */
  let started = false;
  /** Bodega de la ejecución, para comprobar al final que la revocación pausa su contrato. */
  let createdWineryId: string | null = null;

  test.beforeAll(async ({ runId }) => {
    try {
      missing = await missingRoutes(H3_ROUTES);
    } catch (error) {
      openApiError = error instanceof Error ? error.message : String(error);
    }
    if (openApiError !== null || missing.length > 0) return;
    // Con las rutas desplegadas, la cadena puede seguir sin configurar en el entorno: sin cuentas
    // de plataforma ni código del contrato no hay identidad, emisión ni anclaje que recorrer.
    const visitor = await ApiClient.create(`${runId} registro`);
    try {
      chainNotReady = await chainProblem(visitor);
    } finally {
      await visitor.dispose();
    }
  });

  // Al terminar (también si la prueba falla): las cuentas quedan bloqueadas y la bodega, revocada
  // (fuera de la lista pública, con su lote y su colección dentro). Revocarla pausa su contrato en
  // la red (contrato §3.5): se anota si llegó a verse, sin fallar por ello.
  test.afterAll(async ({ runId }) => {
    // Sin bodega creada no hay nada que limpiar (recorrido saltado o marcado fixme).
    if (!started || !DEMO_PASSWORD || !DEMO_TOTP_SECRET) return;
    const admin = await ApiClient.create(`${runId} limpieza`);
    try {
      await admin.login(PLATFORM.admin.email, DEMO_PASSWORD, DEMO_TOTP_SECRET);
      const reason = `Fin del recorrido E2E ${runId}`;
      const accounts = await deactivateRunAccounts(admin, runId, reason);
      const wineries = await retireRunWineries(admin, runId, reason);
      console.log(
        `Limpieza ${runId}: ${accounts.blocked.length} cuenta(s) bloqueadas, ${wineries.revoked.length} bodega(s) revocadas`,
      );
      if (createdWineryId) {
        const path = `/v1/platform/wineries/${createdWineryId}/chain-account`;
        const paused = await pollUntil(
          () => admin.get<WineryChainAccountView>(path),
          (view) => view.identity.status === "PAUSED" || view.identity.contract?.paused === true,
          { what: "contrato de la bodega revocada pausado en la red", timeoutMs: 90_000, intervalMs: 5_000 },
        ).then(
          () => "pausado en la red",
          (error: unknown) => `sin confirmar todavía (${error instanceof Error ? error.message : String(error)})`,
        );
        console.log(`Contrato de la bodega revocada: ${paused}`);
      }
      expect(accounts.remaining, "cuentas de la ejecución que siguen activas").toEqual([]);
      expect(wineries.stillPublic, "bodegas de la ejecución que siguen en la lista pública").toEqual([]);
    } finally {
      await admin.logout();
      await admin.dispose();
    }
  });

  test("bodega de la ejecución con identidad en testnet → 100 botellas autorizadas, revisadas y emitidas → publicar, pausar, reanudar y ampliar a 150 → expediente anclado y verificado en el visor → conciliación sin diferencias", async ({
    page,
    openApp,
    api,
    mailbox,
    runId,
  }) => {
    test.fixme(openApiError !== null, `No se pudo leer el OpenAPI del backend: ${openApiError ?? ""}`);
    test.fixme(
      missing.length > 0,
      `requiere O3-BE desplegado: el OpenAPI de desarrollo aún no declara ${missing.join(", ")}`,
    );
    test.fixme(chainNotReady !== null, `requiere la cadena configurada en el entorno (O3-OPS): ${chainNotReady ?? ""}`);
    needsDemoPassword();
    test.skip(!mailbox, MAILBOX_HELP);
    test.skip(!DEMO_TOTP_SECRET, "Falta E2E_TOTP_SECRET (secreto TOTP del personal de plataforma de la semilla).");
    if (!mailbox) return;
    test.setTimeout(30 * 60_000);
    const startedAt = Date.now();
    const lap = (what: string) => {
      test
        .info()
        .annotations.push({ type: "tiempo", description: `${what}: ${Math.round((Date.now() - startedAt) / 1000)} s` });
    };
    const note = (type: string, description: string) => {
      test.info().annotations.push({ type, description });
    };

    // Bodega, personas y lote de la ejecución (alias propios; variante 4 del nombre: no comparte
    // iniciales con las bodegas de H1 y H2 de la misma ejecución).
    const tradeName = runWineryName(runId, "Destilería", 4);
    const people = {
      owner: { email: runEmail(runId, "tokenizacion-duena"), name: `Dueña de la tokenización ${runId}` },
      enologist: { email: runEmail(runId, "tokenizacion-enologa"), name: `Enóloga de la tokenización ${runId}` },
    };
    const LOT = runName(runId, "Singani Preventa 2026");
    const DESCRIPTION = `Singani de altura del ${REGION}, de producción limitada, en preventa. Recorrido ${runId}.`;
    const suffix = runId.split("-").at(-1) ?? runId;
    const reason = `Recorrido E2E ${runId}`;

    // Sesiones de API. El recorrido dura minutos: renuevan su acceso solas si caduca.
    const ownerApi = await api.anonymous(people.owner.email);
    const enologistApi = await api.anonymous(people.enologist.email);
    const visitor = await api.anonymous(`${runId} visitante`);
    const admin = await api.as(PLATFORM.admin.email, { totpSecret: DEMO_TOTP_SECRET });
    for (const client of [ownerApi, enologistApi, admin]) client.autoRefresh = true;

    let wineryId = "";
    let lotPrefix = "";
    let parcelId = "";
    let account = "";
    let contract = "";
    let anchorAccount = "";
    let chain = new ChainReader("");
    let lotId = "";
    let lotReference = "";
    let requestId = "";
    let collectionId = "";
    let publishedEarly = false;
    let firstTokenId = 0;
    let lotCode = "";
    let hash = "";
    let anchorExplorerUrl = "";

    /** El explorador (un tercero) responde a la página que enlaza el backend. */
    const explorerResponds = async (what: string, url: string) => {
      const check = await checkExplorerUrl(url);
      note("explorador", `${what}: HTTP ${check.status}${check.ok ? "" : " (protegido de robots)"}`);
      expect(check.reachable, `${what}: el explorador responde a ${url} (HTTP ${check.status})`).toBe(true);
    };

    /** `total_minted` y `balance` de la bodega leídos de la red (el RPC puede ir un ledger por detrás). */
    const onChainSupply = (minted: number) =>
      pollUntil(
        async () => ({
          totalMinted: await chain.totalMinted(contract, account),
          balance: await chain.balance(contract, account),
        }),
        (supply) => supply.totalMinted === minted && supply.balance === minted,
        {
          what: `total_minted = ${minted} y balance de la bodega = ${minted} leídos por RPC`,
          timeoutMs: 60_000,
          intervalMs: 3_000,
          describe: (supply) => `total_minted ${supply.totalMinted}, balance ${supply.balance}`,
        },
      );

    // ───────────────────────── Preparación por la API ─────────────────────────

    await test.step("la plataforma da de alta la bodega de la ejecución; su dueña acepta, invita a la enóloga y registra una parcela apta", async () => {
      started = true;
      wineryId = await createRunWinery(admin, mailbox, {
        runId,
        tradeName,
        taxSalt: "tokenizacion",
        region: REGION,
        owner: people.owner,
        ownerClient: ownerApi,
        password: NEW_PASSWORD,
      });
      createdWineryId = wineryId;
      await inviteTeam(ownerApi, mailbox, [[enologistApi, people.enologist, "ENOLOGIST"]], NEW_PASSWORD);
      const parcel = await createParcel(ownerApi, { parcelName: PARCEL, altitudeMasl: 2350 });
      parcelId = parcel.id;
      expect(parcel.isDoEligible, "aptitud D.O. calculada de la parcela").toBe(true);

      const list = await admin.get<ListPage<{ id: string; status: string; lotPrefix: string | null }>>(
        "/v1/platform/wineries",
        { q: runId, limit: 20 },
      );
      const winery = list.items.find((w) => w.id === wineryId);
      expect(winery?.status, "estado de la bodega tras aceptar su dueña").toBe("ACTIVE");
      lotPrefix = winery?.lotPrefix ?? "";
      expect(lotPrefix, "prefijo de lote de la bodega").toMatch(/^[A-Z]{3,5}$/);
      note("bodega", `${tradeName} (${lotPrefix}; se revoca al terminar y su contrato queda pausado en la red)`);
      lap("bodega, equipo y parcela");
    });

    // ───────────────────────── a · Identidad en la red ─────────────────────────

    await test.step("a · la identidad de la bodega en la red pasa a ACTIVE: cuenta y contrato en testnet, en el registro público y en stellar.toml, y leídos del contrato por RPC", async () => {
      const view = await waitForChainIdentity(ownerApi, "/v1/organizations/current/chain-account");
      const identity = view.identity;
      account = identity.account?.address ?? "";
      contract = identity.contract?.address ?? "";
      expect(identity).toMatchObject({
        wineryId,
        network: "TESTNET",
        status: "ACTIVE",
        contract: { symbol: lotPrefix, paused: false },
      });
      expect(account, "cuenta de la bodega").toMatch(/^G[A-Z2-7]{55}$/);
      expect(contract, "contrato NFT de la bodega").toMatch(/^C[A-Z2-7]{55}$/);
      expect(view.totals.minted, "NFT emitidos antes de autorizar nada").toBe(0);
      lap("identidad ACTIVE");

      // La plataforma ve la misma identidad.
      const platformView = await admin.get<WineryChainAccountView>(`/v1/platform/wineries/${wineryId}/chain-account`);
      expect(platformView.identity).toMatchObject({
        status: "ACTIVE",
        account: { address: account },
        contract: { address: contract },
      });

      // Registro público (fuente canónica de los contratos oficiales).
      const registry = await pollUntil(
        () => visitor.get<PublicChainRegistry>("/v1/public/chain/registry"),
        (r) => r.wineries.some((w) => w.contract === contract),
        {
          what: "contrato de la bodega en GET /v1/public/chain/registry",
          timeoutMs: 120_000,
          intervalMs: 5_000,
          describe: (r) => `${r.wineries.length} bodegas`,
        },
      );
      expect(registry.network).toBe("TESTNET");
      expect(registry.wineries.find((w) => w.contract === contract)).toMatchObject({
        tradeName,
        symbol: lotPrefix,
        account,
        paused: false,
      });
      anchorAccount = registry.platform.anchorAccount ?? "";
      expect(anchorAccount, "cuenta de anclaje oficial").toMatch(/^G[A-Z2-7]{55}$/);
      expect(registry.platform.operationsAccount, "cuenta de operaciones").toMatch(/^G[A-Z2-7]{55}$/);
      expect(identity.contract?.operatorAddress, "operador del contrato").toBe(registry.platform.operationsAccount);

      // stellar.toml (SEP-1): texto plano, abierto a cualquier origen, con la cuenta de la bodega.
      // Se sirve con caché de 5 minutos: se espera a que la incluya.
      const toml = await pollUntil(
        () => visitor.bytes("/.well-known/stellar.toml"),
        (file) => file.status === 200 && file.body.toString("utf8").includes(account),
        {
          what: "cuenta de la bodega en /.well-known/stellar.toml",
          timeoutMs: 6 * 60_000,
          intervalMs: 10_000,
          describe: (file) => `HTTP ${file.status}, ${file.body.length} bytes`,
        },
      );
      const tomlText = toml.body.toString("utf8");
      expect(toml.headers["content-type"]).toContain("text/plain");
      expect(toml.headers["access-control-allow-origin"]).toBe("*");
      expect(tomlText).toContain("NETWORK_PASSPHRASE");
      expect(tomlText).toContain(registry.networkPassphrase);
      expect(tomlText).toContain(anchorAccount);
      expect(tomlText).toMatch(/ORG_NAME\s*=\s*"Drinks on Chain"/);
      lap("registro y stellar.toml");

      // Lectura independiente de la red: el contrato existe, es de esta bodega y no ha emitido.
      chain = new ChainReader(registry.networkPassphrase);
      note("rpc", new URL(STELLAR_RPC_URL).host);
      expect(await chain.symbol(contract, account), "symbol() del contrato en la red").toBe(lotPrefix);
      expect(await chain.paused(contract, account), "paused() del contrato en la red").toBe(false);
      expect(await onChainSupply(0)).toEqual({ totalMinted: 0, balance: 0 });
      await explorerResponds("contrato de la bodega", identity.contract?.explorerUrl ?? "");
    });

    // La dueña, en la página de la prueba (ERP); operaciones, en el Backoffice; la enóloga, en
    // otro navegador del ERP.
    const owner = page;
    // La cuota mayor que la estimación la rechaza el servidor (422): es parte del recorrido.
    const ownerErrors = trackErrors(owner, [/^422 \/api\/v1\/lots\/[\w-]+\/tokenization-requests$/]);
    const ops = await openApp("backoffice");
    const opsErrors = trackErrors(ops);

    await test.step("a · la identidad se ve en el ERP («Cuenta de la bodega») y en el Backoffice (pestaña «Cadena»), con los enlaces al explorador que da el backend", async () => {
      const identity = (await ownerApi.get<WineryChainAccountView>("/v1/organizations/current/chain-account")).identity;

      await erpLogin(owner, people.owner.email, NEW_PASSWORD, `Dirección · ${tradeName}`);
      await erpNav(owner, "Cuenta de la bodega");
      await expect(owner.getByRole("heading", { level: 1, name: "Cuenta de la bodega" })).toBeVisible();
      const card = owner.getByRole("group", { name: "Identidad en la red" });
      await expect(card).toHaveAttribute("data-identity", "ACTIVE", { timeout: 30_000 });
      await expect(card).toContainText("Activa");
      await expect(card).toContainText("Red de pruebas de Stellar (testnet)");
      await expect(card).toContainText(account);
      await expect(card).toContainText(lotPrefix);
      await expect(card.getByRole("link", { name: /Ver la cuenta en el explorador/ })).toHaveAttribute(
        "href",
        identity.account?.explorerUrl ?? "",
      );
      await expect(card.getByRole("link", { name: /Ver el contrato en el explorador/ })).toHaveAttribute(
        "href",
        identity.contract?.explorerUrl ?? "",
      );

      await backofficeLogin(ops, PLATFORM.operations.email, DEMO_PASSWORD, DEMO_TOTP_SECRET);
      await ops.goto(`/bodegas/${wineryId}?pestana=cadena`);
      await expect(ops.getByRole("heading", { name: tradeName, level: 1 })).toBeVisible();
      const panel = ops.getByRole("tabpanel", { name: "Cadena" });
      await expect(panel.getByRole("heading", { name: /Identidad en la red/, level: 2 })).toContainText("Activa", {
        timeout: 30_000,
      });
      await expect(panel.getByText(lotPrefix, { exact: true }).first()).toBeVisible();
      await expect(panel.getByRole("link", { name: /Ver la cuenta en el explorador/ })).toHaveAttribute(
        "href",
        identity.account?.explorerUrl ?? "",
      );
      await expect(panel.getByRole("link", { name: /Ver el contrato en el explorador/ })).toHaveAttribute(
        "href",
        identity.contract?.explorerUrl ?? "",
      );
      lap("identidad en el ERP y el Backoffice");
    });

    // ───────────────────────── b · Lote y autorización ─────────────────────────

    await test.step("b · ERP · la dueña crea el lote singani con estimación 3.000: tokenizable, máximo 3.000", async () => {
      await erpNav(owner, "Lotes");
      await owner.getByRole("link", { name: "Nuevo lote" }).click();
      await expect(owner.getByRole("heading", { name: "Nuevo lote" })).toBeVisible();
      await owner.getByLabel("Nombre del lote").fill(LOT);
      await owner.getByRole("combobox", { name: "Tipo de producto" }).click();
      await owner.getByRole("option", { name: "Singani" }).click();
      await owner.getByLabel("Botellas estimadas").fill("3.000");
      await owner.getByLabel("Formato previsto").fill("75");
      await owner.getByLabel("Grado previsto de la botella").fill("40");
      const [created] = await Promise.all([
        owner.waitForResponse((r) => r.url().endsWith("/api/v1/lots") && r.request().method() === "POST"),
        owner.getByRole("button", { name: "Crear lote" }).click(),
      ]);
      expect(created.status()).toBe(201);
      const lot = await dataOf<{ id: string; reference: string }>(created);
      lotId = lot.id;
      lotReference = lot.reference;
      expect(lotReference, "referencia estable del lote").toMatch(new RegExp(`^${lotPrefix}-L\\d{4}-\\d{3}$`));
      await expect(owner.getByRole("heading", { level: 1, name: LOT })).toBeVisible({ timeout: 20_000 });

      const status = await ownerApi.get<{
        tokenizable: boolean;
        limits: { basis: string; maxQuantity: number; authorizedQuota: number };
        approvalRequired: boolean;
        chainIdentity: { status: string };
      }>(`/v1/lots/${lotId}/tokenization`);
      expect(status).toMatchObject({
        tokenizable: true,
        limits: { basis: "ESTIMATE", maxQuantity: ESTIMATE, authorizedQuota: 0 },
        approvalRequired: true,
        chainIdentity: { status: "ACTIVE" },
      });

      const tab = owner.getByRole("tab", { name: "Tokenización" });
      await expect(
        tab,
        "pestaña «Tokenización» del lote: el ERP debe construirse con E2E_ERP_TOKENIZATION=1 (NEXT_PUBLIC_ERP_TOKENIZATION=1)",
      ).toBeVisible();
      await tab.click();
      await expect(lotState(owner).getByTestId("limits-summary")).toContainText("hasta 3.000 botellas");
      lap("lote creado");
    });

    await test.step("b · ERP · una cuota de 3.100 supera la estimación (TOK_QUOTA_EXCEEDS_ESTIMATE); después, 100 botellas con nombre, descripción y una foto", async () => {
      await lotState(owner).getByRole("link", { name: "Autorizar tokenización" }).click();
      await expect(owner.getByRole("heading", { level: 1, name: `Autorizar la tokenización de ${LOT}` })).toBeVisible();
      await expect(owner.getByTestId("limits-summary")).toContainText("hasta 3.000 botellas");
      await owner.getByLabel("Botellas a tokenizar").fill("3.100");
      await owner.getByLabel("Nombre de la colección").fill(LOT);
      await owner.locator('textarea[name="description"]').fill(DESCRIPTION);
      await owner.getByRole("button", { name: "Autorizar tokenización" }).click();
      await owner.getByRole("alertdialog").getByRole("button", { name: "Sí, autorizar 3.100 botellas" }).click();
      const notice = owner.getByTestId("rule-violation-notice");
      await expect(notice).toContainText("TOK_QUOTA_EXCEEDS_ESTIMATE", { timeout: 20_000 });
      await expect(notice).toContainText("3.000");

      await owner.getByLabel("Botellas a tokenizar").fill(String(QUOTA));
      await owner
        .getByLabel("Fotos de la colección")
        .setInputFiles({ name: `botella-${suffix}.png`, mimeType: "image/png", buffer: TINY_PNG });
      await expect(owner.getByRole("list", { name: "Fotos subidas" })).toContainText("Portada", { timeout: 30_000 });
      await owner.getByLabel("Descripción de la foto 1").fill("Botella de singani sobre una mesa de madera");
      await owner.getByLabel("Notas para Drinks on Chain").fill(`Primera preventa de este lote · ${runId}`);
      await owner.getByRole("button", { name: "Autorizar tokenización" }).click();
      const confirm = owner.getByRole("alertdialog", { name: `¿Autorizar la tokenización de ${LOT}?` });
      await expect(confirm).toContainText("Se emitirán 100 NFT a nombre de tu bodega en la red Stellar");
      const [sent] = await Promise.all([
        owner.waitForResponse(
          (r) => /\/api\/v1\/lots\/[\w-]+\/tokenization-requests$/.test(r.url()) && r.status() !== 422,
        ),
        confirm.getByRole("button", { name: "Sí, autorizar 100 botellas" }).click(),
      ]);
      expect(sent.status()).toBe(201);
      const request = await dataOf<TokenizationRequest>(sent);
      requestId = request.id;
      expect(request).toMatchObject({ kind: "INITIAL", status: "SUBMITTED", quantity: QUOTA, resultingQuota: QUOTA });

      await expect(owner).toHaveURL(/pestana=tokenizacion$/, { timeout: 20_000 });
      await expect(requestPanel(owner)).toHaveAttribute("data-status", "SUBMITTED");
      await expect(requestPanel(owner)).toContainText("Autorización · 100 botellas");
      // Con una solicitud abierta no se ofrece otra.
      await expect(owner.getByRole("link", { name: "Autorizar tokenización" })).toHaveCount(0);
      lap("solicitud enviada");
    });

    await test.step("negativas · segunda solicitud abierta (409), la enóloga no autoriza (sin botón y 403) y la solicitud no existe para otra bodega (404)", async () => {
      const again = await ownerApi.raw("POST", `/v1/lots/${lotId}/tokenization-requests`, {
        body: { quantity: 10, confirm: true },
        idempotencyKey: true,
      });
      expect({ status: again.status, codes: errorCodes(again) }).toEqual({
        status: 409,
        codes: ["TOK_REQUEST_ALREADY_OPEN"],
      });

      // La enóloga consulta la tokenización, pero no la autoriza: ni botón, ni formulario, ni API.
      const enologist = await openApp("erp");
      const enologistErrors = trackErrors(enologist);
      await erpLogin(enologist, people.enologist.email, NEW_PASSWORD, `Enología · ${tradeName}`);
      await enologist.goto(`/lotes/${lotId}?pestana=tokenizacion`);
      await expect(lotState(enologist)).toContainText("Solo la dirección de la bodega autoriza la tokenización", {
        timeout: 30_000,
      });
      await expect(requestPanel(enologist)).toHaveAttribute("data-status", "SUBMITTED");
      await expect(enologist.getByRole("link", { name: /Autorizar tokenización|Ampliar cuota/ })).toHaveCount(0);
      await expect(requestPanel(enologist).getByRole("button", { name: "Retirar solicitud" })).toHaveCount(0);
      await enologist.goto(`/lotes/${lotId}/tokenizar`);
      await expect(
        enologist.getByRole("heading", { name: "Solo la dirección de la bodega autoriza la tokenización" }),
      ).toBeVisible({ timeout: 30_000 });
      expect(enologistErrors, "errores en el ERP de la enóloga").toEqual([]);
      const forbidden = await enologistApi.raw("POST", `/v1/lots/${lotId}/tokenization-requests`, {
        body: { quantity: 10, confirm: true },
        idempotencyKey: true,
      });
      expect(forbidden.status, `la enóloga autoriza por la API (${errorCodes(forbidden).join(", ")})`).toBe(403);
      expect((await enologistApi.raw("GET", `/v1/tokenization-requests/${requestId}`)).status).toBe(200);

      // Una persona de otra bodega (el dueño de Altos, de la semilla: solo lee) no la encuentra.
      const stranger = await api.as(WINERY.altosOwner.email);
      const foreign = await stranger.raw("GET", `/v1/tokenization-requests/${requestId}`);
      expect(foreign.status, `solicitud vista desde otra bodega (${errorCodes(foreign).join(", ")})`).toBe(404);
      expect((await stranger.raw("GET", `/v1/lots/${lotId}/tokenization`)).status).toBe(404);

      // Nada de esto cambió la solicitud.
      expect(await ownerApi.get<TokenizationRequest>(`/v1/tokenization-requests/${requestId}`)).toMatchObject({
        status: "SUBMITTED",
        quantity: QUOTA,
      });
    });

    // ───────────────────────── c · Revisión de operaciones ─────────────────────────

    await test.step("c · Backoffice · operaciones toma la solicitud y pide cambios (la nota de cata)", async () => {
      await ops.goto(`/tokenizacion/${requestId}`);
      await expect(ops.getByRole("heading", { name: LOT, level: 1 })).toBeVisible({ timeout: 30_000 });
      await settled(ops);
      await ops.getByRole("button", { name: "Tomar la solicitud" }).click();
      await expect(ops.getByText("Solicitud tomada: ahora está en revisión y asignada a ti.").first()).toBeVisible();
      await expect(ops.getByRole("heading", { name: "Revisión del lote" })).toBeVisible();
      await expect(ops.getByRole("heading", { name: "Identidad en la red" })).toBeVisible();

      await ops.getByRole("button", { name: "Pedir cambios" }).click();
      const changes = ops.getByRole("dialog", { name: "Pedir cambios a la bodega" });
      await changes.getByLabel("Mensaje para la bodega").fill(CHANGES_MESSAGE);
      await changes.getByRole("checkbox", { name: "Nota de cata" }).click();
      await changes.getByRole("button", { name: "Pedir cambios" }).click();
      await expect(changes).toHaveCount(0);
      await expect(ops.getByText("Espera a que la bodega la corrija y la reenvíe desde el ERP.")).toBeVisible();
      await expect(ops.getByRole("list", { name: "Cambios pedidos" })).toContainText(CHANGES_MESSAGE);
      // Ya no está en revisión: no hay nada que decidir.
      await expect(ops.getByRole("button", { name: /Aprobar/ })).toHaveCount(0);
      expect((await ownerApi.get<TokenizationRequest>(`/v1/tokenization-requests/${requestId}`)).status).toBe(
        "CHANGES_REQUESTED",
      );
    });

    await test.step("c · ERP · la dueña ve el cambio pedido, añade la nota de cata y reenvía", async () => {
      await owner.getByRole("button", { name: "Actualizar" }).click();
      await expect(requestPanel(owner)).toHaveAttribute("data-status", "CHANGES_REQUESTED", { timeout: 30_000 });
      await expect(requestPanel(owner).getByTestId("change-request")).toContainText(CHANGES_MESSAGE);
      await requestPanel(owner).getByRole("link", { name: "Editar y reenviar" }).click();
      await expect(owner.getByRole("heading", { level: 1, name: `Editar la solicitud de ${LOT}` })).toBeVisible();
      await expect(owner.getByLabel("Botellas a tokenizar")).toHaveValue(String(QUOTA));
      await owner.getByLabel("Notas de cata").fill(TASTING_NOTES);
      await owner.getByLabel("Qué cambiaste").fill("Añadida la nota de cata.");
      await owner.getByRole("button", { name: "Guardar y reenviar" }).click();
      await owner.getByRole("alertdialog").getByRole("button", { name: "Sí, reenviar 100 botellas" }).click();
      await expect(requestPanel(owner)).toHaveAttribute("data-status", "SUBMITTED", { timeout: 30_000 });
      await expect(requestPanel(owner).getByTestId("change-request")).toHaveCount(0);
      lap("cambios pedidos y reenvío");
    });

    await test.step("negativa · soporte lee la solicitud pero no la toma ni la aprueba (403)", async () => {
      const support = await api.as(PLATFORM.support.email, { totpSecret: DEMO_TOTP_SECRET });
      const base = `/v1/platform/tokenization-requests/${requestId}`;
      expect((await support.raw("GET", base)).status, "soporte lee la solicitud").toBe(200);
      expect((await support.raw("POST", `${base}/take`, { body: {} })).status, "soporte toma la solicitud").toBe(403);
      const approve = await support.raw("POST", `${base}/approve`, { body: {}, idempotencyKey: true });
      expect(approve.status, `soporte aprueba (${errorCodes(approve).join(", ")})`).toBe(403);
      expect(await admin.get<TokenizationRequest>(base)).toMatchObject({ status: "SUBMITTED", collectionId: null });
    });

    await test.step("c · Backoffice · operaciones vuelve a tomarla y aprueba sin precio: se crea la colección y la emisión queda en la red; publicar antes de confirmarla se rechaza (TOK_MINT_NOT_CONFIRMED)", async () => {
      await ops.reload();
      await expect(ops.getByRole("heading", { name: LOT, level: 1 })).toBeVisible({ timeout: 30_000 });
      await settled(ops);
      await ops.getByRole("button", { name: "Tomar la solicitud" }).click();
      await expect(ops.getByText("Solicitud tomada: ahora está en revisión y asignada a ti.").first()).toBeVisible();
      await expect(ops.getByRole("list", { name: "Cambios pedidos" })).toContainText("resuelto el");
      // Lo que completó la bodega, a la vista; el precio, vacío (política sin definir, A-32).
      await expect(ops.getByLabel("Precio por botella")).toHaveValue("");

      await ops.getByRole("button", { name: "Aprobar y emitir" }).click();
      const approve = ops.getByRole("dialog", { name: "Aprobar y emitir los NFT" });
      await expect(approve).toBeVisible();
      await expect(approve.getByRole("checkbox", { name: "Publicar al emitir" })).not.toBeChecked();
      const [approved] = await Promise.all([
        ops.waitForResponse((r) => r.url().endsWith(`/tokenization-requests/${requestId}/approve`)),
        approve.getByRole("button", { name: "Aprobar y emitir" }).click(),
      ]);
      expect(approved.status(), "aprobar responde 201 (OpenAPI)").toBe(201);
      const result = await dataOf<{ request: TokenizationRequest; collection: Collection }>(approved);
      collectionId = result.collection.id;
      expect(result.request).toMatchObject({ status: "APPROVED", collectionId });
      expect(result.collection).toMatchObject({ lotId, quota: QUOTA, contract: { address: contract } });
      expect((result.collection as { price?: unknown }).price ?? null, "colección aprobada sin precio").toBeNull();

      // Publicar antes de que la red confirme la emisión: rechazado. Si la red ya la confirmó (la
      // lectura previa no dice MINTING) no se intenta: no se quiere publicar aquí.
      const before = await platformCollection(admin, collectionId);
      if (before.status === "MINTING" && before.mintStatus !== "CONFIRMED") {
        const early = await admin.raw("POST", `/v1/platform/collections/${collectionId}/publish`, {
          body: { reason },
          idempotencyKey: true,
        });
        // Rechazado con TOK_MINT_NOT_CONFIRMED; o publicada, si la emisión se confirmó entre la
        // lectura y el intento (entonces no se pudo probar y el recorrido sigue desde «Publicada»).
        publishedEarly = publishedBeforeMintConfirmed(early);
        note(
          "publicar antes de confirmar",
          publishedEarly
            ? "la red confirmó la emisión antes del intento: no se pudo probar"
            : "409 TOK_MINT_NOT_CONFIRMED",
        );
      } else {
        note("publicar antes de confirmar", `la emisión ya estaba ${before.mintStatus}: no se intentó`);
      }

      await expect(ops.getByText("Solicitud aprobada: emisión en curso")).toBeVisible();
      await ops.getByRole("link", { name: "Seguir la emisión en la colección" }).click();
      await expect(ops).toHaveURL(new RegExp(`/colecciones/${collectionId}\\?pestana=emisiones$`));
      lap("solicitud aprobada");
    });

    // ───────────────────────── d · Emisión confirmada ─────────────────────────

    await test.step("d · la emisión llega a «Confirmada»: 100 NFT (botellas 1–100) en la colección, y en la red por RPC: total_minted = 100 y balance de la bodega = 100", async () => {
      const collection = await waitForMinted(admin, collectionId, QUOTA);
      lap("emisión confirmada");
      expect(mintProblems(collection.mints, [QUOTA]), "emisión inicial").toEqual([]);
      expect(collection).toMatchObject({
        status: publishedEarly ? "PUBLISHED" : "READY",
        quota: QUOTA,
        counts: { minted: QUOTA, available: QUOTA, sold: 0, burned: 0 },
        redeemable: false,
      });
      const mint = collection.mints[0];
      // El argumento `lot` de mint_batch es la referencia estable del lote (S-12).
      expect(mint?.lotArg).toBe(lotReference);
      firstTokenId = mint?.ranges[0]?.firstTokenId ?? -1;
      const lastTokenId = mint?.ranges.at(-1)?.lastTokenId ?? -1;

      const tokens = await admin.get<
        ListPage<{ tokenId: number; bottleNumber: number; status: string; owner: { kind: string; address: string } }>
      >(`/v1/platform/collections/${collectionId}/tokens`, { limit: 1 });
      expect(tokens.total, "NFT de la colección").toBe(QUOTA);
      expect(tokens.items[0]).toMatchObject({
        tokenId: firstTokenId,
        bottleNumber: 1,
        status: "MINTED",
        owner: { kind: "WINERY", address: account },
      });

      // Lectura independiente de la red (simulación, sin claves).
      expect(await onChainSupply(QUOTA)).toEqual({ totalMinted: QUOTA, balance: QUOTA });
      expect(await chain.ownerOf(contract, account, firstTokenId), "owner_of del primer NFT").toBe(account);
      expect(await chain.ownerOf(contract, account, lastTokenId), "owner_of del último NFT").toBe(account);
      const tx = mintTransaction(mint);
      const onChain = await chain.confirmedTransaction(tx.txHash);
      expect(onChain.ledger, "ledger de la emisión según el RPC y según el backend").toBe(tx.ledger);
      expect(tx.explorerUrl, "el enlace del backend lleva a esa transacción").toContain(tx.txHash);
      await explorerResponds("transacción de la emisión", tx.explorerUrl);

      // Backoffice: la pantalla se pone al día sola.
      await expect(
        ops.getByText(publishedEarly ? "Publicada" : "Lista para publicar", { exact: true }).first(),
      ).toBeVisible({ timeout: 40_000 });
      await expect(ops.getByText(/Botellas 1–100 · ids \d+–\d+/)).toBeVisible();
      const mintTxs = ops.getByRole("list", { name: "Transacciones de la emisión 1" });
      await expect(mintTxs).toContainText("Confirmada");
      await expect(mintTxs.getByRole("link", { name: /Ver en el explorador/ })).toHaveAttribute("href", tx.explorerUrl);

      // ERP: la dueña ve la solicitud aprobada, la colección y la emisión con su transacción.
      await owner.goto(`/lotes/${lotId}?pestana=tokenizacion`);
      await expect(requestPanel(owner)).toHaveAttribute("data-status", "APPROVED", { timeout: 30_000 });
      const panel = collectionPanel(owner);
      await expect(panel).toHaveAttribute("data-collection", publishedEarly ? "PUBLISHED" : "READY");
      const mints = panel.getByRole("list", { name: "Emisiones", exact: true });
      await expect(mints.locator('[data-mint="CONFIRMED"]')).toHaveCount(1);
      await expect(mints).toContainText("Emisión inicial · 100 NFT · botellas 1–100");
      await expect(mints.getByRole("link", { name: /Ver en el explorador/ })).toHaveAttribute("href", tx.explorerUrl);
      await expect(lotState(owner).getByTestId("limits-summary")).toContainText("hasta 2.900 botellas");
      lap("emisión leída de la red");
    });

    // ───────────────────────── e · Publicar, pausar, reanudar y ampliar ─────────────────────────

    await test.step("e · Backoffice · publicar (preventa), pausar con motivo y reanudar: la pausa es comercial y no toca la red", async () => {
      if (!publishedEarly) await publishFromBackoffice(ops, QUOTA);
      await expect(ops.getByText("Publicada", { exact: true }).first()).toBeVisible();
      await expect(ops.getByText("Preventa", { exact: true }).first()).toBeVisible();
      expect(await platformCollection(admin, collectionId)).toMatchObject({
        status: "PUBLISHED",
        saleState: "PRESALE",
      });

      await ops.getByRole("button", { name: "Pausar la venta" }).click();
      const pause = ops.getByRole("alertdialog", { name: "Pausar la venta" });
      await expect(pause).toContainText("no toca la red");
      await pause.getByLabel("Motivo").fill(`${reason}: pausa de prueba`);
      await pause.getByRole("button", { name: "Pausar" }).click();
      await expect(ops.getByText("Colección pausada.").first()).toBeVisible();
      await expect(ops.getByText("Pausada", { exact: true }).first()).toBeVisible();
      expect(await platformCollection(admin, collectionId)).toMatchObject({ status: "PAUSED", saleState: null });
      expect(await chain.paused(contract, account), "paused() en la red con la venta pausada").toBe(false);

      await ops.getByRole("button", { name: "Reanudar la venta" }).click();
      await ops
        .getByRole("alertdialog", { name: "Reanudar la venta" })
        .getByRole("button", { name: "Reanudar" })
        .click();
      await expect(ops.getByText("Venta reanudada.").first()).toBeVisible();
      await expect(ops.getByText("Publicada", { exact: true }).first()).toBeVisible();
      expect(await platformCollection(admin, collectionId)).toMatchObject({
        status: "PUBLISHED",
        saleState: "PRESALE",
      });
      lap("publicar, pausar y reanudar");
    });

    await test.step("e · la dueña amplía la cuota en 50 (ERP) y operaciones la aprueba (Backoffice): segunda emisión con botellas 101–150 e ids continuos; en la red, total_minted = 150", async () => {
      await owner.getByRole("button", { name: "Actualizar" }).click();
      await lotState(owner).getByRole("link", { name: "Ampliar cuota" }).click();
      await expect(owner.getByRole("heading", { level: 1, name: `Ampliar la cuota de ${LOT}` })).toBeVisible();
      // Una ampliación solo lleva la cantidad adicional: los datos comerciales son de la colección.
      await expect(owner.getByLabel("Nombre de la colección")).toHaveCount(0);
      await owner.getByLabel("Botellas adicionales").fill(String(INCREASE));
      await owner.getByRole("button", { name: "Ampliar cuota" }).click();
      const confirm = owner.getByRole("alertdialog", { name: `¿Ampliar la cuota de ${LOT}?` });
      const [sent] = await Promise.all([
        owner.waitForResponse((r) => /\/api\/v1\/lots\/[\w-]+\/tokenization-requests$/.test(r.url())),
        confirm.getByRole("button", { name: "Sí, ampliar en 50 botellas" }).click(),
      ]);
      expect(sent.status()).toBe(201);
      const increase = await dataOf<TokenizationRequest>(sent);
      expect(increase).toMatchObject({
        kind: "QUOTA_INCREASE",
        status: "SUBMITTED",
        quantity: INCREASE,
        resultingQuota: TOTAL,
      });
      await expect(requestPanel(owner)).toContainText("Ampliación de cuota · 50 botellas más (150 en total)", {
        timeout: 30_000,
      });

      await ops.goto(`/tokenizacion/${increase.id}`);
      await expect(ops.getByRole("heading", { name: LOT, level: 1 })).toBeVisible({ timeout: 30_000 });
      await settled(ops);
      await ops.getByRole("button", { name: "Tomar la solicitud" }).click();
      await expect(ops.getByText("Solicitud tomada: ahora está en revisión y asignada a ti.").first()).toBeVisible();
      await ops.getByRole("button", { name: "Aprobar la ampliación" }).click();
      const approve = ops.getByRole("dialog", { name: "Aprobar la ampliación de cuota" });
      const [approved] = await Promise.all([
        ops.waitForResponse((r) => r.url().endsWith(`/tokenization-requests/${increase.id}/approve`)),
        approve.getByRole("button", { name: "Aprobar la ampliación" }).click(),
      ]);
      expect(approved.status()).toBe(201);
      lap("ampliación aprobada");

      const collection = await waitForMinted(admin, collectionId, TOTAL);
      lap("ampliación confirmada");
      // La ampliación no cambia el estado comercial: sigue publicada, con 150 de cuota.
      expect(collection).toMatchObject({
        status: "PUBLISHED",
        quota: TOTAL,
        counts: { minted: TOTAL, available: TOTAL },
      });
      expect(mintProblems(collection.mints, [QUOTA, INCREASE]), "emisión inicial y ampliación").toEqual([]);
      const second = collection.mints.find((m) => m.sequence === 2);
      expect(second?.ranges[0]).toMatchObject({ firstBottleNumber: QUOTA + 1, firstTokenId: firstTokenId + QUOTA });
      expect(second?.ranges.at(-1)).toMatchObject({ lastBottleNumber: TOTAL, lastTokenId: firstTokenId + TOTAL - 1 });

      expect(await onChainSupply(TOTAL)).toEqual({ totalMinted: TOTAL, balance: TOTAL });
      expect(await chain.ownerOf(contract, account, firstTokenId + TOTAL - 1), "owner_of del NFT 150").toBe(account);
      const tx = mintTransaction(second);
      await chain.confirmedTransaction(tx.txHash);

      await owner.goto(`/lotes/${lotId}?pestana=tokenizacion`);
      const mints = collectionPanel(owner).getByRole("list", { name: "Emisiones", exact: true });
      await expect(mints.locator('[data-mint="CONFIRMED"]')).toHaveCount(2, { timeout: 30_000 });
      await expect(mints).toContainText("Ampliación 1 · 50 NFT · botellas 101–150");
      await expect(collectionPanel(owner)).toContainText("150 botellas");
    });

    await test.step("negativa · la estimación del lote no baja de los NFT emitidos (TOK_ESTIMATE_BELOW_MINTED)", async () => {
      const lower = await ownerApi.raw("PATCH", `/v1/lots/${lotId}`, {
        body: { estimatedBottles: TOTAL - 30, reason: `${reason}: la cosecha rindió menos` },
      });
      expect({ status: lower.status, codes: errorCodes(lower) }).toMatchObject({ status: 422 });
      expect(errorCodes(lower)).toContain("TOK_ESTIMATE_BELOW_MINTED");
      expect((await ownerApi.get<{ estimatedBottles: number }>(`/v1/lots/${lotId}`)).estimatedBottles).toBe(ESTIMATE);
    });

    // ───────────────────────── f · Embotellado, cierre y anclaje ─────────────────────────

    await test.step("f · el lote se registra por la API hasta el embotellado (2.950 botellas, reposo cumplido) y se cierra el expediente: anclaje confirmado con memo = huella y lote ANCHORED", async () => {
      const bottled = await bottleSinganiLot(ownerApi, { lotId, parcelId, tankCode: `TK-H3-${suffix}` });
      lotCode = bottled.lotCode;
      expect(lotCode).toMatch(new RegExp(`^${lotPrefix}-\\d{4}-SINGANI-\\d{3,}$`));
      expect(bottled.bottles).toBe(BOTTLES);
      // Con más botellas que NFT, el límite pasa a las botellas con código activo (R6).
      const limits = (
        await ownerApi.get<{ limits: { basis: string; bottles: number; authorizedQuota: number } }>(
          `/v1/lots/${lotId}/tokenization`,
        )
      ).limits;
      expect(limits).toMatchObject({ basis: "BOTTLES", bottles: BOTTLES, authorizedQuota: TOTAL });

      const closed = await certifyLot(ownerApi, { lotId, runId, laboratoryName: LAB_NAME });
      hash = closed.hash;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      lap("expediente cerrado");
      note("lote", `${lotCode} · expediente cerrado en la bodega de la ejecución`);

      const anchored = await waitForAnchor(ownerApi, lotId);
      lap("anclaje confirmado");
      anchorExplorerUrl = anchored.anchor.explorerUrl;
      expect(anchored).toMatchObject({
        stage: "ANCHORED",
        hash,
        anchor: { status: "ANCHORED", network: "TESTNET", account: anchorAccount, memoHashHex: hash },
      });

      // Lectura independiente: la transacción es de la cuenta de anclaje oficial y su memo es la huella.
      const onChain = await chain.confirmedTransaction(anchored.anchor.txHash);
      expect(onChain, "transacción de anclaje leída del RPC").toMatchObject({
        source: anchorAccount,
        memoHashHex: hash,
        ledger: anchored.anchor.ledger,
      });
      expect(anchorExplorerUrl).toContain(anchored.anchor.txHash);
      await explorerResponds("transacción de anclaje", anchorExplorerUrl);

      // El anclaje vuelve canjeable la colección: de preventa a venta normal (contrato §7.2).
      const collection = await pollUntil(
        () => platformCollection(admin, collectionId),
        (c) => c.redeemable && c.saleState === "ON_SALE",
        {
          what: "colección canjeable y en venta tras el anclaje",
          timeoutMs: 60_000,
          describe: (c) => `${c.status}, ${c.saleState ?? "sin venta"}, canjeable: ${c.redeemable}`,
        },
      );
      expect(collection).toMatchObject({ status: "PUBLISHED", anchor: { status: "ANCHORED", memoHashHex: hash } });
      // Anclar no emite ni mueve nada.
      expect(await onChainSupply(TOTAL)).toEqual({ totalMinted: TOTAL, balance: TOTAL });
    });

    // ───────────────────────── g · Verificación pública en el visor ─────────────────────────

    const visor = await openApp("marketplace");
    const visorErrors = trackErrors(visor);

    await test.step("g · Marketplace · /b/{lotCode}: anclado, huella recalculada en el navegador, las cuatro comprobaciones en verde y el enlace a la transacción", async () => {
      const verification = await visitor.get<{
        anchor: { status: string; memoHashHex: string } | null;
        officialAnchorAccount: string | null;
        checks: { key: string; pass: boolean | null }[];
      }>(`/v1/public/lots/${lotCode}/verification`);
      expect(verification).toMatchObject({
        lotCode,
        dossier: { status: "CLOSED", hash },
        anchor: { status: "ANCHORED", memoHashHex: hash, memoHashBase64: hashHexToBase64(hash) },
        officialAnchorAccount: anchorAccount,
      });
      expect(Object.fromEntries(verification.checks.map((c) => [c.key, c.pass]))).toEqual({
        DOSSIER_CLOSED: true,
        ANCHOR_CONFIRMED: true,
        MEMO_MATCHES_HASH: true,
        ANCHOR_ACCOUNT_OFFICIAL: true,
      });

      // El pasaporte público ya dice ANCHORED (el anclaje invalida su caché) antes de abrir el visor.
      const passport = await pollUntil(
        () =>
          visitor.get<{
            stage: string;
            timeline: { type: string }[];
            dossier: { anchor: { status: string; explorerUrl: string | null } | null };
          }>(`/v1/public/passports/${lotCode}`),
        (p) => p.stage === "ANCHORED" && p.dossier.anchor?.status === "ANCHORED",
        {
          what: "pasaporte público del lote ANCHORED",
          timeoutMs: 120_000,
          intervalMs: 5_000,
          describe: (p) => `${p.stage}, anclaje ${p.dossier.anchor?.status ?? "sin crear"}`,
        },
      );
      expect(passport.dossier.anchor?.explorerUrl).toBe(anchorExplorerUrl);
      expect(passport.timeline.map((e) => e.type)).toContain("DOSSIER_ANCHORED");

      // El visor descarga el expediente canónico una vez y recalcula su SHA-256 con WebCrypto.
      const downloads: string[] = [];
      visor.on("request", (r) => {
        if (new URL(r.url()).pathname.endsWith(`/lots/${lotCode}/dossier`)) downloads.push(r.url());
      });
      await visor.goto(`/b/${lotCode}`);
      await expect(visor.getByRole("heading", { level: 1, name: LOT })).toBeVisible({ timeout: 30_000 });
      await expect(visor.getByRole("link", { name: `Ver la página de ${tradeName}` })).toHaveText(tradeName);
      const dossier = visor.getByRole("region", { name: "Expediente del lote", exact: true });
      await expect(dossier.getByTitle(hash)).toHaveText(`${hash.slice(0, 8)}…${hash.slice(-8)}`);

      const region = anchorRegion(visor);
      await expect(region).toContainText("Anclado el");
      await expect(region).toContainText("red de pruebas de Stellar");
      await expect(region).not.toContainText("Anclaje en la red: pendiente");
      await expect(region.getByText("La huella recalculada coincide")).toBeVisible({ timeout: 30_000 });
      expect(downloads.length, "descargas del expediente canónico desde el navegador").toBeGreaterThan(0);
      const checks = region.getByRole("list", { name: "Comprobaciones" }).getByRole("listitem");
      await expect(checks).toHaveCount(4);
      await expect(checks).toContainText([
        "El expediente está cerrado",
        "La red confirmó el anclaje",
        "El memo de la transacción coincide con la huella",
        "La cuenta de anclaje es la oficial de Drinks on Chain",
      ]);
      for (const check of await checks.all()) await expect(check.getByText("Cumple", { exact: true })).toBeVisible();
      await expect(region).toContainText("Comprobaciones hechas por el servidor de Drinks on Chain");
      const link = region.getByRole("link", { name: /Ver la transacción en el explorador/ });
      await expect(link).toHaveAttribute("href", anchorExplorerUrl);
      await expect(link).toHaveAttribute("rel", /noopener/);
      await expect(region.getByRole("alert")).toHaveCount(0);
      lap("anclaje verificado en el visor");
    });

    // ───────────────────────── h · Conciliación ─────────────────────────

    await test.step("h · Backoffice · conciliación manual completa de la colección: sin diferencias ni alertas abiertas de la bodega", async () => {
      await ops.goto("/cadena/conciliaciones");
      await settled(ops);
      await ops.getByRole("button", { name: "Lanzar una conciliación" }).click();
      const start = ops.getByRole("dialog", { name: "Lanzar una conciliación" });
      await expect(start).toBeVisible();
      // Alcance: la colección del recorrido (el entorno es compartido; lo de otras bodegas no es de
      // esta ejecución). Incluye las comprobaciones del contrato de su bodega. Profundidad: completa.
      await start.getByRole("combobox", { name: "Alcance" }).click();
      await ops.getByRole("option", { name: "Una colección", exact: true }).click();
      await start.getByRole("textbox", { name: /Colección/ }).fill(collectionId);
      await expect(start.getByRole("combobox", { name: "Profundidad" })).toContainText("Completa");
      const [launched] = await Promise.all([
        ops.waitForResponse(
          (r) => r.url().endsWith("/platform/chain/reconciliation/runs") && r.request().method() === "POST",
        ),
        start.getByRole("button", { name: "Lanzar" }).click(),
      ]);
      expect(launched.status(), "lanzar la conciliación responde 202").toBe(202);
      const launchedRun = await dataOf<{ id: string }>(launched);
      await expect(start).toHaveCount(0);
      await expect(ops.getByText(/Conciliación (terminada|lanzada)/).first()).toBeVisible();

      const run = await waitForReconciliation(admin, launchedRun.id);
      lap("conciliación terminada");
      expect(run, `conciliación: ${(run.alerts ?? []).map((a) => `${a.code} ${a.message}`).join(" · ")}`).toMatchObject(
        {
          scope: "COLLECTION",
          subjectId: collectionId,
          trigger: "MANUAL",
          depth: "FULL",
          status: "OK",
          issuesOpened: 0,
        },
      );
      expect(run.checks, "comprobaciones hechas").toBeGreaterThan(0);
      expect(run.alerts ?? [], "alertas de la conciliación").toEqual([]);
      const open = await admin.get<ListPage<{ code: string; message: string }>>("/v1/platform/chain/alerts", {
        status: "open",
        wineryId,
        limit: 100,
      });
      expect(
        open.items.map((a) => `${a.code}: ${a.message}`),
        "alertas abiertas de la bodega de la ejecución",
      ).toEqual([]);

      // En la pantalla, la conciliación recién lanzada (la primera: orden por inicio descendente).
      await ops.reload();
      await settled(ops);
      const latest = ops.getByRole("row").filter({ hasText: "Una colección · completa" }).first();
      await expect(latest).toContainText("Sin diferencias");
      await expect(latest).toContainText("Manual");

      // Y la red sigue diciendo lo mismo que la base.
      expect(await onChainSupply(TOTAL)).toEqual({ totalMinted: TOTAL, balance: TOTAL });
      note("tope de las esperas a la red", `${Math.round(CHAIN_WAIT_MS / 1000)} s`);
    });

    expect(ownerErrors, "errores en el ERP de la dueña").toEqual([]);
    expect(opsErrors, "errores en el back office de operaciones").toEqual([]);
    expect(visorErrors, "errores en el visor").toEqual([]);
  });
});

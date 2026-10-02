import type { Page } from "@playwright/test";
import { DEMO_PASSWORD } from "../src/config";
import { expect, needsDemoPassword, test } from "../src/fixtures/test";
import { ORG, WINERY } from "../src/fixtures/users";
import { ApiClient, missingRoutes, type Page as ListPage } from "../src/lib/api";
import { discardRunLots } from "../src/lib/cleanup";
import { daysAgo, plusDays } from "../src/lib/dates";
import { bottleProofRoot, sha256Hex, type MerkleProof } from "../src/lib/merkle";
import { trackErrors } from "../src/lib/page";
import { runName } from "../src/lib/run-id";

// H2 · Pasaporte público (PLAN-MAESTRO, hito H2; contrato plan/contratos/o2-erp-confiable.md §12
// y §18): el visor del Marketplace, construido sin mocks, pinta el pasaporte real de un lote y de
// sus botellas.
//
//   por la API, con las personas de demostración de Destilería Cinti Viejo (enóloga, operario y
//   agrónomo), un lote singani completo con fechas relativas a hoy y el reposo ya cumplido: lote →
//   pesaje, análisis y dictamen → tanque, fermentación y destino singani → destilación cerrada →
//   embotellado de 2.950 botellas → laboratorio conforme → cierre del expediente con huella
//   → el visor abre `/b/{lotCode}` y `/b/{código de botella}` → se anula una botella por la API y
//   el visor lo avisa → un código inexistente (una sola consulta) → "no encontrado".
//
// Todo lo que crea lleva el prefijo de la ejecución en el nombre del lote; de la semilla solo usa
// una parcela apta y las personas, sin modificarlas. El recorrido completo del lote por la
// interfaz del ERP, con las pruebas de elusión, es `h2-lote-singani.spec.ts` (parte 2).
//
// Requiere la Etapa 2 del backend (O2-BE-1): si el OpenAPI no declara sus rutas, se marca fixme.
//
// El freno de enumeración del pasaporte (más de 20 códigos inexistentes por IP en 10 minutos →
// 429) no se prueba aquí ni debe dispararse: el recorrido hace una única consulta inexistente.

const H2_ROUTES = [
  "/v1/lots",
  "/v1/lots/{id}/bottling/preview",
  "/v1/lots/{id}/bottling",
  "/v1/lots/{id}/bottle-codes",
  "/v1/lots/{id}/lab-analyses",
  "/v1/lots/{id}/dossier/preview",
  "/v1/lots/{id}/dossier/close",
  "/v1/lots/{id}/discard",
  "/v1/bottle-codes/{code}/void",
  "/v1/harvest-batches/{id}/maturity-analyses",
  "/v1/harvest-batches/{id}/phyto-decisions",
  "/v1/fermentation-tanks/{id}/start",
  "/v1/fermentation-tanks/{id}/complete",
  "/v1/production-batches/distillation",
  "/v1/production-batches/{id}/close",
  "/v1/public/passports/{code}",
  "/v1/public/lots/{lotCode}/dossier",
] as const;

// Caso del contrato §18.
const VARIETY = "Moscatel de Alejandría";
const MIN_ALTITUDE = 1600;
const REST_DAYS = 180;
const BOTTLES = 2950;
const LAB_NAME = "Laboratorio E2E ISO 17025";
/** Botella que se abre en el visor y botella que se anula (otra, para no leer nada cacheado). */
const SERIAL = 1234;
const VOIDED_SERIAL = 9;

interface Terroir {
  id: string;
  parcelName: string;
  altitudeMasl: number;
  varietyName: string;
  isDoEligible: boolean;
  isActive: boolean;
}

interface Lot {
  id: string;
  stage: string;
  lotCode: string | null;
  rules: {
    origin: string;
    singani: { minAltitudeMasl: number; requiredVarieties: string[]; minRestDays: number };
    bottling: { maxLossPercent: number };
  };
}

interface BottleUnit {
  code: string;
  codeFormatted: string;
  serial: number;
  status: "ACTIVE" | "VOIDED";
}

interface Dossier {
  status: "OPEN" | "CLOSED";
  hash: string | null;
  bottleCodes: { count: number; merkleRoot: string } | null;
}

interface PublicLot {
  kind: "LOT";
  lotCode: string;
  name: string;
  stage: string;
  winery: { slug: string; tradeName: string; region: string; active: boolean };
  timeline: { type: string; summary: string; actorRole: string | null }[];
  dossier: { status: string; hash: string | null; closedAt: string | null; canonicalUrl: string | null };
}

interface PublicBottle {
  kind: "BOTTLE";
  bottle: {
    code: string;
    codeFormatted: string;
    serial: number;
    lotTotal: number;
    status: "ACTIVE" | "VOIDED";
    merkleProof: MerkleProof | null;
  };
  lot: PublicLot;
}

/**
 * Resultados posibles de la comprobación de la botella contra el expediente, por el texto con que
 * el visor los pinta. Solo `verified` es el correcto para una botella activa de un lote cerrado.
 */
const PROOF_OUTCOMES = {
  verified: "Este código pertenece al expediente cerrado",
  "mismatch-root": "No pudimos confirmar este código",
  "mismatch-hash": "El expediente no coincide con su huella",
  failed: "No pudimos descargar el expediente para comprobar el código",
  unsupported: "Este navegador no permite hacer la comprobación aquí",
  "dossier-open": "La bodega aún no cerró el expediente de este lote",
} as const;

/** Resultados de la comprobación que el visor muestra ahora (vacío mientras comprueba). */
async function proofOutcomes(page: Page): Promise<string[]> {
  const shown: string[] = [];
  for (const [outcome, text] of Object.entries(PROOF_OUTCOMES)) {
    if ((await page.getByText(text).count()) > 0) shown.push(outcome);
  }
  return shown;
}

/** Sección del pasaporte por su título (`<section aria-labelledby>`). */
const section = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

/** El visor pide el pasaporte desde el navegador: espera a que pinte el lote (su nombre en el h1). */
async function passportLoaded(page: Page, lotName: string) {
  await expect(page.getByRole("heading", { level: 1, name: lotName }), "pasaporte pintado").toBeVisible({
    timeout: 30_000,
  });
}

test.describe("H2 · pasaporte público en el visor del Marketplace", () => {
  let missing: string[] = [];
  let openApiError: string | null = null;
  // Lo que deja el recorrido, para la limpieza.
  let lotCreated = false;
  let certified = false;

  test.beforeAll(async () => {
    try {
      missing = await missingRoutes(H2_ROUTES);
    } catch (error) {
      openApiError = error instanceof Error ? error.message : String(error);
    }
  });

  // Al terminar (también si la prueba falla): un lote que no llegó a cerrar su expediente se
  // descarta con motivo. El lote con el expediente cerrado es terminal para la API
  // (`TRC_LOT_TERMINAL`): queda en la bodega de demostración con el prefijo de la ejecución en el
  // nombre. El recorrido no crea bodegas ni cuentas.
  test.afterAll(async ({ runId }) => {
    if (!lotCreated || certified || !DEMO_PASSWORD) return;
    const enologist = await ApiClient.create(`${runId} limpieza`);
    try {
      await enologist.login(WINERY.cintiEnologist.email, DEMO_PASSWORD);
      const result = await discardRunLots(enologist, runId, `Fin del recorrido E2E ${runId}`);
      console.log(
        `Limpieza ${runId}: ${result.discarded.length} lote(s) descartados, ${result.kept.length} conservados`,
      );
    } finally {
      await enologist.logout();
      await enologist.dispose();
    }
  });

  test("lote singani por la API → pasaporte del lote y de la botella en el visor → código anulado → código inexistente", async ({
    page,
    api,
    runId,
  }) => {
    test.fixme(openApiError !== null, `No se pudo leer el OpenAPI del backend: ${openApiError ?? ""}`);
    test.fixme(
      missing.length > 0,
      `requiere O2-BE-1 desplegado: el OpenAPI de desarrollo aún no declara ${missing.join(", ")}`,
    );
    needsDemoPassword();
    test.setTimeout(10 * 60_000);

    const lotName = runName(runId, "Singani Gran Reserva 2026");
    const suffix = runId.split("-").at(-1) ?? runId;
    const year = Number(daysAgo(205).slice(0, 4));
    /** Fin de la destilación hace 185 días: el reposo de 180 venció hace 5. */
    const restEnd = daysAgo(185);
    const unlock = plusDays(restEnd, REST_DAYS);
    const bottling = {
      bottlingDate: daysAgo(2),
      packagingFormatCl: 75,
      totalBottlesPackaged: BOTTLES,
      finalAlcoholAbv: 40,
      waterDilutionLiters: 750,
    };
    /** Código de lote con forma válida que no existe (ninguna bodega tiene el prefijo ZZZ). */
    const missingCode = `ZZZ-${year}-SINGANI-999`;

    // Una sesión por persona para todo el recorrido (cada inicio de sesión cuenta para el límite).
    const enologist = await api.as(WINERY.cintiEnologist.email);
    const operator = await api.as(WINERY.cintiOperator.email);
    const agronomist = await api.as(WINERY.cintiAgronomist.email);
    const visitor = await api.anonymous(`${runId} visitante`);

    let parcel: Terroir | undefined;
    let lotId = "";
    let harvestId = "";
    let tankId = "";
    let productionId = "";
    let lotCode = "";
    let hash = "";
    let merkleRoot = "";
    let bottle: BottleUnit | undefined;
    let voided: BottleUnit | undefined;
    let passport: PublicLot | undefined;

    await test.step("la enóloga crea el lote: instantánea con 1.600 m, Moscatel de Alejandría, 180 días y merma del 5 %", async () => {
      // Parcela apta de la semilla (solo se lee): Moscatel de Alejandría a 1.600 m o más.
      const terroirs = await enologist.get<ListPage<Terroir>>("/v1/terroirs", { limit: 100 });
      parcel = terroirs.items.find(
        (t) => t.isActive && t.isDoEligible && t.varietyName === VARIETY && t.altitudeMasl >= MIN_ALTITUDE,
      );
      expect(parcel, `parcela apta para singani en ${ORG.cinti}`).toBeTruthy();

      const lot = await enologist.post<Lot>("/v1/lots", {
        name: lotName,
        harvestYear: year,
        productType: "SINGANI",
        estimatedBottles: 3000,
        plannedFormatCl: 75,
        targetAbvPercent: 40,
        notes: `Lote de prueba del recorrido ${runId}`,
      });
      lotId = lot.id;
      lotCreated = true;
      expect(lot).toMatchObject({
        stage: "ORIGIN",
        lotCode: null,
        rules: {
          origin: "LOT_CREATION",
          singani: { minAltitudeMasl: MIN_ALTITUDE, requiredVarieties: [VARIETY], minRestDays: REST_DAYS },
          bottling: { maxLossPercent: 5 },
        },
      });
    });

    await test.step("pesaje del operario, análisis de la enóloga y dictamen del agrónomo", async () => {
      const harvest = await operator.post<{ id: string; netWeightKg: number; phytosanitaryStatus: string }>(
        "/v1/harvest-batches",
        {
          lotId,
          terroirId: parcel?.id,
          intakeDate: daysAgo(205),
          grossWeightKg: 18500,
          tareWeightKg: 100,
          temperatureAtIntakeC: 18,
        },
      );
      harvestId = harvest.id;
      expect(harvest).toMatchObject({ netWeightKg: 18400, phytosanitaryStatus: "PENDING_INSPECTION" });

      await enologist.post(`/v1/harvest-batches/${harvestId}/maturity-analyses`, {
        brixDegrees: 23.5,
        ph: 3.5,
        acidityGl: 5.8,
        measuredAt: `${daysAgo(205)}T15:00:00Z`,
      });
      const decided = await agronomist.post<{ phytosanitaryStatus: string }>(
        `/v1/harvest-batches/${harvestId}/phyto-decisions`,
        { decision: "APPROVED", decidedAt: `${daysAgo(204)}T12:00:00Z` },
      );
      expect(decided.phytosanitaryStatus).toBe("APPROVED");
    });

    await test.step("tanque de 12.100 L, fermentación con lecturas y un tratamiento, y destino singani", async () => {
      const tank = await enologist.post<{ id: string }>("/v1/fermentation-tanks", {
        inputs: [{ harvestBatchId: harvestId }],
        tankCode: `TK-E2E-${suffix}`,
        capacityLiters: 15000,
        volumeFilledLiters: 12100,
        startDate: `${daysAgo(204)}T14:00:00Z`,
      });
      tankId = tank.id;
      const path = `/v1/fermentation-tanks/${tankId}`;
      const started = await enologist.post<{ status: string }>(`${path}/start`, {
        startedAt: `${daysAgo(203)}T08:00:00Z`,
      });
      expect(started.status).toBe("FERMENTING");
      for (const [day, temperatureCelsius] of [
        [202, 23.8],
        [201, 24.1],
      ] as const) {
        await operator.post(`${path}/logs`, {
          temperatureCelsius,
          specificGravity: 1.05,
          recordedAt: `${daysAgo(day)}T09:00:00Z`,
        });
      }
      await enologist.post(`${path}/treatments`, {
        treatmentType: "SO2_ADDITION",
        additiveName: "Metabisulfito de potasio",
        dosageAppliedGPerHl: 5,
        regulatoryAuthCode: "SENASAG-ADT-E2E-001",
        appliedAt: `${daysAgo(202)}T10:00:00Z`,
      });
      const completed = await enologist.post<{ status: string; destinationType: string }>(`${path}/complete`, {
        endDate: daysAgo(195),
        finalVolumeLiters: 12100,
        destination: "SINGANI_DIST",
      });
      expect(completed).toMatchObject({ status: "COMPLETED", destinationType: "SINGANI_DIST" });
    });

    await test.step("destilación cerrada con cabezas 120 L, corazón 1.500 L al 60 % y colas 210 L: reposo cumplido", async () => {
      const opened = await enologist.post<{ id: string }>("/v1/production-batches/distillation", {
        fermentationTankId: tankId,
        equipmentIdentifier: `Alambique E2E ${suffix}`,
        processStartDate: daysAgo(194),
        inputVolumeLiters: 12100,
      });
      productionId = opened.id;
      const closed = await enologist.post<{ restStatus: string; lock: { unlockDate: string; released: boolean } }>(
        `/v1/production-batches/${productionId}/close`,
        {
          processEndDate: restEnd,
          cuts: { headsLiters: 120, heartLiters: 1500, tailsLiters: 210 },
          heartAbvPercent: 60,
        },
      );
      expect(closed).toMatchObject({ restStatus: "READY", lock: { unlockDate: unlock, released: true } });
      expect((await enologist.get<Lot>(`/v1/lots/${lotId}`)).stage).toBe("RESTING");
    });

    await test.step("vista previa y embotellado: 2.950 botellas de 75 cL al 40 % con 750 L de agua", async () => {
      const preview = await enologist.post<{ valid: boolean; violations: unknown[] }>(
        `/v1/lots/${lotId}/bottling/preview`,
        bottling,
      );
      expect(preview).toMatchObject({
        valid: true,
        violations: [],
        balance: { bottledLiters: 2212.5, pureAlcohol: { availableLiters: 900, bottledLiters: 885 }, maxBottles: 3000 },
      });
      const bottled = await enologist.post<{ lotCode: string; bottleCodes: { total: number; active: number } }>(
        `/v1/lots/${lotId}/bottling`,
        bottling,
      );
      lotCode = bottled.lotCode;
      expect(lotCode).toMatch(/^[A-Z0-9]+-\d{4}-SINGANI-\d{3,}$/);
      expect(bottled.bottleCodes).toMatchObject({ total: BOTTLES, active: BOTTLES });

      const unit = async (serial: number) => {
        const codes = await enologist.get<ListPage<BottleUnit>>(`/v1/lots/${lotId}/bottle-codes`, {
          fromSerial: serial,
          toSerial: serial,
          status: "ACTIVE",
        });
        const found = codes.items.find((c) => c.serial === serial);
        expect(found, `código de la botella n.º ${serial}`).toBeTruthy();
        return found;
      };
      bottle = await unit(SERIAL);
      voided = await unit(VOIDED_SERIAL);
    });

    await test.step("laboratorio conforme (metanol en mg/100 mL a.a., cobre y grado) y cierre del expediente con huella", async () => {
      // El informe va por su URL (alias de `laboratoryReportKey` hasta H2, contrato §8.1): así el
      // recorrido no deja archivos en el almacenamiento de la bodega de demostración.
      const lab = await enologist.post<{ conformityStatus: string }>(`/v1/lots/${lotId}/lab-analyses`, {
        certifiedLaboratoryName: LAB_NAME,
        accreditedLabCertificationCode: `LAB-E2E-${suffix}`,
        testPerformedAt: daysAgo(1),
        actualAlcoholAbv: 40.05,
        totalAcidityTartaricGl: 4.8,
        volatileAcidityAceticGl: 0.22,
        copperContentMgL: 0.02,
        methanolMg100mlAa: 12,
        laboratoryReportPdfUrl: "https://laboratorio.example.test/informe-e2e.pdf",
      });
      expect(lab.conformityStatus).toBe("CONFORMING");

      const preview = await enologist.get<{ ready: boolean; requirements: { key: string; met: boolean }[] }>(
        `/v1/lots/${lotId}/dossier/preview`,
      );
      expect(
        preview.requirements.filter((r) => !r.met).map((r) => r.key),
        "requisitos del cierre sin cumplir",
      ).toEqual([]);
      const closed = await enologist.post<Dossier>(`/v1/lots/${lotId}/dossier/close`, { confirm: true });
      expect(closed).toMatchObject({ status: "CLOSED", bottleCodes: { count: BOTTLES } });
      hash = closed.hash ?? "";
      merkleRoot = closed.bottleCodes?.merkleRoot ?? "";
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect((await enologist.get<Lot>(`/v1/lots/${lotId}`)).stage).toBe("CERTIFIED");
      certified = true;
      test.info().annotations.push({
        type: "lote",
        description: `${lotCode} queda CERTIFIED en ${ORG.cinti} (un expediente cerrado no se puede descartar)`,
      });
    });

    await test.step("pasaporte público por la API: huella recalculable y prueba Merkle de la botella", async () => {
      passport = await visitor.get<PublicLot>(`/v1/public/passports/${lotCode}`);
      expect(passport).toMatchObject({
        kind: "LOT",
        lotCode,
        name: lotName,
        productType: "SINGANI",
        vintage: year,
        stage: "CERTIFIED",
        winery: { tradeName: ORG.cinti, active: true },
        denomination: { applies: true, status: "ELIGIBLE", legalException: false },
        origin: { status: "RECORDED", terroirs: [{ parcelName: parcel?.parcelName, variety: VARIETY }] },
        harvest: { status: "RECORDED", phytosanitary: "APPROVED" },
        fermentation: { status: "RECORDED", readingsCount: 2 },
        aging: { status: "NOT_APPLICABLE" },
        distillation: { status: "RECORDED", heartAbvPercent: 60, restMinDays: REST_DAYS, restUntil: unlock },
        bottling: { status: "RECORDED", bottles: BOTTLES, formatCl: 75, finalAbv: 40 },
        lab: { status: "CONFORMING", laboratoryName: LAB_NAME },
        corrections: { count: 0 },
        dossier: { status: "CLOSED", hash, anchor: null },
      });
      expect(passport.timeline.map((e) => e.type)).toEqual(
        expect.arrayContaining([
          "HARVEST_WEIGHED",
          "PHYTO_DECIDED",
          "TANK_FILLED",
          "FERMENTATION_COMPLETED",
          "DISTILLATION_CLOSED",
          "BOTTLED",
          "LAB_REGISTERED",
          "DOSSIER_CLOSED",
        ]),
      );
      // Sin cifras internas (S-22): ni kilos ni litros intermedios.
      expect(JSON.stringify(passport)).not.toMatch(/18400|12100/);
      test.info().annotations.push({
        type: "dossier.canonicalUrl",
        description: /^https?:\/\//.test(passport.dossier.canonicalUrl ?? "")
          ? "URL absoluta del backend (…/v1/public/lots/{lotCode}/dossier)"
          : String(passport.dossier.canonicalUrl),
      });

      // Los bytes públicos del expediente son los que se hashearon, y llevan la raíz Merkle.
      const file = await visitor.bytes(`/v1/public/lots/${lotCode}/dossier`);
      expect(file.status).toBe(200);
      expect(sha256Hex(file.body), "huella recalculada del expediente canónico").toBe(hash);
      const canonical = JSON.parse(file.body.toString("utf8")) as { bottleCodes: { merkleRoot: string } };
      expect(canonical.bottleCodes.merkleRoot).toBe(merkleRoot);

      const one = await visitor.get<PublicBottle>(`/v1/public/passports/${bottle?.code ?? ""}`);
      expect(one.bottle).toMatchObject({ code: bottle?.code, serial: SERIAL, lotTotal: BOTTLES, status: "ACTIVE" });
      const proof = one.bottle.merkleProof;
      expect(proof, "prueba Merkle de la botella tras el cierre").not.toBeNull();
      expect(
        proof ? bottleProofRoot(SERIAL, one.bottle.code, proof) : null,
        "raíz recalculada desde la botella (SHA-256 sobre los bytes de cada par de nodos)",
      ).toBe(merkleRoot);
    });

    // El visor: una sola página para todo el recorrido. Lo único que se espera en rojo es el 404
    // del código inexistente.
    const errors = trackErrors(page, [new RegExp(`^404 /api/v1/public/passports/${missingCode}$`)]);

    await test.step("el visor abre /b/{lotCode}: nombre, bodega, D.O., elaboración, registro, laboratorio y expediente cerrado", async () => {
      await page.goto(`/b/${lotCode}`);
      await passportLoaded(page, lotName);
      await expect(page.getByText(`Singani · Añada ${year}`)).toBeVisible();
      await expect(page.getByRole("link", { name: `Ver la página de ${ORG.cinti}` })).toHaveText(ORG.cinti);
      await expect(page.getByText(passport?.winery.region ?? "", { exact: true })).toBeVisible();
      await expect(page.getByText("Esta etiqueta identifica el lote")).toBeVisible();
      await expect(page.getByRole("main").getByText(lotCode, { exact: true })).toBeVisible();

      // Expediente cerrado, con su huella abreviada (la completa, en el título).
      const dossier = section(page, "Expediente del lote");
      await expect(dossier.getByText(/^Expediente cerrado el \d{1,2} \S+ \d{4}$/)).toBeVisible();
      await expect(dossier.getByTitle(hash)).toHaveText(`${hash.slice(0, 8)}…${hash.slice(-8)}`);
      await expect(dossier.getByRole("button", { name: "Descargar expediente" })).toBeVisible();
      await expect(dossier).toContainText("Anclaje en la red: pendiente");

      // Origen y Denominación de Origen, con las reglas de la instantánea.
      const origin = section(page, "Origen");
      await expect(origin.getByText(parcel?.parcelName ?? "", { exact: true })).toBeVisible();
      await expect(origin.getByText("Apta", { exact: true })).toBeVisible();
      await expect(origin.getByText("Cumple la Denominación de Origen", { exact: true })).toBeVisible();
      await expect(origin).toContainText(`parcelas a 1.600 m s. n. m. o más, y uva de ${VARIETY}`);

      // Elaboración: cada etapa aplicable con sus datos (la crianza no aplica a un singani).
      const making = section(page, "Elaboración");
      const stage = (name: string) =>
        making.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });
      await expect(stage("Vendimia")).toContainText("Aprobado");
      await expect(stage("Vendimia")).toContainText("23,5 °Brix · pH 3,5 · acidez 5,8 g/L");
      await expect(stage("Fermentación")).toContainText("Metabisulfito de potasio");
      await expect(stage("Destilación y reposo")).toContainText("60 % vol");
      await expect(stage("Destilación y reposo")).toContainText("180 días");
      await expect(stage("Embotellado")).toContainText("2.950");
      await expect(stage("Embotellado")).toContainText("75 cL");
      await expect(stage("Embotellado")).toContainText("40 % vol");
      await expect(making.getByRole("heading", { name: "Crianza", exact: true })).toHaveCount(0);

      // Línea de tiempo: los eventos públicos del pasaporte real, en su orden y con el rol (nunca
      // el nombre) de quien registró.
      const journey = section(page, "Registro del lote");
      const timeline = passport?.timeline ?? [];
      await expect(journey.getByRole("listitem")).toHaveCount(timeline.length);
      await expect(journey.getByRole("listitem")).toContainText(timeline.map((e) => e.summary));
      for (const role of ["Operación de bodega", "Agronomía", "Enología"]) await expect(journey).toContainText(role);
      await expect(journey).toContainText("Sin correcciones registradas.");
      await expect(page.getByRole("main")).not.toContainText("@");

      // Laboratorio conforme, con cada parámetro frente a su límite.
      const lab = section(page, "Laboratorio");
      await expect(lab.getByText("Conforme", { exact: true })).toBeVisible();
      await expect(lab).toContainText(LAB_NAME);
      for (const parameter of ["Metanol", "Cobre", "Grado alcohólico"]) {
        await expect(lab.getByRole("listitem").filter({ hasText: parameter })).toContainText("Cumple");
      }
      await expect(section(page, "Reglas con las que se hizo el lote")).toContainText("Fijadas el");
    });

    await test.step("el visor abre /b/{código de botella}: botella n.º 1.234 de 2.950 y comprobación de pertenencia", async () => {
      await page.goto(`/b/${bottle?.code ?? ""}`);
      await passportLoaded(page, lotName);
      await expect(page.getByText("Botella n.º 1.234 de 2.950", { exact: true })).toBeVisible();
      await expect(page.getByRole("main").getByText(bottle?.codeFormatted ?? "", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Ver el lote completo" })).toHaveAttribute(
        "href",
        `/b/${lotCode}?desde=${bottle?.code ?? ""}`,
      );
      await expect(section(page, "Expediente del lote").getByTitle(hash)).toBeVisible();
      await expect(section(page, "Laboratorio").getByText("Conforme", { exact: true })).toBeVisible();
      await expect(page.getByText("Este código fue anulado por la bodega")).toHaveCount(0);

      // El navegador descarga el expediente canónico (`dossier.canonicalUrl`), recalcula su huella
      // y la raíz Merkle desde la botella. Comprobación blanda: si el visor no lo consigue contra
      // el backend real, el error dice qué resultado pintó, y el recorrido sigue (anulación y
      // código inexistente) y termina en rojo.
      await expect
        .configure({ soft: true })
        .poll(() => proofOutcomes(page), {
          message:
            "resultado de la comprobación de la botella contra el expediente cerrado en el visor (huella del expediente canónico + raíz Merkle desde la botella)",
          timeout: 20_000,
        })
        .toEqual(["verified"]);
    });

    await test.step("la enóloga anula una botella por la API y el visor lo avisa", async () => {
      const result = await enologist.post<BottleUnit>(`/v1/bottle-codes/${voided?.code ?? ""}/void`, {
        reason: `Botella rota tras el cierre · ${runId}`,
      });
      expect(result).toMatchObject({ status: "VOIDED", serial: VOIDED_SERIAL });

      await page.goto(`/b/${voided?.code ?? ""}`);
      await passportLoaded(page, lotName);
      await expect(page.getByText("Este código fue anulado por la bodega", { exact: true })).toBeVisible();
      await expect(page.getByText("Si la etiqueta de tu botella lo muestra, avisa a la bodega.")).toBeVisible();
      await expect(page.getByText(`Botella n.º ${VOIDED_SERIAL} de 2.950`, { exact: true })).toBeVisible();
      await expect(page.getByRole("main").getByText(voided?.codeFormatted ?? "", { exact: true })).toBeVisible();
      // Un código anulado no presume de pertenecer al expediente.
      await expect(page.getByText(PROOF_OUTCOMES.verified)).toHaveCount(0);
    });

    await test.step("un código inexistente (una sola consulta) → no encontrado", async () => {
      let lookups = 0;
      page.on("response", (r) => {
        if (new URL(r.url()).pathname === `/api/v1/public/passports/${missingCode}`) lookups += 1;
      });
      await page.goto(`/b/${missingCode}`);
      await expect(page.getByRole("heading", { level: 1, name: missingCode })).toBeVisible();
      await expect(page.getByText("No encontramos este código", { exact: true })).toBeVisible();
      await expect(page.getByText(/Ese lote no figura en el registro/)).toBeVisible();
      expect(lookups, "consultas del código inexistente").toBe(1);
    });

    expect.soft(errors, "respuestas o errores inesperados en el visor").toEqual([]);
  });
});

import type { ApiClient, LoginResult } from "./api";
import { daysAgo } from "./dates";
import { tokenFromLink, type Mailbox } from "./mailbox";
import { runTaxId } from "./run-id";

// Bodega propia de una ejecución, preparada por la API (CLAUDE.md, "Limpieza de datos"): alta
// directa por la plataforma, dueña y equipo que aceptan su invitación desde el buzón, parcelas y
// lotes de singani listos para embotellar. Lo usan los recorridos de H2 y H3; la limpieza
// (`src/lib/cleanup.ts`) bloquea las cuentas y revoca la bodega al terminar.

export interface RunPerson {
  email: string;
  name: string;
}

export type WineryRole = "ENOLOGIST" | "AGRONOMIST" | "OPERATOR" | "ACCOUNTANT";

export const SINGANI_VARIETY = "Moscatel de Alejandría";

/**
 * Acepta por la API la invitación que llegó al buzón de `person`: crea su cuenta con `password` y
 * deja a `client` con su sesión en la bodega (sin pasar por el inicio de sesión).
 */
export async function acceptFromMailbox(
  mailbox: Mailbox,
  client: ApiClient,
  person: RunPerson,
  password: string,
): Promise<LoginResult> {
  const link = await mailbox.waitForLink(person.email, { link: /\/invitacion\// });
  return client.acceptInvitation(tokenFromLink(link), person.name, password);
}

/**
 * Alta directa de una bodega de la ejecución (sesión de plataforma con permiso de altas) y
 * aceptación de su dueña: la bodega pasa a `ACTIVE` con su prefijo de lote. Devuelve su id.
 */
export async function createRunWinery(
  platform: ApiClient,
  mailbox: Mailbox,
  options: {
    runId: string;
    tradeName: string;
    /** Distingue el NIT de las bodegas de una misma ejecución. */
    taxSalt: string;
    region: string;
    owner: RunPerson;
    ownerClient: ApiClient;
    password: string;
  },
): Promise<string> {
  const { runId, tradeName, owner } = options;
  const created = await platform.post<{ winery: { id: string; status: string } }>("/v1/platform/wineries", {
    legalName: `${tradeName} S.R.L.`,
    tradeName,
    taxId: runTaxId(runId, options.taxSalt),
    category: "DISTILLERY",
    region: options.region,
    contactEmail: owner.email,
    ownerEmail: owner.email,
    ownerFullName: owner.name,
    reason: `Bodega del recorrido E2E ${runId}`,
  });
  const accepted = await acceptFromMailbox(mailbox, options.ownerClient, owner, options.password);
  if (accepted.activeOrganizationId !== created.winery.id) {
    throw new Error(`La dueña de ${tradeName} no quedó con la bodega activa tras aceptar la invitación`);
  }
  return created.winery.id;
}

/** La dueña invita al equipo y cada persona acepta desde el correo (queda con sesión en la bodega). */
export async function inviteTeam(
  owner: ApiClient,
  mailbox: Mailbox,
  team: readonly (readonly [client: ApiClient, person: RunPerson, role: WineryRole])[],
  password: string,
): Promise<void> {
  for (const [, person, role] of team) {
    await owner.post("/v1/organizations/current/invitations", { email: person.email, role });
  }
  for (const [client, person, role] of team) {
    const accepted = await acceptFromMailbox(mailbox, client, person, password);
    const membership = accepted.memberships?.find((m) => m.organizationId === accepted.activeOrganizationId);
    if (membership?.role !== role) {
      throw new Error(`${person.email} no quedó como ${role} en la bodega (rol: ${membership?.role ?? "ninguno"})`);
    }
  }
}

export interface Parcel {
  id: string;
  parcelName: string;
  isDoEligible: boolean;
}

/** Parcela de uva (dueña o agronomía). La aptitud D.O. la calcula el servidor. */
export function createParcel(
  member: ApiClient,
  parcel: { parcelName: string; altitudeMasl: number; varietyName?: string; surfaceHectares?: number },
): Promise<Parcel> {
  return member.post<Parcel>("/v1/terroirs", {
    parcelName: parcel.parcelName,
    surfaceHectares: parcel.surfaceHectares ?? 2.5,
    altitudeMasl: parcel.altitudeMasl,
    rawMaterialType: "Uva",
    varietyName: parcel.varietyName ?? SINGANI_VARIETY,
  });
}

export interface RestingLot {
  lotId: string;
  productionId: string;
  /** Fin del reposo (`AAAA-MM-DD`) según la instantánea del lote. */
  unlockDate: string;
  released: boolean;
}

/**
 * Lote pequeño de singani hasta el reposo, por la API y con una sola sesión (dirección o
 * enología): lote → pesaje de 200 kg → dictamen aprobado → tanque de 120 L, fermentación completa
 * con destino singani → destilación cerrada hace `restEndDaysAgo` días con un corazón de 15 L al
 * 60 %. Con 7,5 L de agua da 30 botellas de 75 cL al 40 % exactas (`SMALL_BOTTLING`). Sin análisis
 * de madurez ni laboratorio: su pasaporte los muestra como "No registrado".
 */
export async function prepareRestingSinganiLot(
  member: ApiClient,
  options: { name: string; parcelId: string; tankCode: string; restEndDaysAgo: number },
): Promise<RestingLot> {
  const end = options.restEndDaysAgo;
  const lot = await member.post<{ id: string }>("/v1/lots", {
    name: options.name,
    harvestYear: Number(daysAgo(end + 20).slice(0, 4)),
    productType: "SINGANI",
  });
  const harvest = await member.post<{ id: string }>("/v1/harvest-batches", {
    lotId: lot.id,
    terroirId: options.parcelId,
    intakeDate: daysAgo(end + 20),
    grossWeightKg: 250,
    tareWeightKg: 50,
  });
  await member.post(`/v1/harvest-batches/${harvest.id}/phyto-decisions`, {
    decision: "APPROVED",
    decidedAt: `${daysAgo(end + 19)}T12:00:00Z`,
  });
  const tank = await member.post<{ id: string }>("/v1/fermentation-tanks", {
    inputs: [{ harvestBatchId: harvest.id }],
    tankCode: options.tankCode,
    capacityLiters: 200,
    volumeFilledLiters: 120,
    startDate: `${daysAgo(end + 19)}T14:00:00Z`,
  });
  await member.post(`/v1/fermentation-tanks/${tank.id}/start`, { startedAt: `${daysAgo(end + 18)}T08:00:00Z` });
  await member.post(`/v1/fermentation-tanks/${tank.id}/complete`, {
    endDate: daysAgo(end + 10),
    finalVolumeLiters: 120,
    destination: "SINGANI_DIST",
  });
  const production = await member.post<{ id: string }>("/v1/production-batches/distillation", {
    fermentationTankId: tank.id,
    equipmentIdentifier: `Alambique ${options.tankCode}`,
    processStartDate: daysAgo(end + 9),
    inputVolumeLiters: 120,
  });
  const closed = await member.post<{ lock: { unlockDate: string; released: boolean } }>(
    `/v1/production-batches/${production.id}/close`,
    {
      processEndDate: daysAgo(end),
      cuts: { headsLiters: 2, heartLiters: 15, tailsLiters: 3 },
      heartAbvPercent: 60,
    },
  );
  return {
    lotId: lot.id,
    productionId: production.id,
    unlockDate: closed.lock.unlockDate,
    released: closed.lock.released,
  };
}

/** Embotellado exacto de un lote de `prepareRestingSinganiLot` (22,5 L al 40 %: sin merma). */
export const SMALL_BOTTLING = {
  packagingFormatCl: 75,
  totalBottlesPackaged: 30,
  finalAlcoholAbv: 40,
  waterDilutionLiters: 7.5,
} as const;

/** Caso del contrato de la Ola 2 §18: 18.400 kg → 12.100 L → corazón de 1.500 L al 60 % → 2.950 botellas. */
export const FULL_BOTTLING = {
  packagingFormatCl: 75,
  totalBottlesPackaged: 2950,
  finalAlcoholAbv: 40,
  waterDilutionLiters: 750,
} as const;

export interface BottledLot {
  lotCode: string;
  bottles: number;
  harvestId: string;
  productionId: string;
}

/**
 * Lleva un lote singani **ya creado** (en origen, con su estimación) hasta el embotellado, por la
 * API y con una sola sesión (dirección o enología), con fechas pasadas para que el reposo de 180
 * días ya esté cumplido: pesaje de 18.400 kg hace 205 días, análisis de madurez y dictamen →
 * tanque de 12.100 L, una lectura y fermentación completa con destino singani → destilación cerrada hace 185
 * días (cabezas 120, corazón 1.500 al 60 %, colas 210) → 2.950 botellas de 75 cL al 40 %.
 */
export async function bottleSinganiLot(
  member: ApiClient,
  options: { lotId: string; parcelId: string; tankCode: string },
): Promise<BottledLot> {
  const { lotId } = options;
  const harvest = await member.post<{ id: string }>("/v1/harvest-batches", {
    lotId,
    terroirId: options.parcelId,
    intakeDate: daysAgo(205),
    grossWeightKg: 18500,
    tareWeightKg: 100,
    temperatureAtIntakeC: 18,
  });
  await member.post(`/v1/harvest-batches/${harvest.id}/maturity-analyses`, {
    brixDegrees: 23.5,
    ph: 3.5,
    acidityGl: 5.8,
    measuredAt: `${daysAgo(205)}T15:00:00Z`,
  });
  await member.post(`/v1/harvest-batches/${harvest.id}/phyto-decisions`, {
    decision: "APPROVED",
    decidedAt: `${daysAgo(204)}T12:00:00Z`,
  });
  const tank = await member.post<{ id: string }>("/v1/fermentation-tanks", {
    inputs: [{ harvestBatchId: harvest.id }],
    tankCode: options.tankCode,
    capacityLiters: 15000,
    volumeFilledLiters: 12100,
    startDate: `${daysAgo(204)}T14:00:00Z`,
  });
  await member.post(`/v1/fermentation-tanks/${tank.id}/start`, { startedAt: `${daysAgo(203)}T08:00:00Z` });
  await member.post(`/v1/fermentation-tanks/${tank.id}/logs`, {
    temperatureCelsius: 23.8,
    specificGravity: 1.05,
    recordedAt: `${daysAgo(202)}T09:00:00Z`,
  });
  await member.post(`/v1/fermentation-tanks/${tank.id}/complete`, {
    endDate: daysAgo(195),
    finalVolumeLiters: 12100,
    destination: "SINGANI_DIST",
  });
  const production = await member.post<{ id: string }>("/v1/production-batches/distillation", {
    fermentationTankId: tank.id,
    equipmentIdentifier: `Alambique ${options.tankCode}`,
    processStartDate: daysAgo(194),
    inputVolumeLiters: 12100,
  });
  const closed = await member.post<{ lock: { released: boolean } }>(`/v1/production-batches/${production.id}/close`, {
    processEndDate: daysAgo(185),
    cuts: { headsLiters: 120, heartLiters: 1500, tailsLiters: 210 },
    heartAbvPercent: 60,
  });
  if (!closed.lock.released) throw new Error("El reposo del lote no quedó cumplido tras cerrar la destilación");
  const bottled = await member.post<{ lotCode: string; bottleCodes: { total: number; active: number } }>(
    `/v1/lots/${lotId}/bottling`,
    { ...FULL_BOTTLING, bottlingDate: daysAgo(2) },
  );
  return {
    lotCode: bottled.lotCode,
    bottles: bottled.bottleCodes.active,
    harvestId: harvest.id,
    productionId: production.id,
  };
}

/**
 * Laboratorio conforme (con su informe subido a la bodega) y cierre del expediente de un lote
 * embotellado: el lote queda `CERTIFIED` con su huella; desde la Ola 3, el worker lo ancla.
 */
export async function certifyLot(
  member: ApiClient,
  options: { lotId: string; runId: string; laboratoryName: string },
): Promise<{ hash: string; merkleRoot: string }> {
  const suffix = options.runId.split("-").at(-1) ?? options.runId;
  const laboratoryReportKey = await member.upload(
    {
      name: `informe-${options.runId}.pdf`,
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%E2E informe de laboratorio\n"),
    },
    "lab-reports",
  );
  await member.post(`/v1/lots/${options.lotId}/lab-analyses`, {
    certifiedLaboratoryName: options.laboratoryName,
    accreditedLabCertificationCode: `LAB-E2E-${suffix}`,
    testPerformedAt: daysAgo(1),
    actualAlcoholAbv: 40.05,
    totalAcidityTartaricGl: 4.8,
    volatileAcidityAceticGl: 0.22,
    copperContentMgL: 0.02,
    methanolMg100mlAa: 12,
    laboratoryReportKey,
  });
  const closed = await member.post<{
    status: string;
    hash: string | null;
    bottleCodes: { merkleRoot: string } | null;
  }>(`/v1/lots/${options.lotId}/dossier/close`, { confirm: true });
  if (closed.status !== "CLOSED" || !closed.hash || !closed.bottleCodes) {
    throw new Error(`El expediente no quedó cerrado con huella (estado ${closed.status})`);
  }
  return { hash: closed.hash, merkleRoot: closed.bottleCodes.merkleRoot };
}

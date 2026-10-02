import type { ApiClient, LoginResult } from "./api";
import { daysAgo } from "./dates";
import { tokenFromLink, type Mailbox } from "./mailbox";
import { runTaxId } from "./run-id";

// Bodega propia de una ejecución, preparada por la API (CLAUDE.md, "Limpieza de datos"): alta
// directa por la plataforma, dueña y equipo que aceptan su invitación desde el buzón, parcelas y
// lotes de singani listos para embotellar. Lo usan los recorridos de H2; la limpieza
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

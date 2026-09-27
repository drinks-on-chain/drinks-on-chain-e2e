// Personas de demostración por rol: las de la semilla del backend de desarrollo (README del
// backend, "Datos de demostración"; mismos correos que `@drinks-on-chain/mocks`). Su contraseña es
// SEED_DEMO_PASSWORD y solo llega por E2E_PASSWORD. La suite **no modifica** a estas personas ni a
// sus organizaciones (solo las lee o las usa para actuar sobre datos de la ejecución).

export type PlatformRole = "SUPERADMIN" | "ADMIN" | "OPERATIONS" | "SUPPORT";
export type WineryRole = "OWNER" | "ENOLOGIST" | "AGRONOMIST" | "OPERATOR" | "ACCOUNTANT";

export interface DemoPerson {
  email: string;
  /** Rol en su organización principal. */
  role: PlatformRole | WineryRole | "CONSUMER" | "CASHIER";
  /** Organización principal (nombre visible). */
  organization: string;
  /** Etiqueta del menú de usuario del shell: `<Rol> · <Organización>`. */
  shellLabel?: string;
  /** Personal de plataforma: entra con segundo factor desde la Ola 1 (secreto en E2E_TOTP_SECRET). */
  mfa?: boolean;
  /** Ola desde la que existe en la semilla del backend (consumidor y cajero aún no). */
  availableFrom?: "O4" | "O5";
  note?: string;
}

export const ORG = {
  platform: "Drinks on Chain",
  altos: "Bodega Altos de Calamuchita",
  cinti: "Destilería Cinti Viejo",
  uriondo: "Casa Uriondo",
} as const;

export const PLATFORM = {
  admin: { email: "administracion@drinksonchain.test", role: "ADMIN", organization: ORG.platform, mfa: true },
  operations: { email: "operaciones@drinksonchain.test", role: "OPERATIONS", organization: ORG.platform, mfa: true },
  analyst: {
    email: "analista@drinksonchain.test",
    role: "OPERATIONS",
    organization: ORG.platform,
    mfa: true,
    note: "Sin TOTP inscrito en los mocks (recorrido de inscripción)",
  },
  support: { email: "soporte@drinksonchain.test", role: "SUPPORT", organization: ORG.platform, mfa: true },
} as const satisfies Record<string, DemoPerson>;

export const WINERY = {
  /** Dueño de Altos de Calamuchita (ACTIVE). */
  altosOwner: {
    email: "admin@altos.test",
    role: "OWNER",
    organization: ORG.altos,
    shellLabel: `Dirección · ${ORG.altos}`,
  },
  /** Dueña de Cinti Viejo (ACTIVE). */
  cintiOwner: {
    email: "admin@cintiviejo.test",
    role: "OWNER",
    organization: ORG.cinti,
    shellLabel: `Dirección · ${ORG.cinti}`,
  },
  cintiOperator: { email: "operario@cintiviejo.test", role: "OPERATOR", organization: ORG.cinti },
  /** Contadora con la membresía bloqueada por la plataforma. */
  cintiBlockedAccountant: { email: "contabilidad@cintiviejo.test", role: "ACCOUNTANT", organization: ORG.cinti },
  /** Enóloga en Altos (ACTIVE) y dueña de Casa Uriondo (SUSPENDED): dos organizaciones. */
  sofia: {
    email: "sofia@aramayo.test",
    role: "ENOLOGIST",
    organization: ORG.altos,
    shellLabel: `Enología · ${ORG.altos}`,
    note: `También Dirección · ${ORG.uriondo} (SUSPENDED)`,
  },
} as const satisfies Record<string, DemoPerson>;

export const CONSUMER = {
  maria: { email: "maria@tribu.test", role: "CONSUMER", organization: "", availableFrom: "O4" },
} as const satisfies Record<string, DemoPerson>;

export const CASHIER = {
  laCava: { email: "cajero.lacava@drinksonchain.test", role: "CASHIER", organization: "", availableFrom: "O5" },
} as const satisfies Record<string, DemoPerson>;

/** Parcela de la semilla de Altos de Calamuchita (lista de parcelas del ERP). */
export const ALTOS_PARCEL = /Cuartel 2 · Los Sauces/;

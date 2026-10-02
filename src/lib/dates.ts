// Fechas relativas a hoy para los recorridos de trazabilidad (contrato de la Ola 2 §18): el
// servidor evalúa los candados (reposo, crianza) con el día de calendario de America/La_Paz.

/** Hoy en America/La_Paz, `AAAA-MM-DD`. */
export function laPazToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/La_Paz",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** `ymd` más `days` días de calendario (negativo = antes). */
export function plusDays(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Día de calendario de hace `n` días en La Paz. */
export const daysAgo = (n: number, now: Date = new Date()): string => plusDays(laPazToday(now), -n);

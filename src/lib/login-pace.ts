// El backend limita el inicio de sesión a 10 por minuto y por IP. Un corredor rápido (la CI) los
// roza con los cambios de persona de un recorrido: antes de cada inicio de sesión (por la
// interfaz o por la API) se espera lo justo para no pasar de `MAX` en `WINDOW_MS`. Solo cuenta los
// de este proceso; el margen hasta 10 cubre los de un worker anterior.

const WINDOW_MS = 65_000;
const MAX = 7;
const recent: number[] = [];

/** Milisegundos que hay que esperar antes del siguiente inicio de sesión (0 si cabe ya). */
export function loginWaitMs(history: readonly number[], now: number, max = MAX, windowMs = WINDOW_MS): number {
  const inWindow = history.filter((at) => now - at < windowMs);
  if (inWindow.length < max) return 0;
  const oldest = inWindow[inWindow.length - max] ?? now;
  return windowMs - (now - oldest) + 500;
}

/** Espera, si hace falta, y anota un inicio de sesión. */
export async function paceLogin(): Promise<void> {
  const wait = loginWaitMs(recent, Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const now = Date.now();
  while (recent.length > 0 && now - (recent[0] ?? now) >= WINDOW_MS) recent.shift();
  recent.push(now);
}

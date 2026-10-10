// Consulta periódica con tope: para lo que tarda segundos en confirmarse fuera de la suite (una
// transacción en la red, una tarea del worker). Sin `waitForTimeout` de Playwright: no depende de
// ninguna página.

export interface PollOptions<T> {
  /** Qué se espera, para el mensaje del tope ("identidad ACTIVE de la bodega"). */
  what: string;
  timeoutMs: number;
  /** Pausa entre consultas (por defecto 3 s). */
  intervalMs?: number;
  /** Resumen del último valor leído, para el mensaje del tope. Nunca datos de sesión. */
  describe?: (last: T) => string;
  /** Corta la espera con un error si el valor ya no puede cumplirse (p. ej. una emisión `FAILED`). */
  failed?: (last: T) => string | null;
  /** Reloj y pausa inyectables (pruebas unitarias). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Repite `read` hasta que `done` lo acepta y devuelve ese valor. Al llegar al tope lanza un error
 * con lo que se esperaba, cuánto se esperó y el último valor leído (o el último error de lectura).
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options: PollOptions<T>,
): Promise<T> {
  const { what, timeoutMs, intervalMs = 3_000, describe, failed } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const startedAt = now();
  let last: { value: T } | null = null;
  let lastError: string | null = null;
  for (;;) {
    try {
      const value = await read();
      last = { value };
      lastError = null;
      if (done(value)) return value;
      const reason = failed?.(value);
      if (reason) throw new PollAborted(`${what}: ${reason}`);
    } catch (error) {
      if (error instanceof PollAborted) throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (now() - startedAt >= timeoutMs) break;
    await sleep(intervalMs);
  }
  const seen = lastError
    ? `última lectura con error: ${lastError}`
    : last
      ? `último valor: ${describe ? describe(last.value) : JSON.stringify(last.value)}`
      : "sin lecturas";
  throw new Error(`${what}: no se cumplió en ${Math.round(timeoutMs / 1000)} s (${seen})`);
}

/** La espera se cortó porque el valor ya no puede cumplirse. */
export class PollAborted extends Error {}

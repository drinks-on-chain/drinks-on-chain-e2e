import { describe, expect, it } from "vitest";
import { PollAborted, pollUntil } from "./poll";

/** Reloj simulado: cada pausa adelanta el tiempo. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

describe("pollUntil", () => {
  it("devuelve el primer valor aceptado", async () => {
    const values = ["PROVISIONING", "PROVISIONING", "ACTIVE"];
    let reads = 0;
    const result = await pollUntil(
      () => Promise.resolve(values[reads++] ?? "ACTIVE"),
      (v) => v === "ACTIVE",
      { what: "identidad", timeoutMs: 60_000, ...clock() },
    );
    expect(result).toBe("ACTIVE");
    expect(reads).toBe(3);
  });

  it("al llegar al tope dice qué esperaba, cuánto y el último valor", async () => {
    await expect(
      pollUntil(
        () => Promise.resolve({ status: "SUBMITTED" }),
        (v) => v.status === "CONFIRMED",
        { what: "emisión confirmada", timeoutMs: 9_000, intervalMs: 3_000, describe: (v) => v.status, ...clock() },
      ),
    ).rejects.toThrow("emisión confirmada: no se cumplió en 9 s (último valor: SUBMITTED)");
  });

  it("un error de lectura no corta la espera, y se cuenta si es lo último que hubo", async () => {
    let reads = 0;
    const flaky = () => (reads++ === 0 ? Promise.reject(new Error("503")) : Promise.resolve("ok"));
    await expect(pollUntil(flaky, (v) => v === "ok", { what: "x", timeoutMs: 10_000, ...clock() })).resolves.toBe("ok");
    await expect(
      pollUntil(
        () => Promise.reject(new Error("GET /v1/x → 404")),
        () => true,
        { what: "ruta", timeoutMs: 3_000, ...clock() },
      ),
    ).rejects.toThrow("última lectura con error: GET /v1/x → 404");
  });

  it("corta en cuanto el valor ya no puede cumplirse", async () => {
    let reads = 0;
    await expect(
      pollUntil(
        () => {
          reads += 1;
          return Promise.resolve("FAILED");
        },
        (v) => v === "CONFIRMED",
        {
          what: "emisión",
          timeoutMs: 60_000,
          failed: (v) => (v === "FAILED" ? "la red la rechazó" : null),
          ...clock(),
        },
      ),
    ).rejects.toBeInstanceOf(PollAborted);
    expect(reads).toBe(1);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { currentRunId, isRunId, newRunId, runEmail, runName, runTaxId, runWineryName } from "./run-id";

describe("run-id", () => {
  const saved = process.env.E2E_RUN_ID;
  afterEach(() => {
    if (saved === undefined) delete process.env.E2E_RUN_ID;
    else process.env.E2E_RUN_ID = saved;
  });

  it("forma e2e-<fecha UTC>-<aleatorio> y distinto en cada llamada", () => {
    const id = newRunId(new Date("2026-09-27T16:30:45Z"));
    expect(id).toMatch(/^e2e-20260927t1630-[a-z0-9]{6}$/);
    expect(isRunId(id)).toBe(true);
    expect(newRunId()).not.toBe(newRunId());
  });

  it("se comparte por E2E_RUN_ID y rechaza valores sin la forma", () => {
    delete process.env.E2E_RUN_ID;
    const id = currentRunId();
    expect(process.env.E2E_RUN_ID).toBe(id);
    expect(currentRunId()).toBe(id);
    process.env.E2E_RUN_ID = "cualquier-cosa";
    expect(() => currentRunId()).toThrow(/E2E_RUN_ID/);
  });

  it("correos, nombres y NIT con el prefijo", () => {
    const id = "e2e-20260927t1630-abcd";
    expect(runEmail(id, "Dueña")).toBe("duena+e2e-20260927t1630-abcd@example.test");
    expect(runEmail(id, "enologa")).toBe("enologa+e2e-20260927t1630-abcd@example.test");
    expect(() => runEmail(id, "¿?")).toThrow(/vacío/);
    expect(runName(id, "Bodega Norte")).toBe("Bodega Norte · e2e-20260927t1630-abcd");
    expect(runTaxId(id)).toMatch(/^9\d{9}$/);
    expect(runTaxId(id, "a")).not.toBe(runTaxId(id, "b"));
    expect(runTaxId(id, "a")).toBe(runTaxId(id, "a"));
  });
  it("nombre de bodega con tres palabras cuyas iniciales cambian con la ejecución", () => {
    expect(runWineryName("e2e-20261002t1506-567801")).toBe("Destilería Isla Alba Brisa · e2e-20261002t1506-567801");
    expect(runWineryName("e2e-20260927t1630-k3v9q2", "Bodega")).toBe(
      "Bodega Jara Quebrada Cumbre · e2e-20260927t1630-k3v9q2",
    );
    const initials = (name: string) =>
      name
        .split(" ")
        .slice(1, 4)
        .map((w) => w[0])
        .join("");
    expect(initials(runWineryName("e2e-20261002t1506-567801"))).toBe("IAB");
    expect(initials(runWineryName("e2e-20261002t1506-567802"))).toBe("IAC");
    // Otra bodega de la misma ejecución: iniciales y nombre distintos.
    expect(runWineryName("e2e-20261002t1506-567801", "Bodega", 1)).toBe(
      "Bodega Jara Brisa Cumbre · e2e-20261002t1506-567801",
    );
    expect(initials(runWineryName("e2e-20261002t1506-567801", "Destilería", 3))).toBe("LDE");
  });
});

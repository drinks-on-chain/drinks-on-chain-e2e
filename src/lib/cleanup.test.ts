import { describe, expect, it } from "vitest";
import type { ApiResult } from "./api";
import { discardRunLots, isRunWinery, retireRunWineries, type CleanupClient } from "./cleanup";

const RUN = "e2e-20261002t1500-abc123";
const OTHER = "e2e-20261002t1500-abc124";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Cliente de mentira: listas paginadas fijas y un registro de las escrituras. */
function fakeClient(
  lists: Record<string, unknown[]>,
  write: (call: Call) => { status: number; code?: string } = () => ({ status: 200 }),
) {
  const calls: Call[] = [];
  function get<T>(path: string): Promise<T> {
    const items = lists[path];
    if (!items) return Promise.reject(new Error(`GET inesperado: ${path}`));
    return Promise.resolve({ items, total: items.length, limit: 100, offset: 0 } as T);
  }
  function raw<T>(method: string, path: string, options?: { body?: unknown }): Promise<ApiResult<T>> {
    const call = { method, path, body: options?.body };
    calls.push(call);
    const { status, code } = write(call);
    return Promise.resolve({
      status,
      ok: status < 400,
      data: undefined,
      error: code ? { code, message: code } : undefined,
      headers: {},
    });
  }
  const client: CleanupClient = { get, raw };
  return { client, calls };
}

describe("isRunWinery", () => {
  it("solo el nombre que termina en « · <runId>»", () => {
    expect(isRunWinery(`Bodega Norte · ${RUN}`, RUN)).toBe(true);
    expect(isRunWinery(`Bodega Norte · ${OTHER}`, RUN)).toBe(false);
    expect(isRunWinery("Destilería Cinti Viejo", RUN)).toBe(false);
    expect(isRunWinery(`${RUN} · Bodega`, RUN)).toBe(false);
  });
});

describe("retireRunWineries", () => {
  const wineries = [
    { id: "w-activa", tradeName: `Bodega Norte · ${RUN}`, status: "ACTIVE" },
    { id: "w-invitada", tradeName: `Bodega Sur · ${RUN}`, status: "INVITED" },
    { id: "w-revocada", tradeName: `Bodega Este · ${RUN}`, status: "REVOKED" },
    { id: "w-otra", tradeName: `Bodega Norte · ${OTHER}`, status: "ACTIVE" },
    { id: "w-semilla", tradeName: "Destilería Cinti Viejo", status: "ACTIVE" },
  ];

  it("revoca con motivo las bodegas de la ejecución y no toca las demás", async () => {
    const { client, calls } = fakeClient({
      "/v1/platform/wineries": wineries,
      "/v1/public/wineries": [{ slug: "destileria-cinti-viejo", tradeName: "Destilería Cinti Viejo" }],
    });
    const result = await retireRunWineries(client, RUN, "Fin del recorrido");
    expect(calls).toEqual([
      { method: "POST", path: "/v1/platform/wineries/w-activa/revoke", body: { reason: "Fin del recorrido" } },
      { method: "POST", path: "/v1/platform/wineries/w-invitada/revoke", body: { reason: "Fin del recorrido" } },
    ]);
    expect(result).toEqual({
      revoked: [`Bodega Norte · ${RUN}`, `Bodega Sur · ${RUN}`],
      alreadyRevoked: [`Bodega Este · ${RUN}`],
      stillPublic: [],
    });
  });

  it("devuelve las bodegas de la ejecución que siguen en la lista pública", async () => {
    const { client } = fakeClient({
      "/v1/platform/wineries": [],
      "/v1/public/wineries": [
        { slug: "norte", tradeName: `Bodega Norte · ${RUN}` },
        { slug: "altos", tradeName: "Bodega Altos de Calamuchita" },
      ],
    });
    expect((await retireRunWineries(client, RUN, "Fin del recorrido")).stillPublic).toEqual([`Bodega Norte · ${RUN}`]);
  });

  it("falla si la API no deja revocar una bodega", async () => {
    const { client } = fakeClient({ "/v1/platform/wineries": wineries, "/v1/public/wineries": [] }, () => ({
      status: 403,
      code: "AUTH_INSUFFICIENT_PERMISSIONS",
    }));
    await expect(retireRunWineries(client, RUN, "Fin del recorrido")).rejects.toThrow(
      /No se pudo revocar la bodega Bodega Norte .* 403 AUTH_INSUFFICIENT_PERMISSIONS/,
    );
  });
});

describe("discardRunLots", () => {
  const lots = [
    { id: "l-abierto", name: `Singani Gran Reserva 2026 · ${RUN}`, stage: "RESTING", lotCode: null },
    {
      id: "l-cerrado",
      name: `Singani Gran Reserva 2026 · ${RUN}`,
      stage: "CERTIFIED",
      lotCode: "CVJ-2026-SINGANI-009",
    },
    { id: "l-descartado", name: `Otro · ${RUN}`, stage: "DISCARDED", lotCode: null },
    { id: "l-semilla", name: "CVJ-2026-SINGANI-001", stage: "BOTTLED", lotCode: "CVJ-2026-SINGANI-001" },
  ];

  it("descarta los lotes abiertos de la ejecución y deja los de expediente cerrado", async () => {
    const { client, calls } = fakeClient({ "/v1/lots": lots });
    const result = await discardRunLots(client, RUN, "Limpieza");
    expect(calls).toEqual([{ method: "POST", path: "/v1/lots/l-abierto/discard", body: { reason: "Limpieza" } }]);
    expect(result).toEqual({
      discarded: [`Singani Gran Reserva 2026 · ${RUN}`],
      kept: [`Singani Gran Reserva 2026 · ${RUN} (CVJ-2026-SINGANI-009)`],
    });
  });

  it("un 409 de la API (lote terminal) cuenta como conservado", async () => {
    const { client } = fakeClient({ "/v1/lots": lots.slice(0, 1) }, () => ({ status: 409, code: "TRC_LOT_TERMINAL" }));
    expect(await discardRunLots(client, RUN, "Limpieza")).toEqual({
      discarded: [],
      kept: [`Singani Gran Reserva 2026 · ${RUN}`],
    });
  });
});

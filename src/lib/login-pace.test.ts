import { describe, expect, it } from "vitest";
import { loginWaitMs } from "./login-pace";

describe("ritmo de inicios de sesión", () => {
  const now = 1_000_000;

  it("no espera mientras quepan en la ventana", () => {
    expect(loginWaitMs([], now)).toBe(0);
    expect(loginWaitMs([now - 5_000, now - 4_000, now - 3_000], now, 4)).toBe(0);
  });

  it("los de fuera de la ventana no cuentan", () => {
    expect(loginWaitMs([now - 70_000, now - 66_000, now - 1_000], now, 2)).toBe(0);
  });

  it("con la ventana llena, espera a que salga el más antiguo que estorba", () => {
    // Tres en la ventana y caben dos: hay que esperar a que salga el segundo más antiguo.
    expect(loginWaitMs([now - 60_000, now - 30_000, now - 1_000], now, 2)).toBe(65_000 - 30_000 + 500);
    expect(loginWaitMs([now - 60_000, now - 1_000], now, 2)).toBe(65_000 - 60_000 + 500);
  });
});

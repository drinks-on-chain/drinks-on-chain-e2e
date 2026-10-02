import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { base32Decode, freshTotp, hotp, readSharedStep, sharedTotpFile, totp, totpRemainingMs } from "./totp";

// Vectores de RFC 4226 (apéndice D) y RFC 6238 (apéndice B, SHA-1) con el secreto ASCII
// "12345678901234567890", cuyo base32 es GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
const SECRET_ASCII = "12345678901234567890";
const SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  it("decodifica base32 con espacios, minúsculas y relleno", () => {
    expect(base32Decode(SECRET_B32).toString("ascii")).toBe(SECRET_ASCII);
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq====").toString("ascii")).toBe(SECRET_ASCII);
    expect(() => base32Decode("ABC1")).toThrow(/no válido/);
    expect(() => base32Decode("  ")).toThrow(/vacío/);
  });

  it("HOTP cumple los vectores de RFC 4226", () => {
    const key = Buffer.from(SECRET_ASCII, "ascii");
    expect([0, 1, 2, 3, 9].map((c) => hotp(key, c))).toEqual(["755224", "287082", "359152", "969429", "520489"]);
  });

  it("TOTP cumple los vectores de RFC 6238 (8 dígitos, SHA-1)", () => {
    expect(totp(SECRET_B32, 59_000, 8)).toBe("94287082");
    expect(totp(SECRET_B32, 1_111_111_109_000, 8)).toBe("07081804");
    expect(totp(SECRET_B32, 1_234_567_890_000, 8)).toBe("89005924");
    expect(totp(SECRET_B32, 20_000_000_000_000, 8)).toBe("65353130");
  });

  it("6 dígitos por defecto y el mismo código dentro del paso de 30 s", () => {
    expect(totp(SECRET_B32, 59_000)).toBe("287082");
    expect(totp(SECRET_B32, 30_000)).toBe(totp(SECRET_B32, 59_999));
    expect(totpRemainingMs(59_000)).toBe(1_000);
  });
});

describe("freshTotp", () => {
  it("no repite un código ya entregado para el mismo secreto", async () => {
    vi.useFakeTimers({ now: 60_000 });
    try {
      const first = await freshTotp(SECRET_B32);
      expect(first).toBe(totp(SECRET_B32, 60_000));
      const second = freshTotp(SECRET_B32);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await second).toBe(totp(SECRET_B32, 90_200));
      expect(await second).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no repite el código del secreto de demostración que otro proceso de la ejecución ya usó en este paso", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-totp-"));
    const file = join(dir, "paso.json");
    const saved = { secret: process.env.E2E_TOTP_SECRET, file: process.env.E2E_TOTP_STATE_FILE };
    const DEMO = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    process.env.E2E_TOTP_SECRET = DEMO;
    process.env.E2E_TOTP_STATE_FILE = file;
    vi.useFakeTimers({ now: 600_000 });
    try {
      expect(sharedTotpFile()).toBe(file);
      expect(readSharedStep(file)).toBe(-1);
      // Otro proceso entregó el código del paso actual (600 s / 30 s = paso 20).
      writeFileSync(file, JSON.stringify({ step: 20 }));
      const pending = freshTotp(DEMO);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await pending).toBe(totp(DEMO, 630_200));
      expect(readSharedStep(file)).toBe(21);
      // Un secreto que no es el de demostración (el de una persona de la ejecución) no usa el archivo.
      expect(await freshTotp(SECRET_B32)).toBe(totp(SECRET_B32, 630_200));
      expect(readSharedStep(file)).toBe(21);
    } finally {
      vi.useRealTimers();
      if (saved.secret === undefined) delete process.env.E2E_TOTP_SECRET;
      else process.env.E2E_TOTP_SECRET = saved.secret;
      if (saved.file === undefined) delete process.env.E2E_TOTP_STATE_FILE;
      else process.env.E2E_TOTP_STATE_FILE = saved.file;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

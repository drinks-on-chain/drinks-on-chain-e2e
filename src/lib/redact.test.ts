import { describe, expect, it } from "vitest";
import { REDACTED, redact, registerSecret } from "./redact";

const env = { E2E_PASSWORD: "Contraseña-Demo-2026!", E2E_TOTP_SECRET: "JBSWY3DPEHPK3PXPJBSWY3DP" };

describe("redact", () => {
  it("quita los valores exactos de E2E_PASSWORD y E2E_TOTP_SECRET", () => {
    const out = redact(`login con Contraseña-Demo-2026! y TOTP JBSWY3DPEHPK3PXPJBSWY3DP`, env);
    expect(out).not.toContain(env.E2E_PASSWORD);
    expect(out).not.toContain(env.E2E_TOTP_SECRET);
    expect(out).toContain(REDACTED);
  });

  it("quita tokens de sesión, cookies y JWT", () => {
    const out = redact(
      "Authorization: Bearer abc.def-123 · Set-Cookie: doc_rt=1f2e.3.xyz; HttpOnly · eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_x",
      {},
    );
    expect(out).toBe(`Authorization: Bearer ${REDACTED} · Set-Cookie: doc_rt=${REDACTED}; HttpOnly · ${REDACTED}`);
  });

  it("quita campos JSON de tokens, secretos y contraseñas", () => {
    const body = '{"mfaToken":"Q2hhbGx","secret":"ABCDEF","password":"x1","email":"a@b.test","code":"123456"}';
    const out = redact(body, {});
    expect(out).toContain('"email":"a@b.test"');
    for (const v of ["Q2hhbGx", "ABCDEF", '"x1"', "123456"]) expect(out).not.toContain(v);
  });

  it("quita enlaces con token=, de invitación y otpauth", () => {
    const out = redact(
      "Verifica en https://bodegas.test/unirse/verificar?token=abc%2B1 o acepta https://erp.test/invitacion/tok_123 " +
        "(ruta /invitacion/tok_456) · otpauth://totp/DoC:ops?secret=JBSWY3DPEHPK3PXP · ?token=zzz&x=1",
      {},
    );
    for (const v of ["abc%2B1", "tok_123", "tok_456", "JBSWY3DPEHPK3PXP", "zzz"]) expect(out).not.toContain(v);
    expect(out).toContain("&x=1");
  });

  it("quita secretos TOTP en base32, códigos de recuperación y contraseñas generadas", () => {
    const out = redact("clave KRSXG5CTMVRXEZLU codigos 1A2B-3C4D y ABCDE-12345 · Pw-e2e-9f8e7d6c5b4a", {});
    for (const v of ["KRSXG5CTMVRXEZLU", "1A2B-3C4D", "ABCDE-12345", "Pw-e2e-9f8e7d6c5b4a"]) {
      expect(out).not.toContain(v);
    }
  });

  it("quita secretos registrados en tiempo de ejecución", () => {
    registerSecret("valor-generado-xyz");
    expect(redact("usa valor-generado-xyz aquí", {})).toBe(`usa ${REDACTED} aquí`);
  });

  it("deja intacto lo que no es secreto", () => {
    const text =
      "H1 › soporte bloquea al operario · 401 /api/v1/users/me · CVJ-2026-SINGANI-001 · 2026-09-27T16:30 · " +
      "duena+e2e-20260927t1630-abcd@example.test · Bodega Norte · e2e-20260927t1630-abcd · VALIDATION_ERROR";
    expect(redact(text, env)).toBe(text);
  });
});

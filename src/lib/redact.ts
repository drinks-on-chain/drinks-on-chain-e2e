// Filtro de secretos para todo lo que sale de una ejecución (resumen publicado como artefacto y
// salida de consola en CI). Regla del repo: ningún artefacto con datos de sesión.
//
// Elimina: los valores exactos de E2E_PASSWORD y E2E_TOTP_SECRET (y los que se registren con
// `registerSecret`), contraseñas generadas por la suite (`Pw-e2e-…`), `Bearer …`, cookies
// `doc_rt=…`, JWT, campos JSON de tokens y secretos, URL `otpauth://`, enlaces con `token=`,
// enlaces de invitación (`/invitacion/<token>`), secretos TOTP (base32 de 16 o más) y códigos de
// recuperación.

export const REDACTED = "[oculto]";

const registered = new Set<string>();

/** Añade un valor que debe ocultarse (p. ej. un secreto generado en tiempo de ejecución). */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 4) registered.add(value);
}

function envSecrets(env: NodeJS.ProcessEnv): string[] {
  return [env.E2E_PASSWORD, env.E2E_TOTP_SECRET].filter((v): v is string => !!v && v.length >= 4);
}

const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PATTERNS: [RegExp, string][] = [
  // URL con token en la query o de invitación: se oculta la URL entera.
  [/\bhttps?:\/\/[^\s"'<>)]*(?:[?&](?:token|mfaToken)=|\/invitacion\/)[^\s"'<>)]*/gi, `<enlace ${REDACTED}>`],
  [/([?&](?:token|mfaToken)=)[^&\s"'<>)]+/gi, `$1${REDACTED}`],
  [/(\/invitacion\/)[^\s"'<>)?/]+/gi, `$1${REDACTED}`],
  [/otpauth:\/\/[^\s"'<>)]+/gi, `otpauth://${REDACTED}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`],
  [/\bdoc_rt=[^;\s"',]+/g, `doc_rt=${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, REDACTED],
  [
    /("(?:accessToken|refreshToken|mfaToken|token|secret|password|currentPassword|newPassword|code|captchaToken|otpauthUrl)"\s*:\s*)"[^"]*"/gi,
    `$1"${REDACTED}"`,
  ],
  [/\bPw-e2e-[A-Za-z0-9]+/g, REDACTED],
  // Secretos TOTP (base32, 16 o más) y códigos de recuperación (XXXX-XXXX / XXXXX-XXXXX).
  [/\b[A-Z2-7]{16,}={0,6}(?![A-Za-z0-9])/g, REDACTED],
  [/\b[0-9A-Z]{4,5}-[0-9A-Z]{4,5}\b(?!-)/g, REDACTED],
];

/** Devuelve `text` sin secretos. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  const exact = [...envSecrets(env), ...registered].sort((a, b) => b.length - a.length);
  for (const value of exact) out = out.replace(new RegExp(escape(value), "g"), REDACTED);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

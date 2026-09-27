import { describe, expect, it } from "vitest";
import {
  Mailbox,
  encodeQueryValue,
  extractLinks,
  firstLink,
  tokenFromLink,
  transportFromEnv,
  type MailSummary,
  type MailpitTransport,
} from "./mailbox";

const summary = (id: string, to: string, subject: string, created: string): MailSummary => ({
  ID: id,
  From: { Name: "Drinks on Chain", Address: "no-reply@dev.drinksonchain.local" },
  To: [{ Name: "", Address: to }],
  Subject: subject,
  Created: created,
});

/** Transporte en memoria que imita las rutas de Mailpit que usa el buzón. */
function fakeTransport(messages: MailSummary[], canDelete = true) {
  const calls: string[] = [];
  const deleted: string[][] = [];
  const transport: MailpitTransport = {
    kind: canDelete ? "ssh-curl" : "ssh-api",
    get: (path) => {
      calls.push(path);
      if (path.startsWith("/api/v1/message/")) {
        const id = path.split("/").pop();
        const m = messages.find((x) => x.ID === id);
        return Promise.resolve({ ...m, Text: `Acepta: https://erp.test/invitacion/tok-${id ?? ""}`, HTML: "" });
      }
      return Promise.resolve({ total: messages.length, messages });
    },
    deleteIds: canDelete
      ? (ids) => {
          deleted.push(ids);
          return Promise.resolve();
        }
      : null,
    deleteAll: () => Promise.resolve(),
  };
  return { transport, calls, deleted };
}

describe("encodeQueryValue", () => {
  it("solo deja caracteres que admite el comando forzado del servidor", () => {
    const encoded = encodeQueryValue('to:"duena+e2e-20260927t1630-abcd@example.test"');
    expect(encoded).toBe("to%3A%22duena%2Be2e-20260927t1630-abcd%40example.test%22");
    expect(`/api/v1/search?query=${encoded}`).toMatch(/^\/api\/v1\/[A-Za-z0-9/_.?=&%-]*$/);
    expect(encodeQueryValue("ñ (x)!")).toBe("%C3%B1%20%28x%29%21");
  });
});

describe("enlaces", () => {
  const message = {
    HTML: '<p><img src="https://cdn.test/logo.png"><a href="https://erp.test/invitacion/abc?x=1&amp;y=2">Aceptar</a> <a href="mailto:hola@x.test">x</a></p>',
    Text: "Abre https://erp.test/invitacion/abc?x=1&y=2.\nO https://bodegas.test/unirse/verificar?token=t%2B1, gracias",
  };

  it("extrae los href del HTML y las URL del texto, sin duplicados ni puntuación final", () => {
    expect(extractLinks(message)).toEqual([
      "https://erp.test/invitacion/abc?x=1&y=2",
      "https://bodegas.test/unirse/verificar?token=t%2B1",
    ]);
  });

  it("primer enlace, o el primero que cumple un patrón", () => {
    expect(firstLink(message)).toBe("https://erp.test/invitacion/abc?x=1&y=2");
    expect(firstLink(message, /verificar/)).toContain("/unirse/verificar");
    expect(() => firstLink({ HTML: "", Text: "sin enlaces" })).toThrow(/ningún enlace/);
  });

  it("token del parámetro o del último segmento", () => {
    expect(tokenFromLink("https://bodegas.test/unirse/verificar?token=t%2B1")).toBe("t+1");
    expect(tokenFromLink("https://erp.test/invitacion/abc%3D")).toBe("abc=");
  });
});

describe("Mailbox", () => {
  const run = "e2e-20260927t1630-abcd";
  const owner = `duena+${run}@example.test`;
  const messages = [
    summary("m3", owner, "Te invitan a Bodega X", "2026-09-27T16:40:00Z"),
    summary("m2", `otra+${run}@example.test`, "Te invitan", "2026-09-27T16:39:00Z"),
    summary("m1", owner, "Verifica tu correo", "2026-09-27T16:30:00Z"),
    summary("m0", "dev@example.test", "Correo de prueba", "2026-09-27T12:54:00Z"),
  ];

  it("espera el correo del destinatario exacto con asunto y fecha, y da su enlace", async () => {
    const { transport, calls } = fakeTransport(messages);
    const box = new Mailbox(transport, run);
    const mail = await box.waitFor(owner, { subject: /Verifica/, timeoutMs: 0 });
    expect(mail.ID).toBe("m1");
    expect(calls[0]).toMatch(/^\/api\/v1\/search\?query=to%3A%22duena%2B/);
    const link = await box.waitForLink(owner, { since: new Date("2026-09-27T16:35:00Z"), timeoutMs: 0 });
    expect(link).toBe("https://erp.test/invitacion/tok-m3");
  });

  it("falla con un mensaje claro si no llega", async () => {
    const box = new Mailbox(fakeTransport(messages).transport, run);
    await expect(box.waitFor("nadie@example.test", { timeoutMs: 0 })).rejects.toThrow(/No llegó ningún correo/);
  });

  it("borra solo los correos de la ejecución cuando el transporte lo permite", async () => {
    const { transport, deleted } = fakeTransport(messages);
    expect(await new Mailbox(transport, run).cleanupRun()).toEqual({ deleted: 3, skipped: false });
    expect(deleted).toEqual([["m3", "m2", "m1"]]);
  });

  it("con la llave restringida no borra nada", async () => {
    const { transport } = fakeTransport(messages, false);
    expect(await new Mailbox(transport, run).cleanupRun()).toEqual({ deleted: 0, skipped: true });
  });
});

describe("transportFromEnv", () => {
  it("elige el transporte por las variables", () => {
    expect(transportFromEnv({})).toBeNull();
    expect(transportFromEnv({ E2E_MAILPIT_URL: "http://127.0.0.1:8025" })?.kind).toBe("http");
    expect(transportFromEnv({ E2E_MAILPIT_SSH: "srv" })?.kind).toBe("ssh-curl");
    const api = transportFromEnv({ E2E_MAILPIT_SSH: "srv", E2E_MAILPIT_SSH_MODE: "api" });
    expect(api?.kind).toBe("ssh-api");
    expect(api?.deleteIds).toBeNull();
  });
});

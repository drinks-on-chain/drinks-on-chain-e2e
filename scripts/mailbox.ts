/**
 * Consulta y limpieza del buzón de Mailpit del entorno (mismo transporte que las pruebas):
 *
 *   pnpm mailbox list [correo]        # últimos correos (o los de un destinatario)
 *   pnpm mailbox cleanup <runId>      # borra los correos de una ejecución (si el transporte puede)
 *   pnpm mailbox purge --yes          # vacía el buzón ENTERO: solo como limpieza final explícita
 */
import { MAILBOX_HELP, Mailbox, transportFromEnv } from "../src/lib/mailbox";
import { isRunId } from "../src/lib/run-id";

async function main() {
  const [command, arg] = process.argv.slice(2);
  const transport = transportFromEnv();
  if (!transport) throw new Error(MAILBOX_HELP);

  switch (command) {
    case "list": {
      const box = new Mailbox(transport);
      const messages = arg ? await box.listFor(arg) : await box.list(30);
      for (const m of messages) {
        console.log(`${m.Created}  ${m.ID}  ${(m.To ?? []).map((t) => t.Address).join(", ")}  «${m.Subject}»`);
      }
      console.log(`${messages.length} correo(s) · transporte ${transport.kind}`);
      return;
    }
    case "cleanup": {
      if (!arg || !isRunId(arg)) throw new Error("Indica el prefijo de la ejecución: pnpm mailbox cleanup e2e-…");
      const result = await new Mailbox(transport, arg).cleanupRun();
      console.log(
        result.skipped
          ? `El transporte ${transport.kind} no puede borrar correos sueltos: no se borró nada.`
          : `${result.deleted} correo(s) de ${arg} borrados.`,
      );
      return;
    }
    case "purge": {
      if (arg !== "--yes") throw new Error("Vacía el buzón entero: confírmalo con pnpm mailbox purge --yes");
      await transport.deleteAll();
      console.log("Buzón vaciado.");
      return;
    }
    default:
      console.log("Uso: pnpm mailbox list [correo] · cleanup <runId> · purge --yes");
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

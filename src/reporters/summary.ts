import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { FullResult, Reporter, Suite, TestCase, TestResult, TestStep } from "@playwright/test/reporter";
import { redact } from "../lib/redact";

// Único informe que sale de una ejecución: texto propio (prueba, paso, mensaje de error) pasado
// por `redact`. Se imprime en la consola (en CI es pública) y se escribe en E2E_SUMMARY_DIR
// (`e2e-summary/`: resumen.md y resumen.json), que es lo único que sube el workflow. Nunca incluye
// trazas, capturas, vídeos ni el árbol de accesibilidad: ningún artefacto con datos de sesión.

interface Entry {
  project: string;
  title: string;
  status: TestResult["status"];
  durationMs: number;
  step: string | null;
  errors: string[];
  annotations: string[];
}

// eslint-disable-next-line no-control-regex -- secuencias ANSI de color de Playwright
const ANSI = /\u001b\[[0-9;]*m/g;
const clean = (text: string) => redact(text.replace(ANSI, "")).trim();
const MAX_ERROR = 1_500;

/** Paso de usuario (`test.step`) más profundo que falló. */
function failedStep(steps: TestStep[]): string | null {
  for (const step of steps) {
    if (!step.error) continue;
    const inner = failedStep(step.steps);
    if (inner) return inner;
    if (step.category === "test.step") return step.title;
  }
  return null;
}

const ICON: Record<TestResult["status"], string> = {
  passed: "✓",
  failed: "✘",
  timedOut: "✘",
  skipped: "-",
  interrupted: "!",
};

export default class SummaryReporter implements Reporter {
  private readonly entries: Entry[] = [];
  private readonly dir = process.env.E2E_SUMMARY_DIR || "e2e-summary";
  private rootDir = process.cwd();

  printsToStdio() {
    return true;
  }

  onBegin(config: { rootDir: string }, suite: Suite) {
    this.rootDir = config.rootDir;
    console.log(`Recorridos: ${suite.allTests().length} prueba(s)`);
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const project = test.parent.project()?.name ?? "";
    const title = clean(test.titlePath().slice(3).join(" › ") || test.title);
    const errors = result.errors.map((e) => {
      const where = e.location ? ` (${relative(this.rootDir, e.location.file)}:${e.location.line})` : "";
      return clean(e.message ?? e.value ?? "error").slice(0, MAX_ERROR) + where;
    });
    // En Playwright 1.63 las anotaciones de ejecución están en las dos listas: sin duplicados.
    const annotations = [
      ...new Set([...test.annotations, ...result.annotations].map((a) => clean(`${a.type}: ${a.description ?? ""}`))),
    ];
    const entry: Entry = {
      project,
      title,
      status: result.status,
      durationMs: result.duration,
      step: result.status === "passed" ? null : failedStep(result.steps),
      errors,
      annotations,
    };
    this.entries.push(entry);
    console.log(`  ${ICON[result.status]} [${project}] ${title} (${(result.duration / 1000).toFixed(1)} s)`);
    if (entry.step) console.log(`      paso: ${clean(entry.step)}`);
    for (const error of errors) console.log(error.replace(/^/gm, "      "));
  }

  onEnd(result: FullResult) {
    const count = (s: TestResult["status"]) => this.entries.filter((e) => e.status === s).length;
    const totals = `${count("passed")} en verde · ${count("failed") + count("timedOut")} con fallo · ${count("skipped")} saltadas`;
    console.log(`Resultado: ${result.status} · ${totals}`);

    const lines = [
      `# Resumen E2E · ${process.env.E2E_RUN_ID ?? ""}`,
      "",
      `Resultado: **${result.status}** · ${totals}`,
      "",
    ];
    for (const e of this.entries) {
      lines.push(
        `- ${ICON[e.status]} **[${e.project}] ${e.title}** · ${e.status} · ${(e.durationMs / 1000).toFixed(1)} s`,
      );
      if (e.step) lines.push(`  - Paso: ${e.step}`);
      for (const a of e.annotations) lines.push(`  - ${a}`);
      for (const err of e.errors) lines.push("", "  ```", ...err.split("\n").map((l) => `  ${l}`), "  ```");
    }
    mkdirSync(this.dir, { recursive: true });
    // Segunda pasada del filtro sobre el documento completo, por si algo se unió entre líneas.
    writeFileSync(join(this.dir, "resumen.md"), `${redact(lines.join("\n"))}\n`);
    writeFileSync(
      join(this.dir, "resumen.json"),
      `${redact(JSON.stringify({ runId: process.env.E2E_RUN_ID ?? null, status: result.status, tests: this.entries }, null, 2))}\n`,
    );
  }
}

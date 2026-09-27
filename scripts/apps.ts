/**
 * Prepara y sirve las apps para los recorridos, **sin mocks** y contra el backend indicado
 * (API_ORIGIN = E2E_API_ORIGIN, por defecto desarrollo):
 *
 *   pnpm apps prepare erp backoffice [--source=github|sibling] [--force]
 *   pnpm apps serve erp            # next start en el puerto de la app (3102, 3103…), en primer plano
 *   pnpm apps status
 *
 * Origen del código de cada app:
 * - `github` (por defecto en CI): clon del repo público `drinks-on-chain/<repo>` en `.apps/<app>`.
 * - `sibling` (por defecto en local): clon de la carpeta hermana del paraguas (`../<repo>`), de su
 *   rama local; no toca su copia de trabajo ni su `.next`.
 * - `E2E_APP_DIR_<APP>=<carpeta>`: construye y sirve esa carpeta tal cual (sustituye su `.next`).
 * Rama: `E2E_REF_<APP>` (por defecto `dev`).
 *
 * Un build se reutiliza si el commit y el backend no cambiaron (`.apps/<app>/.e2e-build.json`).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_ORIGIN, APPS, APP_NAMES, appUrl, appUrls, type AppName } from "../src/config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPS_DIR = join(ROOT, ".apps");
const ORG = "drinks-on-chain";
const isWindows = process.platform === "win32";

type Source = "github" | "sibling";

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  console.log(`$ ${cmd} ${args.join(" ")}   (${cwd})`);
  // pnpm es un .cmd en Windows: necesita shell (las rutas de la suite no llevan espacios).
  const result = spawnSync(cmd, args, { cwd, env, stdio: "inherit", shell: isWindows && cmd === "pnpm" });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} terminó con ${result.status ?? result.signal}`);
}

function capture(cmd: string, args: string[], cwd: string): string {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

const refOf = (app: AppName) => process.env[`E2E_REF_${app.toUpperCase()}`]?.trim() || "dev";
const explicitDir = (app: AppName) => process.env[`E2E_APP_DIR_${app.toUpperCase()}`]?.trim();

/** Carpeta desde la que se construye y sirve la app. */
function appDir(app: AppName): string {
  const dir = explicitDir(app);
  return dir ? resolve(dir) : join(APPS_DIR, app);
}

function checkout(app: AppName, source: Source) {
  const dir = appDir(app);
  if (explicitDir(app)) {
    if (!existsSync(join(dir, "package.json")))
      throw new Error(`E2E_APP_DIR_${app.toUpperCase()} no es una app: ${dir}`);
    console.log(`${app}: se usa ${dir} tal cual (E2E_APP_DIR_${app.toUpperCase()})`);
    return;
  }
  const ref = refOf(app);
  const remote =
    source === "github" ? `https://github.com/${ORG}/${APPS[app].repo}.git` : resolve(ROOT, "..", APPS[app].repo);
  if (source === "sibling" && !existsSync(join(remote, ".git"))) {
    throw new Error(`No existe la carpeta hermana ${remote}: usa --source github o E2E_APP_DIR_${app.toUpperCase()}`);
  }
  mkdirSync(APPS_DIR, { recursive: true });
  // Un clon local (sibling) no admite --depth sin file://, que no sirve con rutas de Windows.
  const depth = source === "github" ? ["--depth", "1"] : [];
  if (!existsSync(join(dir, ".git"))) {
    run("git", ["clone", "--quiet", ...depth, "--branch", ref, remote, dir], ROOT);
  } else {
    // Clon propio de la suite: se lleva a la punta de la rama (se conservan node_modules y .next).
    run("git", ["remote", "set-url", "origin", remote], dir);
    run("git", ["fetch", "--quiet", ...depth, "origin", ref], dir);
    run("git", ["checkout", "--quiet", "--force", "FETCH_HEAD"], dir);
    run("git", ["clean", "-fdq", "-e", "node_modules", "-e", ".next", "-e", ".e2e-build.json"], dir);
  }
  console.log(`${app}: ${source} ${ref} @ ${capture("git", ["log", "-1", "--format=%h %s"], dir)}`);
}

interface BuildStamp {
  commit: string;
  apiOrigin: string;
  env: Record<string, string>;
}

function stampPath(app: AppName) {
  return join(appDir(app), ".e2e-build.json");
}

function build(app: AppName, force: boolean) {
  const dir = appDir(app);
  const env = APPS[app].buildEnv(appUrls());
  const commit = existsSync(join(dir, ".git")) ? capture("git", ["rev-parse", "HEAD"], dir) : "sin-git";
  const stamp: BuildStamp = { commit, apiOrigin: API_ORIGIN, env };
  const previous = existsSync(stampPath(app)) ? (JSON.parse(readFileSync(stampPath(app), "utf8")) as BuildStamp) : null;
  const dirty = explicitDir(app) !== undefined;
  if (
    !force &&
    !dirty &&
    previous &&
    JSON.stringify(previous) === JSON.stringify(stamp) &&
    existsSync(join(dir, ".next", "BUILD_ID"))
  ) {
    console.log(`${app}: build al día (${commit.slice(0, 7)}, ${API_ORIGIN})`);
    return;
  }
  run("pnpm", ["install", "--frozen-lockfile"], dir);
  run("pnpm", ["build"], dir, { ...process.env, ...env, NEXT_TELEMETRY_DISABLED: "1" });
  writeFileSync(stampPath(app), `${JSON.stringify(stamp, null, 2)}\n`);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const server = createServer()
      .once("error", () => {
        ok(false);
      })
      .once("listening", () => {
        server.close(() => {
          ok(true);
        });
      })
      .listen(port, "127.0.0.1");
  });
}

async function serve(app: AppName) {
  const dir = appDir(app);
  if (!existsSync(join(dir, ".next", "BUILD_ID"))) {
    throw new Error(`${app} no está construida: pnpm apps prepare ${app}`);
  }
  const { port } = APPS[app];
  if (!(await portFree(port))) throw new Error(`El puerto ${port} de ${app} está ocupado`);
  // El servidor de Next también necesita API_ORIGIN para la reescritura /api/v1 → backend.
  const env = { ...process.env, ...APPS[app].buildEnv(appUrls()), NEXT_TELEMETRY_DISABLED: "1" };
  console.log(`${app}: next start en ${appUrl(app)} → ${API_ORIGIN}`);
  const child = spawn("pnpm", ["exec", "next", "start", "--port", String(port)], {
    cwd: dir,
    env,
    stdio: "inherit",
    shell: isWindows,
  });
  const stop = () => child.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function status() {
  for (const app of APP_NAMES) {
    const dir = appDir(app);
    const built = existsSync(join(dir, ".next", "BUILD_ID"));
    const free = await portFree(APPS[app].port);
    console.log(
      `${app.padEnd(12)} ${appUrl(app).padEnd(24)} ${built ? "construida" : "sin build "}  puerto ${APPS[app].port} ${free ? "libre" : "ocupado"}  (${dir})`,
    );
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = rest.filter((a) => a.startsWith("--"));
  const names = rest.filter((a) => !a.startsWith("--")) as AppName[];
  for (const name of names) if (!APP_NAMES.includes(name)) throw new Error(`App desconocida: ${name}`);
  const sourceFlag = flags.find((f) => f.startsWith("--source="))?.slice("--source=".length);
  const source: Source =
    sourceFlag === "github" || sourceFlag === "sibling" ? sourceFlag : process.env.CI ? "github" : "sibling";

  switch (command) {
    case "prepare":
      if (names.length === 0) throw new Error("Indica las apps: pnpm apps prepare erp backoffice");
      for (const app of names) {
        checkout(app, source);
        build(app, flags.includes("--force"));
      }
      return;
    case "serve":
      if (names.length !== 1) throw new Error("Indica una app: pnpm apps serve erp");
      return serve(names[0] as AppName);
    case "status":
      return status();
    default:
      console.log("Uso: pnpm apps prepare <apps…> [--source=github|sibling] [--force] · serve <app> · status");
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

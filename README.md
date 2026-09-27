# drinks-on-chain-e2e

Pruebas **entre aplicaciones** de Drinks on Chain: el recorrido de cada hito (H0–H6) del plan maestro contra el entorno de desarrollo, con las apps construidas **sin mocks** y los correos leídos en Mailpit. Diseño en `plan/04-calidad-y-verificacion.md` §5 del paraguas; avance en [`docs/ROADMAP.md`](docs/ROADMAP.md) y reglas en [`CLAUDE.md`](CLAUDE.md).

| Recorrido                                                                                                                             | Archivo                           | Estado                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| H0 · Integración: salud de API y worker, buzón, login con cookie, renovación, cambio de organización, parcelas, 422 por campo, cierre | `tests/h0-integracion.spec.ts`    | Ejecutable                                                                          |
| H1 · De cero a bodega con equipo (back office → solicitud → aprobación → ERP → equipo → bloqueo → alta directa → bitácoras)           | `tests/h1-alta-de-bodega.spec.ts` | Ejecutable (se marca `fixme` solo si el OpenAPI no declara las rutas de la Etapa 1) |
| H2–H6                                                                                                                                 | —                                 | Pendientes (una por hito)                                                           |

## Cómo funciona

- **Playwright + TypeScript** (Node 22, pnpm). Un **proyecto por aplicación** (`erp`, `backoffice`; `marketplace`, `pos` y `bodegas` preparados y desactivados). Cada recorrido se asigna a la app donde empieza y abre las demás con el fixture `openApp(app)`.
- **Apps sin mocks**: `pnpm apps prepare <apps>` clona cada app en `.apps/<app>`, la instala y la construye con `NEXT_PUBLIC_MOCKS=0` y `API_ORIGIN=<backend>`; `pnpm apps serve <app>` la sirve con `next start` en su puerto (ERP **3102**, Backoffice **3103**; Marketplace 3104, POS 3105, bodegas 3100). Con `E2E_START_APPS=1`, Playwright arranca y detiene esos servidores. No se usan las previews de Vercel (protegidas con SSO).
- **Datos de la ejecución**: prefijo único `e2e-<AAAAMMDD>t<HHMM>-<aleatorio>` (`E2E_RUN_ID`) en correos (`<alias>+<runId>@example.test`), nombres (`… · <runId>`) y NIT. La semilla del entorno no se toca.
- **Utilidades** (`src/`):

| Módulo              | Qué hace                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/mailbox.ts`    | API de Mailpit por HTTP o ssh: listar, esperar el correo de una dirección (con asunto, desde una fecha, con tiempo límite), extraer el primer enlace y su token, borrar solo los correos de la ejecución                   |
| `lib/totp.ts`       | Códigos TOTP (RFC 6238) desde un secreto base32; `freshTotp` no repite un código ya usado                                                                                                                                  |
| `lib/api.ts`        | Cliente directo contra el backend (`X-Client-App: API`, `X-Correlation-ID` con el prefijo, cookie `doc_rt`), login con segundo factor, aceptar invitaciones, cambio de organización; `missingRoutes()` consulta el OpenAPI |
| `lib/run-id.ts`     | Prefijo de ejecución, correos, nombres y NIT de prueba                                                                                                                                                                     |
| `lib/page.ts`       | Errores de consola y red, login, esperar a que una pantalla cargue, cerrar sesión                                                                                                                                          |
| `fixtures/users.ts` | Personas de demostración por rol (plataforma, bodega, dueño, consumidor y cajero de olas futuras)                                                                                                                          |
| `fixtures/test.ts`  | `test` con `runId`, `mailbox`, `api`, `apps` y `openApp`                                                                                                                                                                   |

## Ejecutar en local

Requisitos: Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Chrome instalado (en local se usa el canal `chrome`; `E2E_BROWSER_CHANNEL` lo cambia) y acceso ssh al servidor (`drinksonchain-server`).

```bash
pnpm install

# 1. Secretos en variables de tu proceso, sin imprimirlos
export E2E_PASSWORD="$(ssh drinksonchain-server "sed -n 's/^SEED_DEMO_PASSWORD=//p' ~/doc-dev/.env")"
export E2E_MAILPIT_SSH=drinksonchain-server        # buzón: ssh + curl en el servidor
export E2E_TOTP_SECRET="$(ssh drinksonchain-server "sed -n 's/^SEED_DEMO_TOTP_SECRET=//p' ~/doc-dev/.env")"

# 2. Apps sin mocks (clon de la rama dev de la carpeta hermana; --source=github para GitHub)
pnpm apps prepare erp                              # añade backoffice para H1
pnpm apps status

# 3. Recorridos (Playwright arranca las apps construidas en 3102/3103)
E2E_START_APPS=1 E2E_APPS=erp pnpm e2e:h0
E2E_START_APPS=1 pnpm e2e                          # todos los proyectos activos
pnpm report                                        # informe HTML
```

- `sibling` (por defecto en local) clona la rama **local** de `../drinks-on-chain-<app>` (`E2E_REF_<APP>`, por defecto `dev`) sin tocar su copia de trabajo; `--source=github` clona el repo público. Para probar cambios sin commitear: `E2E_APP_DIR_ERP=../drinks-on-chain-erp` (construye esa carpeta tal cual y **sustituye su `.next`**).
- Si ya tienes una app levantada **sin mocks** contra el mismo backend, usa su URL: `E2E_URL_ERP=http://localhost:3002 pnpm e2e:h0`. No arranques un segundo `next dev` sobre una carpeta que ya sirve alguien.
- Los recorridos corren en serie y sin reintentos: el backend limita el login a 10 por minuto e IP.

## Ejecutar en CI

`.github/workflows/e2e.yml`:

- **Manual**: `gh workflow run e2e.yml --ref dev -f specs="h0-"` (entradas: `specs`, `erp_ref`, `backoffice_ref`, `api_origin`).
- **Desde otro repo o la coordinación**: `repository_dispatch` con `event_type=e2e` y `client_payload` con los mismos campos.
- **Diario** (solo H0, que no crea datos): se activa con la variable del repo `E2E_DAILY=1`.

El workflow construye las apps desde GitHub, instala la llave de Mailpit (`DEV_MAILPIT_SSH_KEY`, comando forzado: solo `GET /api/v1/<ruta>` y `DELETE /api/v1/messages`) con `known_hosts`, exporta `E2E_PASSWORD` y `E2E_TOTP_SECRET`, y sube el informe HTML y las trazas como artefactos. `ci.yml` pasa `lint`, `typecheck`, las unitarias y `prettier` en cada push y PR.

Secretos del repo: `DEV_SSH_HOST`, `DEV_SSH_USER`, `DEV_SSH_KNOWN_HOSTS`, `DEV_MAILPIT_SSH_KEY`, `E2E_PASSWORD`, `E2E_TOTP_SECRET` (este último lo crea la coordinación con la Ola 1).

## Variables

| Variable                                                                | Uso                                                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `E2E_API_ORIGIN`                                                        | Backend (por defecto `https://136.243.223.39.sslip.io`); es el `API_ORIGIN` de las apps                          |
| `E2E_PASSWORD`                                                          | Contraseña de las personas de demostración (`SEED_DEMO_PASSWORD`). Sin ella, los recorridos con sesión se saltan |
| `E2E_TOTP_SECRET`                                                       | Secreto TOTP (base32) del personal de plataforma de la semilla                                                   |
| `E2E_URL_<APP>`                                                         | URL de una app ya levantada (`ERP`, `BACKOFFICE`, `MARKETPLACE`, `POS`, `BODEGAS`)                               |
| `E2E_START_APPS`, `E2E_APPS`                                            | `1` = Playwright sirve las apps construidas; lista de apps a servir                                              |
| `E2E_REF_<APP>`, `E2E_APP_DIR_<APP>`                                    | Rama a construir; o carpeta a construir tal cual                                                                 |
| `E2E_ENABLE_<APP>`                                                      | `1`/`0` activa o desactiva el proyecto de una app                                                                |
| `E2E_MAILPIT_SSH`, `E2E_MAILPIT_SSH_MODE`, `E2E_MAILPIT_SSH_KEY`        | Buzón por ssh: destino, `curl` (local) o `api` (llave de CI), llave                                              |
| `E2E_MAILPIT_URL`                                                       | Buzón por HTTP (túnel)                                                                                           |
| `E2E_KEEP_MAIL`                                                         | `1` = no borrar los correos de la ejecución al terminar                                                          |
| `E2E_RUN_ID`, `E2E_WORKERS`, `E2E_CAPTCHA_TOKEN`, `E2E_BROWSER_CHANNEL` | Prefijo fijo, workers, token de captcha de prueba, canal del navegador                                           |

## Buzón

```bash
pnpm mailbox list [correo]          # últimos correos, o los de una dirección
pnpm mailbox cleanup <runId>        # borra los de una ejecución (no con la llave de CI)
pnpm mailbox purge --yes            # vacía el buzón entero: solo como limpieza final explícita
```

Al terminar, cada worker borra los correos de su ejecución si el transporte lo permite (ssh normal o HTTP). La llave de CI no puede borrar correos sueltos: los deja (Mailpit rota los antiguos).

## Añadir un hito

1. Crea `tests/h<N>-<nombre>.spec.ts` con `import { test, expect } from "../src/fixtures/test"`: un `test` por recorrido completo con `test.step` por paso, datos con `runEmail`/`runName`/`runTaxId`, y ninguna dependencia de otro archivo ni del orden.
2. Asígnalo a la app donde empieza en `APPS[app].specs` (`src/config.ts`); activa el proyecto de una app nueva (`enabledByDefault` o `E2E_ENABLE_<APP>`), su `repo`, `port` y `buildEnv`.
3. Si depende de rutas del backend que aún no están desplegadas, consulta `missingRoutes([...])` en un `beforeAll` y márcalo `test.fixme(missing.length > 0, "requiere <tarea> desplegado: …")`.
4. Añade su filtro al workflow si necesita otra app (`E2E_APPS`) y marca la casilla en `docs/ROADMAP.md`.

# drinks-on-chain-e2e

Pruebas **entre aplicaciones** de Drinks on Chain: el recorrido de cada hito (H0–H6) del plan maestro contra el entorno de desarrollo, con las apps construidas **sin mocks** y los correos leídos en Mailpit. Diseño en `plan/04-calidad-y-verificacion.md` §5 del paraguas; avance en [`docs/ROADMAP.md`](docs/ROADMAP.md) y reglas en [`CLAUDE.md`](CLAUDE.md).

| Recorrido                                                                                                                                             | Archivo                           | Estado                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| H0 · Integración: salud de API y worker, buzón, login con cookie, renovación, cambio de organización, parcelas, 422 por campo, cierre                 | `tests/h0-integracion.spec.ts`    | Ejecutable                                                                          |
| H1 · De cero a bodega con equipo (back office → solicitud → aprobación → ERP → equipo → bloqueo → alta directa → bitácoras)                           | `tests/h1-alta-de-bodega.spec.ts` | Ejecutable (se marca `fixme` solo si el OpenAPI no declara las rutas de la Etapa 1) |
| H2 · Pasaporte público: lote singani completo por la API (contrato O2 §18) → visor `/b/{lote}` y `/b/{botella}` → código anulado → código inexistente | `tests/h2-pasaporte.spec.ts`      | Ejecutable (se marca `fixme` solo si el OpenAPI no declara las rutas de la Etapa 2) |
| H2 · Lote singani por la interfaz del ERP, con las pruebas de elusión                                                                                 | `tests/h2-lote-singani.spec.ts`   | Pendiente (O2-E2E-1, parte 2)                                                       |
| H3–H6                                                                                                                                                 | —                                 | Pendientes (una por hito)                                                           |

## Estado contra desarrollo (02-10-2026, backend `8e85935`)

Ejecución de CI `37024567801` (ERP `14879e5`, Backoffice `ff7c029`, Marketplace `4ea1312`): H1 en verde; H0 y el pasaporte de H2 en rojo por **diferencias de forma entre el backend real y lo que esperan las apps** (sus esquemas salen de `@drinks-on-chain/mocks` 0.5.0-rc.1). No se arreglan aquí: son de cada app o de los mocks.

| Recorrido                                    | Paso que falla                                                         | Causa                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H0 · dueño de Altos y Sofía (2 de 4 pruebas) | Panel del ERP tras el login: no aparece "Tareas pendientes"            | El panel pinta "No se pudo cargar · Recibimos datos inesperados del servidor" sin ninguna respuesta ≥ 400: la respuesta de `GET /v1/traceability/dashboard` de una bodega con datos no cumple el esquema del ERP. Campo probable (leído en el código, no observado): `pendingPhyto[].intakeDate` llega como fecha `AAAA-MM-DD` y el esquema exige un instante ISO con zona. Con una bodega recién creada (H1) el panel carga                                                                                                  |
| H2 · pasaporte                               | "el visor abre /b/{código de botella}": la comprobación de pertenencia | El visor pinta "No pudimos confirmar este código" (`mismatch-root`) para una botella válida. El backend calcula cada nodo del árbol Merkle como SHA-256 de los **bytes** de los dos hijos; `merkleRootFromProof` de los mocks, que usa el visor, lo hace sobre su **texto hexadecimal**. El recorrido comprueba por la API que la prueba real reproduce la raíz del expediente con la regla del backend. El resto del recorrido (lote, botella n.º N de M, expediente cerrado con huella, anulación, código inexistente) pasa |

## Cómo funciona

- **Playwright + TypeScript** (Node 22, pnpm). Un **proyecto por aplicación** (`erp`, `backoffice`, `marketplace`; `pos` y `bodegas` preparados y desactivados). Cada recorrido se asigna a la app donde empieza y abre las demás con el fixture `openApp(app)`.
- **Apps sin mocks**: `pnpm apps prepare <apps>` clona cada app en `.apps/<app>`, la instala y la construye con `NEXT_PUBLIC_MOCKS=0` y `API_ORIGIN=<backend>`; `pnpm apps serve <app>` la sirve con `next start` en su puerto (ERP **3102**, Backoffice **3103**, Marketplace **3104**; POS 3105, bodegas 3100). El Marketplace es un sitio público sin sesión: se construye sin `PROXY_SHARED_SECRET`, así que el límite del pasaporte público cuenta por la IP de quien ejecuta la suite. Con `E2E_START_APPS=1`, Playwright arranca y detiene esos servidores. No se usan las previews de Vercel (protegidas con SSO).
- **Datos de la ejecución**: prefijo único `e2e-<AAAAMMDD>t<HHMM>-<aleatorio>` (`E2E_RUN_ID`) en correos (`<alias>+<runId>@example.test`), nombres (`… · <runId>`) y NIT. La semilla del entorno no se toca.
- **Utilidades** (`src/`):

| Módulo              | Qué hace                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/mailbox.ts`    | API de Mailpit por HTTP o ssh: listar, esperar el correo de una dirección (con asunto, desde una fecha, con tiempo límite), extraer el primer enlace y su token, borrar solo los correos de la ejecución                   |
| `lib/totp.ts`       | Códigos TOTP (RFC 6238) desde un secreto base32; `freshTotp` no repite un código ya usado                                                                                                                                  |
| `lib/api.ts`        | Cliente directo contra el backend (`X-Client-App: API`, `X-Correlation-ID` con el prefijo, cookie `doc_rt`), login con segundo factor, aceptar invitaciones, cambio de organización; `missingRoutes()` consulta el OpenAPI |
| `lib/run-id.ts`     | Prefijo de ejecución, correos, nombres y NIT de prueba                                                                                                                                                                     |
| `lib/cleanup.ts`    | Limpieza de una ejecución por la API: cuentas bloqueadas, bodegas revocadas (fuera de la lista pública) y lotes descartados                                                                                                |
| `lib/dates.ts`      | Fechas relativas a hoy en America/La_Paz (candados de reposo y crianza ya cumplidos)                                                                                                                                       |
| `lib/merkle.ts`     | Huella del expediente y prueba Merkle de un código de botella, como las calcula el backend                                                                                                                                 |
| `lib/page.ts`       | Errores de consola y red, login, esperar a que una pantalla cargue, cerrar sesión                                                                                                                                          |
| `fixtures/users.ts` | Personas de demostración por rol (plataforma, bodega, dueño, consumidor y cajero de olas futuras)                                                                                                                          |
| `fixtures/test.ts`  | `test` con `runId`, `mailbox`, `api`, `apps` y `openApp`                                                                                                                                                                   |

## Ningún artefacto con datos de sesión

Contra el backend real no se generan trazas, vídeos, capturas, informe HTML ni el "error context" de Playwright: guardarían el login, cookies, secretos TOTP y valores tecleados. Cada ejecución produce solo un **resumen de texto filtrado** (`e2e-summary/resumen.md` y `resumen.json`: prueba, paso y mensaje de error) pasado por `redact()`, que quita contraseñas, secretos TOTP, tokens, cookies y enlaces con token. Es lo único que se imprime en la consola de CI y lo único que sube el workflow. Para depurar en local, `E2E_DEBUG_ARTIFACTS=1` activa trazas, capturas, vídeo e informe HTML (prohibido en CI; no los compartas).

## Limpieza de lo que crea una ejecución

Nada se borra a mano: todo va por la API, con motivo, y solo sobre datos que llevan el prefijo de la ejecución.

| Qué                                                                    | Cómo queda                                                                                                                                                                                | Quién                                |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Cuentas `+<runId>@` e invitaciones pendientes                          | Cuenta **bloqueada**, invitación anulada                                                                                                                                                  | Sesión ADMIN de demo                 |
| Bodegas `… · <runId>`                                                  | **Revocadas** (`POST /v1/platform/wineries/{id}/revoke`): salen de `GET /v1/public/wineries`, que solo lista las `ACTIVE` y es lo que pintan los sitios públicos                          | Sesión ADMIN de demo                 |
| Lotes con el `runId` en el nombre (bodega de demostración Cinti Viejo) | **Descartados** si la API lo permite. Un lote con el expediente cerrado (`CERTIFIED`) es terminal (`TRC_LOT_TERMINAL`): se queda, con sus códigos de botella, y se reconoce por el nombre | Enóloga o dueño de demo de la bodega |

- El `afterAll` de cada recorrido lo hace al terminar (también si falla) y comprueba que no queda ninguna cuenta activa ni ninguna bodega de la ejecución en la lista pública. El recorrido del pasaporte termina con su lote certificado, así que cada ejecución deja **un lote `Singani Gran Reserva 2026 · <runId>`** en Cinti Viejo.
- Para ejecuciones anteriores: `pnpm cleanup <runId> [<runId>…]` (con `E2E_PASSWORD` y `E2E_TOTP_SECRET` en el entorno), o sin secretos en local, desde CI: `gh workflow run e2e.yml --ref dev -f cleanup="<runId> <runId>"`. Imprime la lista pública de bodegas antes y después.

## Ejecutar en local

Requisitos: Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Chrome instalado (en local se usa el canal `chrome`; `E2E_BROWSER_CHANNEL` lo cambia) y acceso ssh al servidor (`drinksonchain-server`).

```bash
pnpm install

# 1. Secretos en variables de tu proceso, sin imprimirlos
export E2E_PASSWORD="$(ssh drinksonchain-server "sed -n 's/^SEED_DEMO_PASSWORD=//p' ~/doc-dev/.env")"
export E2E_MAILPIT_SSH=drinksonchain-server        # buzón: ssh + curl en el servidor
export E2E_TOTP_SECRET="$(ssh drinksonchain-server "sed -n 's/^SEED_DEMO_TOTP_SECRET=//p' ~/doc-dev/.env")"

# 2. Apps sin mocks (clon de la rama dev de la carpeta hermana; --source=github para GitHub)
pnpm apps prepare erp                              # añade backoffice para H1 y marketplace para el pasaporte de H2
pnpm apps status

# 3. Recorridos (Playwright arranca las apps construidas en 3102/3103/3104)
E2E_START_APPS=1 E2E_APPS=erp pnpm e2e:h0
E2E_START_APPS=1 E2E_APPS=marketplace pnpm e2e:h2-pasaporte
E2E_START_APPS=1 pnpm e2e                          # todos los proyectos activos
cat e2e-summary/resumen.md                         # resumen filtrado
```

- `sibling` (por defecto en local) clona la rama **local** de `../drinks-on-chain-<app>` (`E2E_REF_<APP>`, por defecto `dev`) sin tocar su copia de trabajo; `--source=github` clona el repo público. Para probar cambios sin commitear: `E2E_APP_DIR_ERP=../drinks-on-chain-erp` (construye esa carpeta tal cual y **sustituye su `.next`**).
- Si ya tienes una app levantada **sin mocks** contra el mismo backend, usa su URL: `E2E_URL_ERP=http://localhost:3002 pnpm e2e:h0`. No arranques un segundo `next dev` sobre una carpeta que ya sirve alguien.
- Los recorridos corren en serie y sin reintentos: el backend limita el login a 10 por minuto e IP.

## Ejecutar en CI

`.github/workflows/e2e.yml`:

- **Manual**: `gh workflow run e2e.yml --ref dev -f specs="h0-"` (entradas: `specs`, `erp_ref`, `backoffice_ref`, `marketplace_ref`, `api_origin`, `cleanup`). Las apps se construyen según el recorrido: `h0-` → ERP; `h1-` → ERP y Backoffice; `h2-pasaporte` → Marketplace; sin filtro, todas.
- **Solo limpieza**: `-f cleanup="<runId> <runId>"` no ejecuta recorridos; llama a `pnpm cleanup` con los secretos del repo.
- **Desde otro repo o la coordinación**: `repository_dispatch` con `event_type=e2e` y `client_payload` con los mismos campos.
- **Diario** (solo H0, que no crea datos): se activa con la variable del repo `E2E_DAILY=1`.

El workflow construye las apps desde GitHub, instala la llave de Mailpit (`DEV_MAILPIT_SSH_KEY`, comando forzado: solo `GET /api/v1/<ruta>` y `DELETE /api/v1/messages`) con `known_hosts`, exporta `E2E_PASSWORD` y `E2E_TOTP_SECRET`, y sube solo el resumen filtrado (`resumen-e2e-<runId>`): ni informe HTML ni trazas. `ci.yml` pasa `lint`, `typecheck`, las unitarias y `prettier` en cada push y PR.

Secretos del repo: `DEV_SSH_HOST`, `DEV_SSH_USER`, `DEV_SSH_KNOWN_HOSTS`, `DEV_MAILPIT_SSH_KEY`, `E2E_PASSWORD`, `E2E_TOTP_SECRET` (este último lo crea la coordinación con la Ola 1).

## Variables

| Variable                                                                | Uso                                                                                                                                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E2E_API_ORIGIN`                                                        | Backend (por defecto `https://136.243.223.39.sslip.io`); es el `API_ORIGIN` de las apps                                                                    |
| `E2E_PASSWORD`                                                          | Contraseña de las personas de demostración (`SEED_DEMO_PASSWORD`). Sin ella, los recorridos con sesión se saltan                                           |
| `E2E_TOTP_SECRET`                                                       | Secreto TOTP (base32) del personal de plataforma de la semilla                                                                                             |
| `E2E_URL_<APP>`                                                         | URL de una app ya levantada (`ERP`, `BACKOFFICE`, `MARKETPLACE`, `POS`, `BODEGAS`); por defecto `http://localhost:<puerto>` (3102, 3103, 3104, 3105, 3100) |
| `E2E_START_APPS`, `E2E_APPS`                                            | `1` = Playwright sirve las apps construidas; lista de apps a servir                                                                                        |
| `E2E_REF_<APP>`, `E2E_APP_DIR_<APP>`                                    | Rama a construir; o carpeta a construir tal cual                                                                                                           |
| `E2E_ENABLE_<APP>`                                                      | `1`/`0` activa o desactiva el proyecto de una app (activos por defecto: `ERP`, `BACKOFFICE`, `MARKETPLACE`)                                                |
| `E2E_MAILPIT_SSH`, `E2E_MAILPIT_SSH_MODE`, `E2E_MAILPIT_SSH_KEY`        | Buzón por ssh: destino, `curl` (local) o `api` (llave de CI), llave                                                                                        |
| `E2E_MAILPIT_URL`                                                       | Buzón por HTTP (túnel)                                                                                                                                     |
| `E2E_KEEP_MAIL`                                                         | `1` = no borrar los correos de la ejecución al terminar                                                                                                    |
| `E2E_DEBUG_ARTIFACTS`                                                   | `1` = trazas, capturas, vídeo e informe HTML (solo local; prohibido en CI)                                                                                 |
| `E2E_SUMMARY_DIR`                                                       | Carpeta del resumen filtrado (por defecto `e2e-summary`)                                                                                                   |
| `E2E_RUN_ID`, `E2E_WORKERS`, `E2E_CAPTCHA_TOKEN`, `E2E_BROWSER_CHANNEL` | Prefijo fijo, workers, token de captcha de prueba, canal del navegador                                                                                     |

## Buzón

```bash
pnpm mailbox list [correo]          # últimos correos, o los de una dirección
pnpm mailbox cleanup <runId>        # borra los de una ejecución (no con la llave de CI)
pnpm mailbox purge --yes            # vacía el buzón entero: solo como limpieza final explícita
```

Al terminar, cada worker borra los correos de su ejecución si el transporte lo permite (ssh normal o HTTP). La llave de CI no puede borrar correos sueltos: los deja (Mailpit rota los antiguos).

## Añadir un hito

1. Crea `tests/h<N>-<nombre>.spec.ts` con `import { test, expect } from "../src/fixtures/test"`: un `test` por recorrido completo con `test.step` por paso, datos con `runEmail`/`runName`/`runTaxId`, y ninguna dependencia de otro archivo ni del orden.
2. Asígnalo a la app donde empieza en `APPS[app].specs` (`src/config.ts`); activa el proyecto de una app nueva (`enabledByDefault` o `E2E_ENABLE_<APP>`), su `repo`, `port`, `readyPath` (la ruta con la que Playwright sabe que ya responde: `/login` en las apps con sesión, `/` en los sitios públicos) y `buildEnv`.
3. Si depende de rutas del backend que aún no están desplegadas, consulta `missingRoutes([...])` en un `beforeAll` y márcalo `test.fixme(missing.length > 0, "requiere <tarea> desplegado: …")`.
4. Añade su filtro al workflow si necesita otra app (el `case` de "apps necesarias") y marca la casilla en `docs/ROADMAP.md`.
5. Si crea datos, límpialos en un `test.afterAll` con las utilidades de `src/lib/cleanup.ts` (ver "Limpieza de lo que crea una ejecución").

## Recorrido del pasaporte (H2)

`tests/h2-pasaporte.spec.ts` prepara por la **API** el caso del contrato de la Ola 2 §18 en Destilería Cinti Viejo, con la enóloga, el operario y el agrónomo de demostración (tres inicios de sesión) y una parcela apta de la semilla: lote `Singani Gran Reserva 2026 · <runId>` → pesaje de 18.400 kg hace 205 días, análisis y dictamen → tanque de 12.100 L y fermentación → destilación cerrada hace 185 días (reposo de 180 cumplido) → 2.950 botellas de 75 cL al 40 % → laboratorio conforme → expediente cerrado. Después comprueba:

- Por la API pública: el pasaporte del lote, la huella recalculada sobre los bytes de `GET /v1/public/lots/{lotCode}/dossier` y la prueba Merkle de la botella n.º 1.234 contra la raíz del expediente.
- En el visor del Marketplace: `/b/{lotCode}` (nombre, bodega, D.O., elaboración, registro del lote, laboratorio conforme, expediente cerrado con su huella) y `/b/{código}` ("Botella n.º 1.234 de 2.950" y "Este código pertenece al expediente cerrado"); tras anular por la API la botella n.º 9, el aviso "Este código fue anulado por la bodega"; y un código de lote inexistente → "No encontramos este código".

El pasaporte público frena la enumeración (más de 20 códigos inexistentes por IP en 10 minutos → 429): el recorrido hace **una sola** consulta inexistente y no prueba ese freno. El visor se abre siempre **después** del cierre o de la anulación, así no lee nada cacheado (el backend cachea 60 s el pasaporte).

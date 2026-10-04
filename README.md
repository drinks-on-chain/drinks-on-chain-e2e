# drinks-on-chain-e2e

Pruebas **entre aplicaciones** de Drinks on Chain: el recorrido de cada hito (H0–H6) del plan maestro contra el entorno de desarrollo, con las apps construidas **sin mocks** y los correos leídos en Mailpit. Diseño en `plan/04-calidad-y-verificacion.md` §5 del paraguas; avance en [`docs/ROADMAP.md`](docs/ROADMAP.md) y reglas en [`CLAUDE.md`](CLAUDE.md).

| Recorrido                                                                                                                                                                                                                              | Archivo                           | Estado                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| H0 · Integración: salud de API y worker, buzón, login con cookie, renovación, cambio de organización, parcelas, 422 por campo, cierre                                                                                                  | `tests/h0-integracion.spec.ts`    | Ejecutable                                                                          |
| H1 · De cero a bodega con equipo (back office → solicitud → aprobación → ERP → equipo → bloqueo → alta directa → bitácoras)                                                                                                            | `tests/h1-alta-de-bodega.spec.ts` | Ejecutable (se marca `fixme` solo si el OpenAPI no declara las rutas de la Etapa 1) |
| H2 · Recorrido entre aplicaciones (contrato O2 §18): bodega propia → lote singani por la **interfaz del ERP** hasta el expediente cerrado, con sus elusiones → pasaporte del lote y de una botella del CSV en el visor del Marketplace | `tests/h2-recorrido.spec.ts`      | Ejecutable (se marca `fixme` solo si el OpenAPI no declara las rutas de la Etapa 2) |
| H2 · Pasaporte público: bodega propia → lote singani completo por la API → HTML servido → visor `/b/{lote}` y `/b/{botella}` → código anulado → código inexistente                                                                     | `tests/h2-pasaporte.spec.ts`      | Ejecutable (ídem)                                                                   |
| H3–H6                                                                                                                                                                                                                                  | —                                 | Pendientes (una por hito)                                                           |

## Estado contra desarrollo (02-10-2026, backend `8e85935`)

Todo en verde en una sola pasada de CI (`37043627566`, `h0- h1- h2-`; ERP `28393ad`, Backoffice `ff7c029`, Marketplace `6a5416c`), unos 5 minutos con la construcción de las tres apps:

| Recorrido      | Duración  | Notas                                                                                  |
| -------------- | --------- | -------------------------------------------------------------------------------------- |
| H0 (4 pruebas) | ≈ 15 s    | El panel del ERP carga con los datos de Altos de Calamuchita                           |
| H2 · recorrido | ≈ 55–75 s | Preparación por la API ≈ 25 s; interfaz del ERP ≈ 35 s; visor ≈ 3 s                    |
| H1             | ≈ 45–75 s | Incluye la espera al siguiente código TOTP cuando otro worker acaba de usar el vigente |
| H2 · pasaporte | ≈ 25–45 s | —                                                                                      |

## Cómo funciona

- **Playwright + TypeScript** (Node 22, pnpm). Un **proyecto por aplicación** (`erp`, `backoffice`, `marketplace`; `pos` y `bodegas` preparados y desactivados). Cada recorrido se asigna a la app donde empieza (H0 y el recorrido de H2, al ERP; H1, al Backoffice; el pasaporte de H2, al Marketplace) y abre las demás con el fixture `openApp(app)`, que da además un navegador propio a cada persona.
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
| `lib/run-winery.ts` | Bodega propia de la ejecución por la API: alta directa, dueña y equipo que aceptan desde el buzón, parcelas y lotes de singani en reposo                                                                                   |
| `lib/login-pace.ts` | Reparte los inicios de sesión (interfaz y API) bajo el límite de 10 por minuto e IP                                                                                                                                        |
| `lib/page.ts`       | Errores de consola y red, login, esperar a que una pantalla cargue, cerrar sesión                                                                                                                                          |
| `fixtures/users.ts` | Personas de demostración por rol (plataforma, bodega, dueño, consumidor y cajero de olas futuras)                                                                                                                          |
| `fixtures/test.ts`  | `test` con `runId`, `mailbox`, `api`, `apps` y `openApp`                                                                                                                                                                   |

## Ningún artefacto con datos de sesión

Contra el backend real no se generan trazas, vídeos, capturas, informe HTML ni el "error context" de Playwright: guardarían el login, cookies, secretos TOTP y valores tecleados. Cada ejecución produce solo un **resumen de texto filtrado** (`e2e-summary/resumen.md` y `resumen.json`: prueba, paso y mensaje de error) pasado por `redact()`, que quita contraseñas, secretos TOTP, tokens, cookies y enlaces con token. Es lo único que se imprime en la consola de CI y lo único que sube el workflow. Para depurar en local, `E2E_DEBUG_ARTIFACTS=1` activa trazas, capturas, vídeo e informe HTML (prohibido en CI; no los compartas).

## Limpieza de lo que crea una ejecución

Nada se borra a mano: todo va por la API, con motivo, y solo sobre datos que llevan el prefijo de la ejecución.

| Qué                                           | Cómo queda                                                                                                                                                                                                                                                                                                        | Quién                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Cuentas `+<runId>@` e invitaciones pendientes | Cuenta **bloqueada**, invitación anulada                                                                                                                                                                                                                                                                          | Sesión ADMIN de demo |
| Bodegas `… · <runId>`                         | **Revocadas** (`POST /v1/platform/wineries/{id}/revoke`): salen de `GET /v1/public/wineries`, que solo lista las `ACTIVE` y es lo que pintan los sitios públicos                                                                                                                                                  | Sesión ADMIN de demo |
| Lotes de la ejecución                         | Viven en la **bodega de la ejecución** (el recorrido del pasaporte crea la suya), que se revoca entera: nada queda en las bodegas de demostración. Un lote con el expediente cerrado (`CERTIFIED`) no se puede descartar (`TRC_LOT_TERMINAL`); su pasaporte sigue visible con el aviso de bodega no activa (S-23) | Sesión ADMIN de demo |

- El `afterAll` de cada recorrido lo hace al terminar (también si falla) y comprueba que no queda ninguna cuenta activa ni ninguna bodega de la ejecución en la lista pública. El recorrido de H2 restablece además el ajuste de configuración que cambió (`POST /v1/platform/settings/{key}/overrides/reset`).
- Residuo anterior a esta regla: los lotes `CVJ-2026-SINGANI-004` y `-005` (`Singani Gran Reserva 2026 · e2e-20261002t…`), certificados en Destilería Cinti Viejo el 02-10-2026; la API no deja descartarlos. `pnpm cleanup` sigue descartando con la sesión del dueño de Cinti Viejo los lotes sin certificar de ejecuciones antiguas.
- Una bodega que se activa consume un **prefijo de lote** único y definitivo, derivado de las iniciales de su nombre (unos 29 candidatos por nombre). Las bodegas de un recorrido que llegan a activarse usan `runWineryName(runId, tipo, variante)`, que cambia las iniciales con la ejecución y con la variante (pasaporte 0, H1 1, recorrido 2 y 3).
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
E2E_START_APPS=1 E2E_APPS=erp,marketplace pnpm e2e:h2-recorrido
E2E_START_APPS=1 pnpm e2e                          # todos los proyectos activos
cat e2e-summary/resumen.md                         # resumen filtrado
```

- `sibling` (por defecto en local) clona la rama **local** de `../drinks-on-chain-<app>` (`E2E_REF_<APP>`, por defecto `dev`) sin tocar su copia de trabajo; `--source=github` clona el repo público. Para probar cambios sin commitear: `E2E_APP_DIR_ERP=../drinks-on-chain-erp` (construye esa carpeta tal cual y **sustituye su `.next`**).
- Si ya tienes una app levantada **sin mocks** contra el mismo backend, usa su URL: `E2E_URL_ERP=http://localhost:3002 pnpm e2e:h0`. No arranques un segundo `next dev` sobre una carpeta que ya sirve alguien.
- Los recorridos corren en serie y sin reintentos: el backend limita el login a 10 por minuto e IP.

## Ejecutar en CI

`.github/workflows/e2e.yml`:

- **Manual**: `gh workflow run e2e.yml --ref dev -f specs="h0-"` (entradas: `specs`, `erp_ref`, `backoffice_ref`, `marketplace_ref`, `api_origin`, `cleanup`). Las apps se construyen según el recorrido: `h0-` → ERP; `h1-` → ERP y Backoffice; `h2-recorrido` → ERP y Marketplace; `h2-pasaporte` → Marketplace; `h2-` o sin filtro, todas. La suite entera: `-f specs="h0- h1- h2-"`.
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

## Recorrido de H2 entre aplicaciones

`tests/h2-recorrido.spec.ts` es el hito H2 (contrato de la Ola 2 §18) en una sola prueba de ≈ 1 minuto.

**Preparación por la API**: administración (un inicio de sesión con TOTP) da de alta dos bodegas de la ejecución; la del recorrido forma su equipo (dueña, enóloga, agrónomo, operario) desde el buzón y registra una parcela apta y "El Portillo" a 1.540 m; se dejan tres lotes pequeños en reposo (`prepareRestingSinganiLot`): uno con la destilación reciente y dos con el reposo cumplido (uno en la bodega vecina).

**Interfaz del ERP** (enóloga, operario y agrónomo, cada uno con su inicio de sesión y su navegador): lote singani (3.000 botellas, 75 cL, 40 %; instantánea de reglas) → pesaje de 18.400 kg de hace 200 días → análisis de madurez → dictamen → tanque de 12.100 L, lectura y destino singani → destilación cerrada con cabezas 120, corazón 1.500 al 60 % y colas 210 (reposo cumplido) → vista previa y embotellado de 2.950 botellas de 75 cL al 40 % con 750 L de agua → CSV de los códigos → laboratorio conforme → expediente cerrado con huella.

**Visor del Marketplace**: `/b/{lotCode}` (lo registrado en el ERP: bodega, D.O., madurez, roles, laboratorio conforme, expediente cerrado con su huella, "Ninguno registrado" en tratamientos), `/b/{código}` de la botella n.º 1.234 **tomada del CSV** ("pertenece al expediente cerrado") y el lote sin laboratorio de la bodega vecina ("No registrado" en madurez y laboratorio, expediente abierto).

| Elusión                                                       | Cómo se intenta                                                                                                                                            | Dónde                                                  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `TRC_DO_TERROIR_NOT_ELIGIBLE`                                 | Pesaje de El Portillo (1.540 m) en el lote singani                                                                                                         | Interfaz                                               |
| `TRC_PHYTO_NOT_APPROVED`                                      | Tanque con la uva pendiente de dictamen                                                                                                                    | Interfaz                                               |
| `TRC_MASS_BALANCE_EXCEEDED`                                   | Cortes mayores que la entrada al cerrar la destilación                                                                                                     | Interfaz                                               |
| `TRC_BOTTLING_EXCEEDS_VOLUME`, `TRC_ALCOHOL_BALANCE_EXCEEDED` | Más botellas y más grado en la vista previa                                                                                                                | Interfaz                                               |
| `TRC_LOT_ALREADY_BOTTLED`                                     | Formulario de embotellado del lote ya embotellado (por su URL)                                                                                             | Interfaz                                               |
| `TRC_DOSSIER_NOT_READY`                                       | Cerrar el expediente sin laboratorio                                                                                                                       | Interfaz                                               |
| `TRC_DOSSIER_CLOSED`                                          | Corrección de un pesaje tras el cierre                                                                                                                     | Interfaz                                               |
| `TRC_LOCK_NOT_RELEASED`                                       | Embotellar el lote con la destilación de hace 5 días                                                                                                       | Interfaz                                               |
| `TRC_PLATFORM_READ_ONLY`                                      | La plataforma crea un lote en la bodega                                                                                                                    | API (el ERP no ofrece escrituras a la plataforma)      |
| Grafo de otra bodega → 404 `TRC_LOT_NOT_FOUND`                | La dueña vecina pide el grafo de un lote ajeno                                                                                                             | API                                                    |
| Dos embotellados simultáneos de dos bodegas                   | `Promise.all` de los dos; códigos `…-SINGANI-001` con prefijos distintos                                                                                   | API (no caben dos peticiones a la vez en una pantalla) |
| Cambio de una regla a mitad de proceso                        | Administración sube el reposo mínimo **de la bodega** a 365 días tras cerrar la destilación: un lote nuevo lo toma, el del recorrido embotella con sus 180 | API (la configuración es del back office)              |

Las demás elusiones de §18 (`TRC_PHYTO_IN_CREATE`, `TRC_DO_NOT_ELIGIBLE`, `TRC_PRODUCT_TYPE_MISMATCH`, crianza bajo el mínimo, enumeración con 429) las cubren las suites del backend y del ERP.

Como cada persona tiene su navegador, lo que una registra no aparece en la pantalla ya abierta de otra hasta que recarga (la app guarda 30 s lo que leyó): la enóloga recarga la ficha del pesaje tras el dictamen del agrónomo.

## Recorrido del pasaporte (H2)

`tests/h2-pasaporte.spec.ts` prepara por la **API** el caso del contrato de la Ola 2 §18 en una **bodega propia de la ejecución**: administración (único inicio de sesión, con TOTP) la da de alta con `POST /v1/platform/wineries`; la dueña acepta la invitación del buzón e invita a la enóloga, al agrónomo y al operario (correos `pasaporte-…+<runId>@`), que quedan con sesión al aceptar; la dueña registra una parcela apta (2.350 m, Moscatel de Alejandría). Después, el lote `Singani Gran Reserva 2026 · <runId>` → pesaje de 18.400 kg hace 205 días, análisis y dictamen → tanque de 12.100 L y fermentación → destilación cerrada hace 185 días (reposo de 180 cumplido) → 2.950 botellas de 75 cL al 40 % → laboratorio conforme → expediente cerrado. Y comprueba:

- Por la API pública: el pasaporte del lote, la huella recalculada sobre los bytes de `GET /v1/public/lots/{lotCode}/dossier` y la prueba Merkle de la botella n.º 1.234 contra la raíz del expediente.
- En el **HTML servido** (sin JavaScript): `/b/{lotCode}` lleva el nombre del lote y la bodega, su título y `robots: index, follow`; `/b/{código}` es `noindex`.
- En el visor del Marketplace: `/b/{lotCode}` (nombre, bodega, D.O., elaboración, registro del lote, laboratorio conforme, expediente cerrado con su huella) y `/b/{código}`: "Botella n.º 1.234 de 2.950" y, **obligatorio**, "Este código pertenece al expediente cerrado" (si el visor pinta otro resultado, el error dice cuál).
- Anulación tras el cierre (S-14): la botella n.º 9 conserva su prueba Merkle, la raíz y la huella no cambian, y el visor avisa "Este código fue anulado por la bodega".
- Un código de lote inexistente: el servidor del Marketplace responde 404 con "No encontramos este código" y el navegador no repite la consulta.

El pasaporte público frena la enumeración (más de 20 códigos inexistentes por IP en 10 minutos → 429): el recorrido hace **una sola** consulta inexistente y no prueba ese freno. El visor se abre siempre **después** del cierre o de la anulación y **antes** de la limpieza: el backend cachea 60 s el pasaporte, el Marketplace guarda el de un lote certificado una hora, y una bodega revocada añade su aviso al pasaporte. Dura unos 25 s.

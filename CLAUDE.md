# drinks-on-chain-e2e · reglas

Pruebas entre aplicaciones de Drinks on Chain contra un entorno **compartido** (desarrollo; staging en la Ola 6). Complementa el `CLAUDE.md` del paraguas, `plan/briefing-agentes.md` y `plan/04` §5. Cómo ejecutar: [README](README.md).

## Datos

- Todo lo que una prueba crea lleva el **prefijo de la ejecución** (`runId`, `E2E_RUN_ID`): correos `runEmail(runId, alias)` (`<alias>+<runId>@example.test`), nombres `runName(runId, …)`, NIT `runTaxId(runId, …)`. Nada de correos, nombres ni NIT fijos para datos nuevos.
- **No se toca la semilla**: las personas y bodegas de demostración (`src/fixtures/users.ts`) solo se leen o actúan sobre datos de la ejecución. Nunca se bloquea, suspende, cambia de rol ni cambia la contraseña de una persona de la semilla; un 422 provocado no debe guardar nada.
- **Nunca depender del orden**: cada archivo es independiente y cada recorrido de hito es un único `test` con `test.step` (los datos pasan de un paso a otro dentro de la prueba). Nada de estado compartido entre archivos ni de "la prueba anterior dejó…".
- El buzón se consulta por destinatario exacto y, si puede haber correos previos, con `since`. Solo se borran los correos de la ejecución; vaciar el buzón entero (`pnpm mailbox purge --yes`) es una limpieza final explícita.

## Ningún artefacto con datos de sesión

- Contra el backend real **no se generan** trazas, vídeos, capturas, informe HTML ni el árbol de accesibilidad del "error context" (`PLAYWRIGHT_NO_COPY_PROMPT=1`): guardan cuerpos de peticiones (login, enrolamiento TOTP), cookies y valores tecleados. `playwright.config.ts` los tiene apagados.
- Lo único que sale de una ejecución (consola de CI, que es pública, y artefacto `resumen-e2e-*`) es el resumen de `src/reporters/summary.ts`: prueba, paso y mensaje de error, pasados por `redact()` (`src/lib/redact.ts`, con pruebas unitarias), que quita `E2E_PASSWORD`, `E2E_TOTP_SECRET`, `Bearer …`, `doc_rt=…`, JWT, campos JSON de tokens y secretos, enlaces con `token=` o de invitación, secretos TOTP en base32 y códigos de recuperación. Si añades un tipo de secreto, añádelo al filtro y a su prueba.
- Para depurar **en local**: `E2E_DEBUG_ARTIFACTS=1` activa trazas, capturas, vídeo e informe HTML. Prohibido en CI (la configuración falla) y esos archivos no se comparten ni se suben a ningún sitio.
- Las contraseñas de las personas que crea la suite salen de `runPassword()` (`Pw-e2e-…`, que el filtro reconoce).
- **Ninguna cuenta creada por una prueba queda activa**: cada recorrido que crea personas o usuarios internos tiene un `test.afterAll` (corre también si la prueba falla) que llama a `deactivateRunAccounts()` con la sesión ADMIN de demo: bloquea la cuenta completa de cada `+<runId>@` y anula sus invitaciones pendientes, y comprueba que no queda ninguna activa. Para una ejecución antigua: `pnpm cleanup <runId> [<runId>…]` (o la entrada `cleanup` del workflow E2E).

## Limpieza de datos

- **Ninguna bodega creada por una prueba queda en la lista pública** (`GET /v1/public/wineries`, que pintan los sitios públicos): el mismo `afterAll` llama a `retireRunWineries()`, que revoca con motivo cada bodega `… · <runId>` y comprueba la lista pública. Siempre por la API de plataforma; nunca borrando filas ni tocando una bodega sin el prefijo.
- **Nada en las bodegas de demostración**: un recorrido que necesita lotes crea su propia bodega (`runWineryName(runId)`, alta directa por la API de plataforma, equipo con correos `+<runId>@`) y los lotes dentro de ella; el `afterAll` la revoca. Un lote `CERTIFIED` es terminal para la API (no se descarta), así que nunca se crea en una bodega de la semilla.
- Una bodega que llega a activarse consume un prefijo de lote único y definitivo derivado de las iniciales de su nombre: usa `runWineryName(runId)`, no un nombre fijo.
- Un recorrido usa una botella distinta para cada comprobación que cambia su estado (p. ej. la anulación) y abre el visor después del cambio: el pasaporte público se cachea 60 s.
- El pasaporte público frena la enumeración (más de 20 códigos inexistentes por IP en 10 minutos): un recorrido hace como mucho **una** consulta de un código inexistente y no prueba el 429.

## Secretos

- **Nunca imprimir secretos**: ni `E2E_PASSWORD`, ni `E2E_TOTP_SECRET`, ni llaves, ni tokens de acceso o invitación en logs, anotaciones, nombres de prueba o mensajes de error. `globalSetup` solo dice si están definidos.
- Los secretos llegan por variables de entorno (en local, leídos del servidor a una variable del proceso; en CI, de los secretos del repo). Nunca en el repo: `.env.example` lleva marcadores `change-me`.
- La llave de Mailpit de CI tiene comando forzado (solo lectura y vaciado del buzón): no se amplía desde aquí.

## Pruebas

- Recorridos contra el backend real y con límites por IP (login 10/min): en serie, sin reintentos y con el mínimo de inicios de sesión (reutiliza una sesión de `api.as` dentro del recorrido; las personas que crea la ejecución quedan con sesión de API al aceptar su invitación). `fillLogin` y `ApiClient.login` pasan por `paceLogin()`.
- Un código TOTP es de un solo uso: siempre `freshTotp()`, que no repite el del secreto de demostración ni entre los workers de una ejecución.
- Varias personas a la vez: un navegador por persona (`openApp`). Lo que una registra no aparece en la pantalla ya abierta de otra hasta que recarga (las apps guardan 30 s lo que leyeron): recarga la página, como haría la persona.
- Bodega propia y datos de apoyo por la API con `src/lib/run-winery.ts`; por la interfaz solo lo que el recorrido quiere comprobar.
- Selectores accesibles (`getByRole`, `getByLabel`, textos en español de las apps); sin `waitForTimeout` salvo para el paso del TOTP (`freshTotp`).
- `trackErrors(page, esperados)` en cada página y `expect(errors).toEqual([])` al final: los 4xx provocados se declaran como esperados.
- Un recorrido que depende de rutas aún no desplegadas se marca `test.fixme` **detectándolo** con `missingRoutes()` (OpenAPI de `/docs-json`), con el mensaje "requiere <tarea> desplegado".
- Puertas antes de integrar: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check` y el recorrido afectado en local contra desarrollo.

## Git

- Trabajo en ramas `feat/…` integradas en `dev`; `main` solo por PR que fusiona la coordinación. Conventional Commits en español con `Refs:` y la línea `Co-Authored-By` del briefing.

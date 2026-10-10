# Roadmap · drinks-on-chain-e2e

Un recorrido por hito del plan maestro (`PLAN-MAESTRO.md` §3, `plan/04` §5), contra el entorno de desarrollo (staging en H6). Se marca `- [x] … · fecha · commit` cuando el recorrido pasa en CI.

## Base (O1-E2E-1)

- [x] Repo, `main` y `dev`, Playwright + TypeScript (Node 22, pnpm), un proyecto por app (`erp`, `backoffice`; `marketplace` desde el 02-10-2026; `pos`, `bodegas` desactivados) · 27-09-2026
- [x] Apps sin mocks: `pnpm apps prepare/serve` (clon de GitHub o de la carpeta hermana, `next start` en 3102/3103) · 27-09-2026
- [x] Utilidades: `mailbox` (Mailpit por ssh o HTTP), `totp`, `api` (`X-Client-App: API`), `run-id`, personas de demostración por rol · 27-09-2026
- [x] CI: `ci.yml` (lint, tsc, unitarias, formato) y `e2e.yml` (manual, `repository_dispatch`, diario opcional; informe y trazas como artefactos) · 27-09-2026

## Ola 2 (O2-E2E-1, parte 1)

- [x] Limpieza: las bodegas de cada ejecución se revocan al terminar y salen de la lista pública (`retireRunWineries`); `pnpm cleanup <runId>…` y la entrada `cleanup` del workflow para ejecuciones anteriores; lotes sin certificar descartados (`discardRunLots`) · 02-10-2026 · ec258a9 · CI E2E 37023200224 (cuatro ejecuciones residuales limpiadas)
- [x] Proyecto `marketplace` (puerto 3104, sin mocks) y `marketplace_ref` en el workflow · 02-10-2026 · 6a9550f
- [x] H0 contra el backend de la Ola 2: verde con el ERP `28393ad` (el panel carga con los datos de Altos de Calamuchita) · 02-10-2026 · CI E2E 37043627566
- [x] El recorrido del pasaporte no deja residuos en las bodegas de demostración (bodega propia, revocada al terminar) · 02-10-2026 · ba1d7f5
- [x] H1: la bodega que se activa usa `runWineryName()` (prefijo de lote propio por ejecución) · 02-10-2026 · 5d585f2 · CI E2E 37043627566
- [x] Inicios de sesión repartidos bajo el límite por IP (`paceLogin`) y códigos TOTP que no se repiten entre workers · 02-10-2026

## Hitos

- [x] **H0** · Integración: salud de API y worker, buzón con la llave restringida, login con cookie `doc_rt`, renovación tras recargar, cambio de organización (bodega `SUSPENDED`), parcelas, 422 por campo, cierre de sesión (`tests/h0-integracion.spec.ts`) · 27-09-2026 · 96e1514 · CI E2E 36345510562 (4/4)
- [x] **H1** · De cero a bodega con equipo: administración → operaciones (TOTP) → solicitud pública verificada → aprobación → dueño en el ERP → enóloga → soporte bloquea a un operario (401) → alta directa → bitácoras (`tests/h1-alta-de-bodega.spec.ts`) · 27-09-2026 · 7d12a82 · CI E2E 36358048452 (backend `eace713`)
- [x] **H2** · Lote "Singani Gran Reserva 2026" de la parcela a los códigos de botella en el ERP; elusiones de candados, D.O., dictamen y número de botellas explicadas en la UI; visor del Marketplace con el pasaporte real · 02-10-2026 · CI E2E 37043627566
  - [x] Pasaporte en el visor (`tests/h2-pasaporte.spec.ts`, O2-E2E-1 partes 1 y 1b): bodega propia de la ejecución → lote completo por la API → HTML servido (lote indexable, botella `noindex`) → `/b/{lote}` y `/b/{botella}` con la pertenencia al expediente verificada → anulación tras el cierre (S-14) → código inexistente · 02-10-2026 · ba1d7f5 · CI E2E 37031871658 (Marketplace `6a5416c`, backend `8e85935`)
  - [x] Recorrido entre aplicaciones (`tests/h2-recorrido.spec.ts`, O2-E2E-1 parte 2): bodega propia → lote por la interfaz del ERP hasta el expediente cerrado, con ocho elusiones en la interfaz y cuatro por la API → pasaporte del lote y de una botella del CSV en el visor · 02-10-2026 · 5d585f2 · CI E2E 37043627566 (ERP `28393ad`, Marketplace `6a5416c`, backend `8e85935`)
- [ ] **H3** · Tokenización en testnet: autorización de 100 botellas, aprobación, 100 NFT en el contrato, hash anclado al certificar y verificado en el visor, conciliación sin diferencias (`h3-tokenizacion.spec.ts`)
  - [x] Recorrido escrito y listo (`tests/h3-tokenizacion.spec.ts`, O3-E2E-1, preparación): bodega propia con identidad en testnet, lectura independiente por Stellar RPC sin claves (`src/lib/stellar.ts`), utilidades de la Ola 3 (`src/lib/tokenization.ts`, `poll.ts`), `h3-` en el workflow con el ERP construido con la tokenización y negativas de §14; se marca `fixme` mientras el backend no tenga la cadena configurada · 10-10-2026
  - [ ] Primera ejecución contra desarrollo en testnet (cuando la coordinación confirme el despliegue): confirmar selectores, tiempos y formas de respuesta (suposiciones en el README)
- [ ] **H4** · Compra: registro del consumidor, dos botellas en preventa, "pago recibido", NFT a su nombre, línea de tiempo al registrar una etapa, reseña (`h4-compra.spec.ts`)
- [ ] **H5** · Canje: ciclo 1–12 entre las cuatro apps y los sitios públicos, entrega asistida, pase caducado regenerado (`h5-canje.spec.ts`)
- [ ] **H6** · Recorrido completo contra staging y demo (`h6-staging.spec.ts`)

# Roadmap · drinks-on-chain-e2e

Un recorrido por hito del plan maestro (`PLAN-MAESTRO.md` §3, `plan/04` §5), contra el entorno de desarrollo (staging en H6). Se marca `- [x] … · fecha · commit` cuando el recorrido pasa en CI.

## Base (O1-E2E-1)

- [x] Repo, `main` y `dev`, Playwright + TypeScript (Node 22, pnpm), un proyecto por app (`erp`, `backoffice`; `marketplace`, `pos`, `bodegas` desactivados) · 27-09-2026
- [x] Apps sin mocks: `pnpm apps prepare/serve` (clon de GitHub o de la carpeta hermana, `next start` en 3102/3103) · 27-09-2026
- [x] Utilidades: `mailbox` (Mailpit por ssh o HTTP), `totp`, `api` (`X-Client-App: API`), `run-id`, personas de demostración por rol · 27-09-2026
- [x] CI: `ci.yml` (lint, tsc, unitarias, formato) y `e2e.yml` (manual, `repository_dispatch`, diario opcional; informe y trazas como artefactos) · 27-09-2026

## Hitos

- [ ] **H0** · Integración: salud de API y worker, buzón con la llave restringida, login con cookie `doc_rt`, renovación tras recargar, cambio de organización (bodega `SUSPENDED`), parcelas, 422 por campo, cierre de sesión (`tests/h0-integracion.spec.ts`)
- [ ] **H1** · De cero a bodega con equipo: administración → operaciones (TOTP) → solicitud pública verificada → aprobación → dueño en el ERP → enóloga → soporte bloquea a un operario (401) → alta directa → bitácoras (`tests/h1-alta-de-bodega.spec.ts`, `fixme` hasta O1-BE-1)
- [ ] **H2** · Lote "Singani Gran Reserva 2026" de la parcela a los códigos de botella en el ERP; elusiones de candados, D.O., dictamen y número de botellas → 422 explicado en la UI; visor del Marketplace con el pasaporte real (`h2-lote-singani.spec.ts`)
- [ ] **H3** · Tokenización en testnet: autorización de 100 botellas, aprobación, 100 NFT en el contrato, hash anclado al certificar y verificado en el visor, conciliación sin diferencias (`h3-tokenizacion.spec.ts`)
- [ ] **H4** · Compra: registro del consumidor, dos botellas en preventa, "pago recibido", NFT a su nombre, línea de tiempo al registrar una etapa, reseña (`h4-compra.spec.ts`)
- [ ] **H5** · Canje: ciclo 1–12 entre las cuatro apps y los sitios públicos, entrega asistida, pase caducado regenerado (`h5-canje.spec.ts`)
- [ ] **H6** · Recorrido completo contra staging y demo (`h6-staging.spec.ts`)

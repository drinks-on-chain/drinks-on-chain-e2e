import { defineConfig } from "vitest/config";

// Pruebas unitarias de las utilidades (TOTP, prefijo de ejecución, buzón). Los recorridos de
// Playwright viven en tests/ y no los ejecuta vitest.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});

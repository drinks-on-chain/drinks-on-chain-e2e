import { expect, type Page } from "@playwright/test";
import { paceLogin } from "./login-pace";
import { freshTotp } from "./totp";

// Utilidades de página comunes a las apps (todas nacen de la misma plantilla: shell, menú de
// usuario, login y sesión por cookie).

/**
 * Al arrancar, las apps intentan recuperar la sesión con la cookie de renovación
 * (`POST /api/v1/auth/refresh`): sin cookie responde 401 y es lo esperado.
 */
const BOOT_REFRESH = /^401 \/api\/v1\/auth\/refresh$/;

/**
 * Recoge errores de la página (excepciones, `console.error`, respuestas ≥ 400) salvo los
 * esperados, en la forma `<estado> <ruta>`. La prueba termina con `expect(errors).toEqual([])`.
 */
export function trackErrors(page: Page, expected: RegExp[] = []): string[] {
  const allowed = [BOOT_REFRESH, ...expected];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() < 400) return;
    const line = `${r.status()} ${new URL(r.url()).pathname}`;
    if (!allowed.some((re) => re.test(line))) errors.push(line);
  });
  return errors;
}

export const shellUser = (page: Page) => page.getByRole("button", { name: /Menú de usuario/ });

/** Rellena el login de la app (ERP o Backoffice) y pulsa "Entrar". */
export async function fillLogin(page: Page, email: string, password: string) {
  await paceLogin();
  await page.goto("/login");
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

/** Espera a que la pantalla termine de cargar: un h1 visible y ningún esqueleto. */
export async function settled(page: Page) {
  await expect(page.locator("h1").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".animate-shimmer")).toHaveCount(0, { timeout: 20_000 });
}

/** Cierra la sesión desde el menú de usuario del shell. */
export async function logout(page: Page) {
  await shellUser(page).click();
  await page.getByRole("menuitem", { name: "Cerrar sesión" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/** Entra al ERP y espera el panel con la etiqueta del menú de usuario (`<Rol> · <Bodega>`). */
export async function erpLogin(page: Page, email: string, password: string, shellLabel: string) {
  await fillLogin(page, email, password);
  await expect(page.getByText("Tareas pendientes", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(shellUser(page)).toContainText(shellLabel);
}

/** Entra al back office con el segundo factor (código generado con el secreto de la persona). */
export async function backofficeLogin(page: Page, email: string, password: string, totpSecret: string) {
  await fillLogin(page, email, password);
  await expect(page.getByRole("heading", { name: "Verificación en dos pasos" })).toBeVisible();
  await page.getByLabel("Código de verificación").fill(await freshTotp(totpSecret));
  await expect(page.getByRole("heading", { name: "Tablero", level: 1 })).toBeVisible();
}

/** Enlace de navegación principal del ERP. */
export const erpNav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Navegación principal" }).getByRole("link", { name, exact: true }).click();

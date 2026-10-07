import type { Page } from "playwright-core";

/** Select a real visible group before its subtab; never click hidden controls. */
export async function settingsTab(page: Page, name: string) {
  const coach = [
    "Persona",
    "Model",
    "Preview",
    "Skills",
    "Memories",
    "Autonomy",
    "Worker",
  ].includes(name);
  const primary = page.locator(coach ? "#coachSettingsTab" : "#settingsTab");
  if ((await primary.getAttribute("aria-pressed")) !== "true")
    await primary.click();
  await page.getByRole("tab", { name, exact: true }).click();
}

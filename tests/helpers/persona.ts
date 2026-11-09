import type { Page } from "playwright-core";
import type { Store } from "../../src/config/store.js";
import {
  builtinPersonas,
  builtinProjection,
  defaultPersonaId,
  type PersonaFields,
} from "../../src/config/personas.js";
import { settingsTab } from "./settings-navigation.js";

/** Create a custom persona config from the active projection and select it. */
export async function useCustomPersona(
  store: Store,
  patch: Partial<PersonaFields>,
  label = "Synthetic custom " + Math.random().toString(36).slice(2, 8),
) {
  const id = await store.createPersona({
    label,
    persona: { ...store.publicConfig().persona, ...patch },
  });
  await store.selectPersona(id);
  return id;
}

/**
 * The first saved provider's name: a shared-Save text field (Persona edits
 * save through their own actions, never through the shared Save).
 */
export const sharedNameField = (page: Page) =>
  page.locator('#models [data-provider] input[data-field="name"]').first();

/** Draft a shared-Save change on Server Settings → Models. */
export async function draftSharedName(page: Page, name: string) {
  await settingsTab(page, "Models");
  await sharedNameField(page).fill(name);
}

export const savedSharedName = (store: Store) =>
  store.modelRegistry().providers[0].name;

/** Start an unsaved New persona draft on Coach Settings → Persona. */
export async function draftNewPersona(
  page: Page,
  name: string,
  label = name.slice(0, 100),
) {
  await settingsTab(page, "Persona");
  await page.locator("#newPersona").click();
  await page.locator("#personaLabel").fill(label);
  await page.locator("#name").fill(name);
}

/** GET /api/personas body for mocked Studio routes; the default stays active. */
export function personaViewFixture(
  revision = 1,
  custom: { id: string; label: string; persona: PersonaFields }[] = [],
) {
  const active = builtinPersonas.find((p) => p.id === defaultPersonaId)!;
  return {
    revision,
    active: { id: active.id, kind: "builtin", label: active.label },
    builtins: builtinPersonas.map((p) => ({
      id: p.id,
      kind: "builtin",
      label: p.label,
      description: p.description,
      instructions: p.instructions,
      persona: builtinProjection(p),
      readOnly: true,
    })),
    custom: custom.map((p) => ({ ...p, kind: "custom" })),
  };
}

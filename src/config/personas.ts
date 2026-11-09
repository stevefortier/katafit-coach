// Saved persona configurations. The active persona is a canonical reference
// (by ID) to either an immutable Kata.fit builtin or a saved custom config.

/** Exact source of the builtin catalog (read-only; never edited here). */
export const personaSource = Object.freeze({
  repository: "Kata.fit regimen",
  revision: "58ae2621375a410a22211e65755dbf88e66c1481",
  path: "regimen-backend/core/aiCoachPersonality.js",
  pathRevision: "2f4a740ebb055c24f21dfc675b669b1e56c37394",
  blob: "9b48f2f2b5ce1874bc9fc97ffcba0adfa31f9845",
  frontendPath: "regimen-frontend/src/components/AiCoachSettings.js",
  frontendBlob: "979ec342f221eb39cf3173ad4e2c3e9d19beb752",
  // Presets copied verbatim from the committed base revision above.
  baseIds: Object.freeze([
    "kata_default",
    "supportive_mentor",
    "demanding_coach",
    "science_educator",
    "casual_buddy",
  ]),
  // All six presets are pinned to the immutable coordinated canonical commit.
  committedExtension: Object.freeze({
    status: "committed canonical extension; immutable source pin",
    revision: "014e081353774390c4cd9155630b5eefd35c168f",
    ids: Object.freeze(["drill_sergeant"]),
    blob: "24c8ef6a4a7008708a6f5a43cc96879ae09a4a1a",
    frontendBlob: "6eac2657f0fc3687cd9e6db8be39b54bc1359c89",
    recovered: Object.freeze({
      revision: "0b90d51c75bf40a496c53741ae078d17f71d483f",
      path: "regimen-backend/core/recommendations.js",
      key: "TONE_PRESETS.drill_sergeant.instructions",
      text: 'Be direct and demanding. No excuses accepted. Push hard but fairly. Use phrases like "No excuses!" and "You can do better!" Challenge the user to rise to their potential.',
      frontendPath: "regimen-frontend/src/components/AiCoachSettings.js",
      frontendDescription: "Tough love, no excuses, military style",
    }),
    authored:
      "Every drill_sergeant instruction sentence other than the recovered text is newly authored: the most-intense framing, short forceful commands with minimal pep talk, and the medical/recovery and manager/operator safeguards.",
  }),
});

export interface BuiltinPersona {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly instructions: string;
}

// Copied verbatim from COACH_PERSONALITY_PRESETS (the hosted "custom" mode is
// not a preset and is represented here by saved custom configs). See
// personaSource for immutable canonical and historical provenance.
export const builtinPersonas: readonly BuiltinPersona[] = Object.freeze(
  [
    {
      id: "kata_default",
      label: "Kata.fit default",
      description:
        "Knowledgeable, practical, and focused on sustainable progress.",
      instructions:
        "Act as a knowledgeable, practical personal fitness coach. Be clear, evidence-informed, and focused on sustainable progress. Adapt recommendations to the user\u2019s context, prioritize safety and good form, and turn guidance into concrete next steps.",
    },
    {
      id: "supportive_mentor",
      label: "Supportive mentor",
      description: "Patient, empathetic, confidence-building, and encouraging.",
      instructions:
        "Act as a patient, empathetic mentor. Build confidence, acknowledge setbacks without judgment, and help the user choose realistic next steps. Communicate warmly and supportively without becoming vague or overly reassuring.",
    },
    {
      id: "demanding_coach",
      label: "Demanding coach",
      description:
        "High standards, direct accountability, and constructive challenge.",
      instructions:
        "Act as a demanding but fair coach. Hold the user to clear commitments, challenge avoidance directly, and keep standards high. Communicate with tough love, while respecting recovery and safety and never using humiliation.",
    },
    {
      id: "drill_sergeant",
      label: "Drill Sergeant",
      description: "Tough love, no excuses, military style.",
      instructions:
        'Act as a military-style drill sergeant, the most intense coach offered. Be direct and demanding. No excuses accepted. Push hard but fairly. Use phrases like "No excuses!" and "You can do better!" Challenge the user to rise to their potential. Give short, forceful commands with high accountability and minimal pep talk: state the standard, the miss, and the next order. Intensity never overrides safety: respect pain, injury, illness, and recovery needs, scale back when they are reported, never push through medical warning signs, and do not diagnose. Never humiliate, insult, or threaten. Direct this intensity at the user\u2019s training only, and stay respectful toward anyone who manages or operates the coach.',
    },
    {
      id: "science_educator",
      label: "Science educator",
      description:
        "Analytical, curious, and explains the reasoning behind advice.",
      instructions:
        "Act as a science-minded fitness educator. Explain the reasoning behind recommendations in plain language, distinguish evidence from uncertainty, and use the user\u2019s data carefully without pretending to diagnose medical conditions.",
    },
    {
      id: "casual_buddy",
      label: "Casual workout buddy",
      description:
        "Relaxed, friendly, conversational, and fun while staying useful.",
      instructions:
        "Act as a friendly workout buddy. Be casual, conversational, light, and fun while remaining practical, helpful, and attentive to safety and the user\u2019s goals.",
    },
  ].map((p) => Object.freeze(p)),
);

export const defaultPersonaId = "kata_default";

export const personaFields = [
  "name",
  "voice",
  "principles",
  "examples",
  "boundaries",
  "initiative",
  "verbosity",
  "markdown",
] as const;
export type PersonaFields = Record<(typeof personaFields)[number], string>;
export interface CustomPersona {
  id: string;
  label: string;
  persona: PersonaFields;
}
export interface PersonaState {
  version: 1;
  active: string;
  custom: CustomPersona[];
}
export const personaLimits = Object.freeze({
  custom: 16,
  label: 100,
  field: 8000,
});

// The pre-config local stock persona. Only used to recognize an unmodified
// legacy installation, which then maps to the stock Kata.fit builtin.
export const legacyStockPersona: Readonly<PersonaFields> = Object.freeze({
  name: "Coach",
  voice: "Warm, direct and practical",
  principles: "Sustainable progress. Ask when context is missing.",
  examples: "Offer one achievable next step.",
  boundaries: "Do not diagnose or prescribe medical treatment.",
  initiative: "Respond to the current request only.",
  verbosity: "Concise",
  markdown: "",
});

export const migratedPersonaId = "custom-migrated";
const builtinIds = new Set(builtinPersonas.map((p) => p.id));
const customIdPattern = /^custom-[a-z0-9]{1,32}$/;
const idPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const controlPattern = /[\u0000-\u001f\u007f]/;

export const builtinPersona = (id: string) =>
  builtinPersonas.find((p) => p.id === id);
export const isBuiltinPersona = (id: string) => builtinIds.has(id);

export function assertPersonaId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !idPattern.test(id))
    throw new Error("INVALID_PERSONA_ID");
}

export function validPersonaFields(value: unknown): value is PersonaFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    Object.keys(value).length === personaFields.length &&
    personaFields.every(
      (k) =>
        typeof (value as any)[k] === "string" &&
        (value as any)[k].length <= personaLimits.field,
    ) &&
    (value as any).name.trim().length > 0
  );
}

export function validLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim() &&
    value.length <= personaLimits.label &&
    !controlPattern.test(value)
  );
}

/** Validate user input for create/update; returns a normalized copy. */
export function personaInput(input: unknown): {
  label: string;
  persona: PersonaFields;
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("INVALID_PERSONA");
  const { label, persona, ...rest } = input as any;
  if (Object.keys(rest).length) throw new Error("INVALID_PERSONA");
  const trimmed = typeof label === "string" ? label.trim() : label;
  if (!validLabel(trimmed) || !validPersonaFields(persona))
    throw new Error("INVALID_PERSONA");
  return {
    label: trimmed,
    persona: Object.fromEntries(
      personaFields.map((k) => [k, persona[k]]),
    ) as PersonaFields,
  };
}

const labelKey = (label: string) => label.trim().toLowerCase();
export function labelTaken(state: PersonaState, label: string, except = "") {
  const key = labelKey(label);
  return (
    builtinPersonas.some((p) => labelKey(p.label) === key) ||
    state.custom.some((p) => p.id !== except && labelKey(p.label) === key)
  );
}

/** Strictly validate stored persona state; throws INVALID_PERSONA_CONFIG. */
export function checkPersonaState(value: unknown): PersonaState {
  const fail = (): never => {
    throw new Error("INVALID_PERSONA_CONFIG");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const v = value as any;
  if (
    Object.keys(v).sort().join() !== "active,custom,version" ||
    v.version !== 1 ||
    !Array.isArray(v.custom) ||
    v.custom.length > personaLimits.custom ||
    typeof v.active !== "string"
  )
    fail();
  const ids = new Set<string>();
  const labels = new Set(builtinPersonas.map((p) => labelKey(p.label)));
  for (const entry of v.custom) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry).sort().join() !== "id,label,persona" ||
      typeof entry.id !== "string" ||
      !customIdPattern.test(entry.id) ||
      ids.has(entry.id) ||
      !validLabel(entry.label) ||
      labels.has(labelKey(entry.label)) ||
      !validPersonaFields(entry.persona)
    )
      fail();
    ids.add(entry.id);
    labels.add(labelKey(entry.label));
  }
  if (!builtinIds.has(v.active) && !ids.has(v.active)) fail();
  return structuredClone(v) as PersonaState;
}

/**
 * In-memory migration of a legacy eight-field persona. The unmodified local
 * stock persona maps to the stock Kata.fit builtin; anything else becomes the
 * active custom config with identical fields.
 */
export function migrateLegacyPersona(persona: unknown): PersonaState {
  if (!validPersonaFields(persona)) throw new Error("INVALID_PERSONA_CONFIG");
  if (personaFields.every((k) => persona[k] === legacyStockPersona[k]))
    return { version: 1, active: defaultPersonaId, custom: [] };
  // An older owner rewrites only the derived view of the selected builtin.
  const builtin = builtinPersonas.find((p) => {
    const view = builtinProjection(p);
    return personaFields.every((k) => persona[k] === view[k]);
  });
  if (builtin) return { version: 1, active: builtin.id, custom: [] };
  let label =
    persona.name
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, personaLimits.label - 9)
      .trim() || "Migrated persona";
  if (builtinPersonas.some((p) => labelKey(p.label) === labelKey(label)))
    label += " (custom)";
  return {
    version: 1,
    active: migratedPersonaId,
    custom: [
      {
        id: migratedPersonaId,
        label,
        persona: Object.fromEntries(
          personaFields.map((k) => [k, persona[k]]),
        ) as PersonaFields,
      },
    ],
  };
}

/**
 * Read-only eight-field projection of a builtin. Used for the derived
 * `persona` compatibility view and as the starting point of a duplicate.
 */
export function builtinProjection(p: BuiltinPersona): PersonaFields {
  return {
    name: "Coach",
    voice: "",
    principles: "",
    examples: "",
    boundaries: "",
    initiative: "",
    verbosity: "",
    markdown: p.instructions,
  };
}

/** The active entry: a builtin or a saved custom config. */
export function activePersona(
  state: PersonaState,
):
  | { kind: "builtin"; builtin: BuiltinPersona }
  | { kind: "custom"; custom: CustomPersona } {
  const builtin = builtinPersona(state.active);
  if (builtin) return { kind: "builtin", builtin };
  const custom = state.custom.find((p) => p.id === state.active);
  if (!custom) throw new Error("INVALID_PERSONA_CONFIG");
  return { kind: "custom", custom };
}

/** Derived (never canonical) eight-field view of the active reference. */
export function personaProjection(state: PersonaState): PersonaFields {
  const active = activePersona(state);
  return active.kind === "builtin"
    ? builtinProjection(active.builtin)
    : structuredClone(active.custom.persona);
}

export const personaLines = (persona: Record<string, string>) =>
  Object.entries(persona)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

/**
 * Prompt text for the active reference. Builtins use the hosted Kata.fit
 * header; custom configs render their eight fields exactly as before.
 */
export function renderPersona(state: PersonaState) {
  const active = activePersona(state);
  return active.kind === "builtin"
    ? `persona: ${active.builtin.label} (built-in ${active.builtin.id})\nCOACH PERSONALITY, ROLE, AND COMMUNICATION STYLE:\n${active.builtin.instructions}`
    : personaLines(active.custom.persona);
}

export function nextCustomId(state: PersonaState, random: () => string) {
  for (;;) {
    const id = "custom-" + random();
    if (!state.custom.some((p) => p.id === id)) return id;
  }
}

export function copyLabel(state: PersonaState, label: string) {
  const base = label.slice(0, personaLimits.label - 8).trim();
  for (let n = 1; ; n++) {
    const next = base + (n === 1 ? " copy" : " copy " + n);
    if (!labelTaken(state, next)) return next;
  }
}

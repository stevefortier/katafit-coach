let key = "",
  workerState,
  config,
  authGeneration = 0;
// Presentation only: retain original instants in API data and JSON exports.
// Omit locale/timeZone overrides so the browser uses the viewer's settings.
const localTimestamp = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});
function formatTimestamp(value, fallback = "Time unavailable") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  // Calendar dates are not instants: never shift them across a day boundary.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? localTimestamp.format(date)
    : fallback;
}
function detailText(tag, value) {
  const element = document.createElement(tag);
  element.textContent = String(value ?? "");
  return element;
}
function renderOperatorActions(actions = []) {
  const labels = {
    delivered: "Delivered",
    completed: "Completed — backend receipt confirmed",
    pending: "Pending confirmation — do not resend",
    unknown: "Delivery unknown — refresh receipts before sending again",
    not_found: "No delivery found after session closed",
  };
  $("operatorActions").replaceChildren();
  for (const action of actions) {
    if (!Object.hasOwn(labels, action.status)) continue;
    $("operatorActions").append(
      detailText(
        "p",
        (action.tool_name && action.status === "unknown"
          ? "Action outcome unknown — do not retry; backend confirmation required"
          : labels[action.status]) +
          (action.tool_name ? " · " + action.tool_name : "") +
          (action.member_ref ? " · member " + action.member_ref : "") +
          (action.action_id ? " · " + action.action_id : ""),
      ),
    );
  }
  if (!actions.length) $("operatorActions").textContent = "";
  $("operatorReconcile").hidden = !actions.some((action) =>
    ["pending", "unknown"].includes(action.status),
  );
}

function staleAuthentication() {
  const error = new Error("Stale session response");
  error.stale = true;
  return error;
}
const $ = (id) => document.getElementById(id);
const sessionKey = "katafit-coach-admin";
function rememberedAdmin() {
  try {
    return sessionStorage.getItem(sessionKey) || "";
  } catch {
    return "";
  }
}
function rememberAdmin(value) {
  try {
    if (value) sessionStorage.setItem(sessionKey, value);
    else sessionStorage.removeItem(sessionKey);
  } catch {}
}
const fields = [
  "name",
  "voice",
  "principles",
  "examples",
  "boundaries",
  "initiative",
  "verbosity",
  "markdown",
];
const noticeLabels = {
  success: "Success",
  error: "Error",
  warning: "Warning",
  info: "Info",
  progress: "In progress",
};
// The single Studio notice surface. Every caller classifies its message
// explicitly; message text is never inspected to guess a severity.
function notice(message, severity) {
  const tone = !message
    ? ""
    : Object.hasOwn(noticeLabels, severity)
      ? severity
      : "info";
  const region = $("noticeRegion");
  region.setAttribute("role", tone === "error" ? "alert" : "status");
  region.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
  if (tone) $("noticeBar").dataset.severity = tone;
  else delete $("noticeBar").dataset.severity;
  $("noticeLabel").textContent = tone ? noticeLabels[tone] : "";
  $("noticeLabel").hidden = !tone;
  $("notice").textContent = tone ? message : "";
  syncStickyOffsets();
}
// The header wraps on narrow screens; the notice sticks directly beneath it
// and anchored scrolling clears both.
function syncStickyOffsets() {
  const root = document.documentElement.style;
  root.setProperty(
    "--header-offset",
    document.querySelector("header").offsetHeight + "px",
  );
  root.setProperty(
    "--notice-offset",
    $("noticeBar").dataset.severity
      ? $("noticeBar").offsetHeight + 8 + "px"
      : "0px",
  );
}
if (typeof ResizeObserver === "function") {
  const stickyObserver = new ResizeObserver(syncStickyOffsets);
  stickyObserver.observe(document.querySelector("header"));
  stickyObserver.observe($("noticeBar"));
}
syncStickyOffsets();
let lifecycleBusy = false;
let lifecycleUncertain = false;
let lifecycleOperation;
let serverTransition = false;
let statusEpoch = 0;
let updateRecoveryVisible = false;
const restartExplanation =
  "Coach will stop safely, apply this operation, then restart only if it was running. A stopped Coach stays stopped. Native sessions close; chat and actions are never replayed.";
function showLifecycle(value) {
  if (!value) return;
  const complete = value.phase === "complete";
  const failedRestart =
    complete && value.wasRunning && !value.resumed && !value.running;
  $("restartStatus").textContent = value.applicationUncertain
    ? "Application outcome is unconfirmed. " + value.hint
    : !complete
      ? "Coach operation in progress: " +
        value.phase +
        ". Closing this tab does not cancel it."
      : failedRestart
        ? (value.applied
            ? "Applied, but Coach is not running. "
            : "Nothing applied; Coach is not running. ") +
          (value.hint || "Check Worker status before restarting.")
        : value.error && value.running && !value.resumed
          ? "Nothing applied. Coach is still running the previous saved configuration. " +
            (value.hint ||
              "Safe shutdown failed; check Worker and native session status before retrying.")
          : value.error
            ? "Nothing applied. " +
              (value.resumed
                ? "The previous configuration is running again. "
                : "") +
              (value.hint || "Check the retained draft.")
            : value.resumed
              ? value.applied
                ? "Operation complete. Coach restarted with the saved configuration."
                : "The change was not applied. Coach is running the previous saved configuration."
              : "Operation complete. Coach remains stopped.";
  $("restartRetry").hidden =
    !failedRestart || value.error !== "COACH_RESTART_FAILED";
}
async function lifecycleApi(
  path,
  body,
  alreadyConfirmed = false,
  expectedRevision = config.revision,
) {
  if (lifecycleBusy || lifecycleUncertain) return null;
  const generation = authGeneration;
  lifecycleBusy = true;
  renderUpdate();
  try {
    const state = await api("status", undefined, AbortSignal.timeout(10000));
    let accepted = alreadyConfirmed;
    if (
      !alreadyConfirmed &&
      (state.state !== "stopped" || state.nativeActive)
    ) {
      if (!confirm(restartExplanation + " Apply now?")) {
        notice(
          "Operation cancelled. No settings changed and Coach was not stopped.",
          "info",
        );
        return null;
      }
      accepted = true;
    }
    lifecycleOperation = crypto.randomUUID();
    const result = await api(
      path,
      {
        ...body,
        confirmRestart: accepted,
        operationId: lifecycleOperation,
        expectedRevision,
      },
      AbortSignal.timeout(90000),
    );
    showLifecycle(result.lifecycle);
    return result;
  } catch (error) {
    if (generation !== authGeneration) throw error;
    if (error.lifecycle) showLifecycle(error.lifecycle);
    if (!error.status) {
      lifecycleUncertain = true;
      $("restartCheck").hidden = false;
      notice(
        "Connection lost. The server may still apply and restart Coach. Your draft is retained; check operation status before saving again.",
        "warning",
      );
      return null;
    }
    throw error;
  } finally {
    if (generation === authGeneration) {
      lifecycleBusy = false;
      renderUpdate();
    }
  }
}
action("restartCheck", async () => {
  await status();
});
action("restartRetry", async () => {
  if (lifecycleBusy) return;
  const generation = authGeneration;
  lifecycleBusy = true;
  renderUpdate();
  try {
    await api(updateData?.recovering ? "update/resume" : "run", {});
    await status();
  } finally {
    if (generation === authGeneration) {
      lifecycleBusy = false;
      renderUpdate();
    }
  }
});
async function api(path, body, signal) {
  const generation = authGeneration,
    requestKey = key;
  let r, data;
  try {
    r = await fetch("/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + requestKey,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      redirect: "error",
      cache: "no-store",
    });
    data = await r.json();
  } catch (error) {
    if (generation !== authGeneration || requestKey !== key)
      throw staleAuthentication();
    throw error;
  }
  if (generation !== authGeneration || requestKey !== key)
    throw staleAuthentication();
  if (!r.ok) {
    if (r.status === 401) {
      lockSession(
        "Studio authorization expired. Unlock again with the current admin key.",
        "error",
      );
      const error = new Error(
        "Studio authorization expired. Unlock again with the current admin key.",
      );
      error.status = 401;
      throw error;
    }
    const error = new Error(data.error + (data.hint ? " — " + data.hint : ""));
    error.status = r.status;
    error.code = data.error;
    error.lifecycle = data.lifecycle;
    throw error;
  }
  return data;
}
async function load(preserveDrafts = false) {
  const generation = authGeneration;
  const data = await api("config");
  if (generation !== authGeneration) throw staleAuthentication();
  config = data;
  renderCoachName();
  for (const f of fields) $(f).value = config.persona[f];
  if (!preserveDrafts || !modelsDraft) {
    $("origin").value = config.origin;
    $("token").value = "";
    modelsDraft = draftModels(savedModels());
    renderProviders();
  }
  renderModelStatus();
  $("revision").textContent = "Saved revision " + config.revision;
  clearPersonaHistory();
  if (historyVisible()) void loadPersonaHistory();
  $("prompt").textContent =
    "Preview the saved revision with freshly fetched backend instructions. Unsaved edits are not previewed.";
  $("answer").textContent = "Your preview will appear here.";
}
function action(id, fn) {
  $(id).onclick = async () => {
    try {
      await fn();
    } catch (e) {
      if (!e.stale) notice(e.message, "error");
    }
  };
}
action("unlock", async () => {
  authGeneration++;
  key = $("adminKey").value;
  $("adminKey").value = "";
  await load();
  rememberAdmin(key);
  notice("");
  $("login").hidden = true;
  $("studio").hidden = false;
  $("lockStudio").hidden = false;
  restoreStudioRoute(true);
  void loadNativeReceipts();
  void native.refreshHistory();
  await status();
  await refreshUpdate(true);
});
action("save", async () => {
  const persona = Object.fromEntries(fields.map((f) => [f, $(f).value]));
  const draft = modelsDraft;
  if (!draftActive(draft)) {
    notice(
      "Choose the active model to use after Save. The active model cannot be removed without choosing another.",
      "warning",
    );
    return;
  }
  const moved = draft.providers.find((p) => keyIntentMissing(p));
  if (moved) {
    notice(
      `Base URL changed for ${moved.name || "a provider"}: re-enter its API key or tick Remove saved key, then save.`,
      "warning",
    );
    return;
  }
  const result = await lifecycleApi("config", {
    persona,
    origin: $("origin").value,
    token: $("token").value,
    models: {
      active: { ...draft.active },
      providers: draft.providers.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        ...(p.apiKey ? { apiKey: p.apiKey } : {}),
        ...(p.clearApiKey && !p.apiKey ? { clearApiKey: true } : {}),
        models: p.models.map((m) => ({
          id: m.id,
          name: m.name.trim() || m.model,
          model: m.model,
          vision: m.vision,
        })),
      })),
    },
  });
  if (!result) return;
  await load();
  notice(
    result.lifecycle?.resumed
      ? "Saved. Coach restarted with the new revision."
      : "Saved. Check Coach status below.",
    "success",
  );
});
// Models registry editor. The draft lives in memory and in hidden-not-removed
// panels; nothing here contacts the Studio server or any provider until Save.
let modelsDraft;
const normalUrl = (url) => String(url).replace(/\/$/, "");
function savedModels() {
  if (config?.models) return config.models;
  // Older servers report only the single canonical provider.
  const provider = config?.provider ?? {};
  return {
    active: { provider: "default", model: "default" },
    providers: [
      {
        id: "default",
        name: "Default provider",
        baseUrl: provider.baseUrl ?? "",
        hasCredential: config?.hasApiKey === true,
        models: [
          {
            id: "default",
            name: provider.model ?? "",
            model: provider.model ?? "",
            vision: provider.vision === true,
          },
        ],
      },
    ],
  };
}
function draftModels(saved) {
  return {
    active: { ...saved.active },
    providers: saved.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      savedBaseUrl: p.baseUrl,
      hasCredential: p.hasCredential === true,
      apiKey: "",
      clearApiKey: false,
      models: p.models.map((m) => ({ ...m })),
    })),
  };
}
function draftActive(draft) {
  const provider = draft?.providers.find((p) => p.id === draft.active.provider);
  const model = provider?.models.find((m) => m.id === draft.active.model);
  return provider && model ? { provider, model } : null;
}
const keyIntentMissing = (p) =>
  p.hasCredential &&
  !p.apiKey &&
  !p.clearApiKey &&
  normalUrl(p.baseUrl) !== normalUrl(p.savedBaseUrl);
function comparableModels(m) {
  return JSON.stringify({
    active: m.active,
    providers: m.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: normalUrl(p.baseUrl),
      models: p.models.map(({ id, name, model, vision }) => ({
        id,
        name,
        model,
        vision: vision === true,
      })),
    })),
  });
}
function modelsDirty() {
  return (
    !!modelsDraft &&
    !!config &&
    (comparableModels(modelsDraft) !== comparableModels(savedModels()) ||
      modelsDraft.providers.some((p) => p.apiKey || p.clearApiKey))
  );
}
const modelLabel = (provider, model) =>
  `${provider.name} · ${model.name || model.model} (${model.model})${model.vision ? " · vision" : ""}`;
function renderModelStatus() {
  if (!config || !modelsDraft) {
    $("activeModelBadge").textContent = "";
    $("modelDraftStatus").textContent = "";
    return;
  }
  const saved = savedModels();
  const provider = saved.providers.find((p) => p.id === saved.active.provider);
  const model = provider?.models.find((m) => m.id === saved.active.model);
  $("activeModelBadge").textContent =
    provider && model
      ? "Saved active model: " +
        modelLabel(provider, model) +
        (provider.hasCredential ? "" : " · no API key saved")
      : "No saved active model.";
  const draft = draftActive(modelsDraft);
  $("modelDraftStatus").textContent = !draft
    ? "No draft active model. Choose one before saving."
    : draft.provider.id !== saved.active.provider ||
        draft.model.id !== saved.active.model
      ? "Draft selection: " +
        modelLabel(draft.provider, draft.model) +
        " — becomes active only after Save."
      : "";
  for (const card of $("providerList").querySelectorAll("[data-provider]")) {
    const p = modelsDraft.providers.find((x) => x.id === card.dataset.provider);
    if (!p) continue;
    card.querySelector(".key-status").textContent = keyStatus(p);
    card.querySelector('[data-field="clearApiKey"]').checked = p.clearApiKey;
    for (const radio of card.querySelectorAll('input[type="radio"]')) {
      const m = p.models.find((x) => x.id === radio.value);
      if (m)
        radio.setAttribute(
          "aria-label",
          `Use ${p.name || "provider"} · ${m.name || m.model || "model"} after Save`,
        );
    }
  }
}
function keyStatus(p) {
  if (p.apiKey) return "A new key will be saved privately for this base URL.";
  if (p.clearApiKey) return "The saved key will be removed on Save.";
  if (!p.hasCredential) return "No key saved.";
  if (keyIntentMissing(p))
    return "Base URL changed: re-enter the API key or remove the saved key before saving.";
  return "Key saved privately. Leave blank to keep it.";
}
function randomId(prefix) {
  return (
    prefix +
    "-" +
    [...crypto.getRandomValues(new Uint8Array(4))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}
function editorInput(label, value, attributes, onInput) {
  const wrapper = document.createElement("label");
  wrapper.textContent = label;
  const input = document.createElement("input");
  Object.assign(input, attributes);
  if (attributes.type === "checkbox" || attributes.type === "radio") {
    wrapper.className = "vision-option";
    input.checked = value;
    wrapper.prepend(input);
  } else {
    input.value = value;
    wrapper.append(input);
  }
  input.addEventListener(
    attributes.type === "checkbox" || attributes.type === "radio"
      ? "change"
      : "input",
    () => {
      onInput(input);
      renderModelStatus();
    },
  );
  return { wrapper, input };
}
function editorButton(label, actionName, onClick, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = label;
  button.dataset.action = actionName;
  if (disabled) button.dataset.fixed = "disabled";
  button.onclick = onClick;
  return button;
}
function renderProviders(focus) {
  const list = $("providerList");
  list.replaceChildren();
  if (!modelsDraft) return;
  const saved = config ? savedModels() : null;
  for (const p of modelsDraft.providers) {
    const card = document.createElement("section");
    card.className = "provider-card";
    card.dataset.provider = p.id;
    const header = document.createElement("div");
    header.className = "provider-header";
    const legend = document.createElement("h3");
    legend.id = `provider-title-${p.id}`;
    legend.textContent = p.name || "New provider";
    card.setAttribute("aria-labelledby", legend.id);
    const providerLabel = document.createElement("p");
    providerLabel.className = "registry-label";
    providerLabel.textContent = "Provider";
    header.append(providerLabel, legend);
    const connection = document.createElement("div");
    connection.className = "connection-group";
    const connectionTitle = document.createElement("h4");
    connectionTitle.textContent = "Connection";
    connection.append(connectionTitle);
    card.append(header, connection);
    const top = document.createElement("div");
    top.className = "split";
    const name = editorInput(
      "Provider name",
      p.name,
      { type: "text", maxLength: 100 },
      (input) => {
        p.name = input.value;
        legend.textContent = p.name || "New provider";
      },
    );
    name.input.dataset.field = "name";
    const base = editorInput(
      "API base URL",
      p.baseUrl,
      { type: "url", placeholder: "https://provider.example/v1" },
      (input) => (p.baseUrl = input.value),
    );
    base.input.dataset.field = "baseUrl";
    top.append(name.wrapper, base.wrapper);
    const key = editorInput(
      "API key",
      p.apiKey,
      {
        type: "password",
        autocomplete: "off",
        placeholder: p.hasCredential
          ? "Saved key hidden — leave blank to keep it"
          : "Enter this provider's API key",
      },
      (input) => {
        p.apiKey = input.value;
        if (p.apiKey) p.clearApiKey = false;
      },
    );
    key.input.dataset.field = "apiKey";
    const clear = editorInput(
      "Remove saved key on Save",
      p.clearApiKey,
      { type: "checkbox" },
      (input) => {
        p.clearApiKey = input.checked;
        if (p.clearApiKey) key.input.value = p.apiKey = "";
      },
    );
    clear.input.dataset.field = "clearApiKey";
    clear.wrapper.hidden = !p.hasCredential;
    const status = document.createElement("p");
    status.className = "hint key-status";
    status.setAttribute("aria-live", "polite");
    connection.append(top, key.wrapper, clear.wrapper, status);
    const modelsGroup = document.createElement("div");
    modelsGroup.className = "models-group";
    const modelsTitle = document.createElement("h4");
    modelsTitle.textContent = "Models";
    modelsGroup.append(modelsTitle);
    const rows = document.createElement("div");
    rows.className = "model-list";
    for (const m of p.models) {
      const row = document.createElement("div");
      row.className = "model-row";
      row.dataset.model = m.id;
      const modelHeader = document.createElement("div");
      modelHeader.className = "model-header";
      const title = document.createElement("h5");
      title.className = "model-title";
      const updateTitle = () => {
        title.textContent = m.name.trim() || m.model.trim() || "New model";
      };
      updateTitle();
      modelHeader.append(title);
      const pick = editorInput(
        "Active after Save",
        modelsDraft.active.provider === p.id &&
          modelsDraft.active.model === m.id,
        { type: "radio", name: "activeModel", value: m.id },
        () => (modelsDraft.active = { provider: p.id, model: m.id }),
      );
      pick.wrapper.classList.add("active-pick");
      if (
        saved &&
        saved.active.provider === p.id &&
        saved.active.model === m.id
      ) {
        const badge = document.createElement("span");
        badge.className = "saved-badge";
        badge.textContent = "Saved active";
        modelHeader.append(badge);
      }
      const fieldsRow = document.createElement("div");
      fieldsRow.className = "split";
      const label = editorInput(
        "Display name (optional)",
        m.name,
        { type: "text", maxLength: 100 },
        (input) => {
          m.name = input.value;
          updateTitle();
        },
      );
      label.input.dataset.field = "name";
      const id = editorInput(
        "Model ID",
        m.model,
        {
          type: "text",
          maxLength: 200,
          placeholder: "exact provider model ID",
        },
        (input) => {
          m.model = input.value;
          updateTitle();
        },
      );
      id.input.dataset.field = "model";
      fieldsRow.append(label.wrapper, id.wrapper);
      const vision = editorInput(
        "Vision-capable: allow original-image input",
        m.vision === true,
        { type: "checkbox" },
        (input) => (m.vision = input.checked),
      );
      vision.input.dataset.field = "vision";
      row.append(
        modelHeader,
        pick.wrapper,
        fieldsRow,
        vision.wrapper,
        editorButton(
          "Remove model",
          "removeModel",
          () => {
            p.models = p.models.filter((x) => x !== m);
            renderProviders(card.dataset.provider);
          },
          p.models.length < 2,
        ),
      );
      rows.append(row);
    }
    const tools = document.createElement("div");
    tools.className = "provider-actions";
    modelsGroup.append(
      rows,
      editorButton(
        "Add model",
        "addModel",
        () => {
          p.models.push({
            id: randomId("m"),
            name: "",
            model: "",
            vision: false,
          });
          renderProviders(p.id);
        },
        p.models.length >= 32,
      ),
    );
    tools.append(
      editorButton(
        "Remove provider",
        "removeProvider",
        () => {
          modelsDraft.providers = modelsDraft.providers.filter((x) => x !== p);
          renderProviders();
          $("addProvider").focus({ preventScroll: true });
        },
        modelsDraft.providers.length < 2,
      ),
    );
    card.append(modelsGroup, tools);
    list.append(card);
  }
  $("addProvider").dataset.fixed =
    modelsDraft.providers.length >= 16 ? "disabled" : "";
  applyEditorLock();
  renderModelStatus();
  if (focus)
    list
      .querySelector(
        `[data-provider="${focus}"] .model-row:last-child input[data-field="model"]`,
      )
      ?.focus({ preventScroll: true });
}
let editorsLocked = false;
function applyEditorLock() {
  for (const input of document.querySelectorAll(
    "#katafit input, #models input, #models select, #models button, #persona input, #persona textarea, #persona select, #skills input, #skills textarea, #skills button",
  ))
    input.disabled = editorsLocked || input.dataset.fixed === "disabled";
}
action("addProvider", async () => {
  if (!modelsDraft || modelsDraft.providers.length >= 16) return;
  const openai = $("providerPreset").value === "openai";
  const provider = {
    id: randomId("p"),
    name: openai ? "OpenAI" : "",
    baseUrl: openai ? "https://api.openai.com/v1" : "",
    savedBaseUrl: "",
    hasCredential: false,
    apiKey: "",
    clearApiKey: false,
    models: [
      {
        id: randomId("m"),
        name: openai ? "GPT-4.1 mini" : "",
        model: openai ? "gpt-4.1-mini" : "",
        vision: false,
      },
    ],
  };
  modelsDraft.providers.push(provider);
  renderProviders();
  $("providerList")
    .querySelector(`[data-provider="${provider.id}"] input[data-field="name"]`)
    ?.focus();
});
action("resetPersona", async () => {
  const { persona } = await api("persona-defaults");
  for (const f of fields) $(f).value = persona[f];
  notice(
    "Restored stock persona in the editor. Save a new revision to apply it.",
    "info",
  );
});
let skillsData,
  skillDrafts = new Map(),
  selectedSkill,
  skillsEpoch = 0,
  skillHistoryEpoch = 0;
const skillFields = ["purpose", "triggers", "instructions"];
function captureSkillDraft() {
  if (!selectedSkill || !skillsData) return;
  skillDrafts.set(selectedSkill, {
    enabled: $("skillEnabled").checked,
    purpose: $("skillPurpose").value,
    triggers: $("skillTriggers").value,
    instructions: $("skillInstructions").value,
  });
}
function skillDirty() {
  captureSkillDraft();
  if (!skillsData) return false;
  return skillsData.skills.some((saved) => {
    const draft = skillDrafts.get(saved.id);
    return (
      draft &&
      (draft.enabled !== saved.enabled ||
        skillFields.some((field) => draft[field] !== saved[field]))
    );
  });
}
function renderSkillDefault(skill) {
  $("skillDefaultSnapshot").replaceChildren();
  for (const field of ["enabled", ...skillFields]) {
    const term = document.createElement("dt");
    const value = document.createElement("dd");
    term.textContent = field;
    value.textContent = String(skill.default[field]);
    $("skillDefaultSnapshot").append(term, value);
  }
  $("skillDefaultStatus").textContent = skill.defaultUpdateAvailable
    ? `An updated default (version ${skill.defaultVersion}) is available for review. Your customized text is preserved until you restore it.`
    : `Default version ${skill.defaultVersion}. Restoring appends a new Skills revision.`;
}
function selectSkill(id, focus = false, capture = true) {
  if (capture) captureSkillDraft();
  const skill = skillsData?.skills.find((entry) => entry.id === id);
  if (!skill) return;
  selectedSkill = id;
  const draft = skillDrafts.get(id) ?? {
    enabled: skill.enabled,
    purpose: skill.purpose,
    triggers: skill.triggers,
    instructions: skill.instructions,
  };
  skillDrafts.set(id, draft);
  $("skillEditor").hidden = false;
  $("skillTitle").textContent = skill.name;
  $("skillLabel").textContent =
    skill.status === "customized" ? "Customized" : "Default";
  $("skillLabel").dataset.tone =
    skill.status === "customized" ? "caution" : "ready";
  $("skillEnabled").checked = draft.enabled;
  for (const field of skillFields)
    $("skill" + field[0].toUpperCase() + field.slice(1)).value = draft[field];
  for (const button of $("skillList").querySelectorAll("button"))
    button.setAttribute("aria-pressed", String(button.dataset.skill === id));
  renderSkillDefault(skill);
  $("skillSavedSnapshot").replaceChildren();
  for (const field of ["enabled", ...skillFields]) {
    const term = document.createElement("dt");
    const value = document.createElement("dd");
    term.textContent = field;
    value.textContent = String(skill[field]);
    $("skillSavedSnapshot").append(term, value);
  }
  applyEditorLock();
  if (focus) $("skillTitle").scrollIntoView({ block: "start" });
}
function renderSkills() {
  $("skillList").replaceChildren();
  if (!skillsData?.skills?.length) {
    $("skillsRevision").textContent = "No Coach skills are available.";
    $("skillEditor").hidden = true;
    return;
  }
  $("skillsRevision").textContent =
    `Saved Skills revision ${skillsData.revision}. ` +
    `${skillsData.skills.filter((skill) => skill.enabled).length} of ${skillsData.skills.length} enabled.`;
  for (const skill of skillsData.skills) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary skill-picker";
    button.dataset.skill = skill.id;
    button.setAttribute("aria-pressed", String(skill.id === selectedSkill));
    button.textContent =
      `${skill.name} · ${skill.status === "customized" ? "Customized" : "Default"}` +
      (skill.enabled ? "" : " · Disabled");
    button.onclick = () => selectSkill(skill.id, true);
    $("skillList").append(button);
  }
  selectSkill(
    skillsData.skills.some((skill) => skill.id === selectedSkill)
      ? selectedSkill
      : skillsData.skills[0].id,
    false,
    false,
  );
}
async function loadSkills(preserveDrafts = false) {
  if (!key) return;
  const generation = authGeneration,
    epoch = ++skillsEpoch;
  const data = await api("skills");
  if (generation !== authGeneration || epoch !== skillsEpoch) return;
  skillsData = data;
  if (!preserveDrafts) skillDrafts = new Map();
  renderSkills();
  if ($("skillHistory").open) void loadSkillHistory();
}
action("refreshSkills", async () => {
  if (!skillsData || updatePending) return;
  const generation = authGeneration;
  captureSkillDraft();
  await loadSkills(true);
  if (generation !== authGeneration) return;
  $("skillSavedReview").open = true;
  notice(
    "Latest saved Skills loaded. Your drafts are retained. Review the saved values before choosing Save skill; no write was retried.",
    "info",
  );
});
action("saveSkill", async () => {
  if (!selectedSkill || !skillsData || updatePending) return;
  captureSkillDraft();
  const id = selectedSkill;
  const draft = skillDrafts.get(id);
  const result = await lifecycleApi(
    "skills/" + id,
    draft,
    false,
    skillsData.revision,
  );
  if (!result) return;
  skillDrafts.delete(id);
  await loadSkills(true);
  notice(
    result.lifecycle?.resumed
      ? "Skill saved. Coach restarted with the new Skills revision."
      : "Skill saved as a new immutable revision.",
    "success",
  );
});
action("restoreSkill", async () => {
  if (!selectedSkill || !skillsData || updatePending) return;
  const id = selectedSkill;
  const skill = skillsData.skills.find((entry) => entry.id === id);
  if (
    !confirm(
      `Restore the current default for ${skill.name} as a new Skills revision? Your current draft for this skill will be replaced. ${restartExplanation}`,
    )
  ) {
    notice("Restore cancelled. No skill changed.", "info");
    return;
  }
  const result = await lifecycleApi(
    `skills/${selectedSkill}/restore-default`,
    {},
    true,
    skillsData.revision,
  );
  if (!result) return;
  skillDrafts.delete(id);
  await loadSkills(true);
  notice("Default restored as a new immutable Skills revision.", "success");
});
function skillHistoryVisible() {
  return (
    key &&
    !$("studio").hidden &&
    !$("settingsPanel").hidden &&
    !$("skills").hidden &&
    $("skillHistory").open
  );
}
async function loadSkillHistory() {
  if (!skillHistoryVisible()) return;
  const generation = authGeneration,
    epoch = ++skillHistoryEpoch;
  $("skillHistoryStatus").textContent = "Loading Skills revisions…";
  $("skillHistoryList").replaceChildren();
  $("skillHistoryDetail").hidden = true;
  try {
    const data = await api("skills/history");
    if (generation !== authGeneration || epoch !== skillHistoryEpoch) return;
    $("skillHistoryStatus").textContent =
      `${data.total} saved Skills revisions.`;
    for (const entry of data.items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = historyLabel(entry);
      button.onclick = () => selectSkillHistory(entry.revision);
      $("skillHistoryList").append(button);
    }
  } catch (error) {
    if (!error.stale && epoch === skillHistoryEpoch)
      $("skillHistoryStatus").textContent =
        "Could not load Skills history: " + error.message;
  }
}
async function selectSkillHistory(revision) {
  const generation = authGeneration,
    epoch = ++skillHistoryEpoch;
  try {
    const entry = await api("skills/history/" + revision);
    if (generation !== authGeneration || epoch !== skillHistoryEpoch) return;
    $("skillHistoryTitle").textContent = historyLabel(entry) + " — read-only";
    $("skillHistorySnapshot").replaceChildren();
    for (const skill of entry.skills) {
      const term = document.createElement("dt");
      const value = document.createElement("dd");
      term.textContent = skill.name;
      value.textContent =
        `${skill.enabled ? "Enabled" : "Disabled"} · ${skill.status === "customized" ? "Customized" : "Default"}\n` +
        `Purpose: ${skill.purpose}\nTriggers: ${skill.triggers}\nInstructions:\n${skill.instructions}`;
      $("skillHistorySnapshot").append(term, value);
    }
    $("skillHistoryDetail").hidden = false;
  } catch (error) {
    if (!error.stale && epoch === skillHistoryEpoch)
      $("skillHistoryStatus").textContent =
        "Could not read Skills revision: " + error.message;
  }
}
$("skillHistory").addEventListener("toggle", () => {
  if (skillHistoryVisible()) void loadSkillHistory();
  else {
    ++skillHistoryEpoch;
    $("skillHistoryList").replaceChildren();
    $("skillHistorySnapshot").replaceChildren();
    $("skillHistoryDetail").hidden = true;
  }
});
let historyEpoch = 0,
  historyBefore = null,
  historySelected = null,
  historyBusy = false;
function historyVisible() {
  return (
    key &&
    !$("studio").hidden &&
    !$("settingsPanel").hidden &&
    !$("persona").hidden &&
    $("personaHistory").open
  );
}
function clearPersonaHistory() {
  historyEpoch++;
  historyBefore = historySelected = null;
  $("historyList").replaceChildren();
  $("historySnapshot").replaceChildren();
  $("historyDetail").hidden = true;
  $("historyOlder").hidden = true;
  $("historyStatus").textContent = "";
}
const historyLabel = (e) =>
  `Revision ${e.revision} · ${e.current ? "Current · " : ""}${formatTimestamp(e.savedAt, "Save time unavailable")}`;
async function loadPersonaHistory(before) {
  if (!historyVisible()) return;
  const epoch = ++historyEpoch;
  historySelected = null;
  $("historyDetail").hidden = true;
  $("historyList").replaceChildren();
  $("historyStatus").textContent = "Loading revisions…";
  try {
    const data = await api(
      "persona-history" + (before ? "?before=" + before : ""),
    );
    if (epoch !== historyEpoch) return;
    historyBefore = data.nextBefore;
    $("historyOlder").hidden = !historyBefore;
    $("historyStatus").textContent =
      `${data.total} saved revisions. Select one to read all eight fields.`;
    for (const entry of data.items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = historyLabel(entry);
      button.dataset.revision = String(entry.revision);
      button.setAttribute("aria-pressed", "false");
      button.onclick = () => selectPersonaRevision(entry.revision);
      $("historyList").append(button);
    }
  } catch (e) {
    if (!e.stale && epoch === historyEpoch)
      $("historyStatus").textContent =
        "Could not load history: " +
        e.message +
        ". Use Latest revisions to retry.";
  }
}
async function selectPersonaRevision(revision) {
  if (historyBusy) return;
  const epoch = ++historyEpoch;
  historySelected = null;
  $("historyDetail").hidden = true;
  try {
    const entry = await api("persona-history/" + revision);
    if (epoch !== historyEpoch) return;
    historySelected = revision;
    for (const button of $("historyList").querySelectorAll("button"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.revision === String(revision)),
      );
    $("historyTitle").textContent = historyLabel(entry) + " — read-only";
    $("historySnapshot").replaceChildren();
    for (const field of fields) {
      const label = document.createElement("dt"),
        value = document.createElement("dd");
      label.textContent = field;
      value.textContent = entry.persona[field] || "(empty)";
      $("historySnapshot").append(label, value);
    }
    $("historyDetail").hidden = false;
    $("historyTitle").scrollIntoView({ block: "start" });
  } catch (e) {
    if (!e.stale && epoch === historyEpoch)
      $("historyStatus").textContent = "Could not read revision: " + e.message;
  }
}
$("personaHistory").addEventListener("toggle", () => {
  if (historyVisible()) void loadPersonaHistory();
  else clearPersonaHistory();
});
action("historyLatest", () => loadPersonaHistory());
action("historyOlder", () => loadPersonaHistory(historyBefore));
action("restorePersona", async () => {
  if (historyBusy || !historySelected || updatePending) return;
  const revision = historySelected,
    generation = authGeneration;
  const unsaved = fields.some((f) => $(f).value !== config.persona[f]);
  if (
    !confirm(
      `Restore revision ${revision} as a new latest revision? ${unsaved ? "Your unsaved persona edits will be replaced. " : ""}Saved Kata.fit and Models settings and credentials will not change. Unsaved Kata.fit and Models drafts will remain unsaved. History is kept. ${restartExplanation}`,
    )
  ) {
    notice("Restore cancelled. No settings changed.", "info");
    return;
  }
  historyBusy = true;
  $("restorePersona").disabled = true;
  try {
    if (!(await lifecycleApi("persona-restore", { revision }, true))) return;
    await load(true);
    $("personaHistory").querySelector("summary").focus({ preventScroll: true });
    notice(
      "Persona restored as a new revision. Kata.fit and Models drafts remain unsaved; saved settings and credentials are unchanged.",
      "success",
    );
  } finally {
    if (generation === authGeneration) {
      historyBusy = false;
      renderUpdate();
    }
  }
});
action("connect", async () =>
  notice((await api("connect", {})).message, "success"),
);
function hasUnsavedEdits() {
  return (
    fields.some((f) => $(f).value !== config.persona[f]) ||
    $("origin").value !== config.origin ||
    !!$("token").value ||
    modelsDirty() ||
    skillDirty()
  );
}
// Bind only conversational inputs, never persona/configuration editors.
function chatKeyboard(inputId, sendId) {
  const input = $(inputId);
  input.addEventListener("keydown", (event) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.defaultPrevented
    )
      return;
    event.preventDefault();
    if (event.repeat || input.disabled || input.readOnly || $(sendId).disabled)
      return;
    $(sendId).click();
  });
}

chatKeyboard("question", "previewButton");
let previewBusy = false;
let previewController;
// Retry waits for this tab's server cancel, so the cancel can neither refuse
// nor abort the next preview.
let previewCancelling = false;
const previewUnaffected = "Coach and native sessions were not affected.";
// Preview never stops, starts or restarts Coach or native sessions, so it
// needs no confirmation and a lost reply leaves no lifecycle uncertainty.
action("previewButton", async () => {
  const generation = authGeneration;
  if (!key || previewBusy || previewCancelling || !$("question").value.trim())
    return;
  if (hasUnsavedEdits()) {
    notice(
      "Unsaved edits: save a new revision or revert edits before previewing.",
      "warning",
    );
    return;
  }
  $("answer").textContent = "Preview pending.";
  $("prompt").textContent =
    "Fetching backend instructions; exact preview not yet available.";
  notice("Preview running with your saved provider…", "progress");
  previewBusy = true;
  const controller = (previewController = new AbortController());
  $("previewButton").disabled = true;
  renderUpdate();
  try {
    const r = await api(
      "preview",
      { text: $("question").value },
      AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
    );
    if (generation !== authGeneration || controller.signal.aborted) return;
    $("answer").textContent = r.text;
    $("prompt").textContent = r.prompt;
    notice("Preview complete · revision " + r.revision, "success");
  } catch (error) {
    if (generation !== authGeneration) return;
    $("answer").textContent = "No preview.";
    $("prompt").textContent =
      "Preview the saved revision with freshly fetched backend instructions. Unsaved edits are not previewed.";
    if (controller.signal.aborted || error.code === "CANCELLED")
      notice("Preview cancelled. " + previewUnaffected, "info");
    else
      notice(
        !error.status
          ? "Preview connection lost or timed out; the server cancels a disconnected preview. " +
              previewUnaffected +
              " Retry when ready."
          : error.message,
        "error",
      );
  } finally {
    if (previewController === controller) previewController = undefined;
    if (generation === authGeneration) {
      previewBusy = false;
      $("previewButton").disabled = false;
      renderUpdate();
    }
  }
});
action("cancel", async () => {
  // A repeated click must not send a second global cancel that could land
  // on the retry.
  if (previewCancelling) return;
  // Dropping this tab's request cancels its server preview even if the
  // explicit cancel below is lost; a late answer is never shown.
  const local = previewController;
  const generation = authGeneration;
  local?.abort();
  if (local) {
    previewCancelling = true;
    renderUpdate();
  }
  try {
    await api("cancel", {}, AbortSignal.timeout(10000));
  } catch (error) {
    if (!local) throw error;
  } finally {
    if (local && generation === authGeneration) {
      previewCancelling = false;
      renderUpdate();
    }
  }
  if (!local) notice("Cancellation requested.", "info");
});
for (const cmd of ["run", "stop"])
  action(cmd, async () => {
    const generation = authGeneration;
    const result = await api(cmd, {});
    await status();
    if (generation !== authGeneration) return;
    const reported = result.presence === "reported";
    if (cmd === "run" && reported)
      notice(
        "Worker started and presence reported. Wait for persisted-reply status to confirm delivery.",
        "success",
      );
    else if (cmd === "run")
      notice(
        "Worker started; this backend does not support explicit presence. Connectivity is not confirmed by a heartbeat.",
        "warning",
      );
    else if (reported)
      notice("Worker stopped; backend stop reported.", "success");
    else
      notice(
        "Worker stopped locally; backend stop unconfirmed. Chat may not fail immediately while the backend still considers this worker online.",
        "warning",
      );
  });
action("export", async () => {
  const c = await api("config");
  delete c.hasToken;
  delete c.hasApiKey;
  if (c.models) delete c.models.limits;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(c, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "katafit-coach-persona.json";
  a.click();
  URL.revokeObjectURL(url);
});
async function status() {
  if (!key || document.hidden) return;
  const generation = authGeneration;
  const epoch = ++statusEpoch;
  try {
    const s = await api("status");
    if (generation !== authGeneration || epoch !== statusEpoch) return;
    serverTransition = s.transition === true;
    workerState = s.state;
    if (s.lifecycle) showLifecycle(s.lifecycle);
    if (
      lifecycleUncertain &&
      s.lifecycle?.phase === "complete" &&
      (!lifecycleOperation || s.lifecycle.id === lifecycleOperation)
    ) {
      lifecycleUncertain = false;
      $("restartCheck").hidden = true;
      notice(
        "Operation status recovered. Your draft is retained. Check the saved revision before applying further edits.",
        "info",
      );
      if (s.lifecycle.applied) config.revision = s.revision;
    }
    renderHeaderStatus();
    updateWorkerBlocked = s.preview === true;
    renderUpdate();
    $("lastError").textContent = s.lastError
      ? "Last error · " +
        formatTimestamp(s.lastError.time) +
        " · " +
        s.lastError.code +
        " — " +
        s.lastError.hint
      : "No retained error.";
  } catch {}
}
function workerStatusTone(state) {
  if (
    [
      "idle",
      "reply-persisted",
      "task-result-stored",
      "task-publication-confirmed",
    ].includes(state)
  )
    return "ready";
  if (["connecting", "working", "task-working"].includes(state)) return "busy";
  if (
    [
      "stopped",
      "error",
      "failed",
      "task-failure-reported",
      "task-failure-unverified",
    ].includes(state)
  )
    return "danger";
  return "caution";
}
if (/^[a-f0-9]{64}$/i.test(location.hash.slice(1))) {
  $("adminKey").value = location.hash.slice(1);
  history.replaceState(null, "", location.pathname + location.search);
  $("unlock").click();
} else if (rememberedAdmin()) {
  $("adminKey").value = rememberedAdmin();
  $("unlock").click();
}
setInterval(status, 4000);

let logData = { entries: [] },
  logPaused = false,
  logTimer,
  logController;
const settingsSections = [
  "katafit",
  "models",
  "persona",
  "preview",
  "skills",
  "updates",
  "worker",
];
let settingsSection = "katafit";
function settingsPath() {
  return settingsSection === "katafit"
    ? "/settings"
    : "/settings?section=" + settingsSection;
}
function selectSettingsSection(section, navigate = true) {
  // The former Connection section's links open its Kata.fit successor.
  if (section === "connection") section = "katafit";
  settingsSection = settingsSections.includes(section) ? section : "katafit";
  for (const name of settingsSections) {
    const selected = name === settingsSection;
    $(name).hidden = !selected;
    const tab = $("settings-" + name + "-tab");
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    tab.classList.toggle("secondary", !selected);
  }
  if (navigate) navigateStudio(settingsPath());
  if (settingsSection === "skills" && key && !skillsData)
    void loadSkills().catch((error) => {
      if (!error.stale) $("skillsRevision").textContent = error.message;
    });
  if (historyVisible()) void loadPersonaHistory();
  if (skillHistoryVisible()) void loadSkillHistory();
  logVisibility();
}
for (const [index, section] of settingsSections.entries()) {
  const tab = $("settings-" + section + "-tab");
  tab.onclick = () => selectSettingsSection(section);
  tab.onkeydown = (event) => {
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? settingsSections.length - 1
          : event.key === "ArrowRight"
            ? (index + 1) % settingsSections.length
            : event.key === "ArrowLeft"
              ? (index + settingsSections.length - 1) % settingsSections.length
              : null;
    if (next === null || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    selectSettingsSection(settingsSections[next]);
    $("settings-" + settingsSections[next] + "-tab").focus({
      preventScroll: true,
    });
  };
}
const diagnosticsSections = ["performance", "logs"];
let diagnosticsSection = "logs";
function selectDiagnosticsSection(section, navigate = true) {
  diagnosticsSection = diagnosticsSections.includes(section) ? section : "logs";
  for (const name of diagnosticsSections) {
    const selected = name === diagnosticsSection;
    $(name === "performance" ? "backendPerformance" : "logsView").hidden =
      !selected;
    const tab = $("diagnostics-" + name + "-tab");
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    tab.classList.toggle("secondary", !selected);
  }
  if (navigate) navigateStudio("/diagnostics?section=" + diagnosticsSection);
}
for (const [index, section] of diagnosticsSections.entries()) {
  const tab = $("diagnostics-" + section + "-tab");
  tab.onclick = () => selectDiagnosticsSection(section);
  tab.onkeydown = (event) => {
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? 1
          : event.key === "ArrowRight" || event.key === "ArrowLeft"
            ? 1 - index
            : null;
    if (next === null || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    selectDiagnosticsSection(diagnosticsSections[next]);
    $("diagnostics-" + diagnosticsSections[next] + "-tab").focus({
      preventScroll: true,
    });
  };
}
function renderCoachName() {
  const name =
    key && typeof config?.persona?.name === "string"
      ? config.persona.name.trim()
      : "";
  const label = name || "Coach";
  $("coachTab").textContent = label;
  $("coachTab").title = label;
}
function studioRoute() {
  if (location.pathname === "/diagnostics")
    return {
      tab: "diagnostics",
      section: new URLSearchParams(location.search).get("section"),
    };
  if (location.pathname === "/settings") {
    const section =
      new URLSearchParams(location.search).get("section") ??
      (location.hash === "#logsView" ? "diagnostics" : location.hash.slice(1));
    return section === "diagnostics"
      ? { tab: "diagnostics", legacy: true }
      : { tab: "settings", section };
  }
  return {
    tab: "coach",
    legacy: location.pathname.startsWith("/chat/member/"),
  };
}
function navigateStudio(path) {
  if (location.pathname + location.search + location.hash !== path)
    history.pushState(null, "", path);
}
function restoreStudioRoute(restartDiagnostics = false) {
  const route = studioRoute();
  if (route.legacy)
    history.replaceState(
      null,
      "",
      route.tab === "coach" ? "/chat/operator" : "/diagnostics",
    );
  if (route.tab === "settings") selectSettingsSection(route.section, false);
  if (route.tab === "diagnostics")
    selectDiagnosticsSection(route.section, false);
  if (
    restartDiagnostics ||
    route.tab !== "diagnostics" ||
    $("diagnostics").hidden
  )
    selectStudioTab(route.tab, false);
}
window.addEventListener("popstate", () => {
  if (key) restoreStudioRoute();
});
window.addEventListener("hashchange", () => {
  if (
    key &&
    location.pathname === "/settings" &&
    !/^[a-f0-9]{64}$/i.test(location.hash.slice(1))
  )
    restoreStudioRoute();
});
function selectStudioTab(tab, navigate = true) {
  const coach = tab === "coach";
  $("coachPanel").hidden = !coach;
  $("settingsPanel").hidden = tab !== "settings";
  $("diagnostics").hidden = tab !== "diagnostics";
  if (historyVisible()) void loadPersonaHistory();
  for (const [id, active] of [
    ["coachTab", coach],
    ["settingsTab", tab === "settings"],
    ["diagnosticsTab", tab === "diagnostics"],
  ]) {
    $(id).setAttribute("aria-pressed", String(active));
    $(id).classList.toggle("secondary", !active);
  }
  logVisibility();
  if (coach) operatorSnapshotLabel();
  if (navigate)
    navigateStudio(
      coach
        ? "/chat/operator"
        : tab === "diagnostics"
          ? "/diagnostics?section=" + diagnosticsSection
          : settingsPath(),
    );
}
$("coachTab").onclick = () => selectStudioTab("coach");
$("settingsTab").onclick = () => selectStudioTab("settings");
$("diagnosticsTab").onclick = () => selectStudioTab("diagnostics");
const logActive = () => key && !$("diagnostics").hidden && !document.hidden;
function filteredLogs() {
  return logData.entries.filter(
    (e) =>
      (!performanceSelection ||
        BackendPerformance.identity(e)?.key === performanceSelection.key) &&
      ($("logLevel").value === "all" || e.level === $("logLevel").value),
  );
}
let performanceData = null,
  logReadError = "",
  logLoading = false,
  performanceSelection = null,
  performanceSignature = "";
const performanceMs = (n) =>
  n === null
    ? "—"
    : n.toLocaleString(undefined, { maximumFractionDigits: 1 }) + " ms";
const performanceRate = BackendPerformance.rate;
function logReadStatus() {
  if (!performanceData)
    return logLoading
      ? "Loading activity snapshot…"
      : logReadError
        ? "Unable to load activity snapshot. Use Refresh to retry."
        : "Activity snapshot not loaded. Use Refresh to load.";
  return logLoading
    ? "Last loaded snapshot · Refreshing…"
    : logReadError
      ? "Last loaded snapshot · Refresh failed. Use Refresh to retry."
      : "Last loaded snapshot";
}
function renderPerformance() {
  $("performanceExport").disabled = !key || !performanceData;
  if (!performanceData) {
    $("performanceWindow").textContent = logReadStatus();
    $("performanceRows").replaceChildren();
    performanceSignature = "";
    $("performanceClear").hidden = true;
    $("performanceSelection").textContent = "";
    return;
  }
  const w = performanceData.window;
  $("performanceWindow").textContent =
    `${logReadStatus()} · ${w.receiptCount} receipts · ${w.measuredCalls} duration samples · ${BackendPerformance.duration(w.measuredCalls ? performanceData.totalMs : null)} cumulative · ${w.retainedEntries} retained entries (capacity ${w.capacity}) · Oldest receipt: ${formatTimestamp(w.oldestReceipt)} · Newest receipt: ${formatTimestamp(w.newestReceipt)}${w.invalidTimestampCount ? ` · ${w.invalidTimestampCount} timestamps unavailable` : ""}`;
  const rows = BackendPerformance.sort(
    performanceData.groups,
    $("performanceSort").value,
  );
  const signature = JSON.stringify([rows, performanceSelection]);
  if (signature !== performanceSignature) {
    const focusedKey = document.activeElement?.dataset.performanceKey;
    performanceSignature = signature;
    const nodes = rows.map((r) => {
      const row = document.createElement("article");
      row.className = "performance-row";
      const button = document.createElement("button");
      button.className = "secondary";
      button.textContent = r.name;
      button.dataset.performanceKey = r.key;
      button.setAttribute(
        "aria-pressed",
        String(performanceSelection?.key === r.key),
      );
      button.onclick = () => {
        performanceSelection = { key: r.key, name: r.name };
        $("logLevel").value = "all";
        renderLogs();
        selectDiagnosticsSection("logs");
        $("performanceClear").focus({ preventScroll: true });
      };
      const primary = document.createElement("strong");
      primary.textContent = `${r.calls} calls · ${BackendPerformance.duration(r.measuredCalls ? r.totalMs : null)} cumulative · ${performanceRate(r.share)} of backend time`;
      const duration = document.createElement("small");
      duration.textContent = `Avg ${performanceMs(r.averageMs)} · Median ${performanceMs(r.medianMs)} · p95 ${performanceMs(r.p95Ms)}${r.measuredCalls < 20 ? " (small sample)" : ""} · Max ${performanceMs(r.maxMs)} · ${r.measuredCalls} measured / ${r.missingDurationCalls} missing durations`;
      const outcomes = document.createElement("small");
      outcomes.textContent = `Timeouts ${r.timeouts} (${performanceRate(r.timeoutRate)}) · Other failures ${r.otherFailures} (${performanceRate(r.otherFailureRate)}) · Cancellations ${r.cancellations} (${performanceRate(r.cancellationRate)}) · Unknown outcomes ${r.unknownOutcomes} · Failed time ${BackendPerformance.duration(r.measuredCalls ? r.failedTimeMs : null)} (${performanceRate(r.failedTimeShare)} of call time)`;
      row.append(button, primary, duration, outcomes);
      return row;
    });
    $("performanceRows").replaceChildren(...nodes);
    if (focusedKey) {
      const focused = [...$("performanceRows").querySelectorAll("button")].find(
        (button) => button.dataset.performanceKey === focusedKey,
      );
      (focused || $("performanceSort")).focus({ preventScroll: true });
    }
    if (!rows.length)
      $("performanceRows").textContent = "No retained backend receipts.";
  }
  $("performanceClear").hidden = !performanceSelection;
  $("performanceSelection").textContent = performanceSelection
    ? `Call: ${performanceSelection.name}. Level: ${$("logLevel").selectedOptions[0].textContent}. Selecting a call switches to All levels; changing Level narrows its receipts. Clear keeps the current level. Raw exports contain only shown rows.`
    : "Select a call in Performance to inspect its receipts across All levels. Raw exports contain only shown rows.";
}
$("performanceSort").onchange = renderPerformance;
$("performanceClear").onclick = () => {
  performanceSelection = null;
  renderLogs();
  $("logLevel").focus({ preventScroll: true });
};
action("performanceExport", async () => {
  if (!key || !performanceData) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(performanceData, null, 2)], {
      type: "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "coach-backend-performance.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
let logNodes = new Map();
function renderLogs() {
  renderPerformance();
  if (!performanceData) {
    $("logRows").replaceChildren();
    $("logStatus").textContent = logReadStatus();
    return;
  }
  const rows = filteredLogs();
  const nextNodes = new Map();
  const occurrences = new Map();
  const ordered = [];
  for (const e of [...rows].reverse()) {
    const serialized = JSON.stringify(e);
    const occurrence = occurrences.get(serialized) ?? 0;
    occurrences.set(serialized, occurrence + 1);
    const nodeKey = serialized + ":" + occurrence;
    const existing = logNodes.get(nodeKey);
    if (existing) {
      nextNodes.set(nodeKey, existing);
      ordered.push(existing);
      continue;
    }
    const row = document.createElement("article");
    row.className = "log-entry log-" + e.level;
    const title = document.createElement("strong");
    // Descriptors have passed the fixed-vocabulary sanitizer at capture and
    // restore. Never infer a missing historical or unknown tool name.
    const call = e.backendCall;
    const callName = call
      ? call.tool && call.tool !== "other"
        ? call.tool
        : call.operation === "tools/call"
          ? "tools/call — tool name unavailable"
          : call.operation && call.operation !== "other"
            ? call.operation
            : `${call.method} ${call.route}`
      : e.source === "backend" && e.stage === "backend-call"
        ? "Backend call — name unavailable"
        : undefined;
    title.textContent =
      (callName
        ? callName + " · " + e.level.toUpperCase()
        : e.level.toUpperCase() + " · " + e.source + " / " + e.stage) +
      (e.code ? " · " + e.code : "");
    const meta = document.createElement("small");
    meta.textContent =
      formatTimestamp(e.time) +
      (e.ref ? " · ref " + e.ref : "") +
      " · " +
      JSON.stringify(e.metadata);
    row.append(title, meta);
    if (e.backendCall) {
      const call = e.backendCall;
      const summary = document.createElement("p");
      summary.className = "backend-call-summary";
      summary.textContent = `${call.method} ${call.route} · ${call.operation ?? "request"}${call.tool ? " / " + call.tool : ""} · ${e.metadata.elapsedMs ?? "?"} ms${e.metadata.statusCode ? " · HTTP " + e.metadata.statusCode : ""} · ${call.outcome}`;
      row.insertBefore(summary, meta);
    }
    if (e.shape) {
      const shape = document.createElement("p");
      shape.textContent = `Outbound: ${e.shape.toolChoice} · ${e.shape.toolCount} native tools (${e.shape.toolNames.join(", ")}) · ${e.shape.messageCount} messages · last ${e.shape.lastRole}/${e.shape.lastContentShape}`;
      row.append(shape);
    }
    if (e.preview) {
      const preview = document.createElement("p");
      preview.textContent = `Screened outbound excerpt (not raw JSON): ${e.preview}`;
      row.append(preview);
    }
    if (e.texts?.length || e.calls?.length || e.receipt) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `Model turn ${e.metadata.turn ?? "?"} · screened text / native calls / execution (private)`;
      details.append(summary);
      for (const item of e.texts ?? []) {
        const text = document.createElement("pre");
        text.className = "model-text";
        text.textContent = `${item.role}: ${item.text}`;
        details.append(text);
      }
      for (const call of e.calls ?? []) {
        const line = document.createElement("p");
        line.textContent = `Native ${call.name} · argument keys: ${call.argumentKeys.join(", ") || "none"}`;
        details.append(line);
        if (call.arguments) {
          const args = document.createElement("pre");
          args.className = "model-text";
          args.textContent = `Screened native arguments: ${call.arguments}`;
          details.append(args);
        }
      }
      if (e.receipt) {
        const line = document.createElement("p");
        line.textContent = `${e.receipt.name} · ${e.receipt.outcome} · ${e.receipt.phase ?? "execution"}${e.receipt.code ? ` · ${e.receipt.code}` : ""} · media received: ${e.receipt.media ? "yes" : "no"}`;
        details.append(line);
      }
      row.append(details);
    }
    if (e.hint) {
      const hint = document.createElement("p");
      hint.textContent = e.hint;
      row.append(hint);
    }
    if (e.rejection) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `Rejected ${e.rejection.kind} output · attempt ${e.rejection.attempt} · view full reason and text (private)`;
      const reason = document.createElement("p");
      reason.textContent = `Reject reason: ${e.rejection.reason}`;
      const text = document.createElement("pre");
      text.className = "rejected-output";
      text.textContent = e.rejection.text;
      details.append(summary, reason, text);
      row.append(details);
    }
    nextNodes.set(nodeKey, row);
    ordered.push(row);
  }
  // Reuse unchanged rows (including open disclosures) rather than rebuilding
  // 5000 articles every live poll. No display cap; exports use the same filter.
  const container = $("logRows");
  const keep = new Set(ordered);
  for (const child of [...container.childNodes])
    if (!keep.has(child)) child.remove();
  let cursor = container.firstChild;
  for (const row of ordered) {
    if (row !== cursor) container.insertBefore(row, cursor);
    else cursor = cursor.nextSibling;
  }
  logNodes = nextNodes;
  if (!rows.length) $("logRows").textContent = "No entries match this level.";
  $("logStatus").textContent =
    `${rows.length} shown / ${logData.entries.length} retained (max ${logData.capacity ?? 5000}) · ${logPaused ? "Paused" : "Live while visible"} · ${logData.persistence === false ? "Disk logging unavailable; memory only" : "Protected rotating files"}`;
}
async function refreshLogs() {
  clearTimeout(logTimer);
  if (!logActive() || logController) return;
  const controller = new AbortController();
  logController = controller;
  logLoading = true;
  logReadError = "";
  renderLogs();
  try {
    const data = await api("logs", undefined, controller.signal);
    if (!controller.signal.aborted && logActive()) {
      logData = data;
      performanceData = BackendPerformance.aggregate(logData);
      logLoading = false;
      renderLogs();
      await status();
    }
  } catch (e) {
    if (!controller.signal.aborted && logActive()) {
      logLoading = false;
      logReadError = e.message;
      renderPerformance();
      $("logStatus").textContent = performanceData
        ? e.message
        : logReadStatus();
    }
  } finally {
    if (logController === controller) {
      logController = undefined;
      if (logActive() && !logPaused) logTimer = setTimeout(refreshLogs, 2000);
    }
  }
}
function logVisibility() {
  clearTimeout(logTimer);
  logController?.abort();
  logController = undefined;
  logLoading = false;
  if (key) renderLogs();
  if (logActive() && !logPaused) refreshLogs();
}
document.addEventListener("visibilitychange", logVisibility);
action("logRefresh", refreshLogs);
action("logPause", async () => {
  logPaused = !logPaused;
  $("logPause").textContent = logPaused ? "Resume live" : "Pause live";
  $("logPause").setAttribute("aria-pressed", String(logPaused));
  logVisibility();
  renderLogs();
});
$("logLevel").onchange = renderLogs;
const logJSON = () =>
  JSON.stringify(
    {
      ...logData,
      entries: filteredLogs(),
      update: {
        installed: sourceSha(updateData?.installed)
          ? updateData.installed
          : null,
        latest: sourceSha(updateData?.latest) ? updateData.latest : null,
        lastOperation: safeUpdateOperation(updateData?.lastOperation),
      },
    },
    null,
    2,
  );
action("logCopy", async () => {
  await navigator.clipboard.writeText(logJSON());
  notice(
    "Diagnostic JSON copied. Model-visible health and meal text may remain even after screening; inspect and redact before sharing.",
    "warning",
  );
});
action("logDownload", async () => {
  const url = URL.createObjectURL(
    new Blob([logJSON()], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "katafit-coach-diagnostics.json";
  a.click();
  URL.revokeObjectURL(url);
});

let updateData,
  updateClockOffset = 0,
  updateRequest = false,
  updateCheckRequested = false,
  updatePending = false,
  updateWorkerBlocked = true,
  updateError = "",
  updateTimer,
  updateController,
  updateTarget,
  updateInitialRevision;
const sourceSha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const updateFailureHelp = {
  EXTERNAL_ARTIFACT_BOOTSTRAP_REQUIRED:
    "Matching native artifact or bootstrap required. Provision and preflight the exact candidate image outside Pi. Manual updates need another confirmation; opted-in automatic updates retry after cooldown. The updater never builds or pulls sandbox images.",
  INSUFFICIENT_DISK:
    "Not enough free disk. Free at least 1.5 GiB in the Coach home filesystem, then retry manually.",
  BUILD_TOOL_UNAVAILABLE:
    "A required build tool could not start. Check Git, npm and Node in the launcher environment.",
  BUILD_FAILED:
    "Source build or candidate probe failed or exceeded a resource/time limit. Check disk, Git/npm network access and candidate compatibility.",
  BUILD_CANCELLED:
    "Preparation was cancelled. Check that the service is running before retrying.",
  INCOMPATIBLE_BUILD:
    "Candidate metadata is incompatible. Verify the reviewed source and installed launcher protocol.",
  SOURCE_MISMATCH:
    "Candidate source did not match the approved revision. Do not bypass source verification.",
  PACKAGE_REJECTED:
    "Candidate package identity was rejected. Do not bypass package verification.",
  UNSAFE_PATH:
    "An unsafe managed path was rejected. Check protected home ownership and symlinks without deleting live files.",
  ACTIVATION_ROLLED_BACK:
    "Candidate activation failed and rollback was attempted. Verify the installed revision and worker status before retrying.",
  STARTUP_FAILED:
    "Candidate startup failed. Verify launcher compatibility and the installed revision.",
  STARTUP_TIMEOUT:
    "Candidate startup timed out. Verify host resources and the installed revision.",
  HEALTH_FAILED:
    "Candidate health check failed. Verify the installed revision and worker status.",
  AUTO_UPDATE_DISABLED:
    "Automatic consent was withdrawn before activation. Review the setting before a manual retry.",
  UPGRADE_FAILED:
    "No specific safe failure code is available. Check host disk, Git/npm access and exact native artifact readiness before retrying manually.",
};
const updateOutcomeNames = {
  applying: "Upgrade accepted",
  succeeded: "Last upgrade succeeded",
  failed: "Last upgrade failed",
  interrupted: "Last upgrade was interrupted",
};
function safeUpdateOperation(outcome) {
  if (
    !outcome ||
    !sourceSha(outcome.sha) ||
    typeof outcome.id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      outcome.id,
    ) ||
    !Object.hasOwn(updateOutcomeNames, outcome.state) ||
    !Number.isSafeInteger(outcome.at) ||
    outcome.at <= 0 ||
    !Number.isFinite(new Date(outcome.at).getTime())
  )
    return undefined;
  return {
    id: outcome.id,
    sha: outcome.sha,
    state: outcome.state,
    at: outcome.at,
    ...(["preparing", "activating"].includes(outcome.phase)
      ? { phase: outcome.phase }
      : {}),
    ...(outcome.state === "failed" &&
    Object.hasOwn(updateFailureHelp, outcome.reason)
      ? { reason: outcome.reason }
      : {}),
  };
}
function renderHeaderStatus() {
  if (!key || $("studio").hidden) return;
  if (lifecycleBusy || lifecycleUncertain || serverTransition) {
    $("state").textContent = "APPLYING";
    $("state").dataset.tone = "busy";
  } else if (
    updatePending ||
    updateData?.preparing === true ||
    updateData?.applying === true
  ) {
    $("state").textContent =
      updateData?.preparing === true && updateData?.applying !== true
        ? "PREPARING"
        : "UPGRADING";
    $("state").dataset.tone = "busy";
  } else if (workerState) {
    $("state").textContent = workerState.toUpperCase();
    $("state").dataset.tone = workerStatusTone(workerState);
  }
}
function renderUpdateSchedule() {
  const data = updateData;
  if (!data || !key || document.hidden || $("studio").hidden) return;
  const schedule = data.autoSchedule;
  let text;
  if (!data.auto?.enabled) {
    text = "No automatic retry while automatic updates are off.";
  } else if (!schedule) {
    text =
      "Automatic retry time unknown: this older launcher does not report its schedule. Source upgrades do not replace the stable launcher.";
  } else if (schedule.reason === "running" && schedule.nextAttemptAt === null) {
    text =
      "Launcher automatic cycle in progress; next attempt is not scheduled yet.";
  } else if (
    Number.isSafeInteger(schedule.nextAttemptAt) &&
    schedule.nextAttemptAt > 0 &&
    ["poll", "check-failed", "readiness", "recovery"].includes(schedule.reason)
  ) {
    const reasons = {
      poll: "Normal polling.",
      "check-failed": "Source-check failure backoff.",
      readiness: "Native readiness cooldown.",
      recovery: "Worker recovery retry (before another source check).",
    };
    const localDeadline = schedule.nextAttemptAt - updateClockOffset;
    const seconds = Math.max(0, Math.ceil((localDeadline - Date.now()) / 1000));
    const local = formatTimestamp(localDeadline);
    text = `${reasons[schedule.reason]} ${
      seconds > 0
        ? `Next automatic attempt in ${Math.floor(seconds / 60)}m ${seconds % 60}s · ${local} (local time).`
        : `Scheduled for ${local} (local time). Awaiting launcher status; the deadline passing does not confirm a check has started.`
    }`;
  } else {
    text =
      "Automatic retry time unknown: the launcher has not reported a valid schedule.";
  }
  if (updateError && data.auto?.enabled)
    text = `Last reported schedule (Studio unavailable). ${text}`;
  if ($("updateSchedule").textContent !== text)
    $("updateSchedule").textContent = text;
}
setInterval(() => {
  if (!$("settingsPanel").hidden && !$("updates").hidden)
    renderUpdateSchedule();
}, 1000);
function renderUpdate() {
  renderHeaderStatus();
  const data = updateData;
  $("restorePersona").disabled =
    historyBusy || updatePending || data?.applying === true;
  if (!data) return;
  renderUpdateSchedule();
  const locked =
    updatePending ||
    data.applying ||
    data.recovering ||
    lifecycleBusy ||
    lifecycleUncertain ||
    serverTransition;
  const outcome = safeUpdateOperation(data.lastOperation);
  const failed = outcome && ["failed", "interrupted"].includes(outcome.state);
  const failedLatest =
    failed && outcome.sha === data.latest && outcome.sha !== data.installed;
  $("updateReload").hidden =
    locked ||
    !sourceSha(data.installed) ||
    data.installed === updateInitialRevision;
  $("updateInstalled").textContent = sourceSha(data.installed)
    ? data.installed.slice(0, 12)
    : "Unknown / local build";
  $("updateInstalled").title = sourceSha(data.installed)
    ? data.installed
    : "This build has no verified source revision.";
  $("updateLatest").textContent = sourceSha(data.latest)
    ? data.latest.slice(0, 12)
    : "Not available";
  $("updateLatest").title = sourceSha(data.latest) ? data.latest : "";
  const guidance =
    updateError ||
    (data.auto?.enabled && data.guidance?.startsWith("New source available.")
      ? failedLatest
        ? "Main differs from the installed source. The last attempt failed; see the upgrade failure below."
        : "Main differs from the installed source. Automatic upgrade will verify it and wait for an idle worker."
      : data.guidance);
  $("updateStatus").textContent =
    guidance +
    (data.cleanupWarning === true && !/cleanup/i.test(guidance)
      ? " Candidate cleanup is incomplete; repair protected-home permissions before retrying this revision."
      : "");
  $("updateAuto").disabled =
    !data.supported || data.auto?.available !== true || updateRequest;
  $("updateAuto").checked = data.auto?.enabled === true;
  const autoStates = {
    running:
      "Upgrade committed; worker started locally. Check Worker status for ongoing connectivity.",
    stopped: "Upgrade committed; previously stopped worker remains stopped.",
    deferred:
      "Automatic attempt deferred before installation. The launcher did not record a specific reason; see the last upgrade result separately.",
    suppressed:
      "Automatic retry suppressed: this revision already failed. Resolve the failure, then retry manually, or wait for a different main revision.",
    "restored-running":
      "Upgrade failed; previous runtime restored and worker started locally. Check Worker status.",
    failed:
      "Automatic upgrade failed; previous runtime retained. This revision will not retry automatically.",
    "resume-failed":
      "Worker restart could not be confirmed. Check Worker status and start it manually if needed; inspect upgrade result separately.",
  };
  const deferReasons = {
    AUTO_UPDATE_BUSY:
      "Automatic attempt deferred: worker, preview or native terminal activity is still busy. It will check again after activity finishes.",
    WORKER_STOP_UNCONFIRMED:
      "Automatic attempt deferred: worker stop could not be confirmed. Check Worker status.",
    LOCAL_UNAVAILABLE:
      "Automatic attempt deferred: local Studio communication failed. No source operation was accepted; the supervisor will reconcile worker state before retrying.",
    AUTO_UPDATE_DISABLED:
      "Automatic attempt cancelled before installation because automatic updates were disabled or the owner was shutting down.",
    ARTIFACT_NOT_READY:
      "Automatic attempt deferred before worker stop: the exact trusted native artifact or synthetic preflight is not ready. External provisioning is required; this same revision will retry after cooldown.",
  };
  const autoOutcome = data.autoOutcome;
  const relevantAuto =
    autoOutcome &&
    sourceSha(autoOutcome.sha) &&
    (autoOutcome.sha === data.latest || autoOutcome.sha === data.installed) &&
    !(autoOutcome.state === "suppressed" && autoOutcome.sha === data.installed);
  const historicalAuto =
    relevantAuto && autoOutcome.state === "deferred" && failedLatest
      ? "Last attempt for this revision failed. See the failure details before retrying manually."
      : relevantAuto &&
          autoOutcome.state === "deferred" &&
          Object.hasOwn(deferReasons, autoOutcome.reason)
        ? deferReasons[autoOutcome.reason]
        : relevantAuto &&
            sourceSha(data.autoOutcome.sha) &&
            Object.hasOwn(autoStates, data.autoOutcome.state)
          ? autoStates[data.autoOutcome.state]
          : data.supported && data.auto?.available === false
            ? "Launcher upgrade required. Replace the launcher or container image with the current build, restart the service using the same Coach home, then reload Studio. Source upgrades alone leave the old launcher running."
            : data.auto?.enabled
              ? "Enabled. Waiting for a newer verified main revision and an idle worker."
              : "Off. Enable to upgrade from main automatically.";
  const checkErrors = {
    RATE_LIMITED: "GitHub rate limit. Source check failed.",
    FORBIDDEN:
      "GitHub denied the source check (HTTP 403). Rate limiting was not confirmed.",
    UNAVAILABLE:
      "GitHub unavailable or timed out. Source check failed; check network access.",
  };
  // Older owners only send guidance. Preserve it even when a historical
  // successful autoOutcome matches the installed revision.
  const checkError = Object.hasOwn(checkErrors, data.checkError)
    ? checkErrors[data.checkError]
    : data.checkError === undefined &&
        !sourceSha(data.latest) &&
        data.checkedAt &&
        /^GitHub /i.test(data.guidance || "")
      ? data.guidance
      : "";
  const checkStatus =
    data.checking === true
      ? `Checking GitHub for main source…${checkError ? ` Previous check: ${checkError}` : ""}`
      : updateCheckRequested
        ? `Source check requested; waiting for launcher…${checkError ? ` Previous check: ${checkError}` : ""}`
        : checkError;
  $("updateAutoStatus").textContent =
    (checkStatus ? `${checkStatus} ` : "") +
    (relevantAuto
      ? `Last automatic result: ${historicalAuto}`
      : historicalAuto);
  const validOutcome = !!outcome;
  $("updateOutcome").dataset.tone = failed ? "error" : "neutral";
  $("updateOutcome").setAttribute("role", failed ? "alert" : "status");
  $("updateAutoStatus").dataset.tone =
    checkError ||
    (relevantAuto &&
      ["failed", "suppressed", "restored-running", "resume-failed"].includes(
        autoOutcome.state,
      ))
      ? "error"
      : "neutral";
  const failureHelp = !failed
    ? ""
    : outcome.state === "interrupted"
      ? " Completion was not confirmed. Verify the installed revision and worker status before retrying."
      : outcome.reason
        ? ` ${outcome.reason}: ${updateFailureHelp[outcome.reason]}`
        : " Failure reason was not recorded by this launcher. Check host prerequisites; replacing the stable launcher is required to retain reasons for future failures. Older failures cannot be reconstructed.";
  $("updateOutcome").hidden = !validOutcome;
  $("updateOutcome").textContent = validOutcome
    ? `${updateOutcomeNames[outcome.state]} · ${outcome.sha.slice(0, 12)} · ${formatTimestamp(outcome.at)}${failureHelp}${failed ? ` Diagnostic operation: ${outcome.id}${outcome.phase ? `; phase: ${outcome.phase}` : ""}. Included in diagnostic JSON; worker/preview errors are separate.` : ""}`
    : "";
  $("updateOutcome").title = validOutcome
    ? `Operation ${outcome.id}; target ${outcome.sha}`
    : "";
  $("updateChecked").textContent = data.checkedAt
    ? "Last check · " + formatTimestamp(data.checkedAt)
    : "Not checked yet.";
  $("updateCheck").disabled = updateRequest || locked;
  $("updateApply").disabled =
    updateRequest ||
    locked ||
    data.preparing === true ||
    updateWorkerBlocked ||
    !data.supported ||
    !sourceSha(data.latest) ||
    data.latest === data.installed;
  $("updateConfirmApply").disabled =
    locked || data.preparing === true || updateRequest || updateWorkerBlocked;
  for (const id of [
    "run",
    "stop",
    "save",
    "restorePersona",
    "previewButton",
    "connect",
    "cancel",
    "saveSkill",
    "restoreSkill",
  ])
    $(id).disabled =
      (locked && !(id === "cancel" && previewBusy)) ||
      (id === "previewButton" && (previewBusy || previewCancelling)) ||
      // The server refuses configuration changes while a preview runs.
      (previewBusy &&
        ["save", "restorePersona", "saveSkill", "restoreSkill"].includes(id)) ||
      (id === "restorePersona" && historyBusy);
  editorsLocked = locked;
  $("restartRetry").disabled = lifecycleBusy || data.applying;
  if (
    data.recovering &&
    !data.applying &&
    data.autoOutcome?.state === "resume-failed"
  ) {
    updateRecoveryVisible = true;
    $("restartStatus").textContent =
      "The source operation finished, but Coach restart is not confirmed. Retry starts only the saved configuration; it does not reinstall or replay actions. The launcher will also retry recovery.";
    $("restartRetry").hidden = false;
  } else if (updateRecoveryVisible && !data.recovering) {
    updateRecoveryVisible = false;
    $("restartRetry").hidden = true;
    $("restartStatus").textContent =
      "Launcher recovery completed. Check Worker status for current connectivity.";
  }
  applyEditorLock();
  $("updateSource").hidden = !sourceSha(data.latest);
  if (sourceSha(data.latest))
    $("updateSource").href =
      "https://github.com/stevefortier/katafit-coach/commit/" + data.latest;
}
async function refreshUpdate(check = false) {
  clearTimeout(updateTimer);
  if (!key || updateRequest || document.hidden || $("studio").hidden) return;
  const generation = authGeneration;
  updateRequest = true;
  updateCheckRequested = check;
  const controller = new AbortController();
  updateController = controller;
  renderUpdate();
  try {
    const data = await api(
      check ? "update/check" : "update",
      check ? {} : undefined,
      AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    );
    if (controller.signal.aborted || generation !== authGeneration) return;
    if (updateInitialRevision === undefined)
      updateInitialRevision = data.installed;
    updateData = data;
    updateClockOffset = Number.isSafeInteger(data.serverNow)
      ? data.serverNow - Date.now()
      : 0;
    updatePending = data.applying;
    updateError = "";
  } catch {
    if (!controller.signal.aborted && generation === authGeneration)
      updateError =
        "Studio is unavailable. Reconnecting; verify the installed revision before assuming an upgrade succeeded.";
  } finally {
    if (generation !== authGeneration || updateController !== controller)
      return;
    updateRequest = false;
    updateCheckRequested = false;
    updateController = undefined;
    renderUpdate();
    if (key && !document.hidden && !$("studio").hidden)
      updateTimer = setTimeout(
        () => refreshUpdate(),
        updatePending ||
          updateData?.preparing ||
          updateData?.applying ||
          updateData?.recovering ||
          updateError
          ? 2000
          : 30000,
      );
  }
}
action("updateCheck", async () => {
  $("updateConfirm").hidden = true;
  await refreshUpdate(true);
});
$("updateAuto").addEventListener("change", async () => {
  const enabled = $("updateAuto").checked;
  $("updateAuto").disabled = true;
  try {
    await api("update/auto", { enabled }, AbortSignal.timeout(15000));
    await refreshUpdate();
  } catch {
    $("updateAuto").checked = !enabled;
    notice(
      "Could not save automatic update setting. Check Studio connection.",
      "error",
    );
  } finally {
    renderUpdate();
  }
});
action("updateApply", async () => {
  const generation = authGeneration;
  if (hasUnsavedEdits()) {
    notice(
      "Unsaved edits: save or revert changes before upgrading.",
      "warning",
    );
    return;
  }
  await status();
  if (generation !== authGeneration) return;
  if (
    workerState !== "stopped" &&
    updateData?.manualRestartSupported !== true
  ) {
    notice(
      "Launcher upgrade required: this older launcher cannot restart running Coach after a manual upgrade. Nothing was stopped or applied. Replace the stable launcher using the same Coach home. Settings and preview restarts are available without it.",
      "warning",
    );
    return;
  }
  if (updateWorkerBlocked) {
    notice(
      "Finish or cancel preview and stop native Pi before upgrading. Coach will be restarted automatically after confirmation.",
      "warning",
    );
    return;
  }
  if (
    !sourceSha(updateData?.latest) ||
    updatePending ||
    updateData.preparing ||
    updateData.applying
  )
    return;
  updateTarget = updateData.latest;
  $("updateTarget").textContent = updateTarget;
  $("updateConfirm").hidden = false;
  $("updateConfirmApply").focus();
});
action("updateCancel", async () => {
  $("updateConfirm").hidden = true;
  updateTarget = undefined;
});
action("updateReload", async () => {
  if (hasUnsavedEdits()) {
    notice(
      "Unsaved edits: save or revert changes before reloading.",
      "warning",
    );
    return;
  }
  location.reload();
});
action("updateConfirmApply", async () => {
  const generation = authGeneration;
  if (
    !sourceSha(updateTarget) ||
    updateTarget !== updateData?.latest ||
    updatePending ||
    updateData.preparing ||
    updateData.applying
  )
    return;
  if (hasUnsavedEdits()) {
    notice(
      "Unsaved edits: save or revert changes before upgrading.",
      "warning",
    );
    return;
  }
  updatePending = true;
  updateError = "Upgrade requested. Waiting for verified runtime status…";
  $("updateConfirm").hidden = true;
  renderUpdate();
  try {
    await api(
      "update/apply",
      { sha: updateTarget, confirm: true },
      AbortSignal.timeout(15000),
    );
  } catch (error) {
    if (generation !== authGeneration) return;
    if (error.status) {
      updatePending = false;
      notice(error.message, "error");
    } else
      updateError =
        "Studio is unavailable. The upgrade may have been accepted; reconnecting to verify.";
  }
  if (generation === authGeneration) await refreshUpdate();
});
document.addEventListener("visibilitychange", () => {
  clearTimeout(updateTimer);
  if (document.hidden) updateController?.abort();
  else void refreshUpdate();
});
window.addEventListener("pagehide", () => {
  clearTimeout(updateTimer);
  updateController?.abort();
});
function lockSession(message, severity) {
  if (key)
    void fetch("/api/terminal/stop", {
      method: "POST",
      keepalive: true,
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: "{}",
    }).catch(() => {});
  native.reset();
  authGeneration++;
  key = "";
  lifecycleBusy = false;
  lifecycleUncertain = false;
  lifecycleOperation = undefined;
  serverTransition = false;
  updateRecoveryVisible = false;
  statusEpoch++;
  previewController?.abort();
  previewController = undefined;
  previewBusy = false;
  previewCancelling = false;
  $("restartRetry").hidden = true;
  $("restartCheck").hidden = true;
  $("restartStatus").textContent = "";
  rememberAdmin("");
  config = undefined;
  // Typed provider keys never outlive the authenticated session.
  modelsDraft = undefined;
  renderProviders();
  renderModelStatus();
  historyBusy = false;
  clearPersonaHistory();
  skillsData = undefined;
  skillDrafts = new Map();
  selectedSkill = undefined;
  ++skillsEpoch;
  ++skillHistoryEpoch;
  $("skillList").replaceChildren();
  $("skillEditor").hidden = true;
  $("skillsRevision").textContent = "";
  $("skillHistoryList").replaceChildren();
  $("skillHistorySnapshot").replaceChildren();
  $("skillHistoryDetail").hidden = true;
  renderCoachName();
  renderOperatorActions();

  $("operatorStatus").textContent = "";
  clearTimeout(updateTimer);
  updateController?.abort();
  updateController = undefined;
  updateRequest = false;
  updateCheckRequested = false;
  updatePending = false;
  updateWorkerBlocked = true;
  workerState = undefined;
  updateData = undefined;
  updateTarget = undefined;
  $("updateConfirm").hidden = true;
  clearTimeout(logTimer);
  logController?.abort();
  logController = undefined;
  logData = { entries: [] };
  performanceData = null;
  logLoading = false;
  logReadError = "";
  $("performanceExport").disabled = true;
  performanceSelection = null;
  performanceSignature = "";
  $("performanceRows").replaceChildren();
  $("performanceWindow").textContent = "";
  $("performanceSelection").textContent = "";
  $("performanceClear").hidden = true;
  logNodes.clear();
  $("logRows").replaceChildren();
  $("logStatus").textContent = "";
  $("studio").hidden = true;
  $("login").hidden = false;
  $("lockStudio").hidden = true;
  $("state").textContent = "LOCKED";
  $("state").dataset.tone = "neutral";
  notice(message, severity);
}
action("lockStudio", async () =>
  lockSession(
    "Studio locked. This does not stop the worker or an accepted upgrade.",
    "info",
  ),
);

function operatorSnapshotLabel() {
  if (config)
    $("operatorSnapshot").textContent =
      "Saved default: " +
      config.provider.model +
      " · revision " +
      config.revision +
      ". Native /model changes only this ephemeral session.";
}
async function loadNativeReceipts() {
  const generation = authGeneration;
  try {
    const receipts = await api("terminal/receipts");
    if (generation !== authGeneration) return;
    renderOperatorActions(receipts.actions);
    operatorSnapshotLabel();
    $("operatorStatus").textContent = "";
  } catch (error) {
    if (!error.stale)
      $("operatorStatus").textContent =
        "Action receipts unavailable. Do not retry uncertain writes.";
  }
}
$("operatorReconcile").onclick = () => loadNativeReceipts();
const native = nativeTerminal({
  api,
  // Private attachment bytes; bound to the key of the session that requested.
  fetchAttachment: (path, signal) =>
    fetch(path, {
      headers: { Authorization: "Bearer " + key },
      signal,
      redirect: "error",
      cache: "no-store",
    }),
  authorized: () =>
    !!key &&
    !lifecycleBusy &&
    !lifecycleUncertain &&
    !serverTransition &&
    !updatePending &&
    !updateData?.applying &&
    !updateData?.recovering,
});

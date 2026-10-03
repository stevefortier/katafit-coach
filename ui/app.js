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
  const history = $("operatorDeliveryHistory");
  const rows = $("operatorDeliveryHistoryRows");
  rows.replaceChildren();
  let settled = 0;
  for (const action of actions) {
    if (!Object.hasOwn(labels, action.status)) continue;
    const unresolved = ["pending", "unknown"].includes(action.status);
    if (!unresolved) settled++;
    (unresolved ? $("operatorActions") : rows).append(
      detailText(
        "p",
        (action.tool_name && action.status === "unknown"
          ? "Action outcome unknown — do not retry; backend confirmation required"
          : labels[action.status]) +
          (action.tool_name ? " · " + action.tool_name : "") +
          (action.member_ref ? " · member " + action.member_ref : "") +
          (action.action_id ? " · " + action.action_id : "") +
          (action.recipient_id ? " · recipient " + action.recipient_id : "") +
          (action.message_id ? " · message " + action.message_id : ""),
      ),
    );
  }
  history.hidden = settled === 0;
  // The mounted disclosure preserves deliberate expansion across snapshots.
  $("operatorDeliveryHistorySummary").textContent = settled
    ? "Delivery history · " + settled
    : "";
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
  if (
    config &&
    (config.revision !== data.revision || config.origin !== data.origin)
  )
    resetMemories();
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
  const pane = restorePaneState();
  // Restore coverage before selecting/loading the underlying route. Otherwise
  // a reload briefly fetches Dojo data beneath an expanded/mobile Coach pane.
  if (pane.open && !paneOpen) openPane(pane.expanded === true);
  restoreStudioRoute(true);
  void loadNativeReceipts();
  await status();
  if (!updatesEntryActive) await refreshUpdate();
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
    `${skillsData.skills.filter((skill) => skill.enabled).length} of ${skillsData.skills.length} enabled.` +
    (skillsData.migration ? ` ${skillsData.migration.notice}` : "");
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
    else if (cmd === "run" && result.presence === "unsupported")
      notice(
        "Worker started; this backend does not support explicit presence. Connectivity is not confirmed by a heartbeat.",
        "warning",
      );
    else if (cmd === "run")
      notice(
        "Worker started; presence unconfirmed. The backend did not confirm a heartbeat, so connectivity is not confirmed.",
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
const settingsGroups = {
  settings: ["katafit", "models", "updates"],
  coachSettings: ["persona", "preview", "skills", "memories", "worker"],
};
const settingsSections = Object.values(settingsGroups).flat();
const rememberedSettings = { settings: "katafit", coachSettings: "persona" };
const settingsGroup = (section) =>
  settingsGroups.coachSettings.includes(section) ? "coachSettings" : "settings";
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
  rememberedSettings[settingsGroup(settingsSection)] = settingsSection;
  $("serverSettingsTabs").hidden =
    settingsGroup(settingsSection) !== "settings";
  $("coachSettingsTabs").hidden =
    settingsGroup(settingsSection) !== "coachSettings";
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
  if (settingsSection === "memories" && key) void loadMemories();
  if (historyVisible()) void loadPersonaHistory();
  if (skillHistoryVisible()) void loadSkillHistory();
  logVisibility();
  updateRouteEntry();
}
for (const section of settingsSections) {
  const tab = $("settings-" + section + "-tab");
  tab.onclick = () => selectStudioTab(settingsGroup(section), true, section);
  tab.onkeydown = (event) => {
    const sections = settingsGroups[settingsGroup(section)];
    const index = sections.indexOf(section);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? sections.length - 1
          : event.key === "ArrowRight"
            ? (index + 1) % sections.length
            : event.key === "ArrowLeft"
              ? (index + sections.length - 1) % sections.length
              : null;
    if (next === null || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    selectSettingsSection(sections[next]);
    $("settings-" + sections[next] + "-tab").focus({
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
// My memories: the connected account's memories through ordinary account REST.
// Every write carries a host key created once per intended change; an
// uncertain outcome keeps that key so "Check status" reads its exact receipt
// and "Send the same change again" can never become a second, different write.
// Responses for an older account/configuration, filter or selection are
// discarded (epochs), and drafts survive conflicts.
let memoryData = { items: [], has_more: false, next_cursor: null },
  memorySettings = null,
  memoryAccountEpoch = 0,
  memoryListEpoch = 0,
  memorySelectEpoch = 0,
  memorySelected = null,
  memoryUncertain = null,
  memoryConflict = null;
const memoryKindLabels = {
  fact: "Fact",
  preference: "Preference",
  commitment: "Commitment",
  goal: "Goal",
  lesson: "Lesson",
  hypothesis: "Hypothesis",
};
const memoryConflicts = [
  "MEMORY_CONFLICT",
  "MEMORY_CHANGED",
  "MEMORY_EPOCH_CHANGED",
  "MEMORY_IDEMPOTENCY_CONFLICT",
];
function memoryKey() {
  return "ui:" + crypto.randomUUID();
}
function memoryDate(value) {
  return value ? new Date(value).toLocaleDateString() : "";
}
function memorySource(entry) {
  const p = entry.provenance || {};
  const coach =
    p.producer === "hosted_coach"
      ? "hosted Coach"
      : p.producer === "external_coach"
        ? "standalone Coach"
        : "Coach";
  if (p.created_by === "model_extraction")
    return "Learned by " + coach + " from a chat";
  if (p.producer === "account_owner_session") return "Manually saved";
  return "Saved by " + coach;
}
function memoryShowState(error) {
  const code = error?.code || "";
  const text =
    {
      MEMORY_UNSUPPORTED:
        "This Kata.fit backend does not offer account memories yet. Nothing was read or changed — this is not an empty list.",
      MEMORY_AUTH_EXPIRED:
        "Kata.fit rejected the saved Coach connection (expired or revoked). Reconnect to see your memories; nothing was changed.",
      MEMORY_NOT_AUTHORIZED:
        "Kata.fit denied access to memories for the connected account.",
      MEMORY_UNAVAILABLE:
        "Kata.fit memory is temporarily unavailable. Nothing was confirmed; try again shortly.",
    }[code] ||
    error?.message ||
    "Memories could not be loaded. Try again.";
  $("memoryState").hidden = !error;
  $("memoryState").dataset.code = code;
  $("memoryStateText").textContent = error ? text : "";
  $("memoryReconnect").hidden = code !== "MEMORY_AUTH_EXPIRED";
}
function memoryShowConflict(error) {
  memoryConflict = error ? { code: error.code } : null;
  $("memoryConflict").hidden = !error;
  $("memoryConflictText").textContent = error
    ? error.code === "MEMORY_IDEMPOTENCY_CONFLICT"
      ? "This save was already used for a different change. Your draft is kept; save again to make it a new change."
      : "This memory changed since you opened it (edited elsewhere, by your Coach, or forgotten). Your draft is kept below — load the current version, then save again."
    : "";
}
function memoryRenderUncertain() {
  $("memoryUncertain").hidden = !memoryUncertain;
  $("memoryUncertainText").textContent = memoryUncertain
    ? `The response for “${memoryUncertain.label}” was lost, so it may or may not have been saved. It is never re-sent on its own. Check status first.`
    : "";
}
function memoryDraft(entry, keepText) {
  ++memorySelectEpoch;
  memorySelected = entry
    ? { id: entry.id, revision: entry.revision, review_at: entry.review_at }
    : null;
  memoryShowConflict(null);
  $("memoryEditorTitle").textContent = entry ? "Edit memory" : "Add a memory";
  $("memoryEditorMeta").textContent = entry
    ? `${memorySource(entry)} · updated ${memoryDate(entry.updated_at)}${entry.pinned ? " · pinned" : ""}${entry.status === "archived" ? " · archived" : ""}`
    : "Tell your Coach something to remember about you.";
  $("memoryKind").value = entry?.kind || "preference";
  if (keepText === undefined) $("memoryText").value = entry?.text || "";
  $("memoryReviewAt").value = entry?.review_at
    ? entry.review_at.slice(0, 10)
    : "";
  $("memoryText").disabled = entry?.availability === "unavailable";
  $("memorySave").textContent = entry ? "Save correction" : "Save memory";
  $("memoryHistoryList").replaceChildren();
}
async function memorySelect(id, keepText) {
  const epoch = ++memorySelectEpoch,
    account = memoryAccountEpoch;
  const { item, history } = await api("memories/" + id);
  if (epoch !== memorySelectEpoch || account !== memoryAccountEpoch || !key)
    return null;
  memoryDraft(item, keepText);
  for (const record of history.slice().reverse()) {
    const row = detailText(
      "p",
      `Revision ${record.revision} · ${record.change} · ${formatTimestamp(record.at)}${record.text ? " — " + record.text : ""}`,
    );
    row.className = "history-item";
    $("memoryHistoryList").append(row);
  }
  return item;
}
async function memoryWrite(op) {
  const account = memoryAccountEpoch,
    key0 = op.key || memoryKey();
  try {
    const result = await api(op.path, { ...op.body, idempotency_key: key0 });
    if (account !== memoryAccountEpoch) throw staleAuthentication();
    if (memoryUncertain?.key === key0) memoryUncertain = null;
    memoryRenderUncertain();
    return result;
  } catch (error) {
    if (error.stale || account !== memoryAccountEpoch) throw error;
    // A lost response or a transport failure: the change may have committed.
    if (error.code === "MEMORY_OUTCOME_UNKNOWN" || !error.status) {
      memoryUncertain = { ...op, key: key0 };
      memoryRenderUncertain();
    } else if (memoryUncertain?.key === key0) {
      memoryUncertain = null;
      memoryRenderUncertain();
    }
    throw error;
  }
}
async function memoryReconcile() {
  const op = memoryUncertain;
  if (!op) return;
  const account = memoryAccountEpoch;
  const query = new URLSearchParams({ kind: op.expect.kind });
  if (op.expect.memory_id) query.set("memory_id", op.expect.memory_id);
  const receipt = await api(
    // Host keys are URL-safe by construction (^[A-Za-z0-9._:-]+$).
    "memories/operations/" + op.key + "?" + query,
  );
  if (account !== memoryAccountEpoch || memoryUncertain !== op) return;
  if (receipt.operation) {
    memoryUncertain = null;
    memoryRenderUncertain();
    notice(`Confirmed: “${op.label}” was saved.`, "success");
    if (op.expect.kind === "create" || op.selected) memoryDraft();
    await loadMemories();
  } else
    notice(
      `Not saved as of now: “${op.label}”. You can send the same change again (safe, it cannot apply twice) or dismiss it.`,
      "warning",
    );
}
function memoryRelated(n) {
  return n === 1 ? "1 related memory" : n + " related memories";
}
// Forget is confirmed against the backend's impact snapshot. A failed preview
// forgets nothing and never shows an invented count.
const MEMORY_FORGET_COPY =
  "Forgotten from future memory retrieval. Text already present in this chat or sent to a provider cannot be retracted.";
async function memoryForgetConfirm(id) {
  const account = memoryAccountEpoch;
  let impact;
  try {
    impact = (await api("memories/" + id + "/forget-impact")).forget_impact;
  } catch (error) {
    if (error.stale || account !== memoryAccountEpoch) throw error;
    throw Object.assign(
      new Error(
        "Couldn't check which memories depend on this one, so nothing was forgotten. Try again.",
      ),
      { code: error.code },
    );
  }
  if (account !== memoryAccountEpoch) throw staleAuthentication();
  const n = impact.related_count;
  const ok = confirm(
    "Forget this memory?\n\n" +
      MEMORY_FORGET_COPY +
      (n
        ? `\n\n${memoryRelated(n)} that depended on it will also become unavailable. This count is a snapshot and can change before you confirm; cleanup of their stored text may finish later.`
        : ""),
  );
  return ok ? impact : null;
}
function memoryForgotten(result, impact) {
  const erasure = result?.erasure;
  const n = erasure?.related_count ?? impact?.related_count ?? 0;
  if (!n) return "";
  if (erasure?.status === "complete")
    return ` ${memoryRelated(n)} that depended on it were forgotten and erased too.`;
  return (
    ` ${memoryRelated(n)} ${n === 1 ? "is" : "are"} unavailable now` +
    (erasure?.status === "queued"
      ? "; cleanup of their stored text is pending."
      : ".")
  );
}
function memoryCard(entry) {
  const card = document.createElement("section");
  card.className = "memory-card";
  card.dataset.id = entry.id;
  if (entry.status !== "active") card.dataset.status = entry.status;
  const text = detailText(
    "p",
    entry.availability === "unavailable"
      ? "Unavailable — this memory came from something since corrected or forgotten. You can forget it."
      : entry.text,
  );
  text.className = "memory-text";
  const labels = document.createElement("p");
  labels.className = "memory-labels";
  const tags = [
    memoryKindLabels[entry.kind] || entry.kind,
    ...(entry.pinned ? ["Pinned"] : []),
    ...(entry.status === "archived" ? ["Archived"] : []),
    ...(entry.needs_review
      ? ["Needs review"]
      : entry.review_at
        ? [
            "Check again " +
              new Date(entry.review_at).toLocaleDateString(undefined, {
                timeZone: "UTC",
              }),
          ]
        : []),
    ...(entry.provenance?.corrected ? ["Corrected"] : []),
  ];
  for (const tag of tags) {
    const span = detailText("span", tag);
    span.className = "memory-tag";
    labels.append(span);
  }
  const meta = detailText(
    "p",
    `${memorySource(entry)} · ${memoryDate(entry.created_at)}${entry.updated_at !== entry.created_at ? " · updated " + memoryDate(entry.updated_at) : ""}`,
  );
  meta.className = "hint";
  const actions = document.createElement("div");
  actions.className = "actions";
  const button = (label, fn, secondary = true) => {
    const b = detailText("button", label);
    b.type = "button";
    if (secondary) b.className = "secondary";
    b.onclick = async () => {
      try {
        await fn();
      } catch (error) {
        memoryActionError(error);
      }
    };
    actions.append(b);
    return b;
  };
  const edit = button("Edit", () => memorySelect(entry.id), false);
  edit.disabled = entry.availability === "unavailable";
  const patch = (body, label) =>
    memoryWrite({
      path: "memories/" + entry.id,
      body: { expected_revision: entry.revision, ...body },
      expect: { kind: "update", memory_id: entry.id },
      label,
    }).then(async () => {
      notice(label + ": done.", "success");
      await loadMemories();
    });
  if (entry.availability === "available") {
    button(entry.pinned ? "Unpin" : "Pin", () =>
      patch(
        { pinned: !entry.pinned },
        entry.pinned ? "Unpin memory" : "Pin memory",
      ),
    );
    button(entry.status === "archived" ? "Restore" : "Archive", () =>
      patch(
        { status: entry.status === "archived" ? "active" : "archived" },
        entry.status === "archived" ? "Restore memory" : "Archive memory",
      ),
    );
  }
  button("Forget", async () => {
    const impact = await memoryForgetConfirm(entry.id);
    if (!impact) return;
    const result = await memoryWrite({
      path: "memories/" + entry.id + "/forget",
      body: { expected_revision: entry.revision },
      expect: { kind: "forget", memory_id: entry.id },
      label: "Forget memory",
      selected: memorySelected?.id === entry.id,
    });
    if (memorySelected?.id === entry.id) memoryDraft();
    notice(MEMORY_FORGET_COPY + memoryForgotten(result, impact), "success");
    await loadMemories();
  });
  card.append(text, labels, meta, actions);
  return card;
}
function memoryActionError(error) {
  if (error.stale || !key) return;
  if (memoryConflicts.includes(error.code)) memoryShowConflict(error);
  if (
    [
      "MEMORY_AUTH_EXPIRED",
      "MEMORY_UNSUPPORTED",
      "MEMORY_NOT_AUTHORIZED",
    ].includes(error.code)
  )
    memoryShowState(error);
  notice(error.message || "Memory change failed.", "error");
}
function renderMemories() {
  $("memoryList").replaceChildren(...memoryData.items.map(memoryCard));
  $("memoryMore").hidden = !memoryData.has_more;
  const filtered =
    $("memorySearch").value ||
    $("memoryKindFilter").value ||
    $("memoryPinnedFilter").checked ||
    $("memoryStatusFilter").value !== "active";
  $("memoryStatus").textContent = memoryData.loaded
    ? memoryData.items.length
      ? memoryData.items.length +
        (memoryData.items.length === 1 ? " memory" : " memories") +
        (memoryData.has_more ? " · more available" : "")
      : memoryData.has_more
        ? "No matches on this page · more available — load more to keep searching"
        : filtered
          ? "No memories match these filters."
          : "No memories yet. Ask your Coach to remember something, or add one below."
    : "";
}
function renderMemorySettings() {
  const s = memorySettings;
  $("memoryLearning").disabled = !s;
  $("memoryLearning").checked = !!s && !s.learning_paused;
  $("memoryLearningStatus").textContent = !s
    ? ""
    : s.learning_paused
      ? "Paused: your Coach will not learn from chats. Recall and manual changes still work."
      : "On: after a chat, your Coach may save lasting preferences, goals and facts you state. You'll see a notice in the Coach pane.";
}
async function loadMemorySettings() {
  const account = memoryAccountEpoch;
  const { settings } = await api("memories/settings");
  if (account !== memoryAccountEpoch || !key) return;
  memorySettings = settings;
  renderMemorySettings();
}
async function loadMemories(more = false) {
  if (!key) return;
  const epoch = ++memoryListEpoch,
    account = memoryAccountEpoch;
  const params = new URLSearchParams();
  if ($("memorySearch").value) params.set("query", $("memorySearch").value);
  if ($("memoryKindFilter").value)
    params.set("kind", $("memoryKindFilter").value);
  params.set("status", $("memoryStatusFilter").value);
  if ($("memoryPinnedFilter").checked) params.set("pinned", "true");
  if (more && memoryData.next_cursor)
    params.set("cursor", memoryData.next_cursor);
  $("memoryMore").disabled = true;
  try {
    const result = await api("memories?" + params);
    if (epoch !== memoryListEpoch || account !== memoryAccountEpoch || !key)
      return;
    memoryShowState(null);
    const items = more
      ? [
          ...new Map(
            [...memoryData.items, ...result.items].map((i) => [i.id, i]),
          ).values(),
        ]
      : result.items;
    memoryData = {
      items,
      has_more: result.has_more,
      next_cursor: result.next_cursor,
      loaded: true,
    };
    renderMemories();
    if (!more) void loadMemorySettings().catch(() => {});
  } catch (error) {
    if (
      epoch !== memoryListEpoch ||
      account !== memoryAccountEpoch ||
      error.stale
    )
      return;
    memoryData = { items: [], has_more: false, next_cursor: null };
    renderMemories();
    memoryShowState(error);
  } finally {
    if (epoch === memoryListEpoch) $("memoryMore").disabled = false;
  }
}
function resetMemories() {
  ++memoryAccountEpoch;
  ++memoryListEpoch;
  memoryData = { items: [], has_more: false, next_cursor: null };
  memorySettings = null;
  memoryUncertain = null;
  memoryDraft();
  memoryShowState(null);
  memoryRenderUncertain();
  renderMemories();
  renderMemorySettings();
  legacyResetMemories();
}
let memorySearchTimer;
$("memorySearch").oninput = () => {
  clearTimeout(memorySearchTimer);
  ++memoryListEpoch;
  memorySearchTimer = setTimeout(() => void loadMemories(), 250);
};
for (const id of [
  "memoryKindFilter",
  "memoryStatusFilter",
  "memoryPinnedFilter",
])
  $(id).onchange = () => void loadMemories();
action("memoryRefresh", () => loadMemories());
action("memoryRetry", () => loadMemories());
action("memoryReconnect", async () => selectSettingsSection("katafit"));
action("memoryMore", () => loadMemories(true));
action("memoryNew", async () => memoryDraft());
action("memoryCheck", memoryReconcile);
action("memoryDismiss", async () => {
  memoryUncertain = null;
  memoryRenderUncertain();
});
action("memoryResend", async () => {
  const op = memoryUncertain;
  if (!op) return;
  // Same key and same body: the backend applies it at most once.
  await memoryWrite(op).catch((error) => {
    memoryActionError(error);
    throw Object.assign(error, { stale: true });
  });
  notice(`“${op.label}” saved.`, "success");
  if (op.expect.kind === "create" || op.selected) memoryDraft();
  await loadMemories();
});
action("memoryReload", async () => {
  if (!memorySelected) return memoryShowConflict(null);
  // The current version replaces the revision; the user's draft text stays.
  const item = await memorySelect(memorySelected.id, true).catch((error) => {
    if (error.status === 404 || error.code === "MEMORY_NOT_AUTHORIZED") {
      memoryDraft(undefined, true);
      notice(
        "That memory no longer exists. Your text is kept as a new memory draft.",
        "warning",
      );
      return null;
    }
    throw error;
  });
  if (item) notice("Loaded the current version; your draft is kept.", "info");
});
$("memoryLearning").onchange = async () => {
  const s = memorySettings;
  if (!s) return;
  const paused = !$("memoryLearning").checked;
  $("memoryLearning").disabled = true;
  try {
    const result = await memoryWrite({
      path: "memories/settings",
      body: { expected_revision: s.revision, learning_paused: paused },
      expect: { kind: "settings" },
      label: paused ? "Pause learning" : "Resume learning",
    });
    memorySettings = result.settings;
    notice(
      paused
        ? "Automatic learning paused for your account."
        : "Automatic learning is on.",
      "success",
    );
  } catch (error) {
    memoryActionError(error);
    if (memoryConflicts.includes(error.code))
      await loadMemorySettings().catch(() => {});
  } finally {
    renderMemorySettings();
  }
};
action("memorySave", async () => {
  const selected = memorySelected;
  const text = $("memoryText").value.trim();
  if (!text) throw new Error("Write the memory text first.");
  const date = $("memoryReviewAt").value;
  const review_at =
    date === (selected?.review_at?.slice(0, 10) || "")
      ? (selected?.review_at ?? null)
      : date
        ? date + "T00:00:00.000Z"
        : null;
  const body = { kind: $("memoryKind").value, text, review_at };
  if (!selected && body.review_at === null) delete body.review_at;
  const op = selected
    ? {
        path: "memories/" + selected.id,
        body: { ...body, expected_revision: selected.revision },
        expect: { kind: "update", memory_id: selected.id },
        label: "Save correction",
        selected: true,
      }
    : {
        path: "memories",
        body,
        expect: { kind: "create" },
        label: "Add memory",
      };
  const epoch = memorySelectEpoch;
  try {
    const result = await memoryWrite(op);
    if (epoch !== memorySelectEpoch) return;
    memoryDraft();
    notice(selected ? "Correction saved." : "Memory saved.", "success");
    await loadMemories();
    return result;
  } catch (error) {
    memoryActionError(error);
    throw Object.assign(error, { stale: true });
  }
});
// Legacy private notes: the retired Studio MCP collection, opt-in only and
// never mixed with account memories.
let legacyMemoriesData = { items: [], members: [] },
  legacySelectedMemoryId = "",
  legacySelectedMemoryRevision = 0,
  legacyMemoryListEpoch = 0,
  legacyMemoryHistoryEpoch = 0,
  legacySelectedMemoryReviewAt = null;
function legacyMemoryNumber(id, fallback) {
  const value = Number($(id).value);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}
function legacyMemoryAudienceLabel(value) {
  return (
    {
      member_private: "Member private",
      member_coach: "Member Coach",
      operator_private: "Operator private",
    }[value] || value
  );
}
function legacySyncMemoryMembers() {
  for (const id of ["legacyMemoryMemberFilter", "legacyMemoryMember"]) {
    const select = $(id);
    const value = select.value;
    select.replaceChildren(
      new Option(id === "legacyMemoryMember" ? "No member subject" : "All", ""),
      ...legacyMemoriesData.members.map(
        (m) => new Option(m.display_name || m.member_ref, m.member_ref),
      ),
    );
    select.value = [...select.options].some((o) => o.value === value)
      ? value
      : "";
  }
}
function legacyMemoryDraft(entry) {
  ++legacyMemoryHistoryEpoch;
  legacySelectedMemoryReviewAt = entry?.review_at || null;
  legacySelectedMemoryId = entry?.id || "";
  legacySelectedMemoryRevision = entry?.revision || 0;
  $("legacyMemoryEditorTitle").textContent = entry
    ? "Edit legacy private note"
    : "Add legacy private note";
  $("legacyMemoryAudience").value = entry?.audience || "operator_private";
  $("legacyMemoryMember").value = entry?.subject?.member_ref || "";
  $("legacyMemoryKind").value = entry?.kind || "preference";
  $("legacyMemoryText").value = entry?.text || "";
  $("legacyMemoryImportance").value = entry?.importance ?? 0.85;
  $("legacyMemoryRelevance").value = entry?.goal_relevance ?? 0.85;
  $("legacyMemoryReviewAt").value = entry?.review_at
    ? entry.review_at.slice(0, 10)
    : "";
  $("legacyMemoryPinned").checked = entry ? entry.pinned !== false : true;
  $("legacyMemoryText").disabled = entry?.availability === "unavailable";
  $("legacyMemoryHistoryList").replaceChildren();
}
async function legacyLoadMemoryHistory(id) {
  const epoch = ++legacyMemoryHistoryEpoch;
  const { history, item } = await api("legacy-memories/" + id);
  if (epoch !== legacyMemoryHistoryEpoch || !key) return;
  $("legacyMemoryHistoryList").replaceChildren();
  legacyMemoryDraft(item);
  for (const record of history.slice().reverse()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary history-item";
    button.textContent =
      "Revision " +
      record.revision +
      " · " +
      record.change +
      " · " +
      formatTimestamp(record.at);
    button.onclick = () => {
      $("legacyMemoryHistoryList").replaceChildren(
        detailText("pre", JSON.stringify(record, null, 2)),
      );
    };
    $("legacyMemoryHistoryList").append(button);
  }
}
function legacyRenderMemories() {
  $("legacyMemoryList").replaceChildren();
  legacySyncMemoryMembers();
  $("legacyMemoryMore").hidden = !legacyMemoriesData.next_cursor;
  $("legacyMemoryStatus").textContent =
    legacyMemoriesData.items.length +
    " memories" +
    (legacyMemoriesData.has_more ? " · more available" : "");
  for (const entry of legacyMemoriesData.items) {
    const card = document.createElement("section");
    card.className = "memory-card";
    if (entry.status !== "active") card.dataset.status = entry.status;
    const subject = entry.subject?.display_name
      ? " · " + entry.subject.display_name
      : "";
    const title = detailText(
      "h3",
      `${entry.kind} · ${legacyMemoryAudienceLabel(entry.audience)}${subject}`,
    );
    const text = detailText(
      "p",
      entry.availability === "unavailable"
        ? "Unavailable: " + entry.unavailable_code
        : entry.text,
    );
    const meta = detailText(
      "p",
      `Revision ${entry.revision} · importance ${entry.importance} · relevance ${entry.goal_relevance ?? "n/a"} · confidence ${entry.confidence}${entry.pinned ? " · pinned" : ""}${entry.protected ? " · protected" : ""}`,
    );
    meta.className = "hint";
    const sources = document.createElement("details");
    sources.append(detailText("summary", "Sources"));
    const sourceList = document.createElement("ul");
    for (const source of entry.sources)
      sourceList.append(detailText("li", `${source.family} · ${source.label}`));
    sources.append(sourceList);
    const actions = document.createElement("div");
    actions.className = "actions";
    const edit = detailText("button", "Edit");
    edit.type = "button";
    edit.disabled = entry.availability === "unavailable";
    edit.onclick = async () => {
      await legacyLoadMemoryHistory(entry.id).catch(legacyMemoryLoadError);
    };
    const archive = detailText(
      "button",
      entry.status === "archived" ? "Restore" : "Archive",
    );
    archive.type = "button";
    archive.className = "secondary";
    archive.onclick = async () => {
      const epoch = legacyInvalidateMemory();
      try {
        await api("legacy-memories/" + entry.id, {
          expected_revision: entry.revision,
          status: entry.status === "archived" ? "active" : "archived",
        });
        if (epoch !== legacyMemoryHistoryEpoch || !key) return;
        await legacyLoadMemories();
        notice("Memory status updated.", "success");
      } catch (error) {
        if (epoch === legacyMemoryHistoryEpoch) legacyMemoryLoadError(error);
      }
    };
    const forget = detailText("button", "Forget");
    forget.type = "button";
    forget.className = "secondary";
    forget.onclick = async () => {
      if (!confirm("Forget this memory and fence stale recreation?")) return;
      const epoch = legacyInvalidateMemory();
      try {
        await api("legacy-memories/" + entry.id + "/forget", {
          expected_revision: entry.revision,
        });
        if (epoch !== legacyMemoryHistoryEpoch || !key) return;
        await legacyLoadMemories();
        notice(
          "Memory forgotten. Matching stale extraction is fenced.",
          "success",
        );
      } catch (error) {
        if (epoch === legacyMemoryHistoryEpoch) legacyMemoryLoadError(error);
      }
    };
    actions.append(edit, archive, forget);
    card.append(title, text, meta, sources, actions);
    $("legacyMemoryList").append(card);
  }
}
function legacyMemoryLoadError(error) {
  if (key) notice(error.message || "Memory could not be loaded.", "error");
}
function legacyInvalidateMemory() {
  ++legacyMemoryListEpoch;
  legacyMemoryDraft();
  return legacyMemoryHistoryEpoch;
}
function legacyResetMemories() {
  legacyInvalidateMemory();
  legacyMemoriesData = { items: [], members: [] };
  legacyRenderMemories();
  $("legacyMemoryStatus").textContent = "";
}
async function legacyLoadMemories(more = false) {
  // action() may pass an event; pagination is explicitly opt-in only.
  more = more === true;
  const cursor = more ? legacyMemoriesData.next_cursor : null;
  if (more && !cursor) return;
  const epoch = ++legacyMemoryListEpoch;
  const params = new URLSearchParams();
  if ($("legacyMemorySearch").value)
    params.set("query", $("legacyMemorySearch").value);
  if ($("legacyMemoryAudienceFilter").value)
    params.set("audience", $("legacyMemoryAudienceFilter").value);
  if ($("legacyMemoryMemberFilter").value)
    params.set("member_ref", $("legacyMemoryMemberFilter").value);
  if ($("legacyMemoryKindFilter").value)
    params.set("kind", $("legacyMemoryKindFilter").value);
  if ($("legacyMemoryArchivedFilter").checked) params.set("status", "all");
  if (cursor) params.set("cursor", cursor);
  $("legacyMemoryMore").disabled = true;
  try {
    const result = await api(
      "legacy-memories" + (params.size ? "?" + params : ""),
    );
    if (epoch !== legacyMemoryListEpoch || !key) return;
    legacyMemoriesData = {
      ...result,
      items: more
        ? [
            ...new Map(
              [...legacyMemoriesData.items, ...result.items].map((item) => [
                item.id,
                item,
              ]),
            ).values(),
          ]
        : result.items,
    };
    legacyRenderMemories();
  } catch (error) {
    if (epoch !== legacyMemoryListEpoch || !key) return;
    legacyMemoriesData = { items: [], members: [] };
    legacyRenderMemories();
    $("legacyMemoryStatus").textContent =
      "Memory could not be loaded. Refresh to retry.";
    legacyMemoryLoadError(error);
  } finally {
    if (epoch === legacyMemoryListEpoch) $("legacyMemoryMore").disabled = false;
  }
}

for (const id of [
  "legacyMemorySearch",
  "legacyMemoryAudienceFilter",
  "legacyMemoryMemberFilter",
  "legacyMemoryKindFilter",
  "legacyMemoryArchivedFilter",
])
  $(id).addEventListener("input", () => {
    legacyInvalidateMemory();
    void legacyLoadMemories();
  });
action("legacyMemoryRefresh", legacyLoadMemories);
action("legacyMemoryMore", () => legacyLoadMemories(true));
action("legacyMemoryNew", async () => legacyMemoryDraft());
action("legacyMemorySave", async () => {
  const body = {
    audience: $("legacyMemoryAudience").value,
    member_ref: $("legacyMemoryMember").value || undefined,
    kind: $("legacyMemoryKind").value,
    text: $("legacyMemoryText").value,
    importance: legacyMemoryNumber("legacyMemoryImportance", 0.85),
    goal_relevance: legacyMemoryNumber("legacyMemoryRelevance", 0.85),
    review_at:
      $("legacyMemoryReviewAt").value ===
      (legacySelectedMemoryReviewAt?.slice(0, 10) || "")
        ? legacySelectedMemoryReviewAt
        : $("legacyMemoryReviewAt").value
          ? $("legacyMemoryReviewAt").value + "T00:00:00.000Z"
          : null,
    pinned: $("legacyMemoryPinned").checked,
    expected_revision: legacySelectedMemoryRevision || undefined,
  };
  const path = legacySelectedMemoryId
    ? "legacy-memories/" + legacySelectedMemoryId
    : "legacy-memories";
  const epoch = legacyInvalidateMemory();
  const result = await api(path, body);
  if (epoch !== legacyMemoryHistoryEpoch || !key) return;
  legacyMemoryDraft(result.item);
  await legacyLoadMemoryHistory(result.item.id).catch(legacyMemoryLoadError);
  await legacyLoadMemories();
  notice("Legacy note saved.", "success");
});
$("legacyMemories").ontoggle = () => {
  if ($("legacyMemories").open && key) void legacyLoadMemories();
};
function renderCoachName() {
  const name =
    key && typeof config?.persona?.name === "string"
      ? config.persona.name.trim()
      : "";
  const label = name || "Coach";
  $("coachLauncherName").textContent = label;
  $("coachLauncher").title = label;
  $("coachPaneName").textContent = label;
  $("coachPaneName").title = label;
}
// Global Coach pane. The page underneath keeps its own route and history; the
// pane only docks, expands or collapses around it and never owns a URL.
const paneStateKey = "katafit-coach-pane",
  paneMin = 360,
  paneMax = 960,
  pageMin = 480,
  tabLabels = {
    dashboard: "Dojo",
    diagnostics: "Activity",
    settings: "Server Settings",
    coachSettings: "Coach Settings",
  };
const dockedQuery = matchMedia("(min-width: 900px)");
let paneOpen = false,
  paneExpanded = false,
  // Pi is wanted only after the pane was first opened in this unlock.
  paneStarted = false,
  paneNewOutput = false,
  paneWidth = 520,
  paneCovering = false,
  paneScroll = 0,
  studioTab,
  dashboardPending = false;
try {
  const saved = JSON.parse(sessionStorage.getItem(paneStateKey) || "{}");
  if (Number.isFinite(saved.width)) paneWidth = saved.width;
} catch {}
function savePaneState() {
  try {
    sessionStorage.setItem(
      paneStateKey,
      JSON.stringify({
        width: paneWidth,
        ...(paneOpen && { open: true, expanded: paneExpanded }),
      }),
    );
  } catch {}
}
function restorePaneState() {
  try {
    return JSON.parse(sessionStorage.getItem(paneStateKey) || "{}");
  } catch {
    return {};
  }
}
function paneMode() {
  if (!paneOpen || !key || $("studio").hidden) return "closed";
  if (!dockedQuery.matches) return "mobile";
  return paneExpanded ? "expanded" : "docked";
}
const paneShown = () => paneMode() !== "closed" && !document.hidden;
const pageCovered = () => ["expanded", "mobile"].includes(paneMode());
function paneBounds() {
  const room = document.documentElement.clientWidth - pageMin;
  return { min: paneMin, max: Math.max(paneMin, Math.min(paneMax, room)) };
}
// The rendered width: the preferred width clamped to the current viewport.
function clampPaneWidth(width) {
  const { min, max } = paneBounds();
  return Math.round(Math.min(max, Math.max(min, width)));
}
function setPaneWidth(width, persist = true) {
  const { min, max } = paneBounds();
  const value = clampPaneWidth(width);
  if (persist) paneWidth = value;
  document.documentElement.style.setProperty(
    "--coach-pane-width",
    value + "px",
  );
  const divider = $("coachDivider");
  divider.setAttribute("aria-valuemin", String(min));
  divider.setAttribute("aria-valuemax", String(max));
  divider.setAttribute("aria-valuenow", String(value));
  divider.setAttribute("aria-valuetext", value + " pixels wide");
  if (persist) savePaneState();
}
function syncPaneTop() {
  // Expanded Coach fills the workspace below the header and any notice.
  const header = document.querySelector("header").getBoundingClientRect();
  const bar = $("noticeBar");
  const top = bar.dataset.severity
    ? Math.max(header.bottom, bar.getBoundingClientRect().bottom)
    : header.bottom;
  document.documentElement.style.setProperty(
    "--coach-pane-top",
    Math.max(0, Math.round(top)) + "px",
  );
}
function renderPane() {
  const mode = paneMode();
  const unlocked = !!key && !$("studio").hidden;
  $("coachLauncher").hidden = !unlocked;
  $("coachLauncher").setAttribute("aria-expanded", String(mode !== "closed"));
  if (mode !== "closed") paneNewOutput = false;
  $("coachLauncherIndicator").hidden = !paneNewOutput;
  if (paneNewOutput) $("coachLauncher").dataset.newOutput = "true";
  else delete $("coachLauncher").dataset.newOutput;
  $("coachPane").hidden = mode === "closed";
  $("coachPane").dataset.mode = mode;
  $("coachPaneExpand").textContent = mode === "expanded" ? "Restore" : "Expand";
  $("coachPaneExpand").setAttribute(
    "aria-pressed",
    String(mode === "expanded"),
  );
  $("coachPaneBack").textContent =
    "Back to " + (tabLabels[studioTab] || "Dojo");
  setPaneWidth(paneWidth, false);
  const covering = mode === "expanded" || mode === "mobile";
  const workspace = $("workspaceScroll");
  const owned = document.documentElement.classList.contains("coach-open");
  const open = mode !== "closed";
  // Read the old owner before changing layout. Covered content retains its
  // logical offset even if a narrower/shorter layout temporarily clamps it.
  const offset = paneCovering
    ? paneScroll
    : owned
      ? workspace.scrollTop
      : scrollY;
  if (covering && !paneCovering) paneScroll = offset;
  document.body.classList.toggle("coach-docked", mode === "docked");
  document.documentElement.classList.toggle("coach-open", open);
  document.documentElement.classList.toggle("coach-covered", covering);
  if (open) {
    if (!owned || paneCovering !== covering) workspace.scrollTop = offset;
    if (!owned) scrollTo(0, 0);
  } else if (owned) {
    scrollTo(0, offset);
    workspace.scrollTop = 0;
  }
  if (covering) syncPaneTop();
  // Covered content is out of reach for pointer, keyboard and assistive tech.
  // Focus inside newly covered content moves to the pane rather than <body>.
  const focused = document.activeElement;
  if (mode === "docked") workspace.setAttribute("tabindex", "0");
  else workspace.removeAttribute("tabindex");
  workspace.inert = mode === "mobile";
  const covered =
    mode === "mobile"
      ? document.querySelector("main")
      : mode === "expanded"
        ? $("studio")
        : undefined;
  document.querySelector("main").inert = mode === "mobile";
  $("studio").inert = mode === "expanded";
  if (covered?.contains(focused) || (covering && focused === workspace))
    (mode === "mobile" ? $("coachPaneBack") : $("coachPaneExpand")).focus();
  if (covering === paneCovering) return;
  paneCovering = covering;
  if (!covering) {
    if (dashboardPending && studioTab === "dashboard" && key) {
      dashboardPending = false;
      CoachDashboard.load(api, key);
    }
  }
  // Covered pages stop polling; a docked pane leaves them running.
  logVisibility();
}
function openPane(expand = false) {
  paneOpen = true;
  paneExpanded = expand;
  paneStarted = true;
  savePaneState();
  renderPane();
  if (key && !document.hidden) void native.connect();
  if (native.started()) native.focus();
  else
    (dockedQuery.matches ? $("coachPaneCollapse") : $("coachPaneBack")).focus();
}
function collapsePane() {
  paneOpen = false;
  paneExpanded = false;
  savePaneState();
  renderPane();
  $("coachLauncher").focus({ preventScroll: true });
}
function closePaneForLock() {
  paneOpen = false;
  paneExpanded = false;
  paneStarted = false;
  paneNewOutput = false;
  dashboardPending = false;
  studioTab = undefined;
  savePaneState();
  renderPane();
}
$("coachLauncher").onclick = () =>
  paneMode() === "closed" ? openPane() : collapsePane();
$("coachPaneCollapse").onclick = collapsePane;
$("coachPaneBack").onclick = collapsePane;
// Deliberately starting again after a native Stop; nothing restarts on its own.
$("coachPaneStart").onclick = () => {
  if (key && !document.hidden) void native.connect();
  $("coachPaneCollapse").focus();
};
$("coachPaneExpand").onclick = () => {
  paneExpanded = !paneExpanded;
  savePaneState();
  renderPane();
};
// Escape on pane controls collapses; inside the terminal it stays Pi input.
$("coachPane").addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !$("nativeTerminal").contains(event.target) &&
    !event.target.closest("dialog")
  ) {
    event.preventDefault();
    collapsePane();
  }
});
$("coachDivider").addEventListener("keydown", (event) => {
  const { min, max } = paneBounds();
  const step = event.shiftKey ? 64 : 16;
  // Adjust what is on screen, not a wider preference the viewport clamped.
  const width = clampPaneWidth(paneWidth);
  const next = {
    ArrowLeft: width + step,
    ArrowRight: width - step,
    Home: min,
    End: max,
  }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  setPaneWidth(next);
});
$("coachDivider").addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  const divider = $("coachDivider");
  const startX = event.clientX,
    startWidth = clampPaneWidth(paneWidth);
  divider.setPointerCapture(event.pointerId);
  divider.focus();
  const move = (e) => setPaneWidth(startWidth + startX - e.clientX);
  const end = () => {
    divider.removeEventListener("pointermove", move);
    divider.removeEventListener("pointerup", end);
    divider.removeEventListener("pointercancel", end);
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", end);
  divider.addEventListener("pointercancel", end);
});
dockedQuery.addEventListener("change", renderPane);
new ResizeObserver(() => {
  if (paneCovering) syncPaneTop();
}).observe($("noticeBar"));
window.addEventListener("resize", () => setPaneWidth(paneWidth, false));
function coachOutput() {
  if (paneShown() || paneNewOutput) return;
  paneNewOutput = true;
  renderPane();
}
const paneStatusLabels = {
  starting: "Starting…",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error",
  unavailable: "Unavailable",
  overflow: "Output overflow",
  ended: "Session ended",
};
function coachStatus(state, text) {
  const node = $("coachPaneStatus");
  node.textContent = paneStatusLabels[state] || "Not started";
  node.dataset.state = state;
  node.title = text;
  const start = $("coachPaneStart");
  const focused = document.activeElement === start;
  start.hidden = state !== "ended";
  if (focused && start.hidden) native.focus();
}
function studioRoute() {
  const path = location.pathname;
  // Former chat views open the pane over the page already shown, or Dojo.
  if (path === "/chat/operator" || path.startsWith("/chat/member/"))
    return { tab: studioTab || "dashboard", chat: true };
  if (path === "/diagnostics")
    return {
      tab: "diagnostics",
      section: new URLSearchParams(location.search).get("section"),
    };
  if (path === "/settings") {
    const section =
      new URLSearchParams(location.search).get("section") ??
      (location.hash === "#logsView" ? "diagnostics" : location.hash.slice(1));
    return section === "diagnostics"
      ? { tab: "diagnostics", legacy: true }
      : { tab: settingsGroup(section), section };
  }
  return { tab: "dashboard" };
}
function studioPath(tab) {
  return tab === "dashboard"
    ? "/dashboard"
    : tab === "diagnostics"
      ? "/diagnostics?section=" + diagnosticsSection
      : settingsPath();
}
function navigateStudio(path) {
  if (location.pathname + location.search + location.hash !== path)
    history.pushState(null, "", path);
}
function restoreStudioRoute(restartDiagnostics = false) {
  const route = studioRoute();
  if (route.chat) {
    // Expand before selecting so a covered Dojo defers its reads.
    paneOpen = paneExpanded = true;
    history.replaceState(null, "", studioPath(route.tab));
  } else if (route.legacy) history.replaceState(null, "", "/diagnostics");
  if (route.tab === "diagnostics" && !route.chat)
    selectDiagnosticsSection(route.section, false);
  if (
    (route.chat ? studioTab !== route.tab : true) &&
    (restartDiagnostics ||
      route.tab !== "diagnostics" ||
      $("diagnostics").hidden)
  )
    selectStudioTab(route.tab, false, route.chat ? undefined : route.section);
  if (route.chat) openPane(true);
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
function selectStudioTab(
  tab,
  navigate = true,
  section = rememberedSettings[tab],
) {
  const dashboard = tab === "dashboard";
  if (tab === "settings" || tab === "coachSettings")
    selectSettingsSection(section, false);
  studioTab = tab;
  $("dashboardPanel").hidden = !dashboard;
  $("settingsPanel").hidden = tab !== "settings" && tab !== "coachSettings";
  $("diagnostics").hidden = tab !== "diagnostics";
  if (historyVisible()) void loadPersonaHistory();
  for (const [id, active] of [
    ["dashboardTab", dashboard],
    ["settingsTab", tab === "settings"],
    ["coachSettingsTab", tab === "coachSettings"],
    ["diagnosticsTab", tab === "diagnostics"],
  ]) {
    $(id).setAttribute("aria-pressed", String(active));
    $(id).classList.toggle("secondary", !active);
  }
  logVisibility();
  dashboardPending = false;
  CoachDashboard.clear();
  if (dashboard && pageCovered()) dashboardPending = true;
  else if (dashboard) CoachDashboard.load(api, key);
  renderPane();
  if (navigate) navigateStudio(studioPath(tab));
  updateRouteEntry();
}
$("dashboardTab").onclick = () => selectStudioTab("dashboard");
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    CoachDashboard.clear();
    if (key && !$("dashboardPanel").hidden) dashboardPending = true;
    native.suspend();
  } else {
    if (dashboardPending && !pageCovered()) {
      dashboardPending = false;
      CoachDashboard.load(api, key);
    }
    if (key && paneStarted) native.resume();
  }
});
window.addEventListener("pagehide", () => CoachDashboard.clear());
$("settingsTab").onclick = () => selectStudioTab("settings");
$("coachSettingsTab").onclick = () => selectStudioTab("coachSettings");
$("diagnosticsTab").onclick = () => selectStudioTab("diagnostics");
const logActive = () =>
  key && !$("diagnostics").hidden && !document.hidden && !pageCovered();
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
  // retained articles every live poll. No display cap; exports use the same filter.
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
        lastAdmission: safeUpdateOperation(updateData?.lastAdmission),
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
  updatesEntryActive = false,
  updatesEntryCheckPending = false,
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
  UPDATE_BUSY:
    "Stop Coach, wait for confirmed stopped presence and publication safety, then check and confirm again. No installation was accepted and no actions will be replayed.",
  WORKER_STOP_UNCONFIRMED:
    "Verify stopped presence and publication safety using supported Stop/recovery before confirming again.",
  OPERATION_IN_PROGRESS:
    "Finish or cancel the other operation before confirming again.",
  UPDATE_NOT_ACCEPTED:
    "Inspect protected-home storage and worker status before confirming again.",
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
    "A historical automatic attempt was cancelled. Automatic source updates are no longer supported; retry only with manual confirmation.",
  UPGRADE_FAILED:
    "No specific safe failure code is available. Check host disk, Git/npm access and exact native artifact readiness before retrying manually.",
};
const updateOutcomeNames = {
  applying: "Upgrade accepted",
  succeeded: "Last upgrade succeeded",
  failed: "Last upgrade failed",
  interrupted: "Last upgrade was interrupted",
  rejected: "Last upgrade request was not accepted",
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
    ...(["preparing", "activating", "admission"].includes(outcome.phase)
      ? { phase: outcome.phase }
      : {}),
    ...(["failed", "rejected"].includes(outcome.state) &&
    Object.hasOwn(updateFailureHelp, outcome.reason)
      ? { reason: outcome.reason }
      : {}),
  };
}
function manualUpdateQueue(data = updateData) {
  const queue = data?.manualQueue;
  return queue &&
    sourceSha(queue.sha) &&
    typeof queue.id === "string" &&
    queue.id.length <= 100 &&
    [
      "waiting-worker",
      "waiting-publication",
      "waiting-native",
      "stopping",
      "installing",
      "accepted",
      "cancelled",
      "failed",
    ].includes(queue.phase)
    ? queue
    : undefined;
}
function manualUpdateWaiting(data = updateData) {
  return manualUpdateQueue(data)?.phase.startsWith("waiting-") === true;
}
function manualUpdateActive(data = updateData) {
  const queue = manualUpdateQueue(data);
  return (
    !!queue &&
    (queue.phase.startsWith("waiting-") ||
      ["stopping", "installing"].includes(queue.phase))
  );
}
function renderHeaderStatus() {
  if (!key || $("studio").hidden) return;
  if (manualUpdateWaiting()) {
    $("state").textContent = "QUEUED";
    $("state").dataset.tone = "busy";
  } else if (lifecycleBusy || lifecycleUncertain || serverTransition) {
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
function updatesVisible() {
  return (
    !!key &&
    !$("studio").hidden &&
    !$("settingsPanel").hidden &&
    !$("updates").hidden
  );
}
function updateRouteEntry() {
  const visible = updatesVisible();
  const entered = visible && !updatesEntryActive;
  updatesEntryActive = visible;
  if (!visible) {
    updatesEntryCheckPending = false;
    clearTimeout(updateTimer);
  } else if (entered) {
    if (updateRequest) updatesEntryCheckPending = true;
    else void refreshUpdate(true);
  }
}
function renderUpdate() {
  renderHeaderStatus();
  const data = updateData;
  $("restorePersona").disabled =
    historyBusy || updatePending || data?.applying === true;
  if (!data) return;

  const queue = manualUpdateQueue(data);
  const queueLabels = {
    "waiting-worker": "Waiting for accepted worker work to finish.",
    "waiting-publication":
      "Waiting for authoritative publication receipts; nothing will be discarded or replayed.",
    "waiting-native":
      "Waiting for native Pi to finish and close. Finish the turn, then use Close / Stop Pi.",
    stopping:
      "Confirming safe worker Stop. Installation can no longer be cancelled.",
    installing: "Submitting the prepared installation to the launcher.",
    accepted:
      "Launcher accepted the installation. Verify installed revision and restart status.",
    cancelled:
      "Cancelled queued upgrade. New worker claims may resume; accepted work was not aborted.",
    failed:
      "Queued upgrade could not be admitted. Verify worker safety and launcher status before retrying.",
  };
  $("updateQueueStatus").hidden = !queue;
  $("updateQueueStatus").textContent = queue
    ? `${queueLabels[queue.phase]} Target ${queue.sha.slice(0, 12)}. Waiting intent is process-local and does not survive service restart.`
    : "";
  $("updateQueueCancel").hidden = !manualUpdateWaiting(data);
  $("updateQueueCancel").disabled = updateRequest;
  const locked =
    manualUpdateActive(data) ||
    updatePending ||
    data.applying ||
    data.recovering ||
    lifecycleBusy ||
    lifecycleUncertain ||
    serverTransition;
  const admission = safeUpdateOperation(data.lastAdmission);
  const operation = safeUpdateOperation(data.lastOperation);
  const outcome =
    admission && (!operation || admission.at >= operation.at)
      ? admission
      : operation;
  const failed =
    outcome && ["failed", "interrupted", "rejected"].includes(outcome.state);
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
    data.guidance ||
    "Open Updates or press Check for updates to check main. Installation requires your confirmation.";
  $("updateStatus").textContent =
    guidance +
    (data.cleanupWarning === true && !/cleanup/i.test(guidance)
      ? " Candidate cleanup is incomplete; repair protected-home permissions before retrying this revision."
      : "");
  const checkErrors = {
    RATE_LIMITED: "GitHub rate limit. Source check failed.",
    FORBIDDEN:
      "GitHub denied the source check (HTTP 403). Rate limiting was not confirmed.",
    UNAVAILABLE:
      "GitHub unavailable or timed out. Source check failed; check network access.",
  };
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
  $("updateCheckStatus").textContent = checkStatus;
  $("updateCheckStatus").dataset.tone = checkError ? "error" : "neutral";
  const validOutcome = !!outcome;
  $("updateOutcome").dataset.tone = failed ? "error" : "neutral";
  $("updateOutcome").setAttribute("role", failed ? "alert" : "status");
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
    data.recoveryOutcome?.state === "resume-failed"
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
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    // Observe an existing queued pin before asking for source discovery. A
    // reload/lost POST never submits apply again or overwrites the queued target.
    let data = await api("update", undefined, signal);
    if (check && !manualUpdateActive(data) && !data.preparing && !data.applying)
      data = await api("update/check", {}, signal);
    if (controller.signal.aborted || generation !== authGeneration) return;
    if (updateInitialRevision === undefined)
      updateInitialRevision = data.installed;
    updateData = data;

    updatePending =
      updateApplyRequest ||
      manualUpdateActive(data) ||
      data.preparing === true ||
      data.applying === true;
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
    if (updatesEntryCheckPending && updatesVisible() && !document.hidden) {
      updatesEntryCheckPending = false;
      void refreshUpdate(true);
      return;
    }
    if (
      key &&
      !document.hidden &&
      !$("studio").hidden &&
      (updatesVisible() ||
        updatePending ||
        updateData?.preparing ||
        updateData?.applying ||
        updateData?.recovering)
    )
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
action("updateQueueCancel", async () => {
  const queue = manualUpdateQueue();
  if (!queue || !manualUpdateWaiting()) return;
  try {
    await api("update/cancel", { id: queue.id });
  } catch (error) {
    notice(error.message, "error");
  }
  await status();
  await refreshUpdate();
});
action("updateCheck", async () => {
  $("updateConfirm").hidden = true;
  await refreshUpdate(true);
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
      "Finish or cancel preview before queuing an upgrade. Accepted worker work drains first; native Pi must finish and close before installation.",
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
let updateApplyRequest = false;
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
  updateApplyRequest = true;
  updateError = "Upgrade requested. Waiting for verified runtime status…";
  $("updateConfirm").hidden = true;
  renderUpdate();
  try {
    await api(
      "update/apply",
      { sha: updateTarget, confirm: true },
      // Source staging/build/probe takes longer than ordinary Studio reads.
      // A lost response remains ambiguous; observe status, never replay apply.
      AbortSignal.timeout(900000),
    );
  } catch (error) {
    if (generation !== authGeneration) return;
    if (error.status) {
      updatePending = false;
      notice(error.message, "error");
    } else
      updateError =
        "Studio is unavailable. The upgrade may have been accepted; reconnecting to verify.";
  } finally {
    if (generation === authGeneration) updateApplyRequest = false;
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
  CoachDashboard.clear();
  closePaneForLock();
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
  updateApplyRequest = false;
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
  resetMemories();
  renderCoachName();
  renderOperatorActions();
  $("operatorDeliveryHistory").open = false;

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
  updatesEntryActive = false;
  updatesEntryCheckPending = false;
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
  renderPane();
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

async function loadNativeReceipts() {
  const generation = authGeneration;
  try {
    const receipts = await api("terminal/receipts");
    if (generation !== authGeneration) return;
    renderOperatorActions(receipts.actions);
    $("operatorStatus").textContent = "";
  } catch (error) {
    if (!error.stale)
      $("operatorStatus").textContent =
        "Action receipts unavailable. Do not retry uncertain writes.";
  }
}
$("operatorReconcile").onclick = () => loadNativeReceipts();
// Coach pane memory notices: committed receipts for the current session only.
// Nothing here is stored; a new session starts empty.
let coachMemoryNotices = [],
  coachMemoryChatOff = false;
const coachMemoryVerbs = {
  remembered: "Remembered",
  updated: "Updated",
  forgotten: "Forgotten",
};
async function openMemory(id, editing) {
  selectStudioTab("coachSettings", true, "memories");
  const item = await memorySelect(id);
  if (!item) return;
  $("memoryEditor").scrollIntoView({ block: "nearest" });
  if (editing) $("memoryText").focus();
}
function renderCoachMemory() {
  const list = $("coachMemoryList");
  list.replaceChildren();
  for (const n of coachMemoryNotices) {
    if (n.action === "learning-off") {
      list.append(detailText("li", n.note || "Automatic learning is off."));
      continue;
    }
    if (n.action === "needs-review") {
      // One compact notice: nothing changed; the owner reviews protected
      // memories a newer automatic replacement would have overwritten.
      const li = document.createElement("li");
      li.className = "coach-memory-notice";
      li.append(
        detailText(
          "p",
          n.note ||
            "New information in this chat conflicts with a protected memory. Nothing was changed.",
        ),
      );
      for (const item of n.items) {
        li.append(detailText("p", `Needs review: ${item.text || "a memory"}`));
        const actions = document.createElement("div");
        actions.className = "actions";
        for (const [label, editing] of [
          ["View", false],
          ["Edit", true],
        ]) {
          const b = detailText("button", label);
          b.type = "button";
          b.className = "secondary";
          b.onclick = () =>
            openMemory(item.id, editing).catch((error) => {
              if (!error.stale) notice(error.message, "error");
            });
          actions.append(b);
        }
        li.append(actions);
      }
      list.append(li);
      continue;
    }
    for (const item of n.items) {
      const li = document.createElement("li");
      li.className = "coach-memory-notice";
      const source =
        n.source === "automatic" ? " (learned from this chat)" : "";
      li.append(
        detailText(
          "p",
          `${coachMemoryVerbs[n.action] || n.action}${source}: ${
            item.status === "forgotten" ? "a memory" : item.text || "a memory"
          }`,
        ),
      );
      if (n.action === "forgotten" && n.note) {
        const note = detailText("p", n.note);
        note.className = "hint";
        li.append(note);
      }
      if (item.status !== "forgotten") {
        const actions = document.createElement("div");
        actions.className = "actions";
        const add = (label, fn) => {
          const b = detailText("button", label);
          b.type = "button";
          b.className = "secondary";
          b.onclick = () =>
            fn().catch((error) => {
              if (!error.stale) notice(error.message, "error");
            });
          actions.append(b);
        };
        add("View", () => openMemory(item.id, false));
        add("Edit", () => openMemory(item.id, true));
        add("Forget", async () => {
          const fail = (error) => {
            memoryActionError(error);
            throw Object.assign(error, { stale: true });
          };
          const impact = await memoryForgetConfirm(item.id).catch(fail);
          if (!impact) return;
          const result = await memoryWrite({
            path: "memories/" + item.id + "/forget",
            body: { expected_revision: item.revision },
            expect: { kind: "forget", memory_id: item.id },
            label: "Forget memory",
          }).catch(fail);
          item.status = "forgotten";
          renderCoachMemory();
          notice(
            MEMORY_FORGET_COPY + memoryForgotten(result, impact),
            "success",
          );
          if (settingsSection === "memories") void loadMemories();
        });
        li.append(actions);
      }
      list.append(li);
    }
  }
  $("coachDontSave").disabled = coachMemoryChatOff;
  $("coachMemoryState").textContent = coachMemoryChatOff
    ? "Automatic learning is off locally for this chat. Check the discard notice below: pending or unverified capture discard is not a guarantee that this chat won't be saved. Anything already committed stays in Memories."
    : coachMemoryNotices.length
      ? ""
      : "Notices appear here when your Coach saves, updates or forgets a memory in this chat.";
}
function coachMemory(message) {
  if (message.type === "memory-notices") {
    coachMemoryNotices = Array.isArray(message.notices)
      ? message.notices.slice(-20)
      : [];
    coachMemoryChatOff = message.learning_off === true;
  } else if (message.notice) {
    coachMemoryNotices = [...coachMemoryNotices, message.notice].slice(-20);
    if (
      message.notice.action === "learning-off" &&
      message.notice.source === "user"
    )
      coachMemoryChatOff = true;
  }
  renderCoachMemory();
}
$("coachDontSave").onclick = () => {
  if (native.stopMemoryCapture()) {
    coachMemoryChatOff = true;
    renderCoachMemory();
  } else
    notice(
      "Start or reconnect the Coach session first; nothing was changed.",
      "warning",
    );
};
const native = nativeTerminal({
  api,
  active: () => !!key && !document.hidden && paneStarted,
  visible: paneShown,
  // Never steal focus from the page underneath a docked pane.
  canFocus: () =>
    paneShown() &&
    (document.activeElement === document.body ||
      $("coachPane").contains(document.activeElement)),
  onStatus: coachStatus,
  onOutput: coachOutput,
  onMemory: (message) => coachMemory(message),
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

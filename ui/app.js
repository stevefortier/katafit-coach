let key = "",
  workerState,
  config,
  authGeneration = 0,
  commandViewEpoch = 0;
function clearCommandResult() {
  ++commandViewEpoch;
  $("operatorCommandResult").replaceChildren();
  $("operatorCommandResult").hidden = true;
}
function renderOperatorActions(actions = []) {
  const labels = {
    delivered: "Delivered",
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
        labels[action.status] +
          (action.action_id ? " · " + action.action_id : ""),
      ),
    );
  }
  if (!actions.length)
    $("operatorActions").textContent = "No retained member action receipts.";
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
const notice = (t) => ($("notice").textContent = t);
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
    if (/^members\/(activity|activities)\?/.test(path)) {
      const reader = r.body.getReader(),
        chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 256 * 1024) {
            await reader.cancel();
            throw new Error("Detail response too large");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      data = JSON.parse(await new Blob(chunks).text());
    } else data = await r.json();
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
      );
      const error = new Error(
        "Studio authorization expired. Unlock again with the current admin key.",
      );
      error.status = 401;
      throw error;
    }
    const error = new Error(data.error + (data.hint ? " — " + data.hint : ""));
    error.status = r.status;
    throw error;
  }
  return data;
}
async function load() {
  const generation = authGeneration;
  const data = await api("config");
  if (generation !== authGeneration) throw staleAuthentication();
  if (config) resetMembers();
  config = data;
  for (const f of fields) $(f).value = config.persona[f];
  $("origin").value = config.origin;
  $("model").value = config.provider.model;
  $("baseUrl").value = config.provider.baseUrl;
  $("vision").checked = config.provider.vision === true;
  $("revision").textContent = "Saved revision " + config.revision;
  $("token").value = "";
  $("apiKey").value = "";
  $("prompt").textContent =
    "Preview the saved revision with freshly fetched backend instructions. Unsaved edits are not previewed.";
  $("answer").textContent = "Your preview will appear here.";
}
function action(id, fn) {
  $(id).onclick = async () => {
    try {
      await fn();
    } catch (e) {
      if (!e.stale) notice(e.message);
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
  restoreStudioRoute();
  void loadOperator();
  await status();
  await refreshUpdate(true);
});
action("save", async () => {
  const persona = Object.fromEntries(fields.map((f) => [f, $(f).value]));
  await api("config", {
    persona,
    origin: $("origin").value,
    provider: {
      baseUrl: $("baseUrl").value,
      model: $("model").value,
      vision: $("vision").checked,
    },
    token: $("token").value,
    apiKey: $("apiKey").value,
  });
  await load();
  notice("Saved. Preview this revision before starting the worker.");
});
action("resetPersona", async () => {
  const { persona } = await api("persona-defaults");
  for (const f of fields) $(f).value = persona[f];
  notice(
    "Restored stock persona in the editor. Save a new revision to apply it.",
  );
});
action("rollback", async () => {
  await api("rollback", {});
  await load();
  notice(
    "Previous nonsecret configuration restored as a new revision. Credentials unchanged.",
  );
});
action("connect", async () => notice((await api("connect", {})).message));
function hasUnsavedEdits() {
  return (
    fields.some((f) => $(f).value !== config.persona[f]) ||
    $("origin").value !== config.origin ||
    $("baseUrl").value !== config.provider.baseUrl ||
    $("model").value !== config.provider.model ||
    $("vision").checked !== (config.provider.vision === true) ||
    !!$("token").value ||
    !!$("apiKey").value
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
chatKeyboard("operatorText", "operatorSend");
chatKeyboard("question", "previewButton");
let previewBusy = false;
action("previewButton", async () => {
  if (!key || previewBusy || !$("question").value.trim()) return;
  if (hasUnsavedEdits()) {
    notice(
      "Unsaved edits: save a new revision or revert edits before previewing.",
    );
    return;
  }
  $("answer").textContent = "Preview pending.";
  $("prompt").textContent =
    "Fetching backend instructions; exact preview not yet available.";
  notice("Preview running with your saved provider…");
  previewBusy = true;
  $("previewButton").disabled = true;
  let r;
  try {
    r = await api("preview", { text: $("question").value });
  } finally {
    previewBusy = false;
    $("previewButton").disabled =
      updatePending || updateData?.applying === true;
  }
  $("answer").textContent = r.text;
  $("prompt").textContent = r.prompt;
  notice("Preview complete · revision " + r.revision);
});
action("cancel", async () => {
  await api("cancel", {});
  notice("Cancellation requested.");
});
for (const cmd of ["run", "stop"])
  action(cmd, async () => {
    const generation = authGeneration;
    const result = await api(cmd, {});
    await status();
    if (generation !== authGeneration) return;
    notice(
      cmd === "run"
        ? result.presence === "reported"
          ? "Worker started and presence reported. Wait for persisted-reply status to confirm delivery."
          : "Worker started; this backend does not support explicit presence. Connectivity is not confirmed by a heartbeat."
        : result.presence === "reported"
          ? "Worker stopped; backend stop reported."
          : "Worker stopped locally; backend stop unconfirmed. Chat may not fail immediately while the backend still considers this worker online.",
    );
  });
action("export", async () => {
  const c = await api("config");
  delete c.hasToken;
  delete c.hasApiKey;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(c, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "katafit-coach-persona.json";
  a.click();
  URL.revokeObjectURL(url);
});
$("preset").onchange = () => {
  if ($("preset").value === "openai") {
    $("baseUrl").value = "https://api.openai.com/v1";
    $("model").value = "gpt-4.1-mini";
  }
};
async function status() {
  if (!key || document.hidden) return;
  const generation = authGeneration;
  try {
    const s = await api("status");
    if (generation !== authGeneration) return;
    workerState = s.state;
    renderHeaderStatus();
    updateWorkerBlocked =
      s.state !== "stopped" || s.preview === true || s.operatorChat === true;
    renderUpdate();
    $("lastError").textContent = s.lastError
      ? "Last error · " +
        s.lastError.time +
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
function studioRoute() {
  if (location.pathname === "/settings") return { tab: "settings" };
  if (location.pathname.startsWith("/chat/member/")) {
    try {
      return {
        tab: "coach",
        member: decodeURIComponent(location.pathname.slice(13)),
      };
    } catch {}
  }
  return { tab: "coach" };
}
function navigateStudio(path) {
  if (location.pathname !== path) history.pushState(null, "", path);
}
function restoreStudioRoute() {
  const route = studioRoute();
  selectStudioTab(route.tab, false);
  if (route.tab === "coach") {
    const member = route.member
      ? members.find((m) => m.member_ref === route.member)
      : null;
    selectConversation(member || null, false);
  }
}
window.addEventListener("popstate", () => {
  if (key) restoreStudioRoute();
});
function selectStudioTab(tab, navigate = true) {
  clearCommandResult();
  const coach = tab === "coach";
  $("coachPanel").hidden = !coach;
  $("settingsPanel").hidden = coach;
  for (const [id, active] of [
    ["coachTab", coach],
    ["settingsTab", !coach],
  ]) {
    $(id).setAttribute("aria-pressed", String(active));
    $(id).classList.toggle("secondary", !active);
  }
  logVisibility();
  if (coach) operatorSnapshotLabel();
  memberVisibility();
  if (coach && key && !members.length) void loadMembers();
  if (navigate)
    navigateStudio(
      coach
        ? selectedMember
          ? "/chat/member/" + encodeURIComponent(selectedMember.member_ref)
          : "/chat/operator"
        : "/settings",
    );
}
$("coachTab").onclick = () => selectStudioTab("coach");
$("settingsTab").onclick = () => selectStudioTab("settings");
const logActive = () =>
  key && !$("settingsPanel").hidden && $("logsView").open && !document.hidden;
function filteredLogs() {
  return logData.entries.filter(
    (e) => $("logLevel").value === "all" || e.level === $("logLevel").value,
  );
}
function renderLogs() {
  const rows = filteredLogs();
  $("logRows").replaceChildren();
  for (const e of [...rows].reverse()) {
    const row = document.createElement("article");
    row.className = "log-entry log-" + e.level;
    const title = document.createElement("strong");
    title.textContent =
      e.level.toUpperCase() +
      " · " +
      e.source +
      " / " +
      e.stage +
      (e.code ? " · " + e.code : "");
    const meta = document.createElement("small");
    meta.textContent =
      e.time +
      (e.ref ? " · ref " + e.ref : "") +
      " · " +
      JSON.stringify(e.metadata);
    row.append(title, meta);
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
    $("logRows").append(row);
  }
  if (!rows.length) $("logRows").textContent = "No entries match this level.";
  $("logStatus").textContent =
    `${rows.length} shown / ${logData.entries.length} retained (max ${logData.capacity ?? 500}) · ${logPaused ? "Paused" : "Live when open and visible"} · ${logData.persistence === false ? "Disk logging unavailable; memory only" : "Protected rotating files"}`;
}
async function refreshLogs() {
  clearTimeout(logTimer);
  if (!logActive() || logController) return;
  const controller = new AbortController();
  logController = controller;
  try {
    const data = await api("logs", undefined, controller.signal);
    if (!controller.signal.aborted && logActive()) {
      logData = data;
      renderLogs();
      await status();
    }
  } catch (e) {
    if (!controller.signal.aborted) $("logStatus").textContent = e.message;
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
  if (logActive() && !logPaused) refreshLogs();
}
$("logsView").addEventListener("toggle", logVisibility);
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
  JSON.stringify({ ...logData, entries: filteredLogs() }, null, 2);
action("logCopy", async () => {
  await navigator.clipboard.writeText(logJSON());
  notice(
    "Diagnostic JSON copied. Model-visible health and meal text may remain even after screening; inspect and redact before sharing.",
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
  updateRequest = false,
  updatePending = false,
  updateWorkerBlocked = true,
  updateError = "",
  updateTimer,
  updateController,
  updateTarget,
  updateInitialRevision;
const sourceSha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
function renderHeaderStatus() {
  if (!key || $("studio").hidden) return;
  if (updatePending || updateData?.applying === true) {
    $("state").textContent = "UPGRADING";
    $("state").dataset.tone = "busy";
  } else if (workerState) {
    $("state").textContent = workerState.toUpperCase();
    $("state").dataset.tone = workerStatusTone(workerState);
  }
}
function renderUpdate() {
  renderHeaderStatus();
  const data = updateData;
  if (!data) return;
  const locked = updatePending || data.applying;
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
  $("updateStatus").textContent =
    updateError ||
    (data.auto?.enabled && data.guidance?.startsWith("New source available.")
      ? "Main differs from the installed source. Automatic upgrade will verify it and wait for an idle worker."
      : data.guidance);
  $("updateAuto").disabled =
    !data.supported || data.auto?.available !== true || updateRequest;
  $("updateAuto").checked = data.auto?.enabled === true;
  const autoStates = {
    running:
      "Upgrade committed; worker started locally. Check Worker status for ongoing connectivity.",
    stopped: "Upgrade committed; previously stopped worker remains stopped.",
    deferred: "Automatic upgrade was deferred; no source change was made.",
    "restored-running":
      "Upgrade failed; previous runtime restored and worker started locally. Check Worker status.",
    failed:
      "Automatic upgrade failed; previous runtime retained. This revision will not retry automatically.",
    "resume-failed":
      "Worker restart could not be confirmed. Check Worker status and start it manually if needed; inspect upgrade result separately.",
  };
  $("updateAutoStatus").textContent =
    data.autoOutcome &&
    sourceSha(data.autoOutcome.sha) &&
    Object.hasOwn(autoStates, data.autoOutcome.state)
      ? autoStates[data.autoOutcome.state]
      : data.supported && data.auto?.available === false
        ? "Launcher upgrade required. Replace the launcher or container image with the current build, restart the service using the same Coach home, then reload Studio. Source upgrades alone leave the old launcher running."
        : data.auto?.enabled
          ? "Enabled. Waiting for a newer verified main revision and an idle worker."
          : "Off. Enable to upgrade from main automatically.";
  const outcome = data.lastOperation;
  const outcomeNames = {
    applying: "Upgrade accepted",
    succeeded: "Last upgrade succeeded",
    failed: "Last upgrade failed",
    interrupted: "Last upgrade was interrupted",
  };
  const validOutcome =
    outcome &&
    sourceSha(outcome.sha) &&
    typeof outcome.id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      outcome.id,
    ) &&
    Object.hasOwn(outcomeNames, outcome.state) &&
    Number.isSafeInteger(outcome.at) &&
    outcome.at > 0 &&
    Number.isFinite(new Date(outcome.at).getTime());
  $("updateOutcome").hidden = !validOutcome;
  $("updateOutcome").textContent = validOutcome
    ? `${outcomeNames[outcome.state]} · ${outcome.sha.slice(0, 12)} · ${new Date(outcome.at).toLocaleString()}`
    : "";
  $("updateOutcome").title = validOutcome
    ? `Operation ${outcome.id}; target ${outcome.sha}`
    : "";
  $("updateChecked").textContent = data.checkedAt
    ? "Last check · " + new Date(data.checkedAt).toLocaleString()
    : "Not checked yet.";
  $("updateCheck").disabled = updateRequest || locked;
  $("updateApply").disabled =
    updateRequest ||
    locked ||
    updateWorkerBlocked ||
    !data.supported ||
    !sourceSha(data.latest) ||
    data.latest === data.installed;
  $("updateConfirmApply").disabled =
    locked || updateRequest || updateWorkerBlocked;
  for (const id of [
    "run",
    "stop",
    "save",
    "rollback",
    "previewButton",
    "connect",
    "cancel",
  ])
    $(id).disabled = locked;
  for (const input of document.querySelectorAll(
    "#connection input, #connection select, #persona input, #persona textarea, #persona select",
  ))
    input.disabled = locked;
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
    updateController = undefined;
    renderUpdate();
    if (key && !document.hidden && !$("studio").hidden)
      updateTimer = setTimeout(
        () => refreshUpdate(),
        updatePending || updateData?.applying || updateError ? 2000 : 30000,
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
    notice("Could not save automatic update setting. Check Studio connection.");
  } finally {
    renderUpdate();
  }
});
action("updateApply", async () => {
  const generation = authGeneration;
  if (hasUnsavedEdits()) {
    notice("Unsaved edits: save or revert changes before upgrading.");
    return;
  }
  await status();
  if (generation !== authGeneration) return;
  if (updateWorkerBlocked) {
    notice(
      "Pause the worker and finish or cancel preview and operator chat before upgrading.",
    );
    return;
  }
  if (!sourceSha(updateData?.latest) || updatePending || updateData.applying)
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
    notice("Unsaved edits: save or revert changes before reloading.");
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
    updateData.applying
  )
    return;
  if (hasUnsavedEdits()) {
    notice("Unsaved edits: save or revert changes before upgrading.");
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
      notice(error.message);
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
function lockSession(message) {
  authGeneration++;
  key = "";
  rememberAdmin("");
  config = undefined;
  resetMembers();
  ++operatorEpoch;
  operatorMessages = [];
  renderOperatorActions();
  operatorDraft = "";
  operatorBusy = false;
  operatorControlPending = false;
  $("operatorText").value = "";
  $("operatorStatus").textContent = "";
  renderOperator();
  clearTimeout(updateTimer);
  updateController?.abort();
  updateController = undefined;
  updateRequest = false;
  updatePending = false;
  updateWorkerBlocked = true;
  workerState = undefined;
  updateData = undefined;
  updateTarget = undefined;
  $("updateConfirm").hidden = true;
  clearTimeout(logTimer);
  logController?.abort();
  $("studio").hidden = true;
  $("login").hidden = false;
  $("lockStudio").hidden = true;
  $("state").textContent = "LOCKED";
  $("state").dataset.tone = "neutral";
  notice(message);
}
action("lockStudio", async () =>
  lockSession(
    "Studio locked. This does not stop the worker or an accepted upgrade.",
  ),
);

// Operator state is memory-only and fenced independently of authentication.
let operatorMessages = [],
  operatorBusy = false,
  operatorControlPending = false,
  operatorEpoch = 0,
  operatorDraft = "";
function operatorSnapshotLabel() {
  if (!config) return;
  $("operatorSnapshot").textContent =
    "Uses saved configuration · revision " +
    config.revision +
    (hasUnsavedEdits()
      ? " · Unsaved Settings edits are not used."
      : " · Settings changes must be explicitly saved.");
}
function renderOperator() {
  const list = $("operatorMessages");
  list.replaceChildren();
  for (const message of operatorMessages) {
    if (
      !["user", "assistant"].includes(message.role) ||
      typeof message.text !== "string"
    )
      continue;
    const bubble = document.createElement("article");
    bubble.className = "chat-message chat-" + message.role;
    const label = document.createElement("strong");
    label.textContent = message.role === "user" ? "You · Manager" : "Coach";
    const text = document.createElement("p");
    text.textContent = message.text;
    bubble.append(label, text);
    if (message.role === "user") {
      const use = document.createElement("button");
      use.type = "button";
      use.className = "secondary";
      use.textContent = "Use as Coach instructions";
      use.onclick = () => {
        const existing = $("markdown").value;
        if (
          existing.trim() &&
          !confirm(
            "Append this operator message to the existing persona Markdown draft? Nothing is saved until you review and Save.",
          )
        )
          return;
        $("markdown").value =
          existing + (existing.trim() ? "\n\n" : "") + message.text;
        selectStudioTab("settings");
        $("markdown").closest("details").open = true;
        $("markdown").focus();
        notice(
          "Instruction draft only. Review your persona, pause the worker, then Save new revision to apply. Chat has not changed your saved instructions.",
        );
      };
      bubble.append(use);
    }
    list.append(bubble);
  }
  if (!operatorMessages.length)
    list.textContent = "Start a private conversation with your Coach.";
  list.scrollTop = list.scrollHeight;
  $("operatorPending").hidden = !operatorBusy;
  $("operatorTarget").disabled = operatorBusy || operatorControlPending;
  $("operatorSend").disabled = operatorBusy || operatorControlPending;
  $("operatorCancel").disabled = !operatorBusy || operatorControlPending;
  $("operatorClear").disabled = operatorControlPending;
  operatorSnapshotLabel();
}
async function loadOperator() {
  const epoch = operatorEpoch,
    generation = authGeneration;
  try {
    const data = await api("operator/chat");
    if (epoch !== operatorEpoch || generation !== authGeneration) return;
    operatorMessages = data.messages || [];
    renderOperatorActions(data.actions);
    operatorBusy = data.pending === true;
    renderOperator();
  } catch (error) {
    if (!error.stale && generation === authGeneration)
      $("operatorStatus").textContent =
        "Operator history is unavailable. Try unlocking Studio again.";
  }
}
$("operatorForm").onsubmit = async (event) => {
  event.preventDefault();
  const text = $("operatorText").value.trim();
  if (!key || operatorBusy || operatorControlPending || !text) return;
  clearCommandResult();
  const view = commandViewEpoch;
  const epoch = ++operatorEpoch,
    generation = authGeneration;
  operatorBusy = true;
  operatorDraft = text;
  const previous = operatorMessages.slice();
  operatorMessages.push({ role: "user", text });
  $("operatorText").value = "";
  $("operatorStatus").textContent = "";
  renderOperator();
  try {
    const member_ref = $("operatorTarget").value;
    const data = await api("operator/chat", {
      text,
      ...(member_ref ? { member_ref } : {}),
    });
    if (epoch !== operatorEpoch || generation !== authGeneration) return;
    operatorMessages = data.messages;
    renderOperatorActions(data.actions);
    if (
      data.ephemeral &&
      typeof data.text === "string" &&
      view === commandViewEpoch &&
      !document.hidden &&
      !$("operatorView").hidden
    ) {
      $("operatorCommandResult").hidden = false;
      $("operatorCommandResult").append(
        detailText("h3", "Current command result · not retained in chat"),
        detailText("p", data.text),
      );
    }
    operatorDraft = "";
  } catch (error) {
    if (epoch !== operatorEpoch || generation !== authGeneration) return;
    operatorMessages = previous;
    if (!$("operatorText").value) $("operatorText").value = text;
    $("operatorStatus").textContent =
      "Coach could not complete this response. A member action may already have been delivered; verify its receipt or recipient conversation before sending again.";
  } finally {
    if (epoch === operatorEpoch && generation === authGeneration) {
      operatorBusy = false;
      renderOperator();
    }
  }
};
async function controlOperator(command) {
  if (!key || operatorControlPending) return;
  clearCommandResult();
  operatorControlPending = true;
  renderOperator();
  const generation = authGeneration;
  const epoch = ++operatorEpoch;
  try {
    await api("operator/" + command, {});
    if (generation !== authGeneration || epoch !== operatorEpoch) return;
    if (command === "cancel" && !$("operatorText").value)
      $("operatorText").value = operatorDraft;
    if (command === "clear") $("operatorText").value = "";
    operatorDraft = "";
    operatorBusy = false;
    $("operatorStatus").textContent =
      command === "clear"
        ? "Operator chat cleared. Messages already delivered cannot be recalled."
        : "Response cancelled. Messages already delivered cannot be recalled.";
    if (command === "clear") operatorMessages = [];
    renderOperator();
    await loadOperator();
  } catch (error) {
    if (!error.stale && generation === authGeneration)
      $("operatorStatus").textContent =
        "Could not confirm the chat action. Unlock again to refresh its state.";
  } finally {
    if (generation === authGeneration && epoch === operatorEpoch) {
      operatorControlPending = false;
      renderOperator();
    }
  }
}
$("operatorTarget").onchange = clearCommandResult;
$("operatorReconcile").onclick = async () => {
  if (operatorBusy || operatorControlPending) return;
  $("operatorReconcile").disabled = true;
  try {
    await loadOperator();
  } finally {
    $("operatorReconcile").disabled = false;
  }
};
$("operatorCancel").onclick = () => controlOperator("cancel");
$("operatorClear").onclick = () => controlOperator("clear");

// Member feed data never crosses into operator state or browser storage.
let members = [],
  membersCursor = null,
  membersEpoch = 0;
let selectedMember = null,
  memberItems = [],
  memberCursor = null,
  memberValidationCursor = null,
  memberEpoch = 0,
  memberTimer;
const memberActive = () =>
  key && !document.hidden && !$("coachPanel").hidden && selectedMember;
function resetMembers() {
  ++membersEpoch;
  members = [];
  membersCursor = null;
  selectConversation(null, false);
  renderMembers();
  $("membersStatus").textContent = "";
}
function renderMembers() {
  const target = $("operatorTarget").value;
  $("operatorTarget").replaceChildren(
    new Option("Discussion only · no member tools", ""),
  );
  for (const member of members.filter((m) => m.access === "granted")) {
    $("operatorTarget").append(
      new Option(member.display_name, member.member_ref),
    );
  }
  if (members.some((m) => m.member_ref === target && m.access === "granted"))
    $("operatorTarget").value = target;
  for (const tab of $("conversationTabs").querySelectorAll(".member-tab"))
    tab.remove();
  for (const member of members) {
    const button = document.createElement("button");
    button.className = "member-tab";
    button.classList.toggle(
      "secondary",
      selectedMember?.member_ref !== member.member_ref,
    );
    button.textContent = member.display_name;
    button.setAttribute(
      "aria-pressed",
      String(selectedMember?.member_ref === member.member_ref),
    );
    button.onclick = () => selectConversation(member);
    $("conversationTabs").append(button);
  }
  $("operatorTab").setAttribute("aria-pressed", String(!selectedMember));
  $("operatorTab").classList.toggle("secondary", !!selectedMember);
  $("membersMore").hidden = !membersCursor;
}
async function loadMembers(more = false, routePages = 0) {
  if (!key || document.hidden || $("coachPanel").hidden) return;
  const epoch = ++membersEpoch,
    generation = authGeneration;
  $("membersStatus").textContent = "Loading available conversations…";
  $("membersMore").disabled = true;
  try {
    const data = await api(
      "members?" +
        new URLSearchParams(
          more && membersCursor ? { cursor: membersCursor } : {},
        ),
    );
    if (epoch !== membersEpoch || generation !== authGeneration) return;
    members = [
      ...new Map(
        [...(more ? members : []), ...data.members].map((m) => [
          m.member_ref,
          m,
        ]),
      ).values(),
    ];
    membersCursor = data.has_more ? data.next_cursor : null;
    if (selectedMember) {
      const current = members.find(
        (m) => m.member_ref === selectedMember.member_ref,
      );
      if (!current || current.access !== "granted")
        selectConversation(current || null, false);
    }
    renderMembers();
    const routedMember = studioRoute().member;
    if (routedMember && !$("coachPanel").hidden) restoreStudioRoute();
    $("membersStatus").textContent = members.length
      ? "Member conversations · read-only"
      : "No member conversations available for this credential. Check dojo membership and credential access in Kata.fit, then refresh.";
    if (routedMember && !members.some((m) => m.member_ref === routedMember)) {
      if (membersCursor && routePages < 10)
        void loadMembers(true, routePages + 1);
      else
        $("membersStatus").textContent =
          "Conversation unavailable for this credential. Check member access or refresh the roster.";
    }
  } catch (error) {
    if (epoch !== membersEpoch || generation !== authGeneration) return;
    members = [];
    membersCursor = null;
    selectConversation(null, false);
    renderMembers();
    $("membersStatus").textContent =
      "Member conversations unavailable. Check your connection in Settings and dojo membership, chief authority and credential access in Kata.fit, or update an older backend, then Refresh members.";
  } finally {
    if (epoch === membersEpoch && generation === authGeneration)
      $("membersMore").disabled = false;
  }
}
function selectConversation(member, navigate = true) {
  clearCommandResult();
  clearActivities();
  ++memberEpoch;
  clearTimeout(memberTimer);
  selectedMember = member;
  memberItems = [];
  memberCursor = null;
  memberValidationCursor = null;
  $("memberItems").replaceChildren();
  $("memberMore").hidden = true;
  $("operatorView").hidden = !!member;
  $("memberView").hidden = !member;
  $("memberStatus").textContent = "";
  renderMembers();
  if (navigate && $("settingsPanel").hidden)
    navigateStudio(
      member
        ? "/chat/member/" + encodeURIComponent(member.member_ref)
        : "/chat/operator",
    );
  if (!member) return;
  $("memberTitle").textContent = member.display_name + " · Read-only";
  $("memberRefresh").disabled = member.access !== "granted";
  if (member.access !== "granted")
    $("memberStatus").textContent =
      "Conversation unavailable. Check current dojo membership, chief authority and credential access in Kata.fit, then Refresh members. Category sharing controls activity records, not Coach messages.";
  else void loadMemberFeed();
}
function renderMemberFeed() {
  disposeDetails($("memberItems"));
  $("memberItems").replaceChildren();
  const kinds = {
    message: "Message",
    activity_event: "Activity",
    insight: "Insight",
    proposal_summary: "Proposal summary",
  };
  // The backend pages newest-first; the conversation reads oldest-first.
  // Never turn a standalone insight into a reply to an invented question.
  const ordered = [...memberItems].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
  let previousActivity, thread;
  for (const item of ordered) {
    if (item.activity_ref && item.activity_ref !== previousActivity) {
      thread = document.createElement("section");
      thread.className = "member-thread";
      thread.append(
        detailText("h3", "Activity conversation"),
        activityCard({
          activity_ref: item.activity_ref,
          name: "Expand shared activity",
        }),
      );
      $("memberItems").append(thread);
    } else if (!item.activity_ref) thread = null;
    previousActivity = item.activity_ref;
    const row = document.createElement("article");
    const message = item.type === "message";
    row.className =
      "member-item chat-message" +
      (message && item.role === "user"
        ? " chat-user"
        : message && item.role === "coach"
          ? " chat-assistant"
          : " member-event");
    const label = document.createElement("strong");
    label.textContent =
      (message && item.role === "user"
        ? selectedMember.display_name
        : message && item.role === "coach"
          ? "Coach"
          : kinds[item.type] || "Feed item") +
      (item.status ? " · " + item.status : "");
    const time = document.createElement("small");
    time.textContent = item.created_at;
    const text = document.createElement("p");
    text.textContent =
      item.text ||
      (item.attachments_omitted
        ? "Attachment content omitted."
        : "No text content.");
    row.append(label, time, text);
    if (item.attachments_omitted && item.text) {
      const omitted = document.createElement("p");
      omitted.textContent = "Attachment content omitted.";
      row.append(omitted);
    }
    (thread || $("memberItems")).append(row);
  }
  $("memberMore").hidden = !memberCursor;
}
async function loadMemberFeed(more = false, validate = false) {
  if (!memberActive() || selectedMember.access !== "granted") return;
  clearTimeout(memberTimer);
  const epoch = ++memberEpoch,
    generation = authGeneration,
    ref = selectedMember.member_ref,
    validationCursor = validate ? memberValidationCursor : null,
    requestedCursor = validationCursor || (more ? memberCursor : null);
  $("memberStatus").textContent =
    validate && memberItems.length
      ? "Checking sharing and history…"
      : "Loading read-only feed…";
  $("memberMore").disabled = true;
  try {
    const params = new URLSearchParams({ member_ref: ref });
    if (requestedCursor) params.set("cursor", requestedCursor);
    const data = await api("members/feed?" + params);
    if (
      epoch !== memberEpoch ||
      generation !== authGeneration ||
      !memberActive()
    )
      return;
    if (data.member_ref !== ref) throw new Error("Mismatched member");
    // Conversation membership survives raw-category revocation. Rechecking a
    // feed must not leave previously expanded raw data independently retained.
    clearActivities();
    if (validationCursor) {
      // A cursor is bound to the complete backend snapshot and live authority.
      // Successful revalidation preserves already loaded pages and scroll.
      $("memberStatus").textContent =
        "Read-only · sharing and history rechecked";
      return;
    }
    const unchanged =
      validate &&
      !more &&
      !requestedCursor &&
      JSON.stringify(memberItems) === JSON.stringify(data.items);
    memberValidationCursor = more ? requestedCursor : null;
    memberCursor = data.has_more ? data.next_cursor : null;
    if (unchanged) {
      // Revoked raw details were cleared above; stable chat rows need no DOM work.
      $("memberMore").hidden = !memberCursor;
      $("memberStatus").textContent =
        "Read-only · sharing and history rechecked";
      return;
    }
    memberItems = [
      ...new Map(
        [...(more ? memberItems : []), ...data.items].map((item) => [
          item.id,
          item,
        ]),
      ).values(),
    ];
    renderMemberFeed();
    $("memberStatus").textContent = memberItems.length
      ? "Read-only · refreshed from Kata.fit"
      : "No retained Coach feed items are available. Conversation access follows dojo membership; activity records follow category sharing.";
  } catch (error) {
    if (epoch !== memberEpoch || generation !== authGeneration) return;
    clearActivities();
    memberItems = [];
    memberCursor = null;
    memberValidationCursor = null;
    renderMemberFeed();
    $("memberStatus").textContent = error.message?.includes(
      "UPDATE_IN_PROGRESS",
    )
      ? "Studio is updating. Member feeds are temporarily unavailable; retry shortly."
      : error.message?.includes("BACKEND_TIMEOUT")
        ? "Kata.fit feed timed out. Retry shortly; this does not mean sharing changed."
        : error.message?.includes("MCP_TOOL_FAILED")
          ? "Kata.fit could not build this feed. Retry or check the connection; this does not prove sharing changed."
          : "Feed unavailable. Retry or refresh members; if access changed, check sharing in Kata.fit.";
  } finally {
    if (epoch === memberEpoch && generation === authGeneration) {
      $("memberMore").disabled = false;
      if (memberActive())
        memberTimer = setTimeout(() => loadMemberFeed(false, true), 15000);
    }
  }
}
// Every expansion owns its requests and URLs; no raw source IDs become URLs.
const detailResources = new Set();
function disposeDetails(root) {
  for (const resource of [...detailResources]) {
    if (!root || root === resource.node || root.contains(resource.node)) {
      resource.controller.abort();
      for (const url of resource.urls) URL.revokeObjectURL(url);
      detailResources.delete(resource);
    }
  }
}
function clearActivities() {
  disposeDetails();
  // Inline thread expansions are outside the separate activity inventory.
  // Closing alone fires toggle asynchronously; clear their raw DOM immediately.
  for (const node of $("memberItems").querySelectorAll(
    "details.activity-card",
  )) {
    node.open = false;
    node.querySelector(":scope > div")?.replaceChildren();
  }
  $("memberActivities").open = false;
  $("activityItems").replaceChildren();
}
function detailScope(node) {
  const controller = new AbortController();
  const generation = authGeneration,
    ref = selectedMember?.member_ref;
  const resource = { node, controller, urls: [] };
  detailResources.add(resource);
  resource.current = () =>
    !controller.signal.aborted &&
    generation === authGeneration &&
    memberActive() &&
    selectedMember?.member_ref === ref &&
    node.isConnected;
  resource.ref = ref;
  resource.signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(20000),
  ]);
  return resource;
}
function detailText(tag, text) {
  const node = document.createElement(tag);
  node.textContent = String(text);
  return node;
}
function lazyDetails(label, load) {
  const node = document.createElement("details");
  node.className = "activity-card";
  node.append(detailText("summary", label));
  const body = document.createElement("div");
  node.append(body);
  node.addEventListener("toggle", () => {
    disposeDetails(node);
    body.replaceChildren();
    if (node.open) void load(body);
  });
  return node;
}
function detailError(body, retry) {
  body.replaceChildren(
    detailText(
      "p",
      "Details unavailable. Sharing may have changed, or this backend may not support this view. Refresh or retry.",
    ),
  );
  const button = detailText("button", "Retry");
  button.type = "button";
  button.onclick = () => {
    button.disabled = true;
    void retry();
  };
  body.append(button);
}
function renderDetailFields(body, row, fields) {
  const list = document.createElement("dl");
  for (const [key, label] of fields) {
    const value = row[key];
    if (!["string", "number", "boolean"].includes(typeof value)) continue;
    list.append(detailText("dt", label), detailText("dd", value));
  }
  body.append(list);
}
async function loadDetailPage(body, activity, section, exercise, cursor) {
  if (!cursor) {
    disposeDetails(body);
    body.replaceChildren();
  }
  const scope = detailScope(body);
  const loading = detailText("p", "Loading details…");
  loading.setAttribute("role", "status");
  body.append(loading);
  try {
    const params = new URLSearchParams({
      member_ref: scope.ref,
      activity_ref: activity.activity_ref,
      section,
    });
    if (exercise) params.set("exercise_instance_id", exercise);
    if (cursor) params.set("cursor", cursor);
    const data = await api(
      "members/activity?" + params,
      undefined,
      scope.signal,
    );
    if (!scope.current()) return;
    if (
      data.member_ref !== scope.ref ||
      data.activity?.activity_ref !== activity.activity_ref ||
      data.section !== section ||
      !Array.isArray(data.items) ||
      data.items.length > 100
    )
      throw new Error("Invalid detail response");
    loading.remove();
    if (section === "overview") {
      const next = {
        workout: "workout_exercises",
        meal: "meal_foods",
        metric: "measurements",
        survey: "survey_questions",
        status_change: "status",
        media: "media_files",
      }[data.activity.type];
      if (next) return await loadDetailPage(body, data.activity, next);
    }
    if (!data.items.length)
      body.append(detailText("p", "No recorded details in this section."));
    for (const row of data.items) {
      if (section === "workout_exercises") {
        body.append(
          lazyDetails(row.name || "Exercise", (child) =>
            loadDetailPage(child, activity, "workout_sets", row._id),
          ),
        );
      } else if (section === "media_files") {
        if (typeof row.media_ref === "string")
          await loadMemberImage(body, row.media_ref, scope);
        else
          body.append(
            detailText(
              "p",
              "Photo unavailable under current sharing or credential access.",
            ),
          );
      } else {
        const card = document.createElement("article");
        if (section === "workout_sets") {
          card.append(
            detailText(
              "strong",
              `${row.reps ?? row.repetitions ?? "—"} reps · ${row.weight ?? "—"} ${row.weight_unit || "(unit not recorded)"}`,
            ),
          );
          renderDetailFields(card, row, [
            ["complete", "Completed"],
            ["distance", "Distance"],
            ["distance_unit", "Distance unit"],
            ["duration", "Duration"],
            ["duration_unit", "Duration unit"],
            ["calories", "Calories"],
          ]);
        } else if (section === "meal_foods") {
          card.append(
            detailText(
              "strong",
              `${row.name || "Food / ingredient"} · ${row.quantity ?? "—"} ${row.unit || "(unit not recorded)"}`,
            ),
          );
          renderDetailFields(card, row, [
            ["serving_size", "Serving size"],
            ["calories", "Calories (stored)"],
            ["protein", "Protein (stored)"],
            ["carbs", "Carbohydrates (stored)"],
            ["fat", "Fat (stored)"],
            ["water_ml", "Water (ml)"],
            ["nutrition_source", "Nutrition source"],
          ]);
          if (row.snapshot) {
            card.append(
              detailText(
                "p",
                "Logged nutrition snapshot (not recalculated totals)",
              ),
            );
            renderDetailFields(card, row.snapshot, [
              ["calories", "Calories"],
              ["protein", "Protein"],
              ["carbs", "Carbohydrates"],
              ["fat", "Fat"],
              ["fiber", "Fiber"],
              ["sodium", "Sodium"],
              ["serving_size", "Serving size"],
              ["serving_unit", "Serving unit"],
            ]);
          }
        } else {
          renderDetailFields(card, row, [
            ["name", "Name"],
            ["type", "Type"],
            ["status", "Status"],
            ["type_id", "Measurement"],
            ["value", "Value"],
            ["unit", "Unit"],
            ["text", "Question"],
            ["answer", "Answer"],
            ["reason", "Reason"],
            ["effective_at", "Effective at"],
            ["start_date", "Starts"],
            ["end_date", "Ends"],
            ["created_at", "Created"],
            ["completed_at", "Completed"],
            ["due_at", "Due"],
            ["measured_at", "Measured"],
          ]);
        }
        body.append(card);
      }
    }
    if (data.has_more && data.next_cursor) {
      const more = detailText("button", "Load more details");
      more.type = "button";
      more.onclick = () => {
        more.remove();
        void loadDetailPage(
          body,
          activity,
          section,
          exercise,
          data.next_cursor,
        );
      };
      body.append(more);
    }
  } catch {
    if (scope.current()) {
      disposeDetails(body);
      detailError(body, () =>
        loadDetailPage(body, activity, section, exercise),
      );
    }
  }
}
async function loadMemberImage(body, media_ref, scope) {
  const generation = authGeneration,
    requestKey = key;
  const response = await fetch(
    "/api/members/media?" +
      new URLSearchParams({ member_ref: scope.ref, media_ref }),
    {
      headers: { Authorization: "Bearer " + requestKey },
      signal: scope.signal,
      redirect: "error",
      cache: "no-store",
    },
  );
  if (!scope.current()) {
    await response.body?.cancel();
    return;
  }
  if (
    response.status === 401 &&
    generation === authGeneration &&
    requestKey === key
  ) {
    lockSession(
      "Studio authorization expired. Unlock again with the current admin key.",
    );
    return;
  }
  const type = response.headers.get("content-type")?.split(";")[0];
  if (
    !response.ok ||
    !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)
  ) {
    await response.body?.cancel();
    throw new Error("Image unavailable");
  }
  const reader = response.body.getReader(),
    chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Image too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!scope.current()) return;
  const url = URL.createObjectURL(new Blob(chunks, { type }));
  scope.urls.push(url);
  const image = document.createElement("img");
  image.alt = "Shared activity photo";
  image.src = url;
  image.onerror = () => {
    if (scope.current()) {
      image.replaceWith(
        detailText(
          "p",
          "Photo could not be decoded. Collapse and reopen to retry.",
        ),
      );
      URL.revokeObjectURL(url);
    }
  };
  body.append(image);
}
function activityCard(activity) {
  const sections = {
    workout: "workout_exercises",
    meal: "meal_foods",
    metric: "measurements",
    survey: "survey_questions",
    status_change: "status",
    media: "media_files",
  };
  return lazyDetails(
    activity.name || `${activity.type || "Shared"} activity details`,
    (body) =>
      loadDetailPage(body, activity, sections[activity.type] || "overview"),
  );
}
async function loadActivityInventory(cursor) {
  const body = $("activityItems");
  if (!cursor) {
    disposeDetails(body);
    body.replaceChildren();
  }
  const scope = detailScope(body);
  const loading = detailText("p", "Loading shared activities…");
  body.append(loading);
  try {
    const params = new URLSearchParams({ member_ref: scope.ref });
    if (cursor) params.set("cursor", cursor);
    const data = await api(
      "members/activities?" + params,
      undefined,
      scope.signal,
    );
    if (!scope.current()) return;
    if (
      data.member_ref !== scope.ref ||
      !Array.isArray(data.items) ||
      data.items.length > 100
    )
      throw new Error("Invalid activities");
    loading.remove();
    for (const activity of data.items) body.append(activityCard(activity));
    if (!data.items.length)
      body.append(detailText("p", "No shared activities available."));
    if (data.has_more && data.next_cursor) {
      const more = detailText("button", "More activities");
      more.type = "button";
      more.onclick = () => {
        more.remove();
        void loadActivityInventory(data.next_cursor);
      };
      body.append(more);
    }
  } catch {
    if (scope.current()) {
      disposeDetails(body);
      detailError(body, () => loadActivityInventory());
    }
  }
}
$("memberActivities").addEventListener("toggle", () => {
  disposeDetails($("memberActivities"));
  $("activityItems").replaceChildren();
  if ($("memberActivities").open && memberActive())
    void loadActivityInventory();
});
function memberVisibility() {
  clearCommandResult();
  clearActivities();
  ++memberEpoch;
  clearTimeout(memberTimer);
  // Erase hidden customer content; never retain a stale authority snapshot.
  memberItems = [];
  memberCursor = null;
  memberValidationCursor = null;
  $("memberItems").replaceChildren();
  $("memberMore").hidden = true;
  if (memberActive()) void loadMemberFeed();
}
$("operatorTab").onclick = () => selectConversation(null);
$("membersRefresh").onclick = () => loadMembers();
$("membersMore").onclick = () => loadMembers(true);
$("memberRefresh").onclick = () => loadMemberFeed();
$("memberMore").onclick = () => loadMemberFeed(true);
document.addEventListener("visibilitychange", memberVisibility);
window.addEventListener("pagehide", () => {
  clearActivities();
  ++memberEpoch;
  clearTimeout(memberTimer);
});

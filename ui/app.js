let key = "",
  config,
  authGeneration = 0;
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
  selectStudioTab("coach");
  void loadOperator();
  void loadMembers();
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
action("previewButton", async () => {
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
  const r = await api("preview", { text: $("question").value });
  $("answer").textContent = r.text;
  $("prompt").textContent = r.prompt;
  notice(
    "Preview complete · revision " +
      r.revision +
      " · saved configuration + fetched backend instructions (snapshot) · no claimed-request data authority or read tools · nothing written to Kata.fit",
  );
});
action("cancel", async () => {
  await api("cancel", {});
  notice("Cancellation requested.");
});
for (const cmd of ["run", "stop"])
  action(cmd, async () => {
    const generation = authGeneration;
    await api(cmd, {});
    await status();
    if (generation !== authGeneration) return;
    notice(
      cmd === "run"
        ? "Worker started. Wait for persisted-reply status to confirm delivery."
        : "Worker stopped.",
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
    $("state").textContent = s.state.toUpperCase();
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
if (/^[a-f0-9]{64}$/i.test(location.hash.slice(1))) {
  $("adminKey").value = location.hash.slice(1);
  history.replaceState(null, "", "/");
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
function selectStudioTab(tab) {
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
    if (e.hint) {
      const hint = document.createElement("p");
      hint.textContent = e.hint;
      row.append(hint);
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
  notice("Sanitized diagnostic JSON copied.");
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
function renderUpdate() {
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
  $("updateStatus").textContent = updateError || data.guidance;
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
  updateData = undefined;
  updateTarget = undefined;
  $("updateConfirm").hidden = true;
  clearTimeout(logTimer);
  logController?.abort();
  $("studio").hidden = true;
  $("login").hidden = false;
  $("lockStudio").hidden = true;
  $("state").textContent = "LOCKED";
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
    label.textContent = message.role === "user" ? "You · Operator" : "Coach";
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
    const data = await api("operator/chat", { text });
    if (epoch !== operatorEpoch || generation !== authGeneration) return;
    operatorMessages = data.messages;
    operatorDraft = "";
  } catch (error) {
    if (epoch !== operatorEpoch || generation !== authGeneration) return;
    operatorMessages = previous;
    if (!$("operatorText").value) $("operatorText").value = text;
    $("operatorStatus").textContent =
      "Coach could not complete this response. Check saved provider settings or try again.";
  } finally {
    if (epoch === operatorEpoch && generation === authGeneration) {
      operatorBusy = false;
      renderOperator();
    }
  }
};
async function controlOperator(command) {
  if (!key || operatorControlPending) return;
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
      command === "clear" ? "Operator chat cleared." : "Response cancelled.";
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
  selectConversation(null);
  renderMembers();
  $("membersStatus").textContent = "";
}
function renderMembers() {
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
async function loadMembers(more = false) {
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
        selectConversation(current || null);
    }
    renderMembers();
    $("membersStatus").textContent = members.length
      ? "Member conversations · read-only"
      : "No member conversations available for this credential. Check sharing in Kata.fit, then refresh.";
  } catch (error) {
    if (epoch !== membersEpoch || generation !== authGeneration) return;
    members = [];
    membersCursor = null;
    selectConversation(null);
    renderMembers();
    $("membersStatus").textContent =
      "Member conversations unavailable. Check your connection and sharing permissions in Settings / Kata.fit, or update an older backend, then Refresh members.";
  } finally {
    if (epoch === membersEpoch && generation === authGeneration)
      $("membersMore").disabled = false;
  }
}
function selectConversation(member) {
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
  if (!member) return;
  $("memberTitle").textContent = member.display_name + " · Read-only";
  $("memberRefresh").disabled = member.access !== "granted";
  if (member.access !== "granted")
    $("memberStatus").textContent =
      "No shared conversation available. For a dojo Coach, access follows this member’s Dojo Chief sharing settings in Kata.fit; no separate agent permission is needed. Refresh members after sharing changes.";
  else void loadMemberFeed();
}
function renderMemberFeed() {
  $("memberItems").replaceChildren();
  const kinds = {
    message: "Message",
    activity_event: "Activity",
    insight: "Insight",
    proposal_summary: "Proposal summary",
  };
  for (const item of memberItems) {
    const row = document.createElement("article");
    row.className = "member-item chat-message";
    const label = document.createElement("strong");
    label.textContent =
      (kinds[item.type] || "Feed item") +
      (item.role ? " · " + item.role : "") +
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
    $("memberItems").append(row);
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
  $("memberStatus").textContent = "Loading read-only feed…";
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
    if (validationCursor) {
      // A cursor is bound to the complete backend snapshot and live authority.
      // Successful revalidation preserves already loaded pages and scroll.
      $("memberStatus").textContent =
        "Read-only · sharing and history rechecked";
      return;
    }
    memberValidationCursor = more ? requestedCursor : null;
    memberItems = [
      ...new Map(
        [...(more ? memberItems : []), ...data.items].map((item) => [
          item.id,
          item,
        ]),
      ).values(),
    ];
    memberCursor = data.has_more ? data.next_cursor : null;
    renderMemberFeed();
    $("memberStatus").textContent = memberItems.length
      ? "Read-only · refreshed from Kata.fit"
      : "No retained Coach feed items are visible under current sharing settings. Mixed chat history may be omitted when a category is private.";
  } catch (error) {
    if (epoch !== memberEpoch || generation !== authGeneration) return;
    memberItems = [];
    memberCursor = null;
    memberValidationCursor = null;
    renderMemberFeed();
    $("memberStatus").textContent =
      "Feed unavailable. Sharing may have changed. Refresh members and check the connection in Settings before trying again.";
  } finally {
    if (epoch === memberEpoch && generation === authGeneration) {
      $("memberMore").disabled = false;
      if (memberActive())
        memberTimer = setTimeout(() => loadMemberFeed(false, true), 15000);
    }
  }
}
function memberVisibility() {
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
  ++memberEpoch;
  clearTimeout(memberTimer);
});

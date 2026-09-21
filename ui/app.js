let key = "",
  config;
const $ = (id) => document.getElementById(id);
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
async function api(path, body) {
  const r = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error + (data.hint ? " — " + data.hint : ""));
  return data;
}
async function load() {
  config = await api("config");
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
      notice(e.message);
    }
  };
}
action("unlock", async () => {
  key = $("adminKey").value;
  $("adminKey").value = "";
  await load();
  $("login").hidden = true;
  $("studio").hidden = false;
  await status();
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
    await api(cmd, {});
    await status();
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
  try {
    const s = await api("status");
    $("state").textContent = s.state.toUpperCase();
  } catch {}
}
if (location.hash) {
  $("adminKey").value = location.hash.slice(1);
  history.replaceState(null, "", "/");
  $("unlock").click();
}
setInterval(status, 4000);

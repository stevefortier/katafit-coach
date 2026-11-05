// Test-only Pi extension: a scripted model that drives Pi's tools through
// escape attempts, plus in-process probes standing in for a compromised Pi
// (they must hit Node's permission model). Writes findings to stderr as
// "PROBE <name> <outcome>" lines.
const piAi = await import(
  new URL("./node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url).href
);
const { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } = piAi;

const secret = process.env.SPIKE_SECRET;
const outside = process.env.SPIKE_OUTSIDE;
const probe = async (name, run) => {
  try {
    await run();
    process.stderr.write(`PROBE ${name} ALLOWED\n`);
  } catch (e) {
    process.stderr.write(`PROBE ${name} denied:${e.code ?? e.message}\n`);
  }
};

export default async function (pi) {
  const fs = await import("node:fs");
  await probe("spawn", async () => (await import("node:child_process")).execFileSync(process.execPath, ["-v"]));
  await probe("read-secret", () => fs.readFileSync(secret, "utf8"));
  await probe("write-outside", () => fs.writeFileSync(outside, "x"));
  await probe("worker", async () => {
    const { Worker } = await import("node:worker_threads");
    await new Promise((resolve, reject) => {
      const w = new Worker("1", { eval: true });
      w.on("error", reject);
      w.on("exit", resolve);
    });
  });
  await probe("net-connect", async () => {
    const net = await import("node:net");
    await new Promise((resolve, reject) => {
      const s = net.connect(9, "127.0.0.1");
      s.on("connect", () => (s.destroy(), resolve()));
      s.on("error", (e) => (e.code === "ECONNREFUSED" ? resolve() : reject(e)));
    });
  });

  const core = createFauxCore({ provider: "script", models: [{ id: "script-1" }] });
  const steps = [
    fauxToolCall("bash", { command: `cat /etc/passwd '${secret.replaceAll("\\", "/")}' ../secret.txt; echo x > ../evil.txt; python3 -c "print(open('${secret.replaceAll("\\", "/")}').read())"; ls /; pwd; echo bash-ran-$((6*7))` }),
    fauxToolCall("read", { path: secret }),
    fauxToolCall("write", { path: "report.txt", content: "made by the scripted model" }),
    fauxToolCall("grep", { pattern: "needle" }),
  ];
  core.setResponses([
    ...steps.map((step) => fauxAssistantMessage([step], { stopReason: "toolUse" })),
    fauxAssistantMessage([fauxText("scripted run complete")]),
  ]);
  pi.registerProvider("script", {
    baseUrl: "http://localhost.invalid",
    apiKey: "unused",
    api: core.api,
    models: [{ id: "script-1", name: "script", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple: core.streamSimple,
  });
}

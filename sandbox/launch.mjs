import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = ["--no-session", "--offline"];
const temporary = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
if (process.env.NATIVE_GATEWAY === "1") {
  const deadline = Date.now() + 15000;
  while (!existsSync(temporary + "/native-config.json")) {
    if (Date.now() > deadline) process.exit(1);
    await new Promise((r) => setTimeout(r, 50));
  }
  const config = JSON.parse(
    readFileSync(temporary + "/native-config.json", "utf8"),
  );
  args.push(
    "--provider",
    "katafit",
    "--model",
    config.model,
    "-e",
    "/opt/coach/sandbox/katafit.mjs",
    // Coach is the primary identity. Appending leaves Pi's coding-assistant
    // preamble in authority alongside the saved persona.
    "--system-prompt",
    config.prompt,
  );
}
const child = spawn("/opt/coach/node_modules/.bin/pi", args, {
  stdio: "inherit",
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));

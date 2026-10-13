// Real bounded writer; no Docker/gh/API behavior is simulated here.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { watch, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const [state, mode] = process.argv.slice(2);
process.on("SIGTERM", () => {});
async function overflow() {
  const chunk = Buffer.alloc(32768, 120);
  let bytes = 0;
  for (let i = 0; i < 512; i++) {
    const stream = i % 2 ? process.stderr : process.stdout;
    if (!stream.write(chunk)) await once(stream, "drain");
    bytes += chunk.length;
  }
  await Promise.all([
    new Promise((r) => process.stdout.write("", r)),
    new Promise((r) => process.stderr.write("", r)),
  ]);
  writeFileSync(join(state, "overflow-produced"), JSON.stringify({ bytes }));
}
if (mode === "descendant-writer") {
  const watcher = watch(state, (_type, name) => {
    if (name === "release-descendant") watcher.close();
  });
  process.once("exit", () =>
    writeFileSync(join(state, "descendant-exited"), "exit"),
  );
  await overflow();
  process.stdout.end();
  process.stderr.end();
  writeFileSync(join(state, "descendant-ready"), "ready");
  if (existsSync(join(state, "release-descendant"))) watcher.close();
} else {
  const child = spawn(
    process.execPath,
    mode === "direct"
      ? [
          new URL("./native-descendant-cli.mjs", import.meta.url).pathname,
          state,
          "descendant",
        ]
      : [new URL(import.meta.url).pathname, state, "descendant-writer"],
    {
      detached: true,
      stdio: mode === "direct" ? "ignore" : ["ignore", "inherit", "inherit"],
    },
  );
  child.unref();
  process.once("exit", () =>
    writeFileSync(join(state, "direct-exited"), "exit"),
  );
  if (mode === "direct") await overflow();
}

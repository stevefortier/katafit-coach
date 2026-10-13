// Mock Docker response controls. A real process reads the production --input
// pathname. Trusted launchers hold the flock; this client inherits no authority.
// No Docker is invoked.
import fs from "node:fs/promises";
import { watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
const r = JSON.parse(process.argv[2]),
  args = process.argv.slice(3);
const records = join(r.state, "calls.jsonl");
if (args[2] === "load") {
  const path = args[args.indexOf("--input") + 1];
  const bytes = await fs.readFile(path); // tiny unit fixture, not production copying
  const hash = createHash("sha256").update(bytes).digest("hex");
  const mode = (await fs.stat(path)).mode & 0o777;
  const parentMode = (await fs.stat(join(path, ".."))).mode & 0o777;
  await fs.appendFile(
    records,
    JSON.stringify({
      op: "load",
      path,
      hash,
      mode,
      parentMode,
      pid: process.pid,
    }) + "\n",
  );
  if (r.hold === "child") {
    process.once("exit", () =>
      writeFileSync(join(r.state, "cli-exited"), "exit"),
    );
    process.on("SIGTERM", () => {}); // explicit uncooperative child control
    const released = Promise.withResolvers();
    const watcher = watch(r.state, (_type, file) => {
      if (file === "release-child") released.resolve();
    });
    await fs.writeFile(
      join(r.state, "event-child"),
      JSON.stringify({ pid: process.pid }),
    );
    await released.promise;
    watcher.close();
  }
  await fs.writeFile(
    join(r.state, "loaded"),
    "approved fixture loaded by mock",
  );
  if (r.lostReply) {
    process.stderr.write("MOCK_LOST_LOAD_REPLY\n");
    process.exitCode = 1;
  }
} else {
  const target = args.at(-1);
  await fs.appendFile(
    records,
    JSON.stringify({ op: "inspect", target }) + "\n",
  );
  let loaded = false;
  try {
    await fs.stat(join(r.state, "loaded"));
    loaded = true;
  } catch {}
  if (loaded && target !== r.published)
    process.stdout.write(JSON.stringify([r.inspection]));
  else {
    process.stdout.write("[]\n");
    process.stderr.write(
      `Error response from daemon: No such image: ${target}\n`,
    );
    process.exitCode = 1;
  }
}

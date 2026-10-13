import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const r = JSON.parse(process.argv[2]),
  args = process.argv.slice(3);
if (args[1] === "version" && !["version", "cleanup"].includes(r.phase))
  process.stdout.write("1.52\n");
else if (args[1] === "create") process.stdout.write("1".repeat(64) + "\n");
else if (args[1] === "inspect")
  process.stdout.write(
    JSON.stringify([
      {
        Image: "sha256:" + "c".repeat(64),
        HostConfig: { NetworkMode: "none", ReadonlyRootfs: true },
        Config: { User: "1000:1000" },
        Mounts: [],
      },
    ]),
  );
else {
  if (args[1] === "exec")
    process.stdout.write(
      JSON.stringify({ id: 1, request: { kind: "catalog" } }) + "\n",
    );
  const child = spawn(
    process.execPath,
    [
      new URL("./native-descendant-cli.mjs", import.meta.url).pathname,
      r.state,
      "descendant",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  process.once("exit", () =>
    writeFileSync(join(r.state, "direct-exited"), "exit"),
  );
  if (args[1] === "version") process.stdout.write("1.52\n");
  // Relay exits with closed pipes; its adopted child remains. This also exercises
  // the lock scope drain when runtime.stop itself has already returned.
}

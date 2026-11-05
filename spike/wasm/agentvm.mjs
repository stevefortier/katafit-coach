// Phase 0 spike: the same workloads through AgentVM (node:wasi, its own
// bundled Alpine image with Pi), for comparison with wasmtime.
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const { AgentVM } = createRequire(import.meta.url)("deepclause-agentvm");
const work = process.argv[2];
mkdirSync(work, { recursive: true });
writeFileSync(`${work}/notes.txt`, "alpha\nbeta needle\ngamma\n");
const summary = process.env.GITHUB_STEP_SUMMARY;
const row = (line) =>
  summary ? appendFileSync(summary, line + "\n") : console.log(line);
row(
  `### AgentVM ${process.platform}\n| Step | Seconds | Result |\n|---|---|---|`,
);
const timed = async (name, work) => {
  const start = performance.now();
  try {
    const result = await work();
    row(
      `| ${name} | ${((performance.now() - start) / 1000).toFixed(1)} | ok: ${String(result).trim().split("\n").at(-1).slice(0, 60)} |`,
    );
  } catch (error) {
    row(
      `| ${name} | ${((performance.now() - start) / 1000).toFixed(1)} | FAILED: ${String(error?.message ?? error).slice(0, 60)} |`,
    );
  }
};
const vm = new AgentVM({ mounts: { "/mnt/work": work }, network: false });
await timed("boot", () => vm.start().then(() => "started"));
const exec = (command) =>
  vm
    .exec(command)
    .then((r) =>
      r.exitCode === 0
        ? r.stdout
        : Promise.reject(new Error(r.stderr || `exit ${r.exitCode}`)),
    );
await timed("node -v", () => exec("node -v"));
await timed("node script", () =>
  exec(`node -e 'console.log([1,2,3].map(x=>x*2).join(","))'`),
);
await timed("pi --version", () => exec("pi --version"));
await timed("grep in workspace", () => exec("grep -rn needle /mnt/work"));
await timed("10 shell commands", () =>
  exec(
    "for i in 1 2 3 4 5 6 7 8 9 10; do ls /mnt/work >/dev/null; done; echo done",
  ),
);
await timed("stop", () => vm.stop().then(() => "stopped"));

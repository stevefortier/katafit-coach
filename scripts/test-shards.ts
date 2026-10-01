import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export async function discoverTests(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".test.ts"))
        files.push(relative(root, path).split("\\").join("/"));
    }
  }
  await visit(join(root, "tests"));
  return files.sort();
}

export function validateInventory(files: string[], shards: string[][]) {
  if (!files.length) throw new Error("EMPTY_INVENTORY");
  if (new Set(files).size !== files.length)
    throw new Error("DUPLICATE_INVENTORY");
  const assigned = shards.flat();
  if (new Set(assigned).size !== assigned.length)
    throw new Error("DUPLICATE_ASSIGNMENT");
  if (files.some((file) => !assigned.includes(file)))
    throw new Error("MISSING_TEST");
  if (assigned.some((file) => !files.includes(file)))
    throw new Error("EXTRA_TEST");
  if (shards.length !== 4 || shards.some((shard) => !shard.length))
    throw new Error("EMPTY_SHARD: expected four nonempty shards");
}

export function planShards(files: string[]) {
  const shards: string[][] = [[], [], [], []];
  [...files]
    .sort()
    .forEach((file, index) => shards[index % shards.length].push(file));
  validateInventory(files, shards);
  return { total: files.length, shards };
}

const main = process.argv[1] === fileURLToPath(import.meta.url);
if (main) {
  const [command = "inventory", argument] = process.argv.slice(2);
  const root = command === "inventory" && argument ? argument : process.cwd();
  const files = await discoverTests(root);
  const plan = planShards(files);
  if (command === "inventory") console.log(JSON.stringify(plan));
  else if (command === "run" || command === "all") {
    const selected =
      command === "all" ? files : plan.shards[Number(argument) - 1];
    if (!selected) throw new Error("INVALID_SHARD: expected 1..4");
    console.log(`Running ${selected.length}/${plan.total} test files serially`);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=1",
        "--test-force-exit",
        ...selected,
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } else throw new Error("INVALID_COMMAND: expected inventory, run or all");
}

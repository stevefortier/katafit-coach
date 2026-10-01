import { readdir, open } from "node:fs/promises";
import { constants } from "node:fs";
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
  if (shards.length !== 8 || shards.some((shard) => !shard.length))
    throw new Error("EMPTY_SHARD: expected eight nonempty shards");
}

const MAX_METADATA_BYTES = 1048576;
function validateDurations(
  value: unknown,
): asserts value is Record<string, number> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 10000
  )
    throw new Error("INVALID_DURATION_METADATA");
  for (const [file, ms] of Object.entries(value)) {
    if (
      !/^tests\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.test\.ts$/.test(file) ||
      file.split("/").some((part) => part === "." || part === "..") ||
      !Number.isSafeInteger(ms) ||
      ms < 1 ||
      ms > 3600000
    )
      throw new Error("INVALID_DURATION_METADATA");
  }
}

export async function loadDurations(
  root: string,
): Promise<Record<string, number>> {
  let handle;
  try {
    handle = await open(
      join(root, "scripts/test-durations.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("INVALID_DURATION_METADATA", { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES)
      throw new Error("INVALID_DURATION_METADATA");
    const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_METADATA_BYTES)
      throw new Error("INVALID_DURATION_METADATA");
    const data = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(",") !== "durationsMs,source,version" ||
      data.version !== 1 ||
      typeof data.source !== "string" ||
      !data.source.trim() ||
      data.source.length > 1024
    )
      throw new Error("INVALID_DURATION_METADATA");
    validateDurations(data.durationsMs);
    return data.durationsMs;
  } catch (error) {
    throw new Error("INVALID_DURATION_METADATA", { cause: error });
  } finally {
    await handle.close();
  }
}

export function planShards(
  files: string[],
  durations: Record<string, number> = {},
) {
  validateDurations(durations);
  const shards: string[][] = Array.from({ length: 8 }, () => []);
  const estimatedMs = Array<number>(8).fill(0);
  const weight = (file: string) => durations[file] ?? 5000;
  for (const file of [...files].sort(
    (a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0),
  )) {
    const index = estimatedMs.indexOf(Math.min(...estimatedMs));
    shards[index].push(file);
    estimatedMs[index] += weight(file);
  }
  validateInventory(files, shards);
  return { total: files.length, shards, estimatedMs };
}

const main = process.argv[1] === fileURLToPath(import.meta.url);
if (main) {
  const [command = "inventory", argument] = process.argv.slice(2);
  const root = command === "inventory" && argument ? argument : process.cwd();
  const files = await discoverTests(root);
  const plan = planShards(files, await loadDurations(root));
  if (command === "inventory") console.log(JSON.stringify(plan));
  else if (command === "run" || command === "all") {
    if (command === "run" && !/^[1-8]$/.test(argument ?? ""))
      throw new Error("INVALID_SHARD: expected 1..8");
    const selected =
      command === "all" ? files : plan.shards[Number(argument) - 1];
    if (!selected) throw new Error("INVALID_SHARD: expected 1..8");
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

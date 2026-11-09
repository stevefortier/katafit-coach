import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";

// Retired persona history is never written any more, but an existing archive
// is still read, validated and screened for credentials on every load.
const persona = {
  name: "Archived Coach",
  voice: "Warm",
  principles: "",
  examples: "",
  boundaries: "",
  initiative: "",
  verbosity: "Concise",
  markdown: "",
};
const admin = "synthetic-retired-admin-secret";

async function snapshot(dir: string, record: unknown) {
  const bytes = JSON.stringify(record, null, 2);
  const name =
    "persona-" + createHash("sha256").update(bytes).digest("hex") + ".json";
  await writeFile(dir + "/persona-history/" + name, bytes, { mode: 0o600 });
  return name;
}
async function archive() {
  const dir = await mkdtemp(tmpdir() + "/persona-retired-");
  await mkdir(dir + "/persona-history", { mode: 0o700 });
  const first = await snapshot(dir, {
    version: 1,
    revision: 1,
    savedAt: null,
    persona: { ...persona, name: "Coach" },
    previous: null,
  });
  const valid = {
    version: 1,
    revision: 2,
    savedAt: "2025-01-01T00:00:00.000Z",
    persona,
    previous: first,
  };
  const head = await snapshot(dir, valid);
  const config = {
    current: {
      revision: 2,
      origin: "https://kata.fit",
      provider: {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
        vision: false,
      },
      persona,
    },
    history: { version: 1, head },
  };
  await writeFile(dir + "/config.json", JSON.stringify(config));
  await writeFile(
    dir + "/secrets.json",
    JSON.stringify({ token: "", apiKey: "", admin }),
  );
  return { dir, config, valid, head, path: dir + "/persona-history/" + head };
}

test("a valid retired archive loads read-only and is never rewritten", async () => {
  const { dir } = await archive();
  try {
    const before = await readdir(dir + "/persona-history");
    const s = new Store(dir);
    await s.init();
    assert.equal(s.personaView().active.label, "Archived Coach");
    await s.selectPersona("kata_default");
    assert.deepEqual(await readdir(dir + "/persona-history"), before);
    const disk = JSON.parse(await readFile(dir + "/config.json", "utf8"));
    assert.equal(disk.history, undefined);
    assert.equal(disk.retiredPersonaHistory.version, 1);
    await new Store(dir).init();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retired chain rejects missing, hash-invalid, oversized, symlink, directory and FIFO snapshots", async () => {
  const { dir, path } = await archive();
  try {
    const bytes = await readFile(path);
    await writeFile(dir + "/target", bytes);
    for (const kind of [
      "missing",
      "hash",
      "oversized",
      "symlink",
      "directory",
      "fifo",
    ]) {
      await rm(path, { recursive: true, force: true });
      if (kind === "hash")
        await writeFile(path, Buffer.concat([bytes, Buffer.from(" ")]));
      if (kind === "oversized")
        await writeFile(path, Buffer.alloc(1024 * 1024));
      if (kind === "symlink") await symlink(dir + "/target", path);
      if (kind === "directory") await mkdir(path);
      if (kind === "fifo") execFileSync("mkfifo", [path]);
      await assert.rejects(new Store(dir).init(), undefined, kind);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retired records and manifest fail closed for malformed shapes, links, IDs, timestamps and secrets", async () => {
  const { dir, config, valid, head } = await archive();
  try {
    for (const record of [
      { ...valid, extra: true },
      { ...valid, version: 2 },
      { ...valid, savedAt: "not a date" },
      { ...valid, revision: 0 },
      { ...valid, revision: 1.5 },
      { ...valid, revision: valid.revision + 1 },
      { ...valid, previous: "../secrets.json" },
      { ...valid, previous: "persona-" + "a".repeat(64) + ".json" },
      { ...valid, previous: head }, // Valid hash, nondecreasing revision.
      { ...valid, persona: { ...valid.persona, extra: "forbidden" } },
      { ...valid, persona: { ...valid.persona, name: "" } },
      { ...valid, persona: { ...valid.persona, voice: 7 } },
      { ...valid, persona: { ...valid.persona, markdown: "x".repeat(8001) } },
      { ...valid, persona: { ...valid.persona, markdown: admin } },
    ]) {
      const bad = await snapshot(dir, record);
      await writeFile(
        dir + "/config.json",
        JSON.stringify({ ...config, history: { version: 1, head: bad } }),
      );
      await assert.rejects(
        new Store(dir).init(),
        undefined,
        JSON.stringify(record).slice(0, 80),
      );
    }
    // A clean head cannot hide a secret-bearing older snapshot.
    const previous = await snapshot(dir, {
      version: 1,
      revision: 1,
      savedAt: null,
      persona: { ...persona, markdown: admin },
      previous: null,
    });
    const leaky = await snapshot(dir, { ...valid, previous });
    for (const key of ["history", "retiredPersonaHistory"]) {
      await writeFile(
        dir + "/config.json",
        JSON.stringify({
          current: config.current,
          [key]: { version: 1, head: leaky },
        }),
      );
      await assert.rejects(new Store(dir).init(), /SECRET_IN_CONFIG/, key);
    }
    for (const history of [
      null,
      {},
      { version: 2, head },
      { version: 1, head, extra: true },
      { version: 1, head: "../secrets.json" },
      { version: 1, head: null },
    ]) {
      await writeFile(
        dir + "/config.json",
        JSON.stringify({ ...config, history }),
      );
      await assert.rejects(new Store(dir).init());
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retired archive directory must be a real directory", async () => {
  const { dir } = await archive();
  try {
    const archiveDir = dir + "/persona-history";
    await mkdir(dir + "/outside");
    for (const kind of ["symlink", "file", "fifo"]) {
      await rm(archiveDir, { recursive: true, force: true });
      if (kind === "symlink") await symlink(dir + "/outside", archiveDir);
      if (kind === "file") await writeFile(archiveDir, "not a directory");
      if (kind === "fifo") execFileSync("mkfifo", [archiveDir]);
      await assert.rejects(new Store(dir).init(), undefined, kind);
      assert.deepEqual(await readdir(dir + "/outside"), []);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

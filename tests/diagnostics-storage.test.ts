import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  stat,
  writeFile,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  Diagnostics,
  LOG_ENTRIES,
  LOG_FILE_BYTES,
} from "../src/diagnostics/log.js";

test("bounded structured history rotates, strips arbitrary data and retains last error after idle history", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-ring-");
  try {
    const log = new Diagnostics(dir);
    log.record({
      source: "worker",
      stage: "request-failed",
      error: new Error("MODEL_FAILED"),
    });
    for (let i = 0; i < 3000; i++)
      log.record({
        source: "worker",
        stage: "idle",
        metadata: {
          elapsedMs: i,
          bytes: -1,
          limit: Infinity,
          url: "PRIVATE",
          nested: { key: "PRIVATE" },
        },
        ref: "PRIVATE",
      });
    assert.equal(log.lastError?.code, "MODEL_FAILED");
    const result = log.snapshot();
    assert.equal(result.entries.length, LOG_ENTRIES);
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
    assert.deepEqual(result.entries.at(-1)?.metadata, { elapsedMs: 2999 });
    for (const suffix of ["", ".1"]) {
      assert.ok(
        (await stat(dir + "/diagnostics.jsonl" + suffix)).size <=
          LOG_FILE_BYTES,
      );
      assert.equal(
        (await stat(dir + "/diagnostics.jsonl" + suffix)).mode & 0o777,
        0o600,
      );
    }
    const restored = new Diagnostics(dir);
    assert.equal(restored.snapshot().entries.length, LOG_ENTRIES);
    assert.equal(restored.snapshot().entries.at(-1)?.metadata.elapsedMs, 2999);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("provider diagnostic preview and shape survive protected restart but unsafe input is omitted", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-payload-");
  try {
    const log = new Diagnostics(dir);
    log.record({
      source: "provider",
      stage: "provider-payload",
      preview: "Please list available tools.",
      shape: {
        toolChoice: "auto",
        toolCount: 1,
        toolNames: ["coach_list_activities"],
        messageCount: 2,
        lastRole: "user",
        lastContentShape: "text",
        previewSource: "last-message",
      },
    });
    assert.equal(
      new Diagnostics(dir).snapshot().entries.at(-1)?.preview,
      "Please list available tools.",
    );
    log.record({
      source: "provider",
      stage: "provider-payload",
      preview: "Bearer synthetic-private-key",
      shape: {
        toolChoice: "auto",
        toolCount: 0,
        toolNames: [],
        messageCount: 1,
        lastRole: "user",
        lastContentShape: "text",
        previewSource: "last-message",
      },
    });
    assert.equal(log.snapshot().entries.at(-1)?.preview, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inbound response shape counters survive protected restart without content", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-response-");
  try {
    const log = new Diagnostics(dir);
    log.record({
      source: "provider",
      stage: "provider-response",
      metadata: {
        turn: 2,
        nativeCalls: 1,
        textParts: 0,
        rawText: "PRIVATE",
      },
    });
    assert.deepEqual(new Diagnostics(dir).snapshot().entries.at(-1)?.metadata, {
      turn: 2,
      nativeCalls: 1,
      textParts: 0,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("protected task-output log retains a full safe rejected candidate and exact reason across restart", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-rejected-");
  try {
    const log = new Diagnostics(dir);
    const text =
      "model returned XML rather than JSON: <tool_call>read</tool_call>";
    log.record({
      source: "worker",
      stage: "task-output-correction",
      level: "warn",
      error: new Error("TASK_OUTPUT_JSON"),
      rejection: {
        kind: "activity_reaction",
        attempt: 1,
        reason: "Unexpected token '<' at position 0",
        text,
      },
    });
    assert.equal(log.snapshot().entries.at(-1)?.rejection?.text, text);
    assert.equal(
      new Diagnostics(dir).snapshot().entries.at(-1)?.rejection?.reason,
      "Unexpected token '<' at position 0",
    );
    assert.equal((await stat(dir + "/diagnostics.jsonl")).mode & 0o777, 0o600);
    log.record({
      source: "worker",
      stage: "idle",
      rejection: {
        kind: "activity_reaction",
        attempt: 1,
        reason: "oops",
        text,
      },
    });
    assert.equal(log.snapshot().entries.at(-1)?.rejection, undefined);
    log.record({
      source: "worker",
      stage: "task-output-correction",
      error: new Error("TASK_OUTPUT_SECURITY"),
      rejection: {
        kind: "activity_reaction",
        attempt: 1,
        reason: "secret",
        text: "Bearer leaked-secret",
      },
    });
    assert.equal(log.snapshot().entries.at(-1)?.rejection, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("long schema reasons retain the full rejected text across restart", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-schema-rejected-");
  try {
    const text = '{"text":"ok","extra":true}';
    const reason = "schema detail ".repeat(850);
    const log = new Diagnostics(dir);
    log.record({
      source: "worker",
      stage: "task-output-correction",
      error: new Error("TASK_OUTPUT_SCHEMA"),
      rejection: { kind: "activity_reaction", attempt: 2, reason, text },
    });
    assert.deepEqual(
      new Diagnostics(dir).snapshot().entries.at(-1)?.rejection,
      { kind: "activity_reaction", attempt: 2, reason, text },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("benign escaped Unicode in schema-invalid JSON retains full candidate; decoded credentials do not", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-benign-escape-");
  try {
    const log = new Diagnostics(dir);
    const text = '{"text":"caf\\u00e9","unexpected":true}';
    log.record({
      source: "worker",
      stage: "task-output-correction",
      error: new Error("TASK_OUTPUT_SCHEMA"),
      rejection: {
        kind: "activity_followup",
        attempt: 1,
        reason: "additional property unexpected",
        text,
      },
    });
    assert.equal(
      new Diagnostics(dir).snapshot().entries.at(-1)?.rejection?.text,
      text,
    );
    const disguised = '{"text":"kco\\u0061ch_private-token","unexpected":true}';
    log.record({
      source: "worker",
      stage: "task-output-correction",
      error: new Error("TASK_OUTPUT_SCHEMA"),
      rejection: {
        kind: "activity_followup",
        attempt: 2,
        reason: "additional property unexpected",
        text: disguised,
      },
    });
    assert.equal(log.snapshot().entries.at(-1)?.rejection, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("malformed JSON with Unicode-escaped credential bytes never enters protected logs", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-escaped-secret-");
  try {
    const log = new Diagnostics(dir);
    const text = '{"text":"kco\\u0061ch_private-token"} extra';
    log.record({
      source: "worker",
      stage: "task-output-correction",
      error: new Error("TASK_OUTPUT_JSON"),
      rejection: {
        kind: "activity_reaction",
        attempt: 1,
        reason: "invalid JSON",
        text,
      },
    });
    assert.equal(log.snapshot().entries.at(-1)?.rejection, undefined);
    assert.ok(
      !(await readFile(dir + "/diagnostics.jsonl", "utf8")).includes(text),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
for (const kind of ["symlink", "fifo", "malformed"] as const) {
  test(`log storage ${kind} is bounded, sanitized and cannot block startup`, async () => {
    const dir = await mkdtemp(tmpdir() + "/coach-log-storage-");
    const path = dir + "/diagnostics.jsonl";
    try {
      if (kind === "symlink") {
        await writeFile(dir + "/outside", "PRIVATE");
        await symlink(dir + "/outside", path);
      }
      if (kind === "fifo") assert.equal(spawnSync("mkfifo", [path]).status, 0);
      if (kind === "malformed")
        await writeFile(
          path,
          "{bad\n" +
            JSON.stringify({
              time: new Date().toISOString(),
              source: "PRIVATE",
              stage: "PRIVATE",
              level: "error",
              code: "MODEL_FAILED",
              hint: "PRIVATE",
              metadata: { status: 500, raw: "PRIVATE" },
            }) +
            "\n",
        );
      const script = `import { Diagnostics } from './src/diagnostics/log.ts'; const d = new Diagnostics(${JSON.stringify(dir)}); d.record({ source: 'studio', stage: 'studio-started' }); console.log(JSON.stringify(d.snapshot()));`;
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        { timeout: 2000, encoding: "utf8" },
      );
      assert.equal(child.status, 0, "storage must not block or crash");
      const result = JSON.parse(child.stdout);
      assert.equal(result.persistence, kind === "malformed");
      assert.ok(!child.stdout.includes("PRIVATE"));
      if (kind === "symlink")
        assert.equal(await readFile(dir + "/outside", "utf8"), "PRIVATE");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

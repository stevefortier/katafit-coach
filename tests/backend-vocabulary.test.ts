import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import {
  backendTools,
  safeBackendCall,
} from "../src/katafit/backendReceipt.js";
import { Client } from "../src/katafit/client.js";
import { Diagnostics } from "../src/diagnostics/log.js";
import { fixture } from "./helpers/native.js";

// Deliberately inspect production literals, not just the fixture catalog. Newly
// introduced static names need an explicit privacy-vocabulary review.
async function productionTools(dir: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (const file of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, file.name);
    if (file.isDirectory()) {
      for (const name of await productionTools(path)) names.add(name);
    } else if (file.name.endsWith(".ts") && file.name !== "backendReceipt.ts") {
      const source = ts.createSourceFile(
        path,
        await readFile(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isStringLiteralLike(node) &&
          /^(coach|studio)_[a-z_]+$/.test(node.text)
        )
          names.add(node.text);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return names;
}

test("every production tool literal retains its safe name through Client, Diagnostics and restart", async () => {
  const names = [
    ...(await productionTools(new URL("../src", import.meta.url).pathname)),
  ].sort();
  assert.ok(names.length > 0);
  assert.deepEqual(
    names.filter((name) => !backendTools.includes(name as any)),
    [],
  );
  const f = await fixture();
  try {
    const log = new Diagnostics(f.store.dir);
    const client = new Client(
      f.store.publicConfig().origin,
      "synthetic-backend-credential",
      new AbortController().signal,
      (e) => log.record(e),
    );
    for (const name of names)
      await client.call(name, { private: "PRIVATE_ARGS" });
    const expected = names;
    for (const snapshot of [
      log.snapshot(),
      new Diagnostics(f.store.dir).snapshot(),
    ]) {
      assert.deepEqual(
        snapshot.entries.map((e) => e.backendCall?.tool),
        expected,
      );
      assert.doesNotMatch(
        JSON.stringify(snapshot),
        /PRIVATE_ARGS|synthetic-backend-credential|127\.0\.0/,
      );
    }
    for (const name of [
      "arbitrary_private_string",
      "coach_read_profile?token=secret",
      "https://private.invalid",
      "studio_operator_new_unreviewed_tool",
    ]) {
      assert.equal(
        safeBackendCall({
          route: "mcp",
          method: "POST",
          operation: "tools/call",
          tool: name,
          outcome: "ok",
        })?.tool,
        "other",
      );
    }
  } finally {
    await f.close();
  }
});

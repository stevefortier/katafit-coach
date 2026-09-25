import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("generic action receipts render completed and unknown without calling them message deliveries", async () => {
  const source = await readFile(
    new URL("../ui/app.js", import.meta.url),
    "utf8",
  );
  const render = source.slice(
    source.indexOf("function renderOperatorActions("),
    source.indexOf("function staleAuthentication("),
  );
  const nodes: string[] = [];
  const controls = {
    hidden: true,
    replaceChildren() {
      nodes.length = 0;
    },
    append(text: string) {
      nodes.push(text);
    },
  };
  const context = {
    $: () => controls,
    detailText: (_tag: string, text: string) => text,
  };
  runInNewContext(
    render +
      `\nrenderOperatorActions([{ tool_name: "studio_operator_future_write", status: "completed", action_id: "canonical-action" }, { tool_name: "studio_operator_future_write", status: "unknown" }]);`,
    context,
  );
  assert.equal(nodes.length, 2);
  assert.match(
    nodes[0],
    /Completed.*backend receipt confirmed.*future_write.*canonical-action/,
  );
  assert.match(
    nodes[1],
    /Action outcome unknown.*do not retry.*backend confirmation required.*future_write/,
  );
  assert.doesNotMatch(nodes[1], /Delivery/);
  assert.equal(controls.hidden, false);
});

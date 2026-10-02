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
  const settledNodes: string[] = [];
  const historyRows = {
    replaceChildren() {
      settledNodes.length = 0;
    },
    append(text: string) {
      settledNodes.push(text);
    },
  };
  const history = { hidden: true, open: false };
  const summary = { textContent: "" };
  const context = {
    $: (id: string) =>
      id === "operatorDeliveryHistoryRows"
        ? historyRows
        : id === "operatorDeliveryHistory"
          ? history
          : id === "operatorDeliveryHistorySummary"
            ? summary
            : controls,
    detailText: (_tag: string, text: string) => text,
  };
  runInNewContext(
    render +
      `\nrenderOperatorActions([{ tool_name: "studio_operator_future_write", status: "completed", action_id: "canonical-action" }, { tool_name: "studio_operator_future_write", status: "unknown" }]);`,
    context,
  );
  assert.equal(nodes.length, 1);
  assert.equal(settledNodes.length, 1);
  assert.equal(history.hidden, false);
  assert.equal(history.open, false);
  assert.equal(summary.textContent, "Delivery history · 1");
  assert.match(
    settledNodes[0],
    /Completed.*backend receipt confirmed.*future_write.*canonical-action/,
  );
  assert.match(
    nodes[0],
    /Action outcome unknown.*do not retry.*backend confirmation required.*future_write/,
  );
  assert.doesNotMatch(nodes[0], /Delivery/);
  assert.equal(controls.hidden, false);
});

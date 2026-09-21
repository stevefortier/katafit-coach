import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoSecrets } from "../src/config/store.js";
import { Client } from "../src/katafit/client.js";
import { discoverReads } from "../src/katafit/readTools.js";
import { fence, readFixture, schema, wire } from "./data-fixtures.js";

for (const kind of ["backend", "admin", "provider"]) {
  const secret = `synthetic-"${kind}\\credential"`;
  for (const [label, value] of Object.entries({
    key: { [secret]: "safe" },
    nested: { rows: [{ child: { [secret]: "safe" } }] },
    value: { rows: [{ child: secret }] },
    jsonKey: JSON.stringify({ rows: [{ [secret]: "safe" }] }),
    jsonValue: JSON.stringify({ rows: [secret] }),
    unicodeKey: JSON.stringify({ [secret]: "safe" }).replace(
      "synthetic",
      "\\u0073ynthetic",
    ),
  })) {
    test(`${kind}: known-secret traversal rejects ${label}`, () => {
      assert.throws(() => assertNoSecrets(value, [secret]), /SECRET_IN_CONFIG/);
      assert.doesNotThrow(() => assertNoSecrets(value, ["unrelated"]));
    });
  }
  for (const [label, result] of Object.entries({
    structured: { structuredContent: { rows: [{ [secret]: "safe" }] } },
    text: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ rows: [{ [secret]: "safe" }] }),
        },
      ],
    },
  })) {
    test(`${kind}: MCP bridge rejects ${label} keys before exposing model content`, async () => {
      const f = await readFixture(result);
      try {
        const reads = await discoverReads(
          new Client(f.origin, "synthetic-token", AbortSignal.timeout(2000)),
          fence,
          { vision: false, secrets: [secret] },
        );
        await assert.rejects(
          reads.tools[0].execute("test", {}),
          /SECRET_IN_CONFIG/,
        );
      } finally {
        await f.close();
      }
    });
  }
  for (const location of ["property", "description", "capabilities"]) {
    test(`${kind}: discovery rejects known secrets in ${location}`, async () => {
      const inputSchema = structuredClone(schema) as any;
      if (location === "property")
        inputSchema.properties[secret] = { type: "string" };
      const f = await wire((method) =>
        method === "tools/list"
          ? {
              tools: [
                { name: "coach_get_capabilities" },
                {
                  name: "coach_list_activities",
                  inputSchema,
                  description:
                    location === "description"
                      ? JSON.stringify({ [secret]: "safe" })
                      : "safe",
                },
              ],
            }
          : {
              structuredContent: {
                contract_version: 2,
                allowed_tools: ["coach_list_activities"],
                domains:
                  location === "capabilities" ? [{ [secret]: "safe" }] : {},
              },
            },
      );
      try {
        await assert.rejects(
          discoverReads(
            new Client(f.origin, "synthetic-token", AbortSignal.timeout(2000)),
            fence,
            { vision: false, secrets: [secret] },
          ),
          /SECRET_IN_CONFIG/,
        );
      } finally {
        await f.close();
      }
    });
  }
}

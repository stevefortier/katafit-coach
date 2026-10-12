import test from "node:test";
import assert from "node:assert/strict";
import { releasePresenceFixture } from "./release-presence-fixture.mjs";

const instance = "00000000-0000-4000-8000-000000000001";
async function fixture(fault, run) {
  const backend = releasePresenceFixture({ fault });
  await new Promise((resolve) =>
    backend.server.listen(0, "127.0.0.1", resolve),
  );
  const rpc = async (method, params, token = "synthetic-release-token") => {
    const response = await fetch(
      `http://127.0.0.1:${backend.server.address().port}/mcp`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(5000),
      },
    );
    return {
      status: response.status,
      ...(response.status === 200 ? await response.json() : {}),
    };
  };
  try {
    await run(rpc, backend.snapshot);
  } finally {
    backend.server.closeAllConnections();
    await new Promise((resolve) => backend.server.close(resolve));
  }
}
const report = (args) => ({
  name: "coach_report_worker_presence",
  arguments: { instance_id: instance, ...args },
});

test("synthetic presence enforces exact credentials, incarnation and rotating generation CAS", async () => {
  await fixture(undefined, async (rpc, snapshot) => {
    assert.equal(
      (await rpc("tools/call", report({ state: "running" }), "wrong-identity"))
        .status,
      401,
    );
    assert.equal(snapshot().reports.length, 0);
    const first = (await rpc("tools/call", report({ state: "running" }))).result
      .structuredContent;
    assert.equal(first.state, "running");
    assert.match(first.generation, /^[a-f0-9]{32}$/);
    const next = (
      await rpc(
        "tools/call",
        report({ state: "running", generation: first.generation }),
      )
    ).result.structuredContent;
    assert.notEqual(next.generation, first.generation);
    assert.equal(
      (
        await rpc(
          "tools/call",
          report({ state: "stopped", generation: first.generation }),
        )
      ).result.isError,
      true,
    );
    assert.equal(snapshot().running.length, 1);
    const stopped = (
      await rpc(
        "tools/call",
        report({ state: "stopped", generation: next.generation }),
      )
    ).result.structuredContent;
    assert.equal(stopped.state, "stopped");
    assert.equal(snapshot().running.length, 0);
    assert.equal(
      (
        await rpc(
          "tools/call",
          report({ state: "running", generation: next.generation }),
        )
      ).result.isError,
      true,
    );
    assert.equal(
      (await rpc("tools/call", report({ state: "running" }))).result.isError,
      true,
    );
    assert.equal(
      (
        await rpc(
          "tools/call",
          report({ state: "stopped", generation: next.generation }),
        )
      ).result.isError,
      undefined,
    );
  });
});
test("unsupported presence does not advertise a supported contract", async () => {
  await fixture("unsupported", async (rpc) =>
    assert.deepEqual((await rpc("tools/list")).result.tools, []),
  );
});
test("valid-shaped wrong-generation response cannot acknowledge a later Stop", async () => {
  await fixture("wrong-generation", async (rpc, snapshot) => {
    const reply = (await rpc("tools/call", report({ state: "running" }))).result
      .structuredContent;
    assert.match(reply.generation, /^[a-f0-9]{32}$/);
    assert.notEqual(reply.generation, snapshot().reports[0].issuedGeneration);
    const stop = await rpc(
      "tools/call",
      report({ state: "stopped", generation: reply.generation }),
    );
    assert.equal(stop.result.isError, true);
    assert.equal(stop.result.structuredContent.code, "WORKER_PRESENCE_STALE");
    assert.equal(snapshot().running.length, 1);
  });
});

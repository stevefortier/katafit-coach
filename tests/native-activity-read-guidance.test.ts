import test from "node:test";
import assert from "node:assert/strict";
import { continuityFixture, DETAIL, GENERIC } from "./helpers/continuity.js";
import { openNativeGateway } from "./helpers/legacy-gateway.js";

test("backend READ_LIMIT on activity detail yields content-free, read-only native guidance", async () => {
  const f = await continuityFixture({ detailFailure: "READ_LIMIT" });
  try {
    const gateway = await openNativeGateway(f.store);
    try {
      const result = await gateway.handle({
        kind: "tool",
        name: DETAIL,
        args: {
          member_ref: "fixture-member",
          activity_ref: "synthetic-activity",
          section: "media_files",
        },
      });
      assert.deepEqual(result, { operatorReadError: { code: "READ_LIMIT" } });
      assert.equal(f.named(DETAIL).length, 1);
      const other = await gateway.handle({
        kind: "tool",
        name: GENERIC,
        args: {},
      });
      assert.match(JSON.stringify(other), /SYNTHETIC GENERIC/);
    } finally {
      await gateway.close();
    }
  } finally {
    await f.close();
  }
});

test("unclassified activity errors do not become a trusted guidance code", async () => {
  const f = await continuityFixture({ detailFailure: "PRIVATE_BACKEND_CODE" });
  try {
    const gateway = await openNativeGateway(f.store);
    try {
      await assert.rejects(
        gateway.handle({
          kind: "tool",
          name: DETAIL,
          args: {
            member_ref: "fixture-member",
            activity_ref: "synthetic-activity",
            section: "media_files",
          },
        }),
        /MCP_TOOL_FAILED/,
      );
    } finally {
      await gateway.close();
    }
  } finally {
    await f.close();
  }
});

test("bad or stale activity reference is a read denial, not proof of missing media or session revocation", async () => {
  const f = await continuityFixture({
    detailFailure: "OPERATOR_NOT_AUTHORIZED",
  });
  try {
    const gateway = await openNativeGateway(f.store);
    try {
      const result = await gateway.handle({
        kind: "tool",
        name: DETAIL,
        args: {
          member_ref: "fixture-member",
          activity_ref: "synthetic-stale-ref",
          section: "media_files",
        },
      });
      assert.deepEqual(result, {
        operatorReadError: { code: "OPERATOR_NOT_AUTHORIZED" },
      });
      assert.equal(f.state.status, "active");
      assert.equal(f.named("studio_operator_authorize_context").length, 0);
      assert.equal(f.named(DETAIL).length, 1);
    } finally {
      await gateway.close();
    }
  } finally {
    await f.close();
  }
});

test("retained-context revocation still destroys runtime before read guidance", async () => {
  const f = await continuityFixture({
    detailFailure: "OPERATOR_NOT_AUTHORIZED",
    revocationMarker: true,
  });
  const terminated: string[] = [];
  try {
    const gateway = await openNativeGateway(f.store, undefined, {
      onTerminate: (reason) => terminated.push(reason),
    });
    f.state.revoked = true;
    try {
      await assert.rejects(
        gateway.handle({
          kind: "tool",
          name: DETAIL,
          args: {
            member_ref: "fixture-member",
            activity_ref: "synthetic-activity",
            section: "media_files",
          },
        }),
        (error: any) => error.code === "NATIVE_SESSION_REVOKED",
      );
      assert.equal(terminated.length, 1);
    } finally {
      await gateway.close();
    }
  } finally {
    await f.close();
  }
});

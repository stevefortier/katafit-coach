import test from "node:test";
import assert from "node:assert/strict";
import { Updates } from "../src/update/updates.js";
import { autonomyAdmin, until } from "./helpers/autonomy-admin.js";

const delay = () => new Promise((r) => setTimeout(r, 350));
const acquisitions = (calls: { path: string }[]) =>
  calls.filter((c) => c.path.startsWith("/api/coach/autonomy/work?"));

for (const fence of ["applying", "recovering"] as const)
  test(`participating admin resumes once after initial ${fence} fence clears`, async () => {
    const updates = new Updates(null, async () => {});
    updates[fence] = true;
    const env = await autonomyAdmin({ updates, participate: true });
    try {
      await delay();
      assert.equal(acquisitions(env.fake.calls).length, 0);
      assert.equal((await env.status()).local.state, "stopped");
      updates[fence] = false;
      await until(
        () => acquisitions(env.fake.calls).length > 0,
        "one safety-gated startup resumes real acquisition",
      );
      assert.notEqual((await env.status()).local.state, "stopped");
    } finally {
      await env.close();
    }
  });

test("activation retry does not override withdrawn participation", async () => {
  const updates = new Updates(null, async () => {});
  updates.applying = true;
  const env = await autonomyAdmin({ updates, participate: true });
  try {
    await env.store.setAutonomyParticipate(false);
    updates.applying = false;
    await delay();
    assert.equal(acquisitions(env.fake.calls).length, 0);
    assert.equal((await env.status()).local.state, "stopped");
  } finally {
    await env.close();
  }
});

test("closing cancels activation retry without a backend acquisition", async () => {
  const updates = new Updates(null, async () => {});
  updates.recovering = true;
  const env = await autonomyAdmin({ updates, participate: true });
  await env.close();
  updates.recovering = false;
  await delay();
  assert.equal(acquisitions(env.fake.calls).length, 0);
});

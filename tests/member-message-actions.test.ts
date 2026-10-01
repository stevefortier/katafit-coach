import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Actions } from "../src/chat/actions.js";
import { Store } from "../src/config/store.js";

const binding = {
  installation_id: "0123456789abcdef0123456789abcdef",
  origin: "https://backend.example",
  account_owner_id: "64b7f0c2a1b2c3d4e5f60718",
};
const recipient = "64b7f0c2a1b2c3d4e5f60799";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const intent = (
  occurrence_id: string,
  text = "Same words",
  to = recipient,
) => ({
  occurrence_id,
  recipient_id: to,
  payload_sha256: digest(text),
});

async function journal() {
  const dir = await mkdtemp(tmpdir() + "/member-journal-");
  const store = new Store(dir);
  await store.init();
  await store.save({ ...store.publicConfig(), token: "synthetic-token-a" });
  return {
    store,
    dir,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test("one occurrence mints one durable host key and is stable across restart", async () => {
  const j = await journal();
  try {
    const first = new Actions(j.store).admitMemberDelivery(
      binding,
      intent("event-1:slot-0"),
    );
    assert.equal(first.mode, "send");
    assert.match(first.record.idempotency_key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(first.record.status, "pending");
    // Durable before any dispatch: a fresh reader sees the same pending key.
    const reopened = new Actions(j.store);
    const again = reopened.admitMemberDelivery(
      binding,
      intent("event-1:slot-0"),
    );
    assert.equal(again.mode, "recover");
    assert.equal(again.record.idempotency_key, first.record.idempotency_key);
    reopened.settleMemberDelivery(first.record.idempotency_key, {
      status: "delivered",
      message_id: "message-1",
    });
    const settled = new Actions(j.store).admitMemberDelivery(
      binding,
      intent("event-1:slot-0"),
    );
    assert.equal(settled.mode, "delivered");
    assert.equal(settled.record.message_id, "message-1");
    assert.equal(settled.record.idempotency_key, first.record.idempotency_key);
    assert.equal(new Actions(j.store).memberDeliveries().length, 1);
  } finally {
    await j.close();
  }
});

test("same occurrence with a changed recipient or text is rejected before any new key", async () => {
  const j = await journal();
  try {
    const actions = new Actions(j.store);
    const first = actions.admitMemberDelivery(binding, intent("occ"));
    actions.settleMemberDelivery(first.record.idempotency_key, {
      status: "delivered",
      message_id: "message-1",
    });
    const before = await readFile(j.dir + "/operator-actions.json", "utf8");
    assert.throws(
      () => actions.admitMemberDelivery(binding, intent("occ", "Other words")),
      /OCCURRENCE_CONFLICT/,
    );
    assert.throws(
      () =>
        actions.admitMemberDelivery(
          binding,
          intent("occ", "Same words", "64b7f0c2a1b2c3d4e5f60700"),
        ),
      /OCCURRENCE_CONFLICT/,
    );
    assert.equal(
      await readFile(j.dir + "/operator-actions.json", "utf8"),
      before,
    );
  } finally {
    await j.close();
  }
});

test("distinct occurrences may carry identical words with distinct keys", async () => {
  const j = await journal();
  try {
    const actions = new Actions(j.store);
    const keys = [];
    for (const occurrence of ["event-1:slot-0", "event-2:slot-0"]) {
      const admitted = actions.admitMemberDelivery(binding, intent(occurrence));
      assert.equal(admitted.mode, "send");
      keys.push(admitted.record.idempotency_key);
      actions.settleMemberDelivery(admitted.record.idempotency_key, {
        status: "delivered",
        message_id: "message-" + occurrence,
      });
    }
    assert.notEqual(keys[0], keys[1]);
    assert.equal(actions.memberDeliveries().length, 2);
  } finally {
    await j.close();
  }
});

test("member delivery state is monotonic and a pending occurrence fences new ones", async () => {
  const j = await journal();
  try {
    const actions = new Actions(j.store);
    const first = actions.admitMemberDelivery(binding, intent("occ-1"));
    actions.settleMemberDelivery(first.record.idempotency_key, {
      status: "unknown",
    });
    // A new occurrence cannot be admitted while one outcome is uncertain.
    assert.throws(
      () => actions.admitMemberDelivery(binding, intent("occ-2")),
      /DELIVERY_UNVERIFIED/,
    );
    actions.settleMemberDelivery(first.record.idempotency_key, {
      status: "delivered",
      message_id: "message-1",
    });
    actions.settleMemberDelivery(first.record.idempotency_key, {
      status: "unknown",
    });
    actions.settleMemberDelivery(first.record.idempotency_key, {
      status: "pending",
    });
    const record = new Actions(j.store).memberDeliveries()[0];
    assert.equal(record.status, "delivered");
    assert.equal(record.message_id, "message-1");
    assert.equal(
      actions.admitMemberDelivery(binding, intent("occ-2")).mode,
      "send",
    );
  } finally {
    await j.close();
  }
});

test("retention evicts only verified deliveries and never readmits an evicted occurrence", async () => {
  const j = await journal();
  try {
    const actions = new Actions(j.store);
    for (let i = 0; i < 30; i++) {
      const admitted = actions.admitMemberDelivery(binding, intent("e" + i));
      actions.settleMemberDelivery(admitted.record.idempotency_key, {
        status: "delivered",
        message_id: "m" + i,
      });
    }
    const retained = new Actions(j.store).memberDeliveries();
    assert.ok(retained.length < 20);
    assert.equal(retained.at(-1)?.message_id, "m29");
    // An evicted occurrence never mints a second key or a second POST.
    assert.throws(
      () => new Actions(j.store).admitMemberDelivery(binding, intent("e0")),
      /OCCURRENCE_CONSUMED/,
    );
    const pending = actions.admitMemberDelivery(binding, intent("e-last"));
    assert.equal(pending.mode, "send");
    assert.ok(
      Buffer.byteLength(
        await readFile(j.dir + "/operator-actions.json", "utf8"),
      ) <= 131072,
    );
    assert.equal(
      new Actions(j.store)
        .memberDeliveries()
        .some((r) => r.occurrence_id === "e-last" && r.status === "pending"),
      true,
    );
  } finally {
    await j.close();
  }
});

test("secret rotation keeps a new-format occurrence's identity; another account cannot adopt it", async () => {
  const j = await journal();
  try {
    const first = new Actions(j.store).admitMemberDelivery(
      binding,
      intent("occ"),
    );
    await j.store.save({
      ...j.store.publicConfig(),
      token: "synthetic-token-b",
      apiKey: "synthetic-provider-key-b",
    });
    const rotated = new Actions(j.store).admitMemberDelivery(
      binding,
      intent("occ"),
    );
    assert.equal(rotated.mode, "recover");
    assert.equal(rotated.record.idempotency_key, first.record.idempotency_key);
    const other = { ...binding, account_owner_id: "64b7f0c2a1b2c3d4e5f60000" };
    // A different account sees no adoptable record and stays fenced.
    assert.deepEqual(
      new Actions(j.store).recoverableMemberDeliveries(other),
      [],
    );
    assert.throws(
      () => new Actions(j.store).admitMemberDelivery(other, intent("occ")),
      /DELIVERY_UNVERIFIED/,
    );
    assert.equal(
      new Actions(j.store).recoverableMemberDeliveries(binding).length,
      1,
    );
  } finally {
    await j.close();
  }
});

test("journal persists a payload digest, never the message text or credentials", async () => {
  const j = await journal();
  try {
    new Actions(j.store).admitMemberDelivery(
      binding,
      intent("occ", "Private synthetic coaching words"),
    );
    const raw = await readFile(j.dir + "/operator-actions.json", "utf8");
    assert.doesNotMatch(raw, /Private synthetic coaching words/);
    assert.doesNotMatch(raw, /synthetic-token-a/);
    assert.match(raw, new RegExp(digest("Private synthetic coaching words")));
    assert.match(raw, new RegExp(binding.account_owner_id));
    assert.match(raw, new RegExp(binding.installation_id));
  } finally {
    await j.close();
  }
});

test("old journal entries are preserved, unknown future formats fail closed", async () => {
  const j = await journal();
  try {
    const actions = new Actions(j.store);
    actions.save({
      session_id: "native-rest",
      idempotency_key: "a".repeat(64),
      tool_name: "katafit_rest_request",
      recipient_id: recipient,
      status: "unknown",
    });
    actions.save({
      session_id: "legacy",
      idempotency_key: "legacy-key",
      tool_name: "studio_operator_send_message",
      status: "delivered",
      message_id: "legacy-message",
    });
    const reopened = new Actions(j.store);
    assert.deepEqual(
      reopened.snapshot().map((a: any) => [a.idempotency_key, a.status]),
      [
        ["a".repeat(64), "unknown"],
        ["legacy-key", "delivered"],
      ],
    );
    // The legacy unknown send keeps fencing new occurrences.
    assert.throws(
      () => reopened.admitMemberDelivery(binding, intent("occ")),
      /DELIVERY_UNVERIFIED/,
    );
    const rows = JSON.parse(
      await readFile(j.dir + "/operator-actions.json", "utf8"),
    );
    rows.push(
      { role: "user", text: "member-delivery-v2" },
      {
        role: "assistant",
        text: JSON.stringify({ format: "member-delivery-v9", status: "x" }),
      },
    );
    await writeFile(j.dir + "/operator-actions.json", JSON.stringify(rows));
    assert.throws(() => new Actions(j.store), /UNSAFE_STORAGE/);
  } finally {
    await j.close();
  }
});

test("legacy same-scope unknown sends are attested to the backend binding without a new key", async () => {
  const j = await journal();
  try {
    const actions = new Actions(j.store);
    actions.save({
      session_id: "native-rest",
      idempotency_key: "b".repeat(64),
      tool_name: "katafit_rest_request",
      recipient_id: recipient,
      status: "unknown",
    });
    // Same original credential scope: provenance is the attested token.
    assert.equal(actions.attestLegacyMemberSends(binding), 1);
    const [record] = actions.recoverableMemberDeliveries(binding);
    assert.equal(record.idempotency_key, "b".repeat(64));
    assert.equal(record.recipient_id, recipient);
    assert.equal(record.status, "unknown");
    assert.equal(record.legacy, true);
    assert.equal(record.occurrence_id, undefined);

    // A legacy record written under another credential scope is not adopted.
    actions.save(
      {
        session_id: "native-rest",
        idempotency_key: "c".repeat(64),
        tool_name: "katafit_rest_request",
        recipient_id: recipient,
        status: "unknown",
      },
      "other-scope",
    );
    assert.equal(actions.attestLegacyMemberSends(binding), 0);
    assert.equal(actions.memberDeliverySummary(binding).legacy_unbound, 1);
    assert.equal(
      new Actions(j.store)
        .snapshot()
        .some((a: any) => a.idempotency_key === "c".repeat(64)),
      true,
    );
  } finally {
    await j.close();
  }
});

test("retired ledger saturation never forgets an old occurrence or mutates storage", async () => {
  const j = await journal();
  try {
    const actions = new Actions(j.store);
    let blocked = false;
    let last = "";
    for (let i = 0; i < 1100; i++) {
      const occurrence = "capacity-" + i;
      let admitted;
      try {
        admitted = actions.admitMemberDelivery(binding, intent(occurrence));
      } catch (error) {
        assert.match((error as Error).message, /MEMBER_DELIVERY_LEDGER_FULL/);
        blocked = true;
        break;
      }
      actions.settleMemberDelivery(admitted.record.idempotency_key, {
        status: "delivered",
        message_id: "message-" + occurrence,
      });
      last = occurrence;
    }
    const before = await readFile(j.dir + "/operator-actions.json", "utf8");
    assert.throws(
      () =>
        new Actions(j.store).admitMemberDelivery(binding, intent("capacity-0")),
      /OCCURRENCE_CONSUMED/,
    );
    assert.ok(
      blocked,
      "bounded storage must stop rather than forget a delivery",
    );
    assert.throws(
      () =>
        new Actions(j.store).admitMemberDelivery(
          binding,
          intent("genuinely-new"),
        ),
      /MEMBER_DELIVERY_LEDGER_FULL/,
    );
    assert.equal(
      new Actions(j.store).admitMemberDelivery(binding, intent(last)).mode,
      "delivered",
    );
    assert.equal(
      await readFile(j.dir + "/operator-actions.json", "utf8"),
      before,
    );
  } finally {
    await j.close();
  }
});

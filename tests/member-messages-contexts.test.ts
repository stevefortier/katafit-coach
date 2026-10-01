import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { Actions } from "../src/chat/actions.js";
import { openMemberMessages } from "../src/katafit/memberMessages.js";
import { memberBackend } from "./helpers/member-backend.js";

const OWNER = "64b7f0c2a1b2c3d4e5f60718";
const ALICE = "64b7f0c2a1b2c3d4e5f60799";

/**
 * Synthetic trusted event producer: NOT a scheduler and no new authority. It
 * reads persisted events and calls the very same shared delivery service with
 * an occurrence identity of persisted event + action slot. No Pi runtime,
 * gateway, provider selection or worker lease is involved.
 */
class SyntheticEventProducer {
  constructor(
    private store: Store,
    private file = store.dir + "/synthetic-events.json",
  ) {}
  async record(events: unknown) {
    await writeFile(this.file, JSON.stringify(events), { mode: 0o600 });
  }
  async run() {
    const events = JSON.parse(await readFile(this.file, "utf8")) as {
      id: string;
      actions: { slot: number; recipient: string; text: string }[];
    }[];
    // A fresh service per run, as a separate process would open it.
    const messages = openMemberMessages(this.store);
    await messages.reconcile();
    const results = [];
    for (const event of events)
      for (const action of event.actions)
        results.push(
          await messages
            .deliver({
              occurrenceId: `event:${event.id}:slot:${action.slot}`,
              recipientId: action.recipient,
              text: action.text,
            })
            .catch((error) => ({ failed: error.code })),
        );
    return results;
  }
}

async function setup() {
  const backend = await memberBackend({ "synthetic-token": OWNER });
  const dir = await mkdtemp(tmpdir() + "/member-contexts-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: backend.origin,
    token: "synthetic-token",
  });
  return {
    backend,
    store,
    async close() {
      await backend.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("two events with identical words produce two canonical messages; replays of one event produce none", async () => {
  const s = await setup();
  try {
    const producer = new SyntheticEventProducer(s.store);
    await producer.record([
      {
        id: "evt-1",
        actions: [{ slot: 0, recipient: ALICE, text: "Nice work." }],
      },
    ]);
    const [first] = await producer.run();
    // The same persisted event re-run (e.g. a retried job) is one occurrence.
    assert.deepEqual((await producer.run())[0], first);
    await producer.record([
      {
        id: "evt-1",
        actions: [{ slot: 0, recipient: ALICE, text: "Nice work." }],
      },
      {
        id: "evt-2",
        actions: [{ slot: 0, recipient: ALICE, text: "Nice work." }],
      },
    ]);
    const results = await producer.run();
    assert.deepEqual(results[0], first);
    assert.notEqual((results[1] as any).message_id, (first as any).message_id);
    assert.deepEqual(
      s.backend.messages.map((m) => [m.recipient, m.text]),
      [
        [ALICE, "Nice work."],
        [ALICE, "Nice work."],
      ],
    );
    assert.equal(s.backend.posts().length, 2);
    // A brand-new producer and service over the same protected storage.
    const restarted = await new SyntheticEventProducer(s.store).run();
    assert.deepEqual(restarted, results);
    assert.equal(s.backend.posts().length, 2);
    assert.ok(
      new Actions(s.store)
        .memberDeliveries()
        .every((r) => r.occurrence_id!.startsWith("event:")),
      "direct callers never impersonate native selections",
    );
  } finally {
    await s.close();
  }
});

test("distinct action slots within one event are distinct intended messages", async () => {
  const s = await setup();
  try {
    const producer = new SyntheticEventProducer(s.store);
    await producer.record([
      {
        id: "evt-run",
        actions: [
          { slot: 0, recipient: ALICE, text: "Check in." },
          { slot: 1, recipient: ALICE, text: "Check in." },
        ],
      },
    ]);
    await producer.run();
    await producer.run();
    assert.equal(s.backend.messages.length, 2);
  } finally {
    await s.close();
  }
});

test("an event whose acknowledgement was lost is recovered per event on restart, never re-posted", async () => {
  const s = await setup();
  try {
    s.backend.state.post = "destroy";
    s.backend.state.receiptsVisible = false;
    const producer = new SyntheticEventProducer(s.store);
    await producer.record([
      { id: "evt-lost", actions: [{ slot: 0, recipient: ALICE, text: "Hi." }] },
      { id: "evt-next", actions: [{ slot: 0, recipient: ALICE, text: "Hi." }] },
    ]);
    // The unresolved first event fences the second; neither is re-posted.
    assert.deepEqual(await producer.run(), [
      { failed: "DELIVERY_UNVERIFIED" },
      { failed: "DELIVERY_UNVERIFIED" },
    ]);
    assert.equal(s.backend.posts().length, 1);
    s.backend.state.post = "ok";
    s.backend.state.receiptsVisible = true;
    const results = await new SyntheticEventProducer(s.store).run();
    assert.equal((results[0] as any).message_id, "message-1");
    assert.equal((results[1] as any).message_id, "message-2");
    assert.equal(s.backend.posts().length, 2);
    assert.equal(s.backend.messages.length, 2);
  } finally {
    await s.close();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { startBackend } from "./helpers/memory-backend.js";

// Independent adversarial disclosure probe: a real replica-set mutation revokes
// peer consent after the reader already captured its roster/consent snapshot.
test(
  "real day-events reader refuses consent revoked during decisive source checks",
  { skip: !process.env.KATAFIT_MEMORY_BACKEND },
  async () => {
    const b = await startBackend();
    const viewer = new b.ObjectId();
    const peer = new b.ObjectId();
    const dojo = new b.ObjectId();
    const first = new b.ObjectId();
    const second = new b.ObjectId();
    const now = new Date();
    const from = new Date(now);
    from.setUTCHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + 86400000);
    const originalCollection = b.db.collection.bind(b.db);
    try {
      await originalCollection("users").insertMany([
        {
          _id: viewer,
          first_name: "Synthetic Viewer",
          settings: {},
          privacy_settings: {},
        },
        {
          _id: peer,
          first_name: "Synthetic Peer",
          settings: {},
          privacy_settings: { workout: ["dojo_chief"] },
        },
      ]);
      await originalCollection("dojos").insertOne({
        _id: dojo,
        chief_id: viewer,
      });
      await originalCollection("dojo_members").insertMany([
        { user_id: viewer, dojo_id: dojo, role: "chief" },
        { user_id: peer, dojo_id: dojo, role: "member" },
      ]);
      await originalCollection("activities").insertMany(
        [first, second].map((_id) => ({
          _id,
          user_id: peer,
          type: "workout",
          status: "complete",
          created_at: now,
          data: {},
        })),
      );
      const { buildUserActivityEvent } = b.require(
        "./core/userActivityTimeline",
      );
      const { eventFor } = b.require("./core/userActivityMutationContext");
      const context = {
        requestReceivedAt: now,
        requestId: "independent-consent-race",
        actorType: "member",
        actorUserId: peer,
        source: "interactive",
      };
      await originalCollection("user_activity_events").insertMany(
        [first, second].map((id, i) =>
          buildUserActivityEvent(
            eventFor(context, {
              ownerUserId: peer,
              eventType: "workout.completed",
              subjectType: "workout",
              subjectId: id,
              occurredAt: new Date(now.getTime() + i),
              eventKey: `independent-consent-race-${i}`,
              details: { from_status: "ongoing", to_status: "complete" },
            }),
          ),
        ),
      );
      let secondReads = 0;
      let revoked = false;
      b.db.collection = ((name: string, ...options: any[]) => {
        const collection = originalCollection(name, ...options);
        if (name !== "activities") return collection;
        return new Proxy(collection, {
          get(target, property) {
            const value = target[property];
            if (property === "findOne")
              return async (...args: any[]) => {
                if (
                  String(args[0]?._id) === String(second) &&
                  ++secondReads === 2
                ) {
                  await originalCollection("users").updateOne(
                    { _id: peer },
                    { $set: { "privacy_settings.workout": [] } },
                  );
                  revoked = true;
                }
                return value.apply(target, args);
              };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }) as typeof b.db.collection;
      let result: any;
      let denial: any;
      try {
        result = await b
          .require("./core/dojoDayEvents")
          .listDojoDayEvents(String(viewer), {
            start: from.toISOString(),
            end: to.toISOString(),
            limit: 10,
          });
      } catch (error) {
        denial = error;
      }
      assert.equal(
        revoked,
        true,
        `the adversarial hook must actually revoke consent during the read: ${JSON.stringify({ secondReads, denial: denial?.code || denial?.message, status: denial?.status, returned: result?.events?.length })}`,
      );
      assert.deepEqual(
        (await originalCollection("users").findOne({ _id: peer }))
          .privacy_settings.workout,
        [],
      );
      if (denial)
        assert.ok(
          [403, 409].includes(denial.status),
          `unexpected denial status ${denial.status}`,
        );
      else
        assert.equal(
          result.events.filter((event: any) => event.user_id === String(peer))
            .length,
          0,
          "stale captured consent must not disclose either peer event",
        );
      const fenced = await originalCollection(
        "user_activity_events",
      ).countDocuments({ owner_user_id: peer });
      assert.equal(
        fenced,
        2,
        "operational authority fences must not fabricate ledger events",
      );
    } finally {
      b.db.collection = originalCollection;
      await b.close();
    }
  },
);

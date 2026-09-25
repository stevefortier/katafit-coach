import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { feed } from "./operator-question-bank-cases.mjs";
export async function seed({ db, require }) {
  const { ObjectId } = require("mongodb");
  const names = [
    "Chief",
    "Steve",
    "Kai",
    "Empty",
    "Pat",
    "Partial",
    "Alex",
    "Alex",
    ...Array.from(
      { length: 23 },
      (_, i) => `Filler ${String(i + 1).padStart(2, "0")}`,
    ),
  ];
  const people = names.map((name, i) => ({
    name,
    id: new ObjectId(),
    key: name === "Alex" ? `Alex${i}` : name,
  }));
  const ids = Object.fromEntries(people.map((p) => [p.key, p.id])),
    dojo = new ObjectId();
  await db.collection("users").insertMany(
    people.map((p) => ({
      _id: p.id,
      display_name: p.name,
      privacy_settings: Object.fromEntries(
        ["metric", "meal", "workout", "media", "survey", "status_change"].map(
          (k) => [k, ["dojo_chief"]],
        ),
      ),
    })),
  );
  await db.collection("dojos").insertOne({
    _id: dojo,
    chief_id: ids.Chief,
    external_coach_agent: { enabled: true },
  });
  await db.collection("dojo_members").insertMany(
    people.map((p) => ({
      user_id: p.id,
      dojo_id: dojo,
      role: p.name === "Chief" ? "chief" : "member",
      joined_at: new Date(0),
    })),
  );
  const docs = [];
  const add = (name, type, day, data, status = "complete", label = type) =>
    docs.push({
      user_id: ids[name],
      dojo_id: dojo,
      type,
      name: `Synthetic ${label}`,
      status,
      created_at: new Date(day + "T12:00:00Z"),
      ...(status === "complete"
        ? { completed_at: new Date(day + "T12:00:00Z") }
        : { due_at: new Date(day + "T12:00:00Z") }),
      data,
    });
  for (const [day, value] of [
    ["2025-08-31", 95],
    ["2025-09-01", 80],
    ["2025-09-07", 79],
    ["2025-09-08", 60],
  ])
    add("Steve", "metric", day, {
      measurements: [{ type_id: "weight", value, unit: "kg" }],
    });
  add("Partial", "metric", "2025-09-03", {
    measurements: [{ type_id: "weight", value: 72, unit: "kg" }],
  });
  for (const [name, calories, protein] of [
    ["Steve", 400, 30],
    ["Kai", 600, 20],
  ]) {
    for (const [day, kcal] of [
      ["2025-09-03", calories],
      ["2025-08-31", 9000],
      ["2025-09-08", 9000],
    ])
      add(name, "meal", day, {
        foods: [
          {
            name: "Synthetic one-serving meal",
            quantity: 1,
            unit: "serving",
            calories: kcal,
            protein,
            snapshot: {
              name: "Synthetic meal",
              calories: kcal,
              protein,
              serving_size: 1,
              serving_unit: "serving",
            },
          },
        ],
      });
    for (const day of [
      "2025-08-31",
      "2025-09-02",
      "2025-09-08",
      ...(name === "Steve" ? ["2025-09-05"] : []),
    ])
      add(name, "workout", day, { exercises: [] });
    add(
      name,
      "workout",
      name === "Steve" ? "2025-09-06" : "2025-09-09",
      { exercises: [] },
      "pending",
    );
  }
  add("Pat", "metric", "2025-09-03", {
    measurements: [{ type_id: "weight", value: 101, unit: "kg" }],
  });
  const media = new Map();
  for (const [name, color] of [
    ["Steve", "#ff0000"],
    ["Kai", "#0000ff"],
  ]) {
    const file = new ObjectId();
    const bytes = await require("sharp")({
      create: { width: 64, height: 64, channels: 3, background: color },
    })
      .png()
      .toBuffer();
    media.set(String(file), bytes);
    add(
      name,
      "media",
      "2025-09-07",
      { files: [{ _id: file, type: "image" }] },
      "complete",
      "progress check-in",
    );
  }
  // Creation is not completion chronology: a scheduled Steve record predates
  // the requested week, while Kai created next week's completed record inside it.
  for (const type of ["workout", "meal"]) {
    docs.find(
      (d) =>
        d.user_id.equals(ids.Steve) &&
        d.type === type &&
        d.completed_at
          ?.toISOString()
          .startsWith(type === "workout" ? "2025-09-02" : "2025-09-03"),
    ).created_at = new Date("2025-08-30T12:00:00Z");
    docs.find(
      (d) =>
        d.user_id.equals(ids.Kai) &&
        d.type === type &&
        d.completed_at?.toISOString().startsWith("2025-09-08"),
    ).created_at = new Date("2025-09-04T12:00:00Z");
  }
  const inWeek = (date) =>
    date >= new Date("2025-09-01T00:00:00Z") &&
    date < new Date("2025-09-08T00:00:00Z");
  for (const type of ["workout", "meal"]) {
    assert.ok(
      docs.some(
        (d) =>
          d.type === type && inWeek(d.completed_at) && !inWeek(d.created_at),
      ),
      "fixture must distinguish in-window completion from creation: " + type,
    );
    assert.ok(
      docs.some(
        (d) =>
          d.type === type && !inWeek(d.completed_at) && inWeek(d.created_at),
      ),
      "fixture must distinguish out-of-window completion from creation: " +
        type,
    );
  }
  await db.collection("activities").insertMany(docs);
  assert.equal(await db.collection("dojo_members").countDocuments(), 31);
  for (const [name, completed, planned] of [
    ["Steve", 2, 3],
    ["Kai", 1, 1],
  ]) {
    const week = {
      user_id: ids[name],
      type: "workout",
      $or: [
        {
          status: "complete",
          completed_at: {
            $gte: new Date("2025-09-01T00:00:00Z"),
            $lt: new Date("2025-09-08T00:00:00Z"),
          },
        },
        {
          status: "pending",
          due_at: {
            $gte: new Date("2025-09-01T00:00:00Z"),
            $lt: new Date("2025-09-08T00:00:00Z"),
          },
        },
      ],
    };
    assert.equal(
      await db.collection("activities").countDocuments(week),
      planned,
      "Fixture adherence denominator " + name,
    );
    assert.equal(
      await db
        .collection("activities")
        .countDocuments({ ...week, status: "complete" }),
      completed,
      "Fixture completed workouts " + name,
    );
  }
  // Only storage boundary is synthetic; authorization, metadata, image validation,
  // Mongo transactions, HTTP MCP and installed Coach all execute real code.
  const storage = require("./core/activities/media"),
    original = storage.getMediaFile;
  storage.getMediaFile = async (id) => {
    const bytes = media.get(String(id));
    if (!bytes) throw new Error("Unknown synthetic image");
    return { fileStream: Readable.from([bytes]), contentType: "image/png" };
  };
  const service = require("./core/personalExternalCoach"),
    operator = require("./core/studioOperator");
  await service.ensureExternalCoachIndexes(db);
  const credential = await service.createCredential(String(ids.Chief), {
    scopes: [
      ...service.DEFAULT_SCOPES,
      "history:read",
      "userdata:read",
      "media:read",
    ],
  });
  const auth = await service.authenticateCredential(credential.token);
  const members = new Map();
  for (const [name, text] of Object.entries(feed)) {
    const s = await operator.execute(auth, "studio_operator_open_session", {
      mode: "dojo_operator",
      idempotency_key: randomUUID(),
    });
    try {
      let cursor;
      do {
        const r = await operator.execute(auth, "studio_operator_list_members", {
          session_id: s.session_id,
          ...(cursor ? { cursor } : {}),
        });
        for (const p of r.members) members.set(p.member_ref, p.display_name);
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      const member_ref = [...members].find(([, n]) => n === name)[0];
      await operator.execute(auth, "studio_operator_send_message", {
        session_id: s.session_id,
        member_ref,
        idempotency_key: randomUUID(),
        text,
      });
    } finally {
      await operator.execute(auth, "studio_operator_close_session", {
        session_id: s.session_id,
      });
    }
  }
  return {
    ids,
    dojo,
    people,
    operator,
    credential,
    members,
    media,
    restore: () => {
      storage.getMediaFile = original;
    },
  };
}

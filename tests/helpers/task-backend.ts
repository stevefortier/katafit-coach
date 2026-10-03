import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { backendRoot, closeServer } from "./account-backend.js";

const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as any).port}`;
};

/**
 * The REAL backend typed-task plane (coach.tasks.v1 + coach.capability.v1),
 * ordinary user/activity REST, API discovery and account memory on a
 * disposable Mongo replica set. Only process-external services (cache, Clerk,
 * feature gate, websocket fan-out) are stubbed. Every Coach-bearer REST call
 * is logged server-side as "METHOD /path STATUS".
 */
export async function startTaskBackend() {
  const dir = backendRoot;
  if (!dir) throw new Error("COACH_BACKEND_ROOT is required for this gate");
  const require = createRequire(dir + "/package.json");
  for (const path of Object.keys(require.cache))
    if (
      ["core/", "config/", "routes/", "middleware/", "docs/"].some((prefix) =>
        path.startsWith(dir + "/" + prefix),
      )
    )
      delete require.cache[path];
  process.env.JWT_SECRET = "synthetic-task-pairing-jwt";
  delete process.env.CLERK_SECRET_KEY;
  const { MongoMemoryReplSet } = require("mongodb-memory-server");
  const { MongoClient, ObjectId } = require("mongodb");
  const express = require("express");
  const mongo = await MongoMemoryReplSet.create({
    binary: { version: "7.0.14" },
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  let client: any;
  let server: Server | undefined;
  try {
    client = await MongoClient.connect(mongo.getUri());
    const db = client.db("coach-task-pairing");
    const connect: any = async () => db;
    connect.getClient = () => client;
    const inject = (name: string, exports: unknown) => {
      const path = require.resolve(name);
      require.cache[path] = {
        id: path,
        filename: path,
        loaded: true,
        exports,
      } as any;
    };
    inject("./config/db", connect);
    inject("./core/cache", {
      CACHE_KEYS: {},
      getCache: async () => null,
      setCache: async () => {},
      deleteCache: async () => {},
    });
    inject("@clerk/express", {
      verifyToken: async () => null,
      clerkClient: {},
    });
    inject("./middleware/featureGate", {
      requireFeature: () => (_req: any, _res: any, next: any) => next(),
    });
    inject("./core/websocket", {
      sendToUser() {},
      broadcastToUsers() {},
      broadcast() {},
      broadcastToDojo() {},
    });
    const service = require("./core/personalExternalCoach");
    const tasks = require("./core/externalCoachTasks");
    const daily = require("./core/externalDailyCoachTasks");
    const calls: string[] = [];
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use(require("cookie-parser")());
    app.use((req: any, res: any, next: any) => {
      const bearer = /^Bearer rgn_coach_/.test(req.get("Authorization") || "");
      if (
        bearer &&
        !req.path.startsWith("/api/agents/") &&
        !req.path.startsWith("/api/coach/tasks")
      )
        res.on("finish", () =>
          calls.push(
            `${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode}`,
          ),
        );
      next();
    });
    app.get("/api/agents/coach.md", (_req: any, res: any) =>
      res.sendFile(dir + "/public/agents/coach.md"),
    );
    app.use("/api", require("./routes/users"));
    app.use("/api", require("./routes/activities"));
    app.use("/api", require("./routes/coachDocs"));
    app.use("/api", require("./routes/coach"));
    app.use("/api", require("./routes/personalExternalCoach"));
    server = createServer(app);
    const origin = await listen(server);
    await service.ensureExternalCoachIndexes(db);

    const user = new ObjectId();
    await db.collection("users").insertOne({
      _id: user,
      display_name: "Synthetic lifter",
      timezone: "UTC",
      height: 180,
      sex: "male",
      date_of_birth: "1985-01-01",
      external_coach_agent: { enabled: true },
    });
    /** A canonical prescription (strategy nutrition plan). */
    const withTargets = () =>
      db.collection("strategies").insertOne({
        user_id: user,
        status: "active",
        created_at: new Date(),
        data: {
          nutrition_plan: {
            daily_calories: 3000,
            protein_g: 200,
            carbs_g: 350,
            fat_g: 80,
            water_ml: 4000,
          },
        },
      });
    /** Intake derived from the canonical food catalog. */
    const lunch = async () => {
      const food = new ObjectId();
      await db.collection("foods").insertOne({
        _id: food,
        name: "Synthetic rice bowl",
        calories: 700,
        protein: 45,
        carbs: 80,
        fat: 20,
      });
      await db.collection("activities").insertOne({
        _id: new ObjectId(),
        user_id: user,
        type: "meal",
        name: "Synthetic lunch",
        status: "complete",
        created_at: new Date(),
        completed_at: new Date(),
        due_at: new Date(),
        is_template: false,
        data: {
          foods: [
            {
              food_id: String(food),
              instance_id: String(new ObjectId()),
              name: "Synthetic rice bowl",
              quantity: 1,
              unit: "serving",
            },
          ],
        },
      });
    };
    /** A daily check-in: the real producer captures one daily_insight task. */
    const checkIn = () =>
      daily.recordStatus(db, String(user), {
        _id: new ObjectId(),
        user_id: user,
        type: "status_change",
        status: "complete",
        data: { status: "good" },
        created_at: new Date(),
        completed_at: new Date(),
        source: null,
      });
    const credential = async (rest: boolean) =>
      (
        await service.createCredential(
          String(user),
          { name: "Synthetic Pi worker" },
          rest ? { restUserAccess: true } : {},
        )
      ).token as string;
    const published = () =>
      db
        .collection("recommendations")
        .find({ kind: "daily", user_id: user })
        .toArray();
    const task = () =>
      db
        .collection("external_coach_tasks")
        .findOne({ kind: "daily_insight" }, { sort: { _id: -1 } });
    const occurrences = () =>
      db.collection("external_coach_task_actions").find({}).toArray();
    return {
      db,
      ObjectId,
      origin,
      user,
      calls,
      tasks,
      daily,
      withTargets,
      lunch,
      checkIn,
      credential,
      published,
      task,
      occurrences,
      /** Drops every task, publication, action and seeded fact. */
      async reset() {
        calls.length = 0;
        for (const name of [
          "external_coach_tasks",
          "external_coach_task_actions",
          "recommendations",
          "strategies",
          "foods",
          "activities",
        ])
          await db
            .collection(name)
            .deleteMany({})
            .catch(() => undefined);
      },
      async close() {
        if (server) await closeServer(server);
        await client?.close();
        await mongo.stop();
      },
    };
  } catch (error) {
    if (server) await closeServer(server);
    await client?.close();
    await mongo.stop();
    throw error;
  }
}
export type TaskPairedBackend = Awaited<ReturnType<typeof startTaskBackend>>;

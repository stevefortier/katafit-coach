import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { provisionArtifact } from "../src/sandbox/artifact.js";
import { answer, toolCall } from "./helpers/continuity.js";
import { PI_READY } from "./helpers/native-ready.js";
import {
  memoryBackendEnabled,
  startBackend,
  isExtraction,
  systemOf,
} from "./helpers/memory-backend.js";

const enabled =
  memoryBackendEnabled &&
  process.env.NATIVE_DOCKER_TEST === "1" &&
  !!process.env.NATIVE_TEST_IMAGE;
// Actual immutable network-none Pi, terminal/WebSocket, relay, host gateway,
// backend/Mongo. Inference alone is synthetic; no production service or data.
test(
  "actual Pi retains final delivered tool-grounded turn, recalls next turn, and destroys the same runtime after correction",
  { skip: !enabled, timeout: 240000 },
  async () => {
    const backend = await startBackend();
    const dir = await mkdtemp(tmpdir() + "/coach-memory-native-paired-");
    const bodies: any[] = [];
    const provider = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      bodies.push(body);
      res.setHeader("content-type", "text/event-stream");
      if (isExtraction(body))
        return res.end(
          answer(
            JSON.stringify({
              proposals: [
                {
                  kind: "preference",
                  text: "Operator prefers brief morning reports.",
                  confidence: 0.9,
                  importance: 0.9,
                },
              ],
            }),
          ),
        );
      const userIndex = body.messages.findLastIndex(
        (m: any) => m.role === "user",
      );
      const toolResults = body.messages
        .slice(userIndex + 1)
        .filter((m: any) => m.role === "tool");
      const second = JSON.stringify(body.messages[userIndex]).includes(
        "second synthetic",
      );
      if (!second && !toolResults.length)
        return res.end(
          toolCall("studio_operator_list_members", {}, "actual_memory_roster"),
        );
      res.end(
        answer(
          second ? "MEMORY_PAIRED_SECOND_DONE" : "MEMORY_PAIRED_FIRST_DONE",
        ),
      );
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    let app: Awaited<ReturnType<typeof admin>> | undefined,
      ws: WebSocket | undefined;
    let output = "";
    try {
      const { db, service, ObjectId } = backend;
      const chief = new ObjectId(),
        member = new ObjectId(),
        dojo = new ObjectId();
      await db.collection("users").insertMany([
        { _id: chief, display_name: "Synthetic chief", timezone: "UTC" },
        {
          _id: member,
          display_name: "Synthetic member",
          timezone: "UTC",
          privacy_settings: Object.fromEntries(
            ["workout", "meal", "media", "metric", "survey"].map((k) => [
              k,
              ["dojo_chief"],
            ]),
          ),
        },
      ]);
      await db.collection("dojos").insertOne({
        _id: dojo,
        chief_id: chief,
        external_coach_agent: { enabled: true },
      });
      await db.collection("dojo_members").insertMany([
        {
          user_id: chief,
          dojo_id: dojo,
          role: "chief",
          joined_at: new Date(0),
        },
        {
          user_id: member,
          dojo_id: dojo,
          role: "member",
          joined_at: new Date(0),
        },
      ]);
      const token = (
        await service.createCredential(String(chief), {
          scopes: [
            ...service.DEFAULT_SCOPES,
            "history:read",
            "userdata:read",
            "media:read",
          ],
        })
      ).token;
      const store = new Store(dir);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: backend.origin,
        token,
        apiKey: "synthetic-memory-provider",
        provider: {
          baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
          model: "approved-custom-model",
        },
      });
      await provisionArtifact(
        dir,
        process.env.COACH_PACKAGED_ROOT ?? process.cwd(),
        process.env.NATIVE_TEST_IMAGE!,
      );
      app = await admin(store, 0);
      const headers = {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: app.origin,
        "Content-Type": "application/json",
      };
      const ticket = (await (
        await fetch(app.origin + "/api/terminal/ticket", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).json()) as any;
      ws = new WebSocket(app.origin.replace("http:", "ws:") + ticket.path, {
        origin: app.origin,
      });
      let closed: number | undefined;
      const errors: string[] = [];
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "output") output = (output + m.data).slice(-150000);
        if (m.type === "error") errors.push(m.message);
      });
      ws.on("close", (code) => {
        closed = code;
      });
      await new Promise<void>((resolve, reject) => {
        ws!.once("open", resolve);
        ws!.once("error", reject);
      });
      ws.send(JSON.stringify({ ticket: ticket.ticket }));
      const waitFor = async (
        check: () => boolean | Promise<boolean>,
        name: string,
      ) => {
        const end = Date.now() + 60000;
        while (!(await check())) {
          if (Date.now() > end)
            throw new Error(
              "Missing " +
                name +
                ": " +
                errors.join(",") +
                "\n" +
                output.slice(-4000),
            );
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      await waitFor(() => output.includes(PI_READY), "Pi ready");
      await new Promise((resolve) => setTimeout(resolve, 150));
      ws.send(
        JSON.stringify({
          type: "input",
          data: "First synthetic turn: I prefer brief morning reports. Read the roster.\r",
        }),
      );
      await waitFor(
        () => output.includes("MEMORY_PAIRED_FIRST_DONE"),
        "first turn",
      );
      await waitFor(
        async () =>
          (await db
            .collection("coach_memories")
            .countDocuments({ status: "active" })) === 1,
        "retention after delivery acknowledgement",
      );
      assert.equal(
        bodies.filter(isExtraction).length,
        1,
        "intermediate tool-call response is not learned",
      );
      const extraction = bodies.find(isExtraction);
      assert.match(JSON.stringify(extraction), /Synthetic member/);
      assert.match(JSON.stringify(extraction), /MEMORY_PAIRED_FIRST_DONE/);
      const record = await db
        .collection("coach_memories")
        .findOne({ status: "active" });
      assert.equal(record.audience, "operator_private");
      const sessionsBefore = await db
        .collection("studio_operator_sessions")
        .find()
        .toArray();
      // Verify the actual runtime sandbox configuration by its task-owned name,
      // never requiring other users' native containers to be absent.
      const containerIds = execFileSync(
        "docker",
        [
          "ps",
          "--filter",
          "ancestor=" + process.env.NATIVE_TEST_IMAGE!,
          "--format",
          "{{.ID}}",
        ],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      assert.equal(containerIds.length, 1, "one task-owned candidate runtime");
      const inspected = JSON.parse(
        execFileSync("docker", ["inspect", containerIds[0]], {
          encoding: "utf8",
        }),
      )[0];
      assert.equal(inspected.Image, process.env.NATIVE_TEST_IMAGE);
      assert.equal(inspected.HostConfig.NetworkMode, "none");
      assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
      const containerNames = inspected.Name;
      ws.send(
        JSON.stringify({
          type: "input",
          data: "Perform the second synthetic turn: what reporting style should we use?\r",
        }),
      );
      await waitFor(
        () => output.includes("MEMORY_PAIRED_SECOND_DONE"),
        "next turn",
      );
      const secondBody = bodies.find(
        (body) =>
          !isExtraction(body) &&
          JSON.stringify(
            body.messages.findLast((m: any) => m.role === "user"),
          ).includes("second synthetic"),
      );
      assert.match(
        systemOf(secondBody),
        /Operator prefers brief morning reports/,
      );
      await waitFor(
        async () =>
          (await db
            .collection("coach_memory_captures")
            .countDocuments({ status: "committed" })) === 2,
        "second delivered turn retention settles before correction",
      );
      const auth = await service.authenticateCredential(token);
      await backend
        .require("./core/coachMemory")
        .execute(auth, "studio_memory_update", {
          memory_id: String(record._id),
          expected_revision: 1,
          text: "Operator now prefers detailed weekly reports.",
        });
      const count = bodies.filter((body) => !isExtraction(body)).length;
      ws.send(
        JSON.stringify({
          type: "input",
          data: "Perform a third synthetic turn.\r",
        }),
      );
      await waitFor(() => closed !== undefined, "revoked runtime closure");
      assert.equal(closed, 1008);
      await waitFor(
        () =>
          !execFileSync(
            "docker",
            [
              "ps",
              "-a",
              "--filter",
              "id=" + containerIds[0],
              "--format",
              "{{.ID}}",
            ],
            { encoding: "utf8" },
          ).trim(),
        "task-owned runtime removal",
      );
      assert.equal(bodies.filter((body) => !isExtraction(body)).length, count);
      const sessionsAfter = await db
        .collection("studio_operator_sessions")
        .find()
        .toArray();
      assert.equal(
        sessionsAfter.length,
        sessionsBefore.length,
        "no fresh session over retained Pi context",
      );
      assert.ok(
        sessionsAfter.every((session: any) => session.status !== "active"),
      );
      assert.equal(
        await db.collection("studio_operator_actions").countDocuments(),
        0,
      );
      if (process.env.COACH_MEMORY_EVIDENCE)
        await writeFile(
          process.env.COACH_MEMORY_EVIDENCE +
            "/native-paired-observations.json",
          JSON.stringify(
            {
              image: process.env.NATIVE_TEST_IMAGE,
              containerNames,
              providerRequests: count,
              extractionRequests: bodies.filter(isExtraction).length,
              sessions: sessionsAfter.map((s: any) => ({
                status: s.status,
                turn_generation: s.turn_generation,
              })),
              correctionCloseCode: closed,
              toolGrounding: true,
            },
            null,
            2,
          ),
        );
    } finally {
      ws?.terminate();
      await app?.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await backend.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

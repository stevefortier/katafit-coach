import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { Store } from "../src/config/store.js";
import { admin } from "../src/server/admin.js";
import { provisionArtifact } from "../src/sandbox/artifact.js";
import { PI_READY } from "./helpers/native-ready.js";
import { startAccountMemoryBackend } from "./helpers/account-memory-backend.js";
import { isExtraction, sseText, systems } from "./helpers/native-memory.js";

const enabled =
  process.env.NATIVE_DOCKER_TEST === "1" && !!process.env.NATIVE_TEST_IMAGE;
const PREFERENCE = "Prefers brief morning reports.";
const TUESDAYS = "Trains on Tuesdays.";
const proposal = (text: string) => ({
  kind: "preference",
  text,
  confidence: 0.9,
  importance: 0.8,
  goal_relevance: null,
  supersedes: [],
});

// Actual immutable network-none Pi image, terminal WebSocket, relay and host
// gateway over the contract-faithful account backend. Inference is synthetic.
test(
  "actual Pi learns only from delivered turns, recalls next turn, cannot resurrect after Forget, and a new runtime learns again",
  { skip: !enabled, timeout: 300000 },
  async () => {
    const backend = await startAccountMemoryBackend();
    const dir = await mkdtemp(tmpdir() + "/native-account-memory-docker-");
    const bodies: any[] = [];
    let extract: () => unknown = () => ({ proposals: [] });
    let holdExtraction = false;
    let extractionHeld = false;
    let releaseExtraction!: () => void;
    const extractionGate = new Promise<void>((r) => {
      releaseExtraction = r;
    });
    const provider = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      bodies.push(body);
      res.setHeader("content-type", "text/event-stream");
      if (isExtraction(body)) {
        if (holdExtraction) {
          extractionHeld = true;
          await extractionGate;
        }
        return res.end(sseText(JSON.stringify(extract())));
      }
      const human = JSON.stringify(
        body.messages.findLast((m: any) => m.role === "user"),
      );
      const marker = /ACCOUNT_(\w+)_TURN/.exec(human)?.[1] ?? "UNKNOWN";
      // Deterministic grounding: the reply may state the stored preference
      // only when the supplied recall actually contains it.
      const recall = String(body.messages[0]?.content ?? "");
      res.end(
        sseText(
          `ACCOUNT_${marker}_DONE ` +
            (recall.includes(PREFERENCE)
              ? `RECALLED: ${PREFERENCE}`
              : "MEMORY_MISSING"),
        ),
      );
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    let app: Awaited<ReturnType<typeof admin>> | undefined;
    let ws: WebSocket | undefined;
    let output = "";
    const notices: any[] = [];
    const errors: string[] = [];
    try {
      const store = new Store(dir);
      await store.init();
      await store.save({
        ...store.publicConfig(),
        origin: backend.origin,
        token: backend.token,
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
      const origin = app.origin;
      const headers = {
        Authorization: "Bearer " + store.secrets.admin,
        Origin: origin,
        "Content-Type": "application/json",
      };
      const waitFor = async (
        check: () => boolean | Promise<boolean>,
        name: string,
      ) => {
        const end = Date.now() + 60000;
        while (!(await check())) {
          if (Date.now() > end)
            throw new Error(
              `host logs: ${await fetch(origin + "/api/logs", { headers })
                .then((r) => r.text())
                .catch(String)}\n` +
                `Missing ${name}: ${errors.join(",")}\nbackend: ${backend.requests
                  .map((r) => r.method + " " + r.path)
                  .join(", ")}\nprovider: ${bodies.length} (${
                  bodies.filter(isExtraction).length
                } extraction)\nnotices: ${JSON.stringify(notices)}\n${output.slice(-4000)}`,
            );
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      const connect = async () => {
        const ticket = (await (
          await fetch(origin + "/api/terminal/ticket", {
            method: "POST",
            headers,
            body: "{}",
          })
        ).json()) as any;
        output = "";
        ws = new WebSocket(origin.replace("http:", "ws:") + ticket.path, {
          origin,
        });
        ws.on("message", (raw) => {
          const m = JSON.parse(raw.toString());
          if (m.type === "output") output = (output + m.data).slice(-150000);
          if (m.type === "error") errors.push(m.message);
          if (m.type === "memory-notice") notices.push(m.notice);
        });
        await new Promise<void>((resolve, reject) => {
          ws!.once("open", resolve);
          ws!.once("error", reject);
        });
        ws.send(JSON.stringify({ ticket: ticket.ticket }));
        await waitFor(() => output.includes(PI_READY), "Pi ready");
        await new Promise((resolve) => setTimeout(resolve, 150));
      };
      const say = async (text: string, marker: string) => {
        ws!.send(JSON.stringify({ type: "input", data: text + "\r" }));
        await waitFor(
          () => output.includes(`ACCOUNT_${marker}_DONE`),
          marker + " turn",
        );
        return bodies.find(
          (body) =>
            !isExtraction(body) &&
            JSON.stringify(
              body.messages.findLast((m: any) => m.role === "user"),
            ).includes(`ACCOUNT_${marker}_TURN`),
        );
      };
      const active = () =>
        [...backend.items.values()].filter((i) => i.status === "active");
      const runtimeContainers = () =>
        execFileSync(
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

      await connect();
      extract = () => ({ proposals: [proposal(PREFERENCE)] });
      await say(
        "ACCOUNT_FIRST_TURN: I prefer brief morning reports. Please remember that.",
        "FIRST",
      );
      await waitFor(
        () => active().some((i) => i.text === PREFERENCE),
        "commit after delivery",
      );
      await waitFor(
        () =>
          notices.some(
            (n) =>
              n.action === "remembered" &&
              n.items.some((i: any) => i.text === PREFERENCE),
          ),
        "commit-backed Remembered notice",
      );
      const extractions = bodies.filter(isExtraction);
      assert.equal(extractions.length, 1, "one delivered final response");
      assert.match(JSON.stringify(extractions[0]), /ACCOUNT_FIRST_DONE/);
      assert.equal(
        JSON.stringify(extractions[0]).includes('"tools"'),
        false,
        "extraction offers no tools",
      );
      const ids = runtimeContainers();
      assert.equal(ids.length, 1, "one task-owned candidate runtime");
      const inspected = JSON.parse(
        execFileSync("docker", ["inspect", ids[0]], { encoding: "utf8" }),
      )[0];
      assert.equal(inspected.Image, process.env.NATIVE_TEST_IMAGE);
      assert.equal(inspected.HostConfig.NetworkMode, "none");
      assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
      const container = execFileSync(
        "docker",
        ["exec", ids[0], "sh", "-c", "env; ls -a ~ 2>/dev/null"],
        { encoding: "utf8" },
      );
      assert.ok(
        !container.includes(backend.token),
        "Pi holds no account credential",
      );

      extract = () => ({ proposals: [] });
      const second = await say(
        "ACCOUNT_SECOND_TURN: what reporting style should we use?",
        "SECOND",
      );
      const leading = systems(second);
      assert.equal(leading.length, 1, "one leading persona system message");
      assert.equal(second.messages[0], leading[0]);
      assert.ok(String(leading[0].content).includes(PREFERENCE));
      await waitFor(
        () => output.includes(`ACCOUNT_SECOND_DONE RECALLED: ${PREFERENCE}`),
        "terminal final grounded in the recalled preference",
      );
      assert.ok(!output.includes("ACCOUNT_SECOND_DONE MEMORY_MISSING"));
      await waitFor(
        () =>
          backend.requests.filter((r) => /\/commit$/.test(r.path)).length >= 2,
        "second capture settles",
      );

      const saved = active().find((i) => i.text === PREFERENCE)!;
      const forgot = await fetch(
        origin + "/api/memories/" + saved.id + "/forget",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            idempotency_key: "ui:" + randomUUID(),
            expected_revision: saved.revision,
          }),
        },
      );
      assert.equal(forgot.status, 200, await forgot.clone().text());
      // Adversarial: the extractor re-proposes the forgotten text, and the
      // user's new words ground it; the earlier acquired text is still in Pi.
      extract = () => ({ proposals: [proposal(PREFERENCE)] });
      const third = await say(
        "ACCOUNT_THIRD_TURN: yes, I prefer brief morning reports.",
        "THIRD",
      );
      assert.ok(
        !String(systems(third)[0].content).includes(PREFERENCE),
        "fresh recall omits the forgotten memory",
      );
      await waitFor(
        () => output.includes("ACCOUNT_THIRD_DONE MEMORY_MISSING"),
        "terminal final states the forgotten memory is missing",
      );
      await waitFor(
        () => notices.some((n) => n.action === "learning-off"),
        "visible learning-off notice",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.ok(
        !active().some((i) => i.text === PREFERENCE),
        "forgotten text was not saved again",
      );

      // A new runtime has no earlier transcript, so learning resumes.
      assert.equal(
        (
          await fetch(origin + "/api/terminal/stop", {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
        200,
      );
      ws?.terminate();
      await waitFor(
        () => !runtimeContainers().includes(ids[0]),
        "old runtime removal",
      );
      await connect();
      extract = () => ({ proposals: [proposal(TUESDAYS)] });
      const fourth = await say(
        "ACCOUNT_FOURTH_TURN: I train on Tuesdays, please remember it.",
        "FOURTH",
      );
      assert.doesNotMatch(
        JSON.stringify(fourth),
        /ACCOUNT_(FIRST|SECOND|THIRD)_DONE|brief morning/,
      );
      await waitFor(
        () => active().some((i) => i.text === TUESDAYS),
        "new runtime learns again",
      );
      // Real Pi/relay delivery followed by host-owned opt-out while the
      // separate extractor HTTP response is genuinely in flight.
      holdExtraction = true;
      extract = () => ({
        proposals: [proposal("Prefers short morning workouts.")],
      });
      await say(
        "ACCOUNT_OPTOUT_TURN: I prefer short morning workouts.",
        "OPTOUT",
      );
      await waitFor(() => extractionHeld, "in-flight extraction");
      ws!.send(JSON.stringify({ type: "memory-capture", enabled: false }));
      await waitFor(
        () =>
          notices.some((n) =>
            /part of this chat was already committed/.test(n.note ?? ""),
          ),
        "confirmed durable discard",
      );
      const fence = backend.requests
        .filter((r) => r.path.endsWith("/discard"))
        .at(-1)!;
      assert.ok(fence.body.idempotency_key.startsWith("native:"));
      assert.ok(
        [...backend.captures.values()].some(
          (c) =>
            c.key === fence.body.idempotency_key &&
            c.status === "discarded" &&
            c.evidence === null,
        ),
      );
      releaseExtraction();
      holdExtraction = false;
      assert.equal(
        (
          await fetch(origin + "/api/terminal/stop", {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
        200,
      );
      ws?.terminate();
      await connect();
      await say("ACCOUNT_FRESH_TURN: hello", "FRESH");
      assert.ok(
        !active().some((i) => i.text === "Prefers short morning workouts."),
        "fresh actual Pi recovery cannot learn opted-out evidence",
      );
      assert.deepEqual(errors, []);
    } finally {
      releaseExtraction();
      ws?.terminate();
      await app?.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await backend.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

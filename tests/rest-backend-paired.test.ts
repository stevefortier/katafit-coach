import test from "node:test";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { PI_READY } from "./helpers/native-ready.js";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import sharp from "sharp";
import { fixture } from "./helpers/native.js";
import {
  startRelay,
  loadExtension,
  piTurn,
  imageParts,
} from "./helpers/native-relay.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import {
  startBackend,
  memoryBackendEnabled,
} from "./helpers/memory-backend.js";
import { restRequest } from "../src/katafit/restGet.js";

// Opt-in: actual backend authorization + Mongo + Coach transport; only object
// storage is synthetic. No production credentials, database or images.
test(
  "paired ordinary backend and Coach REST use one token, with four valid images and current backend permissions",
  { skip: !memoryBackendEnabled },
  async () => {
    process.env.JWT_SECRET = "synthetic-paired-rest-jwt";
    delete process.env.CLERK_SECRET_KEY;
    const b = await startBackend();
    try {
      const app = (b as any).app;
      assert.ok(app, "paired harness exposes real Express app");
      const jpeg = await sharp({
        create: { width: 8, height: 8, channels: 3, background: "red" },
      })
        .jpeg()
        .toBuffer();
      const media = b.require("./core/activities/media");
      media.getMediaFile = async () => ({
        fileStream: Readable.from([jpeg]),
        contentType: "image/jpeg",
      });
      app.use("/api", b.require("./routes/media"));
      app.use("/api", b.require("./routes/coachDocs"));
      app.use("/api/friends", b.require("./routes/friends"));
      const authenticate = b.require("./middleware/authenticateJWT");
      app.get("/api/new-paired-route", authenticate, (req: any, res: any) =>
        res.json({ user_id: req.user.user_id }),
      );
      const viewer = new b.ObjectId(),
        owner = new b.ObjectId(),
        stranger = new b.ObjectId(),
        dojo = new b.ObjectId(),
        activity = new b.ObjectId();
      const files = Array.from({ length: 4 }, () => ({
        _id: String(new b.ObjectId()),
        type: "image/jpeg",
        name: "synthetic.jpg",
      }));
      await b.db.collection("users").insertMany([
        { _id: viewer, username: "viewer" },
        {
          _id: owner,
          username: "owner",
          privacy_settings: { media: ["dojo"] },
        },
        { _id: stranger, username: "stranger" },
      ]);
      await b.db.collection("dojos").insertOne({ _id: dojo, chief_id: viewer });
      await b.db.collection("dojo_members").insertMany([
        { user_id: viewer, dojo_id: dojo, role: "chief" },
        { user_id: owner, dojo_id: dojo, role: "member" },
      ]);
      await b.db.collection("activities").insertOne({
        _id: activity,
        user_id: owner,
        type: "media",
        status: "complete",
        data: { files },
      });
      const human = b
        .require("jsonwebtoken")
        .sign(
          { user_id: String(viewer), username: "viewer" },
          process.env.JWT_SECRET,
        );
      const issued = await fetch(
        b.origin + "/api/coach/external-agent/credentials",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${human}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "Synthetic paired Coach",
            rest_user_access: true,
          }),
        },
      );
      assert.equal(issued.status, 201);
      const { token, credential } = (await issued.json()) as any;
      assert.equal(credential.rest_user_access, true);
      const read = (path: string) =>
        restRequest(
          b.origin,
          token,
          { method: "GET", path },
          new AbortController().signal,
          [token],
        );
      const novel = await read("/api/new-paired-route");
      assert.equal(JSON.parse(novel.content![0].text!).user_id, String(viewer));
      const index = JSON.parse((await read("/api/docs/coach")).content![0].text!);
      assert.equal(index.version, 1);
      const domain = index.domains.find((item: any) => item.id === "activities");
      assert.ok(domain?.path);
      const reference = JSON.parse((await read(domain.path)).content![0].text!);
      assert.equal(reference.id, "activities");
      assert.ok(reference.operations.some((operation: any) => operation.method === "POST" && operation.path === "/api/activities"));
      const detail = await read(`/api/friends/activity/${activity}`);
      assert.equal(
        JSON.parse(detail.content![0].text!).activity.data.files.length,
        4,
      );
      for (const file of files) {
        const path = `/api/media/${activity}/files/${file._id}`;
        const ordinary = await fetch(b.origin + path, {
          headers: { Authorization: `Bearer ${human}` },
        });
        assert.equal(ordinary.status, 200);
        const result = await read(path);
        const image = result.content!.find(
          (part: any) => part.type === "image",
        ) as any;
        assert.equal(image.mimeType, "image/jpeg");
        assert.ok(
          Buffer.from(image.data, "base64").equals(
            Buffer.from(await ordinary.arrayBuffer()),
          ),
        );
      }
      await b.db
        .collection("dojos")
        .updateOne({ _id: dojo }, { $set: { chief_id: owner } });
      await b.db
        .collection("dojo_members")
        .updateOne({ user_id: viewer }, { $set: { role: "member" } });
      assert.ok(
        (await read(`/api/friends/activity/${activity}`)).content,
        "ordinary member still sees dojo-shared data",
      );
      const path = `/api/media/${activity}/files/${files[0]._id}`;
      const backendCalls: string[] = [];
      b.server.prependListener("request", (req: any) =>
        backendCalls.push(req.url),
      );
      const f = await fixture((name, _value, body) => {
        if (name !== "provider") return;
        const acquired = body.messages.some((m: any) => m.role === "tool");
        if (acquired) assert.equal(imageParts(body).length, 1);
        const delta = acquired
          ? {
              content: body.messages.some(
                (m: any) =>
                  m.role === "user" &&
                  (typeof m.content === "string"
                    ? m.content
                    : Array.isArray(m.content)
                      ? m.content
                          .filter((p: any) => p.type === "text")
                          .map((p: any) => p.text)
                          .join(" ")
                      : ""
                  ).includes("again"),
              )
                ? "REST_IMAGE_REUSED"
                : "Verified synthetic JPEG reached the native provider.",
            }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: "call-katafit_rest_request",
                  type: "function",
                  function: {
                    name: "katafit_rest_request",
                    arguments: JSON.stringify({ method: "GET", path }),
                  },
                },
              ],
            };
        const again = body.messages.some(
          (m: any) =>
            m.role === "user" &&
            (typeof m.content === "string"
              ? m.content
              : Array.isArray(m.content)
                ? m.content
                    .filter((p: any) => p.type === "text")
                    .map((p: any) => p.text)
                    .join(" ")
                : ""
            ).includes("again"),
        );
        if (
          process.env.NATIVE_DOCKER_TEST === "1" &&
          acquired &&
          again &&
          !body.messages.some(
            (m: any) =>
              m.role === "tool" && m.tool_call_id === "call_send_to_operator",
          )
        ) {
          const text = body.messages
            .filter((m: any) => m.role === "tool")
            .map((m: any) => m.content)
            .join("\n");
          const observed = text.match(/"image_receipt"\s*:\s*("[^"\n]+")/);
          assert.ok(
            observed,
            "send selection must use an actually received image receipt",
          );
          Object.assign(delta, {
            content: undefined,
            tool_calls: [
              {
                index: 0,
                id: "call_send_to_operator",
                type: "function",
                function: {
                  name: "send_to_operator",
                  arguments: JSON.stringify({
                    image_receipt: JSON.parse(observed[1]),
                  }),
                },
              },
            ],
          });
        }
        return `data: ${JSON.stringify({ id: "paired", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "paired", choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`;
      });
      let gateway: Awaited<ReturnType<typeof openNativeGateway>> | undefined;
      let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
      let runtime: NativeRuntime | undefined;
      const published: any[] = [];
      try {
        await f.store.save({
          ...f.store.publicConfig(),
          origin: b.origin,
          token,
          provider: { ...f.store.publicConfig().provider, vision: true },
        });
        gateway = await openNativeGateway(f.store, undefined, {
          attachments: {
            read: async () => {
              throw new Error("No workspace read in this fixture");
            },
            publish: (item) => {
              published.push(item);
              return true;
            },
            connected: () => true,
          },
        });
        if (process.env.NATIVE_DOCKER_TEST === "1") {
          assert.ok(process.env.NATIVE_TEST_IMAGE);
          runtime = new NativeRuntime(process.env.NATIVE_TEST_IMAGE!);
          let output = "";
          runtime.onOutput = (chunk) => {
            output = (output + chunk).slice(-100000);
          };
          const wait = async (text: string) => {
            const until = Date.now() + 25000;
            while (!output.includes(text)) {
              if (Date.now() > until)
                throw new Error(
                  `Missing native marker ${text}: ${output.slice(-2500)}`,
                );
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          };
          await runtime.start(gateway);
          await runtime.attach();
          await wait(PI_READY);
          runtime.input("Read the synthetic shared image.\r");
          await wait("Verified synthetic JPEG reached the native provider.");
          await b.db
            .collection("users")
            .updateOne(
              { _id: owner },
              { $set: { "privacy_settings.media": [] } },
            );
          const before = backendCalls.length;
          runtime.input(
            "Describe that same acquired image again without fetching it.\r",
          );
          await wait("REST_IMAGE_REUSED");
          assert.equal(published.length, 1);
          assert.equal(published[0].byte_count, jpeg.length);
          assert.equal(
            backendCalls.length,
            before,
            "real isolated Pi reuses acquired pixels without another backend request",
          );
          assert.equal(backendCalls.filter((url) => url === path).length, 1);
          console.log(
            JSON.stringify({
              proof:
                "real Mongo/Express + isolated Docker Pi + conditional scripted provider",
              imageFetches: backendCalls.filter((url) => url === path).length,
              followupBackendCalls: backendCalls.length - before,
              operatorAttachments: published.length,
            }),
          );
        } else {
          relay = await startRelay(gateway);
          const extension = await loadExtension(relay);
          const messages: any[] = [
            {
              role: "user",
              content: "Read the synthetic shared image.",
              timestamp: Date.now(),
            },
          ];
          const selection = await piTurn(
            relay,
            "approved-custom-model",
            messages,
          );
          assert.equal(selection.stopReason, "toolUse");
          messages.push(selection);
          const result = await extension.call("katafit_rest_request", {
            method: "GET",
            path,
          });
          assert.ok(
            result.content.some((p: any) => p.type === "image"),
            "real backend pixels reached the shipped native extension",
          );
          const { normalizeToolResultImages } = await import(
            new URL(
              "./utils/tool-result-images.js",
              import.meta.resolve("@earendil-works/pi-coding-agent"),
            ).href
          );
          messages.push({
            role: "toolResult",
            toolCallId: "call-katafit_rest_request",
            toolName: "katafit_rest_request",
            content: await normalizeToolResultImages(result.content),
            isError: false,
            timestamp: Date.now(),
          });
          await b.db
            .collection("users")
            .updateOne(
              { _id: owner },
              { $set: { "privacy_settings.media": [] } },
            );
          const before = backendCalls.length;
          const answer = await piTurn(relay, "approved-custom-model", messages);
          assert.equal(answer.stopReason, "stop");
          assert.ok(
            JSON.stringify(answer.content).includes("Verified synthetic JPEG"),
          );
          assert.equal(
            backendCalls.length,
            before,
            "provider follow-up does not reauthorize or reread acquired data",
          );
          assert.deepEqual(
            backendCalls.filter((url) => url !== "/api/agents/coach/mcp"),
            [path],
            "optional initial legacy memory denial never gates ordinary nonchief REST; follow-up above makes zero requests",
          );
        }
      } finally {
        await runtime?.stop();
        await relay?.close();
        await gateway?.close();
        await f.close();
      }
      const denial = await read(`/api/media/${activity}/files/${files[0]._id}`);
      assert.ok(
        denial.restReadError &&
          [403, 404].includes(denial.restReadError.status),
      );
      assert.equal(
        JSON.parse(detail.content![0].text!).activity.data.files.length,
        4,
        "acquired data remains usable, without a permission callback",
      );
      await b.db
        .collection("external_coach_credentials")
        .updateOne(
          { _id: new b.ObjectId(credential.id) },
          { $set: { revoked_at: new Date() } },
        );
      assert.equal(
        (await read("/api/new-paired-route")).restReadError?.status,
        401,
      );
    } finally {
      await b.close();
    }
  },
);

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { Store } from "../src/config/store.js";
import { openNativeGateway } from "./helpers/legacy-gateway.js";
import {
  memoryBackendEnabled,
  startBackend,
  startProvider,
} from "./helpers/memory-backend.js";

for (const boundary of [
  "provider",
  "send",
  "image",
  "attachment",
  "activity_image",
  "activity_attachment",
  "archive_response",
  "archive_request",
])
  test(
    `paired native acquired memory remains internal after forget at ${boundary} boundary`,
    { skip: !memoryBackendEnabled, timeout: 60000 },
    async () => {
      const backend = await startBackend();
      const dir = await mkdtemp(tmpdir() + "/memory-native-authority-");
      const provider = await startProvider(() => "Synthetic response.");
      let gateway: Awaited<ReturnType<typeof openNativeGateway>> | undefined;
      try {
        const { db, service, ObjectId } = backend;
        const chief = new ObjectId(),
          member = new ObjectId(),
          dojo = new ObjectId(),
          activity = new ObjectId(),
          file = new ObjectId();
        await db.collection("users").insertMany([
          { _id: chief, display_name: "Chief" },
          {
            _id: member,
            display_name: "Synthetic image member",
            privacy_settings: { media: ["dojo_chief"] },
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
        await db.collection("activities").insertOne({
          _id: activity,
          user_id: member,
          dojo_id: dojo,
          type: "media",
          status: "complete",
          name: "Weekly progress check-in",
          created_at: new Date(Date.now() - 10000),
          data: { files: [{ _id: file, type: "image" }] },
        });
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
        const auth = await service.authenticateCredential(token),
          memory = backend.require("./core/coachMemory");
        const remembered = (
          await memory.execute(auth, "studio_memory_create", {
            idempotency_key: "retained",
            audience: "operator_private",
            kind: "fact",
            text: "Operator prefers brief reports.",
            pinned: true,
          })
        ).item;
        const store = new Store(dir);
        await store.init();
        await store.save({
          ...store.publicConfig(),
          origin: backend.origin,
          token,
          apiKey: "synthetic-model-key",
          provider: { baseUrl: provider.origin + "/v1", model: "synthetic" },
        });
        let terminated = 0,
          published = 0,
          imageReads = 0;
        const bytes = await sharp({
          create: { width: 3, height: 2, channels: 3, background: "#123456" },
        })
          .png()
          .toBuffer();
        // Only object-store bytes are synthetic. Source identities, original image
        // selection, authorization, policy, MCP transport and MIME checks are real.
        backend.require("./core/activities/media").getMediaFile = async () => {
          imageReads++;
          return {
            fileStream: Readable.from([bytes]),
            contentType: "image/png",
          };
        };
        gateway = await openNativeGateway(store, undefined, {
          ...(boundary.startsWith("archive_")
            ? {
                onExchange: async (capture: any) => {
                  if (
                    (boundary === "archive_request" && !capture.complete) ||
                    (boundary === "archive_response" && capture.complete)
                  )
                    await memory.execute(auth, "studio_memory_forget", {
                      memory_id: remembered.id,
                    });
                },
              }
            : {}),
          onTerminate: () => {
            terminated++;
          },
          attachments: {
            read: async () => {
              throw new Error("No workspace fixture");
            },
            publish: () => {
              published++;
              return true;
            },
          },
        });
        const tool = (name: string, args: any) =>
          gateway!.handle({ kind: "tool", name, args });
        const text = (result: any) => JSON.parse(result.content[0].text);
        const firstDisclosure = gateway.handle({
          kind: "provider",
          body: {
            model: "synthetic",
            messages: [
              {
                role: "user",
                content:
                  boundary === "provider"
                    ? [
                        { type: "text", text: "Use my reporting preferences." },
                        {
                          type: "image_url",
                          image_url: {
                            url: `data:image/png;base64,${bytes.toString("base64")}`,
                          },
                        },
                      ]
                    : "Use my reporting preferences.",
              },
            ],
          },
        });
        await firstDisclosure;
        if (boundary === "archive_request" || boundary === "archive_response") {
          assert.equal(provider.bodies.length, 1);
          assert.equal(terminated, 0);
        }
        if (boundary === "provider") {
          const sent = provider.bodies[0];
          assert.match(
            sent.messages[0].content,
            /Operator prefers brief reports/,
          );
          assert.deepEqual(sent.messages.at(-1).content[1], {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${bytes.toString("base64")}`,
            },
          });
        }
        const session = await db
          .collection("studio_operator_sessions")
          .findOne({ status: "active" });
        assert.equal(session.retained_memories[0].id, remembered.id);
        const checkins = text(
          await tool("studio_operator_list_dojo_checkins", {}),
        );
        const entry = checkins.items.find(
          (item: any) => item.display_name === "Synthetic image member",
        );
        assert.ok(entry.images[0].media_ref);
        let args: any = {
          member_ref: entry.member_ref,
          media_ref: entry.images[0].media_ref,
        };
        let imageTool = "studio_operator_read_dojo_checkin_image";
        if (boundary.startsWith("activity_")) {
          const listing = text(
            await tool("studio_operator_list_activities", {
              member_ref: entry.member_ref,
            }),
          );
          const activityRef = listing.items[0].activity_ref;
          const detail = text(
            await tool("studio_operator_read_activity", {
              member_ref: entry.member_ref,
              activity_ref: activityRef,
              section: "media_files",
            }),
          );
          args = {
            member_ref: entry.member_ref,
            activity_ref: activityRef,
            media_ref: detail.items[0].media_ref,
          };
          imageTool = "studio_operator_read_activity_image";
        }
        const image = text(await tool(imageTool, args));
        assert.equal(imageReads, 1);
        const attachment = text(
          await tool("send_to_operator", {
            image_receipt: image.image_receipt,
            caption: "Synthetic check-in",
          }),
        );
        assert.equal(published, 1);
        assert.deepEqual(
          (await gateway.readAttachment(attachment.attachment_id)).bytes,
          bytes,
        );
        if (!boundary.startsWith("archive_"))
          await memory.execute(auth, "studio_memory_forget", {
            memory_id: remembered.id,
          });
        const count = provider.bodies.length;
        if (boundary === "provider") {
          await gateway.handle({
            kind: "provider",
            body: {
              model: "synthetic",
              messages: [{ role: "user", content: "Continue." }],
            },
          });
          assert.equal(provider.bodies.length, count + 1);
        } else if (boundary === "send") {
          const sent = text(
            await tool("studio_operator_send_message", {
              member_ref: entry.member_ref,
              text: "Follow-up for the current recipient.",
            }),
          );
          assert.equal(sent.status, "delivered");
        } else if (boundary === "image" || boundary === "activity_image") {
          assert.ok(text(await tool(imageTool, args)).image_receipt);
          assert.equal(imageReads, 2);
        } else {
          assert.deepEqual(
            (await gateway.readAttachment(attachment.attachment_id)).bytes,
            bytes,
          );
        }
        if (boundary !== "provider")
          assert.equal(provider.bodies.length, count);
        if (boundary !== "image" && boundary !== "activity_image")
          assert.equal(imageReads, 1);
        assert.equal(published, 1);
        assert.equal(terminated, 0);
        assert.equal(gateway.attachments().length, 1);
        assert.equal(
          await db.collection("studio_operator_actions").countDocuments(),
          boundary === "send" ? 1 : 0,
        );
        assert.equal(
          await db.collection("studio_operator_sessions").countDocuments(),
          1,
        );
      } finally {
        await gateway?.close();
        await provider.close();
        await backend.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

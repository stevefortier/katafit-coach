import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Store } from "../src/config/store.js";
import { openNativeGateway } from "./helpers/legacy-gateway.js";
import { fixture } from "./operator-checkins.test.js";

const LIST = "studio_operator_list_dojo_checkins";
const IMAGE = "studio_operator_read_dojo_checkin_image";
test("image catalog includes host constraints even with a backend description", async () => {
  const f = await setup({
    imageDescription: "Backend-authorized original image.",
  });
  try {
    const catalog = await f.gateway.handle({ kind: "catalog" });
    const description = catalog.tools.find(
      (t: any) => t.name === IMAGE,
    ).description;
    assert.match(description, /Backend-authorized original image/);
    assert.match(description, /studio_operator_list_dojo_checkins/);
    assert.match(description, /matching member_ref and media_ref/);
    assert.match(description, /4 images.*16 MiB.*8 MiB/);
    assert.match(description, /sequentially, one call at a time/);
    assert.doesNotMatch(description, /selected from the authorized roster/);
  } finally {
    await f.close();
  }
});

test("rejected aggregate image bytes do not consume delivered-image capacity", async () => {
  const f = await setup({ imageSize: 6 * 1024 * 1024 });
  try {
    await f.gateway.handle({ kind: "tool", name: LIST, args: {} });
    for (let i = 0; i < 2; i++)
      await f.gateway.handle({
        kind: "tool",
        name: IMAGE,
        args: { member_ref: "member-photo", media_ref: "media-photo" },
      });
    const result = await f.gateway.handle({
      kind: "tool",
      name: IMAGE,
      args: { member_ref: "member-photo", media_ref: "media-photo-2" },
    });
    assert.deepEqual(result, {
      imageReadError: {
        code: "IMAGE_BUDGET_EXHAUSTED",
        remainingImages: 2,
        remainingBytes: 4 * 1024 * 1024,
      },
    });
    assert.equal(f.backend.calls.filter((n) => n === IMAGE).length, 3);
  } finally {
    await f.close();
  }
});

async function setup(options = {}, token = "synthetic-token") {
  const backend = await fixture({ imageCount: 5, ...options });
  const dir = await mkdtemp(tmpdir() + "/image-contract-");
  const store = new Store(dir);
  try {
    await store.init();
    await store.save({
      ...store.publicConfig(),
      origin: backend.origin,
      token,
    });
    const gateway = await openNativeGateway(store);
    return {
      backend,
      gateway,
      async close() {
        await gateway.close();
        await backend.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await backend.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

test("image result secret screening is a result rejection and does not consume delivery capacity", async () => {
  const f = await setup({}, "image/png");
  try {
    await f.gateway.handle({ kind: "tool", name: LIST, args: {} });
    assert.deepEqual(
      await f.gateway.handle({
        kind: "tool",
        name: IMAGE,
        args: { member_ref: "member-photo", media_ref: "media-photo" },
      }),
      {
        imageReadError: {
          code: "IMAGE_RESULT_REJECTED",
          remainingImages: 4,
          remainingBytes: 16777216,
        },
      },
    );
  } finally {
    await f.close();
  }
});

for (const cancellation of ["request", "gateway"])
  test(`pending image ${cancellation} cancellation never becomes a recoverable imageReadError`, async () => {
    let release!: () => void;
    const imageGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await setup({ imageGate });
    const abort = new AbortController();
    let pending: Promise<any> | undefined;
    try {
      await f.gateway.handle({ kind: "tool", name: LIST, args: {} });
      pending = f.gateway.handle(
        {
          kind: "tool",
          name: IMAGE,
          args: { member_ref: "member-photo", media_ref: "media-photo" },
        },
        abort.signal,
      );
      const end = Date.now() + 3000;
      while (!f.backend.calls.includes(IMAGE)) {
        assert.ok(Date.now() < end);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const rejected = assert.rejects(
        pending,
        cancellation === "request"
          ? /NATIVE_CANCELLED/
          : /CANCELLED|NATIVE_SESSION_REVOKED/,
      );
      if (cancellation === "request") abort.abort();
      else await f.gateway.close();
      await rejected;
    } finally {
      release();
      await pending?.catch(() => {});
      await f.close();
    }
  });

test("parallel native image admission reports busy without dispatch or capacity consumption", async () => {
  let release!: () => void;
  const imageGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await setup({ imageGate });
  let pending: Promise<any> | undefined;
  try {
    await f.gateway.handle({ kind: "tool", name: LIST, args: {} });
    pending = f.gateway.handle({
      kind: "tool",
      name: IMAGE,
      args: { member_ref: "member-photo", media_ref: "media-photo" },
    });
    const end = Date.now() + 3000;
    while (!f.backend.calls.includes(IMAGE)) {
      assert.ok(Date.now() < end, "first image reached backend");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (let i = 1; i < 4; i++) {
      assert.deepEqual(
        await f.gateway.handle({
          kind: "tool",
          name: IMAGE,
          args: { member_ref: "member-photo", media_ref: `media-photo-${i}` },
        }),
        {
          imageReadError: { code: "IMAGE_READ_BUSY" },
        },
      );
    }
    assert.equal(f.backend.calls.filter((n) => n === IMAGE).length, 1);
    await assert.rejects(
      f.gateway.handle({
        kind: "tool",
        name: "studio_operator_send_message",
        args: {},
      }),
      /NATIVE_REQUEST_BUSY/,
    );
    release();
    const delivered = await pending;
    assert.deepEqual(JSON.parse(delivered.content[0].text).remaining_capacity, {
      images: 3,
      bytes: 16777216 - f.backend.bytes.length,
    });
    const next = await f.gateway.handle({
      kind: "tool",
      name: IMAGE,
      args: { member_ref: "member-photo", media_ref: "media-photo-1" },
    });
    assert.equal(next.content[1].type, "image");
    assert.equal(f.backend.calls.filter((n) => n === IMAGE).length, 2);
  } finally {
    release();
    await pending?.catch(() => {});
    await f.close();
  }
});

test("native five-photo inventory returns exact remaining capacity and blocks fifth dispatch", async () => {
  const f = await setup();
  try {
    await f.gateway.handle({ kind: "tool", name: LIST, args: {} });
    for (let i = 0; i < 4; i++) {
      const result = await f.gateway.handle({
        kind: "tool",
        name: IMAGE,
        args: {
          member_ref: "member-photo",
          media_ref: i ? `media-photo-${i}` : "media-photo",
        },
      });
      assert.equal(result.content[1].type, "image");
      assert.deepEqual(JSON.parse(result.content[0].text).remaining_capacity, {
        images: 3 - i,
        bytes: 16 * 1024 * 1024 - (i + 1) * f.backend.bytes.length,
      });
    }
    const result = await f.gateway.handle({
      kind: "tool",
      name: IMAGE,
      args: {
        member_ref: "member-photo",
        media_ref: "media-photo-4",
      },
    });
    assert.deepEqual(result, {
      imageReadError: {
        code: "IMAGE_BUDGET_EXHAUSTED",
        remainingImages: 0,
        remainingBytes: 16 * 1024 * 1024 - 4 * f.backend.bytes.length,
      },
    });
    assert.equal(f.backend.calls.filter((n) => n === IMAGE).length, 4);
  } finally {
    await f.close();
  }
});

test("native image failures distinguish prerequisites, invalid arguments, backend refusal and rejected integrity", async () => {
  for (const [options, args, listed, code, dispatches] of [
    [
      {},
      { member_ref: "member-photo", media_ref: "media-photo" },
      false,
      "CHECKIN_LIST_REQUIRED",
      0,
    ],
    [
      {},
      { member_ref: "member-photo", media_ref: "activity-detail-ref" },
      true,
      "CHECKIN_LIST_REQUIRED",
      0,
    ],
    [
      {},
      { member_ref: "wrong-member", media_ref: "media-photo" },
      true,
      "CHECKIN_LIST_REQUIRED",
      0,
    ],
    [{}, { member_ref: "member-photo" }, true, "IMAGE_ARGUMENTS_REJECTED", 0],
    [
      {},
      {
        member_ref: "member-photo",
        media_ref: "media-photo",
        session_id: "injected-private-ref",
      },
      true,
      "IMAGE_ARGUMENTS_REJECTED",
      0,
    ],
    [
      { revoke: true },
      { member_ref: "member-photo", media_ref: "media-photo" },
      true,
      "IMAGE_BACKEND_FAILED",
      1,
    ],
    [
      { malformed: true },
      { member_ref: "member-photo", media_ref: "media-photo" },
      true,
      "IMAGE_RESULT_REJECTED",
      1,
    ],
  ] as const) {
    const f = await setup(options);
    try {
      if (listed)
        await f.gateway.handle({ kind: "tool", name: LIST, args: {} });
      const result = await f.gateway.handle({
        kind: "tool",
        name: IMAGE,
        args,
      });
      assert.deepEqual(result, {
        imageReadError: {
          code,
          remainingImages: 4,
          remainingBytes: 16 * 1024 * 1024,
        },
      });
      assert.equal(
        f.backend.calls.filter((n) => n === IMAGE).length,
        dispatches,
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /member-photo|media-photo|private-ref|synthetic-token/,
      );
    } finally {
      await f.close();
    }
  }
});

test("backend read limit is not mislabeled as permissions or file availability", async () => {
  const f = await setup({ imageToolCode: "READ_LIMIT" });
  try {
    await f.gateway.handle({ kind: "tool", name: LIST, args: {} });
    const result = await f.gateway.handle({
      kind: "tool",
      name: IMAGE,
      args: { member_ref: "member-photo", media_ref: "media-photo" },
    });
    assert.deepEqual(result, {
      imageReadError: {
        code: "IMAGE_READ_LIMIT",
        remainingImages: 4,
        remainingBytes: 16 * 1024 * 1024,
      },
    });
    assert.equal(f.backend.calls.filter((name) => name === IMAGE).length, 1);
    assert.doesNotMatch(
      JSON.stringify(result),
      /member-photo|media-photo|Synthetic/,
    );
  } finally {
    await f.close();
  }
});

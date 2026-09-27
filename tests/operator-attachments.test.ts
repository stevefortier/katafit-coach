import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  ATTACHMENT_TOOL,
  AttachmentFailure,
  OperatorAttachments,
  attachmentTool,
  classifyAttachment,
  contentDisposition,
  sanitizeCaption,
  sanitizeFilename,
  workspacePathParts,
  workspaceReadScript,
} from "../src/sandbox/attachments.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AttachmentFailure, String(error));
    return error.code;
  }
  assert.fail("expected AttachmentFailure");
};
const png = () =>
  sharp({
    create: { width: 4, height: 3, channels: 3, background: "#224466" },
  })
    .png()
    .toBuffer();

test("send_to_operator schema admits only a receipt or workspace file plus safe labels", () => {
  assert.equal(ATTACHMENT_TOOL, "send_to_operator");
  const tool = attachmentTool();
  assert.equal(tool.name, "send_to_operator");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
    "caption",
    "filename",
    "image_receipt",
    "workspace_path",
  ]);
  assert.match(tool.description, /not confirm/i);
  assert.match(tool.description, /\/workspace/);
  assert.doesNotMatch(JSON.stringify(tool), /url|media_ref|member_ref/i);
});

test("workspace paths are relative component lists; traversal, absolute host paths and control bytes are refused", () => {
  assert.deepEqual(workspacePathParts("report.csv"), ["report.csv"]);
  assert.deepEqual(workspacePathParts("/workspace/out/chart.png"), [
    "out",
    "chart.png",
  ]);
  assert.deepEqual(workspacePathParts("./out/a b.txt"), ["out", "a b.txt"]);
  for (const bad of [
    "",
    "/",
    "/workspace",
    "/workspace/",
    "/etc/hostname",
    "/home/node/.pi/agent/models.json",
    "/tmp/native-config.json",
    "../escape",
    "out/../../escape",
    "out/./..",
    "a//b",
    "a\u0000b",
    "a\nb",
    "x".repeat(129),
    Array.from({ length: 9 }, () => "d").join("/"),
    "d/".repeat(130) + "f",
    42,
    null,
    { path: "a" },
  ])
    assert.equal(
      code(() => workspacePathParts(bad as any)),
      "ATTACHMENT_PATH_REJECTED",
      JSON.stringify(bad),
    );
});

test("filenames and captions are sanitized, bounded and never carry markup, bidi or path semantics", () => {
  assert.equal(sanitizeFilename("report.csv", "fallback"), "report.csv");
  assert.equal(
    sanitizeFilename("../../etc/pass\u202Ewd.exe", "x"),
    "pass_wd.exe",
  );
  assert.equal(sanitizeFilename("  ..hidden  ", "x"), "hidden");
  assert.equal(
    sanitizeFilename("<img onerror=x>.html", "x"),
    "_img onerror_x_.html",
  );
  assert.equal(sanitizeFilename("C:\\Users\\x\\notes.txt", "x"), "notes.txt");
  assert.equal(sanitizeFilename("", "attachment.bin"), "attachment.bin");
  assert.equal(sanitizeFilename(undefined, "attachment.bin"), "attachment.bin");
  assert.equal(sanitizeFilename("a\u0000b\u0007c", "x"), "abc");
  const long = sanitizeFilename("n".repeat(300) + ".txt", "x");
  assert.ok(long.length <= 100 && long.endsWith(".txt"), long);
  assert.equal(
    code(() => sanitizeFilename(7 as any, "x")),
    "ATTACHMENT_ARGUMENTS_REJECTED",
  );
  assert.equal(sanitizeCaption(undefined), "");
  assert.equal(
    sanitizeCaption("Line one\u202E\r\n\n\n\nLine\u0007 two\u200B"),
    "Line one\n\nLine two",
  );
  assert.equal(sanitizeCaption("x".repeat(900)).length, 500);
  assert.equal(
    code(() => sanitizeCaption({} as any)),
    "ATTACHMENT_ARGUMENTS_REJECTED",
  );
  assert.match(
    contentDisposition('résumé "q".png'),
    /^attachment; filename="r_sum_ _q_.png"; filename\*=UTF-8''r%C3%A9sum%C3%A9%20_q_.png$/,
  );
});

test("only decoded raster images preview; SVG, HTML, spoofed and corrupt images are downloads", async () => {
  const image = await png();
  assert.deepEqual(await classifyAttachment(image, "chart.png"), {
    mime_type: "image/png",
    preview: "image",
    filename: "chart.png",
  });
  // Extension is forced to match sniffed bytes.
  assert.deepEqual(await classifyAttachment(image, "chart.jpg"), {
    mime_type: "image/png",
    preview: "image",
    filename: "chart.jpg.png",
  });
  const jpeg = await sharp(image).jpeg().toBuffer();
  assert.equal((await classifyAttachment(jpeg, "p.jpeg")).preview, "image");
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  for (const [bytes, name] of [
    [svg, "x.svg"],
    [svg, "x.png"],
    [Buffer.from("<!doctype html><script>alert(1)</script>"), "x.html"],
    [Buffer.from("<html><body>hi"), "x.png"],
    [image.subarray(0, 40), "truncated.png"],
    [Buffer.concat([image.subarray(0, 8), Buffer.alloc(64, 1)]), "fake.png"],
    [Buffer.from("MZ\x90\x00"), "tool.exe"],
    [Buffer.from("a,b\n1,2\n"), "data.csv"],
  ] as const) {
    const result = await classifyAttachment(bytes, name);
    assert.equal(result.preview, "download", name);
    assert.equal(result.mime_type, "application/octet-stream", name);
  }
});

test("per-file, count and session byte budgets; duplicate sends reuse one attachment; clear erases", async () => {
  const store = new OperatorAttachments({
    maxFileBytes: 10,
    maxCount: 2,
    maxBytes: 16,
  });
  const add = (bytes: string, filename = "a.txt", caption = "") =>
    store.add({
      source: "workspace",
      bytes: Buffer.from(bytes),
      filename,
      caption,
      mime_type: "application/octet-stream",
      preview: "download",
    });
  const first = add("0123456789");
  assert.match(first.item.id, /^at_[a-f0-9]{32}$/);
  assert.equal(first.duplicate, false);
  assert.equal(
    first.item.sha256,
    createHash("sha256").update("0123456789").digest("hex"),
  );
  assert.equal(add("0123456789").item.id, first.item.id);
  assert.equal(add("0123456789").duplicate, true);
  assert.equal(
    code(() => add("01234567890")),
    "ATTACHMENT_TOO_LARGE",
  );
  assert.equal(
    code(() => add("0123456789", "b.txt")),
    "ATTACHMENT_BUDGET_EXHAUSTED",
    "session bytes",
  );
  add("abc", "b.txt");
  assert.equal(
    code(() => add("x", "c.txt")),
    "ATTACHMENT_BUDGET_EXHAUSTED",
    "count",
  );
  assert.deepEqual(store.remaining(), { attachments: 0, bytes: 3 });
  assert.equal(store.list().length, 2);
  assert.equal(store.get(first.item.id)?.bytes.toString(), "0123456789");
  assert.equal(JSON.stringify(store.list()).includes("0123456789"), false);
  store.clear();
  assert.equal(store.list().length, 0);
  assert.equal(store.get(first.item.id), undefined);
  assert.equal(
    code(() => add("z")),
    "ATTACHMENT_UNAVAILABLE",
    "a cleared store never accepts again",
  );
});

test("workspace read script walks with O_NOFOLLOW from /workspace and accepts only regular files", () => {
  const script = workspaceReadScript();
  assert.match(script, /O_NOFOLLOW/);
  assert.match(script, /O_DIRECTORY/);
  assert.match(script, /O_NONBLOCK/);
  assert.match(script, /\/proc\/self\/fd\//);
  assert.match(script, /"\/workspace"/);
  assert.match(script, /isFile\(\)/);
  assert.doesNotMatch(script, /realpath|readFileSync\(/);
});

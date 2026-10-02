import test from "node:test";
import assert from "node:assert/strict";
import { stockSkills } from "../src/config/skills.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import { fixture } from "./helpers/native.js";
import {
  openNativeGateway,
  nativeProviderEnvelope,
} from "../src/sandbox/gateway.js";

test("native catalog serializes efficient fetching guidance while pinned Pi loads the body on demand", async () => {
  const f = await fixture();
  const gateway = await openNativeGateway(f.store);
  const dir = await mkdtemp(tmpdir() + "/api-fetching-native-");
  try {
    const catalog = JSON.parse(
      JSON.stringify(await gateway.handle({ kind: "catalog" })),
    );
    const tool = catalog.tools.find(
      (entry: any) => entry.name === "katafit_rest_request",
    );
    assert.match(tool.description, /type=media&limit=20&pagination=cursor/);
    assert.match(tool.description, /nextCursor/);
    assert.match(tool.description, /cursor=.*nextCursor/);
    assert.match(tool.description, /types=media,metric/);
    assert.match(tool.description, /startDate.*endDate.*beforeDate/);
    assert.match(tool.description, /sequential.*pages.*details.*images/i);
    assert.match(tool.description, /reuse.*acquired.*bytes/i);
    assert.match(tool.description, /previews/);
    assert.match(catalog.skills[0].body, /type=media&limit=20/);
    assert.match(catalog.skills[0].body, /same type and date filters/);
    assert.match(
      catalog.skills[0].body,
      /This native Pi session is Operator scope/,
    );
    const skillDir = dir + "/katafit-api";
    await mkdir(skillDir);
    await writeFile(
      skillDir + "/SKILL.md",
      `---\nname: katafit-api\ndescription: ${JSON.stringify(catalog.skills[0].description)}\n---\n\n${catalog.skills[0].body}`,
    );
    const loaded = loadSkillsFromDir({ dir, source: "user" });
    assert.deepEqual(loaded.diagnostics, []);
    const prompt = formatSkillsForPrompt(loaded.skills, "read");
    assert.match(prompt, /katafit-api/);
    assert.ok(
      !prompt.includes("type=media&limit=20"),
      "body remains on-demand, not always injected",
    );
    const wire = JSON.parse(
      nativeProviderEnvelope({
        messages: [
          { role: "system", content: catalog.prompt + prompt },
          {
            role: "tool",
            tool_call_id: "read-skill",
            content: catalog.skills[0].body,
          },
        ],
        tools: [{ type: "function", function: tool }],
      }),
    );
    assert.match(wire.tools[0].function.description, /type=media/);
    assert.match(wire.messages[1].content, /types=media,metric/);
    assert.ok(!JSON.stringify(wire).includes(f.store.secrets.token));
    assert.equal(
      f.calls.length,
      0,
      "catalog/guidance requires no backend read or permission refresh",
    );
  } finally {
    await gateway.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unified API guidance narrows shared-feed acquisition to requested dates and dimensions", () => {
  const text = stockSkills[0].instructions;
  assert.match(text, /\/api\/friends\/feed\/dojo\?type=media&limit=20/);
  assert.match(text, /\/api\/friends\/feed\/dojo\?types=media,metric&limit=20/);
  assert.match(text, /server-side.*before.*detail/i);
  assert.match(text, /startDate.*endDate.*beforeDate/);
  assert.match(text, /no documented.*member.*filter/i);
  assert.match(text, /user_id.*locally/i);
  assert.match(text, /not.*media-only.*workout.*meal/i);
  assert.match(text, /same.*type.*date.*filters/i);
  assert.match(text, /missing.*repeated.*nonadvancing.*cursor/i);
  assert.match(text, /empty.*page.*advancing.*cursor/i);
  assert.match(text, /type=media&limit=20&pagination=cursor/);
  assert.match(text, /types=media,metric&limit=20&pagination=cursor/);
  assert.match(text, /nextCursor.*opaque/);
  assert.match(text, /pagination=cursor&cursor=/);
  assert.match(text, /same.*limit/);
  assert.match(text, /Do not switch.*beforeDate/);
  assert.match(text, /older.*beforeDate.*timestamp.*ties/i);
  assert.match(text, /oldestDate.*null/i);
  assert.match(text, /sequential.*pages.*details.*image/i);
  assert.match(text, /only.*details.*needed/i);
  assert.match(text, /Feed files are previews only/);
  assert.match(text, /Reuse images already acquired/);
  assert.match(text, /Do not re-fetch images merely to send them/);
});

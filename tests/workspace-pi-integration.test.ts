import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CombinedAutocompleteProvider, Editor } from "@earendil-works/pi-tui";
import { InMemoryFs } from "just-bash";
// @ts-expect-error shipped workspace module
import { patchWorkspacePi } from "../workspace/pi-startup.mjs";
// @ts-expect-error shipped workspace module
import { workspaceAutocomplete } from "../workspace/autocomplete.mjs";
// @ts-expect-error shipped workspace module
import { workspaceShell } from "../workspace/tools.mjs";

test("workspace bootstrap patch is pinned, narrow and leaves upstream diagnostics intact", () => {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const original = readFileSync(
    new URL("./bundle/chunks/chunk-CMRUVXTE.js", entry),
    "utf8",
  );
  const patched = patchWorkspacePi(original);
  assert.equal(
    patched.includes(
      'ensureTool("fd",status=>this.showManagedToolStatus(status))',
    ),
    false,
  );
  assert.equal(
    patched.includes("Offline mode enabled, skipping download."),
    true,
  );
  assert.equal(
    patched.includes("async function ensureTool(tool,onStatus)"),
    true,
  );
  assert.equal(
    patched.replace(
      "await Promise.resolve([null])",
      'await Promise.all([ensureTool("fd",status=>this.showManagedToolStatus(status)),ensureTool("rg",status=>this.showManagedToolStatus(status))])',
    ),
    original,
  );
  assert.throws(
    () => patchWorkspacePi(original + "\n"),
    /WORKSPACE_PI_STARTUP_PATCH_MISMATCH/,
  );
  assert.throws(
    () => patchWorkspacePi(patched),
    /WORKSPACE_PI_STARTUP_PATCH_MISMATCH/,
  );
  const docker = readFileSync(
    new URL("../sandbox/launch.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(docker, /pi-startup|autocomplete\.mjs/);
});

test("actual Pi editor Tab completes virtual paths and slash arguments without host lookup", async (t) => {
  const cases = [
    ["worksp", "workspace/"],
    ['"workspace/autoc', '"workspace/autocomplete.mjs"'],
    ["./workspace/autoc", "./workspace/autocomplete.mjs"],
    ["/model m", "/model mini"],
    ["@workspace/autoc", "@workspace/autocomplete.mjs "],
    ["/model @workspace/autoc", "/model @workspace/autocomplete.mjs "],
    ["@../secret", "@../secret"],
    ['"../secret', '"../secret'],
    ["/model @/etc/pass", "/model @/etc/pass"],
    ["@planted", "@planted"],
  ];
  for (const [input, expected] of cases) {
    await t.test(JSON.stringify(input), async () => {
      // Real virtual FS, entirely memory-backed: no host fixture or file lookup.
      const fs = new InMemoryFs();
      await fs.mkdir("/workspace/workspace", { recursive: true });
      await fs.mkdir("/etc", { recursive: true });
      await fs.writeFile("/workspace/workspace/autocomplete.mjs", "virtual");
      await fs.writeFile("/secret.txt", "outside-root");
      await fs.writeFile("/etc/passwd", "outside-root");
      await fs.symlink("/secret.txt", "/workspace/planted.txt");
      const lookups: string[] = [];
      const virtualFs = new Proxy(fs, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key === "readdir" || key === "lstat") {
            return async (path: string) => {
              lookups.push(path);
              assert.ok(
                path === "/workspace" || path.startsWith("/workspace/"),
              );
              return value.call(target, path);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const current = new CombinedAutocompleteProvider(
        [
          {
            name: "model",
            getArgumentCompletions: (prefix) => {
              assert.equal(prefix, "m");
              return [{ label: "mini", value: "mini" }];
            },
          },
        ],
        "/unused-host-path",
        null,
      );
      const slashCalls: string[] = [];
      const upstreamSuggestions = current.getSuggestions.bind(current);
      current.getSuggestions = async (lines, row, col, options) => {
        const text = lines[row].slice(0, col);
        // Fail before upstream can enter its host-backed file/attachment path.
        assert.equal(text, "/model m");
        assert.equal(options.force, false);
        slashCalls.push(text);
        return upstreamSuggestions(lines, row, col, options);
      };
      const provider = workspaceAutocomplete(current, virtualFs);
      const identity = (text: string) => text;
      const editor = new Editor({ requestRender() {} } as any, {
        borderColor: identity,
        selectList: {
          selectedPrefix: identity,
          selectedText: identity,
          description: identity,
          scrollInfo: identity,
          noMatch: identity,
        },
      });
      editor.setAutocompleteProvider(provider);
      try {
        assert.equal(
          await provider.getSuggestions(["worksp"], 0, 6, {
            force: false,
            signal: new AbortController().signal,
          }),
          null,
          "nonforced ordinary prose remains silent",
        );
        assert.equal(
          lookups.length,
          0,
          "prose does not even inspect the virtual FS",
        );
        editor.setText(input);
        editor.handleInput("\t");
        // InMemoryFs settles through microtasks; drain them via the next loop turn.
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(editor.getText(), expected);
        assert.deepEqual(slashCalls, input === "/model m" ? [input] : []);
        if (input.includes("..") || input.includes("/etc/"))
          assert.deepEqual(
            lookups,
            [],
            "escape refused before filesystem lookup",
          );
      } finally {
        editor.setText(""); // Cancels any outstanding autocomplete request/timer.
      }
    });
  }
});

test("workspace file completion handles real directories, quoted paths, substring attachment lookup and isolation", async () => {
  const base = mkdtempSync(join(tmpdir(), "ws-completion-"));
  const workspace = join(base, "workspace");
  mkdirSync(join(workspace, "nested"), { recursive: true });
  writeFileSync(join(workspace, "nested", "space name.txt"), "needle");
  writeFileSync(join(base, "secret.txt"), "HOST-SECRET");
  try {
    symlinkSync(join(base, "secret.txt"), join(workspace, "planted.txt"));
  } catch {}
  try {
    const { fs } = workspaceShell(workspace);
    const slashCalls: any[] = [];
    const current = {
      async getSuggestions(...args: any[]) {
        slashCalls.push(args);
        return { prefix: "/m", items: [{ label: "model", value: "model" }] };
      },
      applyCompletion() {
        return "base apply";
      },
    };
    const provider = workspaceAutocomplete(current, fs);
    const suggest = (
      line: string,
      force = true,
      signal = new AbortController().signal,
    ) => provider.getSuggestions([line], 0, line.length, { force, signal });
    assert.equal(
      await suggest("nes", false),
      null,
      "ordinary prose does not trigger file completion",
    );
    const direct = await suggest("@nested/spa");
    assert.equal(direct.prefix, "@nested/spa");
    assert.deepEqual(direct.items, [
      { label: "space name.txt", value: '@"nested/space name.txt"' },
    ]);
    const quoted = await suggest('@"nested/space n');
    assert.equal(quoted.items[0].value, '@"nested/space name.txt"');
    assert.equal(
      (await suggest("@space")).items[0].value,
      '@"nested/space name.txt"',
    );
    assert.equal((await suggest("./nes")).items[0].value, "./nested/");
    assert.equal(
      (await suggest("/workspace/nested/spa")).items[0].value,
      '"/workspace/nested/space name.txt"',
    );
    assert.equal(await suggest("@../secret"), null);
    assert.equal(await suggest("@/etc/pass"), null);
    assert.equal(await suggest("@planted"), null);
    assert.equal(await suggest("@space", true, AbortSignal.abort()), null);
    const slashAttachment = await suggest("/model @nested/spa");
    assert.equal(slashAttachment.items[0].value, '@"nested/space name.txt"');
    assert.equal(
      slashCalls.length,
      0,
      "file completion never invokes host-backed provider",
    );
    await suggest("/model m");
    assert.equal(slashCalls.length, 1);
    assert.equal(slashCalls[0][3].force, false);
    assert.equal(provider.applyCompletion(), "base apply");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

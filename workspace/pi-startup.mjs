// Workspace-only patch for Pi 0.86.1. Its CLI has no managed-tool startup
// hook: it unconditionally bootstraps native fd/rg before session_start.
// Neither is a workspace dependency: tools and completion use just-bash.
// Keep the upstream CLI (including input readiness ordering) and replace only
// that bootstrap expression. Node's supported synchronous load hook handles
// both the CLI's require(ESM) and its chunk imports; no shared files change.
// Fail closed on any upstream drift. Docker never installs this hook.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const CHUNK = "./bundle/chunks/chunk-CMRUVXTE.js";
const SHA256 =
  "2d5dc2025bf5cb9632f83491472677a281f8bfa375840bf785d38a9d7f103e1b";
const BEFORE =
  'await Promise.all([ensureTool("fd",status=>this.showManagedToolStatus(status)),ensureTool("rg",status=>this.showManagedToolStatus(status))])';
const AFTER = "await Promise.resolve([null])";

export function patchWorkspacePi(source) {
  if (
    createHash("sha256").update(source).digest("hex") !== SHA256 ||
    source.split(BEFORE).length !== 2
  ) {
    throw new Error(
      "WORKSPACE_PI_STARTUP_PATCH_MISMATCH: expected Pi 0.86.1 CLI chunk",
    );
  }
  return source.replace(BEFORE, AFTER);
}

export function installWorkspacePiStartup() {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", entry), "utf8"),
  );
  if (manifest.version !== "0.86.1")
    throw new Error("WORKSPACE_PI_VERSION_MISMATCH");
  const target = new URL(CHUNK, entry).href;
  // Validate before starting the TUI, even if upstream changes its imports.
  const source = patchWorkspacePi(readFileSync(new URL(target), "utf8"));
  return registerHooks({
    load(url, context, nextLoad) {
      if (url !== target) return nextLoad(url, context);
      return { format: "module", source, shortCircuit: true };
    },
  });
}

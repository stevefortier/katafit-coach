// Entry point of a workspace-mode Pi session (src/sandbox/workspace.ts). It
// runs under Node's permission model, which forbids child processes, so Pi
// runs in this same process: connect the relay, then hand over to Pi's CLI
// with the same arguments the Docker launcher (sandbox/launch.mjs) uses, plus
// the just-bash tools in place of Pi's host-backed built-ins.
import { fileURLToPath } from "node:url";
import { connectRelay } from "./ipc-relay.mjs";

const config = await connectRelay();
const extension = (name) => fileURLToPath(new URL(name, import.meta.url));
const args = [
  "--no-session",
  "--offline",
  // Never trust project resources from the workspace.
  "--no-approve",
  "--provider",
  "katafit",
  "--model",
  config.model,
  "-e",
  extension("./fetch.mjs"),
  "-e",
  extension("../sandbox/katafit.mjs"),
  // Coach is the primary identity, as in the Docker launcher.
  "--system-prompt",
  config.prompt,
];
if (process.env.NATIVE_PROFILE === "composer") args.push("--no-tools");
else args.push("--no-builtin-tools", "-e", extension("./tools.mjs"));
// Pi's RPC entry adds `--mode rpc` and reads the rest from process.argv.
const entry = import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry");
process.argv = [process.execPath, fileURLToPath(entry), ...args];
await import(entry);

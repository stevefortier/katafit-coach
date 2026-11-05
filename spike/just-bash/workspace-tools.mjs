// Pi extension (spike): Pi's own tools, backed by just-bash instead of the
// host. Every tool keeps Pi's schema, prompt text and rendering; only its
// operations change. The model sees one folder, /workspace, which is the
// host workspace through just-bash's ReadWriteFs. Nothing else on the host
// is reachable: the rest of the namespace is just-bash's in-memory layout.
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { posix as posixPath } from "node:path";
import { Bash, InMemoryFs, MountableFs, ReadWriteFs } from "just-bash";

const ROOT = "/workspace";
const MAX_OUTPUT = 512 * 1024;

export function workspaceShell(hostWorkspace) {
  const fs = new MountableFs({
    base: new InMemoryFs(),
    mounts: [
      {
        mountPoint: ROOT,
        filesystem: new ReadWriteFs({ root: hostWorkspace, allowSymlinks: false }),
      },
    ],
  });
  const bash = new Bash({
    fs,
    cwd: ROOT,
    env: { HOME: ROOT, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    python: true,
    javascript: true,
    executionLimits: { maxExecutionTimeMs: 120_000, maxOutputSize: 8 * MAX_OUTPUT },
  });
  return { fs, bash };
}

// Pi hands tools paths resolved against its real working folder (the host
// workspace), with the host's separators. Map them into the sandbox's POSIX
// namespace: the host workspace becomes /workspace; anything else stays a
// path in just-bash's in-memory layout, where nothing of the host exists.
const posixOf = (path) => String(path).replace(/^[A-Za-z]:/, "").replaceAll("\\", "/");
const guestPaths = (hostWorkspace) => {
  const host = posixOf(hostWorkspace).replace(/\/+$/, "");
  return (path) => {
    let p = posixOf(path);
    if (p === host || p.startsWith(host + "/")) p = ROOT + p.slice(host.length);
    return posixPath.normalize(p.startsWith("/") ? p : `${ROOT}/${p}`);
  };
};

export function workspaceTools(hostWorkspace) {
  const { fs, bash } = workspaceShell(hostWorkspace);
  const guest = guestPaths(hostWorkspace);
  const readFile = async (p) => Buffer.from(await fs.readFileBuffer(guest(p)));
  const access = async (p) => {
    if (!(await fs.exists(guest(p)))) throw new Error(`ENOENT: ${guest(p)}`);
  };
  const writeFile = (p, content) => fs.writeFile(guest(p), content);
  const mkdir = (p) => fs.mkdir(guest(p), { recursive: true });
  const exists = (p) => fs.exists(guest(p));
  // just-bash reports isDirectory as a property; Pi expects a method.
  const stat = async (p) => {
    const s = await fs.stat(guest(p));
    return { ...s, isDirectory: () => s.isDirectory };
  };
  const run = async (command, options = {}) => {
    const result = await bash.exec(command, { replaceEnv: false, ...options });
    return result;
  };

  const tools = [
    createReadToolDefinition(ROOT, { operations: { readFile, access } }),
    createWriteToolDefinition(ROOT, { operations: { writeFile, mkdir } }),
    createEditToolDefinition(ROOT, { operations: { readFile, writeFile, access } }),
    createLsToolDefinition(ROOT, {
      operations: { exists, stat, readdir: (p) => fs.readdir(guest(p)) },
    }),
    createFindToolDefinition(ROOT, {
      operations: {
        exists,
        async glob(pattern, cwd, { limit }) {
          const r = await run("find . -type f -path \"$PATTERN\" | head -n \"$LIMIT\"", {
            cwd: guest(cwd),
            env: { PATTERN: pattern.includes("/") ? `./${pattern}` : `*/${pattern}`, LIMIT: String(limit) },
          });
          return r.stdout.split("\n").filter(Boolean).map((l) => l.replace(/^\.\//, ""));
        },
      },
    }),
    createBashToolDefinition(ROOT, {
      exposeSessionEnvironment: false,
      operations: {
        async exec(command, cwd, { onData, signal, timeout }) {
          const signals = [signal, timeout ? AbortSignal.timeout(timeout * 1000) : undefined].filter(Boolean);
          const r = await run(command, { cwd: guest(cwd), signal: signals.length ? AbortSignal.any(signals) : undefined });
          const out = (r.stdout ?? "") + (r.stderr ?? "");
          onData(Buffer.from(out.length > MAX_OUTPUT ? out.slice(-MAX_OUTPUT) : out));
          return { exitCode: r.exitCode };
        },
      },
    }),
  ];
  // Pi's grep always spawns ripgrep; keep its schema and rendering, search
  // with just-bash's rg instead.
  const grep = createGrepToolDefinition(ROOT);
  tools.push({
    ...grep,
    async execute(_id, params, signal) {
      const { pattern, path = ".", glob, ignoreCase, literal, context, limit = 100 } = params;
      const args = ["-n", "--hidden"];
      if (ignoreCase) args.push("-i");
      if (literal) args.push("-F");
      if (glob) args.push("--glob", glob);
      if (context > 0) args.push("-C", String(context));
      // just-bash's rg has no "--"; -e keeps a leading "-" in the pattern.
      args.push("-e", pattern, guest(path));
      const r = await run("rg", { args, signal });
      if (r.exitCode > 1) throw new Error(r.stderr.trim() || `rg exited ${r.exitCode}`);
      const lines = r.stdout.split("\n").filter(Boolean);
      const text = lines.length ? lines.slice(0, limit).join("\n") : "No matches found";
      return {
        content: [{ type: "text", text }],
        details: lines.length > limit ? { matchLimitReached: limit } : undefined,
      };
    },
  });
  return { tools, bash, guest };
}

export default function (pi) {
  const host = process.env.KATAFIT_WORKSPACE ?? process.cwd();
  const { tools, bash, guest } = workspaceTools(host);
  for (const tool of tools) pi.registerTool(tool);
  // Human `!` commands run in the same sandbox, never on the host.
  pi.on("user_bash", async (event) => {
    const r = await bash.exec(event.command, { cwd: guest(event.cwd ?? ROOT) });
    return {
      result: { output: (r.stdout ?? "") + (r.stderr ?? ""), exitCode: r.exitCode, cancelled: false, truncated: false },
    };
  });
}

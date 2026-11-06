#!/usr/bin/env node
// Installs Kata.fit Coach for the current user on Linux, with no admin rights
// (install.sh downloads the archive and runs this from inside it):
//
//   1. verifies the archive's attestation (skipped only for a local archive
//      the user supplied with --archive, and said so);
//   2. installs the runtime (Node + application + launch scripts) into
//      ~/.local/share/katafit-coach, replacing an earlier one;
//   3. for a new installation, chooses workspace mode (no Docker);
//   4. runs the bootstrap as a systemd user service, enabled at boot when
//      lingering is allowed, or else from cron @reboot, or else just now;
//   5. waits for Studio and prints its address.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { verifyProvenanceFile } from "./release/manifest.js";
import { sandboxModeFile } from "./sandbox/mode.js";

const SERVICE = "katafit-coach";

export type InstallPaths = {
  /** Coach's data: settings, versions, sessions. Kept across reinstalls. */
  home: string;
  /** The installed runtime: node/, app/, bin/. Replaced on reinstall. */
  runtime: string;
  /** Where the `katafit-coach` command is linked. */
  bin: string;
  /** systemd user unit directory. */
  units: string;
};

export function installPaths(env = process.env): InstallPaths {
  const user = env.HOME || homedir();
  return {
    home: env.KATAFIT_COACH_HOME || join(user, ".katafit-coach"),
    runtime: join(env.XDG_DATA_HOME || join(user, ".local/share"), SERVICE),
    bin: join(user, ".local/bin"),
    units: join(env.XDG_CONFIG_HOME || join(user, ".config"), "systemd/user"),
  };
}

/** The unit runs the bootstrap from the installed runtime. */
export function serviceUnit(paths: InstallPaths) {
  return `[Unit]
Description=Kata.fit Coach
After=network-online.target

[Service]
ExecStart=${join(paths.runtime, "node/bin/node")} ${join(paths.runtime, "app/dist/boot.js")}
Environment=KATAFIT_COACH_HOME=${paths.home}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

const run = (file: string, args: string[]) =>
  spawnSync(file, args, { encoding: "utf8", stdio: "pipe" });
const ok = (file: string, args: string[]) => {
  try {
    return run(file, args).status === 0;
  } catch {
    return false;
  }
};

/** Copies the extracted runtime into place, keeping the old one until done. */
export function installRuntime(source: string, paths: InstallPaths) {
  const next = paths.runtime + ".new",
    old = paths.runtime + ".old";
  rmSync(next, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  mkdirSync(resolve(paths.runtime, ".."), { recursive: true });
  cpSync(source, next, { recursive: true, verbatimSymlinks: true });
  if (existsSync(paths.runtime)) renameSync(paths.runtime, old);
  renameSync(next, paths.runtime);
  rmSync(old, { recursive: true, force: true });
  mkdirSync(paths.bin, { recursive: true });
  const link = join(paths.bin, SERVICE);
  rmSync(link, { force: true });
  symlinkSync(join(paths.runtime, "bin", SERVICE), link);
}

/**
 * A new installation runs Pi without Docker. An existing one keeps the mode
 * it has: no sandbox.json there means it was set up for Docker.
 */
export function chooseSandbox(paths: InstallPaths) {
  const fresh = !existsSync(paths.home);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  chmodSync(paths.home, 0o700);
  if (fresh)
    writeFileSync(sandboxModeFile(paths.home), '{"mode":"workspace"}\n', {
      mode: 0o600,
    });
  return existsSync(sandboxModeFile(paths.home)) ? "workspace" : "docker";
}

type Started = "systemd-boot" | "systemd-login" | "cron" | "now";

/** Starts the bootstrap so it runs at boot where the system allows it. */
export function startService(paths: InstallPaths): Started {
  if (ok("systemctl", ["--user", "show-environment"])) {
    mkdirSync(paths.units, { recursive: true });
    writeFileSync(join(paths.units, `${SERVICE}.service`), serviceUnit(paths));
    run("systemctl", ["--user", "daemon-reload"]);
    if (!ok("systemctl", ["--user", "enable", "--now", SERVICE]))
      throw new Error("SERVICE_START_FAILED");
    // Lingering starts user services at boot, before anyone logs in.
    const user = userInfo().username;
    ok("loginctl", ["enable-linger", user]);
    const linger = run("loginctl", ["show-user", user, "--property=Linger"]);
    return linger.stdout?.trim() === "Linger=yes"
      ? "systemd-boot"
      : "systemd-login";
  }
  const boot = `${join(paths.runtime, "node/bin/node")} ${join(paths.runtime, "app/dist/boot.js")}`;
  const started = background(paths);
  if (ok("sh", ["-c", "command -v crontab >/dev/null"])) {
    const current = run("crontab", ["-l"]).stdout ?? "";
    const lines = current
      .split("\n")
      .filter((line) => line && !line.includes("# katafit-coach"));
    lines.push(
      `@reboot KATAFIT_COACH_HOME=${paths.home} ${boot} >>${join(paths.home, "boot.log")} 2>&1 # katafit-coach`,
    );
    const set = spawnSync("crontab", ["-"], {
      input: lines.join("\n") + "\n",
      encoding: "utf8",
    });
    if (set.status === 0) return "cron";
  }
  return started;
}

/** Runs the bootstrap detached, logging to the home folder. */
function background(paths: InstallPaths): Started {
  const log = openSync(join(paths.home, "boot.log"), "a", 0o600);
  const child = spawn(
    join(paths.runtime, "node/bin/node"),
    [join(paths.runtime, "app/dist/boot.js")],
    {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, KATAFIT_COACH_HOME: paths.home },
    },
  );
  child.unref();
  writeFileSync(join(paths.home, "boot.pid"), String(child.pid), {
    mode: 0o600,
  });
  return "now";
}

/** Stops a running installation before its runtime is replaced. */
export function stopExisting(paths: InstallPaths) {
  if (ok("systemctl", ["--user", "show-environment"]))
    run("systemctl", ["--user", "stop", SERVICE]);
  stopBackground(paths);
}

/** Stops a background bootstrap and waits for it, so its lock is released. */
function stopBackground(paths: InstallPaths) {
  let pid: number;
  try {
    pid = Number(readFileSync(join(paths.home, "boot.pid"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 1) return;
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 30000;
  while (alive() && Date.now() < deadline) spawnSync("sleep", ["0.2"]);
  rmSync(join(paths.home, "boot.pid"), { force: true });
}

/** Waits for the supervisor to publish its address, then Studio's URL. */
export async function studioAddress(home: string, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { origin } = JSON.parse(
        readFileSync(join(home, "service.json"), "utf8"),
      );
      const { admin } = JSON.parse(
        readFileSync(join(home, "secrets.json"), "utf8"),
      );
      if (
        /^http:\/\/127\.0\.0\.1:\d+$/.test(origin) &&
        typeof admin === "string" &&
        (await fetch(origin + "/", { signal: AbortSignal.timeout(5000) })).ok
      )
        return `${origin}/#${admin}`;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("STUDIO_NOT_READY");
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const source = option("--source");
  const archive = option("--archive");
  const revision = option("--revision");
  if (!source || !archive || !revision || !/^[a-f0-9]{40}$/.test(revision))
    throw new Error(
      "Usage: install.js --source <extracted dir> --archive <file> --revision <sha> [--local]",
    );
  if (args.includes("--local"))
    console.log(
      "Installing a local archive you supplied: its provenance is not verified.",
    );
  else {
    console.log("Verifying the release's attestation...");
    await verifyProvenanceFile(archive, revision);
  }
  const paths = installPaths();
  stopExisting(paths);
  installRuntime(source, paths);
  const sandbox = chooseSandbox(paths);
  const started = startService(paths);
  console.log("Starting Coach...");
  const url = await studioAddress(paths.home);
  const port = new URL(url).port;
  console.log(`
Kata.fit Coach ${revision.slice(0, 7)} is installed and running.

  Studio:   ${url}
  Command:  ${join(paths.bin, SERVICE)} (status, open, stop)
  Data:     ${paths.home}
  Sandbox:  ${sandbox === "workspace" ? "workspace mode (no Docker needed)" : "Docker (kept from your existing installation)"}

${
  {
    "systemd-boot": "It starts automatically at boot.",
    "systemd-login":
      "It starts when you log in. To start it at boot without logging in, run once:\n  sudo loginctl enable-linger " +
      userInfo().username,
    cron: "It starts at boot through your crontab (@reboot).",
    now: "It is running now, but nothing will start it after a reboot on this system.",
  }[started]
}
Studio listens on this computer only. From another machine, use an SSH
tunnel: ssh -L ${port}:127.0.0.1:${port} <this host>
`);
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("dist/install.js"))
  main().catch((error) => {
    console.error(`Installation failed: ${error.message}`);
    process.exitCode = 1;
  });

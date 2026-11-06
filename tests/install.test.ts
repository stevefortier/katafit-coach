// The Linux installer's file-level steps; the full install, start and
// reinstall run in clean containers in the CI `installer` job.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  chooseSandbox,
  installPaths,
  installRuntime,
  serviceUnit,
} from "../src/install.js";
import { sandboxMode } from "../src/sandbox/mode.js";

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "install-")));

test("paths follow XDG and the Coach home override", () => {
  assert.deepEqual(installPaths({ HOME: "/home/u" }), {
    home: "/home/u/.katafit-coach",
    runtime: "/home/u/.local/share/katafit-coach",
    bin: "/home/u/.local/bin",
    units: "/home/u/.config/systemd/user",
  });
  const custom = installPaths({
    HOME: "/home/u",
    KATAFIT_COACH_HOME: "/data/coach",
    XDG_DATA_HOME: "/x/data",
    XDG_CONFIG_HOME: "/x/config",
  });
  assert.equal(custom.home, "/data/coach");
  assert.equal(custom.runtime, "/x/data/katafit-coach");
  assert.equal(custom.units, "/x/config/systemd/user");
});

test("the unit runs the bootstrap from the installed runtime", () => {
  const unit = serviceUnit(installPaths({ HOME: "/home/u" }));
  assert.match(
    unit,
    /^ExecStart=\/home\/u\/\.local\/share\/katafit-coach\/node\/bin\/node \/home\/u\/\.local\/share\/katafit-coach\/app\/dist\/boot\.js$/m,
  );
  assert.match(
    unit,
    /^Environment=KATAFIT_COACH_HOME=\/home\/u\/\.katafit-coach$/m,
  );
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test("a reinstall replaces the runtime and links the command", () => {
  const root = scratch();
  const paths = installPaths({ HOME: root });
  for (const version of ["one", "two"]) {
    const source = join(root, "src-" + version);
    mkdirSync(join(source, "bin"), { recursive: true });
    writeFileSync(join(source, "bin/katafit-coach"), version);
    writeFileSync(join(source, version), "");
    installRuntime(source, paths);
  }
  assert.equal(
    readFileSync(join(paths.runtime, "bin/katafit-coach"), "utf8"),
    "two",
  );
  assert.ok(!existsSync(join(paths.runtime, "one")));
  assert.ok(!existsSync(paths.runtime + ".old"));
  assert.ok(!existsSync(paths.runtime + ".new"));
  assert.equal(
    readlinkSync(join(paths.bin, "katafit-coach")),
    join(paths.runtime, "bin/katafit-coach"),
  );
});

test("a new installation runs Pi without Docker; an existing one keeps its mode", async () => {
  const fresh = installPaths({ HOME: scratch() });
  assert.equal(chooseSandbox(fresh), "workspace");
  assert.equal(await sandboxMode(fresh.home), "workspace");
  // Reinstalling keeps the choice.
  assert.equal(chooseSandbox(fresh), "workspace");

  const existing = installPaths({ HOME: scratch() });
  mkdirSync(existing.home);
  writeFileSync(join(existing.home, "config.json"), "{}");
  assert.equal(chooseSandbox(existing), "docker");
  assert.equal(await sandboxMode(existing.home), "docker");
});

import { command } from "./release-command.mjs";
import {
  beginImageBuild,
  reconcileImageBuild,
  cleanupImageBuild,
} from "./release-image-owner.mjs";
import { releasePresenceFixture } from "./release-presence-fixture.mjs";
import { roundtripChangedImage } from "./release-image-roundtrip.mjs";
import { syntheticReleaseBoundary } from "./synthetic-release-boundary.mjs";
// Real packed CLI/child lifecycle with synthetic release discovery and local Git.
// The owner uses actual native readiness; this fixture makes no provenance claim.
import {
  mkdtemp,
  mkdir,
  cp,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
if (!process.env.NATIVE_TEST_IMAGE || !process.env.COACH_RELEASE_PACKAGE)
  throw Error("EXACT_RELEASE_PACKAGE_AND_NATIVE_IMAGE_REQUIRED");
const readinessOnly = process.argv.includes("--readiness-only");
if (process.argv.slice(2).some((arg) => arg !== "--readiness-only"))
  throw Error("UNKNOWN_QUALIFICATION_SCOPE");
const root = await mkdtemp(join(tmpdir(), "coach-packed-update-"));
const home = join(root, "home"),
  source = join(root, "source"),
  selection = join(root, "selection.json"),
  trace = join(root, "build-trace.jsonl");
const env = {
  ...process.env,
  KATAFIT_COACH_HOME: home,
  KATAFIT_COACH_PORT: "0",
  TEST_BUILD_SECRET: "must-not-inherit",
};
let cli, preload, failure, backend, presence, imagesBeforeBuild, imageOwner;
const imageOwnerPath = join(root, "image-owner.json");
const phase = (name, details = {}) =>
  console.log(JSON.stringify({ phase: name, ...details }));
const run = (...args) =>
  command(process.execPath, ["--import", preload, cli, ...args], {
    env,
    encoding: "utf8",
    timeout: 20000,
  });
try {
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      join(root, "install"),
      "--omit=dev",
      "--ignore-scripts",
      resolve(process.env.COACH_RELEASE_PACKAGE),
    ],
    { stdio: "pipe", timeout: 120000 },
  );
  cli = join(root, "install/node_modules/@katafit/coach/dist/cli.js");
  if (process.env.NATIVE_TEST_IMAGE) {
    const installedRoot = join(root, "install/node_modules/@katafit/coach");
    const { provisionArtifact } = await import(
      join(installedRoot, "dist/sandbox/artifact.js")
    );
    const installedBuild = JSON.parse(
      await readFile(join(installedRoot, "dist/build.json"), "utf8"),
    );
    let provisioningRoot = installedRoot;
    if (
      installedBuild.revision === null &&
      readinessOnly &&
      process.env.COACH_NATIVE_BOOTSTRAP_PACKAGE
    ) {
      const bootstrap = join(root, "bootstrap");
      await mkdir(bootstrap);
      execFileSync("tar", [
        "-xzf",
        resolve(process.env.COACH_NATIVE_BOOTSTRAP_PACKAGE),
        "-C",
        bootstrap,
      ]);
      provisioningRoot = join(bootstrap, "package");
      const priorBuild = JSON.parse(
        await readFile(join(provisioningRoot, "dist/build.json"), "utf8"),
      );
      assert.equal(
        installedBuild.fingerprint,
        priorBuild.fingerprint,
        "unknown local package must have the same real native inputs",
      );
    }
    await provisionArtifact(
      home,
      provisioningRoot,
      process.env.NATIVE_TEST_IMAGE,
    );
  }
  await mkdir(source);
  for (const name of [
    "src",
    "sandbox",
    "ui",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ])
    await cp(resolve(name), join(source, name), { recursive: true });
  await mkdir(join(source, "scripts"));
  for (const name of ["build-metadata.mjs", "clean-dist.mjs"])
    await cp(resolve("scripts", name), join(source, "scripts", name));
  // Native protocol 2 is retained in every candidate.
  const git = (...args) =>
    execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=f@example.invalid",
    "commit",
    "-qm",
    "good candidate",
  );
  const good = git("rev-parse", "HEAD");
  const adminPath = join(source, "src/server/admin.ts");
  const original = await readFile(adminPath, "utf8");
  await writeFile(
    adminPath,
    original.replace(
      "  const logs = new Diagnostics(store.dir);",
      `  if(store.dir === ${JSON.stringify(home)}) process.exit(9);\n  const logs = new Diagnostics(store.dir);`,
    ),
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=f@example.invalid",
    "commit",
    "-qm",
    "startup crash candidate",
  );
  const bad = git("rev-parse", "HEAD");
  await writeFile(
    adminPath,
    original + "\n// Second good synthetic revision\n",
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=f@example.invalid",
    "commit",
    "-qm",
    "second good candidate",
  );
  const second = git("rev-parse", "HEAD");
  await writeFile(
    join(source, "sandbox/relay.mjs"),
    (await readFile(join(source, "sandbox/relay.mjs"), "utf8")) +
      "\n// Native full-chain changed fingerprint fixture\n",
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=f@example.invalid",
    "commit",
    "-qm",
    "changed native candidate",
  );
  const changed = git("rev-parse", "HEAD");
  preload = join(root, "boundary.mjs");
  await writeFile(
    preload,
    `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {readFileSync,appendFileSync,existsSync,statSync} from 'node:fs';
import {Updates} from ${JSON.stringify(join(root, "install/node_modules/@katafit/coach/dist/update/updates.js"))};
${syntheticReleaseBoundary({ installedRoot: join(root, "install/node_modules/@katafit/coach"), source, legacy: false })}
const now=Date.now.bind(Date), tracePath=${JSON.stringify(trace)};
const record=(row)=>{try{if(!existsSync(tracePath)||statSync(tracePath).size<16384)appendFileSync(tracePath,JSON.stringify(row)+'\\n');}catch{}};
const original=cp.spawn;
cp.spawn=function(file,args,options){
  if(file==='git')args=args.map(v=>v==='https://github.com/stevefortier/katafit-coach.git'?${JSON.stringify(source)}:v);
  const command=file==='git'?'git:'+args[0]:file==='npm'?'npm:'+args[0]:'launcher', started=now();
  record({event:'start',command});
  const child=original.call(this,file,args,options);
  child.once('close',(code,signal)=>record({event:'exit',command,code,signal,durationMs:now()-started}));
  return child;
};
syncBuiltinESMExports();
const request=globalThis.fetch;
globalThis.fetch=(url,options)=>String(url)==='https://api.github.com/repos/stevefortier/katafit-coach/git/ref/heads/main'?Promise.resolve(new Response(JSON.stringify({object:{sha:JSON.parse(readFileSync(${JSON.stringify(selection)},'utf8')).sha}}))):request(url,options);
Date.now=()=>now()+JSON.parse(readFileSync(${JSON.stringify(selection)},'utf8')).offset;`,
  );
  await writeFile(selection, JSON.stringify({ sha: good, offset: 0 }));
  presence = releasePresenceFixture({
    fault: process.env.COACH_RELEASE_PRESENCE_FAULT,
  });
  backend = presence.server;
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const { Store } = await import(
    join(root, "install/node_modules/@katafit/coach/dist/config/store.js")
  );
  const fixtureStore = new Store(home);
  await fixtureStore.init();
  const settings = fixtureStore.publicConfig();
  delete settings.models;
  await fixtureStore.save({
    ...settings,
    origin: `http://127.0.0.1:${backend.address().port}`,
    token: "synthetic-release-token",
    apiKey: "synthetic-release-key",
  });
  assert.match(await run("start"), /started/);
  const info = JSON.parse(await readFile(join(home, "service.json"), "utf8"));
  const secrets = await readFile(join(home, "secrets.json"), "utf8");
  const config = await readFile(join(home, "config.json"), "utf8");
  const auth = {
    Authorization: "Bearer " + JSON.parse(secrets).admin,
    Origin: info.origin,
    "Content-Type": "application/json",
  };
  const api = (path, body, timeout = 5000) =>
    fetch(info.origin + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: auth,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  const wait = async (predicate) => {
    let lastState;
    for (let i = 0; i < 900; i++) {
      try {
        const state = await (await api("update")).json();
        lastState = state;
        if (predicate(state)) return state;
      } catch {}
      if (
        lastState &&
        !lastState.applying &&
        !lastState.recovering &&
        lastState.lastOperation?.state === "failed" &&
        lastState.lastOperation.sha === lastState.latest &&
        !lastState.manualQueue?.phase?.startsWith("waiting-")
      )
        break;
      await sleep(100);
    }
    const status = {
      installed: lastState?.installed,
      applying: lastState?.applying,
      recovering: lastState?.recovering,
      guidance: lastState?.guidance,
      operation: lastState?.lastOperation && {
        sha: lastState.lastOperation.sha,
        state: lastState.lastOperation.state,
        phase: lastState.lastOperation.phase,
      },
    };
    throw Error(
      "UPDATE_NOT_COMPLETED " +
        JSON.stringify(status) +
        "\n" +
        (await readFile(trace, "utf8").catch(() => "(no build trace)")),
    );
  };
  const apply = async (sha, offset) => {
    await writeFile(selection, JSON.stringify({ sha, offset }));
    const receiptsBefore = await readdir(join(home, "native-artifacts"));
    const checked = await (await api("update/check", {})).json();
    assert.equal(checked.latest, sha);
    assert.equal(checked.readiness?.state, "ready");
    assert.equal(checked.readiness?.sha, sha);
    const reread = await (await api("update")).json();
    assert.equal(reread.checkedAt, checked.checkedAt);
    assert.deepEqual(
      await readdir(join(home, "native-artifacts")),
      receiptsBefore,
      "readonly readiness must not mint receipts",
    );
    const response = await api("update/apply", { sha, confirm: true }, 180000);
    assert.equal(response.status, 202, await response.text());
  };
  await apply(good, 0);
  await wait((s) => !s.applying && s.installed === good);
  phase("initial-good-installed", { good });
  assert.equal(
    JSON.parse(await readFile(join(home, "active.json"), "utf8")).revision,
    good,
  );
  assert.equal((await (await api("status")).json()).state, "stopped");
  // A packed candidate must not resurrect the retired automatic installer.
  for (const enabled of [true, false]) {
    const autoResponse = await api("update/auto", { enabled });
    assert.equal(autoResponse.status, 410);
    assert.deepEqual(await autoResponse.json(), {
      error: "AUTOMATIC_UPDATES_REMOVED",
    });
  }
  const manualState = await (await api("update")).json();
  assert.equal("auto" in manualState, false);
  assert.equal("autoSchedule" in manualState, false);
  if (readinessOnly) {
    const preparation = manualState.preparationAttempt;
    const activeBefore = await readFile(join(home, "active.json"), "utf8");
    const receiptsBefore = await readdir(join(home, "native-artifacts"));
    assert.equal(
      receiptsBefore.includes(good + ".json"),
      false,
      "compatible source-only image is reused",
    );
    await writeFile(selection, JSON.stringify({ sha: changed, offset: 61000 }));
    const pending = await (await api("update/check", {})).json();
    assert.equal(pending.readiness?.state, "delivery-pending");
    const deferred = await api("update/apply", { sha: changed, confirm: true });
    assert.equal(deferred.status, 409);
    const body = await deferred.json();
    assert.equal(body.error, "UPDATE_DELIVERY_PENDING");
    assert.equal(body.deferred, true);
    const after = await (await api("update")).json();
    assert.deepEqual(after.preparationAttempt, preparation);
    assert.equal(
      await readFile(join(home, "active.json"), "utf8"),
      activeBefore,
    );
    assert.deepEqual(
      await readdir(join(home, "native-artifacts")),
      receiptsBefore,
    );
    assert.equal(await readFile(join(home, "config.json"), "utf8"), config);
    assert.equal(await readFile(join(home, "secrets.json"), "utf8"), secrets);
    assert.equal((await (await api("status")).json()).state, "stopped");
    console.log(
      JSON.stringify({
        packedReadiness: "PASS",
        scope: "compatible-image-upgrade-and-missing-image-deferral",
        syntheticReleaseDiscovery: true,
        cryptographicProvenanceQualified: false,
        protocol: 2,
        finalSourceReleaseQualified: false,
        fullChain: false,
      }),
    );
  } else {
    const waitWorker = async (expected) => {
      for (let i = 0; i < 300; i++) {
        const status = await (await api("status")).json();
        const update = await (await api("update")).json();
        if (
          status.state === expected &&
          status.safeToReplace &&
          !update.applying &&
          !update.recovering
        ) {
          const observed = presence.snapshot();
          if (expected === "idle") {
            assert.equal(status.presence, "reported");
            assert.equal(observed.running.length, 1);
          } else {
            assert.equal(status.stopConfirmed, true);
            assert.equal(observed.running.length, 0);
            assert.equal(observed.reports.at(-1)?.state, "stopped");
            assert.equal(observed.reports.at(-1)?.accepted, true);
          }
          return status;
        }
        await sleep(50);
      }
      throw Error("WORKER_INTENT_NOT_RECOVERED");
    };
    const runResponse = await api("run", {});
    assert.equal(runResponse.status, 200, await runResponse.text());
    await waitWorker("idle");
    const goodPointer = await readFile(join(home, "active.json"), "utf8");
    await apply(bad, 61000);
    const failed = await wait(
      (s) =>
        !s.applying &&
        !s.recovering &&
        s.lastOperation?.sha === bad &&
        s.lastOperation.state === "failed" &&
        s.lastOperation.phase === "activating",
    );
    assert.equal(failed.installed, good);
    assert.equal(
      await readFile(join(home, "active.json"), "utf8"),
      goodPointer,
    );
    assert.equal(
      JSON.parse(await readFile(join(home, "active.json"), "utf8")).revision,
      good,
    );
    assert.equal(await readFile(join(home, "config.json"), "utf8"), config);
    assert.equal(await readFile(join(home, "secrets.json"), "utf8"), secrets);
    const restored = await waitWorker("idle");
    console.log(
      JSON.stringify({
        rollbackObservation: {
          installed: failed.installed,
          operation: failed.lastOperation,
          applying: failed.applying,
          recovering: failed.recovering,
          guidance: failed.guidance,
          goodPointerConfigSecretsUnchanged: true,
          worker: {
            state: restored.state,
            presence: restored.presence,
            safeToReplace: restored.safeToReplace,
          },
        },
      }),
    );
    assert.equal(restored.presence, "reported");
    await writeFile(selection, JSON.stringify({ sha: second, offset: 122000 }));
    assert.equal((await (await api("update/check", {})).json()).latest, second);
    // Actual local transport loss: destroy the accepted response before its body
    // is delivered. Do not retry apply; independently join the durable outcome.
    const { request: httpRequest } = await import("node:http");
    await new Promise((resolve, reject) => {
      const req = httpRequest(
        info.origin + "/api/update/apply",
        { method: "POST", headers: auth },
        (res) => {
          if (res.statusCode !== 202) {
            res.resume();
            reject(Error("UPGRADE_NOT_ACCEPTED"));
            return;
          }
          res.destroy();
          resolve();
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ sha: second, confirm: true }));
    });
    await wait((s) => !s.applying && s.installed === second);
    await waitWorker("idle");
    phase("lost-ack-subsequent-upgrade", { second, applyRequests: 1 });
    assert.equal(await readFile(join(home, "secrets.json"), "utf8"), secrets);
    assert.equal(await readFile(join(home, "config.json"), "utf8"), config);
    assert.equal(
      JSON.parse(await readFile(join(home, "service.json"), "utf8")).pid,
      info.pid,
    );
    const cycles = Number(process.env.COACH_RELEASE_CYCLES ?? "1");
    if (!Number.isInteger(cycles) || cycles < 1 || cycles > 20)
      throw Error("INVALID_CYCLE_COUNT");
    let offset = 183000;
    for (let cycle = 1; cycle < cycles; cycle++) {
      for (const target of [good, second]) {
        await apply(target, offset);
        offset += 61000;
        await wait((s) => !s.applying && s.installed === target);
        await waitWorker("idle");
      }
      phase("reuse-cycle", { cycle: cycle + 1, installed: second });
    }
    phase("reuse-complete", { cycles });
    await writeFile(selection, JSON.stringify({ sha: changed, offset }));
    offset += 61000;
    assert.equal(
      (await (await api("update/check", {})).json()).latest,
      changed,
    );
    const beforePointer = await readFile(join(home, "active.json"), "utf8");
    assert.equal(
      (await api("update/apply", { sha: changed, confirm: true }, 180000))
        .status,
      409,
    );
    assert.equal(
      await readFile(join(home, "active.json"), "utf8"),
      beforePointer,
    );
    assert.equal((await (await api("status")).json()).state, "idle");
    phase("changed-image-missing-refused", { changed, pointerUnchanged: true });
    imagesBeforeBuild = new Set(
      (
        await command(
          "docker",
          ["image", "ls", "--all", "--no-trunc", "--quiet"],
          {
            encoding: "utf8",
          },
        )
      )
        .trim()
        .split("\n"),
    );
    const buildRoot = join(root, "native-build");
    await mkdir(buildRoot);
    const archiveSource = await command("git", ["archive", changed], {
      cwd: source,
      encoding: null,
      maxBuffer: 64 * 1024 ** 2,
    });
    await command("tar", ["-xf", "-", "-C", buildRoot], {
      input: archiveSource,
    });
    const { symlink } = await import("node:fs/promises");
    await symlink(resolve("node_modules"), join(buildRoot, "node_modules"));
    await command("npm", ["run", "build"], {
      cwd: buildRoot,
      env: { ...process.env, KATAFIT_BUILD_REVISION: changed },
      stdio: "pipe",
      timeout: 120000,
    });
    const build = JSON.parse(
      await readFile(join(buildRoot, "dist/build.json"), "utf8"),
    );
    assert.equal(build.revision, changed);
    imageOwner = await beginImageBuild(imageOwnerPath, {
      build,
      inputImage: process.env.NATIVE_TEST_IMAGE,
      imagesBeforeBuild,
    });
    phase("image-build-owned", {
      marker: imageOwner.marker,
      recordPath: imageOwnerPath,
    });
    await command(
      "docker",
      [
        "build",
        "--label",
        `fit.kata.fixture.owner=${imageOwner.marker}`,
        "--pull=false",
        "-f",
        "sandbox/Dockerfile",
        "--build-arg",
        `KATAFIT_BUILD_REVISION=${changed}`,
        "--build-arg",
        `KATAFIT_NATIVE_FINGERPRINT=${build.fingerprint}`,
        "--iidfile",
        join(root, "changed-image"),
        ".",
      ],
      { cwd: buildRoot, stdio: "pipe", timeout: 300000 },
    );
    imageOwner = await reconcileImageBuild(
      imageOwnerPath,
      join(root, "changed-image"),
    );
    const image = imageOwner.image;
    await roundtripChangedImage({
      recordPath: imageOwnerPath,
      image,
      build,
      root,
      home,
      imagesBeforeBuild,
      inputImage: process.env.NATIVE_TEST_IMAGE,
      evidence: process.env.COACH_RELEASE_EVIDENCE_DIR,
    });
    const { provisionArtifact } = await import(
      join(buildRoot, "dist/sandbox/artifact.js")
    );
    await provisionArtifact(home, buildRoot, image);
    assert.equal((await api("stop", {})).status, 200);
    const stoppedWorker = await waitWorker("stopped");
    assert.equal(stoppedWorker.presence, "reported");
    phase("reported-stop-settled");
    await apply(changed, offset);
    await wait((s) => !s.applying && s.installed === changed);
    await waitWorker("stopped");
    const nativeReceipt = JSON.parse(
      await readFile(join(home, "native-artifacts", changed + ".json"), "utf8"),
    );
    assert.equal(nativeReceipt.image, image);
    phase("changed-image-activated-stopped", { changed, image });
    assert.equal(await readFile(join(home, "config.json"), "utf8"), config);
    assert.equal(await readFile(join(home, "secrets.json"), "utf8"), secrets);
    assert.equal((await readdir(home)).includes("update-staging"), false);
    assert.match(await run("stop"), /stopped/);
    assert.match(await run("start"), /started/);
    const restarted = JSON.parse(
      await readFile(join(home, "service.json"), "utf8"),
    );
    const restartState = await (
      await fetch(restarted.origin + "/api/update", {
        headers: { Authorization: auth.Authorization },
      })
    ).json();
    assert.equal(restartState.installed, changed);
    phase("restart-installed", { changed });
    process.kill(restarted.pid, "SIGKILL");
    await sleep(700);
    assert.match(await run("start"), /started/);
    const recovered = JSON.parse(
      await readFile(join(home, "service.json"), "utf8"),
    );
    const recoveredUpdate = await (
      await fetch(recovered.origin + "/api/update", {
        headers: { Authorization: auth.Authorization },
      })
    ).json();
    const recoveredWorker = await (
      await fetch(recovered.origin + "/api/status", {
        headers: { Authorization: auth.Authorization },
      })
    ).json();
    assert.equal(recoveredUpdate.installed, changed);
    assert.equal(recoveredUpdate.applying, false);
    assert.equal(recoveredUpdate.recovering, false);
    assert.equal(recoveredWorker.state, "stopped");
    assert.equal(recoveredWorker.safeToReplace, true);
    assert.equal(recoveredWorker.stopConfirmed, true);
    assert.equal(presence.snapshot().running.length, 0);
    phase("crash-recovery-installed-stopped", { changed });
    console.log(
      JSON.stringify(
        {
          packedUpdate: "PASS",
          syntheticTrustedGit: true,
          first: good,
          rollbackCandidate: bad,
          second,
          changed,
          cycles,
          protocol: 2,
          changedFingerprintMissingThenProvisioned: true,
          stableOwner: true,
          runningAndStoppedIntentPreserved: true,
          acceptedResponseTransportLossRecoveredWithoutReplay: true,
          configSecretsPreserved: true,
          multipleUpgrades: true,
          retainedVersions: (await readdir(join(home, "versions"))).length,
          restartAndCrashRecovery: true,
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  failure = error;
  // Preserve the bounded lifecycle diagnostic even if fixture cleanup fails.
  if (
    error instanceof Error &&
    error.message.startsWith("UPDATE_NOT_COMPLETED ")
  )
    console.error(error.message);
  throw error;
} finally {
  const owned = await readFile(join(home, "service.json"), "utf8")
    .then(JSON.parse)
    .catch(() => undefined);
  if (cli && preload)
    try {
      await run("stop");
    } catch {}
  // A failed test can interrupt an accepted upgrade, which correctly fences the
  // public shutdown route. Terminate only this fixture's recorded processes.
  for (const pid of [owned?.pid, owned?.runtimePid]) {
    if (!Number.isInteger(pid)) continue;
    const command = await readFile("/proc/" + pid + "/cmdline", "utf8").catch(
      () => "",
    );
    if (command.includes(join(root, "install")))
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
  }
  if (backend) await new Promise((resolve) => backend.close(resolve));
  if (presence) phase("presence-rpc-ledger", presence.snapshot());
  // Teardown must finish before dropping the private active/rollback references.
  let live = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    live = false;
    for (const pid of [owned?.pid, owned?.runtimePid]) {
      if (!Number.isInteger(pid)) continue;
      const cmd = await readFile("/proc/" + pid + "/cmdline", "utf8").catch(
        () => "",
      );
      if (cmd.includes(root + "/")) live = true;
    }
    if (!live) break;
    await sleep(50);
  }
  let cleanup = { state: "no-build" };
  if (live)
    cleanup = {
      state: "retained",
      reason: "FIXTURE_OWNER_STILL_LIVE",
      recordPath: imageOwnerPath,
    };
  else {
    await rm(home, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
    if (imageOwner)
      cleanup = await cleanupImageBuild(imageOwnerPath, {
        home,
        iidfile: join(root, "changed-image"),
      });
  }
  phase("task-image-cleanup", cleanup);
  if (process.env.COACH_RELEASE_EVIDENCE_DIR && imageOwner) {
    await mkdir(process.env.COACH_RELEASE_EVIDENCE_DIR, { recursive: true });
    await cp(
      imageOwnerPath,
      join(process.env.COACH_RELEASE_EVIDENCE_DIR, "image-owner.json"),
    );
  }
  if (cleanup.state === "retained") {
    // Root, unique marker, build context and any archive survive for reconciliation.
    console.error("TASK_IMAGE_CLEANUP_RETAINED " + JSON.stringify(cleanup));
    if (!failure) throw Error("TASK_IMAGE_CLEANUP_RETAINED");
  } else
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
}

// Real packed CLI/child lifecycle. Only GitHub fetch and Git remote are replaced
// by a code-loaded, local synthetic trust boundary; production has no URL override.
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
let cli, preload, failure;
const run = (...args) =>
  execFileSync(process.execPath, ["--import", preload, cli, ...args], {
    env,
    encoding: "utf8",
    timeout: 20000,
  });
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
      encoding: "utf8",
    }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      join(root, "install"),
      "--omit=dev",
      "--ignore-scripts",
      join(root, Object.values(packed)[0].filename),
    ],
    { stdio: "pipe", timeout: 120000 },
  );
  cli = join(root, "install/node_modules/@katafit/coach/dist/cli.js");
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
  await cp(
    resolve("scripts/build-metadata.mjs"),
    join(source, "scripts/build-metadata.mjs"),
  );
  // This daemon-independent lifecycle matrix deliberately exercises legacy
  // protocol-1 rollback compatibility. Native artifacts have a separate Docker
  // qualification; never relabel real released native source as protocol 1.
  const fixtureMetadata = join(source, "scripts/build-metadata.mjs");
  await writeFile(
    fixtureMetadata,
    (await readFile(fixtureMetadata, "utf8")).replace(
      "protocol: 2",
      "protocol: 1",
    ),
  );
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
  preload = join(root, "boundary.mjs");
  await writeFile(
    preload,
    `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {readFileSync,appendFileSync,existsSync,statSync} from 'node:fs';
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
  assert.match(run("start"), /started/);
  const info = JSON.parse(await readFile(join(home, "service.json"), "utf8"));
  const secrets = await readFile(join(home, "secrets.json"), "utf8");
  const config = await readFile(join(home, "config.json"), "utf8");
  const auth = {
    Authorization: "Bearer " + JSON.parse(secrets).admin,
    Origin: info.origin,
    "Content-Type": "application/json",
  };
  const api = (path, body) =>
    fetch(info.origin + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: auth,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
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
        lastState.lastOperation?.state === "failed"
      )
        break;
      await sleep(100);
    }
    const status = {
      installed: lastState?.installed,
      applying: lastState?.applying,
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
    assert.equal((await (await api("update/check", {})).json()).latest, sha);
    assert.equal(
      (await api("update/apply", { sha, confirm: true })).status,
      202,
    );
  };
  await apply(good, 0);
  await wait((s) => !s.applying && s.installed === good);
  assert.equal(
    JSON.parse(await readFile(join(home, "active.json"), "utf8")).revision,
    good,
  );
  assert.equal((await (await api("status")).json()).state, "stopped");
  const autoResponse = await api("update/auto", { enabled: true });
  assert.equal(
    autoResponse.status,
    200,
    `Auto-update setting after successful upgrade: ${autoResponse.status} ${JSON.stringify(await autoResponse.json())}`,
  );
  const autoState = (await (await api("update")).json()).auto;
  assert.deepEqual(autoState, { enabled: true, available: true });
  assert.equal((await api("update/auto", { enabled: false })).status, 200);
  assert.equal((await (await api("update")).json()).auto.enabled, false);
  await apply(bad, 61000);
  const failed = await wait(
    (s) => !s.applying && s.guidance.includes("failed"),
  );
  assert.equal(failed.installed, good);
  assert.equal(
    JSON.parse(await readFile(join(home, "active.json"), "utf8")).revision,
    good,
  );
  await apply(second, 122000);
  await wait((s) => !s.applying && s.installed === second);
  assert.equal(await readFile(join(home, "secrets.json"), "utf8"), secrets);
  assert.equal(await readFile(join(home, "config.json"), "utf8"), config);
  assert.equal(
    JSON.parse(await readFile(join(home, "service.json"), "utf8")).pid,
    info.pid,
  );
  assert.equal((await readdir(join(home, "versions"))).length, 2);
  assert.equal((await readdir(home)).includes("update-staging"), false);
  assert.match(run("stop"), /stopped/);
  assert.match(run("start"), /started/);
  const restarted = JSON.parse(
    await readFile(join(home, "service.json"), "utf8"),
  );
  const restartState = await (
    await fetch(restarted.origin + "/api/update", {
      headers: { Authorization: auth.Authorization },
    })
  ).json();
  assert.equal(restartState.installed, second);
  process.kill(restarted.pid, "SIGKILL");
  await sleep(700);
  assert.match(run("start"), /started/);
  console.log(
    JSON.stringify(
      {
        packedUpdate: "PASS",
        syntheticTrustedGit: true,
        first: good,
        rollbackCandidate: bad,
        second,
        stableOwner: true,
        configSecretsPreserved: true,
        multipleUpgrades: true,
        retainedVersions: 2,
        restartAndCrashRecovery: true,
      },
      null,
      2,
    ),
  );
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
      run("stop");
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
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  }).catch((error) => {
    if (!failure) throw error;
    console.error(
      "Fixture cleanup failed after the reported lifecycle failure.",
    );
  });
}

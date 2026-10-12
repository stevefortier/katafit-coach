import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
test("actual owner crash after preparation recovers exact target for retry without acceptance or activation", async () => {
  const home = await mkdtemp(join(tmpdir(), "preparation-crash-retry-"));
  const runner = join(home, "owner.mjs"),
    sha = "a".repeat(40);
  const url = (p: string) => JSON.stringify(pathToFileURL(resolve(p)).href);
  await writeFile(
    runner,
    `import {Store} from ${url("src/config/store.ts")};
import {supervise} from ${url("tests/helpers/legacy-supervisor.ts")};
import * as managed from ${url("src/update/managed.ts")};
import {cp,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
const home=process.argv[2], sha=${JSON.stringify(sha)},store=new Store(home);await store.init();
const owner=await supervise(store,0,undefined,{prepare:async(s,signal,lease)=>{
 const staging=join(home,'test-candidate');await rm(staging,{recursive:true,force:true});
 await cp(join(home,'legacy-bootstrap-fixture'),staging,{recursive:true});
 await writeFile(join(staging,'dist/build.json'),JSON.stringify({revision:s,protocol:1}));
 await mkdir(join(home,'versions'),{recursive:true,mode:0o700});
 if(managed.publishCandidate) return managed.publishCandidate(home,s,staging,lease);
 const target=join(home,'versions',s);await rename(staging,target);return target;
}});
process.send({ready:true,pid:owner.pid,origin:owner.origin});
process.on('message',async(command)=>{try{if(command==='prepare'){owner.updates.latest=sha;owner.updates.checkedAt=Date.now();await owner.updates.prepare(sha);process.send({prepared:true,operation:owner.updates.lastOperation,pid:owner.pid,attempt:owner.updates.preparationAttempt});}else{await owner.close();process.exit(0);}}catch(e){process.send({error:e.message});}});`,
  );
  let child: ChildProcess | undefined, runtime: number | undefined;
  const receive = (c: ChildProcess) =>
    Promise.race([
      once(c, "message").then(([m]) => m),
      new Promise<never>((_, reject) => {
        const t = setTimeout(
          () => reject(Error("owner fixture timeout")),
          20000,
        );
        t.unref();
      }),
    ]);
  const start = async () => {
    child = fork(runner, [home], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const msg = await receive(child);
    assert.equal(msg.ready, true);
    runtime = msg.pid;
    return msg;
  };
  try {
    await start();
    const firstPid = runtime;
    child!.send("prepare");
    const first = await receive(child!);
    assert.equal(first.prepared, true);
    assert.equal(first.operation, undefined);
    assert.equal(first.pid, firstPid);
    await access(join(home, "versions", sha));
    const config = await readFile(join(home, "config.json"));
    const exit = once(child!, "exit");
    child!.kill("SIGKILL");
    await exit;
    if (runtime)
      try {
        process.kill(runtime, "SIGTERM");
      } catch {}
    await start();
    const restartPid = runtime;
    assert.equal(
      await readFile(join(home, "config.json"), "utf8"),
      config.toString(),
    );
    child!.send("prepare");
    const retry = await receive(child!);
    assert.equal(retry.prepared, true, JSON.stringify(retry));
    assert.equal(retry.pid, restartPid);
    assert.equal(retry.operation, undefined);
    await assert.rejects(access(join(home, "active.json")), { code: "ENOENT" });
    const stopped = once(child!, "exit");
    child!.send("close");
    await stopped;
    child = undefined;
    await assert.rejects(access(join(home, "versions", sha)), {
      code: "ENOENT",
    });
  } finally {
    if (child) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
    if (runtime)
      try {
        process.kill(runtime, "SIGTERM");
      } catch {}
    await rm(home, { recursive: true, force: true });
  }
});

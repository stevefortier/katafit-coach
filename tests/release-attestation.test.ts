import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  verifyProvenance,
  verifyProvenanceFile,
} from "../src/release/manifest.js";
const revision = "a".repeat(40);
function expected(path: string) {
  return [
    "attestation",
    "verify",
    path,
    "--repo",
    "stevefortier/katafit-coach",
    "--signer-workflow",
    "stevefortier/katafit-coach/.github/workflows/release.yml",
    "--source-ref",
    "refs/heads/main",
    "--source-digest",
    revision,
    "--deny-self-hosted-runners",
  ];
}
test("provenance runner preserves exact trust arguments, byte subject and bounded options; failure propagates and cleans subject", async () => {
  const bytes = Buffer.from("original\0subject"),
    failure = Error("verifier rejected");
  let path = "";
  let calls = 0;
  await assert.rejects(
    verifyProvenance(bytes, revision, async (file, args, options) => {
      calls++;
      path = args[2];
      assert.equal(file, "gh");
      assert.deepEqual(args, expected(path));
      assert.deepEqual(options, { timeout: 30000, maxBuffer: 65536 });
      assert.deepEqual(await readFile(path), bytes);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      throw failure;
    }),
    (e) => e === failure,
  );
  assert.equal(calls, 1);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await verifyProvenanceFile(
    "/fixed/artifact",
    revision,
    async (file, args, options) => {
      calls++;
      assert.equal(file, "gh");
      assert.deepEqual(args, expected("/fixed/artifact"));
      assert.deepEqual(options, { timeout: 30000, maxBuffer: 65536 });
    },
  );
  assert.equal(calls, 2);
});
for (const overflow of [false, true])
  test(`ordinary nonrelease default attestation retains execFile ${overflow ? "stdout limit" : "success"} behavior without ownership`, async () => {
    const state = await mkdtemp("/dev/shm/native-final-default-");
    const script = String.raw`
  const cp=await import('node:child_process'),fs=await import('node:fs'),mod=await import('node:module');
  const original=cp.default.execFile;
  cp.default.execFile=(file,args,options,callback)=>{
   if(file!=='gh')throw Error('real executable forbidden');
   fs.writeFileSync(process.argv[1],JSON.stringify({file,args,options}));
   return original(process.execPath,['-e',process.argv[3]==='true'?'process.stdout.write("x".repeat(65537))':'process.stdout.write("verified")'],options,callback);
  };
  mod.syncBuiltinESMExports();
  const {verifyProvenanceFile}=await import(process.argv[2]);
  try{await verifyProvenanceFile('/fixed/artifact','a'.repeat(40));process.stdout.write('accepted');}
  catch(e){process.stdout.write(e.code);}
 `;
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script,
          join(state, "execution.json"),
          new URL("../src/release/manifest.ts", import.meta.url).href,
          String(overflow),
        ],
        { timeout: 5000 },
      );
      assert.equal(
        stdout,
        overflow ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : "accepted",
      );
      const record = JSON.parse(
        await readFile(join(state, "execution.json"), "utf8"),
      );
      assert.equal(record.file, "gh");
      assert.deepEqual(record.args, expected("/fixed/artifact"));
      assert.deepEqual(record.options, { timeout: 30000, maxBuffer: 65536 });
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });

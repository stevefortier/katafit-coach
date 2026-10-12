import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { releasePresenceFixture } from "./release-presence-fixture.mjs";
const exec = promisify(execFile);
const docker = async (...args) =>
  (await exec("docker", args, { timeout: 30000 })).stdout.trim();
const baseline = process.env.COACH_HARNESS_BASELINE_DIR;
const command = baseline
  ? async (file, args, options) => execFileSync(file, args, options)
  : (await import("./release-command.mjs")).command;
const ownership = baseline ? null : await import("./release-image-owner.mjs");
const inputImage = (
  await readFile("/dev/shm/coach-upgrade-8f43f16-artifacts/image-id", "utf8")
).trim();
const oldCleanup =
  baseline &&
  new Function(
    "return Object.getPrototypeOf(async function(){}).constructor",
  )()(
    "root",
    "home",
    "imagesBeforeBuild",
    "failure",
    "execFileSync",
    "phase",
    "readFile",
    "rm",
    "assert",
    "join",
    (await readFile(join(baseline, "release-chain-smoke.mjs"), "utf8"))
      .split("  const changedImage = await readFile(")[1]
      .replace(/}\s*$/, "")
      .replace(/^/, "  const changedImage = await readFile("),
  );
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );

// A real separate-process Worker must heartbeat while the driver's command is
// held on HTTP served by this same process. No elapsed time qualifies success.
test(
  "held subprocess leaves real Worker heartbeat and Stop RPCs responsive",
  { timeout: 20000 },
  async () => {
    const f = releasePresenceFixture();
    await new Promise((r) => f.server.listen(0, "127.0.0.1", r));
    let releaseHeartbeat;
    const heartbeat = new Promise((r) => {
      releaseHeartbeat = r;
    });
    let held = false;
    f.server.on("request", (req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("finish", () => {
        const msg = JSON.parse(raw);
        if (
          held &&
          msg.params?.name === "coach_report_worker_presence" &&
          msg.params.arguments.state === "running"
        )
          releaseHeartbeat();
      });
    });
    const control = createServer(async (_req, res) => {
      held = true;
      await heartbeat;
      res.end("heartbeat-acknowledged");
    });
    await new Promise((r) => control.listen(0, "127.0.0.1", r));
    const worker = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {Worker} from ${JSON.stringify(pathToFileURL(resolve("dist/worker/runner.js")).href)};
    const worker=new Worker({origin:${JSON.stringify(`http://127.0.0.1:${f.server.address().port}`)},token:'synthetic-release-token',system:'Coach',complete:async()=>'',pollMs:10000,presenceMs:50});
    await worker.start(); console.log('ready');
    process.stdin.once('data',async()=>{await worker.stop();process.stdin.destroy();});
  `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const ended = once(worker, "exit");
    try {
      await once(worker.stdout, "data");
      const output = await command(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const r=await fetch('http://127.0.0.1:${control.address().port}',{signal:AbortSignal.timeout(1500)});console.log(await r.text());`,
        ],
        { encoding: "utf8", timeout: 3000 },
      );
      assert.match(output, /heartbeat-acknowledged/);
      assert.ok(
        f.snapshot().reports.filter((r) => r.state === "running").length >= 2,
      );
    } finally {
      releaseHeartbeat();
      worker.stdin.end("stop");
      const timer = setTimeout(() => worker.kill("SIGKILL"), 5000);
      await ended;
      clearTimeout(timer);
      control.closeAllConnections();
      f.server.closeAllConnections();
      await Promise.all([
        new Promise((r) => control.close(r)),
        new Promise((r) => f.server.close(r)),
      ]);
    }
    const rows = f.snapshot().reports;
    assert.equal(rows.at(-1).state, "stopped");
    assert.equal(rows.at(-1).accepted, true);
    assert.equal(
      rows.at(-1).generation,
      rows.filter((r) => r.state === "running").at(-1).issuedGeneration,
    );
  },
);

async function imageFixture(run, { teardownDocker = docker } = {}) {
  const root = await mkdtemp(join(tmpdir(), "coach-harness-fault-"));
  const home = join(root, "home");
  await mkdir(join(home, "native-artifacts"), { recursive: true });
  const build = { revision: "a".repeat(40), fingerprint: "b".repeat(64) };
  const before = new Set(
    (await docker("image", "ls", "--all", "--no-trunc", "--quiet")).split("\n"),
  );
  const recordPath = join(root, "image-owner.json");
  const record = baseline
    ? {
        marker: randomUUID(),
        revision: build.revision,
        fingerprint: build.fingerprint,
      }
    : await ownership.beginImageBuild(recordPath, {
        build,
        inputImage,
        imagesBeforeBuild: before,
      });
  if (baseline) await writeFile(recordPath, JSON.stringify(record));
  await writeFile(
    join(root, "Dockerfile"),
    `FROM scratch\nLABEL fit.kata.native.revision=${build.revision} fit.kata.native.fingerprint=${build.fingerprint}\n`,
  );
  await docker(
    "build",
    "--label",
    `fit.kata.fixture.owner=${record.marker}`,
    "--iidfile",
    join(root, "changed-image"),
    root,
  );
  const image = (await readFile(join(root, "changed-image"), "utf8")).trim();
  const tag = `coach-harness-fault:${record.marker}`;
  const clean = async () => {
    if (baseline) {
      await oldCleanup(
        root,
        home,
        before,
        undefined,
        execFileSync,
        () => {},
        readFile,
        rm,
        assert,
        join,
      );
      return { state: "legacy-unrecorded" };
    }
    return ownership.cleanupImageBuild(recordPath, {
      home,
      iidfile: join(root, "changed-image"),
    });
  };
  let observationFailure;
  try {
    await run({
      root,
      home,
      recordPath,
      record,
      image,
      tag,
      clean,
      build,
      before,
    });
  } catch (error) {
    if (error.code === "REGRESSION_IMAGE_OBSERVATION_FAILED")
      observationFailure = error;
    throw error;
  } finally {
    // This test owns the simulated external tag. Remove only that exact tag
    // after checking retention, then its uniquely labelled, unreferenced image.
    try {
      // An inner cleanup (e.g. the second ambiguity image) also needs its marker.
      if (observationFailure) throw observationFailure;
      await removeFaultImage(image, record, build, before, tag, teardownDocker);
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      console.error(
        JSON.stringify({
          regressionCleanup: "rejected",
          root,
          recordPath,
          reason: error.code ?? "REGRESSION_IMAGE_CLEANUP_FAILED",
        }),
      );
      throw error;
    }
  }
}
test("late external tag survives roundtrip rejection and final cleanup", async () => {
  await imageFixture(
    async ({ home, root, recordPath, image, tag, clean, build, before }) => {
      await writeFile(
        join(home, "active.json"),
        JSON.stringify({ revision: "c".repeat(40), image: inputImage }),
      );
      await docker("tag", image, tag);
      const roundtrip = baseline
        ? (
            await import(
              pathToFileURL(join(baseline, "release-image-roundtrip.mjs"))
            )
          ).roundtripChangedImage
        : (await import("./release-image-roundtrip.mjs")).roundtripChangedImage;
      await assert.rejects(
        roundtrip({
          image,
          build,
          root,
          home,
          imagesBeforeBuild: before,
          inputImage,
          recordPath,
        }),
      );
      const outcome = await clean();
      console.log(JSON.stringify({ cleanupOutcome: outcome }));
      assert.equal(
        await docker("image", "inspect", image).then(
          () => true,
          () => false,
        ),
        true,
        "final cleanup must retain externally tagged image",
      );
      assert.equal(outcome.state, "retained");
      assert.equal(
        await exists(recordPath),
        true,
        "rejected ownership evidence survives",
      );
    },
  );
});
test("exported image with missing iidfile is reconciled through durable unique marker", async () => {
  await imageFixture(async ({ root, recordPath, image, clean }) => {
    await rm(join(root, "changed-image"));
    const outcome = await clean();
    console.log(JSON.stringify({ cleanupOutcome: outcome }));
    assert.equal(
      await docker("image", "inspect", image).then(
        () => true,
        () => false,
      ),
      false,
      "missing iidfile cannot silently orphan exported image",
    );
    assert.equal(outcome.state, "removed");
    assert.equal(await exists(recordPath), true);
  });
});

async function removeFaultImage(
  image,
  record,
  build,
  before,
  tag,
  observe = docker,
) {
  const inspect = async () => {
    try {
      const rows = JSON.parse(await observe("image", "inspect", image));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].Id, image);
      return rows;
    } catch (error) {
      if (
        error.code === 1 &&
        !error.killed &&
        !error.signal &&
        error.stderr?.trim() ===
          `Error response from daemon: No such image: ${image}`
      )
        return [];
      throw Object.assign(
        new Error("REGRESSION_IMAGE_OBSERVATION_FAILED", { cause: error }),
        {
          code: "REGRESSION_IMAGE_OBSERVATION_FAILED",
        },
      );
    }
  };
  let found = (await inspect())[0];
  if (!found) return;
  const validate = (row) => {
    assert.equal(row.Id, image);
    assert.equal(before.has(image), false);
    assert.notEqual(image, inputImage);
    assert.equal(row.Os + "/" + row.Architecture, "linux/amd64");
    assert.equal(row.Config.Labels["fit.kata.fixture.owner"], record.marker);
    assert.equal(row.Config.Labels["fit.kata.native.revision"], build.revision);
    assert.equal(
      row.Config.Labels["fit.kata.native.fingerprint"],
      build.fingerprint,
    );
    // Docker's containerd store also attaches a repo digest to our simulated
    // external tag. Only this test-owned reference may be removed in teardown.
    assert.ok(
      (row.RepoDigests ?? []).every(
        (value) =>
          row.RepoTags?.includes(tag) &&
          value === `coach-harness-fault@${image}`,
      ),
    );
    assert.ok((row.RepoTags ?? []).every((value) => value === tag));
  };
  validate(found);
  assert.equal(await docker("ps", "-aq", "--filter", `ancestor=${image}`), "");
  if (found.RepoTags?.includes(tag)) await docker("image", "rm", tag);
  found = (await inspect())[0];
  if (found) {
    validate(found);
    assert.equal(found.RepoTags?.length ?? 0, 0);
    assert.equal(
      await docker("ps", "-aq", "--filter", `ancestor=${image}`),
      "",
    );
    await docker("image", "rm", image);
  }
}
if (!baseline) {
  for (const [name, faultAt, properties] of [
    ["transport", 1, { code: "ECONNRESET", stderr: "connection reset" }],
    ["timeout", 1, { code: 1, killed: true, signal: "SIGTERM" }],
    [
      "daemon",
      1,
      { code: 1, stderr: "Error response from daemon: unavailable" },
    ],
    [
      "transport-after-tag-removal",
      2,
      { code: "ECONNRESET", stderr: "connection reset" },
    ],
  ]) {
    test(
      `regression teardown retains ownership on ${name} inspect failure`,
      { timeout: 30000 },
      async () => {
        const rescue = await mkdtemp(
          join(tmpdir(), "coach-harness-observation-"),
        );
        const archive = join(rescue, "owned-image.tar");
        let fixture,
          inspections = 0,
          tagRemoved = false;
        try {
          const result = await imageFixture(
            async (context) => {
              fixture = context;
              await docker("tag", fixture.image, fixture.tag);
              // Keep only this tiny task-owned image available for exact recovery
              // after a real tag removal, which may also remove the image itself.
              await docker("image", "save", "--output", archive, fixture.image);
            },
            {
              teardownDocker: async (...args) => {
                assert.deepEqual(args, ["image", "inspect", fixture.image]);
                if (++inspections === faultAt) {
                  if (faultAt === 2) {
                    const tags = await docker(
                      "image",
                      "ls",
                      "--format",
                      "{{.Repository}}:{{.Tag}}",
                    );
                    assert.equal(tags.split("\n").includes(fixture.tag), false);
                    tagRemoved = true;
                  }
                  throw Object.assign(
                    new Error(`held ${name} observation failure`),
                    properties,
                  );
                }
                return docker(...args);
              },
            },
          ).then(
            () => ({ rejected: false }),
            (error) => ({ rejected: true, error }),
          );
          const rootRetained = await exists(fixture.root);
          const recordRetained = await exists(fixture.recordPath);
          console.log(
            JSON.stringify({
              observationFault: name,
              cleanupRejected: result.rejected,
              reason: result.error?.code,
              rootRetained,
              recordRetained,
              tagRemoved,
            }),
          );
          assert.equal(
            result.rejected,
            true,
            "failed observation must reject teardown",
          );
          assert.equal(
            result.error.code,
            "REGRESSION_IMAGE_OBSERVATION_FAILED",
          );
          assert.equal(
            rootRetained,
            true,
            "failed observation cannot authorize directory deletion",
          );
          assert.equal(
            recordRetained,
            true,
            "ownership evidence must survive failed observation",
          );
          const bytes = await readFile(fixture.recordPath, "utf8");
          assert.equal(JSON.parse(bytes).marker, fixture.record.marker);
          if (process.env.COACH_REGRESSION_CLEANUP_EVIDENCE)
            await writeFile(
              join(
                process.env.COACH_REGRESSION_CLEANUP_EVIDENCE,
                `${name}-retained-owner.json`,
              ),
              bytes,
              { flag: "wx", mode: 0o600 },
            );
          if (faultAt === 2) assert.equal(tagRemoved, true);
        } finally {
          if (fixture) {
            // Observation is now real again. Restore this exact owned archive if
            // tag removal deleted it, then verify identity before controlled cleanup.
            await docker("image", "load", "--input", archive);
            const found = JSON.parse(
              await docker("image", "inspect", fixture.image),
            )[0];
            assert.equal(found.Id, fixture.image);
            assert.equal(
              found.Config.Labels["fit.kata.fixture.owner"],
              fixture.record.marker,
            );
            await removeFaultImage(
              fixture.image,
              fixture.record,
              fixture.build,
              fixture.before,
              fixture.tag,
            );
            await rm(fixture.root, { recursive: true, force: true });
          }
          await rm(rescue, { recursive: true, force: true });
        }
      },
    );
  }
  test("failed load cannot reuse the preceding removed ownership state", async () => {
    await imageFixture(async ({ root, recordPath, image, clean }) => {
      assert.equal((await clean()).state, "removed");
      const archive = join(root, "missing-archive.tar.gz");
      await assert.rejects(
        ownership.loadOwnedImage
          ? ownership.loadOwnedImage(recordPath, archive)
          : docker("image", "load", "--input", archive),
      );
      const result = await clean();
      assert.equal(result.state, "retained");
      assert.equal(result.reason, "IMAGE_OWNER_UNRESOLVED");
      assert.equal(JSON.parse(await readFile(recordPath, "utf8")).image, image);
      console.log(JSON.stringify({ failedLoadOwnership: result }));
    });
  });
  test("unresolved build retains its durable marker when no image can yet be observed", async () => {
    const root = await mkdtemp(join(tmpdir(), "coach-harness-unresolved-"));
    try {
      const recordPath = join(root, "image-owner.json");
      const record = await ownership.beginImageBuild(recordPath, {
        build: { revision: "a".repeat(40), fingerprint: "b".repeat(64) },
        inputImage,
        imagesBeforeBuild: new Set(),
      });
      const result = await ownership.cleanupImageBuild(recordPath, {
        iidfile: join(root, "missing"),
      });
      assert.equal(result.state, "retained");
      assert.equal(result.reason, "IMAGE_OWNER_UNRESOLVED");
      const retained = JSON.parse(await readFile(recordPath, "utf8"));
      assert.equal(retained.marker, record.marker);
      assert.equal(retained.state, "retained");
      console.log(
        JSON.stringify({
          unresolvedOwnership: retained.marker,
          reason: retained.reason,
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("multiple exact-marker images remain untouched with an ambiguous ownership record", async () => {
    await imageFixture(
      async ({
        root,
        recordPath,
        record,
        image,
        build,
        before,
        tag,
        clean,
      }) => {
        await docker(
          "build",
          "--label",
          `fit.kata.fixture.owner=${record.marker}`,
          "--label",
          "fixture.ambiguity=second",
          "--iidfile",
          join(root, "second-image"),
          root,
        );
        const second = (
          await readFile(join(root, "second-image"), "utf8")
        ).trim();
        try {
          await rm(join(root, "changed-image"));
          const result = await clean();
          assert.equal(result.state, "retained");
          assert.equal(result.reason, "IMAGE_OWNER_AMBIGUOUS");
          for (const id of [image, second])
            assert.equal(
              JSON.parse(await docker("image", "inspect", id))[0].Id,
              id,
            );
          assert.equal(
            JSON.parse(await readFile(recordPath, "utf8")).state,
            "retained",
          );
          console.log(JSON.stringify({ ambiguousOwnership: result }));
        } finally {
          await removeFaultImage(second, record, build, before, tag);
        }
      },
    );
  });
}

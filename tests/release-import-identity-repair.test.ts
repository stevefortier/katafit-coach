import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { once } from "node:events";
import { gzipSync, createGunzip } from "node:zlib";
import {
  loadNativeReleaseImage,
  fileDigest,
  withReleaseOperatorLock,
} from "../src/release/provision.js";
import {
  readNativeArchiveIdentity,
  verifyNativeArchiveInspection,
} from "../src/release/native-identity.js";
import {
  syntheticArchive,
  tar,
  sha256,
  classicArchive,
} from "./helpers/native-import-archive.js";

const absent = (id: string) =>
  Object.assign(Error("recorded absence shape; mocked response"), {
    code: 1,
    stdout: "[]\n",
    stderr: `Error response from daemon: No such image: ${id}\n`,
    killed: false,
    signal: null,
  });
async function fixtureRun(
  run: (f: ReturnType<typeof syntheticArchive>, path: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "identity-review-"));
  try {
    const f = syntheticArchive(),
      path = join(dir, "image.tar.gz");
    await writeFile(path, f.bytes);
    await run(f, path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const damage of [
  "changed-after-validation",
  "truncated",
  "missing",
  "unsupported-layout",
]) {
  test(`B1 archive ${damage} must reject before ANY load, even if mock classic becomes available`, async () => {
    await fixtureRun(async (f, path) => {
      assert.deepEqual(await fileDigest(path, f.bytes.length), {
        size: f.bytes.length,
        sha256: sha256(f.bytes),
      });
      if (damage === "missing") await rm(path);
      else if (damage === "truncated")
        await writeFile(path, f.bytes.subarray(0, -10));
      else if (damage === "changed-after-validation") {
        const b = Buffer.from(f.bytes);
        b[b.length - 5] ^= 1;
        await writeFile(path, b);
      } else {
        const b = gzipSync(
          tar(new Map([["manifest.json", Buffer.from("[]")]])),
        );
        f.m.artifacts[1] = {
          ...f.m.artifacts[1],
          size: b.length,
          sha256: sha256(b),
        };
        await writeFile(path, b);
      }
      let loads = 0;
      const result = await loadNativeReleaseImage(
        f.m,
        path,
        async (_file, args) => {
          if (args[2] === "load") {
            loads++;
            return { stdout: "" };
          }
          if (!loads) throw absent(args.at(-1)!);
          return {
            stdout: JSON.stringify([{ ...f.inspection, Id: f.m.image }]),
          };
        },
      ).then(
        () => "accepted",
        () => "rejected",
      );
      assert.equal(loads, 0);
      assert.equal(result, "rejected");
    });
  });
}

for (const stage of ["classic", "oci"])
  for (const problem of [
    "timeout",
    "transport",
    "malformed",
    "wrong-descriptor",
    "wrong-diffids",
    "almost-absence",
  ]) {
    test(`B2 ${stage} ${problem}: uncertain or contradictory inspect authorizes ZERO load`, async () => {
      await fixtureRun(async (f, path) => {
        let loads = 0;
        const operation = loadNativeReleaseImage(
          f.m,
          path,
          async (_file, args) => {
            if (args[2] === "load") {
              loads++;
              return { stdout: "" };
            }
            const target = args.at(-1)!;
            if (stage === "oci" && target === f.m.image) throw absent(target);
            if (problem === "timeout")
              throw Object.assign(Error("timeout"), {
                code: "ETIMEDOUT",
                killed: true,
              });
            if (problem === "transport") throw Error("cannot connect");
            if (problem === "almost-absence")
              throw {
                ...absent(target),
                stderr: absent(target).stderr + "extra daemon error\n",
              };
            if (problem === "malformed") return { stdout: "not JSON" };
            const i = structuredClone(f.inspection);
            if (stage === "classic") i.Id = f.m.image;
            if (problem === "wrong-descriptor") i.Descriptor.size++;
            if (problem === "wrong-diffids") i.RootFS.Layers.reverse();
            return { stdout: JSON.stringify([i]) };
          },
        );
        const outcome = await operation.then(
          () => "accepted",
          () => "rejected",
        );
        assert.equal(loads, 0);
        assert.equal(outcome, "rejected");
      });
    });
  }

for (const target of ["index.json", "blob"])
  test(`B3 raw high-bit ${target} with rebuilt checksum and signed outer hash rejects`, async () => {
    await fixtureRun(async (f, path) => {
      const bytes = tar(f.entries);
      for (let offset = 0; offset < bytes.length - 1024; ) {
        const header = bytes.subarray(offset, offset + 512);
        const name = header.subarray(0, 100).toString().split("\0")[0];
        if (
          target === name ||
          (target === "blob" && name.startsWith("blobs/"))
        ) {
          header[0] |= 0x80;
          header.fill(32, 148, 156);
          header.write(
            [...header]
              .reduce((a, b) => a + b, 0)
              .toString(8)
              .padStart(6, "0") + "\0 ",
            148,
          );
          break;
        }
        offset +=
          512 +
          Math.ceil(parseInt(header.subarray(124, 136).toString(), 8) / 512) *
            512;
      }
      const changed = gzipSync(bytes);
      await writeFile(path, changed);
      f.m.artifacts[1] = {
        ...f.m.artifacts[1],
        size: changed.length,
        sha256: sha256(changed),
      };
      await assert.rejects(readNativeArchiveIdentity(path, f.m));
    });
  });

for (const value of [false, 0, null, []])
  test(`B4 invalid config variant type ${JSON.stringify(value)} rejects with rehashed descriptors`, async () => {
    await fixtureRun(async (_f, path) => {
      const f = syntheticArchive({
        config: (c) => {
          c.variant = value;
        },
      });
      await writeFile(path, f.bytes);
      await assert.rejects(readNativeArchiveIdentity(path, f.m));
    });
  });
for (const [field, value] of [
  ["Os", ["linux"]],
  ["Architecture", ["amd64"]],
  ["Variant", false],
  ["Variant", 0],
  ["Variant", null],
  ["OsVersion", null],
] as const) {
  test(`B4 invalid inspect ${field}=${JSON.stringify(value)} rejects`, async () => {
    await fixtureRun(async (f, path) => {
      const proof = await readNativeArchiveIdentity(path, f.m);
      assert.throws(() =>
        verifyNativeArchiveInspection(
          proof,
          JSON.stringify([{ ...f.inspection, [field]: value }]),
        ),
      );
    });
  });
}

for (const mode of ["cancel", "deadline"])
  test(
    `B5 held actual source read ${mode} settles pipeline and closes descriptor`,
    { timeout: 3000 },
    async (t) => {
      await fixtureRun(async (f, path) => {
        const handle = await open(path, "r");
        const prototype = Object.getPrototypeOf(handle);
        await handle.close();
        const controller = new AbortController();
        const events: string[] = [];
        let entered!: () => void;
        const requested = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const held = new Readable({
          read() {
            events.push("read-requested");
            entered();
          },
        });
        const closed = once(held, "close").catch(() => {});
        held.on("close", () => events.push("source-closed"));
        const original = prototype.createReadStream;
        const mock = t.mock.method(prototype, "createReadStream", function () {
          return held;
        });
        let settled = false;
        const operation = readNativeArchiveIdentity(path, f.m, {
          signal: controller.signal,
          timeoutMs: mode === "deadline" ? 30 : 1000,
        })
          .then(
            () => ({ error: "accepted" }),
            (e) => ({ error: e.message }),
          )
          .finally(() => {
            settled = true;
            events.push("operation-settled");
          });
        await requested;
        if (mode === "cancel") {
          events.push("cancel-requested");
          controller.abort();
        }
        let timer: ReturnType<typeof setTimeout>;
        const watchdog = new Promise<{ error: string }>((resolve) => {
          timer = setTimeout(
            () => resolve({ error: "WATCHDOG: operation did not settle" }),
            300,
          );
        });
        try {
          const result = await Promise.race([operation, watchdog]);
          assert.match(
            result.error,
            mode === "cancel" ? /CANCELLED/ : /TIMEOUT/,
          );
          assert.equal(settled, true);
          await closed;
          assert.ok(events.includes("source-closed"));
          t.diagnostic(JSON.stringify(events));
        } finally {
          clearTimeout(timer!);
          held.destroy(Error("test cleanup"));
          await operation;
          mock.mock.restore();
          assert.equal(prototype.createReadStream, original);
        }
      });
    },
  );

for (const stage of ["source", "decompression"])
  for (const cause of ["cancel", "deadline"]) {
    test(
      `B5 ${stage} ${cause}: held pipeline rejects loader with ZERO calls, closes fd, releases actual flock`,
      { timeout: 4000 },
      async (t) => {
        await fixtureRun(async (f, path) => {
          const state = join(path, "..");
          const sample = await open(path, "r");
          const prototype = Object.getPrototypeOf(sample);
          await sample.close();
          const realCreate = prototype.createReadStream;
          let archiveHandle: Awaited<ReturnType<typeof open>> | undefined;
          const events: string[] = [];
          let enter!: () => void;
          const entered = new Promise<void>((resolve) => {
            enter = resolve;
          });
          let held: Readable | undefined;
          const mock = t.mock.method(
            prototype,
            "createReadStream",
            function (this: any, ...args: any[]) {
              archiveHandle = this;
              const stream =
                stage === "source"
                  ? new Readable({
                      read() {
                        events.push("source-read-requested");
                        enter();
                      },
                    })
                  : realCreate.apply(this, args);
              held = stream;
              stream.on("close", () => events.push("source-closed"));
              return stream;
            },
          );
          const decoder = createGunzip();
          const decoderPrototype = Object.getPrototypeOf(decoder);
          decoder.destroy();
          const decodeMock =
            stage === "decompression"
              ? t.mock.method(decoderPrototype, "_transform", function () {
                  events.push("decompression-write-held");
                  enter();
                })
              : undefined;
          const controller = new AbortController();
          let calls = 0,
            loads = 0,
            timer: ReturnType<typeof setTimeout>;
          const operation = withReleaseOperatorLock(state, async () => {
            events.push("lock-acquired");
            return loadNativeReleaseImage(
              f.m,
              path,
              async (_file, args) => {
                calls++;
                if (args[2] === "load") loads++;
                throw Error("must not reach daemon");
              },
              {
                signal: controller.signal,
                timeoutMs: cause === "deadline" ? 60 : 1500,
              },
            );
          })
            .then(
              () => "accepted",
              (e) => e.message,
            )
            .finally(() => events.push("lock-operation-settled"));
          const watchdog = new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve("WATCHDOG"), 1000);
          });
          try {
            await entered;
            await assert.rejects(
              withReleaseOperatorLock(state, async () => {}),
              /RELEASE_BUSY/,
            );
            events.push("contender-refused");
            if (cause === "cancel") {
              events.push("cancel-requested");
              controller.abort();
            }
            assert.match(
              await Promise.race([operation, watchdog]),
              cause === "cancel" ? /CANCELLED/ : /TIMEOUT/,
            );
            assert.equal(calls, 0);
            assert.equal(loads, 0);
            assert.ok(events.includes("source-closed"));
            assert.ok(archiveHandle);
            await assert.rejects(archiveHandle!.stat(), { code: "EBADF" });
            events.push("archive-fd-closed");
            await withReleaseOperatorLock(state, async () => {
              events.push("lock-reacquired");
            });
            t.diagnostic(JSON.stringify({ events, calls, loads }));
          } finally {
            clearTimeout(timer!);
            controller.abort();
            held?.destroy(Error("test cleanup"));
            await operation;
            mock.mock.restore();
            decodeMock?.mock.restore();
          }
        });
      },
    );
  }

for (const family of ["oci", "classic"]) {
  test(`B1/B2 ${family} valid signed gzip loads only after exact absence and lost reply reconciles without replay`, async (t) => {
    await fixtureRun(async (_f, path) => {
      const f = family === "classic" ? classicArchive() : syntheticArchive();
      await writeFile(path, f.bytes);
      let loaded = false,
        loads = 0,
        inspections = 0;
      const run = async (_file: string, args: string[]) => {
        if (args[2] === "load") {
          loads++;
          loaded = true;
          throw Error("dropped mock reply");
        }
        inspections++;
        const target = args.at(-1)!;
        if (!loaded || target !== f.inspection.Id) throw absent(target);
        return { stdout: JSON.stringify([f.inspection]) };
      };
      await assert.rejects(
        loadNativeReleaseImage(f.m, path, run),
        /dropped mock reply/,
      );
      assert.equal(loads, 1);
      assert.equal(
        (await loadNativeReleaseImage(f.m, path, run)).selectedImage,
        f.inspection.Id,
      );
      assert.equal(loads, 1);
      // Reconciliation uncertainty after a lost reply must never replay load.
      await assert.rejects(
        loadNativeReleaseImage(f.m, path, async (_file, args) => {
          if (args[2] === "load") {
            loads++;
            return { stdout: "" };
          }
          if (family === "oci" && args.at(-1) === f.m.image)
            throw absent(f.m.image);
          throw Object.assign(Error("reconcile timeout"), {
            code: "ETIMEDOUT",
          });
        }),
        /reconcile timeout/,
      );
      assert.equal(loads, 1);
      // An existing exact classic image is no permission to skip byte integrity.
      const corrupted = Buffer.from(f.bytes);
      corrupted[corrupted.length - 5] ^= 1;
      await writeFile(path, corrupted);
      let unexpectedCalls = 0;
      await assert.rejects(
        loadNativeReleaseImage(f.m, path, async () => {
          unexpectedCalls++;
          return { stdout: JSON.stringify([f.inspection]) };
        }),
      );
      assert.equal(unexpectedCalls, 0);
      t.diagnostic(
        JSON.stringify({
          family,
          loads,
          inspections,
          corruptArchiveDaemonCalls: unexpectedCalls,
        }),
      );
    });
  });
}

for (const field of [
  "os",
  "architecture",
  "variant",
  "os.version",
  "os.features",
])
  for (const value of [false, 0, null, []]) {
    if (field === "os.features" && Array.isArray(value)) continue; // explicitly allowed empty feature list
    test(`B4 typed config ${field}=${JSON.stringify(value)} fails before load`, async () => {
      await fixtureRun(async (_f, path) => {
        const f = syntheticArchive({
          config: (c) => {
            c[field] = value;
          },
        });
        await writeFile(path, f.bytes);
        let loads = 0;
        await assert.rejects(
          loadNativeReleaseImage(f.m, path, async (_file, args) => {
            if (args[2] === "load") loads++;
            throw absent(args.at(-1)!);
          }),
        );
        assert.equal(loads, 0);
      });
    });
  }

test("B4 explicitly supported empty/absent platform qualifiers preserve OCI proof", async () => {
  await fixtureRun(async (_f, path) => {
    const f = syntheticArchive({
      config: (c) => {
        c.variant = "";
        c["os.version"] = "";
        c["os.features"] = [];
      },
    });
    await writeFile(path, f.bytes);
    const proof = await readNativeArchiveIdentity(path, f.m);
    assert.equal(
      verifyNativeArchiveInspection(
        proof,
        JSON.stringify([{ ...f.inspection, Variant: "", OsVersion: "" }]),
      ),
      f.inspection.Id,
    );
  });
});

for (const damage of [
  "read-error",
  "rehashed-truncated-tar",
  "wrong-signed-hash",
]) {
  test(`B1 ${damage} is fatal before ANY daemon call`, async (t) => {
    await fixtureRun(async (f, path) => {
      let restore: (() => void) | undefined,
        calls = 0,
        loads = 0;
      if (damage === "read-error") {
        const h = await open(path, "r"),
          proto = Object.getPrototypeOf(h);
        await h.close();
        const mocked = t.mock.method(
          proto,
          "createReadStream",
          () =>
            new Readable({
              read() {
                this.destroy(
                  Object.assign(Error("injected source EIO"), { code: "EIO" }),
                );
              },
            }),
        );
        restore = () => mocked.mock.restore();
      } else if (damage === "rehashed-truncated-tar") {
        const bytes = gzipSync(tar(f.entries).subarray(0, -512));
        await writeFile(path, bytes);
        f.m.artifacts[1] = {
          ...f.m.artifacts[1],
          size: bytes.length,
          sha256: sha256(bytes),
        };
      } else f.m.artifacts[1].sha256 = "0".repeat(64);
      try {
        await assert.rejects(
          loadNativeReleaseImage(f.m, path, async (_file, args) => {
            calls++;
            if (args[2] === "load") loads++;
            return {
              stdout: JSON.stringify([{ ...f.inspection, Id: f.m.image }]),
            };
          }),
        );
        assert.equal(calls, 0);
        assert.equal(loads, 0);
      } finally {
        restore?.();
      }
    });
  });
}

for (const family of ["oci", "classic"])
  for (const field of ["Os", "Architecture", "Variant", "OsVersion"])
    for (const value of [false, 0, null, []]) {
      test(`B4 ${family} inspect ${field}=${JSON.stringify(value)} cannot authorize load`, async () => {
        await fixtureRun(async (_f, path) => {
          const f =
            family === "classic" ? classicArchive() : syntheticArchive();
          await writeFile(path, f.bytes);
          let loads = 0;
          await assert.rejects(
            loadNativeReleaseImage(f.m, path, async (_file, args) => {
              if (args[2] === "load") {
                loads++;
                return { stdout: "" };
              }
              if (family === "oci" && args.at(-1) === f.m.image)
                throw absent(f.m.image);
              return {
                stdout: JSON.stringify([{ ...f.inspection, [field]: value }]),
              };
            }),
          );
          assert.equal(loads, 0);
        });
      });
    }

for (const field of ["mediaType", "digest", "size"])
  for (const value of [false, 0, null, []]) {
    test(`B4 OCI descriptor ${field}=${JSON.stringify(value)} cannot authorize load`, async () => {
      await fixtureRun(async (_f, path) => {
        const f = syntheticArchive({
          index: (i) => {
            i.manifests[0][field] = value;
          },
        });
        await writeFile(path, f.bytes);
        let calls = 0;
        await assert.rejects(
          loadNativeReleaseImage(f.m, path, async () => {
            calls++;
            throw Error("must not inspect");
          }),
        );
        assert.equal(calls, 0);
      });
    });
  }

for (const alteration of [
  "wrong-id",
  "wrong-code",
  "killed",
  "signal",
  "stdout",
  "missing-fields",
  "coerced-killed",
]) {
  test(`B2 absence lookalike ${alteration} cannot authorize load`, async () => {
    await fixtureRun(async (f, path) => {
      let loads = 0;
      await assert.rejects(
        loadNativeReleaseImage(f.m, path, async (_file, args) => {
          if (args[2] === "load") {
            loads++;
            return { stdout: "" };
          }
          const e: any = absent(args.at(-1)!);
          if (alteration === "wrong-id")
            e.stderr = absent("sha256:" + "f".repeat(64)).stderr;
          if (alteration === "wrong-code") e.code = "1";
          if (alteration === "killed") e.killed = true;
          if (alteration === "signal") e.signal = "SIGTERM";
          if (alteration === "stdout") e.stdout = "unrelated image";
          if (alteration === "missing-fields") delete e.killed;
          if (alteration === "coerced-killed") e.killed = 0;
          throw e;
        }),
      );
      assert.equal(loads, 0);
    });
  });
}

test("B2 successful transport without stdout is malformed, never absence", async () => {
  await fixtureRun(async (f, path) => {
    let loads = 0;
    await assert.rejects(
      loadNativeReleaseImage(f.m, path, async (_file, args) => {
        if (args[2] === "load") loads++;
        return {} as any;
      }),
    );
    assert.equal(loads, 0);
  });
});

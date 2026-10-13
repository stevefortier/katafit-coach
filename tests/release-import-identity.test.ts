import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureNativeReleaseBinding,
  loadNativeReleaseImage,
} from "../src/release/provision.js";
import { nativeImage } from "../src/sandbox/artifact.js";
import {
  readNativeArchiveIdentity,
  verifyNativeArchiveInspection,
} from "../src/release/native-identity.js";
import {
  syntheticArchive,
  classicArchive,
  noSuchImage,
  sha256,
  tar,
} from "./helpers/native-import-archive.js";
import { gzipSync } from "node:zlib";

const saved = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/native-import-identity/docker-inspect.json",
      import.meta.url,
    ),
    "utf8",
  ),
)[0];
const published =
  "sha256:084e2d041325469f4a375a1d4c88ee47c96a9e285289307eca5955fd0686bdf6";
const revision = saved.Config.Labels["fit.kata.native.revision"];
const fingerprint = saved.Config.Labels["fit.kata.native.fingerprint"];
const relation = {
  kind: "oci-archive-v1",
  publishedImage: published,
  archiveSha256:
    "8255e76c436bbbd9aba622598dc22ac5e9566d63ac020cb3bd69b7296777fec3",
  manifest: saved.Descriptor,
  config: JSON.parse(
    await readFile(
      new URL(
        "./fixtures/native-import-identity/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).config,
};

test("fresh binding keeps signed config identity but provisions the proven runnable OCI ID (mocked daemon/probe)", async () => {
  const folder = await mkdtemp(join(tmpdir(), "coach-import-identity-"));
  const root = join(folder, "app"),
    home = join(folder, "home");
  const priorPath = process.env.PATH;
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({ revision, fingerprint, protocol: 2 }),
    );
    // RED guard: old code lacks the injected boundary. Never reach a real Docker
    // binary even on the unmodified implementation; this is a mocked control.
    await mkdir(join(folder, "bin"));
    await writeFile(
      join(folder, "bin", "docker"),
      `#!${process.execPath}
const id = process.argv.at(-1);
if (id === ${JSON.stringify(saved.Id)}) { process.stdout.write(${JSON.stringify(JSON.stringify([saved]))}); }
else { process.stderr.write('Error response from daemon: No such image: ' + id + '\\n'); process.exitCode = 1; }
`,
      { mode: 0o700 },
    );
    process.env.PATH = join(folder, "bin") + ":" + priorPath;
    const inspect = async (_file: string, args: string[]) => {
      assert.equal(args[0], "--host=unix:///var/run/docker.sock");
      assert.equal(args.at(-1), saved.Id);
      return { stdout: JSON.stringify([saved]) };
    };
    let probes = 0;
    const selected = await ensureNativeReleaseBinding(
      home,
      root,
      published,
      async () => ({ selectedImage: saved.Id, identity: relation }),
      async () => {},
      undefined,
      {
        inspect,
        probe: async () => {
          probes++;
          return saved.Id;
        },
      },
    );
    assert.deepEqual(selected, {
      selectedImage: saved.Id,
      publishedImage: published,
      binding: "provisioned",
      identity: relation,
    });
    assert.equal(probes, 1);
    const receipt = JSON.parse(
      await readFile(
        join(home, "native-artifacts", revision + ".json"),
        "utf8",
      ),
    );
    assert.equal(receipt.image, saved.Id);
    assert.deepEqual(receipt.releaseIdentity, relation);
    assert.equal(await nativeImage(home, root, inspect), saved.Id);
    const resumed = await ensureNativeReleaseBinding(
      home,
      root,
      published,
      async () => {
        throw Error("must not reload");
      },
      async () => {},
      selected,
      {
        inspect,
        probe: async () => {
          throw Error("must not reprobe ready binding");
        },
      },
    );
    assert.deepEqual(resumed, selected);
    await assert.rejects(
      nativeImage(home, root, async () => ({
        stdout: JSON.stringify([
          { ...saved, Descriptor: { ...saved.Descriptor, size: 1 } },
        ]),
      })),
    );
    for (const invalid of [
      null,
      { ...relation, config: { ...relation.config, digest: saved.Id } },
      { ...relation, manifest: { ...relation.manifest, digest: published } },
    ]) {
      await writeFile(
        join(home, "native-artifacts", revision + ".json"),
        JSON.stringify({ ...receipt, releaseIdentity: invalid }),
        { mode: 0o600 },
      );
      await assert.rejects(nativeImage(home, root, inspect));
    }
  } finally {
    process.env.PATH = priorPath;
    await rm(folder, { recursive: true, force: true });
  }
});

test("saved real Docker descriptor binds byte-exact saved manifest/config; hostile inspection controls reject", async () => {
  const manifestBytes = await readFile(
    new URL("./fixtures/native-import-identity/manifest.json", import.meta.url),
  );
  const configBytes = await readFile(
    new URL("./fixtures/native-import-identity/config.json", import.meta.url),
  );
  assert.equal("sha256:" + sha256(manifestBytes), saved.Id);
  assert.equal("sha256:" + sha256(configBytes), published);
  const manifest = JSON.parse(manifestBytes.toString()),
    config = JSON.parse(configBytes.toString());
  assert.equal(manifestBytes.length, saved.Descriptor.size);
  assert.equal(configBytes.length, manifest.config.size);
  assert.deepEqual(
    manifest.layers.map((l: any) => l.digest),
    config.rootfs.diff_ids,
  );
  const proof = {
    identity: relation,
    platform: "linux/amd64",
    revision,
    fingerprint,
    diffIds: config.rootfs.diff_ids,
  };
  // This checks the saved inspect response, not a new daemon observation.
  assert.equal(
    verifyNativeArchiveInspection(proof, JSON.stringify([saved])),
    saved.Id,
  );
  for (const mutate of [
    (i: any) => {
      i.Id = published;
    },
    (i: any) => {
      delete i.Descriptor;
    },
    (i: any) => {
      i.Descriptor.digest = published;
    },
    (i: any) => {
      i.Descriptor.size++;
    },
    (i: any) => {
      i.Descriptor.mediaType = "application/vnd.oci.image.index.v1+json";
    },
    (i: any) => {
      i.Architecture = "arm64";
    },
    (i: any) => {
      i.Variant = "v8";
    },
    (i: any) => {
      i.RootFS.Layers.reverse();
    },
    (i: any) => {
      i.RootFS.Layers.pop();
    },
    (i: any) => {
      i.RootFS.Layers[0] = published;
    },
    (i: any) => {
      i.Config.Labels["fit.kata.native.revision"] = "f".repeat(40);
    },
  ]) {
    const i = structuredClone(saved);
    mutate(i);
    assert.throws(() =>
      verifyNativeArchiveInspection(proof, JSON.stringify([i])),
    );
  }
  assert.throws(() =>
    verifyNativeArchiveInspection(proof, JSON.stringify([saved, saved])),
  );
  assert.throws(() =>
    verifyNativeArchiveInspection(
      {
        ...proof,
        identity: {
          ...relation,
          config: { ...relation.config, digest: saved.Id },
        },
      },
      JSON.stringify([saved]),
    ),
  );
});

async function withArchive(
  fixture: ReturnType<typeof syntheticArchive>,
  run: (path: string) => Promise<void>,
) {
  const folder = await mkdtemp(join(tmpdir(), "coach-identity-archive-"));
  try {
    const path = join(folder, "archive.tar.gz");
    await writeFile(path, fixture.bytes);
    await run(path);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("synthetic full archive proof and mocked load select manifest; lost load acknowledgement reconciles immutable descriptor", async () => {
  const fixture = syntheticArchive();
  await withArchive(fixture, async (path) => {
    const proof = await readNativeArchiveIdentity(path, fixture.m);
    assert.equal(proof.identity.publishedImage, fixture.m.image);
    assert.equal(proof.identity.manifest.digest, fixture.inspection.Id);
    let loaded = false,
      loads = 0;
    const run = async (file: string, args: string[]) => {
      assert.equal(file, "docker");
      assert.equal(args[0], "--host=unix:///var/run/docker.sock");
      if (args[2] === "load") {
        loaded = true;
        loads++;
        // Not an authority: intentionally misleading mocked stdout.
        return {
          stdout:
            "Loaded image: mutable:tag\nLoaded image ID: " + fixture.m.image,
        };
      }
      const target = args.at(-1);
      assert.ok([fixture.m.image, fixture.inspection.Id].includes(target!));
      if (target === fixture.m.image || !loaded) throw noSuchImage(target!);
      return { stdout: JSON.stringify([fixture.inspection]) };
    };
    const selected = await loadNativeReleaseImage(fixture.m, path, run);
    assert.equal(selected.selectedImage, fixture.inspection.Id);
    assert.deepEqual(selected.identity, proof.identity);
    assert.equal(loads, 1);
    assert.deepEqual(
      await loadNativeReleaseImage(fixture.m, path, run),
      selected,
    );
    assert.equal(loads, 1);
    // Actual control of a lost mocked load reply: state changes, call rejects,
    // and the next attempt must inspect the proven digest without a second load.
    loaded = false;
    loads = 0;
    const dropped = async (file: string, args: string[]) => {
      const result = await run(file, args);
      if (args[2] === "load") throw Error("mock dropped load acknowledgement");
      return result;
    };
    await assert.rejects(
      loadNativeReleaseImage(fixture.m, path, dropped),
      /dropped load acknowledgement/,
    );
    assert.deepEqual(
      await loadNativeReleaseImage(fixture.m, path, dropped),
      selected,
    );
    assert.equal(loads, 1);
  });
});

test("legacy exact config-ID load requires a valid signed classic gzip archive (mocked classic store)", async () => {
  const fixture = classicArchive();
  const folder = await mkdtemp(join(tmpdir(), "classic-archive-"));
  try {
    const path = join(folder, "classic.tar.gz");
    await writeFile(path, fixture.bytes);
    let loaded = false,
      loads = 0;
    const run = async (_file: string, args: string[]) => {
      if (args[2] === "load") {
        loaded = true;
        loads++;
        return { stdout: "" };
      }
      assert.equal(args.at(-1), fixture.m.image);
      if (!loaded) throw noSuchImage(fixture.m.image);
      return { stdout: JSON.stringify([fixture.inspection]) };
    };
    const selected = await loadNativeReleaseImage(fixture.m, path, run);
    assert.deepEqual(selected, { selectedImage: fixture.m.image });
    assert.equal(loads, 1);
    assert.deepEqual(
      await loadNativeReleaseImage(fixture.m, path, run),
      selected,
    );
    assert.equal(loads, 1);
    await assert.rejects(
      loadNativeReleaseImage(fixture.m, path, async () => ({
        stdout: JSON.stringify({ 0: fixture.inspection, length: 1 }),
      })),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

const hostileArchives: [string, Parameters<typeof syntheticArchive>[0]][] = [
  [
    "wrong config descriptor",
    {
      manifest: (m) => {
        m.config = { ...m.config, digest: "sha256:" + "f".repeat(64) };
      },
    },
  ],
  [
    "wrong manifest descriptor",
    {
      index: (i) => {
        i.manifests[0].digest = "sha256:" + "f".repeat(64);
      },
    },
  ],
  [
    "wrong descriptor size",
    {
      index: (i) => {
        i.manifests[0].size++;
      },
    },
  ],
  [
    "multiple manifests",
    {
      index: (i) => {
        i.manifests.push(i.manifests[0]);
      },
    },
  ],
  [
    "index target instead of runnable manifest",
    {
      index: (i) => {
        i.manifests[0].mediaType = "application/vnd.oci.image.index.v1+json";
      },
    },
  ],
  [
    "wrong platform with rehashed config",
    {
      config: (c) => {
        c.architecture = "arm64";
      },
    },
  ],
  [
    "platform variant",
    {
      config: (c) => {
        c.variant = "v8";
      },
    },
  ],
  [
    "wrong labels with rehashed config",
    {
      config: (c) => {
        c.config.Labels["fit.kata.native.fingerprint"] = "c".repeat(64);
      },
    },
  ],
  [
    "wrong ordered DiffIDs with rehashed config",
    {
      config: (c) => {
        c.rootfs.diff_ids.reverse();
      },
    },
  ],
  [
    "missing layer",
    {
      entries: (e) => {
        for (const [k, v] of e)
          if (v.toString() === "synthetic layer one") e.delete(k);
      },
    },
  ],
  [
    "wrong layer bytes",
    {
      entries: (e) => {
        for (const [k, v] of e)
          if (v.toString() === "synthetic layer one")
            e.set(k, Buffer.from("synthetic layer bad"));
      },
    },
  ],
  [
    "wrong layer size",
    {
      manifest: (m) => {
        m.layers[0].size++;
      },
    },
  ],
  [
    "wrong layer digest",
    {
      manifest: (m) => {
        m.layers[0].digest = m.layers[1].digest;
      },
    },
  ],
  [
    "compressed layer unsupported",
    {
      manifest: (m) => {
        m.layers[0].mediaType += "+gzip";
      },
    },
  ],
  [
    "Docker config disagrees",
    {
      docker: (d) => {
        d[0].Config = d[0].Layers[0];
      },
    },
  ],
  [
    "Docker layer order disagrees",
    {
      docker: (d) => {
        d[0].Layers.reverse();
      },
    },
  ],
  [
    "Docker LayerSources disagrees",
    {
      docker: (d) => {
        Object.values<any>(d[0].LayerSources)[0].size++;
      },
    },
  ],
  [
    "descriptor external URL",
    {
      index: (i) => {
        i.manifests[0].urls = ["https://untrusted.invalid/image"];
      },
    },
  ],
];
for (const [name, change] of hostileArchives)
  test(
    "archive rejects " + name + " (rehashed synthetic control)",
    async () => {
      const fixture = syntheticArchive(change);
      await withArchive(fixture, async (path) => {
        await assert.rejects(
          readNativeArchiveIdentity(path, fixture.m),
          /RELEASE_IMAGE_IDENTITY_REJECTED/,
        );
      });
    },
  );

test("signed archive hash/config fences reject independently of labels; malformed tar fails closed", async () => {
  const fixture = syntheticArchive();
  await withArchive(fixture, async (path) => {
    await assert.rejects(
      readNativeArchiveIdentity(path, {
        ...fixture.m,
        image: "sha256:" + "f".repeat(64),
      }),
    );
    const changed = structuredClone(fixture.m);
    changed.artifacts[1].sha256 = "f".repeat(64);
    await assert.rejects(readNativeArchiveIdentity(path, changed));
  });
  for (const mutate of [
    (b: Buffer) => {
      b[148] ^= 1;
      return b;
    },
    (b: Buffer) => b.subarray(0, b.length - 512),
    (b: Buffer) => Buffer.concat([b, Buffer.alloc(512, 1)]),
    (b: Buffer) => Buffer.concat([b.subarray(0, b.length - 1024), b]),
  ]) {
    const changed = structuredClone(fixture);
    changed.bytes = gzipSync(mutate(tar(fixture.entries)));
    changed.m.artifacts[1] = {
      ...changed.m.artifacts[1],
      size: changed.bytes.length,
      sha256: sha256(changed.bytes),
    };
    await withArchive(changed, async (path) => {
      await assert.rejects(readNativeArchiveIdentity(path, changed.m));
    });
  }
});

test("hostile mocked daemon cannot replace archive proof with matching labels or load output", async () => {
  const fixture = syntheticArchive();
  await withArchive(fixture, async (path) => {
    for (const changes of [
      { Id: fixture.m.image },
      { Descriptor: { ...fixture.inspection.Descriptor, size: 1 } },
      { Architecture: "arm64" },
      { RootFS: { Type: "layers", Layers: [] } },
    ]) {
      await assert.rejects(
        loadNativeReleaseImage(fixture.m, path, async (_file, args) => {
          if (args[2] === "load")
            return { stdout: "Loaded image ID: " + fixture.inspection.Id };
          if (args.at(-1) === fixture.m.image)
            throw noSuchImage(fixture.m.image);
          return {
            stdout: JSON.stringify([{ ...fixture.inspection, ...changes }]),
          };
        }),
      );
    }
  });
});

for (const withIdentity of [false, true])
  for (const activeTarget of [false, true]) {
    test(`protected same-fingerprint receipt reuse preserves authority (identity=${withIdentity}, activeTarget=${activeTarget}; mocked inspect/probe)`, async () => {
      const folder = await mkdtemp(join(tmpdir(), "coach-import-reuse-"));
      const root = join(folder, "app"),
        home = join(folder, "home"),
        target = "e".repeat(40);
      try {
        await mkdir(join(root, "dist"), { recursive: true });
        await mkdir(join(home, "native-artifacts"), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(
          join(root, "dist/build.json"),
          JSON.stringify({ revision: target, fingerprint, protocol: 2 }),
        );
        const receiptPath = join(home, "native-artifacts", revision + ".json");
        const receipt = JSON.stringify({
          revision,
          fingerprint,
          image: saved.Id,
          platform: "linux/amd64",
          ...(withIdentity ? { releaseIdentity: relation } : {}),
        });
        await writeFile(receiptPath, receipt, { mode: 0o600 });
        const active = JSON.stringify({
          revision: activeTarget ? target : revision,
          image: saved.Id,
        });
        await writeFile(join(home, "active.json"), active, { mode: 0o600 });
        let probes = 0;
        const inspect = async () => ({ stdout: JSON.stringify([saved]) });
        const selected = await ensureNativeReleaseBinding(
          home,
          root,
          "sha256:" + "d".repeat(64),
          async () => {
            throw Error("must not load");
          },
          async () => {},
          undefined,
          {
            inspect,
            probe: async () => {
              probes++;
              return saved.Id;
            },
          },
        );
        assert.deepEqual(selected, {
          selectedImage: saved.Id,
          publishedImage: "sha256:" + "d".repeat(64),
          binding: "reused",
        });
        assert.equal(probes, 1);
        assert.equal(await readFile(receiptPath, "utf8"), receipt);
        assert.equal(await readFile(join(home, "active.json"), "utf8"), active);
        await assert.rejects(
          readFile(join(home, "native-artifacts", target + ".json")),
          { code: "ENOENT" },
        );
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });
  }

for (const reason of [
  "active",
  "compatible",
  "corrupt-compatible",
  "changed-during-probe",
  "wrong-active-image",
]) {
  test(`failed existing binding never authorizes fresh replacement: ${reason} (mocked boundary)`, async () => {
    const folder = await mkdtemp(join(tmpdir(), "coach-import-fence-"));
    const root = join(folder, "app"),
      home = join(folder, "home"),
      target = "e".repeat(40);
    try {
      await mkdir(join(root, "dist"), { recursive: true });
      await mkdir(join(home, "native-artifacts"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(root, "dist/build.json"),
        JSON.stringify({ revision: target, fingerprint, protocol: 2 }),
      );
      if (reason !== "active")
        await writeFile(
          join(home, "native-artifacts", revision + ".json"),
          JSON.stringify({
            revision,
            fingerprint,
            image: reason === "corrupt-compatible" ? "mutable:tag" : saved.Id,
            platform: "linux/amd64",
          }),
          { mode: 0o600 },
        );
      if (["active", "wrong-active-image"].includes(reason))
        await writeFile(
          join(home, "active.json"),
          JSON.stringify({
            revision: target,
            image: "sha256:" + "d".repeat(64),
          }),
          { mode: 0o600 },
        );
      let probes = 0,
        loads = 0;
      const inspect = async () => {
        if (reason === "compatible") throw Error("mock daemon unavailable");
        return {
          stdout: JSON.stringify([
            { ...saved, ...(probes ? { Id: published } : {}) },
          ]),
        };
      };
      await assert.rejects(
        ensureNativeReleaseBinding(
          home,
          root,
          published,
          async () => {
            loads++;
          },
          async () => {},
          undefined,
          {
            inspect,
            probe: async () => {
              probes++;
              return saved.Id;
            },
          },
        ),
      );
      assert.equal(loads, 0);
      await assert.rejects(
        readFile(join(home, "native-artifacts", target + ".json")),
        { code: "ENOENT" },
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
}

test("fresh callback cannot substitute an unproven runnable ID; malformed relation is not persisted", async () => {
  for (const identity of [
    undefined,
    { ...relation, config: { ...relation.config, digest: saved.Id } },
    { ...relation, publishedImage: saved.Id },
  ]) {
    const folder = await mkdtemp(join(tmpdir(), "coach-import-unproven-"));
    const root = join(folder, "app"),
      home = join(folder, "home");
    try {
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(
        join(root, "dist/build.json"),
        JSON.stringify({ revision, fingerprint, protocol: 2 }),
      );
      await assert.rejects(
        ensureNativeReleaseBinding(
          home,
          root,
          published,
          async () => ({ selectedImage: saved.Id, identity }),
          async () => {},
          undefined,
          {
            inspect: async () => {
              throw Error("must not inspect unproven selection");
            },
          },
        ),
      );
      await assert.rejects(
        readFile(join(home, "native-artifacts", revision + ".json")),
        { code: "ENOENT" },
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
});

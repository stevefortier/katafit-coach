import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { directory } from "./managed.js";
import { atomicWrite } from "./journal.js";
const name = "update-candidate.json",
  marker = ".update-candidate.json";
type Lease = {
  version: 1;
  sha: string;
  token: string;
  state: "preparing" | "retained" | "removing";
  directory?: { dev: number; ino: number };
};
const unsafe = () => new Error("UPDATE_CLEANUP_PENDING");
async function privateDirectory(path: string) {
  await directory(path);
  for (let p = resolve(path); ; p = dirname(p)) {
    const s = await lstat(p),
      privatePath = p === resolve(path);
    if (
      (privatePath
        ? s.uid !== process.getuid?.()
        : s.uid !== 0 && s.uid !== process.getuid?.()) ||
      ((s.mode & 0o022) !== 0 &&
        !(!privatePath && s.uid === 0 && s.mode & 0o1000))
    )
      throw unsafe();
    if (p === dirname(p)) break;
  }
}
async function read(path: string) {
  await privateDirectory(dirname(path));
  const h = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = await h.stat(),
      p = await lstat(path);
    for (const v of [s, p])
      if (
        !v.isFile() ||
        v.uid !== process.getuid?.() ||
        v.nlink !== 1 ||
        v.mode & 0o022 ||
        v.size > 512
      )
        throw unsafe();
    if (s.ino !== p.ino || s.dev !== p.dev) throw unsafe();
    const bytes = Buffer.alloc(513),
      r = await h.read(bytes, 0, bytes.length, 0);
    if (r.bytesRead > 512) throw unsafe();
    return JSON.parse(bytes.subarray(0, r.bytesRead).toString());
  } finally {
    await h.close();
  }
}
function valid(value: any): Lease {
  if (
    !value ||
    !["sha,state,token,version", "directory,sha,state,token,version"].includes(
      Object.keys(value).sort().join(),
    ) ||
    value.version !== 1 ||
    !/^[a-f0-9]{40}$/.test(value.sha) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      value.token,
    ) ||
    !["preparing", "retained", "removing"].includes(value.state) ||
    (value.state === "removing"
      ? !value.directory ||
        Object.keys(value.directory).sort().join() !== "dev,ino" ||
        !Number.isSafeInteger(value.directory.dev) ||
        !Number.isSafeInteger(value.directory.ino)
      : value.directory !== undefined)
  )
    throw unsafe();
  return value;
}
/** Separate deletion authority. A preparation observation never grants ownership. */
export class CandidateOwnership {
  constructor(readonly home: string) {}
  async read(): Promise<Lease | undefined> {
    try {
      return valid(await read(join(this.home, name)));
    } catch (e: any) {
      if (e.code === "ENOENT") return;
      throw unsafe();
    }
  }
  async clear() {
    await rm(join(this.home, name), { force: true });
    const h = await open(
      this.home,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  }
  async recover() {
    const lease = await this.read();
    if (!lease) return;
    // A published version is retained; it is never an abandoned preparation.
    if (lease.state === "retained") {
      await this.clear();
      return;
    }
    await this.cleanup(lease.sha);
  }
  async begin(sha: string) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw unsafe();
    await this.recover();
    await privateDirectory(this.home);
    await directory(join(this.home, "versions"), true);
    await privateDirectory(join(this.home, "versions"));
    let state: Lease["state"] = "preparing";
    try {
      await lstat(join(this.home, "versions", sha));
      const retained = valid(
        await read(join(this.home, "versions", sha, marker)),
      );
      if (retained.sha !== sha || retained.state !== "retained") throw unsafe();
      state = "retained";
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      // A missing marker in an existing version is not ownership evidence.
      try {
        await lstat(join(this.home, "versions", sha));
        throw unsafe();
      } catch (m: any) {
        if (m.code !== "ENOENT") throw m;
      }
    }
    const lease: Lease = { version: 1, sha, token: randomUUID(), state };
    await atomicWrite(this.home, name, lease);
    return lease.token;
  }
  async mark(path: string, sha: string, token: string) {
    const lease = await this.read();
    if (
      !lease ||
      lease.sha !== sha ||
      lease.token !== token ||
      lease.state !== "preparing"
    )
      throw unsafe();
    await privateDirectory(path);
    await atomicWrite(path, marker, {
      version: 1,
      sha,
      token,
      state: "preparing",
    });
  }
  async retain(sha: string) {
    const lease = await this.read();
    if (!lease || lease.sha !== sha) throw unsafe();
    await atomicWrite(join(this.home, "versions", sha), marker, {
      ...lease,
      state: "retained",
    });
    await atomicWrite(this.home, name, { ...lease, state: "retained" });
  }
  async cleanup(sha: string) {
    const lease = await this.read();
    if (!lease || lease.sha !== sha) throw unsafe();
    if (lease.state === "retained") {
      await this.clear();
      return;
    }
    let active: any;
    try {
      active = await read(join(this.home, "active.json"));
      if (!/^[a-f0-9]{40}$/.test(active.revision)) throw unsafe();
    } catch (e: any) {
      if (e.code !== "ENOENT") throw unsafe();
    }
    if (active?.revision === sha) throw unsafe();
    const path = join(this.home, "versions", sha);
    try {
      await lstat(path);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      await this.clear();
      return;
    }
    await privateDirectory(path);
    const identity = await lstat(path);
    if (lease.state === "removing") {
      if (
        identity.dev !== lease.directory?.dev ||
        identity.ino !== lease.directory?.ino
      )
        throw unsafe();
    } else {
      const owned = valid(await read(join(path, marker)));
      if (owned.sha !== sha || owned.token !== lease.token) throw unsafe();
      if (owned.state === "retained") {
        await this.clear();
        return;
      }
      if (owned.state !== "preparing") throw unsafe();
      // rm may remove the marker before it fails or the owner crashes. Persist
      // the exact protected directory identity before beginning removal.
      await atomicWrite(this.home, name, {
        ...lease,
        state: "removing",
        directory: { dev: identity.dev, ino: identity.ino },
      });
    }
    await rm(path, { recursive: true, force: true });
    await this.clear();
  }
}

import {
  constants,
  mkdirSync,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeFileSync,
  fsyncSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, parse, sep, dirname } from "node:path";
import { captureKey } from "./account.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** Content-free privacy intents. No chat/evidence/token bytes are persisted. */
export class DiscardJournal {
  private readonly origin: string;
  private readonly credential: string;
  constructor(
    private readonly dir: string,
    origin: string,
    token: string,
  ) {
    this.origin = hash(origin);
    this.credential = hash(token);
  }
  private directory() {
    const absolute = resolve(this.dir);
    let path = parse(absolute).root;
    for (const part of absolute.slice(path.length).split(sep)) {
      if (!part) continue;
      path = join(path, part);
      try {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error("UNSAFE_DISCARD_JOURNAL");
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
        mkdirSync(path, { mode: 0o700 });
        const parent = openSync(
          dirname(path),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          fsyncSync(parent);
        } finally {
          closeSync(parent);
        }
      }
    }
  }
  private sync() {
    const fd = openSync(
      this.dir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  private name(key: string) {
    return hash(this.origin + ":" + this.credential + ":" + key) + ".json";
  }
  private bytes(file: string) {
    const fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024)
        throw new Error("UNSAFE_DISCARD_JOURNAL");
      const bytes = Buffer.alloc(1025);
      const size = readSync(fd, bytes, 0, bytes.length, 0);
      if (size > 1024) throw new Error("UNSAFE_DISCARD_JOURNAL");
      return bytes.subarray(0, size).toString("utf8");
    } finally {
      closeSync(fd);
    }
  }
  put(key: string, discovery = false) {
    if (!captureKey(key)) throw new Error("INVALID_DISCARD_KEY");
    this.directory();
    const body = JSON.stringify({
      version: 1,
      origin: this.origin,
      credential: this.credential,
      key,
      discovery,
    });
    const file = join(this.dir, this.name(key));
    let fd: number;
    try {
      fd = openSync(
        file,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      if (this.bytes(file) !== body) throw new Error("UNSAFE_DISCARD_JOURNAL");
      return;
    }
    try {
      writeFileSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.sync();
  }
  pending() {
    this.directory();
    const names = readdirSync(this.dir);
    if (names.length > 256) throw new Error("DISCARD_JOURNAL_LIMIT");
    const keys: string[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name))
        throw new Error("UNSAFE_DISCARD_JOURNAL");
      {
        const v = JSON.parse(this.bytes(join(this.dir, name)));
        if (
          v.version !== 1 ||
          Object.keys(v).sort().join(",") !==
            "credential,discovery,key,origin,version" ||
          typeof v.discovery !== "boolean" ||
          !/^[a-f0-9]{64}$/.test(v.origin) ||
          !/^[a-f0-9]{64}$/.test(v.credential) ||
          !captureKey(v.key)
        )
          throw new Error("UNSAFE_DISCARD_JOURNAL");
        if (v.origin !== this.origin) continue;
        // Never clear an old account's fence with a replacement/foreign bearer.
        // Without verified account rebinding, rotation conservatively blocks recovery.
        if (v.credential !== this.credential)
          throw new Error("DISCARD_REBIND_REQUIRED");
        if (name !== this.name(v.key))
          throw new Error("UNSAFE_DISCARD_JOURNAL");
        if (v.discovery === true)
          throw new Error("DISCARD_DISCOVERY_UNRESOLVED");
        keys.push(v.key);
      }
    }
    return keys;
  }
  remove(key: string) {
    this.directory();
    try {
      unlinkSync(join(this.dir, this.name(key)));
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    this.sync();
  }
}

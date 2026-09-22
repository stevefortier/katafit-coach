import {
  openSync,
  closeSync,
  readSync,
  writeFileSync,
  renameSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  readdirSync,
  fsyncSync,
  unlinkSync,
  constants,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
export type Message = { role: "user" | "assistant"; text: string };
export const MAX_BYTES = 131072;
export function bound(messages: Message[]) {
  const result = messages.slice(-40);
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES)
    result.splice(0, 2);
  return result;
}
function validate(value: unknown): asserts value is Message[] {
  if (
    !Array.isArray(value) ||
    value.length > 40 ||
    value.length % 2 ||
    value.some(
      (m, i) =>
        !m ||
        Object.keys(m).sort().join(",") !== "role,text" ||
        m.role !== (i % 2 ? "assistant" : "user") ||
        typeof m.text !== "string" ||
        !m.text.trim() ||
        m.text.length > (i % 2 ? 32000 : 8000),
    )
  )
    throw new Error("UNSAFE_STORAGE");
}
export class History {
  private path: string;
  constructor(
    private dir: string,
    private filename:
      | "operator-chat.json"
      | "operator-actions.json" = "operator-chat.json",
  ) {
    this.path = resolve(dir, filename);
  }
  private directories() {
    for (let p = resolve(this.dir); ; p = dirname(p)) {
      const info = lstatSync(p);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("UNSAFE_STORAGE");
      if (p === dirname(p)) break;
    }
  }
  private open(): number | undefined {
    this.directories();
    let fd: number;
    try {
      fd = openSync(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (e: any) {
      if (e.code === "ENOENT") return undefined;
      throw e;
    }
    try {
      if (!fstatSync(fd).isFile()) throw new Error("UNSAFE_STORAGE");
      return fd;
    } catch (e) {
      closeSync(fd);
      throw e;
    }
  }
  load(): Message[] {
    this.cleanupTemps();
    const fd = this.open();
    if (fd === undefined) return [];
    try {
      if (fstatSync(fd).size > MAX_BYTES) throw new Error("UNSAFE_STORAGE");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const n = readSync(fd, buffer, size, buffer.length - size, null);
        if (!n) break;
        size += n;
      }
      if (size > MAX_BYTES) throw new Error("UNSAFE_STORAGE");
      const messages: unknown = JSON.parse(
        buffer.subarray(0, size).toString("utf8"),
      );
      validate(messages);
      fchmodSync(fd, 0o600);
      return messages;
    } finally {
      closeSync(fd);
    }
  }
  private cleanupTemps() {
    this.directories();
    // Only names produced by this writer (randomUUID v4), never broad prefixes.
    // Saves are synchronous and the application has a single storage owner.
    for (const name of readdirSync(this.dir)) {
      if (
        !new RegExp(
          `^${this.filename.replace(".", "\\.")}\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
        ).test(name)
      )
        continue;
      const path = resolve(this.dir, name);
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new Error("UNSAFE_STORAGE");
      unlinkSync(path);
    }
  }
  save(messages: Message[]) {
    validate(messages);
    const data = JSON.stringify(messages);
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("UNSAFE_STORAGE");
    this.cleanupTemps();
    const existing = this.open();
    if (existing !== undefined) closeSync(existing);
    const tmp = this.path + "." + randomUUID();
    const fd = openSync(
      tmp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let failed = false;
    try {
      let writeFailed = false;
      try {
        writeFileSync(fd, data);
        fsyncSync(fd);
      } catch (e) {
        writeFailed = true;
        throw e;
      } finally {
        try {
          closeSync(fd);
        } catch (e) {
          if (!writeFailed) throw e;
        }
      }
      const check = this.open();
      if (check !== undefined) closeSync(check);
      renameSync(tmp, this.path);
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      try {
        unlinkSync(tmp);
      } catch (e: any) {
        // Cleanup must not replace the persistence error that caused it.
        if (e.code !== "ENOENT" && !failed) throw e;
      }
    }
  }
}

import { randomBytes } from "node:crypto";

// Private to one discovered request. Never serializable, logged, or persisted.
export class MediaHandles {
  #references = new Map<string, string>();
  #closed = false;
  constructor(private signal: AbortSignal) {
    signal.addEventListener("abort", this.dispose, { once: true });
    if (signal.aborted) this.dispose();
  }
  dispose = () => {
    this.#closed = true;
    this.#references.clear();
    this.signal.removeEventListener("abort", this.dispose);
  };
  resolve(value: unknown): unknown {
    this.assertOpen();
    if (typeof value !== "string" || !value.startsWith("mr:")) return value;
    const original = this.#references.get(value);
    if (!original) throw new Error("ARGUMENTS_REJECTED");
    return original;
  }
  assertOpen() {
    if (this.#closed) throw new Error("READ_UNAVAILABLE");
  }
  private alias(value: unknown): string {
    if (
      this.#closed ||
      typeof value !== "string" ||
      !/^[A-Za-z0-9_-]{1,4096}$/.test(value) ||
      value.startsWith("mr:")
    )
      throw new Error("RESULT_REJECTED");
    for (const [handle, original] of this.#references)
      if (original === value) return handle;
    if (this.#references.size >= 256) throw new Error("RESULT_REJECTED");
    let handle: string;
    do {
      handle = "mr:" + randomBytes(8).toString("hex");
    } while (this.#references.has(handle));
    this.#references.set(handle, value);
    return handle;
  }
  // Only backend-defined DTO paths, never recursive key/text substitution.
  project(name: string, args: any, value: any): any {
    if (this.#closed) throw new Error("READ_UNAVAILABLE");
    const copy = structuredClone(value);
    if (!Array.isArray(copy?.items)) return copy;
    const replace = (item: any) => {
      if (item && typeof item === "object" && Object.hasOwn(item, "media_ref"))
        item.media_ref = this.alias(item.media_ref);
    };
    if (name === "coach_read_activity" && args.section === "media_files")
      copy.items.forEach(replace);
    if (name === "coach_read_conversation")
      for (const item of copy.items)
        if (Array.isArray(item?.attachments)) item.attachments.forEach(replace);
    return copy;
  }
}

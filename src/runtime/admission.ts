/**
 * Shared inference admission: one slot for the request Worker and the
 * continuous Coach together. Requests go first; a waiting autonomy cycle
 * that has aged past `agingMs` (default 10 minutes) goes before any request
 * so a busy Worker cannot starve it.
 */
export type Lane = "request" | "autonomy";
interface Waiter {
  lane: Lane;
  since: number;
  grant: () => void;
}
export class Admission {
  private holder = false;
  private readonly queue: Waiter[] = [];
  private readonly now: () => number;
  private readonly agingMs: number;
  constructor(options: { now?: () => number; agingMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.agingMs = options.agingMs ?? 600_000;
  }
  get busy() {
    return this.holder;
  }
  get waiting() {
    return this.queue.length;
  }

  async run<T>(
    lane: Lane,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.acquire(lane, signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(lane: Lane, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.holder && !this.queue.length) {
      this.holder = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        lane,
        since: this.now(),
        grant: () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
      };
      const abort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release() {
    const next = this.pick();
    if (!next) {
      this.holder = false;
      return;
    }
    this.queue.splice(this.queue.indexOf(next), 1);
    next.grant();
  }

  private pick(): Waiter | undefined {
    const now = this.now();
    return (
      this.queue.find(
        (w) => w.lane === "autonomy" && now - w.since >= this.agingMs,
      ) ??
      this.queue.find((w) => w.lane === "request") ??
      this.queue[0]
    );
  }
}

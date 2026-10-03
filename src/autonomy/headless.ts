import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { NativeGateway } from "../sandbox/gateway.js";
import {
  NATIVE_PROFILES,
  NativeRuntime,
  type NativeProfile,
} from "../sandbox/runtime.js";

export const HEADLESS_ROLE_LABEL = "fit.kata.native.role";
export const HEADLESS_ROLE = "autonomy";
export const HEADLESS_NAME =
  /^katafit-pi-auto-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** One RPC stdout line; larger output ends the cycle. */
export const HEADLESS_LINE_LIMIT = 8 * 1024 * 1024;
// Grace for Pi to acknowledge an abort before the container is removed.
const ABORT_GRACE_MS = 500;

export type HeadlessCode =
  | "HEADLESS_BUSY"
  | "HEADLESS_TIMEOUT"
  | "HEADLESS_ABORTED"
  | "HEADLESS_EXITED"
  | "HEADLESS_PROMPT_REJECTED"
  | "HEADLESS_NO_OUTPUT"
  | "HEADLESS_OUTPUT_TOO_LARGE";
export class HeadlessFailure extends Error {
  constructor(readonly code: HeadlessCode) {
    super(code);
  }
}

type Engine = ConstructorParameters<typeof NativeRuntime>[1] & {};
export interface HeadlessRun {
  profile: NativeProfile;
  gateway: NativeGateway;
  message: string;
  cycleMs: number;
  signal?: AbortSignal;
}

/**
 * Bounded headless native Pi: one network-none container per cycle, driven
 * over Pi's JSONL RPC, always removed. At most one container at a time.
 */
export class HeadlessCycleRuntime {
  private running = false;
  private readonly image: string;
  private readonly engine: Engine;
  constructor(options: { image: string; engine?: Engine }) {
    this.image = options.image;
    this.engine = options.engine ?? {};
  }
  get active() {
    return this.running;
  }

  async run(run: HeadlessRun): Promise<{ text: string; container: string }> {
    if (!NATIVE_PROFILES.includes(run.profile))
      throw new Error("PROFILE_REJECTED");
    if (run.signal?.aborted) throw new HeadlessFailure("HEADLESS_ABORTED");
    if (this.running) throw new HeadlessFailure("HEADLESS_BUSY");
    this.running = true;
    const name = "katafit-pi-auto-" + randomUUID();
    const runtime = new NativeRuntime(this.image, {
      ...this.engine,
      name,
      labels: { [HEADLESS_ROLE_LABEL]: HEADLESS_ROLE },
    });
    let fail!: (failure: HeadlessFailure) => void;
    const failed = new Promise<never>((_, reject) => {
      fail = (failure) => reject(failure);
    });
    failed.catch(() => {});
    let failure: HeadlessFailure | undefined;
    const end = (code: HeadlessCode) => {
      if (failure) return;
      failure = new HeadlessFailure(code);
      fail(failure);
    };
    const responses = new Map<string, (response: any) => void>();
    let agentEnd!: () => void;
    const ended = new Promise<void>((resolve) => (agentEnd = resolve));
    let pending = "";
    runtime.onOutput = (chunk) => {
      pending += chunk;
      let index;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event?.type === "response" && typeof event.id === "string")
          responses.get(event.id)?.(event);
        else if (event?.type === "agent_end") agentEnd();
      }
      if (Buffer.byteLength(pending) > HEADLESS_LINE_LIMIT) {
        pending = "";
        end("HEADLESS_OUTPUT_TOO_LARGE");
      }
    };
    runtime.onExit = () => end("HEADLESS_EXITED");
    const response = (id: string) =>
      new Promise<any>((resolve) => responses.set(id, resolve));
    const timer = setTimeout(() => end("HEADLESS_TIMEOUT"), run.cycleMs);
    const onAbort = () => end("HEADLESS_ABORTED");
    run.signal?.addEventListener("abort", onAbort, { once: true });
    let prompted = false;
    try {
      await Promise.race([
        runtime.start(run.gateway, { mode: "rpc", profile: run.profile }),
        failed,
      ]);
      await Promise.race([runtime.attach(), failed]);
      const promptId = randomUUID();
      const accepted = response(promptId);
      prompted = true;
      await Promise.race([
        runtime.rpc({ id: promptId, type: "prompt", message: run.message }),
        failed,
      ]);
      const reply = await Promise.race([accepted, failed]);
      if (reply.success !== true)
        throw new HeadlessFailure("HEADLESS_PROMPT_REJECTED");
      await Promise.race([ended, failed]);
      const textId = randomUUID();
      const last = response(textId);
      await Promise.race([
        runtime.rpc({ id: textId, type: "get_last_assistant_text" }),
        failed,
      ]);
      const final = await Promise.race([last, failed]);
      const text = final.success === true ? final.data?.text : undefined;
      if (typeof text !== "string" || !text.trim())
        throw new HeadlessFailure("HEADLESS_NO_OUTPUT");
      return { text, container: name };
    } catch (error) {
      const code = failure?.code;
      if (
        prompted &&
        (code === "HEADLESS_TIMEOUT" || code === "HEADLESS_ABORTED")
      )
        await this.abort(runtime, response);
      throw failure ?? error;
    } finally {
      clearTimeout(timer);
      run.signal?.removeEventListener("abort", onAbort);
      runtime.onOutput = () => {};
      try {
        await runtime.stop();
      } finally {
        this.running = false;
      }
    }
  }

  private async abort(
    runtime: NativeRuntime,
    response: (id: string) => Promise<any>,
  ) {
    const id = randomUUID();
    const acknowledged = response(id);
    let grace: NodeJS.Timeout | undefined;
    try {
      await runtime.rpc({ id, type: "abort" });
      await Promise.race([
        acknowledged,
        new Promise((resolve) => (grace = setTimeout(resolve, ABORT_GRACE_MS))),
      ]);
    } catch {
      // The container is removed regardless.
    } finally {
      clearTimeout(grace);
    }
  }

  /** Startup sweep: removes only this role's exactly named containers. */
  async sweep(): Promise<number> {
    const run =
      this.engine.exec ??
      (promisify(execFile) as unknown as NonNullable<Engine["exec"]>);
    const host =
      "--host=unix://" + (this.engine.socketPath ?? "/var/run/docker.sock");
    const { stdout } = await run(
      "docker",
      [
        host,
        "ps",
        "--all",
        "--filter",
        `label=${HEADLESS_ROLE_LABEL}=${HEADLESS_ROLE}`,
        "--format",
        "{{.Names}}",
      ],
      { timeout: 10000, maxBuffer: 65536 },
    );
    let removed = 0;
    for (const name of String(stdout)
      .split("\n")
      .map((n) => n.trim())) {
      if (!HEADLESS_NAME.test(name)) continue;
      await run("docker", [host, "rm", "--force", name], {
        timeout: 15000,
        maxBuffer: 65536,
      });
      removed++;
    }
    return removed;
  }
}

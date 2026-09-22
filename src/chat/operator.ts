import { Store, compile, assertNoSecrets } from "../config/store.js";
import { complete } from "../runtime/piAdapter.js";
import { effectivePrompt, fetchInstructions } from "../runtime/prompt.js";
import { Client } from "../katafit/client.js";
import { SafeError } from "../runtime/errors.js";

import { History, bound, type Message } from "./history.js";
export class OperatorChat {
  private messages: Message[] = [];
  private controller?: AbortController;
  get active() {
    return !!this.controller;
  }
  cancel() {
    this.controller?.abort();
    this.controller = undefined;
  }
  clear() {
    this.cancel();
    this.history.save([]);
    this.messages = [];
  }
  private history: History;
  constructor(
    private store: Store,
    private infer = complete,
  ) {
    this.history = new History(store.dir);
    this.messages = this.history.load();
  }
  assertSecrets(secrets = Object.values(this.store.secrets)) {
    assertNoSecrets(this.messages, secrets);
  }
  snapshot() {
    this.assertSecrets();
    return { messages: structuredClone(this.messages) };
  }
  async turn(text: string) {
    if (typeof text !== "string" || !text.trim() || text.length > 8000)
      throw new SafeError("INVALID_PREVIEW");
    this.assertSecrets();
    assertNoSecrets(text, Object.values(this.store.secrets));
    const controller = new AbortController();
    this.controller = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(60000),
    ]);
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () =>
        reject(
          new SafeError(
            controller.signal.aborted ? "CANCELLED" : "PROVIDER_TIMEOUT",
          ),
        );
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([
        this.generate(text, signal, controller),
        cancelled,
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.controller === controller) this.controller = undefined;
    }
  }
  private async generate(
    text: string,
    signal: AbortSignal,
    controller: AbortController,
  ) {
    const c = this.store.publicConfig();
    const secrets = Object.values(this.store.secrets);

    const instructions = await fetchInstructions(
      new Client(c.origin, this.store.secrets.token, signal),
    ).catch(() => {
      if (signal.aborted)
        throw new SafeError(
          controller.signal.aborted ? "CANCELLED" : "BACKEND_TIMEOUT",
        );
      throw new SafeError("BACKEND_INSTRUCTIONS_UNAVAILABLE");
    });
    signal.throwIfAborted();
    const prompt = effectivePrompt(compile(c, secrets), instructions, secrets);
    const messages: Message[] = [...this.messages, { role: "user", text }];
    const reply = await this.infer(
      { ...c.provider, apiKey: this.store.secrets.apiKey, secrets },
      prompt,
      JSON.stringify({
        scope: "local operator conversation",
        authority:
          "No member data, no claimed request or tools. Discussion only; no permanent changes. Use Settings persona to save instructions.",
        messages,
      }),
      signal,
      [],
    );
    if (signal.aborted || this.controller !== controller)
      throw new SafeError("CANCELLED");
    if (typeof reply !== "string" || !reply.trim())
      throw new SafeError("MODEL_EMPTY_RESPONSE");
    if (reply.length > 32000) throw new SafeError("OUTPUT_REJECTED");
    assertNoSecrets(reply, [...secrets, ...Object.values(this.store.secrets)]);
    const next = bound([...messages, { role: "assistant", text: reply }]);
    this.history.save(next);
    this.messages = next;
    return {
      text: reply,
      ...this.snapshot(),
      revision: c.revision,
      configuration: "saved",
      instructionsStatus: "fetched",
    };
  }
}

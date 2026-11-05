import { restRequest } from "./restGet.js";

const TTL_SECONDS = 4 * 3600;
const RENEW_BEFORE_MS = 5 * 60 * 1000;
const TOKEN = /^rgn_agent_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$/;

/**
 * One short-lived backend token for a model session, minted from the
 * installation credential. The backend refuses it on host-only routes, so
 * the model never holds the installation token and the Coach needs no route
 * filters of its own. It never falls back to the installation token.
 */
export class AgentSession {
  private minted?: { id: string; token: string; expiresAt: number };
  private pending?: Promise<string>;
  constructor(
    private readonly origin: string,
    private readonly installation: string,
    private readonly secrets: () => string[],
  ) {}

  token(signal: AbortSignal): Promise<string> {
    const minted = this.minted;
    if (minted && minted.expiresAt - Date.now() > RENEW_BEFORE_MS)
      return Promise.resolve(minted.token);
    return (this.pending ??= this.mint(signal).finally(() => {
      this.pending = undefined;
    }));
  }

  /** The live token, so it is screened like any other secret. */
  current() {
    return this.minted?.token;
  }

  private async mint(signal: AbortSignal) {
    const result = await restRequest(
      this.origin,
      this.installation,
      {
        method: "POST",
        path: "/api/coach/agent-sessions",
        body: { ttl_seconds: TTL_SECONDS },
      },
      signal,
      this.secrets(),
    );
    let body: any;
    try {
      body = JSON.parse(result.content?.[0]?.text ?? "null");
    } catch {}
    const expiresAt = Date.parse(body?.expires_at);
    if (
      typeof body?.id !== "string" ||
      typeof body?.token !== "string" ||
      !TOKEN.test(body.token) ||
      !Number.isFinite(expiresAt)
    )
      throw new Error("AGENT_SESSION_UNAVAILABLE");
    const previous = this.minted;
    this.minted = { id: body.id, token: body.token, expiresAt };
    if (previous) void this.revoke(previous.id);
    return body.token as string;
  }

  private async revoke(id: string) {
    try {
      await restRequest(
        this.origin,
        this.installation,
        { method: "DELETE", path: `/api/coach/agent-sessions/${id}` },
        AbortSignal.timeout(3000),
        this.secrets(),
      );
    } catch {
      // Expiry still ends it.
    }
  }

  /** Best effort: an unrevoked token still expires on its own. */
  async close() {
    const minted = this.minted;
    this.minted = undefined;
    if (minted) await this.revoke(minted.id);
  }
}

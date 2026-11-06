// Pi extension, always loaded in workspace mode: Pi configures its own HTTP
// client at startup, so the relay's fetch (workspace/pipe-relay.mjs) is
// installed here, once Pi has done so. Every fetch then goes to the relay or
// fails; the process has no network permission either way.
const RELAY_FETCH = Symbol.for("katafit.workspace.relay-fetch");

export default function () {
  const relayFetch = globalThis[RELAY_FETCH];
  if (typeof relayFetch !== "function") throw new Error("RELAY_UNAVAILABLE");
  globalThis.fetch = relayFetch;
}

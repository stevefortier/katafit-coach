// Synthetic transport only; execute the real production native worker/provisioner.
// No provider, daemon, package or service calls are admitted by this fixture.
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  if (
    !String(url).startsWith(
      "https://api.github.com/repos/stevefortier/katafit-coach/attestations/sha256:",
    ) ||
    new Headers(init?.headers).has("authorization")
  )
    throw Error("FIXTURE_REQUEST_REJECTED");
  return new Response("PRIVATE response https://signed.invalid/?token=SECRET", {
    status: 429,
    headers: {
      "x-github-request-id": "ABCD:1234:5678:90AB",
      "x-ratelimit-remaining": "0",
      "retry-after": "30",
      location: "https://signed.invalid/?token=SECRET",
    },
  });
}) as typeof fetch;
await import("../../dist/release/native-worker.js");

import { runNativeWorker } from "../../src/release/native-supervisor.js";
import { provenanceDiagnostics } from "../../src/release/provenance-diagnostics.js";
runNativeWorker(async () => {
  const enabled = provenanceDiagnostics.hasSubscribers;
  for (let i = 0; i < 40; i++)
    provenanceDiagnostics.publish({
      protocol: 1,
      stage: "attestation-fetch",
      failure: "http",
      status: 403,
      requestId: "https://signed.invalid/SECRET",
      private: "PRIVATE",
    });
  return { enabled };
});

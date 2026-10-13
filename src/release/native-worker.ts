import { runNativeWorker } from "./native-supervisor.js";
import { provisionReleaseOwned } from "./provision.js";

runNativeWorker(async (request, signal) => {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).sort().join(",") !==
      "archiveTimeoutMs,artifacts,home,manifest,manifestBytes,staging" ||
    ![
      request.artifacts,
      request.home,
      request.staging,
      request.manifestBytes,
    ].every((v) => typeof v === "string") ||
    request.manifestBytes.length > 11000 ||
    !Number.isSafeInteger(request.archiveTimeoutMs) ||
    request.archiveTimeoutMs < 1 ||
    request.archiveTimeoutMs > 180000
  )
    throw Error("RELEASE_WORKER_REQUEST_REJECTED");
  return provisionReleaseOwned(
    request.manifest,
    request.artifacts,
    request.home,
    request.staging,
    Buffer.from(request.manifestBytes, "base64"),
    { signal, timeoutMs: request.archiveTimeoutMs },
  );
});

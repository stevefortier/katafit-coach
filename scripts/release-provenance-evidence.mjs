import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  provenanceDiagnostics,
  provenanceDiagnosticLimit,
  sanitizeProvenanceDiagnostic,
} from "../dist/release/provenance-diagnostics.js";

/** Release qualification only. Explicit one-file output, including on failure;
 * never walks the operator home, stages packages, or copies error prose. */
export async function withProvenanceEvidence(path, work) {
  const diagnostics = [];
  let dropped = 0;
  const collect = (value) => {
    const safe = sanitizeProvenanceDiagnostic(value);
    if (!safe) return;
    if (diagnostics.length < provenanceDiagnosticLimit) diagnostics.push(safe);
    else dropped = Math.min(9999, dropped + 1);
  };
  provenanceDiagnostics.subscribe(collect);
  try {
    return await work();
  } finally {
    provenanceDiagnostics.unsubscribe(collect);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      JSON.stringify({ protocol: 1, diagnostics, dropped }) + "\n",
      { mode: 0o600 },
    );
  }
}

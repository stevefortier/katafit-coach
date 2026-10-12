import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export async function browserEvidence() {
  const path =
    process.env.COACH_EVIDENCE_DIR ??
    (await mkdtemp(join(tmpdir(), "coach-browser-evidence-")));
  await mkdir(path, { recursive: true });
  return path;
}

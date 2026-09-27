import { existsSync } from "node:fs";

// Repository convention for browser tests. A missing browser is an explicit
// failure, never a silent skip.
export function chromePath() {
  const path = process.env.CHROME_PATH || "/usr/bin/google-chrome";
  if (!existsSync(path))
    throw new Error(
      `Chrome not found at ${path}. Install Google Chrome or set CHROME_PATH.`,
    );
  return path;
}

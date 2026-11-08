import { existsSync } from "node:fs";
import { join } from "node:path";

// Repository convention for browser tests. A missing browser is an explicit
// failure, never a silent skip.
export function chromePath() {
  const path =
    process.env.CHROME_PATH ||
    (process.platform === "win32"
      ? [
          process.env.PROGRAMFILES,
          process.env["PROGRAMFILES(X86)"],
          process.env.LOCALAPPDATA,
        ]
          .filter((root): root is string => !!root)
          .map((root) =>
            join(root, "Google", "Chrome", "Application", "chrome.exe"),
          )
          .find(existsSync)
      : "/usr/bin/google-chrome");
  if (!path || !existsSync(path))
    throw new Error(
      `Chrome not found at ${path}. Install Google Chrome or set CHROME_PATH.`,
    );
  return path;
}

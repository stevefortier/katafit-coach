import { execFile } from "node:child_process";

// Keep the driver's HTTP event loop live while children build, load or stop.
// Kill an expired client rather than letting it hold an unbounded test join.
export function command(file, args, options = {}) {
  const { input, ...rest } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
        ...rest,
      },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve(stdout);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { sandboxArgs } from "../src/sandbox/policy.js";

test("native Pi sandbox has no external network, mounts or ambient credentials", () => {
  const args = sandboxArgs("coach-native-test", "katafit-pi:0.86.1");
  for (const flag of [
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--memory=512m",
    "--pids-limit=128",
    "--cpus=1",
    "--user=1000:1000",
    "--log-driver=none",
  ])
    assert.ok(args.includes(flag), flag);
  assert.ok(
    args.includes("/workspace:rw,nosuid,nodev,size=32m,uid=1000,gid=1000"),
  );
  assert.ok(
    !args.some((a) => /privileged|docker.sock|type=bind|network=host/.test(a)),
  );
  assert.equal(args.at(-1), "katafit-pi:0.86.1");
});

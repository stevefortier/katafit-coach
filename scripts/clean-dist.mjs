import { rmSync } from "node:fs";
// tsc leaves outputs for deleted sources behind. Clean only this checkout's
// generated directory before compiling; never touch the protected Coach home.
rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });

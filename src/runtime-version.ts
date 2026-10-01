export function assertSupportedNode(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) !== 26 || Number(match[2]) < 10)
    throw new Error(
      "Node 26.10+ (major 26 only) required; received " + version,
    );
}

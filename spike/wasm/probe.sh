#!/usr/bin/env bash
# Phase 0 spike: tell apart an image problem from a runtime problem by
# running both images under wasmtime with each documented invocation form.
# Usage: probe.sh <c2w-image.wasm> <agentvm-image.wasm> <workdir>
set -uo pipefail
ours="$1" agentvm="$2" work="$3"
mkdir -p "$work"; echo hi > "$work/hi.txt"
host="$(cygpath -w "$work" 2>/dev/null || echo "$work")"
try() { # label, args...
  local label="$1"; shift
  echo "=== $label"
  local start; start=$(date +%s%N)
  timeout 120 wasmtime "$@" </dev/null > "$work/out.log" 2>&1; local status=$?
  echo "status $status after $(awk -v a="$start" -v b="$(date +%s%N)" 'BEGIN{printf "%.1f", (b-a)/1e9}')s"
  head -c 1500 "$work/out.log"; echo
}
for image in "$ours" "$agentvm"; do
  echo "##### $(basename "$image") $(du -h "$image" | cut -f1)"
  try "run IMAGE uname -a" run "$image" uname -a
  try "-- IMAGE uname -a" -- "$image" uname -a
  try "run IMAGE -no-stdin uname -a" run "$image" -no-stdin uname -a
  try "run --dir IMAGE cat" run --dir "$host::/mnt/work" "$image" cat /mnt/work/hi.txt
  try "run -W max-memory IMAGE uname" run -W max-memory-size=4294967296 "$image" uname -a
done

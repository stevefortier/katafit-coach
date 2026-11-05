#!/usr/bin/env bash
# Phase 0 spike: time typical Pi workloads in the WebAssembly VM and check the
# workspace boundary. Usage: measure.sh <runner> <image.wasm> <workdir>
set -uo pipefail
runner="$1" image="$2" work="$3"
mkdir -p "$work"; printf 'alpha\nbeta needle\ngamma\n' > "$work/notes.txt"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
# wasmtime on Windows needs a native path for the shared directory.
host="$(cygpath -w "$work" 2>/dev/null || echo "$work")"
echo "| Step | Seconds | Result |" >> "$summary"
echo "|---|---|---|" >> "$summary"
run() { # name, guest command
  local name="$1"; shift
  local start end out status
  start=$(date +%s.%N)
  out=$(wasmtime run --dir "$host::/mnt/work" "$image" "$@" 2>&1); status=$?
  end=$(date +%s.%N)
  printf '| %s | %.1f | %s |\n' "$name" "$(echo "$end - $start" | bc)" \
    "$( [ $status -eq 0 ] && echo "ok: $(echo "$out" | tail -1 | cut -c1-60)" || echo "FAILED ($status): $(echo "$out" | tail -1 | cut -c1-60)")" >> "$summary"
  echo "== $name ($status)"; echo "$out" | tail -5
}
echo "### $runner" >> "$summary"
run "boot + uname" uname -a
run "node -v" node -v
run "node script" node -e 'console.log([1,2,3].map(x=>x*2).join(","))'
run "pi --version" pi --version
run "grep in workspace" grep -rn needle /mnt/work
run "write in workspace" sh -c 'echo from-guest > /mnt/work/out.txt && cat /mnt/work/out.txt'
run "10 shell commands in one boot" sh -c 'for i in 1 2 3 4 5 6 7 8 9 10; do ls /mnt/work >/dev/null; done; echo done'
run "git init + commit" sh -c 'cd /tmp && git init -q r && cd r && echo x > f && git -c user.email=a@b -c user.name=a add f && git -c user.email=a@b -c user.name=a commit -qm x && git log --oneline | wc -l'
# Boundary: the guest sees only its own filesystem plus the shared workspace.
run "host home not visible" sh -c 'ls /mnt; test ! -e /mnt/work/../../home/runner && echo isolated'
if [ "$(cat "$work/out.txt" 2>/dev/null)" = "from-guest" ]; then
  echo "| guest write visible on host | - | ok |" >> "$summary"
else
  echo "| guest write visible on host | - | FAILED |" >> "$summary"
fi

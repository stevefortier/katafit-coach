#!/usr/bin/env bash
# Phase 0 spike: time typical Pi workloads in the WebAssembly VM and check the
# workspace boundary. Usage: measure.sh <runner> <image.wasm> <workdir>
# Results go to the log and the job summary; any failed step fails the job.
set -uo pipefail
runner="$1" image="$2" work="$3"
mkdir -p "$work"; printf 'alpha\nbeta needle\ngamma\n' > "$work/notes.txt"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
# wasmtime on Windows needs a native path for the shared directory.
host="$(cygpath -w "$work" 2>/dev/null || echo "$work")"
failures=0
report() { echo "$1"; echo "$1" >> "$summary"; }
report "### $runner"
report "| Step | Seconds | Result |"
report "|---|---|---|"
wasmtime --version
ls -l "$image"
run() { # name, guest command...
  local name="$1"; shift
  local start end out status
  start=$(date +%s%N)
  out=$(wasmtime run --dir "$host::/mnt/work" "$image" -no-stdin "$@" 2>&1 </dev/null); status=$?
  end=$(date +%s%N)
  local seconds; seconds=$(awk -v a="$start" -v b="$end" 'BEGIN{printf "%.1f", (b-a)/1e9}')
  if [ $status -eq 0 ]; then
    report "| $name | $seconds | ok: $(echo "$out" | tail -1 | cut -c1-60) |"
  else
    failures=$((failures + 1))
    report "| $name | $seconds | FAILED ($status): $(echo "$out" | tr '\n' ' ' | cut -c1-120) |"
  fi
  echo "--- output of $name:"; echo "$out" | tail -20
}
run "boot + uname" uname -a
run "node -v" node -v
run "node script" node -e 'console.log([1,2,3].map(x=>x*2).join(","))'
run "pi --version" pi --version
run "grep in workspace" grep -rn needle /mnt/work
run "write in workspace" sh -c 'echo from-guest > /mnt/work/out.txt && cat /mnt/work/out.txt'
run "10 shell commands in one boot" sh -c 'for i in 1 2 3 4 5 6 7 8 9 10; do ls /mnt/work >/dev/null; done; echo done'
run "git init + commit" sh -c 'cd /tmp && git init -q r && cd r && echo x > f && git -c user.email=a@b -c user.name=a add f && git -c user.email=a@b -c user.name=a commit -qm x && git log --oneline | wc -l'
run "only workspace shared" sh -c 'ls /mnt && test "$(ls /mnt)" = work && echo isolated'
# Interactive sessions feed the VM through stdin: commands piped to a shell.
start=$(date +%s%N)
piped=$(printf 'echo piped-$((6*7))\nnode -e "console.log(process.version)"\nexit\n' | wasmtime run --dir "$host::/mnt/work" "$image" sh 2>&1); status=$?
seconds=$(awk -v a="$start" -v b="$(date +%s%N)" 'BEGIN{printf "%.1f", (b-a)/1e9}')
if [ $status -eq 0 ] && echo "$piped" | grep -q piped-42; then
  report "| commands piped to sh on stdin | $seconds | ok: $(echo "$piped" | tail -1 | cut -c1-60) |"
else
  failures=$((failures + 1)); report "| commands piped to sh on stdin | $seconds | FAILED ($status): $(echo "$piped" | tr '\n' ' ' | cut -c1-120) |"
fi
if [ "$(cat "$work/out.txt" 2>/dev/null)" = "from-guest" ]; then
  report "| guest write visible on host | - | ok |"
else
  failures=$((failures + 1)); report "| guest write visible on host | - | FAILED |"
fi
echo "failures: $failures"
exit $(( failures > 0 ))

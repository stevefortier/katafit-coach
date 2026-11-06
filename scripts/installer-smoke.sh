#!/bin/sh
# Runs inside a clean Linux container as an ordinary user (the CI `installer`
# job creates it and runs this with `docker exec -u`): installs Coach from the
# archive with install.sh, checks that Studio answers in workspace mode, and
# that a reinstall keeps the data.
set -eu
archive=$(ls /archives/coach-*-linux-x64.tar.gz)
node=$HOME/.local/share/katafit-coach/node/bin/node

sh /install.sh --archive "$archive" | tee /tmp/install.log
grep -q "is installed and running" /tmp/install.log
grep -q "workspace mode" /tmp/install.log
grep -q '"workspace"' "$HOME/.katafit-coach/sandbox.json"
url=$(grep -o 'http://127\.0\.0\.1:[0-9]*/#[A-Za-z0-9_-]*' /tmp/install.log)
origin=${url%%/#*}
admin=${url##*#}
"$node" -e "fetch('$origin/').then((r) => process.exit(r.ok ? 0 : 1))"
"$node" -e "fetch('$origin/api/status', { headers: { Authorization: 'Bearer $admin' } }).then((r) => process.exit(r.ok ? 0 : 1))"
"$HOME/.local/bin/katafit-coach" status >/dev/null

# A reinstall replaces the runtime, keeps the data and the admin credential.
touch "$HOME/.katafit-coach/keep-me"
sh /install.sh --archive "$archive" >/tmp/reinstall.log
grep -q "is installed and running" /tmp/reinstall.log
grep -q "#$admin" /tmp/reinstall.log
test -f "$HOME/.katafit-coach/keep-me"
echo "Installer smoke passed on $(. /etc/os-release && echo "$PRETTY_NAME")."

#!/bin/sh
# Runs inside a clean Linux container as root: creates an ordinary user, then
# installs Coach from the archive with install.sh, checks that Studio answers
# in workspace mode, and that a reinstall keeps the data. Used by the CI
# `installer` job: docker run -v install.sh -v archives IMAGE sh this-script.
set -eu
archive=$(ls /archives/coach-*-linux-x64.tar.gz)
useradd -m coach 2>/dev/null || adduser -D coach
as() { su coach -c "$1"; }
node=/home/coach/.local/share/katafit-coach/node/bin/node

as "sh /install.sh --archive $archive" | tee /tmp/install.log
grep -q "is installed and running" /tmp/install.log
grep -q "workspace mode" /tmp/install.log
as 'cat ~/.katafit-coach/sandbox.json' | grep -q '"workspace"'
url=$(grep -o 'http://127\.0\.0\.1:[0-9]*/#[A-Za-z0-9_-]*' /tmp/install.log)
origin=${url%%/#*}
admin=${url##*#}
as "$node -e \"fetch('$origin/').then((r) => process.exit(r.ok ? 0 : 1))\""
as "$node -e \"fetch('$origin/api/status', { headers: { Authorization: 'Bearer $admin' } }).then((r) => process.exit(r.ok ? 0 : 1))\""
as '~/.local/bin/katafit-coach status' >/dev/null

# A reinstall replaces the runtime, keeps the data and the admin credential.
as 'touch ~/.katafit-coach/keep-me'
as "sh /install.sh --archive $archive" >/tmp/reinstall.log
grep -q "is installed and running" /tmp/reinstall.log
grep -q "#$admin" /tmp/reinstall.log
as 'test -f ~/.katafit-coach/keep-me'
echo "Installer smoke passed on $(. /etc/os-release && echo "$PRETTY_NAME")."

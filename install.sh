#!/bin/sh
# Kata.fit Coach installer for Linux: for the current user, no admin rights.
#
#   curl -fsSL https://raw.githubusercontent.com/stevefortier/katafit-coach/main/install.sh | sh
#
# Downloads the latest release's self-contained archive (Node and Coach, no
# system packages needed), checks it against the digest GitHub publishes for
# it, then hands over to the installer inside it (dist/install.js), which
# verifies its attestation, installs it and starts it at boot.
#
#   sh install.sh --archive FILE   installs a local archive (not verified)
set -eu

REPO=stevefortier/katafit-coach
API=https://api.github.com/repos/$REPO/releases/latest

fail() {
	echo "Kata.fit Coach installer: $*" >&2
	exit 1
}

[ "$(uname -s)" = Linux ] || fail "this installer is for Linux."
case "$(uname -m)" in
x86_64 | amd64) platform=linux-x64 ;;
aarch64 | arm64) platform=linux-arm64 ;;
*) fail "unsupported processor $(uname -m) (x64 and arm64 only)." ;;
esac
[ "$(id -u)" != 0 ] || fail "run this as your own user, not root: Coach installs for one user."
for tool in tar sha256sum; do
	command -v "$tool" >/dev/null || fail "$tool is required."
done

fetch() { # url [file]
	if command -v curl >/dev/null; then
		if [ $# -gt 1 ]; then curl -fsSL -o "$2" "$1"; else curl -fsSL "$1"; fi
	elif command -v wget >/dev/null; then
		if [ $# -gt 1 ]; then wget -qO "$2" "$1"; else wget -qO- "$1"; fi
	else
		fail "curl or wget is required."
	fi
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

local=""
if [ "${1:-}" = --archive ]; then
	[ -f "${2:-}" ] || fail "--archive needs an existing file."
	archive=$work/archive.tar.gz
	cp "$2" "$archive"
	local=--local
else
	echo "Finding the latest Kata.fit Coach release..."
	release=$(fetch "$API" | tr -d '\n')
	tag=$(printf '%s' "$release" | grep -o '"tag_name": *"coach-[0-9a-f]\{40\}"' | grep -o 'coach-[0-9a-f]\{40\}') ||
		fail "could not read the latest release."
	name="$tag-$platform.tar.gz"
	# One asset per line, then the digest GitHub computed for ours.
	digest=$(printf '%s' "$release" |
		sed 's/"url": *"https:\/\/api.github.com\/repos\/[^"]*\/releases\/assets\//\n&/g' |
		grep "\"name\": *\"$name\"" | grep -o '"digest": *"sha256:[0-9a-f]\{64\}"' | grep -o '[0-9a-f]\{64\}') ||
		fail "the latest release has no archive for $platform yet."
	archive=$work/$name
	echo "Downloading $name..."
	fetch "https://github.com/$REPO/releases/download/$tag/$name" "$archive"
	echo "$digest  $archive" | sha256sum -c - >/dev/null 2>&1 ||
		fail "the download does not match the digest GitHub publishes for it."
fi

mkdir "$work/extract"
tar -xzf "$archive" -C "$work/extract"
coach=$work/extract/katafit-coach
revision=$(grep -o '"revision": *"[0-9a-f]\{40\}"' "$coach/app/dist/build.json" | grep -o '[0-9a-f]\{40\}') ||
	fail "the archive has no build metadata."
"$coach/node/bin/node" "$coach/app/dist/install.js" \
	--source "$coach" --archive "$archive" --revision "$revision" $local

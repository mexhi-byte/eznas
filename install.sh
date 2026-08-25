#!/usr/bin/env bash
#
# Install or update EzNAS on a TrueNAS SCALE box.
#
# Run it once to install. Run it again to update: it pulls the latest release,
# rebuilds, and restarts, keeping everything under the data directory.
#
#   curl -fsSL https://raw.githubusercontent.com/mexhi-byte/eznas/main/install.sh | bash -s -- --pool tank
#
# or, from a clone:
#
#   sudo ./install.sh --pool tank
#
# Everything it writes lives under /mnt/<pool>/eznas. That is deliberate: /mnt
# is the only place on a TrueNAS box that survives a system update, so an
# install anywhere else is one upgrade away from being gone.

set -euo pipefail

REPO_URL="${EZNAS_REPO:-https://github.com/mexhi-byte/eznas.git}"
IMAGE="eznas:local"
CONTAINER="eznas"

POOL=""
PORT="8080"
REF=""
BASE=""
USERNAME="admin"
PASSWORD=""
ASSUME_YES="no"

# ---------------------------------------------------------------- output

# Colour only when a terminal is watching. Piped into a log, escape codes are
# noise that makes the log harder to read, not easier.
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; OFF=""
fi

say()  { printf '%s\n' "${BOLD}==>${OFF} $*"; }
note() { printf '%s\n' "    ${DIM}$*${OFF}"; }
warn() { printf '%s\n' "${YELLOW}    ! $*${OFF}"; }
die()  { printf '%s\n' "${RED}==> $*${OFF}" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Install or update EzNAS on TrueNAS SCALE.

  --pool NAME        ZFS pool to install into. Everything lives in
                     /mnt/NAME/eznas. Required on a first install; remembered
                     afterwards.
  --port N           Port to serve on (default 8080).
  --dir PATH         Install somewhere other than /mnt/<pool>/eznas. It must
                     still be under /mnt to survive a TrueNAS update.
  --ref TAG          Install a particular tag or branch instead of the latest
                     release. Useful for going back to one that worked.
  --username NAME    First admin account (default "admin"). First install only.
  --password PASS    Its password. Generated and printed if not given.
  --yes              Do not ask anything; take the defaults.
  --uninstall        Stop and remove the container and the image. Leaves the
                     data directory alone.
  -h, --help         This.
USAGE
}

# ---------------------------------------------------------------- arguments

UNINSTALL="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --pool)      POOL="${2:-}"; shift 2 ;;
    --port)      PORT="${2:-}"; shift 2 ;;
    --dir)       BASE="${2:-}"; shift 2 ;;
    --ref)       REF="${2:-}"; shift 2 ;;
    --username)  USERNAME="${2:-}"; shift 2 ;;
    --password)  PASSWORD="${2:-}"; shift 2 ;;
    --yes|-y)    ASSUME_YES="yes"; shift ;;
    --uninstall) UNINSTALL="yes"; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "Unknown option: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------- checks

[ "$(id -u)" -eq 0 ] || die "Run this with sudo: it needs Docker and it writes to /mnt."

command -v docker >/dev/null 2>&1 \
  || die "Docker is not on this machine. TrueNAS SCALE 25.04 and newer ship it; on 24.x apps ran under Kubernetes and this script will not work."

docker info >/dev/null 2>&1 \
  || die "Docker is installed but not running. On TrueNAS, check that Apps are enabled and a pool is chosen for them."

command -v git >/dev/null 2>&1 || die "git is not on this machine, and the build needs it."

# ---------------------------------------------------------------- where

if [ -z "$BASE" ]; then
  if [ -z "$POOL" ]; then
    # An existing install knows where it lives; only a new one has to be told.
    EXISTING="$(docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/data" }}{{ .Source }}{{ end }}{{ end }}' "$CONTAINER" 2>/dev/null || true)"
    if [ -n "$EXISTING" ]; then
      BASE="$(dirname "$EXISTING")"
      note "Updating the install already at $BASE"
    else
      echo "Pools on this machine:"
      ls -1 /mnt 2>/dev/null | grep -v '^\.' | sed 's/^/  /' || true
      die "Say which pool to install into: --pool NAME"
    fi
  else
    BASE="/mnt/${POOL}/eznas"
  fi
fi

case "$BASE" in
  /mnt/*) : ;;
  *) warn "$BASE is not under /mnt. A TrueNAS system update can wipe anything outside it." ;;
esac

SRC="${BASE}/src"
DATA="${BASE}/data"
ENV_FILE="${BASE}/eznas.env"

# ---------------------------------------------------------------- uninstall

if [ "$UNINSTALL" = "yes" ]; then
  say "Removing the container and the image"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
  say "Done."
  note "Your data is still at ${DATA}. Delete it by hand if you mean to."
  exit 0
fi

# ---------------------------------------------------------------- source

say "Fetching the source into ${SRC}"
mkdir -p "$BASE"
if [ -d "${SRC}/.git" ]; then
  git -C "$SRC" remote set-url origin "$REPO_URL"
  git -C "$SRC" fetch --tags --prune origin --quiet
else
  rm -rf "$SRC"
  git clone --quiet "$REPO_URL" "$SRC"
fi

if [ -z "$REF" ]; then
  # The newest release tag, or the default branch if none has been cut yet.
  REF="$(git -C "$SRC" tag --list 'v*' --sort=-v:refname | head -n1)"
  if [ -z "$REF" ]; then
    REF="origin/HEAD"
    note "No release tags published yet; using the default branch."
  fi
fi

git -C "$SRC" checkout --force --quiet "$REF"
VERSION="$(git -C "$SRC" describe --tags --always 2>/dev/null || echo unknown)"
note "Building ${VERSION}"

# ---------------------------------------------------------------- settings

# Written once and read on every later run. SESSION_SECRET in particular must
# never be regenerated: the console derives the encryption key for stored API
# keys and NAS passwords from it, so a new one does not just sign people out —
# it makes every saved credential unreadable.
NEW_INSTALL="no"
if [ ! -f "$ENV_FILE" ]; then
  NEW_INSTALL="yes"
  [ -n "$PASSWORD" ] || PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
  umask 077
  cat > "$ENV_FILE" <<ENVFILE
# EzNAS. Written by install.sh; edit if you like, it is not overwritten.
#
# SESSION_SECRET is the key that stored API keys and NAS passwords are
# encrypted with. Changing it signs everyone out AND makes every saved
# credential unreadable. Keep it, and keep it private.
SESSION_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
UI_USERNAME=${USERNAME}
UI_PASSWORD=${PASSWORD}
RELEASE_CHANNEL=container
ENVFILE
  chmod 600 "$ENV_FILE"
else
  note "Keeping the settings already in ${ENV_FILE}"
fi

# ---------------------------------------------------------------- data

mkdir -p "$DATA"
# 1000 is the node user inside the image. A bind mount takes its ownership from
# the host, so without this the container starts and cannot write its own
# accounts file — which looks like a crash with no explanation.
chown -R 1000:1000 "$DATA"
chmod 700 "$DATA"

# ---------------------------------------------------------------- build

say "Building the image"
docker build --quiet --tag "$IMAGE" "$SRC" >/dev/null

# ---------------------------------------------------------------- run

say "Starting it"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run --detach \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --publish "${PORT}:8080" \
  --volume "${DATA}:/data" \
  --env-file "$ENV_FILE" \
  --label "eznas.version=${VERSION}" \
  --health-cmd "node -e \"fetch('http://127.0.0.1:8080/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" \
  --health-interval 30s \
  "$IMAGE" >/dev/null

# ---------------------------------------------------------------- wait

say "Waiting for it to answer"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/session" 2>/dev/null; then
    READY="yes"; break
  fi
  sleep 1
done

if [ "${READY:-no}" != "yes" ]; then
  warn "It did not answer within 30 seconds. What it said:"
  docker logs --tail 40 "$CONTAINER" 2>&1 | sed 's/^/    /'
  die "Not running. Fix the above, then run this again."
fi

# ---------------------------------------------------------------- done

HOSTIP="$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || true)"
[ -n "$HOSTIP" ] || HOSTIP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost)"

echo
say "${GREEN}EzNAS ${VERSION} is running.${OFF}"
echo
note "Open        http://${HOSTIP}:${PORT}"
if [ "$NEW_INSTALL" = "yes" ]; then
  note "Sign in as  ${USERNAME}"
  note "Password    ${PASSWORD}"
  echo
  warn "Write that password down now. It is in ${ENV_FILE} and nowhere else."
  echo
  note "Then add your NAS under Settings → Servers, with an API key from"
  note "TrueNAS → Credentials → Local Users → API keys."
fi
echo
note "Update    sudo $0            (re-run; your data is kept)"
note "Logs      docker logs -f ${CONTAINER}"
note "Stop      docker stop ${CONTAINER}"
note "Remove    sudo $0 --uninstall"
echo
warn "This console holds an API key with full control of your NAS. Do not put"
warn "it on the internet behind a password alone — use a VPN or an identity proxy."

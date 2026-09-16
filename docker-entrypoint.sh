#!/bin/sh
#
# Make /data writable by the console, then run as the console.
#
# The image runs its process as an unprivileged user. A bind mount, though,
# takes its ownership from the host — so without this the container started,
# could not write its own accounts file, and stopped with an error that read
# like a crash. Earlier images asked install.sh to chown the directory first,
# which TrueNAS's Custom App button gives nobody the chance to do.
#
# So the container starts as root for exactly as long as it takes to fix the
# ownership, then drops to PUID:PGID (1000:1000 unless told otherwise) with
# su-exec, which replaces this shell rather than wrapping it: the console is
# PID 1 and receives the stop signal directly. Started with --user already,
# there is nothing to fix and nothing to drop, and this just runs the command.
set -eu

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  DATA="${DATA_DIR:-/data}"
  mkdir -p "$DATA"
  # Only when it is wrong. A recursive chown over a large preview cache on
  # every start would make restarts slow for no reason.
  if [ "$(stat -c '%u:%g' "$DATA")" != "${PUID}:${PGID}" ]; then
    chown -R "${PUID}:${PGID}" "$DATA"
  fi
  exec su-exec "${PUID}:${PGID}" "$@"
fi

exec "$@"

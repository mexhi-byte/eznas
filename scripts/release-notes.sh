#!/usr/bin/env bash
#
# Print the changelog section for one version, for use as GitHub release notes.
#
#   scripts/release-notes.sh 0.5.2 > notes.md
#
# The changelog is the one place release notes are written, and a release
# whose notes were typed into a web form is a release whose notes differ
# from the changelog by the end of the week. This reads the section between
# the version's heading and the next one, and appends the two commands a
# reader most likely came for.
set -euo pipefail

VERSION="${1:?usage: release-notes.sh VERSION}"
VERSION="${VERSION#v}"
FILE="${2:-CHANGELOG.md}"
IMAGE="${IMAGE:-ghcr.io/mexhi-byte/eznas}"

section="$(awk -v v="$VERSION" '
  /^## / { if (found) exit; found = ($2 == v) ; next }
  found { print }
' "$FILE")"

if [ -z "$(printf '%s' "$section" | tr -d '[:space:]')" ]; then
  echo "No section for ${VERSION} in ${FILE}. Add one under '## ${VERSION}' before tagging." >&2
  exit 1
fi

printf '%s\n' "$section" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}'
cat <<NOTES

---

**Install or update on TrueNAS** — Apps → Discover → Custom App, paste
[deploy/truenas-custom-app.yaml](https://github.com/mexhi-byte/eznas/blob/v${VERSION}/deploy/truenas-custom-app.yaml),
or from a shell:

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/mexhi-byte/eznas/v${VERSION}/install.sh | sudo bash -s -- --pool tank
\`\`\`

**Image** \`${IMAGE}:${VERSION}\` for amd64 and arm64.
NOTES

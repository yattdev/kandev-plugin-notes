#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
kandev_backend=${KANDEV_NOTES_KANDEV_BACKEND:-"$repo_root/../kandev/apps/backend"}
contract_test="$repo_root/integration/host_upgrade_preserves_user_state_test.go"

if [ ! -f "$kandev_backend/internal/plugins/service_install.go" ]; then
  echo "Notes host persistence gate requires a Kandev backend checkout at: $kandev_backend" >&2
  echo "Set KANDEV_NOTES_KANDEV_BACKEND to apps/backend when using another sibling layout." >&2
  exit 1
fi

overlay=$(mktemp "${TMPDIR:-/tmp}/notes-host-overlay.XXXXXX")
trap 'rm -f "$overlay"' EXIT HUP INT TERM

target="$kandev_backend/internal/plugins/notes_persistence_contract_test.go"
printf '{"Replace":{"%s":"%s"}}\n' "$target" "$contract_test" >"$overlay"

(
  cd "$kandev_backend"
  go test \
    -overlay "$overlay" \
    ./internal/plugins \
    -run '^TestNotesPluginVersionReplacementPreservesUserState$' \
    -count=1
)

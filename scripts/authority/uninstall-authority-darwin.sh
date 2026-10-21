#!/usr/bin/env bash
#
# Remove the HUQAN approval authority daemon on macOS (ADR-020, #4082 PR-5).
#
# Stops and boots out the daemon, removes the plist and the protected program
# directory, and removes the pin. The state directory -- keys, TOTP secret and
# ledger -- is not deleted: it is renamed with its ownership and mode intact, so
# the ledger stays available for an audit. Removing the pin is the only way back
# to legacy mode, which is why it takes root.
#
# The hidden service user is left in place: deleting it would leave the renamed
# state directory owned by a uid with no name. Remove it by hand if you want it
# gone once no state refers to it.
#
# Usage: sudo scripts/authority/uninstall-authority-darwin.sh

set -euo pipefail

SERVICE_LABEL=com.huqan.authority
SERVICE_USER=_huqanauthority
INSTALL_DIR=/Library/HUQAN/authority
DATA_DIR=/Library/HUQAN/authority-data
PLIST_FILE="/Library/LaunchDaemons/$SERVICE_LABEL.plist"

fail() { echo "uninstall-authority-darwin: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail 'run this as root (sudo)'

launchctl bootout "system/$SERVICE_LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_FILE"

rm -f "$DATA_DIR/public/authority.json"
if [ -e "$DATA_DIR" ]; then
  archive="$DATA_DIR.removed-$(date +%Y%m%d%H%M%S)"
  mv "$DATA_DIR" "$archive"
  echo "State and ledger kept at $archive (still owned by $SERVICE_USER, mode 0700)."
fi
rm -rf "$INSTALL_DIR"
echo 'HUQAN approval authority removed; the runtime is back in legacy mode.'

#!/usr/bin/env bash
#
# Remove the HUQAN approval authority service on Linux (ADR-020, #4082 PR-4).
#
# Stops and disables the unit, removes the unit file and the protected program
# directory, and removes the pin. The state directory -- keys, TOTP secret and
# ledger -- is not deleted: it is renamed with its ownership and mode intact, so
# the ledger stays available for an audit. Removing the pin is the only way back
# to legacy mode, which is why it takes root.
#
# Usage: sudo scripts/authority/uninstall-authority.sh

set -euo pipefail

SERVICE_NAME=huqan-authority
SERVICE_USER=huqan-authority
INSTALL_DIR=/opt/huqan-authority
DATA_DIR=/var/lib/huqan-authority
SOCKET_GROUP=huqan-authority-ops
UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"

fail() { echo "uninstall-authority: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail 'run this as root (sudo)'

if systemctl list-unit-files "$SERVICE_NAME.service" >/dev/null 2>&1; then
  systemctl stop "$SERVICE_NAME.service" >/dev/null 2>&1 || true
  systemctl disable "$SERVICE_NAME.service" >/dev/null 2>&1 || true
fi
rm -f "$UNIT_FILE"
systemctl daemon-reload >/dev/null 2>&1 || true

# The socket dies with the service, but a leftover file in the socket directory
# would make a later reinstall's stale-socket check the only thing standing
# between a plant and a bind, so it is removed with the directory's parent. The
# directory itself is inside DATA_DIR and goes with it below.
rm -f "$DATA_DIR/run/authority.sock"
rm -f "$DATA_DIR/public/authority.json"
if [ -e "$DATA_DIR" ]; then
  archive="$DATA_DIR.removed-$(date +%Y%m%d%H%M%S)"
  mv "$DATA_DIR" "$archive"
  echo "State and ledger kept at $archive (still owned by $SERVICE_USER, mode 0700)."
fi
rm -rf "$INSTALL_DIR"
# The operator group is left in place: the service user is left too, and a group
# that owned the archived socket directory is the same kind of dangling
# reference. Remove it by hand once no state refers to it.
echo "HUQAN approval authority removed; the runtime is back in legacy mode."
echo "The operator group $SOCKET_GROUP was left in place; remove it by hand with 'groupdel $SOCKET_GROUP' if you want it gone."

#!/usr/bin/env bash
#
# Install the HUQAN agent user on Linux (ADR-020, #4082 PR-11).
#
# Run once, as root, before the first agent session. Creates the dedicated
# standard user that agents run as and writes the agent-user marker that
# lib/authority/agent-user-boundary.js reads. The split is real only once both
# exist: the marker is the evidence, and it is trusted only while its whole path
# is root-owned and link-free (posix-path-trust.js). An agent that could write
# the marker could claim a split that was never made, so the file and every
# ancestor are root's.
#
# The user is deliberately NOT added to sudo, wheel or admin: a uid that can
# become root voids the os-user split (ADR-020 section 9), and the boundary
# refuses it with agent_in_admin_group. A pre-existing user that is already an
# administrator is refused rather than silently edited.
#
# The marker path is fixed in source and never taken from the environment: the
# agent controls its own environment, so an env variable must not be able to
# move the evidence the boundary is read from (agent-user-boundary.js). The
# operator uid comes from SUDO_UID, the one value that must cross the sudo
# boundary, and it must name a non-root account.
#
# Usage: sudo scripts/agent-user/install-agent-user-linux.sh

set -euo pipefail

AGENT_USER=huqan-agent
STATE_ROOT=/var/lib/huqan/state
MARKER_FILE="$STATE_ROOT/agent-boundary.json"
MARKER_VERSION=huqan.agent-boundary.v1

fail() { echo "install-agent-user: $*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" -eq 0 ] || fail 'run this as root (sudo)'
}

# The operator's uid is the caller's, carried across sudo. Without it the marker
# cannot say what the agent is distinct from, and a split the boundary cannot
# corroborate is not a split.
require_operator_uid() {
  if [ -z "${SUDO_UID:-}" ]; then fail 'SUDO_UID is unset; run this with sudo from the operator account'; fi
  case "$SUDO_UID" in
    ''|*[!0-9]*) fail "SUDO_UID is not a uid: $SUDO_UID" ;;
  esac
  if [ "$SUDO_UID" -eq 0 ]; then fail 'SUDO_UID is 0; the operator must not be root'; fi
}

# A user that exists and is already an administrator is refused rather than
# patched: silently editing group membership is how a split gets reported that
# was never made.
assert_agent_user_safe() {
  id -u "$AGENT_USER" >/dev/null 2>&1 || return 0
  if id -nG "$AGENT_USER" 2>/dev/null | tr ' ' '\n' | grep -qxE 'sudo|wheel|admin'; then
    fail "$AGENT_USER is in sudo/wheel/admin; remove it there before installing"
  fi
}

ensure_agent_user() {
  if id -u "$AGENT_USER" >/dev/null 2>&1; then return 0; fi
  # A standard user (uid >= 1000), not --system: it owns a home and a session,
  # which is what the split needs. No sudo membership is granted here.
  useradd --create-home --shell /bin/bash "$AGENT_USER"
}

# The state root is created root-owned and closed to group and other write. It
# is the same root the protected store uses, so the boundary's trust walk and
# the store's ACL check look at one tree.
ensure_state_root() {
  mkdir -p "$STATE_ROOT"
  chown root:root "$STATE_ROOT"
  chmod 0755 "$STATE_ROOT"
}

# Write through a fresh file and rename, so a half-written marker never reaches
# the boundary as evidence. The uid is read back from the account database, not
# assumed: the marker must agree with `getent passwd` or the boundary answers
# agent_uid_mismatch.
write_marker() {
  local agent_uid operator_uid created tmp
  agent_uid="$(getent passwd "$AGENT_USER" | cut -d: -f3)"
  case "$agent_uid" in ''|*[!0-9]*) fail "cannot read a uid for $AGENT_USER" ;; esac
  [ "$agent_uid" -ne 0 ] || fail "$AGENT_USER has uid 0"
  operator_uid="$SUDO_UID"
  created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="$MARKER_FILE.tmp.$$"
  printf '{"v":"%s","agentUser":"%s","agentUid":%s,"operatorUid":%s,"createdAt":"%s"}\n' \
    "$MARKER_VERSION" "$AGENT_USER" "$agent_uid" "$operator_uid" "$created" > "$tmp"
  chown root:root "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$MARKER_FILE"
}

# Prove what the boundary will read: root owns both, and neither is writable by
# group or other. A link anywhere on the path fails the runtime's trust walk, so
# a link at the leaf is refused here too.
assert_protected() {
  local target owner mode
  for target in "$STATE_ROOT" "$MARKER_FILE"; do
    if [ -L "$target" ]; then fail "$target is a link"; fi
    owner="$(stat -c '%u' "$target")"
    if [ "$owner" != 0 ]; then fail "$target is not owned by root"; fi
    mode="$(( 8#$(stat -c '%a' "$target") ))"
    if [ $(( mode & 8#022 )) -ne 0 ]; then fail "$target is writable by group or other"; fi
  done
}

main() {
  require_root
  require_operator_uid
  assert_agent_user_safe
  ensure_agent_user
  assert_agent_user_safe
  ensure_state_root
  write_marker
  assert_protected
  echo "HUQAN agent user $AGENT_USER installed; boundary marker at $MARKER_FILE."
  echo 'Agents run as this user; the operator window stays in the operator session.'
}

main "$@"

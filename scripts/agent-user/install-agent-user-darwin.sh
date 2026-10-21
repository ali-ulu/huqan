#!/usr/bin/env bash
#
# Install the HUQAN agent user on macOS (ADR-020, #4082 PR-11).
#
# Run once, as root, before the first agent session. Creates the dedicated
# standard user that agents run as and writes the agent-user marker that
# lib/authority/agent-user-boundary.js reads. The split is real only once both
# exist: the marker is the evidence, and it is trusted only while its whole path
# is root-owned and link-free (posix-path-trust.js). An agent that could write
# the marker could claim a split that was never made, so the file and every
# ancestor are root's.
#
# /Library, not /var: /var and /etc are symlinks into /private on macOS, which
# would break the runtime's "no link on the path" rule (ADR-020 section 1), so
# the marker lives under /Library/HUQAN/state -- the same root section 8 names.
#
# The user is deliberately NOT added to admin or wheel: a uid that can become
# root voids the os-user split (ADR-020 section 9), and the boundary refuses it
# with agent_in_admin_group. A pre-existing user that is already an
# administrator is refused rather than silently edited.
#
# The marker path is fixed in source and never taken from the environment: the
# agent controls its own environment, so an env variable must not be able to
# move the evidence the boundary is read from (agent-user-boundary.js). The
# operator uid comes from SUDO_UID, the one value that must cross the sudo
# boundary, and it must name a non-root account.
#
# Usage: sudo scripts/agent-user/install-agent-user-darwin.sh

set -euo pipefail

AGENT_USER=huqan-agent
AGENT_GROUP=huqan-agent
STATE_ROOT=/Library/HUQAN/state
MARKER_FILE="$STATE_ROOT/agent-boundary.json"
MARKER_VERSION=huqan.agent-boundary.v1
# Normal accounts start at 501 on macOS; system accounts are below 500. The
# agent user is a normal account (it owns a session), so the search starts at
# 501 and takes the first uid and gid that are free.
UID_FLOOR=501

fail() { echo "install-agent-user-darwin: $*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" -eq 0 ] || fail 'run this as root (sudo)'
}

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
  if id -nG "$AGENT_USER" 2>/dev/null | tr ' ' '\n' | grep -qxE 'admin|wheel'; then
    fail "$AGENT_USER is in admin/wheel; remove it there before installing"
  fi
}

# The first uid at or above UID_FLOOR that the directory service has not taken.
free_uid() {
  local uid="$UID_FLOOR" taken
  taken="$(dscl . -list /Users UniqueID 2>/dev/null | awk '{print $2}')"
  while printf '%s\n' "$taken" | grep -qx "$uid"; do uid=$(( uid + 1 )); done
  printf '%s' "$uid"
}

free_gid() {
  local gid="$UID_FLOOR" taken
  taken="$(dscl . -list /Groups PrimaryGroupID 2>/dev/null | awk '{print $2}')"
  while printf '%s\n' "$taken" | grep -qx "$gid"; do gid=$(( gid + 1 )); done
  printf '%s' "$gid"
}

ensure_group() {
  dscl . -read "/Groups/$AGENT_GROUP" >/dev/null 2>&1 && return 0
  local gid
  gid="$(free_gid)"
  dscl . -create "/Groups/$AGENT_GROUP"
  dscl . -create "/Groups/$AGENT_GROUP" PrimaryGroupID "$gid"
  dscl . -create "/Groups/$AGENT_GROUP" RealName "HUQAN Agent"
}

ensure_agent_user() {
  dscl . -read "/Users/$AGENT_USER" >/dev/null 2>&1 && return 0
  local uid gid
  uid="$(free_uid)"
  gid="$(dscl . -read "/Groups/$AGENT_GROUP" PrimaryGroupID | awk '{print $2}')"
  dscl . -create "/Users/$AGENT_USER"
  dscl . -create "/Users/$AGENT_USER" UserShell /bin/bash
  dscl . -create "/Users/$AGENT_USER" RealName "HUQAN Agent"
  dscl . -create "/Users/$AGENT_USER" UniqueID "$uid"
  dscl . -create "/Users/$AGENT_USER" PrimaryGroupID "$gid"
  dscl . -create "/Users/$AGENT_USER" NFSHomeDirectory "/Users/$AGENT_USER"
  # Hidden from the login window and the user list, but still a normal account
  # with a home and a session -- which is what the split needs.
  dscl . -create "/Users/$AGENT_USER" IsHidden 1
  createhomedir -c -u "$AGENT_USER" >/dev/null 2>&1 || true
}

# The state root is created root-owned and closed to group and other write. It
# is the same root the protected store uses, so the boundary's trust walk and
# the store's ACL check look at one tree.
ensure_state_root() {
  mkdir -p "$STATE_ROOT"
  chown root:wheel "$STATE_ROOT"
  chmod 0755 "$STATE_ROOT"
}

# Write through a fresh file and rename, so a half-written marker never reaches
# the boundary as evidence. The uid is read back from the directory service, not
# assumed: the marker must agree with `dscl ... UniqueID` or the boundary answers
# agent_uid_mismatch.
write_marker() {
  local agent_uid operator_uid created tmp
  agent_uid="$(dscl . -read "/Users/$AGENT_USER" UniqueID | awk '{print $2}')"
  case "$agent_uid" in ''|*[!0-9]*) fail "cannot read a uid for $AGENT_USER" ;; esac
  [ "$agent_uid" -ne 0 ] || fail "$AGENT_USER has uid 0"
  operator_uid="$SUDO_UID"
  created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="$MARKER_FILE.tmp.$$"
  printf '{"v":"%s","agentUser":"%s","agentUid":%s,"operatorUid":%s,"createdAt":"%s"}\n' \
    "$MARKER_VERSION" "$AGENT_USER" "$agent_uid" "$operator_uid" "$created" > "$tmp"
  chown root:wheel "$tmp"
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
    owner="$(stat -f '%u' "$target")"
    if [ "$owner" != 0 ]; then fail "$target is not owned by root"; fi
    mode="$(( $(stat -f '%Lp' "$target") ))"
    if [ $(( mode & 8#022 )) -ne 0 ]; then fail "$target is writable by group or other"; fi
  done
}

main() {
  require_root
  require_operator_uid
  assert_agent_user_safe
  ensure_group
  ensure_agent_user
  assert_agent_user_safe
  ensure_state_root
  write_marker
  assert_protected
  echo "HUQAN agent user $AGENT_USER installed; boundary marker at $MARKER_FILE."
  echo 'Agents run as this user; the operator window stays in the operator session.'
}

main "$@"

#!/usr/bin/env bash
#
# Install the HUQAN approval authority as a launchd daemon on macOS
# (ADR-020, #4082 PR-5).
#
# Run once, as root, with every agent stopped: enrollment shows the TOTP secret
# on screen, and same-user code can read the screen.
#
# The daemon runs as the dedicated hidden system user _huqanauthority from a
# directory only root can write, using a node whose tarball is verified against
# the GPG-signed SHASUMS256.txt published by nodejs.org -- the same mechanism the
# Linux installer uses, which answers open question 2b in ADR-020. There is no
# unverified-node escape hatch and no use of a system node. The code comes from
# the npm tarball of --version, verified against the registry's dist.integrity,
# and only the files lib/authority/bundle-manifest.js lists are installed. The
# state directory is owned by the service user, mode 0700.
#
# /Library, not /usr/local: /var and /etc are symlinks into /private on macOS,
# which would break the runtime's "no link on the path" rule, and Homebrew can
# hand /usr/local to the user (ADR-020 section 1).
#
# Paths are fixed and never taken from the environment (ADR-020 section 1): the
# runtime trusts the pin at /Library/HUQAN/authority-data/public/authority.json
# and nothing else.
#
# With --socket the daemon listens on a unix socket instead of the loopback
# port: the socket is 0660 and group-owned by a dedicated operator group, so a
# local user outside that group cannot connect at all (ADR-020 section 12). The
# port stays in the pin, and without --socket the install is unchanged.
#
# Usage: sudo scripts/authority/install-authority-darwin.sh --version 1.0.2 [--node-version v22.23.3] [--port 47821] [--socket]

set -euo pipefail

SERVICE_LABEL=com.huqan.authority
SERVICE_USER=_huqanauthority
INSTALL_DIR=/Library/HUQAN/authority
NODE_DIR="$INSTALL_DIR/node"
APP_DIR="$INSTALL_DIR/app"
DATA_DIR=/Library/HUQAN/authority-data
STATE_DIR="$DATA_DIR/state"
PUBLIC_DIR="$DATA_DIR/public"
PIN_FILE="$PUBLIC_DIR/authority.json"
RUN_DIR="$DATA_DIR/run"
SOCKET_PATH="$RUN_DIR/authority.sock"
SOCKET_GROUP=_huqanauthority-ops
LOG_DIR=/Library/Logs/HUQAN
LOG_FILE="$LOG_DIR/authority.log"
PLIST_FILE="/Library/LaunchDaemons/$SERVICE_LABEL.plist"
NODE_DIST=https://nodejs.org/dist
NODE_KEYRING_URL=https://github.com/nodejs/release-keys/raw/HEAD/gpg/pubring.kbx
REGISTRY=https://registry.npmjs.org/huqan
MIN_NODE=22.13.0

# A pinned default (ADR-020 section 2), overridable so a newer LTS can be
# installed without editing this file.
NODE_VERSION=v22.23.3
PORT=47821
VERSION=
# The unix socket transport is opt-in (ADR-020 section 12): with --socket the
# daemon listens on $SOCKET_PATH and the pin names it. The port stays in the pin
# either way, so a TCP install is byte-for-byte what it was.
USE_SOCKET=0
# CI installs the tarball `npm pack` just produced instead of reading the
# registry metadata, and passes its expected integrity on the command line
# (ADR-020 open question 4). Enrollment then reads the code from stdin, because
# a runner has no controlling terminal to type it into.
TARBALL=
INTEGRITY=
ENROLL_FROM_STDIN=0

fail() { echo "install-authority-darwin: $*" >&2; exit 1; }

usage() {
  echo 'usage: install-authority-darwin.sh --version <x.y.z> [--node-version v22.23.3] [--port 47821] [--socket] [--tarball <path> --integrity <sha512-...>] [--enroll-code-stdin]' >&2
}

# A tiny JSON field reader, so the installer never needs jq. The node used here
# is the verified copy under $NODE_DIR. $field may be a dotted path, because the
# registry puts the integrity under dist.integrity.
json_field() {
  local file="$1" field="$2"
  "$NODE_DIR/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(process.argv[1].split(".").reduce((v,k)=>v==null?v:v[k],JSON.parse(s)) ?? "")))' "$field" < "$file"
}

# The nodejs.org tarball is per architecture; on a host this does not recognise
# the installer stops here rather than verifying a tarball it cannot exec.
node_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf '%s' x64 ;;
    arm64|aarch64) printf '%s' arm64 ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

# Exactly three numeric components. A shell case glob would also accept a value
# such as 1.0.0/../../other, which curl would then resolve against the registry.
validate_version() {
  local major minor patch extra
  IFS=. read -r major minor patch extra <<< "$1"
  for part in "$major" "$minor" "$patch"; do
    case "$part" in ''|*[!0-9]*) fail '--version must be x.y.z' ;; esac
  done
  [ -z "$extra" ] || fail '--version must be x.y.z'
}

require_root() {
  [ "$(id -u)" -eq 0 ] || fail 'run this as root (sudo)'
}

# Refuse ground the installer did not prepare: an existing daemon, program or
# data directory may belong to, or link to, anyone.
assert_fresh() {
  if [ -e "$PLIST_FILE" ]; then fail "$PLIST_FILE already exists; run uninstall-authority-darwin.sh first"; fi
  for dir in "$INSTALL_DIR" "$DATA_DIR"; do
    if [ -e "$dir" ]; then fail "$dir already exists; remove it (uninstall-authority-darwin.sh) and run again"; fi
  done
}

# The service user is a hidden system account below uid 500 with a shell that
# cannot log in (ADR-020 section 1). It is created only if absent, so a reinstall
# keeps the uid the state directory is owned by.
id_in_use() {
  dscl . -list "$1" "$2" 2>/dev/null | awk -v want="$3" '$NF == want { found = 1 } END { exit found ? 0 : 1 }'
}

next_free_id() {
  local id=499
  while [ "$id" -ge 400 ]; do
    if ! id_in_use "$1" "$2" "$id"; then printf '%s' "$id"; return 0; fi
    id=$((id - 1))
  done
  fail "no free $1 id below 500"
}

ensure_service_user() {
  if dscl . -read "/Users/$SERVICE_USER" >/dev/null 2>&1; then return 0; fi
  local uid gid
  uid="$(next_free_id /Users UniqueID)"
  gid="$(next_free_id /Groups PrimaryGroupID)"
  dscl . -create "/Groups/$SERVICE_USER"
  dscl . -create "/Groups/$SERVICE_USER" PrimaryGroupID "$gid"
  dscl . -create "/Groups/$SERVICE_USER" RealName 'HUQAN Approval Authority'
  dscl . -create "/Users/$SERVICE_USER"
  dscl . -create "/Users/$SERVICE_USER" UniqueID "$uid"
  dscl . -create "/Users/$SERVICE_USER" PrimaryGroupID "$gid"
  dscl . -create "/Users/$SERVICE_USER" NFSHomeDirectory /var/empty
  dscl . -create "/Users/$SERVICE_USER" UserShell /usr/bin/false
  dscl . -create "/Users/$SERVICE_USER" RealName 'HUQAN Approval Authority'
  dscl . -create "/Users/$SERVICE_USER" IsHidden 1
}

# The operator group narrows who can open the socket (ADR-020 section 12). dscl,
# not dseditgroup: the group is a hidden system group below gid 500, created only
# with --socket, and the caller -- the operator, carried across sudo as SUDO_UID
# -- is added to it. A group that exists is reused, never re-created, so a
# reinstall keeps the gid the socket directory is owned by.
require_operator_uid() {
  if [ -z "${SUDO_UID:-}" ]; then fail 'SUDO_UID is unset; run this with sudo from the operator account'; fi
  case "$SUDO_UID" in
    ''|*[!0-9]*) fail "SUDO_UID is not a uid: $SUDO_UID" ;;
  esac
  if [ "$SUDO_UID" -eq 0 ]; then fail 'SUDO_UID is 0; the operator must not be root'; fi
}

ensure_socket_group() {
  require_operator_uid
  if ! dscl . -read "/Groups/$SOCKET_GROUP" >/dev/null 2>&1; then
    local gid
    gid="$(next_free_id /Groups PrimaryGroupID)"
    dscl . -create "/Groups/$SOCKET_GROUP"
    dscl . -create "/Groups/$SOCKET_GROUP" PrimaryGroupID "$gid"
    dscl . -create "/Groups/$SOCKET_GROUP" RealName 'HUQAN Approval Authority Operators'
    dscl . -create "/Groups/$SOCKET_GROUP" GroupMembership
    dscl . -create "/Groups/$SOCKET_GROUP" IsHidden 1
  fi
  # dseditgroup -o edit -a is the idempotent membership edit; it only adds.
  # It takes an account name, not a uid, so SUDO_UID is resolved first.
  local operator
  operator="$(id -nu "$SUDO_UID")" || fail "no account for uid $SUDO_UID"
  dseditgroup -o edit -a "$operator" -t user "$SOCKET_GROUP" >/dev/null || fail "cannot add $operator to $SOCKET_GROUP"
}

# The socket directory is owned by the service user and group-owned by the
# operator group, mode 2750: setgid so a socket created inside it inherits the
# operator group rather than the creator's primary group, and closed to other so
# a non-member cannot even traverse it.
ensure_run_dir() {
  mkdir -p "$RUN_DIR"
  chown "$SERVICE_USER:$SOCKET_GROUP" "$RUN_DIR"
  chmod 2750 "$RUN_DIR"
}

install_node() {
  local staging="$1" ver="${NODE_VERSION#v}" arch tarball extract_dir
  arch="$(node_arch)"
  tarball="node-v${ver}-darwin-${arch}.tar.gz"
  extract_dir="node-v${ver}-darwin-${arch}"
  mkdir -p "$staging/gnupg"
  chmod 0700 "$staging/gnupg"
  curl -fsSL "$NODE_DIST/v${ver}/SHASUMS256.txt.asc" -o "$staging/SHASUMS256.txt.asc"
  curl -fsSL "$NODE_KEYRING_URL" -o "$staging/nodejs-keyring.kbx"
  # --decrypt verifies the clearsigned manifest and writes the plaintext out; a
  # signature that does not verify fails the command, not just the output. The
  # keyring is the release-keys keyring only, so a key in root's own keyring
  # cannot make a forged manifest verify.
  if ! GNUPGHOME="$staging/gnupg" gpg --batch --no-default-keyring --keyring "$staging/nodejs-keyring.kbx" \
      --decrypt "$staging/SHASUMS256.txt.asc" > "$staging/SHASUMS256.txt" 2>"$staging/gpg.log"; then
    fail "the node SHASUMS256.txt signature did not verify (see $staging/gpg.log)"
  fi
  grep -q " $tarball\$" "$staging/SHASUMS256.txt" || fail "SHASUMS256.txt has no entry for $tarball"
  curl -fsSL "$NODE_DIST/v${ver}/$tarball" -o "$staging/$tarball"
  # macOS has no coreutils digest tool; shasum -a 256 reads the same manifest.
  ( cd "$staging" && grep " $tarball\$" SHASUMS256.txt | shasum -a 256 -c - ) || fail "the node tarball does not match SHASUMS256.txt"
  tar -xzf "$staging/$tarball" -C "$staging"
  mkdir -p "$NODE_DIR"
  # The tarball records the release machine's uid (501 on the darwin build), and
  # cp -a would carry it onto the target. If that uid exists there, its owner
  # could replace the node the daemon execs, so normalise to root and drop the
  # group/other write bits.
  cp -a "$staging/$extract_dir/." "$NODE_DIR/"
  chown -R root:wheel "$NODE_DIR"
  chmod -R go-w "$NODE_DIR"
  local got
  got="$("$NODE_DIR/bin/node" -p 'process.versions.node')"
  if [ "$(printf '%s\n%s\n' "$MIN_NODE" "$got" | sort -V | head -1)" != "$MIN_NODE" ]; then
    fail "node $got is older than $MIN_NODE"
  fi
}

# Download the npm tarball of $VERSION, check it against the registry's
# dist.integrity, unpack it and print the package root.
#
# With --tarball the registry is not consulted at all: the file is the one the
# caller built, and --integrity is the sha512 the caller computed from it. The
# check is the same one the registry path performs, so the trust decision is
# unchanged -- only its source is.
get_verified_package() {
  local staging="$1" meta integrity tarball got
  tarball="$staging/huqan.tgz"
  if [ -n "$TARBALL" ]; then
    case "$INTEGRITY" in
      sha512-*) ;;
      *) fail '--tarball needs --integrity sha512-<base64>' ;;
    esac
    cp "$TARBALL" "$tarball"
    integrity="$INTEGRITY"
  else
    meta="$staging/registry.json"
    curl -fsSL "$REGISTRY/$VERSION" -o "$meta" || fail "cannot read registry metadata for $VERSION"
    integrity="$(json_field "$meta" dist.integrity)"
    case "$integrity" in
      sha512-*) ;;
      *) fail "registry metadata for $VERSION carries no sha512 integrity" ;;
    esac
    local url
    url="$(json_field "$meta" dist.tarball)"
    curl -fsSL "$url" -o "$tarball"
  fi
  # -A keeps openssl's base64 on one line; macOS base64 has no -w.
  got="sha512-$(openssl dgst -sha512 -binary "$tarball" | openssl base64 -A)"
  if [ "$got" != "$integrity" ]; then fail 'the downloaded package does not match the registry integrity'; fi
  mkdir -p "$staging/pkg"
  tar -xzf "$tarball" -C "$staging/pkg"
  printf '%s' "$staging/pkg/package"
}

# Copy exactly the bundle's files into the protected app directory, so the
# service cannot run code an agent could have written.
install_bundle() {
  local package="$1" rel files
  files="$("$NODE_DIR/bin/node" -e 'process.stdout.write(require(process.argv[1]).AUTHORITY_BUNDLE_FILES.join("\n"))' "$package/lib/authority/bundle-manifest.js")"
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    case "$rel" in
      lib/*.js) ;;
      *) fail "unexpected bundle path $rel" ;;
    esac
    case "$rel" in
      *..*) fail "unexpected bundle path $rel" ;;
    esac
    mkdir -p "$APP_DIR/$(dirname "$rel")"
    install -m 0644 "$package/$rel" "$APP_DIR/$rel"
  done <<< "$files"
}

install_plist() {
  # With --socket the daemon listens on the socket path; the port stays in the
  # argument list because serveAuthority takes both and the socket wins (ADR-020
  # section 12). Without --socket the plist is byte-for-byte what it was.
  local socket_args=''
  if [ "$USE_SOCKET" = 1 ]; then
    socket_args="    <string>--socket</string>
    <string>$SOCKET_PATH</string>"
  fi
  cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$SERVICE_LABEL</string>
  <key>UserName</key>
  <string>$SERVICE_USER</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_DIR/bin/node</string>
    <string>$APP_DIR/lib/authority/service-main.js</string>
    <string>serve</string>
    <string>--state-dir</string>
    <string>$STATE_DIR</string>
    <string>--port</string>
    <string>$PORT</string>
$socket_args
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_OPTIONS</key>
    <string></string>
  </dict>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
</dict>
</plist>
EOF
  # launchd refuses a daemon plist that group or other can write, and the
  # canonical owner is root:wheel.
  chown root:wheel "$PLIST_FILE"
  chmod 0644 "$PLIST_FILE"
  plutil -lint "$PLIST_FILE" >/dev/null
}

new_protected_tree() {
  mkdir -p "$DATA_DIR" "$PUBLIC_DIR" "$STATE_DIR" "$LOG_DIR"
  chown root:wheel "$DATA_DIR" "$PUBLIC_DIR"
  chmod 0755 "$DATA_DIR" "$PUBLIC_DIR"
  # The service user owns state, and only it: the serve self-check refuses a
  # state directory that is not owned by the running uid or is group-readable.
  chown "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR"
  chmod 0700 "$STATE_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$LOG_DIR"
  chmod 0750 "$LOG_DIR"
}

# The operator window is a fixed wrapper in the protected install, owned by
# root: the user-side `huqan-authority` never launches it, because code an agent
# can edit must not decide where an operator types the TOTP code (ADR-016).
install_decide_wrapper() {
  local wrapper="$INSTALL_DIR/huqan-authority-decide"
  cat > "$wrapper" <<EOF
#!/bin/sh
exec "$NODE_DIR/bin/node" "$APP_DIR/lib/authority/operator-cli.js" "\$@"
EOF
  chmod 0755 "$wrapper"
  chown root:wheel "$wrapper"
}

# Create the keys and the TOTP secret, prove enrollment, then hand the state to
# the service user. init and enroll-check run as root, so their files are root's
# until the chown at the end.
#
# Prompts go to stderr and the code is read from the controlling terminal, so
# the caller can capture the key id from stdout without swallowing the setup
# key, the URI and the retry message (they must reach the operator's screen).
invoke_enrollment() {
  local node="$NODE_DIR/bin/node" service_main="$APP_DIR/lib/authority/service-main.js" init uri secret code attempt key_id
  init="$staging/init.json"
  # The pin names the socket only when --socket was given: init validates the
  # path the same way serve does, so a pin can never name a path the server
  # would refuse (ADR-020 section 12).
  if [ "$USE_SOCKET" = 1 ]; then
    "$node" "$service_main" init --state-dir "$STATE_DIR" --public-dir "$PUBLIC_DIR" --port "$PORT" --socket "$SOCKET_PATH" > "$init" || fail 'service-main init failed'
  else
    "$node" "$service_main" init --state-dir "$STATE_DIR" --public-dir "$PUBLIC_DIR" --port "$PORT" > "$init" || fail 'service-main init failed'
  fi
  # The pin must be readable by every runtime user but writable only by root,
  # whatever the root umask is.
  chmod 0644 "$PIN_FILE"
  uri="$(json_field "$init" otpauthUri)"
  key_id="$(json_field "$init" keyId)"
  secret="$(printf '%s' "$uri" | sed -E 's/.*secret=([A-Z2-7]+).*/\1/')"
  {
    echo
    echo 'Add this to your authenticator app (setup key, time based, 6 digits, 30 seconds):'
    echo "  Account: HUQAN Authority:operator   Key: $secret"
    echo "  or the URI: $uri"
  } >&2
  for attempt in 1 2 3; do
    if [ "$ENROLL_FROM_STDIN" = 1 ]; then
      # EOF is an input failure, not a wrong code: looping it would spend the
      # three attempts on empty strings and record TOTP failures in
      # totp-progress.json, so the failed run would change enrollment state.
      read -r code || fail 'stdin closed before an enrollment code was read'
    else
      printf 'Enter the 6-digit code your app shows now: ' >&2
      read -r code < /dev/tty
    fi
    if "$node" "$service_main" enroll-check --state-dir "$STATE_DIR" --code "$code" >/dev/null 2>&1; then
      chown -R "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR"
      printf '%s' "$key_id"
      return 0
    fi
    echo 'That code did not match; wait for the next one and try again.' >&2
  done
  fail 'enrollment was not confirmed; nothing was started'
}

test_installed() {
  local key_id="$1" node="$NODE_DIR/bin/node" client pin script tries answer
  client="$APP_DIR/lib/authority/authority-client.js"
  pin="$APP_DIR/lib/authority/authority-pin.js"
  script='const fs=require("fs");const p=require(process.argv[2]).parseAuthorityPin(fs.readFileSync(process.argv[3],"utf8"));'
  script+='if(!p.ok)process.exit(3);require(process.argv[1]).createAuthorityClient({pin:p.pin}).identity()'
  script+='.then(r=>{process.stdout.write(String(r.body&&r.body.keyId));process.exit(r.status===200?0:4)},()=>process.exit(5))'
  for ((tries = 0; tries < 20; tries++)); do
    answer="$("$node" -e "$script" "$client" "$pin" "$PIN_FILE" 2>/dev/null || true)"
    if [ "$answer" = "$key_id" ]; then return 0; fi
    sleep 1
  done
  fail "the service did not answer under the pinned key $key_id"
}

# macOS stat spells the same questions differently: %u for the owner, and the
# mode in two pieces -- %Lp is the rwx bits alone, %Mp is the setuid/setgid/sticky
# bits. `%Lp` drops setgid, so a 2750 directory would read as 750; the two are
# concatenated to get the whole mode the way Linux's `%a` returns it.
owner_uid() { stat -f '%u' "$1"; }
file_mode() { printf '%s' "$(( 8#$(stat -f '%Mp%Lp' "$1") ))"; }

assert_protected() {
  local target
  # The service user owns state and it is closed to everyone else.
  if [ "$(owner_uid "$STATE_DIR")" = 0 ] || [ "$(file_mode "$STATE_DIR")" != 448 ]; then
    fail "$STATE_DIR must be owned by $SERVICE_USER, mode 0700"
  fi
  # The program and the verified node are root's too: an agent that could write
  # either would run code as the service user.
  for target in "$DATA_DIR" "$PUBLIC_DIR" "$PIN_FILE" "$INSTALL_DIR" "$NODE_DIR" "$APP_DIR"; do
    if [ -L "$target" ]; then fail "$target is a link"; fi
    if [ "$(owner_uid "$target")" != 0 ]; then fail "$target is not owned by root"; fi
    if [ $(( $(file_mode "$target") & 8#022 )) -ne 0 ]; then fail "$target is writable by group or other"; fi
  done
}

# The socket is only as narrow as its directory and its own mode: the directory
# is 2750 owned by the service user and the operator group, the socket is 0660
# and group-owned by that same group. A socket whose group is not the operator
# group would be openable by whoever the umask left it with, so it is checked
# against the group name, not just the bits (ADR-020 section 12).
group_name() { stat -f '%Sg' "$1"; }

assert_socket_protected() {
  local dir_owner dir_group dir_mode sock_owner sock_group sock_mode
  dir_owner="$(owner_uid "$RUN_DIR")"
  dir_group="$(group_name "$RUN_DIR")"
  dir_mode="$(file_mode "$RUN_DIR")"
  if [ "$dir_owner" != "$(dscl . -read "/Users/$SERVICE_USER" UniqueID | awk '{print $2}')" ] || [ "$dir_group" != "$SOCKET_GROUP" ] || [ "$dir_mode" != 1512 ]; then
    fail "$RUN_DIR must be owned by $SERVICE_USER:$SOCKET_GROUP, mode 2750"
  fi
  if [ ! -S "$SOCKET_PATH" ]; then fail "$SOCKET_PATH is not a socket"; fi
  sock_owner="$(owner_uid "$SOCKET_PATH")"
  sock_group="$(group_name "$SOCKET_PATH")"
  sock_mode="$(file_mode "$SOCKET_PATH")"
  if [ "$sock_owner" != "$dir_owner" ]; then fail "$SOCKET_PATH must be owned by $SERVICE_USER"; fi
  if [ "$sock_group" != "$SOCKET_GROUP" ]; then fail "$SOCKET_PATH must be group-owned by $SOCKET_GROUP"; fi
  if [ "$sock_mode" != 432 ]; then fail "$SOCKET_PATH must be mode 0660"; fi
}

# A failed run must leave nothing that starts at the next boot with unconfirmed
# state: the daemon plist is written before enrollment so the daemon can be
# proven, but the trap boots it out and removes it again on any failure.
cleanup() {
  local status=$?
  rm -rf "$staging"
  if [ "$status" -ne 0 ] && [ -e "$PLIST_FILE" ]; then
    launchctl bootout "system/$SERVICE_LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST_FILE"
  fi
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) VERSION="${2:-}"; shift 2 ;;
      --node-version) NODE_VERSION="${2:-}"; shift 2 ;;
      --port) PORT="${2:-}"; shift 2 ;;
      --socket) USE_SOCKET=1; shift ;;
      --tarball) TARBALL="${2:-}"; shift 2 ;;
      --integrity) INTEGRITY="${2:-}"; shift 2 ;;
      --enroll-code-stdin) ENROLL_FROM_STDIN=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) fail "unknown argument: $1" ;;
    esac
  done
  if [ -z "$VERSION" ]; then usage; fail '--version is required'; fi
  validate_version "$VERSION"
  case "$PORT" in
    ''|*[!0-9]*) fail '--port must be a number' ;;
  esac
  # --integrity without --tarball would be silently ignored, which reads as a
  # verified install; refuse instead. The pairing is checked here, not inside
  # get_verified_package, so a mistyped invocation fails before the node
  # tarball is downloaded.
  if [ -z "$TARBALL" ] && [ -n "$INTEGRITY" ]; then fail '--integrity is only used with --tarball'; fi
  if [ -n "$TARBALL" ] && [ -z "$INTEGRITY" ]; then fail '--tarball needs --integrity sha512-<base64>'; fi
  # The path is checked here, before require_root and new_protected_tree, so a
  # mistyped path fails before it can leave an account and a data tree behind
  # that make the next install fail assert_fresh.
  if [ -n "$TARBALL" ] && [ ! -f "$TARBALL" ]; then fail "--tarball is not a regular file: $TARBALL"; fi

  require_root
  assert_fresh
  command -v launchctl >/dev/null || fail 'launchd is required'
  command -v dscl >/dev/null || fail 'dscl is required'
  command -v plutil >/dev/null || fail 'plutil is required'
  command -v gpg >/dev/null || fail 'gpg is required to verify the node tarball'

  staging="$(mktemp -d)"
  trap cleanup EXIT

  ensure_service_user
  new_protected_tree
  # The group and the socket directory exist before the daemon is written and
  # started, because the plist names them (ADR-020 section 12).
  if [ "$USE_SOCKET" = 1 ]; then
    ensure_socket_group
    ensure_run_dir
  fi
  install_node "$staging"
  local package key_id
  package="$(get_verified_package "$staging")"
  install_bundle "$package"
  install_plist
  install_decide_wrapper
  key_id="$(invoke_enrollment)"
  # bootstrap loads the daemon and, because RunAtLoad is set, starts it. A plist
  # in /Library/LaunchDaemons would otherwise be loaded at every boot, so the
  # boot-time commitment here is the plist's presence: the cleanup trap removes
  # it again on any failure, which leaves nothing that starts at the next boot
  # with unconfirmed state (the macOS counterpart of enabling the systemd unit
  # last).
  launchctl bootstrap system "$PLIST_FILE"
  test_installed "$key_id"
  assert_protected
  if [ "$USE_SOCKET" = 1 ]; then assert_socket_protected; fi

  if [ "$USE_SOCKET" = 1 ]; then
    echo "HUQAN approval authority $VERSION installed (key $key_id, socket $SOCKET_PATH, group $SOCKET_GROUP)."
    echo "Only members of $SOCKET_GROUP can reach the socket; the operator was added to it."
  else
    echo "HUQAN approval authority $VERSION installed (key $key_id, port $PORT)."
  fi
  echo "Decide approvals with: sudo $INSTALL_DIR/huqan-authority-decide"
  echo 'Check the runtime with: node bin/huqan-authority.js status'
}

staging=
main "$@"

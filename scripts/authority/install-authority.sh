#!/usr/bin/env bash
#
# Install the HUQAN approval authority as a systemd service on Linux
# (ADR-020, #4082 PR-4).
#
# Run once, as root, with every agent stopped: enrollment shows the TOTP secret
# on screen, and same-user code can read the screen.
#
# The service runs as the dedicated system user huqan-authority from a
# directory only root can write, using a node whose tarball is verified against
# the GPG-signed SHASUMS256.txt published by nodejs.org. The code comes from the
# npm tarball of --version, verified against the registry's dist.integrity, and
# only the files lib/authority/bundle-manifest.js lists are installed. The state
# directory is owned by the service user, mode 0700.
#
# Paths are fixed and never taken from the environment (ADR-020 section 1): the
# runtime trusts the pin at /var/lib/huqan-authority/public/authority.json and
# nothing else.
#
# Usage: sudo scripts/authority/install-authority.sh --version 1.0.2 [--node-version v22.23.3] [--port 47821]

set -euo pipefail

SERVICE_NAME=huqan-authority
SERVICE_USER=huqan-authority
INSTALL_DIR=/opt/huqan-authority
NODE_DIR="$INSTALL_DIR/node"
APP_DIR="$INSTALL_DIR/app"
DATA_DIR=/var/lib/huqan-authority
STATE_DIR="$DATA_DIR/state"
PUBLIC_DIR="$DATA_DIR/public"
PIN_FILE="$PUBLIC_DIR/authority.json"
UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"
NODE_DIST=https://nodejs.org/dist
NODE_KEYRING_URL=https://github.com/nodejs/release-keys/raw/HEAD/gpg/pubring.kbx
REGISTRY=https://registry.npmjs.org/huqan
MIN_NODE=22.13.0

# A pinned default (ADR-020 section 2), overridable so a newer LTS can be
# installed without editing this file.
NODE_VERSION=v22.23.3
PORT=47821
VERSION=

fail() { echo "install-authority: $*" >&2; exit 1; }

usage() {
  echo 'usage: install-authority.sh --version <x.y.z> [--node-version v22.23.3] [--port 47821]' >&2
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
    aarch64|arm64) printf '%s' arm64 ;;
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

# Refuse ground the installer did not prepare: an existing unit, program or data
# directory may belong to, or link to, anyone.
assert_fresh() {
  if [ -e "$UNIT_FILE" ]; then fail "$UNIT_FILE already exists; run uninstall-authority.sh first"; fi
  for dir in "$INSTALL_DIR" "$DATA_DIR"; do
    if [ -e "$dir" ]; then fail "$dir already exists; remove it (uninstall-authority.sh) and run again"; fi
  done
}

ensure_service_user() {
  if ! getent group "$SERVICE_USER" >/dev/null; then groupadd --system "$SERVICE_USER"; fi
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --gid "$SERVICE_USER" --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
}

install_node() {
  local staging="$1" ver="${NODE_VERSION#v}" arch tarball extract_dir
  arch="$(node_arch)"
  tarball="node-v${ver}-linux-${arch}.tar.xz"
  extract_dir="node-v${ver}-linux-${arch}"
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
  ( cd "$staging" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c - ) || fail "the node tarball does not match SHASUMS256.txt"
  tar -xJf "$staging/$tarball" -C "$staging"
  mkdir -p "$NODE_DIR"
  cp -a "$staging/$extract_dir/." "$NODE_DIR/"
  local got
  got="$("$NODE_DIR/bin/node" -p 'process.versions.node')"
  if [ "$(printf '%s\n%s\n' "$MIN_NODE" "$got" | sort -V | head -1)" != "$MIN_NODE" ]; then
    fail "node $got is older than $MIN_NODE"
  fi
}

# Download the npm tarball of $VERSION, check it against the registry's
# dist.integrity, unpack it and print the package root.
get_verified_package() {
  local staging="$1" meta integrity tarball got
  meta="$staging/registry.json"
  curl -fsSL "$REGISTRY/$VERSION" -o "$meta" || fail "cannot read registry metadata for $VERSION"
  integrity="$(json_field "$meta" dist.integrity)"
  tarball="$staging/huqan.tgz"
  case "$integrity" in
    sha512-*) ;;
    *) fail "registry metadata for $VERSION carries no sha512 integrity" ;;
  esac
  local url
  url="$(json_field "$meta" dist.tarball)"
  curl -fsSL "$url" -o "$tarball"
  got="sha512-$(openssl dgst -sha512 -binary "$tarball" | base64 -w0)"
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

install_unit() {
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=HUQAN Approval Authority
Documentation=https://github.com/ali-ulu/huqan/blob/main/docs/adr/ADR-020-posix-authority-parity.md
After=network.target

[Service]
User=$SERVICE_USER
Group=$SERVICE_USER
ExecStart=$NODE_DIR/bin/node $APP_DIR/lib/authority/service-main.js serve --state-dir $STATE_DIR --port $PORT
Environment=NODE_OPTIONS=
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$STATE_DIR
ProtectHome=yes
PrivateTmp=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
SystemCallFilter=@system-service
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$UNIT_FILE"
  systemctl daemon-reload
}

new_protected_tree() {
  mkdir -p "$DATA_DIR" "$PUBLIC_DIR" "$STATE_DIR"
  chown root:root "$DATA_DIR" "$PUBLIC_DIR"
  chmod 0755 "$DATA_DIR" "$PUBLIC_DIR"
  # The service user owns state, and only it: the serve self-check refuses a
  # state directory that is not owned by the running uid or is group-readable.
  chown "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR"
  chmod 0700 "$STATE_DIR"
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
  chown root:root "$wrapper"
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
  "$node" "$service_main" init --state-dir "$STATE_DIR" --public-dir "$PUBLIC_DIR" --port "$PORT" > "$init" || fail 'service-main init failed'
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
    printf 'Enter the 6-digit code your app shows now: ' >&2
    read -r code < /dev/tty
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
  systemctl start "$SERVICE_NAME.service"
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

assert_protected() {
  local target owner mode
  # The service user owns state and it is closed to everyone else.
  owner="$(stat -c '%u' "$STATE_DIR")"
  mode="$(( 8#$(stat -c '%a' "$STATE_DIR") ))"
  if [ "$owner" = 0 ] || [ "$mode" != 448 ]; then fail "$STATE_DIR must be owned by $SERVICE_USER, mode 0700"; fi
  for target in "$DATA_DIR" "$PUBLIC_DIR" "$PIN_FILE"; do
    if [ -L "$target" ]; then fail "$target is a link"; fi
    owner="$(stat -c '%u' "$target")"
    mode="$(( 8#$(stat -c '%a' "$target") ))"
    if [ "$owner" != 0 ]; then fail "$target is not owned by root"; fi
    if [ $(( mode & 8#022 )) -ne 0 ]; then fail "$target is writable by group or other"; fi
  done
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) VERSION="${2:-}"; shift 2 ;;
      --node-version) NODE_VERSION="${2:-}"; shift 2 ;;
      --port) PORT="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) fail "unknown argument: $1" ;;
    esac
  done
  if [ -z "$VERSION" ]; then usage; fail '--version is required'; fi
  validate_version "$VERSION"
  case "$PORT" in
    ''|*[!0-9]*) fail '--port must be a number' ;;
  esac

  require_root
  assert_fresh
  command -v systemctl >/dev/null || fail 'systemd is required'
  command -v gpg >/dev/null || fail 'gpg is required to verify the node tarball'

  staging="$(mktemp -d)"
  trap 'rm -rf "$staging"' EXIT

  ensure_service_user
  new_protected_tree
  install_node "$staging"
  local package key_id
  package="$(get_verified_package "$staging")"
  install_bundle "$package"
  install_unit
  install_decide_wrapper
  key_id="$(invoke_enrollment)"
  test_installed "$key_id"
  assert_protected
  # Enable only now: a failure above leaves nothing that starts at the next boot
  # with unconfirmed state.
  systemctl enable "$SERVICE_NAME.service" >/dev/null

  echo "HUQAN approval authority $VERSION installed (key $key_id, port $PORT)."
  echo "Decide approvals with: sudo $INSTALL_DIR/huqan-authority-decide"
  echo 'Check the runtime with: node bin/huqan-authority.js status'
}

staging=
main "$@"

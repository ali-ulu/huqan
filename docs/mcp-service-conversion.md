# Converting shared MCP servers to per-server virtual service accounts

ADR-018 §3 (#3999) turns each shared MCP server from a stdio child of the
agent into a Windows service under its own virtual account,
`NT SERVICE\huqan-mcp-<name>`, listening on `127.0.0.1:<port>`, reached only
through the client envelope specified in
[mcp-client-envelope-spec.md](mcp-client-envelope-spec.md) (#3997) and never
holding an ACE on the protected memory store (#3998).

This page is the operator's path from "a spawned child" to "a protected
service". It claims what the commands below do; it does not claim that any
install has run them yet.

## 1. What each side is

- **The service** (`lib/mcp/service-main.js`): runs the ordinary MCP server
  (`mcpServer.createServer`) behind `lib/mcp/loopback-service.js`, which
  verifies the client envelope before the existing MCP gate and admission
  policy run. It holds no key of its own.
- **The state** (`C:\ProgramData\huqan\mcp\<name>\state`): the enrolled-client
  registry (`clients.json`) and the durable nonce records (`nonces/`), ACL'd to
  SYSTEM, Administrators, the operator account and the server's own service SID
  only. One server cannot read another server's state, and the agent user holds
  no ACE here.
- **The endpoint pin** (`...\public\endpoint.json`): the fixed loopback port,
  the server name, the operator account and the workspace id. Users may read
  it; only the elevated install writes it, once.
- **The proxy** (`huqan-mcp proxy`): the per-session stdio helper the agent's
  MCP client spawns instead of the server. It signs every frame with the
  client envelope and carries it to the loopback endpoint. It reads no
  protected state and refuses a non-loopback URL.
- **The memory store** (`C:\ProgramData\huqan\state`): untouched by this
  conversion. The server's account must hold no ACE on it; the server reaches
  the store through the runtime.

## 2. Install one server

Elevated PowerShell, agents stopped:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\mcp-service\install-mcp-service.ps1 `
  -Name levh -Version <package-version> -WorkspaceRoot C:\work\levh `
  -Port 47921 -OperatorAccount DESKTOP\operator
```

The installer verifies the npm tarball against the registry integrity, copies
node.exe after checking its OpenJS signature, creates the service under
`NT SERVICE\huqan-mcp-levh` (WinSW, `obj=` set, `sidtype unrestricted`),
applies the state ACL, writes the endpoint pin once, starts the service, and
refuses to declare success until the listener answers an unsigned request with
`403` -- a server that speaks without an envelope is not the boundary this
install promises. It then reads the DACLs back: any principal outside SYSTEM,
Administrators, the operator and the service SID on the state tree fails the
install, and so does any ACE the service SID holds on the memory store.

Uninstall keeps the registry for audit:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\mcp-service\uninstall-mcp-service.ps1 -Name levh
```

## 3. Enrol one agent client

The envelope authenticates the client, so each agent client gets an Ed25519
keypair the operator enrols (spec §5). Elevated, because it writes the
protected registry:

```powershell
huqan mcp enroll --name levh --client agent-claude-code --out C:\keys\levh-agent-claude-code.txt
```

This generates the keypair, writes the signing seed (unpadded base64url, one
line) to `--out`, and records `{client_id, key_id, public_key}` in the server's
registry. To enrol a key the operator already holds, pass
`--public-key <file>` instead of `--out`. Rotation enrols a second key per
client (the overlap bound is two records); revocation removes a record and
takes effect on the next request:

```powershell
huqan mcp revoke --name levh --client agent-claude-code --key-id <key-id>
```

## 4. Point the agent's client at the loopback endpoint

```powershell
huqan mcp config --name levh --client agent-claude-code --key-file C:\keys\levh-agent-claude-code.txt
```

prints the MCP client configuration: a `huqan-mcp proxy` command line pinned to
the endpoint URL, the workspace id and the seed file -- not a spawned server.
The proxy carries each frame as a signed request; a refused frame comes back
to the client as a JSON-RPC error naming the refusal code
(`binding_mismatch`, `replayed`, `expired`, ...).

## 5. Verify an install

```powershell
huqan mcp status --name levh
```

reads the pin, checks the state DACL against the spec (and refuses any
principal outside SYSTEM, Administrators, the operator and the service SID),
checks that the service SID holds no ACE on the memory store, probes the
listener for its fail-closed refusal, and summarises the enrolled clients. Its
`--json` form answers `ok: true` only when every leg is green; the verdict
line says `PROTECTED` only then.

## 6. Verification status

- The envelope verification, the registry, the pin, the ACL checks, the
  loopback transport, the proxy and the service entry are covered by the
  committed test suite (`test/mcp-client-envelope*.test.js`,
  `test/mcp-loopback-service.test.js`, `test/mcp-stdio-proxy.test.js`,
  `test/mcp-service-*.test.js`, `test/cli-mcp-service.test.js`), including the
  #3997 conformance vectors run through the production verifier.
- The installer's load-bearing properties are pinned by
  `test/mcp-service-installer-scripts.test.js`, the same way the authority
  installer's are; the installer itself runs only on a Windows host with
  operator elevation, which CI cannot exercise.
- `huqan mcp status` on a real install is the operator's evidence that the
  ACL checks hold on their machine; this repository's tests cannot prove that.

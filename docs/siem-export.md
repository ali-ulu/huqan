# SIEM export

`huqan-gate-hook siem-export` moves the external-action guard's decisions into
the deployment's own SIEM. Each admission receipt becomes one
`huqan.siem-event.v1` event: an allowlisted set of fields, scrubbed by the AB9
egress gate, carrying `event.id` (the receipt id) and `huqan.receipt.hash` so an
analyst can pivot from the SIEM back to the receipt. Issue: #4093.

The export runs as its own command, after the guard has decided. A SIEM that is
down, slow or misconfigured cannot change what an agent may do.

## What it is not

- **Not evidence.** A SIEM event is a copy of a fact the receipt holds. The
  receipt trail stays the source of truth; for evidence, use
  `huqan evidence pack` (#4092).
- **At-least-once, not exactly-once.** The cursor moves only after the sink
  accepted the events, so a crash or a failed delivery re-sends them. Deduplicate
  on `event.id`.
- **Not a vendor-certified integration.** The ECS, Splunk HEC and CEF output is
  checked by HUQAN's own tests, not certified by Elastic, Splunk or Microsoft.
- **Only admission receipts.** Other receipt kinds in the trail (outcomes,
  reviews, approvals) are counted under `skippedReceiptKinds` and not exported.

## Choose a transport

| Transport | Network | When |
|---|---|---|
| `file` (default) | none | A forwarder (Splunk UF, Elastic Agent, rsyslog) already runs on the host. |
| `syslog` | TLS to your collector | You have a syslog-over-TLS collector, for example the Sentinel log forwarder. |
| `http` | HTTPS to your collector | You send to Splunk HEC or Elastic `_bulk` directly. |

The file transport is the recommended default: HUQAN opens no connection, and
retention, buffering and delivery stay with the forwarder you already operate.

## Formats

`--format` picks the line written or sent:

| Format | Shape | Typical consumer |
|---|---|---|
| `jsonl` (default) | the canonical event, one JSON object per line | any JSON-aware forwarder |
| `ecs` | Elastic Common Schema field names | Elastic Agent, Elastic `_bulk` |
| `hec` | a Splunk HEC envelope (`time`, `host`, `source=huqan`, `sourcetype=huqan:receipt`, `event`) | Splunk HEC |
| `cef` | one CEF line per event (shape below) | CEF collectors, Microsoft Sentinel |

A CEF line has the shape:

```
CEF:0|HUQAN|huqan|<version>|<receipt kind>|<decision>|<severity>|<extension>
```

## Run it

Run it on a schedule (cron, systemd timer, Task Scheduler). Each run exports
what the previous run did not, and prints a JSON report. The exit code is `0` on
success, `1` when the sink refused the events (they stay pending), and `2` when
the arguments or the destination were refused before anything was read or sent.

```
huqan-gate-hook siem-export                       # file, jsonl
huqan-gate-hook siem-export --format ecs --dry-run
```

`--dry-run` reports what would be exported, including the receipt kinds that
would be skipped, and writes and sends nothing.

### File (default)

The log is `HUQAN_STATE/siem/huqan-events.jsonl`, mode `0600`, where
`HUQAN_STATE` is `$HUQAN_STATE_ROOT` if set, otherwise
`~/.local/state/huqan` on Linux and macOS and `%LOCALAPPDATA%\huqan` on Windows.
`--siem-log <path>` names another file; `--max-bytes <n>` sets the rotation size
(default 10 MiB).

At the limit the active file is renamed to the next free generation
(`huqan-events.jsonl.1`, `.2`, …) and a new one is started. Rotated files are
never deleted by HUQAN; that is the forwarder's retention decision. Point the
forwarder at the active file and the rotated ones.

### Syslog over TLS

```
huqan-gate-hook siem-export --sink syslog --url syslog+tls://siem.example.com:6514 --format cef
```

- RFC 5424 messages with RFC 6587 octet-counting framing, facility `local0`.
  Severity follows the decision: `block` is warning, `review` is notice, and
  everything else is informational. The message body is the formatted line.
- TLS 1.2 or later, with the server certificate always verified. Trust a private
  CA through `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. UDP and plain TCP are not
  offered.
- Port 6514 is the default.

### HTTPS (Splunk HEC or Elastic `_bulk`)

Do not type the token on the command line, where it lands in shell history.
Put it in the scheduler's secret store (a systemd `EnvironmentFile=` with mode
`0600`, or your vault agent) or read it without echo:

```
read -rs HUQAN_SIEM_HTTP_TOKEN && export HUQAN_SIEM_HTTP_TOKEN

huqan-gate-hook siem-export --sink http --format hec \
  --url https://splunk.example.com:8088/services/collector/event

huqan-gate-hook siem-export --sink http --format ecs \
  --url https://es.example.com:9200/huqan-events/_bulk
```

- `--format hec` posts HEC envelopes with `Authorization: Splunk <token>`.
- `--format ecs` posts an Elastic `_bulk` body that `create`s each event under
  its `event.id` (`Authorization: ApiKey <key>`). An event Elastic already holds
  answers 409 and counts as delivered, so a re-send does not duplicate it. The
  key needs `create_doc` on the target index or data stream.
- Splunk HEC cannot deduplicate. Up to 500 events go in each request; if a
  later request in the same run fails, the whole run is re-sent next time, and
  the events that already arrived are duplicated.
- The token is read only from `HUQAN_SIEM_HTTP_TOKEN` and is never printed. The
  URL must be HTTPS without credentials, query or fragment. Redirects are
  refused. The sink refuses to start when `NODE_TLS_REJECT_UNAUTHORIZED=0`.
  Retries follow the observability webhook's rules: 408/425/429/5xx and network
  errors, honouring `Retry-After`, at most 3 attempts.

### Which hosts a push may reach

Before a push sink opens anything, its host is judged by the guard's own gates:

- **Data residency (AB12).** When the command policy declares
  `dataResidency.allowedDestinations`, the SIEM host must be inside it. The
  event stream is treated as protected data, because its findings describe
  actions on citizen data. `--policy <file>` names the policy file; if that file
  does not exist, the push is refused rather than run without residency.
- **Expected egress (AB13).** With `HUQAN_EXTERNAL_GUARD_EXPECTED_EGRESS` set,
  the host must be in `HUQAN_EXTERNAL_GUARD_EXPECTED_DESTINATIONS`. In `block`
  mode an undeclared host is refused. In `review` mode it is refused too, because
  nobody reviews an unattended export, unless you accept it explicitly with
  `--allow-unreviewed-host`. The report then carries a warning.

A refused destination exits `2` with `SIEM_PUSH_DESTINATION_BLOCKED` and the
reason. Nothing is read and nothing is sent.

### Cursors

Each destination keeps its own position in the receipt trail. The file export
uses `<log>.cursor.json`. Each push endpoint and format uses
`HUQAN_STATE/siem/push-<kind>-<host>-<digest>.cursor.json`. Exporting to the file
and to two collectors therefore never marks one destination's events as
delivered to another. `--cursor <path>` overrides it. Deleting a cursor
re-exports everything still in the trail.

## Forwarder examples

The paths below assume Linux with the default state root. Adjust them for your
installation, and test in a staging index first.

### Splunk Universal Forwarder (file, `jsonl` or `ecs`)

`inputs.conf`:

```
[monitor:///home/huqan/.local/state/huqan/siem/huqan-events.jsonl*]
index = huqan
sourcetype = huqan:receipt
disabled = 0
```

`props.conf` (on the forwarder, so the JSON is extracted at index time):

```
[huqan:receipt]
INDEXED_EXTRACTIONS = json
TIMESTAMP_FIELDS = @timestamp
```

Splunk tracks rotated files by content, so the renamed generations are not
indexed twice. Do not set `crcSalt = <SOURCE>` for these files: a renamed
generation would be indexed again.

### Elastic Agent or Filebeat (file, `ecs`)

A `filestream` input with the `ndjson` parser:

```yaml
- type: filestream
  id: huqan-siem
  paths:
    - /home/huqan/.local/state/huqan/siem/huqan-events.jsonl*
  parsers:
    - ndjson:
        target: ""
        add_error_key: true
```

`filestream` identifies a file by its content, so a rotated generation keeps its
read position. Keep the rotated files inside `paths`, as above.

Check the version. Content identity (the fingerprint) is the default from 9.0.
From 9.0 to 9.4, a file is not read until it is larger than the fingerprint,
1024 bytes by default, and one HUQAN event can be smaller than that. On those
versions, shorten the fingerprint (the minimum is 64 bytes):

```yaml
  prospector.scanner.fingerprint.length: 64
```

From 9.5, small files are read at once
(`file_identity.fingerprint.growing`, on by default), and no setting is
needed. Either way, check that a one-event file arrives before you rely on the
input.

### Microsoft Sentinel (syslog over TLS, `cef`)

Sentinel ingests CEF through the Azure Monitor Agent on a Linux log forwarder
running rsyslog or syslog-ng ("CEF via AMA"). The Microsoft installer configures
the forwarder for plain syslog on port 514. HUQAN sends only TLS, so add a TLS
listener to the forwarder's rsyslog:

```
global(
  DefaultNetstreamDriver="gtls"
  DefaultNetstreamDriverCAFile="/etc/rsyslog.d/tls/ca.pem"
  DefaultNetstreamDriverCertFile="/etc/rsyslog.d/tls/cert.pem"
  DefaultNetstreamDriverKeyFile="/etc/rsyslog.d/tls/key.pem"
)
module(load="imtcp" StreamDriver.Name="gtls" StreamDriver.Mode="1" StreamDriver.Authmode="anon")
input(type="imtcp" port="6514")
```

This listener authenticates the server only. HUQAN verifies the forwarder's
certificate, but `Authmode="anon"` lets any host that reaches port 6514 send
messages, including forged CEF. HUQAN does not present a client certificate, so
restrict the port with a firewall to the hosts that run the export
([rsyslog on anonymous TLS](https://docs.rsyslog.com/doc/faq/tls_anon_auth_mitm.html)).

Then push to it:

```
huqan-gate-hook siem-export --sink syslog --url syslog+tls://forwarder.example.com:6514 --format cef
```

In the Data Collection Rule, CEF uses the `Microsoft-CommonSecurityLog` stream
and the events land in the `CommonSecurityLog` table. Messages arrive on
facility `local0`.

## Sources

- Elastic: [filestream input](https://www.elastic.co/docs/reference/beats/filebeat/filebeat-input-filestream)
- Splunk: [Monitor files and directories with inputs.conf](https://help.splunk.com/en/splunk-enterprise/get-started/get-data-in/9.0/get-data-from-files-and-directories/monitor-files-and-directories-with-inputs.conf),
  [How the Splunk platform handles log file rotation](https://help.splunk.com/en/splunk-cloud-platform/get-started/get-data-in/10.6/get-data-from-files-and-directories/how-the-splunk-platform-handles-log-file-rotation)
- Microsoft: [Ingest syslog and CEF messages to Microsoft Sentinel with the Azure Monitor Agent](https://learn.microsoft.com/en-us/azure/sentinel/connect-cef-syslog-ama)
- rsyslog: [TLS-protected syslog, central server](https://docs.rsyslog.com/doc//tutorials/tls_cert_server.html)

#!/usr/bin/env python3
"""Clean-room HUQAN evidence-pack verifier.

Implemented from the HUQAN Evidence Pack 0.1 README alone. It imports no HUQAN
code, requires no third-party package, and uses only the Python standard
library. It reuses the shipped receipt-bundle verifier
(specs/huqan-trust-protocol/0.2/conformance/verify_bundle.py) for the bundle
checks rather than re-implementing the bundle contract, so the two artifacts
cannot drift apart.

What a VALID verdict means, and what it does not:

    VALID means the pack is internally consistent -- the manifest recomputes to
    its own packHash, every listed file is present with the recorded bytes, no
    unlisted file is present, and any receipt bundle passes the bundle checks.

    VALID does NOT mean any control was met, does NOT mean HUQAN is SOC 2
    certified, does NOT prove the recorded events happened, and does NOT prove
    the operator is honest. Those limits are printed with the verdict.

Usage:
    python3 verify_pack.py <pack-dir> [...] [--collector-pubkeys <dir>]

Collector public keys are supplied apart from the pack (a pack never carries
the keys that vouch for it). Without them a pack that holds collector seals
is still VALID, with a warning that the seals were not verified.

Exit status is 0 when every pack verifies, 1 otherwise. Warnings never change it.
"""

import base64
import errno
import hashlib
import importlib.util
import json
import os
import posixpath
import re
import stat as stat_module
import sys

# Loading the shipped bundle verifier as a module would otherwise write a
# __pycache__ beside it, dirtying the tree the verifier is meant to leave
# untouched. This tool is read-only; keep it that way.
sys.dont_write_bytecode = True

SCHEMA_VERSION = "huqan.evidence-pack.v1"
MANIFEST_FILE = "manifest.json"
SIGNATURE_FILE = "manifest.signature.json"
SIGNATURE_SCHEMA_VERSION = "huqan.evidence-pack-signature.v1"
SIGNATURE_NON_CLAIM = ("the issuer signature proves origin, not independence: the public key travels "
                       "inside the pack and the issuing key lives on the operator host")
BUNDLE_RELATIVE_PATH = "receipts/receipt-bundle.json"
LEDGER_RELATIVE_PATH = "emergency-stop/ledger.jsonl"
LEDGER_ACTIONS = ("stop", "lift", "integrity_violation")
COLLECTOR_SEALS_RELATIVE_PATH = "external-actions/collector-seals.jsonl"
COLLECTOR_SEAL_VERSION = "huqan.collector-seal.v1"
UNVERIFIED_WARNING = "collector seals present, not verified: no collector public key supplied"
COLLECTOR_NON_CLAIM = ("collector seals are third-party evidence only if the collector is administered by someone "
                       "other than the operator; a seal chain whose last seals were removed cannot be told from a quiet period")

INTEGRITY_CLASSES = frozenset([
    "hash_chained",
    "counter_sealed",
    "issuer_sealed",
    "snapshot_hash_only",
])

# Escapes the spec mandates. Everything else printable stays literal.
_SHORT_ESCAPES = {
    '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f",
    "\n": "\\n", "\r": "\\r", "\t": "\\t",
}


def _utf16_sort_key(text):
    """Order by UTF-16 code unit, which is not the same as by code point."""
    return text.encode("utf-16-be", "surrogatepass")


def _encode_string(text):
    out = ['"']
    for ch in text:
        if ch in _SHORT_ESCAPES:
            out.append(_SHORT_ESCAPES[ch])
        elif ord(ch) < 0x20 or 0xD800 <= ord(ch) <= 0xDFFF:
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _encode_number(value):
    """ECMAScript Number::toString, which differs from Python's repr."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError("non-finite numbers cannot appear in JSON")
    if value == 0:
        return "0"
    if value == int(value) and abs(value) < 1e21:
        return str(int(value))
    text = repr(value)
    if "e" in text:
        mantissa, exponent = text.split("e")
        sign = "-" if exponent.startswith("-") else "+"
        digits = exponent.lstrip("+-").lstrip("0") or "0"
        if sign == "-" and int(digits) <= 6:
            return "%.*f" % (int(digits) + len(mantissa.replace("-", "").replace(".", "")) - 1, value)
        if mantissa.endswith(".0"):
            mantissa = mantissa[:-2]
        return "%se%s%s" % (mantissa, sign, digits)
    return text


def canonical_json(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _encode_string(value)
    if isinstance(value, (int, float)):
        return _encode_number(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=_utf16_sort_key)
        return "{" + ",".join(
            _encode_string(k) + ":" + canonical_json(value[k]) for k in keys
        ) + "}"
    raise TypeError("unsupported value: %r" % (value,))


def pack_hash(manifest):
    """packHash over the manifest minus packHash and signature."""
    payload = {k: v for k, v in manifest.items() if k not in ("packHash", "signature")}
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def load_bundle_verifier():
    """Load the shipped bundle verifier beside this file's spec tree."""
    here = os.path.dirname(os.path.abspath(__file__))
    spec_root = os.path.normpath(os.path.join(here, "..", ".."))
    path = os.path.join(spec_root, "huqan-trust-protocol", "0.2", "conformance", "verify_bundle.py")
    if not os.path.exists(path):
        return None
    spec = importlib.util.spec_from_file_location("huqan_verify_bundle_02", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# RFC 8032 Ed25519 verification, pure Python, so the stdlib-only contract holds
# (the same compact verifier the axiom-trust-protocol bundle verifier ships).
Q = 2 ** 255 - 19
L = 2 ** 252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, Q - 2, Q)) % Q
I = pow(2, (Q - 1) // 4, Q)
B_Y = (4 * pow(5, Q - 2, Q)) % Q


def _xrecover(y):
    xx = (y * y - 1) * pow(D * y * y + 1, Q - 2, Q) % Q
    x = pow(xx, (Q + 3) // 8, Q)
    if (x * x - xx) % Q:
        x = x * I % Q
    return x


B = (_xrecover(B_Y), B_Y)
if B[0] & 1:
    B = (Q - B[0], B[1])


def _add(p, q):
    x1, y1 = p
    x2, y2 = q
    x3 = (x1 * y2 + x2 * y1) * pow(1 + D * x1 * x2 * y1 * y2, Q - 2, Q) % Q
    y3 = (y1 * y2 + x1 * x2) * pow(1 - D * x1 * x2 * y1 * y2, Q - 2, Q) % Q
    return (x3, y3)


def _scalar_mult(p, n):
    result = (0, 1)
    while n:
        if n & 1:
            result = _add(result, p)
        p = _add(p, p)
        n >>= 1
    return result


def _decode_point(raw):
    if len(raw) != 32:
        return None
    value = int.from_bytes(raw, "little")
    sign = value >> 255
    y = value & ((1 << 255) - 1)
    if y >= Q:
        return None
    x = _xrecover(y)
    if (x * x - (y * y - 1) * pow(D * y * y + 1, Q - 2, Q)) % Q:
        return None
    if (x & 1) != sign:
        x = Q - x
    point = (x, y)
    return point if _scalar_mult(point, L) == (0, 1) else None


def ed25519_verify(raw_key, signature, message):
    """True when `signature` (64 bytes) is a valid Ed25519 signature of `message`."""
    if len(signature) != 64:
        return False
    r, s, a = _decode_point(signature[:32]), int.from_bytes(signature[32:], "little"), _decode_point(raw_key)
    if r is None or a is None or s >= L:
        return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + raw_key + message).digest(), "little") % L
    return _scalar_mult(B, s) == _add(r, _scalar_mult(a, h))


SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")


def spki_ed25519(pem):
    """Raw 32-byte key from an Ed25519 SPKI PEM, or None."""
    if not isinstance(pem, str):
        return None
    lines = [line.strip() for line in pem.splitlines() if not line.startswith("---")]
    try:
        der = base64.b64decode("".join(lines), validate=True)
    except Exception:
        return None
    return der[len(SPKI_PREFIX):] if len(der) == len(SPKI_PREFIX) + 32 and der.startswith(SPKI_PREFIX) else None


def key_id(raw_key):
    """The issuer key fingerprint: ed25519: + first 32 hex of SHA-256 over the SPKI DER."""
    return "ed25519:" + hashlib.sha256(SPKI_PREFIX + raw_key).hexdigest()[:32]


def signature_findings(pack_dir, manifest):
    """Check manifest.signature.json against the manifest. Returns (findings, signed, key_id)."""
    declared = (manifest.get("producer") or {}).get("issuerKeyId") if isinstance(manifest.get("producer"), dict) else None
    try:
        envelope = json.loads(read_listed_file(pack_dir, SIGNATURE_FILE).decode("utf-8"))
    except UnsafePackFile as unsafe:
        if unsafe.code == "PATH_NOT_FOUND":
            return (["signature_missing"] if declared else []), False, None
        return ["signature_unreadable"], True, None
    except (json.JSONDecodeError, UnicodeDecodeError):
        envelope = None
    well_formed = (
        isinstance(envelope, dict)
        and envelope.get("schemaVersion") == SIGNATURE_SCHEMA_VERSION
        and envelope.get("algorithm") == "ed25519"
        and all(isinstance(envelope.get(k), str) for k in ("keyId", "publicKeyPem", "signature"))
    )
    if not well_formed:
        return ["signature_format_invalid"], True, None
    findings = []
    raw_key = spki_ed25519(envelope["publicKeyPem"])
    if raw_key is None or key_id(raw_key) != envelope["keyId"]:
        findings.append("signature_key_id_mismatch")
    if envelope["keyId"] != declared:
        findings.append("signature_producer_key_mismatch")
    payload = {
        "schemaVersion": SIGNATURE_SCHEMA_VERSION,
        "packHash": manifest.get("packHash"),
        "period": manifest.get("period"),
        "generatedAt": manifest.get("generatedAt"),
    }
    try:
        signature = base64.b64decode(envelope["signature"], validate=True)
    except Exception:
        signature = b""
    if raw_key is None or not ed25519_verify(raw_key, signature, canonical_json(payload).encode("utf-8")):
        findings.append("signature_invalid")
    return findings, True, envelope["keyId"]



def load_collector_keys(directory):
    """keyId -> PEM from one file per key; the file name without .pem/.pub/.key is the keyId."""
    keys = {}
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return keys
    for name in names:
        path = os.path.join(directory, name)
        key = re.sub(r"\.(pem|pub|key)$", "", name, flags=re.IGNORECASE)
        if not key or not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as handle:
                keys[key] = handle.read()
        except (OSError, UnicodeDecodeError):
            pass
    return keys


def _js_string(value):
    """String(value || '') for the scalar types a seal field can hold; None when it is something else."""
    if value is None or value is False or value == "" or value == 0:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true"
    if isinstance(value, int):
        return str(value)
    return None


def _seal_payload(seal):
    fields = {}
    for name in ("batchId", "workspaceId", "ownerActorId", "contentHash", "receivedAt", "previousSealHash"):
        fields[name] = _js_string(seal.get(name))
        if fields[name] is None:
            return None
    count = seal.get("count")
    return {
        "schemaVersion": COLLECTOR_SEAL_VERSION,
        "batchId": fields["batchId"],
        "workspaceId": fields["workspaceId"],
        "ownerActorId": fields["ownerActorId"],
        "contentHash": fields["contentHash"],
        "count": int(count) if is_integer(count) else -1,
        "receivedAt": fields["receivedAt"],
        "previousSealHash": fields["previousSealHash"],
    }


def collector_seal_valid(seal, public_key_pem):
    """True only when this key made this seal over this statement (the stored sealHash is recomputed)."""
    if seal.get("schemaVersion") != COLLECTOR_SEAL_VERSION or seal.get("algorithm") != "ed25519":
        return False
    if not isinstance(seal.get("signature"), str):
        return False
    payload = _seal_payload(seal)
    raw_key = spki_ed25519(public_key_pem)
    if payload is None or raw_key is None:
        return False
    message = canonical_json(payload).encode("utf-8")
    if "sha256:" + hashlib.sha256(message).hexdigest() != seal.get("sealHash"):
        return False
    try:
        signature = base64.b64decode(seal["signature"], validate=True)
    except Exception:
        return False
    return ed25519_verify(raw_key, signature, message)


def collector_chain_reason(seals, keys):
    """Walk one tenant's seals in stored order; the first failing reason, else None (same tokens as verifyCollectorSealChain)."""
    previous = ""
    for seal in seals:
        key_id = seal.get("keyId") if isinstance(seal.get("keyId"), str) else None
        pem = keys.get(key_id) if key_id is not None else None
        if not pem:
            return "seal_key_not_trusted"
        if not collector_seal_valid(seal, pem):
            return "seal_signature_invalid"
        if _js_string(seal.get("previousSealHash")) != previous:
            return "seal_chain_broken"
        previous = seal["sealHash"]
    return None


def collector_seal_report(text, keys, issuer_key_id):
    """(findings, warnings) for collector-seals.jsonl; keys is None when no public key was supplied."""
    if keys is None:
        return [], [UNVERIFIED_WARNING]
    chains = {}
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except ValueError:
            parsed = None
        row = parsed if isinstance(parsed, dict) else {"__corrupt": True}
        tenant = tuple(row[name] if isinstance(row.get(name), str) else "" for name in ("workspaceId", "ownerActorId"))
        chains.setdefault(tenant, []).append(row)
    findings, used, warnings = [], set(), []
    for seals in chains.values():
        reason = collector_chain_reason(seals, keys)
        if reason:
            findings.append("collector_seal_chain_invalid:%s" % reason)
        used.update(s["keyId"] for s in seals if isinstance(s.get("keyId"), str) and s["keyId"] in keys)
    if issuer_key_id:
        for used_id in sorted(used):
            raw = spki_ed25519(keys[used_id])
            if raw is not None and key_id(raw) == issuer_key_id:
                warnings.append("collector_not_independent: the collector key and the issuer key (%s) are the same key, "
                                "so the counter-seal adds no independence" % issuer_key_id)
                break
    return findings, warnings


def manifest_path_invalid(relative):
    """The manifest path policy: a packed file is named by a canonical,
    relative, forward-slash path. An absolute path, a backslash, a `.` or `..`
    segment, or a non-normalized form would let os.path.join(pack_dir, ...)
    resolve outside the pack. Same rule, same token, as verify.js."""
    if relative.startswith("/") or os.path.isabs(relative):
        return True
    if "\\" in relative:
        return True
    if any(segment in ("", ".", "..") for segment in relative.split("/")):
        return True
    return posixpath.normpath(relative) != relative


def is_integer(value):
    """Match JS Number.isInteger: an integer-valued number, but not a bool."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and value.is_integer()


class UnsafePackFile(Exception):
    """A manifest path that is not the regular file inside the pack it claimed to be.

    Mirrors readFileWithinRoot in lib/path-safety.js (#4247, CWE-22). `code` is
    the shared token the JS side uses, so the two verifiers report the same
    finding for the same fixture.
    """

    def __init__(self, code, relative):
        super().__init__("%s:%s" % (code, relative))
        self.code = code
        self.relative = relative


def read_listed_file(pack_dir, relative):
    """Read one manifest-named file, or raise UnsafePackFile.

    A path the manifest lists is a claim the pack can lie about. Containment
    alone is not enough: a final symlink would be realpathed and admitted, a
    FIFO would block `open` forever (the denial of service in #4247), and a
    device is not the regular file the manifest promised. Each is refused
    fail-closed instead of being hashed or opened.
    """
    absolute = os.path.join(pack_dir, relative)
    try:
        info = os.lstat(absolute)
    except OSError as error:
        raise UnsafePackFile("PATH_NOT_FOUND" if error.errno == errno.ENOENT else "PATH_UNREADABLE", relative) from None
    except ValueError:
        # An embedded NUL or unencodable character in a manifest-named path
        # makes os.lstat raise ValueError, not OSError. The JS reader maps the
        # same input to PATH_UNREADABLE, so the verdict has to match.
        raise UnsafePackFile("PATH_UNREADABLE", relative) from None
    if stat_module.S_ISLNK(info.st_mode):
        raise UnsafePackFile("PATH_SYMLINK", relative)
    if not stat_module.S_ISREG(info.st_mode):
        raise UnsafePackFile("PATH_NOT_REGULAR", relative)

    root_real = os.path.realpath(pack_dir)
    target_real = os.path.realpath(absolute)
    if target_real != root_real and not target_real.startswith(root_real + os.sep):
        raise UnsafePackFile("PATH_OUTSIDE_ALLOWED_ROOT", relative)

    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    # O_NONBLOCK makes a FIFO open return so the descriptor can be judged; it is
    # not a deadline for a regular-file read (no flag bounds that). The type gate
    # below is what refuses the FIFO in #4247, so the special-file denial of
    # service cannot stall the verifier.
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    # os.open defaults to text mode on Windows, which would translate CRLF to LF
    # and make every Windows pack's bytes differ from the ones the manifest
    # hashed. O_BINARY pins the raw bytes the manifest is a claim about.
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    try:
        descriptor = os.open(absolute, flags)
    except OSError as error:
        raise UnsafePackFile("PATH_SYMLINK" if error.errno == errno.ELOOP else "PATH_UNREADABLE", relative) from None
    try:
        opened = os.fstat(descriptor)
        if not stat_module.S_ISREG(opened.st_mode):
            raise UnsafePackFile("PATH_NOT_REGULAR", relative)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise UnsafePackFile("PATH_CHANGED", relative)
        chunks = []
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def walk_pack_files(pack_dir):
    out = []
    for root, dirs, files in os.walk(pack_dir):
        dirs.sort()
        # A symlinked directory is not followed by os.walk, but it is still an
        # entry in the pack directory that the manifest must list. Report it, so
        # a link out of the pack is an unlisted_file rather than a silent skip.
        for name in sorted(dirs):
            if os.path.islink(os.path.join(root, name)):
                out.append(os.path.relpath(os.path.join(root, name), pack_dir).replace(os.sep, "/"))
        for name in sorted(files):
            absolute = os.path.join(root, name)
            out.append(os.path.relpath(absolute, pack_dir).replace(os.sep, "/"))
    return out


def ledger_reason(text):
    """Walk the emergency-stop ledger hash chain from genesis.

    Returns None when the chain holds, else the first failing reason -- the same
    token, in the same check order, as verify.js. An entry is the ledger line
    without `hash`, `seq` and `prevHash`; its hash is SHA-256 over the canonical
    JSON of that payload plus the previous entry's hash as `prevHash`.
    """
    entries = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except ValueError:
            parsed = None
        entries.append(parsed if isinstance(parsed, dict) else None)
    if any(entry is None for entry in entries):
        return "ledger_unreadable_or_corrupt"
    prev_hash = None
    for index, entry in enumerate(entries):
        seq = entry.get("seq")
        if isinstance(seq, bool) or not isinstance(seq, (int, float)) or seq != index:
            return "ledger_seq_gap"
        if entry.get("prevHash") != prev_hash:
            return "ledger_prevhash_mismatch"
        payload = {k: v for k, v in entry.items() if k not in ("hash", "seq", "prevHash")}
        payload["prevHash"] = prev_hash
        digest = hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()
        if entry.get("hash") != digest:
            return "ledger_hash_mismatch"
        action = entry.get("action")
        if not action or action not in LEDGER_ACTIONS:
            return "ledger_invalid_action"
        prev_hash = entry["hash"]
    return None


def verify(pack_dir, bundle_verifier, collector_pubkeys=None):
    findings = []
    try:
        manifest = json.loads(read_listed_file(pack_dir, MANIFEST_FILE).decode("utf-8"))
    except UnsafePackFile:
        return ["manifest_unreadable"], [], [], (False, None), []
    except (json.JSONDecodeError, UnicodeDecodeError):
        return ["manifest_not_json"], [], [], (False, None), []

    if not isinstance(manifest, dict):
        return ["manifest_not_object"], [], [], (False, None), []
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        findings.append("manifest_schema_version_mismatch")
    entries_raw = manifest.get("files")
    if not isinstance(entries_raw, list):
        findings.append("manifest_files_missing")
        return findings, [], manifest.get("nonClaims") or [], (False, None), []

    if pack_hash(manifest) != manifest.get("packHash"):
        findings.append("pack_hash_mismatch")

    entries = {}
    file_reports = []
    for entry in entries_raw:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not entry["path"]:
            findings.append("manifest_file_entry_invalid")
            continue
        relative = entry["path"]
        if manifest_path_invalid(relative):
            findings.append("manifest_path_invalid:%s" % relative)
            continue
        if relative in entries:
            findings.append("manifest_duplicate_entry:%s" % relative)
        entries[relative] = entry
        if entry.get("integrityClass") not in INTEGRITY_CLASSES:
            findings.append("manifest_unknown_integrity_class:%s" % relative)

    for relative, entry in entries.items():
        try:
            data = read_listed_file(pack_dir, relative)
        except UnsafePackFile as unsafe:
            if unsafe.code == "PATH_NOT_FOUND":
                findings.append("missing_file:%s" % relative)
            else:
                findings.append("unsafe_file:%s" % relative)
            file_reports.append((relative, entry.get("integrityClass"), False, None))
            continue
        actual_hash = hashlib.sha256(data).hexdigest()
        actual_bytes = len(data)
        hash_valid = actual_hash == entry.get("sha256")
        if not hash_valid:
            findings.append("file_hash_mismatch:%s" % relative)
        if not is_integer(entry.get("bytes")) or entry["bytes"] != actual_bytes:
            findings.append("file_size_mismatch:%s" % relative)
        file_reports.append((relative, entry.get("integrityClass"), True, hash_valid))

    for relative in walk_pack_files(pack_dir):
        if relative in (MANIFEST_FILE, SIGNATURE_FILE):
            continue
        if relative not in entries:
            findings.append("unlisted_file:%s" % relative)

    if BUNDLE_RELATIVE_PATH in entries and bundle_verifier is None:
        findings.append("receipt_bundle_verifier_unavailable")
    elif BUNDLE_RELATIVE_PATH in entries:
        try:
            bundle = json.loads(read_listed_file(pack_dir, BUNDLE_RELATIVE_PATH).decode("utf-8"))
            ok, _bundle_findings = bundle_verifier.verify(bundle)
            if not ok:
                findings.append("receipt_bundle_invalid")
        except Exception:
            # A bundle the verifier cannot even read (a broken envelope, a
            # missing required field) is a finding, not a crash: the pack is
            # being judged, and the verdict has to be reported either way.
            findings.append("receipt_bundle_unreadable")

    if LEDGER_RELATIVE_PATH in entries:
        try:
            reason = ledger_reason(read_listed_file(pack_dir, LEDGER_RELATIVE_PATH).decode("utf-8"))
            if reason:
                findings.append("emergency_stop_ledger_invalid:%s" % reason)
        except Exception:
            findings.append("emergency_stop_ledger_unreadable")

    warnings = []
    if COLLECTOR_SEALS_RELATIVE_PATH in entries:
        try:
            seal_text = read_listed_file(pack_dir, COLLECTOR_SEALS_RELATIVE_PATH).decode("utf-8")
            producer = manifest.get("producer")
            issuer = producer.get("issuerKeyId") if isinstance(producer, dict) else None
            keys = load_collector_keys(collector_pubkeys) if collector_pubkeys else None
            seal_findings, warnings = collector_seal_report(seal_text, keys, issuer)
            findings.extend(seal_findings)
        except Exception:
            findings.append("collector_seals_unreadable")

    sig_findings, signed, signer = signature_findings(pack_dir, manifest)
    findings.extend(sig_findings)
    non_claims = list(manifest.get("nonClaims") or [])
    if signed:
        non_claims.append(SIGNATURE_NON_CLAIM)
    if COLLECTOR_SEALS_RELATIVE_PATH in entries:
        non_claims.append(COLLECTOR_NON_CLAIM)
    return findings, file_reports, non_claims, (signed, signer), warnings


def report(pack_dir, findings, file_reports, non_claims, signature=(False, None), warnings=()):
    name = os.path.basename(os.path.normpath(pack_dir)) or pack_dir
    if findings:
        print("%-40s INVALID  %s" % (name, ", ".join(findings)))
        for warning in warnings:
            print("    warning: %s" % warning)
        return False
    print("%-40s VALID" % name)
    print("    signature: %s" % ("signed  keyId: %s" % signature[1] if signature[0] else "unsigned"))
    for warning in warnings:
        print("    warning: %s" % warning)
    for relative, integrity_class, _present, _hash_valid in file_reports:
        print("    %-48s %s" % (relative, integrity_class))
    for claim in non_claims:
        print("    non-claim: %s" % claim)
    return True


def main(argv):
    pubkeys = None
    if "--collector-pubkeys" in argv:
        at = argv.index("--collector-pubkeys")
        if at + 1 >= len(argv) or argv[at + 1].startswith("--"):
            print("usage: verify_pack.py <pack-dir> [...] [--collector-pubkeys <dir>]", file=sys.stderr)
            return 2
        pubkeys = argv[at + 1]
        argv = argv[:at] + argv[at + 2:]
    if not argv:
        print("usage: verify_pack.py <pack-dir> [...] [--collector-pubkeys <dir>]", file=sys.stderr)
        return 2
    bundle_verifier = load_bundle_verifier()
    ok = True
    for pack_dir in argv:
        findings, file_reports, non_claims, signature, warnings = verify(pack_dir, bundle_verifier, pubkeys)
        ok = report(pack_dir, findings, file_reports, non_claims, signature, warnings) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

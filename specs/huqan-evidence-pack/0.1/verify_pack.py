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
    python3 verify_pack.py <pack-dir> [...]

Exit status is 0 when every pack verifies, 1 otherwise.
"""

import hashlib
import importlib.util
import json
import os
import posixpath
import sys

# Loading the shipped bundle verifier as a module would otherwise write a
# __pycache__ beside it, dirtying the tree the verifier is meant to leave
# untouched. This tool is read-only; keep it that way.
sys.dont_write_bytecode = True

SCHEMA_VERSION = "huqan.evidence-pack.v1"
MANIFEST_FILE = "manifest.json"
SIGNATURE_FILE = "manifest.signature.json"
BUNDLE_RELATIVE_PATH = "receipts/receipt-bundle.json"

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


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


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


def verify(pack_dir, bundle_verifier):
    findings = []
    manifest_path = os.path.join(pack_dir, MANIFEST_FILE)
    try:
        with open(manifest_path, encoding="utf-8") as handle:
            manifest = json.load(handle)
    except OSError:
        # Every read failure is manifest_unreadable, matching verify.js: a
        # permission error must not escape verify() and skip the verdict line.
        return ["manifest_unreadable"], [], []
    except (json.JSONDecodeError, UnicodeDecodeError):
        return ["manifest_not_json"], [], []

    if not isinstance(manifest, dict):
        return ["manifest_not_object"], [], []
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        findings.append("manifest_schema_version_mismatch")
    entries_raw = manifest.get("files")
    if not isinstance(entries_raw, list):
        findings.append("manifest_files_missing")
        return findings, [], manifest.get("nonClaims") or []

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
        absolute = os.path.join(pack_dir, relative)
        if not os.path.isfile(absolute):
            findings.append("missing_file:%s" % relative)
            file_reports.append((relative, entry.get("integrityClass"), False, None))
            continue
        actual_hash = sha256_file(absolute)
        actual_bytes = os.path.getsize(absolute)
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
        bundle_path = os.path.join(pack_dir, BUNDLE_RELATIVE_PATH)
        try:
            with open(bundle_path, encoding="utf-8") as handle:
                bundle = json.load(handle)
            ok, _bundle_findings = bundle_verifier.verify(bundle)
            if not ok:
                findings.append("receipt_bundle_invalid")
        except Exception:
            # A bundle the verifier cannot even read (a broken envelope, a
            # missing required field) is a finding, not a crash: the pack is
            # being judged, and the verdict has to be reported either way.
            findings.append("receipt_bundle_unreadable")

    return findings, file_reports, manifest.get("nonClaims") or []


def report(pack_dir, findings, file_reports, non_claims):
    name = os.path.basename(os.path.normpath(pack_dir)) or pack_dir
    if findings:
        print("%-40s INVALID  %s" % (name, ", ".join(findings)))
        return False
    print("%-40s VALID" % name)
    for relative, integrity_class, _present, _hash_valid in file_reports:
        print("    %-48s %s" % (relative, integrity_class))
    for claim in non_claims:
        print("    non-claim: %s" % claim)
    return True


def main(argv):
    if not argv:
        print("usage: verify_pack.py <pack-dir> [...]", file=sys.stderr)
        return 2
    bundle_verifier = load_bundle_verifier()
    ok = True
    for pack_dir in argv:
        findings, file_reports, non_claims = verify(pack_dir, bundle_verifier)
        ok = report(pack_dir, findings, file_reports, non_claims) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

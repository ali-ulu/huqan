#!/usr/bin/env python3
"""Clean-room ATP v0.1 receipt bundle verifier.

Implemented from RECEIPT-BUNDLE.md alone. It imports no HUQAN code, requires no
third-party package, and uses only the Python standard library. Its purpose is
to be a second implementation: if it and the JavaScript producer agree on the
bytes, the specification is portable; if they disagree, the specification is
underspecified and that is a defect worth reporting.

Usage:
    python3 verify_bundle.py <bundle.json> [...]

Exit status is 0 when every bundle verifies, 1 otherwise.
"""

import hashlib
import json
import sys

GENESIS = "genesis:v4-receipt-chain"

# Escapes the spec mandates. Everything else printable stays literal.
_SHORT_ESCAPES = {
    '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f",
    "\n": "\\n", "\r": "\\r", "\t": "\\t",
}


def _utf16_sort_key(text):
    """Order by UTF-16 code unit, which is not the same as by code point.

    U+1F600 is stored as the surrogate pair D83D DE00, so it sorts before
    U+E000 under UTF-16 but after it under Python's native code-point sort.
    """
    return text.encode("utf-16-be", "surrogatepass")


def _encode_string(text):
    out = ['"']
    for ch in text:
        if ch in _SHORT_ESCAPES:
            out.append(_SHORT_ESCAPES[ch])
        elif ord(ch) < 0x20 or 0xD800 <= ord(ch) <= 0xDFFF:
            # Control characters, and unpaired surrogates which have no valid
            # UTF-8 encoding, use lowercase \uXXXX.
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
        return "0"  # collapses -0 to 0, as JSON.stringify does
    if value == int(value) and abs(value) < 1e21:
        return str(int(value))

    text = repr(value)
    if "e" in text:
        mantissa, exponent = text.split("e")
        sign = "-" if exponent.startswith("-") else "+"
        digits = exponent.lstrip("+-").lstrip("0") or "0"
        # JavaScript uses plain decimal until the exponent drops below 1e-7.
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


def sha256_hex(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def check_bundle_seal(bundle):
    return sha256_hex(canonical_json(bundle["receipts"])) == bundle["bundleHash"]


def expected_envelope_version(receipts):
    v2 = any(r.get("schemaVersion") == "v4-receipt-v2" for r in receipts)
    return "v4-receipt-bundle-v2" if v2 else "v4-receipt-bundle-v1"


def validate_chain(receipts):
    for i, record in enumerate(receipts):
        if (not isinstance(record, dict) or not record.get("receiptHash")
                or not record.get("previousReceiptHash")):
            return (False, i, "content_tampered")
        rest = {k: v for k, v in record.items() if k != "receiptHash"}
        if sha256_hex(canonical_json(rest)) != record["receiptHash"]:
            return (False, i, "content_tampered")
        if i == 0:
            if record["previousReceiptHash"] != GENESIS:
                return (False, i, "genesis_mismatch")
        elif record["previousReceiptHash"] != receipts[i - 1]["receiptHash"]:
            return (False, i, "chain_link_broken")
    return (True, None, None)


def verify(bundle):
    """Return (ok, findings) for one parsed bundle."""
    findings = []
    if not check_bundle_seal(bundle):
        findings.append("bundle_seal_mismatch")
    if bundle.get("schemaVersion") != expected_envelope_version(bundle["receipts"]):
        findings.append("envelope_version_mismatch")
    # receiptCount is deliberately NOT checked. The specification defines exactly
    # three checks, and the producer's verifyExportedBundle() likewise derives
    # validity from bundle seal, envelope version and chain only. Rejecting a
    # bundle on receiptCount would make this verifier stricter than the format it
    # implements, which is a conformance defect even though it sounds safer.
    ok, broken_at, reason = validate_chain(bundle["receipts"])
    if not ok:
        findings.append("%s@%d" % (reason, broken_at))
    return (not findings, findings)


def main(argv):
    failed = False
    for path in argv:
        with open(path, encoding="utf-8") as handle:
            bundle = json.load(handle)
        ok, findings = verify(bundle)
        print("%-46s %s%s" % (
            path.split("/")[-1],
            "VALID" if ok else "INVALID",
            "" if ok else "  " + ", ".join(findings),
        ))
        failed = failed or not ok
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

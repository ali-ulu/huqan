#!/usr/bin/env python3
"""Clean-room ATP v0.1 receipt bundle verifier.

Implemented from RECEIPT-BUNDLE.md alone. It imports no HUQAN code, requires no
third-party package, and uses only the Python standard library. Its purpose is
to be a second implementation: if it and the JavaScript producer agree on the
bytes, the specification is portable; if they disagree, the specification is
underspecified and that is a defect worth reporting.

What a VALID verdict means, and what it does not:

    VALID means the bundle is internally consistent under ATP v0.1's three
    verification checks -- bundle seal, envelope version, chain validation.

    Because the format is unsigned and self-contained, VALID does NOT prove the
    bundle is authentic, nor that it is unchanged since export, against a party
    able to recompute the receipt hashes, the chain links and bundleHash. Such a
    party produces a bundle this tool reports as VALID. Establishing that a
    bundle matches what its issuer holds requires comparing bundleHash against a
    value obtained from the issuer through a separate channel.

Usage:
    python3 verify_bundle.py <bundle.json> [...]

Exit status is 0 when every bundle verifies, 1 otherwise.
"""

import hashlib
import json
import sys
import base64

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


SEAL_VERSION = "huqan-bundle-seal-v2"
SIGNATURE_SCHEMA_VERSION = "huqan.receipt-bundle-signature.v1"

# RFC 8032 Ed25519 verification.  It is included (rather than imported) so
# this clean-room verifier keeps its stdlib-only contract.
Q = 2 ** 255 - 19
L = 2 ** 252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, Q - 2, Q)) % Q
I = pow(2, (Q - 1) // 4, Q)
B_Y = (4 * pow(5, Q - 2, Q)) % Q

def _xrecover(y):
    xx = (y * y - 1) * pow(D * y * y + 1, Q - 2, Q) % Q
    x = pow(xx, (Q + 3) // 8, Q)
    if (x * x - xx) % Q: x = x * I % Q
    return x

B = (_xrecover(B_Y), B_Y)
if B[0] & 1: B = (Q - B[0], B[1])

def _add(p, q):
    x1, y1 = p; x2, y2 = q
    x3 = (x1 * y2 + x2 * y1) * pow(1 + D * x1 * x2 * y1 * y2, Q - 2, Q) % Q
    y3 = (y1 * y2 + x1 * x2) * pow(1 - D * x1 * x2 * y1 * y2, Q - 2, Q) % Q
    return (x3, y3)

def _scalar_mult(p, n):
    result = (0, 1)
    while n:
        if n & 1: result = _add(result, p)
        p = _add(p, p); n >>= 1
    return result

def _decode_point(raw):
    if len(raw) != 32: return None
    value = int.from_bytes(raw, 'little'); sign = value >> 255; y = value & ((1 << 255) - 1)
    if y >= Q: return None
    x = _xrecover(y)
    if (x * x - (y * y - 1) * pow(D * y * y + 1, Q - 2, Q)) % Q: return None
    if (x & 1) != sign: x = Q - x
    point = (x, y)
    return point if _scalar_mult(point, L) == (0, 1) else None

def _spki_ed25519(pem):
    lines = [line.strip() for line in pem.splitlines() if not line.startswith('---')]
    try: der = base64.b64decode(''.join(lines), validate=True)
    except Exception: return None
    prefix = bytes.fromhex('302a300506032b6570032100')
    return der[len(prefix):] if len(der) == len(prefix) + 32 and der.startswith(prefix) else None

def _signature_payload(bundle):
    return {"schemaVersion": SIGNATURE_SCHEMA_VERSION, "sealVersion": bundle.get("sealVersion"), "bundleHash": bundle.get("bundleHash"), "workspaceId": bundle.get("workspaceId"), "receiptCount": bundle.get("receiptCount")}

def verify_signature(bundle, public_key_pem):
    envelope = bundle.get("bundleSignature")
    if not isinstance(envelope, dict): return (False, "signature_missing")
    if envelope.get("schemaVersion") != SIGNATURE_SCHEMA_VERSION or envelope.get("algorithm") != "ed25519": return (False, "signature_format_invalid")
    raw_key = _spki_ed25519(public_key_pem or '')
    if raw_key is None: return (False, "signing_key_unavailable")
    try: signature = base64.b64decode(envelope.get("signature", ''), validate=True)
    except Exception: return (False, "signature_format_invalid")
    if len(signature) != 64: return (False, "signature_format_invalid")
    r, s, a = _decode_point(signature[:32]), int.from_bytes(signature[32:], 'little'), _decode_point(raw_key)
    if r is None or a is None or s >= L: return (False, "signature_invalid")
    message = canonical_json(_signature_payload(bundle)).encode('utf-8')
    h = int.from_bytes(hashlib.sha512(signature[:32] + raw_key + message).digest(), 'little') % L
    return (_scalar_mult(B, s) == _add(r, _scalar_mult(a, h)), "signature_invalid")


def canonical_seal_payload(bundle):
    """The exact field set the bundle hash commits to.

    Everything a consumer may treat as authoritative provenance is in here.
    An earlier revision of this format sealed only ``receipts``, which let a
    bundle be relabelled with another workspaceId or exportedAt, or declare a
    false receiptCount, while still verifying (#735, #767).
    """
    return {
        "sealVersion": SEAL_VERSION,
        "schemaVersion": bundle.get("schemaVersion"),
        "workspaceId": bundle.get("workspaceId"),
        "exportedAt": bundle.get("exportedAt"),
        "receiptCount": bundle.get("receiptCount"),
        "receipts": bundle["receipts"],
    }


def check_bundle_seal(bundle):
    if bundle.get("sealVersion") == SEAL_VERSION:
        return sha256_hex(canonical_json(canonical_seal_payload(bundle))) == bundle["bundleHash"]
    # Legacy bundles predate the envelope seal and committed to receipts only.
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


def verify(bundle, allow_unsealed_envelope=False, public_keys=None, require_signature=False):
    """Return (ok, findings) for one parsed bundle."""
    findings = []
    if not check_bundle_seal(bundle):
        findings.append("bundle_seal_mismatch")
    if bundle.get("schemaVersion") != expected_envelope_version(bundle["receipts"]):
        findings.append("envelope_version_mismatch")
    # receiptCount IS checked: the specification now binds it into the seal and
    # additionally requires it to agree with the array. A count that disagrees
    # with the receipts it describes is a defect no matter what is signed.
    if bundle.get("receiptCount") is not None and bundle["receiptCount"] != len(bundle["receipts"]):
        findings.append("receipt_count_mismatch")
    # A bundle with no sealVersion has an unauthenticated envelope, so it is
    # only acceptable to a caller that has explicitly said it will not trust
    # that envelope.
    if bundle.get("sealVersion") != SEAL_VERSION and not allow_unsealed_envelope:
        findings.append("envelope_unsealed")
    ok, broken_at, reason = validate_chain(bundle["receipts"])
    if not ok:
        findings.append("%s@%d" % (reason, broken_at))
    signature = bundle.get("bundleSignature")
    if signature is None:
        if require_signature: findings.append("signature_missing")
        signature_status = "unsigned"
    elif not isinstance(signature, dict):
        findings.append("signature_format_invalid"); signature_status = "invalid"
    else:
        key = (public_keys or {}).get(signature.get("keyReference"))
        signature_ok, reason = verify_signature(bundle, key)
        if not signature_ok: findings.append(reason); signature_status = "invalid"
        else: signature_status = "signed by %s" % signature.get("keyReference")
    return (not findings, findings, signature_status)


def main(argv):
    public_keys = {}; require_signature = False; paths = []
    for arg in argv:
        if arg == '--require-signature': require_signature = True
        elif arg.startswith('--public-key='):
            reference, key_path = arg[len('--public-key='):].split('=', 1)
            with open(key_path, encoding='utf-8') as handle: public_keys[reference] = handle.read()
        else: paths.append(arg)
    failed = False
    for path in paths:
        with open(path, encoding="utf-8") as handle:
            bundle = json.load(handle)
        ok, findings, signature_status = verify(bundle, public_keys=public_keys, require_signature=require_signature)
        print("%-46s %s (%s)%s" % (
            path.split("/")[-1],
            "VALID" if ok else "INVALID",
            signature_status,
            "" if ok else "  " + ", ".join(findings),
        ))
        failed = failed or not ok
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

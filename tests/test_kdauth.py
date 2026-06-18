# coding: utf-8
"""Deterministic tests for the fork's Google-auth JWT verifier.

Run: python3 tests/test_kdauth.py   (also works under pytest)
"""
import base64
import hashlib
import hmac
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from kopyparty.kdauth import AuthGate


SECRET = "super-shared-secret"


def _b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def mint(claims, secret=SECRET, alg="HS256"):
    header = {"alg": alg, "typ": "JWT"}
    h = _b64url(json.dumps(header).encode("utf-8"))
    p = _b64url(json.dumps(claims).encode("utf-8"))
    signing_input = (h + "." + p).encode("utf-8")
    if alg == "none":
        sig = b""
    else:
        sig = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return h + "." + p + "." + _b64url(sig)


def gate(iss="", aud=""):
    return AuthGate(SECRET, "kd_session", "https://kunaldawn.com/login", "redirect", iss, aud)


def test_valid_token_returns_claims():
    g = gate()
    tok = mint({"exp": 2000, "email": "a@b.com"})
    claims = g.verify(tok, now=1000)
    assert claims is not None and claims["email"] == "a@b.com", claims


def test_expired_is_rejected():
    g = gate()
    assert g.verify(mint({"exp": 500}), now=1000) is None


def test_exp_leeway_boundary():
    g = gate()  # leeway default 60
    assert g.verify(mint({"exp": 950}), now=1000) is not None   # 1000 <= 950+60
    assert g.verify(mint({"exp": 800}), now=1000) is None       # 1000 > 800+60


def test_nbf_in_future_is_rejected():
    g = gate()
    assert g.verify(mint({"exp": 2000, "nbf": 1500}), now=1000) is None


def test_bad_signature_is_rejected():
    g = gate()
    assert g.verify(mint({"exp": 2000}, secret="wrong-secret"), now=1000) is None


def test_alg_none_is_rejected():
    g = gate()
    assert g.verify(mint({"exp": 2000}, alg="none"), now=1000) is None


def test_alg_rs256_is_rejected():
    g = gate()
    # header claims RS256 but body is HMAC-signed; must be refused on alg check
    assert g.verify(mint({"exp": 2000}, alg="RS256"), now=1000) is None


def test_missing_exp_is_rejected():
    g = gate()
    assert g.verify(mint({"email": "a@b.com"}), now=1000) is None


def test_exp_as_bool_is_rejected():
    g = gate()
    assert g.verify(mint({"exp": True}), now=1000) is None
    assert g.verify(mint({"exp": False}), now=1000) is None


def test_tampered_payload_is_rejected():
    g = gate()
    tok = mint({"exp": 2000, "email": "a@b.com"})
    h, p, s = tok.split(".")
    forged_p = _b64url(json.dumps({"exp": 2000, "email": "evil@x.com"}).encode("utf-8"))
    assert g.verify(h + "." + forged_p + "." + s, now=1000) is None


def test_iss_must_match_when_configured():
    g = gate(iss="kunaldawn")
    assert g.verify(mint({"exp": 2000}), now=1000) is None                       # no iss
    assert g.verify(mint({"exp": 2000, "iss": "kunaldawn"}), now=1000) is not None
    assert g.verify(mint({"exp": 2000, "iss": "evil"}), now=1000) is None


def test_aud_string_and_list_when_configured():
    g = gate(aud="archive")
    assert g.verify(mint({"exp": 2000, "aud": "archive"}), now=1000) is not None
    assert g.verify(mint({"exp": 2000, "aud": ["x", "archive"]}), now=1000) is not None
    assert g.verify(mint({"exp": 2000, "aud": "other"}), now=1000) is None


def test_garbage_tokens_are_rejected():
    g = gate()
    for bad in ["", "x", "a.b", "a.b.c.d", "not-base64.@@@.@@@"]:
        assert g.verify(bad, now=1000) is None, bad


def test_build_login_redirect_no_existing_query():
    g = gate()
    url = g.build_login_redirect("https://xyz.kunaldawn.com/m/?s=n")
    assert url == "https://kunaldawn.com/login?redirect=https%3A%2F%2Fxyz.kunaldawn.com%2Fm%2F%3Fs%3Dn", url


def test_build_login_redirect_existing_query_uses_amp():
    g = AuthGate(SECRET, "kd_session", "https://kunaldawn.com/login?x=1", "redirect", "", "")
    url = g.build_login_redirect("https://xyz.kunaldawn.com/a")
    assert url == "https://kunaldawn.com/login?x=1&redirect=https%3A%2F%2Fxyz.kunaldawn.com%2Fa", url


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
    print("ALL PASS")

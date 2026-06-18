# coding: utf-8
from __future__ import print_function, unicode_literals

"""
KD fork: Google-auth token verification gate.

The Google OAuth flow lives on kunaldawn.com (a separate codebase). It signs a
JWT (HS256) with a shared secret and sets it as a cookie on .kunaldawn.com. This
server only VERIFIES that cookie on each request (see httpcli.kdauth_gate): a
valid, unexpired token lets the request through to the normal read-only serving;
anything else gets a 302 to a configurable login URL carrying the original URL
back as a query param.

Enabled iff a secret is configured (--kd-auth-secret / KOPYPARTY_AUTH_SECRET).
Verify-only: stdlib hmac/hashlib, no new deps; rejects alg!=HS256 (blocks
alg:none and RS256 confusion) and requires exp. Started per serving process in
HttpSrv.__init__ (like kdcache/kdratelimit); the verifier is stateless so -j>1
is fine (each worker holds an identical copy).
"""

import base64
import hashlib
import hmac
import json
from urllib.parse import quote

# the live AuthGate singleton, or None when disabled / not yet started
INST = None


def _b64url_decode(s):
    # JWT segments are unpadded base64url; restore padding before decoding.
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


class AuthGate(object):
    def __init__(self, secret, cookie, login_url, return_param, iss, aud, leeway=60):
        self.secret = secret.encode("utf-8") if isinstance(secret, str) else secret
        self.cookie = cookie
        self.login_url = login_url
        self.return_param = return_param
        self.iss = iss or ""
        self.aud = aud or ""
        self.leeway = int(leeway)

    def verify(self, token, now):
        """Return the claims dict for a valid HS256 token, else None. Never raises."""
        try:
            if not token or len(token) > 8192:
                return None
            parts = token.split(".")
            if len(parts) != 3:
                return None
            h_b64, p_b64, sig_b64 = parts

            header = json.loads(_b64url_decode(h_b64))
            if not isinstance(header, dict) or header.get("alg") != "HS256":
                return None  # block alg:none and RS256 confusion

            signing_input = (h_b64 + "." + p_b64).encode("utf-8")
            expected = hmac.new(self.secret, signing_input, hashlib.sha256).digest()
            if not hmac.compare_digest(expected, _b64url_decode(sig_b64)):
                return None

            claims = json.loads(_b64url_decode(p_b64))
            if not isinstance(claims, dict):
                return None

            exp = claims.get("exp")
            if isinstance(exp, bool) or not isinstance(exp, (int, float)):
                return None  # exp is mandatory (numeric, not bool)
            if now > exp + self.leeway:
                return None

            nbf = claims.get("nbf")
            if isinstance(nbf, (int, float)) and now < nbf - self.leeway:
                return None
            iat = claims.get("iat")
            if isinstance(iat, (int, float)) and now < iat - self.leeway:
                return None

            if self.iss and claims.get("iss") != self.iss:
                return None
            if self.aud:
                aud = claims.get("aud")
                if isinstance(aud, list):
                    if self.aud not in aud:
                        return None
                elif aud != self.aud:
                    return None

            return claims
        except Exception:
            return None

    def build_login_redirect(self, original_url):
        """login_url with the original URL appended as the configured return param."""
        enc = quote(original_url, safe="")
        sep = "&" if "?" in self.login_url else "?"
        return "%s%s%s=%s" % (self.login_url, sep, self.return_param, enc)


def start(args):
    """Create the per-process singleton unless disabled (empty secret).
    Idempotent: a second call is a no-op, safe to invoke from HttpSrv.__init__."""
    global INST
    if INST is not None:
        return INST
    secret = getattr(args, "kd_auth_secret", "") or ""
    if not secret:
        return None
    INST = AuthGate(
        secret,
        getattr(args, "kd_auth_cookie", "") or "kd_session",
        getattr(args, "kd_auth_login_url", "") or "",
        getattr(args, "kd_auth_return_param", "") or "redirect",
        getattr(args, "kd_auth_iss", "") or "",
        getattr(args, "kd_auth_aud", "") or "",
    )
    return INST

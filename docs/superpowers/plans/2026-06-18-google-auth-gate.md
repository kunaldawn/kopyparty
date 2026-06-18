# Google-auth token verification gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, env-toggled authentication gate that verifies a shared HS256 JWT cookie (issued by kunaldawn.com) on every request and redirects unauthenticated visitors to a configurable login URL, carrying the original URL back as a query param.

**Architecture:** A thin verify-only overlay. A new fork module `kopyparty/kdauth.py` holds the JWT verifier and login-redirect builder (both pure functions) plus a per-process singleton. A single gate call at the GET/HEAD dispatch chokepoint in `httpcli.py` either lets the request through to the existing read-only serving (token valid, or auth disabled) or sends a 302 to the login URL. copyparty's permission model is untouched.

**Tech Stack:** Python 3.12 stdlib only (`hmac`, `hashlib`, `base64`, `json`, `urllib.parse`), Docker Compose. No new image dependencies.

**Conventions (from CLAUDE.md):**
- Fork-only modules mirror `kdratelimit.py`/`kdcache.py`: module-global `INST`, idempotent `start()`.
- Process-wide singletons init in `HttpSrv.__init__`, never `svchub`.
- After editing anything under `kopyparty/web/` rebuild with `--no-cache` (this feature touches no web assets, so a normal `up -d` suffices for config-only changes; a code change to `kopyparty/*.py` still needs `docker compose build`).
- No `tests/` framework exists; tests are standalone scripts runnable with `python3`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `kopyparty/kdauth.py` | **create** | JWT HS256 verify + login-redirect builder + singleton `start()` |
| `tests/test_kdauth.py` | **create** | Deterministic unit tests (mint tokens, injected `now`) |
| `kopyparty/httpcli.py` | modify dispatch (~866) + add methods + import | The gate: read cookie, verify, proceed or 302 |
| `kopyparty/__main__.py` | add args (~after `--kd-dl-limit`) | `--kd-auth-*` CLI args |
| `kopyparty/httpsrv.py` | modify `__init__` (~after kdratelimit.start) | Start the gate singleton + misconfig warning |
| `docker-compose.yml` | add command flags | `KOPYPARTY_AUTH_*` env wiring |
| `CLAUDE.md` | document | New "Auth gate" architecture section |

---

## Task 1: `kdauth.py` verifier module + unit tests

**Files:**
- Create: `kopyparty/kdauth.py`
- Test: `tests/test_kdauth.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_kdauth.py` with exactly this content:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 tests/test_kdauth.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'kopyparty.kdauth'`.

- [ ] **Step 3: Write the module**

Create `kopyparty/kdauth.py` with exactly this content:

```python
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
            parts = token.split(".")
            if len(parts) != 3:
                return None
            h_b64, p_b64, sig_b64 = parts

            header = json.loads(_b64url_decode(h_b64))
            if header.get("alg") != "HS256":
                return None  # block alg:none and RS256 confusion

            signing_input = (h_b64 + "." + p_b64).encode("utf-8")
            expected = hmac.new(self.secret, signing_input, hashlib.sha256).digest()
            if not hmac.compare_digest(expected, _b64url_decode(sig_b64)):
                return None

            claims = json.loads(_b64url_decode(p_b64))
            if not isinstance(claims, dict):
                return None

            exp = claims.get("exp")
            if not isinstance(exp, (int, float)):
                return None  # exp is mandatory
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 tests/test_kdauth.py`
Expected: prints `ok test_...` for each test then `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add kopyparty/kdauth.py tests/test_kdauth.py
git commit -m "feat(auth): HS256 JWT verifier + login-redirect builder (fork-only)"
```

---

## Task 2: The gate in httpcli.py

**Files:**
- Modify: `kopyparty/httpcli.py` (import area; dispatch at ~866; add two methods)

- [ ] **Step 1: Add the import**

Near the other `from . import ...` lines at the top of `httpcli.py` (there is already `from . import kdratelimit`), add:

```python
from . import kdauth
```

Verify placement with: `grep -n "^from \. import" kopyparty/httpcli.py`

- [ ] **Step 2: Hook the gate into the GET/HEAD dispatch**

Find this block (around line 866):

```python
            cors_k = self._cors()
            if self.mode in ("GET", "HEAD"):
                return self.handle_get() and self.keepalive
```

Change it to:

```python
            cors_k = self._cors()
            if self.mode in ("GET", "HEAD"):
                if not self.kdauth_gate():
                    return self.keepalive
                return self.handle_get() and self.keepalive
```

- [ ] **Step 3: Add the gate methods**

Add these two methods to the `HttpCli` class. Put them just before the `handle_get` method definition (find it with `grep -n "def handle_get" kopyparty/httpcli.py`):

```python
    def kdauth_gate(self):
        # KD fork: Google-auth verification overlay. Returns True to let the
        # request proceed (auth disabled, or a valid token); False after it has
        # sent a 302 to the login URL.
        inst = kdauth.INST
        if inst is None:
            return True  # disabled -> behave exactly as the public archive

        tok = self.cookies.get(inst.cookie) or ""
        if tok and inst.verify(tok, time.time()) is not None:
            return True

        proto = "https" if self.is_https else "http"
        original = "%s://%s/%s" % (proto, self.host, self.req.lstrip("/"))
        url = inst.build_login_redirect(original)
        self.reply(
            b"<html><body>redirecting to login\xe2\x80\xa6</body></html>",
            status=302,
            headers={"Location": url},
        )
        return False
```

(`time` is already imported in `httpcli.py`; confirm with `grep -n "^import time" kopyparty/httpcli.py`.)

- [ ] **Step 4: Verify it imports cleanly**

Run: `python3 -c "import kopyparty.httpcli; print('httpcli import ok')"`
Expected: `httpcli import ok`.

- [ ] **Step 5: Verify the gate is a no-op when disabled (INST is None)**

Run:
```bash
python3 -c "
import kopyparty.kdauth as k
assert k.INST is None
print('gate disabled by default ->', 'noop ok')
"
```
Expected: `gate disabled by default -> noop ok`.

- [ ] **Step 6: Commit**

```bash
git add kopyparty/httpcli.py
git commit -m "feat(auth): gate GET/HEAD on JWT cookie, 302 to login when missing"
```

---

## Task 3: CLI args, startup wiring, and compose env

**Files:**
- Modify: `kopyparty/__main__.py` (after the `--kd-dl-limit` arg)
- Modify: `kopyparty/httpsrv.py` (after the `kdratelimit.start(self.args)` call)
- Modify: `docker-compose.yml` (after the `--kd-dl-limit` command line)

- [ ] **Step 1: Add the CLI args**

In `__main__.py`, immediately after the `--kd-dl-limit` add_argument line, add:

```python
    ap2.add_argument("--kd-auth-secret", metavar="STR", type=u, default="", help="KD fork: shared HMAC secret for the Google-auth JWT cookie; setting this ENABLES the auth gate (empty = disabled, anonymous access)")
    ap2.add_argument("--kd-auth-login-url", metavar="URL", type=u, default="", help="KD fork: where to 302-redirect users without a valid token (e.g. https://kunaldawn.com/login)")
    ap2.add_argument("--kd-auth-cookie", metavar="NAME", type=u, default="kd_session", help="KD fork: name of the auth JWT cookie to read")
    ap2.add_argument("--kd-auth-return-param", metavar="NAME", type=u, default="redirect", help="KD fork: query-param name used to pass the original URL to the login page")
    ap2.add_argument("--kd-auth-iss", metavar="STR", type=u, default="", help="KD fork: if set, require the JWT 'iss' claim to equal this")
    ap2.add_argument("--kd-auth-aud", metavar="STR", type=u, default="", help="KD fork: if set, require the JWT 'aud' claim to equal (or contain) this")
```

- [ ] **Step 2: Start the singleton in HttpSrv.__init__**

In `httpsrv.py`, immediately after the existing `kdratelimit.start(self.args)` line, add:

```python
        # KD fork: Google-auth verification gate (same per-serving-process init
        # rule as above). Enabled only when --kd-auth-secret is set.
        from . import kdauth

        kdgate = kdauth.start(self.args)
        if kdgate is not None and not kdgate.login_url:
            self.log(
                "kdauth",
                "auth gate enabled but --kd-auth-login-url is empty; unauthenticated users will be redirected to a bare URL",
                3,
            )
```

- [ ] **Step 3: Add the compose env wiring**

In `docker-compose.yml`, immediately after the `- --kd-dl-limit=${KOPYPARTY_DL_LIMIT:-0.061}` line, add:

```yaml
      # KD fork: optional Google-auth gate. Set KOPYPARTY_AUTH_SECRET (shared
      # HMAC secret with the kunaldawn.com login service) to ENABLE; leave empty
      # to keep the archive public. Unauthenticated users are 302'd to
      # KOPYPARTY_AUTH_LOGIN_URL with the original URL in the 'redirect' param.
      - --kd-auth-secret=${KOPYPARTY_AUTH_SECRET:-}
      - --kd-auth-login-url=${KOPYPARTY_AUTH_LOGIN_URL:-}
      - --kd-auth-cookie=${KOPYPARTY_AUTH_COOKIE:-kd_session}
      - --kd-auth-return-param=${KOPYPARTY_AUTH_RETURN_PARAM:-redirect}
      - --kd-auth-iss=${KOPYPARTY_AUTH_ISS:-}
      - --kd-auth-aud=${KOPYPARTY_AUTH_AUD:-}
```

Match the existing 6-space + `- ` indentation; read the file first to confirm.

- [ ] **Step 4: Verify args parse and the gate starts**

Run:
```bash
python3 -c "
import argparse
from kopyparty import kdauth
ap = argparse.ArgumentParser()
for a in ['secret','login_url','cookie','return_param','iss','aud']:
    ap.add_argument('--kd-auth-' + a.replace('_','-'), dest='kd_auth_'+a, default='')
a = ap.parse_args(['--kd-auth-secret','s','--kd-auth-login-url','https://kunaldawn.com/login'])
g = kdauth.start(a)
print('enabled cookie=%s login=%s' % (g.cookie, g.login_url))
"
```
Expected: `enabled cookie=kd_session login=https://kunaldawn.com/login`
(Note: `start()` falls back to `kd_session`/`redirect` defaults when the dest values are empty strings, which matches the argparse defaults in Step 1.)

- [ ] **Step 5: Verify empty secret disables (fresh process)**

Run:
```bash
python3 -c "
import argparse
from kopyparty import kdauth
ap = argparse.ArgumentParser(); ap.add_argument('--kd-auth-secret', dest='kd_auth_secret', default='')
print('INST when no secret:', kdauth.start(ap.parse_args([])))
"
```
Expected: `INST when no secret: None`.

- [ ] **Step 6: Verify YAML still parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('docker-compose.yml')); print('yaml ok')"`
Expected: `yaml ok` (if pyyaml is missing, run `docker compose config -q && echo 'compose ok'`).

- [ ] **Step 7: Commit**

```bash
git add kopyparty/__main__.py kopyparty/httpsrv.py docker-compose.yml
git commit -m "feat(auth): --kd-auth-* args, start in HttpSrv, compose env"
```

---

## Task 4: Document in CLAUDE.md and run the live audit

**Files:**
- Modify: `CLAUDE.md` (new architecture subsection)

- [ ] **Step 1: Add a CLAUDE.md section**

Add a subsection under "Architecture & quirks" (near the rate-limiter / no-zip sections) describing:
- `kdauth.py` — verify-only Google-auth gate; HS256 JWT cookie issued by
  kunaldawn.com, verified here; rejects `alg!=HS256` and requires `exp`;
  singleton started in `HttpSrv.__init__`; stateless so `-j>1` is fine.
- The gate: one chokepoint at the GET/HEAD dispatch in `httpcli.py`; disabled
  (no secret) = public archive as before; enabled + no/invalid token = 302 to
  `KOPYPARTY_AUTH_LOGIN_URL?redirect=<original url>`; valid token = serves as
  anonymous `*` (perm model untouched; `self.uname` deliberately left `*`).
- Token contract: cookie `kd_session` (configurable) on `.kunaldawn.com`,
  claims `exp` (required) + `email`, optional `iss`/`aud`.
- Knobs: `KOPYPARTY_AUTH_SECRET` (on/off switch), `KOPYPARTY_AUTH_LOGIN_URL`,
  `KOPYPARTY_AUTH_COOKIE`, `KOPYPARTY_AUTH_RETURN_PARAM`, `KOPYPARTY_AUTH_ISS`,
  `KOPYPARTY_AUTH_AUD`.

Also update the URL-surface block near the top of CLAUDE.md to note that, when
auth is enabled, unauthenticated GETs return 302 to the login URL.

Use the existing prose style. Match the surrounding sections' depth.

- [ ] **Step 2: Build and verify DISABLED mode is unchanged (default)**

Run (auth env unset → public archive):
```bash
docker compose build 2>&1 | tail -3
docker compose up -d 2>&1 | tail -1
sleep 5
P=${KOPYPARTY_PORT:-8282}
curl -s -o /dev/null -w "disabled root -> %{http_code} (expect 200)\n" "http://127.0.0.1:$P/"
```
Expected: `disabled root -> 200` (no redirect; behaves as today).

- [ ] **Step 3: Verify ENABLED mode redirects when no cookie**

Run (enable with a known secret + login URL):
```bash
P=${KOPYPARTY_PORT:-8282}
KOPYPARTY_AUTH_SECRET=testsecret123 \
KOPYPARTY_AUTH_LOGIN_URL=https://kunaldawn.com/login \
  docker compose up -d --force-recreate 2>&1 | tail -1
sleep 5
curl -s -o /dev/null -w "no-cookie root -> %{http_code}\n" "http://127.0.0.1:$P/"
echo "--- Location header (expect 302 to login with redirect= param) ---"
curl -s -D - -o /dev/null "http://127.0.0.1:$P/many_files/?sort=name" | grep -i "^HTTP/\|^location:"
```
Expected: status `302`; `Location:` begins with `https://kunaldawn.com/login?redirect=` and the encoded value contains the original path+query (`%2Fmany_files%2F%3Fsort%3Dname`).

- [ ] **Step 4: Verify ENABLED mode accepts a valid token**

Mint a valid cookie with the same secret and confirm 200:
```bash
P=${KOPYPARTY_PORT:-8282}
TOKEN=$(python3 -c "
import base64,hashlib,hmac,json,time
def b(x): return base64.urlsafe_b64encode(x).rstrip(b'=').decode()
sec=b'testsecret123'
h=b(json.dumps({'alg':'HS256','typ':'JWT'}).encode())
p=b(json.dumps({'exp':int(time.time())+3600,'email':'me@kunaldawn.com'}).encode())
sig=b(hmac.new(sec,(h+'.'+p).encode(),hashlib.sha256).digest())
print(h+'.'+p+'.'+sig)
")
curl -s -o /dev/null -w "valid-cookie root -> %{http_code} (expect 200)\n" \
  --cookie "kd_session=$TOKEN" "http://127.0.0.1:$P/"
echo "--- expired token should 302 ---"
EXPIRED=$(python3 -c "
import base64,hashlib,hmac,json,time
def b(x): return base64.urlsafe_b64encode(x).rstrip(b'=').decode()
sec=b'testsecret123'
h=b(json.dumps({'alg':'HS256','typ':'JWT'}).encode())
p=b(json.dumps({'exp':int(time.time())-10}).encode())
sig=b(hmac.new(sec,(h+'.'+p).encode(),hashlib.sha256).digest())
print(h+'.'+p+'.'+sig)
")
curl -s -o /dev/null -w "expired-cookie root -> %{http_code} (expect 302)\n" \
  --cookie "kd_session=$EXPIRED" "http://127.0.0.1:$P/"
```
Expected: `valid-cookie root -> 200`; `expired-cookie root -> 302`.

- [ ] **Step 5: Restore default (disabled) and confirm public again**

```bash
P=${KOPYPARTY_PORT:-8282}
docker compose up -d --force-recreate 2>&1 | tail -1
sleep 5
curl -s -o /dev/null -w "restored root -> %{http_code} (expect 200)\n" "http://127.0.0.1:$P/"
```
Expected: `restored root -> 200`.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the Google-auth verification gate"
```

---

## Self-Review notes

- **Spec coverage:** verifier + redirect builder + start → Task 1; gate + dispatch hook + 302 + uname-stays-`*` → Task 2; env on/off switch + all `--kd-auth-*` knobs + HttpSrv init + misconfig warning → Task 3; CLAUDE.md + disabled/enabled/valid/expired live tests → Task 4. Security defaults (`alg!=HS256` reject, mandatory `exp`, `iss`/`aud`) covered by Task 1 tests. All spec sections mapped.
- **Type/name consistency:** `AuthGate(secret, cookie, login_url, return_param, iss, aud, leeway=60)`, `verify(token, now)`, `build_login_redirect(original_url)`, module `INST`/`start(args)`; gate method `kdauth_gate`; cookie default `kd_session`; return param default `redirect`; args `kd_auth_secret/login_url/cookie/return_param/iss/aud` — identical across all tasks.
- **No placeholders:** every step has concrete code/commands.
- **Disabled = no-op** is explicitly tested (Task 2 Step 5, Task 4 Steps 2 & 5) so the public-archive behavior is provably preserved when the secret is unset.

# Design — Google-auth token verification gate

**Date:** 2026-06-18
**Context:** kopyparty fork (read-only archive served at a `*.kunaldawn.com`
subdomain). Adds optional, env-toggled authentication.

## Motivation

The archive should be viewable only by people who have signed in with Google.
The Google OAuth flow itself lives on **kunaldawn.com** (a separate codebase, not
this repo). That service authenticates the user and sets a **signed JWT cookie**
scoped to `.kunaldawn.com`. This kopyparty server's only job is to **verify that
cookie** on every request and block anyone without a valid one — acting as an
authentication gate in front of the existing public, read-only content.

## Decisions (from brainstorming)

- This server is **verify-only**; it never talks to Google and never mints
  tokens for normal operation.
- Token is a **JWT signed with HS256** (shared secret), verifiable with Python
  stdlib only — no new image dependencies.
- A request with no valid token gets a **302 redirect to a configurable login
  URL** on kunaldawn.com, carrying the original URL back as a query param so the
  user returns to where they were after signing in.
- **Any** validly-signed, unexpired token grants full read access; the
  who-is-allowed policy lives entirely at the issuer (kunaldawn.com).
- The whole feature is **toggled by env**: setting the secret enables it;
  leaving it empty disables it and the server behaves exactly as it does today
  (anonymous read).
- Security defaults (non-negotiable): reject `alg:none` and any non-HS256 alg;
  require and check `exp`. Optional `iss`/`aud` checks, enforced only if set.

## Architecture

A thin **gate overlay**. copyparty's permission model is left untouched: the
volume stays anonymous-readable (`*:r`), exactly as now. A single chokepoint
early in request handling decides whether a request may reach that content:

```
request → parse cookies → [kdauth gate] → (valid|disabled) → normal copyparty serving
                                        → (enabled & invalid) → 302 to login URL
```

Rationale: keeping auth as an overlay (rather than mapping Google identities onto
copyparty users/volumes) is YAGNI-correct for "any valid token = allowed",
isolates the change, and makes disable a true no-op.

## Components

### 1. `kopyparty/kdauth.py` (new, fork-only — mirrors `kdratelimit.py`)

Module-global singleton `INST` (or `None` when disabled) plus a pure-logic
verifier.

**Config object** (built in `start(args)`):
- `secret: bytes` — HMAC key (from `--kd-auth-secret`).
- `cookie: str` — cookie name to read (default `kd_session`).
- `login_url: str` — where to send unauthenticated users.
- `return_param: str` — query-param name carrying the original URL (default
  `redirect`).
- `iss: str` / `aud: str` — optional expected claims ("" = don't check).
- `leeway: int` — clock-skew seconds for `exp`/`nbf`/`iat` (default 60).

**`start(args)`** — idempotent. Enabled **iff** `args.kd_auth_secret` is
non-empty. If enabled but `login_url` is empty, log a warning (gate will still
work, redirect just goes to a bare/empty URL — misconfig). Returns `INST` or
`None`.

**`verify(token, now) → dict | None`** — pure stdlib:
1. Split into `header_b64.payload_b64.sig_b64`; exactly 3 parts or return `None`.
2. base64url-decode header; require JSON `{"alg":"HS256","typ":...}`; **if `alg`
   is not exactly `"HS256"`, return `None`** (blocks `none` and RS256
   confusion).
3. Recompute `HMAC-SHA256(secret, "header_b64.payload_b64")`; compare to the
   decoded signature with `hmac.compare_digest`; mismatch → `None`.
4. base64url-decode payload to claims dict (bad JSON → `None`).
5. `exp` **required**: missing or `now > exp + leeway` → `None`.
6. `nbf` (if present): `now < nbf - leeway` → `None`. `iat` (if present and in
   the future beyond leeway) → `None`.
7. If `iss` configured and `claims.get("iss") != iss` → `None`. Same for `aud`
   (string equality; if token `aud` is a list, membership).
8. Return the claims dict.

base64url decoding pads with `=` to a multiple of 4 and uses `urlsafe_b64decode`.
`now` is injected (caller passes `time.time()`) so tests are deterministic.

### 2. The gate in `kopyparty/httpcli.py`

A method `kdauth_gate() → bool` (True = proceed), called from the request
dispatch **after cookies are parsed** (`self.cookies` is set ~line 677) and
**before** any content is served — placed once at the top of the GET/HEAD
dispatch path so every content route is covered.

```
def kdauth_gate(self):
    inst = kdauth.INST
    if inst is None:
        return True                      # disabled → no-op (today's behavior)
    tok = self.cookies.get(inst.cookie) or ""
    claims = kdauth.verify(tok, time.time()) if tok else None
    if claims is not None:
        self.kdauth_email = claims.get("email") or ""   # for the access log only
        return True
    # blocked: 302 to the login URL with the original absolute URL as a param
    self.tx_login_redirect(inst)
    return False
```

- `tx_login_redirect(inst)` builds the original absolute URL from the `Host`
  header, scheme (`X-Forwarded-Proto` if present else `is_https`), `self.vpath`,
  and the original query string; URL-encodes it; appends
  `?{return_param}=...` or `&{return_param}=...` depending on whether
  `login_url` already has a `?`. Sends `302` with `Location:` and a tiny HTML
  body (using the existing `send_headers`/`reply` path; not the `redirect()`
  helper, which only builds local vpaths).
- `self.uname` is **left as `*`** (setting it to the email would make
  `uaxs[email]` all-false and 403 the read). Identity is logged separately via
  `kdauth_email`.
- The redirect target is external (kunaldawn.com), so there is no redirect loop
  on this server. After login the user returns with the cookie and passes.

**Caller integration:** call `if not self.kdauth_gate(): return ...` at the
single point where GET/HEAD requests begin serving (before route matching for
files/listings/static). Non-GET verbs already 405 earlier, so they need no
change.

### 3. Config / env wiring

`__main__.py` (beside the other `--kd-*` args):
- `--kd-auth-secret` (str, default ``)
- `--kd-auth-login-url` (str, default ``)
- `--kd-auth-cookie` (str, default `kd_session`)
- `--kd-auth-return-param` (str, default `redirect`)
- `--kd-auth-iss` (str, default ``)
- `--kd-auth-aud` (str, default ``)

`docker-compose.yml` command list:
- `--kd-auth-secret=${KOPYPARTY_AUTH_SECRET:-}`
- `--kd-auth-login-url=${KOPYPARTY_AUTH_LOGIN_URL:-}`
- `--kd-auth-cookie=${KOPYPARTY_AUTH_COOKIE:-kd_session}`
- `--kd-auth-return-param=${KOPYPARTY_AUTH_RETURN_PARAM:-redirect}`
- `--kd-auth-iss=${KOPYPARTY_AUTH_ISS:-}`
- `--kd-auth-aud=${KOPYPARTY_AUTH_AUD:-}`

Started in `HttpSrv.__init__` (per-serving-process init point, same as
`kdcache`/`kdratelimit`; under `-j>1` each worker builds its own identical
verifier — fine, it's stateless).

## Token contract (for the kunaldawn.com issuer)

- JWT, alg **HS256**, signed with the shared `KOPYPARTY_AUTH_SECRET`.
- Cookie: name = `KOPYPARTY_AUTH_COOKIE` (default `kd_session`),
  `Domain=.kunaldawn.com; Path=/; Secure; HttpOnly; SameSite=Lax`.
- Claims: `exp` (required, unix seconds); `email` (recommended, logged);
  optional `iss`/`aud` matching this server's config.

## Error handling

- Disabled (no secret): gate is a no-op; zero behavior change.
- Enabled, missing/empty/garbage/expired/tampered cookie: 302 to login URL.
- Enabled, login URL empty (misconfig): still 302, to a bare URL; a startup
  warning is logged so it's noticed.
- Verification never throws into the request path — any parse error inside
  `verify` returns `None` (treated as "not authenticated").

## Testing

- **Unit (`tests/test_kdauth.py`, standalone like `test_kdratelimit.py`):**
  build tokens with a known secret and an injected `now`. Cover: valid token →
  claims; expired → None; not-yet-valid `nbf` → None; bad signature → None;
  `alg:none` → None; `alg:RS256` → None; missing `exp` → None; tampered payload
  → None; wrong `iss`/`aud` when configured → None; correct `iss`/`aud` → claims;
  leeway boundary.
- **Live (Docker):**
  - secret unset → site serves publicly as today (200, no redirect).
  - secret set, no cookie → `302` with `Location` starting with the login URL and
    containing the url-encoded original URL under the configured return param.
  - secret set, valid freshly-signed cookie → `200` and content streams.
  - secret set, expired/tampered cookie → `302`.
  - confirm the redirect preserves path + query (`/folder/?x=1`).

## Out of scope

- The Google OAuth flow, consent screen, and token *issuance* (those live on
  kunaldawn.com).
- Per-user / per-folder authorization (any valid token = full read).
- Logout (clearing the cookie is the issuer's concern).
- Preserving the URL `#fragment` (browsers don't send it to the server).
- RS256 / Google-JWKS verification (rejected in favor of stdlib-only HS256).

# Design — bandwidth cap, bulk-download removal, lazy thumbnails

**Date:** 2026-06-18
**Branch context:** kopyparty fork (read-only copyparty, served from home internet off a slow USB HDD)

## Motivation

The fork is served from a home connection. Three problems to solve:

1. Visitors can saturate the home upload bandwidth.
2. Folder / multi-file (ZIP/TAR) downloads let one visitor pull the whole tree cheaply.
3. Opening a folder with many files (2000+) hangs the page until thumbnails load,
   because every thumbnail is requested up front and each one is a server-side
   album-art extraction off the slow HDD.

## Decisions (from brainstorming)

- Bandwidth limit is a **single global shared cap** across all visitors and
  connections — not per-IP, not per-connection.
- Default **5 MB/s**, tunable via an environment variable; `0` disables.
- **All** bulk download is removed — only individual files download. No private
  exception for the operator.

---

## Feature 1 — Global download bandwidth cap

### New module: `kopyparty/kdratelimit.py` (fork-only)

A thread-safe **token bucket**:

- State: `rate` (bytes/sec), `capacity` (burst, e.g. `rate * 1` to a small
  multiple), `tokens`, `last_refill` (monotonic clock).
- `throttle(nbytes)`: under a lock, refill tokens based on elapsed monotonic
  time, then if insufficient tokens, compute the required sleep time, **release
  the lock**, `sleep`, and retry. Threads must *not* hold the lock while
  sleeping — they serialize on bandwidth, not on the lock.
- Module-global singleton `INST` (mirrors `kdcache.INST`). A `start(rate)` /
  `get()` helper, idempotent.

### Initialization point: `HttpSrv.__init__`

Same constraint as the dir-cache (see CLAUDE.md "Directory cache"): with `-j1`
(which this fork keeps) there is exactly one serving process, so one shared
bucket covers every download thread. Initializing in `svchub` would be wrong
under `-j>1` because request threads run in `BrokerMp` worker processes where a
parent-process global is `None`.

**Documented caveat:** under `-j>1` the cap becomes *per worker process*
(N workers ⇒ up to N×limit total). The fork runs `-j1`, so this is fine.

### Hook point: the file-send byte loop

- The default path is kernel `os.sendfile` (`util.sendfile_kern`), which **cannot
  throttle** (its `slp` arg is ignored). The Python path `util.sendfile_py`
  already loops `f.read()` + `s.sendall()` per chunk.
- When the cap is enabled, `tx_file` (`httpcli.py` ~2325, the `use_sendfile`
  decision) is forced to use `sendfile_py`.
- Inside `sendfile_py`, add a single `kdratelimit` throttle call per chunk,
  sized to the bytes about to be sent. Guarded so it is a no-op when no limiter
  is configured (and on the TLS path, which already uses `sendfile_py`).
- Losing kernel zero-copy is acceptable: we are deliberately slowing transfers,
  and the box is disk-bound, not CPU-bound.

### Wiring

- `--kd-dl-limit FLOAT` in `__main__.py` (MB/s; `0` = disabled; default `5`),
  added beside the existing `--kd-*` args.
- `KOPYPARTY_DL_LIMIT` env var in `docker-compose.yml` → `--kd-dl-limit`,
  default `5`.

---

## Feature 2 — Remove all bulk download

### Server

- `httpcli.py` ~4194: the `for k in ["zip", "tar"]` routing block returns
  **404** instead of calling `tx_zip` (consistent with how other removed routes
  404 in this fork).
- `tx_zip`'s body is reduced to a guard that raises `Pebkac(404)`, so archive
  generation is unreachable even if some other caller remains.

### Client

- `browser.html`: remove the `#kd-zip` ZIP-button injection. The same inline
  script also repositions `#wfp` (PREV/UP/NEXT) — **that behavior is kept**;
  only the ZIP-button creation is removed.
- `browser.js`: force the `selzip` multi-select button hidden (it already POSTs,
  which 405s, but the UI affordance is removed).
- Grep `browser2.html` (no-JS fallback) and any folder-listing template for
  residual per-folder zip/tar links and remove them.

---

## Feature 3 — Viewport-gated thumbnail loading

### Problem

`loadgrid()` (`browser.js` ~5821) builds **all** grid items in one `innerHTML`
write with `<img ... loading="lazy" src="…?th…">`. Native `loading="lazy"` does
not reliably gate the up-front burst, and each `?th` request triggers a
server-side thumbnail/album-art extraction off the slow HDD.

### Change

- Emit thumbnails with **`data-src`** instead of `src` (no request at render
  time). Keep a tiny/empty placeholder so layout height is preserved
  (`th_onload` already clears the fixed height once a real image loads).
- After the grid is (re)built, attach an **IntersectionObserver**
  (`rootMargin` ≈ `200px` to preload just ahead of the viewport) over
  `#ggrid > a > img`. On intersection: `img.src = img.dataset.src`, then
  `unobserve` that image.
- The grid is rebuilt on resize / format / size changes — disconnect and
  recreate (or refresh) the observer on each rebuild so newly created `<img>`
  nodes are observed.

### Effect

Only thumbnails the user scrolls near are ever requested, so opening a
2000-file folder paints immediately and the disk only serves what is viewed.

---

## Verification

- `docker compose build --no-cache` (CLAUDE.md layer-cache discipline) + `up -d`.
- Playwright audit invariants from CLAUDE.md (J_U2K === 2, no console errors,
  grid renders, no overlaps).
- Smoke tests:
  - `GET /<folder>/?zip` and `?tar` → **404**.
  - `GET /<folder>/file` (single file) → **200** and still streams.
  - Network tab: only near-viewport `?th=` requests fire when a large folder is
    opened; scrolling triggers more.
  - Confirm a large download is rate-limited near the configured cap and that two
    concurrent downloads *share* the cap (sum ≈ limit), proving the global pool.

## Out of scope

- No per-IP or per-connection limits, no concurrency/queue limit (global cap only).
- No upload limits (uploads are already disabled — read-only fork).
- No changes to the dir-cache, theme, or other subsystems.

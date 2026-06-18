# Bandwidth cap, bulk-download removal, lazy thumbnails — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global download-bandwidth cap, remove all bulk (folder/multi-file) downloads, and make grid thumbnails load only when scrolled into view — so the home-served read-only archive can't be bandwidth-abused and large folders open instantly.

**Architecture:** Three independent changes. (1) A fork-only `kdratelimit.py` token-bucket singleton, started in `HttpSrv.__init__` (same per-serving-process rule as `kdcache`), throttling the Python file-send loop in `util.sendfile_py`; `httpcli.tx_file` forces that path when the limiter is active. (2) Bulk download is disabled via copyparty's existing `--no-zip` switch (blocks the server route and hides the client UI) plus removal of the fork's hardcoded `#kd-zip` button. (3) `browser.js` `loadgrid()` emits thumbnails with `data-src` and an IntersectionObserver assigns `src` on approach to the viewport.

**Tech Stack:** Python 3.12 (stdlib `threading`/`time`), vanilla JS (IntersectionObserver), Docker Compose, Jinja2 templates.

**Conventions to follow (from CLAUDE.md):**
- Always `docker compose build --no-cache` after editing anything under `kopyparty/web/` — the layer cache silently serves stale CSS/JS.
- Fork-only modules mirror `kdcache.py` (module-global `INST`, idempotent `start()`).
- Process-wide singletons init in `HttpSrv.__init__`, never `svchub` (the `-j>1` BrokerMp trap).
- Keep `-j1`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `kopyparty/kdratelimit.py` | **create** | Thread-safe global token-bucket + `start()`/`throttle()` singleton |
| `tests/test_kdratelimit.py` | **create** | Deterministic unit tests for the bucket (injected clock/sleep) |
| `kopyparty/util.py` | modify `sendfile_py` (~3313) | Call `kdratelimit.throttle(len(buf))` per chunk |
| `kopyparty/httpcli.py` | modify `tx_file` `use_sendfile` (~2248) | Force Python send path when limiter active |
| `kopyparty/httpsrv.py` | modify `__init__` (~128) | Start the rate-limiter singleton |
| `kopyparty/__main__.py` | add arg (~1915) | `--kd-dl-limit` CLI arg |
| `docker-compose.yml` | add command flags (~32) | `KOPYPARTY_DL_LIMIT` env + `--no-zip` |
| `kopyparty/web/browser.html` | modify injection (~206) | Remove `#kd-zip` button, keep `#wfp` move |
| `kopyparty/web/browser.js` | modify `loadgrid()` (~5889, ~5905) | `data-src` + IntersectionObserver |
| `CLAUDE.md` | document | Add a section for the rate limiter, `--no-zip`, lazy thumbs |

---

## Task 1: Rate-limiter token bucket module

**Files:**
- Create: `kopyparty/kdratelimit.py`
- Test: `tests/test_kdratelimit.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_kdratelimit.py`. The bucket takes an injected clock and sleep
function so timing is deterministic (no real sleeping). `clk` is a mutable list
holding "now"; `slept` records every sleep duration.

```python
# coding: utf-8
"""Deterministic tests for the fork's global download rate limiter.

Run: python3 tests/test_kdratelimit.py   (also works under pytest)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from kopyparty.kdratelimit import RateLimiter


def make_limiter(rate, burst=None):
    clk = [0.0]
    slept = []

    def clock():
        return clk[0]

    def sleep(n):
        slept.append(n)
        clk[0] += n  # waking up advances the clock by exactly the slept time

    lim = RateLimiter(rate, burst=burst, clock=clock, sleep=sleep)
    return lim, clk, slept


def test_burst_is_free():
    # capacity defaults to one second of rate; consuming <= capacity never sleeps
    lim, clk, slept = make_limiter(1000.0)  # 1000 B/s, capacity 1000
    lim.consume(1000)
    assert slept == [], "consuming the full burst should not sleep"


def test_overdraw_sleeps_the_debt():
    lim, clk, slept = make_limiter(1000.0)  # capacity 1000
    lim.consume(1000)          # drains bucket to 0, no sleep
    lim.consume(1000)          # bucket empty -> 1000 B debt -> 1.0s sleep
    assert abs(sum(slept) - 1.0) < 1e-9, slept


def test_refill_over_time():
    lim, clk, slept = make_limiter(1000.0)
    lim.consume(1000)          # drains to 0
    clk[0] += 0.5              # half a second passes -> 500 B refilled
    lim.consume(500)           # exactly the refilled amount -> no sleep
    assert slept == [], slept


def test_chunk_larger_than_capacity_still_drains():
    # a single request bigger than the burst must not deadlock; it just sleeps longer
    lim, clk, slept = make_limiter(1000.0, burst=1000)
    lim.consume(3000)          # 1000 free + 2000 debt -> 2.0s
    assert abs(sum(slept) - 2.0) < 1e-9, slept


def test_aggregate_throughput_matches_rate():
    # sending 10x the rate worth of bytes takes ~ (10x - burst)/rate seconds total
    lim, clk, slept = make_limiter(1000.0)  # capacity 1000
    for _ in range(10):
        lim.consume(1000)      # 10_000 B total; 1000 free -> 9000 debt -> 9.0s
    assert abs(sum(slept) - 9.0) < 1e-9, sum(slept)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
    print("ALL PASS")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 tests/test_kdratelimit.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'kopyparty.kdratelimit'` (module not created yet).

- [ ] **Step 3: Write the module**

Create `kopyparty/kdratelimit.py`:

```python
# coding: utf-8
from __future__ import print_function, unicode_literals

"""
KD fork: global download bandwidth cap.

The archive is served from a home connection; without a limit a single visitor
can saturate the uplink. This is ONE shared token bucket for the whole serving
process: every file-download thread draws from the same pool, so the *aggregate*
send rate across all visitors/connections converges to --kd-dl-limit MB/s.

Hooked into util.sendfile_py (the Python read/sendall loop). The default kernel
os.sendfile path cannot throttle, so httpcli.tx_file routes through sendfile_py
whenever a limiter is active. Started once per serving process from
HttpSrv.__init__ (same rule as kdcache: with -j>1 each BrokerMp worker is its
own process, so a parent-process global would be None in the workers; HttpSrv
runs once per serving process). The fork keeps -j1, so there is exactly one
bucket. Under -j>1 the cap would become per-worker.
"""

import threading
import time

# the live RateLimiter singleton, or None when disabled / not yet started
INST = None


class RateLimiter(object):
    def __init__(self, rate, burst=None, clock=time.monotonic, sleep=time.sleep):
        # rate: bytes/sec. burst (capacity): bytes that may be sent instantly;
        # defaults to ~1 second of rate so a fresh download isn't stalled.
        self.rate = float(rate)
        self.capacity = float(burst) if burst else self.rate
        self.tokens = self.capacity
        self._clock = clock
        self._sleep = sleep
        self.last = clock()
        self.lock = threading.Lock()

    def consume(self, nbytes):
        # Deduct nbytes (debt allowed to go negative so a chunk larger than the
        # burst still drains), then sleep off any debt OUTSIDE the lock so
        # threads serialize on bandwidth, not on the lock.
        n = float(nbytes)
        with self.lock:
            now = self._clock()
            self.tokens = min(
                self.capacity, self.tokens + (now - self.last) * self.rate
            )
            self.last = now
            self.tokens -= n
            if self.tokens >= 0:
                return
            wait = -self.tokens / self.rate
        self._sleep(wait)


def throttle(nbytes):
    """No-op when no limiter configured; otherwise block until nbytes may send."""
    if INST is not None:
        INST.consume(nbytes)


def start(args):
    """Create the per-process singleton unless disabled (--kd-dl-limit 0).
    Idempotent: a second call is a no-op, safe to invoke from HttpSrv.__init__."""
    global INST
    if INST is not None:
        return INST
    mbps = float(getattr(args, "kd_dl_limit", 0) or 0)
    if mbps <= 0:
        return None
    INST = RateLimiter(mbps * 1024 * 1024)
    return INST
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 tests/test_kdratelimit.py`
Expected: prints `ok test_...` for each test then `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add kopyparty/kdratelimit.py tests/test_kdratelimit.py
git commit -m "feat(ratelimit): global download token-bucket (fork-only)"
```

---

## Task 2: Throttle the Python file-send loop

**Files:**
- Modify: `kopyparty/util.py:3313-3346` (`sendfile_py`)

- [ ] **Step 1: Add the throttle call**

In `sendfile_py`, import the limiter once and throttle each chunk by its actual
size *before* sending. Replace the loop body. Current code:

```python
    sent = 0
    remains = upper - lower
    f.seek(lower)
    while remains > 0:
        if slp:
            time.sleep(slp)

        buf = f.read(min(bufsz, remains))
        if not buf:
            return remains

        try:
            s.sendall(buf)
            remains -= len(buf)
        except:
            return remains
```

Change to (adds the `from . import kdratelimit` and the `kdratelimit.throttle`
call):

```python
    from . import kdratelimit

    sent = 0
    remains = upper - lower
    f.seek(lower)
    while remains > 0:
        if slp:
            time.sleep(slp)

        buf = f.read(min(bufsz, remains))
        if not buf:
            return remains

        kdratelimit.throttle(len(buf))  # KD fork: global download bandwidth cap

        try:
            s.sendall(buf)
            remains -= len(buf)
        except:
            return remains
```

- [ ] **Step 2: Verify it imports cleanly**

Run: `python3 -c "import kopyparty.util; import kopyparty.kdratelimit; print('import ok')"`
Expected: `import ok` (no circular-import error — `kdratelimit` imports only stdlib).

- [ ] **Step 3: Verify throttle is a no-op when disabled**

Run:
```bash
python3 -c "import kopyparty.kdratelimit as k; k.throttle(1<<20); print('noop ok' if k.INST is None else 'unexpected INST')"
```
Expected: `noop ok` (no limiter started, so `throttle` returns immediately).

- [ ] **Step 4: Commit**

```bash
git add kopyparty/util.py
git commit -m "feat(ratelimit): throttle sendfile_py chunks via global bucket"
```

---

## Task 3: Force the Python send path when the limiter is active

**Files:**
- Modify: `kopyparty/httpcli.py:2248-2254` (`tx_file` `use_sendfile`)
- Modify: `kopyparty/httpcli.py` import area (add `from . import kdratelimit`)

- [ ] **Step 1: Add the import**

Near the other `from . import …` lines at the top of `httpcli.py`, add:

```python
from . import kdratelimit
```

(If a `from . import (...)` grouped form is used, add `kdratelimit` to it; a
standalone line is fine too. Verify with `grep -n "^from \. import" kopyparty/httpcli.py`.)

- [ ] **Step 2: Gate kernel sendfile on the limiter being off**

Current code at `httpcli.py:2248`:

```python
            use_sendfile = (
                # fmt: off
                not self.tls
                and not self.args.no_sendfile
                and (BITNESS > 32 or file_sz < 0x7fffFFFF)
                # fmt: on
            )
```

Change to:

```python
            use_sendfile = (
                # fmt: off
                not self.tls
                and not self.args.no_sendfile
                and not kdratelimit.INST  # KD fork: throttle needs the py loop
                and (BITNESS > 32 or file_sz < 0x7fffFFFF)
                # fmt: on
            )
```

- [ ] **Step 3: Verify import + module load**

Run: `python3 -c "import kopyparty.httpcli; print('httpcli import ok')"`
Expected: `httpcli import ok`.

- [ ] **Step 4: Commit**

```bash
git add kopyparty/httpcli.py
git commit -m "feat(ratelimit): route downloads through py send loop when capped"
```

---

## Task 4: Start the limiter in HttpSrv and wire the CLI arg

**Files:**
- Modify: `kopyparty/httpsrv.py:128-130`
- Modify: `kopyparty/__main__.py:1915` (after `--kd-dircache-secs`)

- [ ] **Step 1: Add the CLI arg**

In `__main__.py`, immediately after the `--kd-dircache-secs` line (1915), add:

```python
    ap2.add_argument("--kd-dl-limit", metavar="MBPS", type=float, default=0, help="KD fork: global download bandwidth cap in MB/s shared across ALL visitors/connections (one token bucket per serving process); 0 disables. Forces the python send loop instead of kernel sendfile so throttling can apply")
```

- [ ] **Step 2: Start the singleton in HttpSrv.__init__**

In `httpsrv.py`, just after the existing `kdcache.start(...)` block (line 130), add:

```python
        # KD fork: global download bandwidth cap. Same per-serving-process init
        # rule as kdcache above (the request/send threads live in THIS process).
        from . import kdratelimit

        kdratelimit.start(self.args)
```

- [ ] **Step 3: Verify the arg parses and the limiter starts**

Run:
```bash
python3 -c "
import argparse
from kopyparty import kdratelimit
ap = argparse.ArgumentParser()
ap.add_argument('--kd-dl-limit', type=float, default=0)
a = ap.parse_args(['--kd-dl-limit', '5'])
kdratelimit.start(a)
print('rate bytes/s =', int(kdratelimit.INST.rate), '(expect 5242880)')
"
```
Expected: `rate bytes/s = 5242880` (5 × 1024 × 1024).

- [ ] **Step 4: Verify 0 disables**

Run:
```bash
python3 -c "
import argparse
from kopyparty import kdratelimit
ap = argparse.ArgumentParser(); ap.add_argument('--kd-dl-limit', type=float, default=0)
print('INST after start:', kdratelimit.start(ap.parse_args([])))
"
```
Expected: `INST after start: None`.

- [ ] **Step 5: Commit**

```bash
git add kopyparty/httpsrv.py kopyparty/__main__.py
git commit -m "feat(ratelimit): --kd-dl-limit arg + start in HttpSrv"
```

---

## Task 5: Disable bulk download (--no-zip + remove injected button)

**Files:**
- Modify: `docker-compose.yml` (command list, after `--grid` ~line 34)
- Modify: `kopyparty/web/browser.html:206-241`

- [ ] **Step 1: Add `--no-zip` and the DL-limit env to docker-compose**

In `docker-compose.yml`, in the `command:` list, add `--no-zip` (after the
`--grid` line ~34) and a `--kd-dl-limit` line near the other `--kd-*` flags
(after the `--kd-dircache-secs` line ~66):

After `- --grid` add:
```yaml
      # KD fork: read-only archive — no folder/multi-file ZIP/TAR downloads.
      # Blocks the ?zip/?tar route (tx_zip raises) AND hides the client UI
      # (have_zip := not no_zip). Only single files download.
      - --no-zip
```

After the `--kd-dircache-secs=...` line add:
```yaml
      # KD fork: global download bandwidth cap in MB/s, shared across ALL
      # visitors (one token bucket). Protects the home uplink. 0 disables.
      - --kd-dl-limit=${KOPYPARTY_DL_LIMIT:-5}
```

- [ ] **Step 2: Remove the injected `#kd-zip` button from browser.html**

In `browser.html`, the inline IIFE at 206-241 both injects the ZIP button and
repositions `#wfp`. Remove only the ZIP-button half. Replace lines 206-241
(the whole `(function () { var vp = … })();` block) with this version that keeps
the `#wfp` move and drops everything ZIP:

```html
		(function () {
			var tries = 0;
			var done_wfp = false;
			var inject = function () {
				var gh = document.getElementById('ghead');
				if (!gh) return false;
				if (!done_wfp) {
					var wfp = document.getElementById('wfp');
					if (wfp && gh.parentNode) {
						gh.parentNode.insertBefore(wfp, gh.nextSibling);
						done_wfp = true;
					}
				}
				return done_wfp;
			};
			if (inject()) return;
			var timer = setInterval(function () {
				if (inject() || ++tries > 50) clearInterval(timer);
			}, 100);
		})();
```

- [ ] **Step 3: Rebuild without cache and bring up**

Run:
```bash
docker compose build --no-cache && docker compose up -d && sleep 3 && docker compose logs --tail 5
```
Expected: container starts, no traceback in logs.

- [ ] **Step 4: Verify bulk download is blocked and single files still work**

Run (replace the folder/file with a real one from your `srv`, or use `/`):
```bash
PORT=${KOPYPARTY_PORT:-8282}
curl -s -o /dev/null -w "?zip  -> %{http_code}\n" "http://127.0.0.1:$PORT/?zip"
curl -s -o /dev/null -w "?tar  -> %{http_code}\n" "http://127.0.0.1:$PORT/?tar"
```
Expected: both `-> 400` (download-as-zip/tar disabled in server config).
Then confirm a single existing file still returns 200:
```bash
curl -s -o /dev/null -w "file  -> %{http_code} %{size_download}\n" "http://127.0.0.1:$PORT/<some-existing-file>"
```
Expected: `200` with a non-zero size.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml kopyparty/web/browser.html
git commit -m "feat(bulk): --no-zip + global dl cap env; drop injected ZIP button"
```

---

## Task 6: Viewport-gated thumbnail loading

**Files:**
- Modify: `kopyparty/web/browser.js:5891` (img markup) and `:5905-5914` (post-render)

- [ ] **Step 1: Emit thumbnails with `data-src` instead of `src`**

In `loadgrid()` at `browser.js:5889-5892`, the current push is:

```javascript
			html.push('<a href="' + ohref + '" ref="' + ref +
				'"' + ac + ' ttt="' + esc(name) + '"><img style="height:' +
				(r.sz / 1.25) + 'em" loading="lazy" fetchpriority="low" decoding="async" onload="th_onload(this)" src="' +
				ihref + '" /><span' + ac + '>' + ao.innerHTML + '</span></a>');
```

Change the `src="' + ihref + '"` to `data-src` (so no request fires at render),
keep `onload`/`decoding`; drop the now-redundant `loading="lazy"`:

```javascript
			html.push('<a href="' + ohref + '" ref="' + ref +
				'"' + ac + ' ttt="' + esc(name) + '"><img style="height:' +
				(r.sz / 1.25) + 'em" fetchpriority="low" decoding="async" onload="th_onload(this)" data-src="' +
				ihref + '" /><span' + ac + '>' + ao.innerHTML + '</span></a>');
```

- [ ] **Step 2: Attach an IntersectionObserver after the grid is built**

Still in `loadgrid()`, the post-render block at `browser.js:5905-5914` is:

```javascript
			var ths = QSA('#ggrid>a');
			for (var a = 0, aa = ths.length; a < aa; a++) {
				ths[a].ondblclick = gclick2;
				ths[a].onclick = gclick1;
			}

			r.dirty = false;
			r.bagit('#ggrid');
			r.loadsel();
			aligngriditems();
			setTimeout(r.tippen, 20);
```

Insert the observer wiring right after the click-handler loop (before
`r.dirty = false;`):

```javascript
			var ths = QSA('#ggrid>a');
			for (var a = 0, aa = ths.length; a < aa; a++) {
				ths[a].ondblclick = gclick2;
				ths[a].onclick = gclick1;
			}

			// KD fork: only fetch thumbnails as they approach the viewport, so
			// opening a folder with thousands of files doesn't fire thousands of
			// ?th requests up front. Falls back to eager load if the browser
			// lacks IntersectionObserver.
			if (r.thumb_io)
				r.thumb_io.disconnect();
			var imgs = QSA('#ggrid>a>img');
			if (window.IntersectionObserver) {
				r.thumb_io = new IntersectionObserver(function (ents, ob) {
					for (var i = 0; i < ents.length; i++) {
						if (!ents[i].isIntersecting)
							continue;
						var im = ents[i].target;
						if (im.dataset.src) {
							im.src = im.dataset.src;
							im.removeAttribute('data-src');
						}
						ob.unobserve(im);
					}
				}, { rootMargin: '200px' });
				for (var a = 0, aa = imgs.length; a < aa; a++)
					r.thumb_io.observe(imgs[a]);
			} else {
				for (var a = 0, aa = imgs.length; a < aa; a++)
					if (imgs[a].dataset.src) {
						imgs[a].src = imgs[a].dataset.src;
						imgs[a].removeAttribute('data-src');
					}
			}

			r.dirty = false;
			r.bagit('#ggrid');
			r.loadsel();
			aligngriditems();
			setTimeout(r.tippen, 20);
```

- [ ] **Step 3: Rebuild without cache**

Run:
```bash
docker compose build --no-cache && docker compose up -d && sleep 3
```
Expected: container up, no traceback.

- [ ] **Step 4: Verify only near-viewport thumbnails load (Playwright)**

Use the Playwright MCP against a folder with many files. Confirm that on load the
number of fired `?th=` network requests is far smaller than the grid item count,
and that scrolling triggers more.

```js
await mcp__plugin_playwright_playwright__browser_navigate({ url: "http://127.0.0.1:8282/<big-folder>/" });
const before = await mcp__plugin_playwright_playwright__browser_evaluate({ function: `() => ({
  items: document.querySelectorAll('#ggrid>a').length,
  th_reqs: performance.getEntriesByType('resource').filter(e => e.name.indexOf('th=') > -1).length
})`});
// scroll to bottom
await mcp__plugin_playwright_playwright__browser_evaluate({ function: `() => window.scrollTo(0, document.body.scrollHeight)` });
await mcp__plugin_playwright_playwright__browser_wait_for({ time: 2 });
const after = await mcp__plugin_playwright_playwright__browser_evaluate({ function: `() => performance.getEntriesByType('resource').filter(e => e.name.indexOf('th=') > -1).length`});
// Expect: before.th_reqs << before.items, and after > before.th_reqs
```
Expected: initial `th_reqs` is roughly only what fits the first viewport (+200px margin), much less than `items`; after scrolling, more thumbnails have loaded. Also check `0` console errors.

- [ ] **Step 5: Commit**

```bash
git add kopyparty/web/browser.js
git commit -m "feat(grid): viewport-gated thumbnail loading via IntersectionObserver"
```

---

## Task 7: Document in CLAUDE.md and run the full audit

**Files:**
- Modify: `CLAUDE.md` (add an architecture subsection)

- [ ] **Step 1: Add a CLAUDE.md section**

Add a new subsection under "Architecture & quirks" describing:
- `kdratelimit.py` — global download token bucket; one bucket per serving
  process; init in `HttpSrv.__init__` (the `-j>1` trap); throttles
  `sendfile_py`; `tx_file` forces the py path when `kdratelimit.INST` is set;
  knob `KOPYPARTY_DL_LIMIT` → `--kd-dl-limit` MB/s (0 disables); under `-j>1`
  the cap becomes per-worker.
- Bulk download disabled via `--no-zip` (route → 400, UI auto-hidden via
  `have_zip`); the fork-injected `#kd-zip` button was removed from
  `browser.html` (the `#wfp` repositioning in that same script is retained).
- Grid thumbnails are viewport-gated (`data-src` + IntersectionObserver in
  `loadgrid()`); don't revert to eager `src`.

Use the same prose style as the existing sections.

- [ ] **Step 2: Run the documented smoke-test probes**

Run the CLAUDE.md smoke-test block plus the bulk checks:
```bash
PORT=${KOPYPARTY_PORT:-8282}
for u in '' '?h' '?ru' '?hc'; do
  curl -s -A "Mozilla/5.0" -o /dev/null -w "%-8s HTTP:%{http_code}\n" "http://127.0.0.1:$PORT/$u"; done
for u in '?zip' '?tar'; do
  curl -s -o /dev/null -w "GET $u -> %{http_code}\n" "http://127.0.0.1:$PORT/$u"; done
```
Expected: the page probes return 200; `?zip`/`?tar` return 400.

- [ ] **Step 3: Run the Playwright audit invariants**

Run the CLAUDE.md audit script (J_U2K === 2, grid renders, no overlaps, 0
console errors except possible favicon 404, kd-theme.css URL is `/.kpr/w/…`).
Expected: all invariants hold.

- [ ] **Step 4: Manual bandwidth sanity check (optional but recommended)**

With `KOPYPARTY_DL_LIMIT=5`, time a large single-file download and confirm the
rate sits near 5 MB/s, then run two downloads at once and confirm their combined
rate still sits near 5 MB/s (proving the shared global pool):
```bash
PORT=${KOPYPARTY_PORT:-8282}
F="<some-large-file>"   # > ~50 MB
curl -s -o /dev/null -w "1 dl: %{speed_download} B/s\n" "http://127.0.0.1:$PORT/$F"
( curl -s -o /dev/null -w "A: %{speed_download} B/s\n" "http://127.0.0.1:$PORT/$F" & \
  curl -s -o /dev/null -w "B: %{speed_download} B/s\n" "http://127.0.0.1:$PORT/$F" & wait )
```
Expected: single ≈ 5.0–5.5 MB/s; the two concurrent rates each ≈ 2.5 MB/s and sum ≈ 5 MB/s.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document global dl cap, --no-zip, lazy thumbnails"
```

---

## Self-Review notes

- **Spec coverage:** Feature 1 → Tasks 1-4 + Task 7 sanity check; Feature 2 →
  Task 5; Feature 3 → Task 6; verification → Task 7. All spec sections mapped.
- **Type/name consistency:** `RateLimiter(rate, burst, clock, sleep)`,
  `consume(nbytes)`, module `INST` / `start(args)` / `throttle(nbytes)`, arg
  `--kd-dl-limit` → `args.kd_dl_limit`, env `KOPYPARTY_DL_LIMIT`, JS
  `r.thumb_io` + `data-src` — all used identically across tasks.
- **No placeholders:** every code/command step shows concrete content.
- **`-j1` assumption** is preserved; the per-worker caveat is documented, not a
  gap.

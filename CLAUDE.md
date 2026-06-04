# CLAUDE.md — agent guide for the kopyparty fork

> Instructions for AI agents (Claude Code, Copilot Workspace, etc.) maintaining
> this fork. Read this end-to-end before making non-trivial changes.

## TL;DR

This is a heavily-slimmed personal fork of [copyparty](https://github.com/9001/copyparty)
that serves a single purpose: read-only HTTP browsing of a folder tree, themed
to match the kunaldawn.com family of sites.

- **Read-only** — every POST / PUT / DELETE / WebDAV verb returns 405.
- **Single theme** — all CSS overrides live in `kopyparty/web/kd-theme.css`.
- **Single config surface** — env vars driving `docker-compose.yml`.
- **Don't bring features back** unless the user explicitly asks. The whole
  point of this fork is what's missing.

## What was removed (and don't restore)

### Python modules deleted

| file | why |
|---|---|
| `ftpd.py`, `sftpd.py`, `tftpd.py`, `smbd.py` | alternative protocol servers — HTTP-only here |
| `mdns.py`, `ssdp.py`, `multicast.py` | service discovery broadcasters |
| `qrkode.py` | terminal QR-code printer + `?qr` SVG endpoint |
| `metrics.py` | Prometheus metrics endpoint |

### Web assets deleted

- Editors: `mde.html/css/js`, `md2.css/js`, `easymde.{css,js}`, `mini-fa.{css,woff}`
- Auth/admin: `idp.html`, `shares.{html,css,js}`, `cf.html`
- Misc: `copyparty.gif`, `dbg-audio.js`, `opds.xml`, `opds_osd.xml`
- Upload-only: `w.hash.js`, `deps/sha512.{hw,ac}.js*`, `deps/busy.mp3.gz`, `deps/fuse.py`
- Client tools: `a/partyfuse.py`, `a/u2c.py`, `a/webdav-cfg.txt`
- Translations: every file in `web/tl/` (we run `--lang eng` which is built-in)

### Code paths removed inside surviving modules

- `httpcli.py` lost ~3000 lines: every WebDAV handler (PROPFIND, PROPPATCH,
  LOCK, UNLOCK, MKCOL, MOVE, COPY), every POST handler (multipart, json,
  binary, search, smsg, stash, dump_to_file, bakflip), every folder mutation
  (`handle_mkdir`, `_mkdir`, `handle_new_md`, `handle_plain_upload`,
  `handle_text_upload`, `handle_eshare`, `handle_share`, `handle_rm`,
  `handle_mv`, `_mv`, `handle_cp`, `_cp`, `handle_fs_abrt`), every admin
  action (`scanvol`, `handle_reload`, `tx_stack`), the QR generator
  (`tx_qr`), the IDP/shares pages (`tx_idp`, `tx_shares`), the auth POSTs
  (`handle_login`, `handle_chpw`, `handle_logout`), and the OPDS catalog.
- `svchub.py` lost the FTP/SFTP/TFTP/SMB launchers, mDNS/SSDP zeroconf
  startup, and the terminal QR-code printer (`sticky_qr`, `_qr_thr` etc).
- `httpsrv.py` lost the SSDP responder, the `Metrics` instance.
- `tcpsrv.py` lost `_qr` / `_qr2file` / `_h2i` and the `restart_*` calls.

### Code paths intentionally kept (don't remove)

- `authsrv.py` — still parses volumes and permissions even though there's no
  user UI. **It's foundational; do not delete.** Methods like `chpw` and
  `forget_session` are unreachable but harmless.
- `up2k.py` — despite the name, it's the file index. Listing and search
  still depend on it.
- `pwhash.py` — instantiated by `authsrv.py` even with no users. Don't touch.
- `metrics.py` was deleted. Don't recreate it; just 404 `/.kpr/metrics`.

## What's there now

### URL surface

```
GET  /                     → browser.html (grid)
GET  /<path>/              → browser.html
GET  /<path>/file          → tx_file
GET  /<path>/?zip          → tx_zip (folder→zip, hidden by JS at root)
GET  /?h                   → splash.html
GET  /?hc                  → svcs.html (trimmed to "HTTP-only" notice)
GET  /?ru                  → rups.html (always empty)
GET  /?b=u                 → browser2.html (no-JS fallback)
GET  /file.md?v            → md.html (standalone)
GET  /file.md?doc=…        → browser.html with iframe
GET  /.kpr/w/*             → static assets (renamed from /.cpr/)
GET  /.kpr/ico/*           → ico server (still active)
GET  /<path>/?kv=<cfg>#a…  → restores a shared visualizer/tracker setup
                             (fork-only; read by kd-visualizer.js, ignored
                             server-side — `v` is reserved, so we use `kv`)

POST/PUT/DELETE/PROPFIND/PROPPATCH/LOCK/UNLOCK/MKCOL/MOVE/COPY  → 405

GET  /?qr | /?shares | /?idp | /?stack | /?reload=cfg | /?scan
GET  /.kpr/metrics | /.kpr/ssdp                                  → 404
```

### Themed pages

`browser.html`, `splash.html`, `md.html`, `rups.html`, `svcs.html`,
`browser2.html`, `msg.html` — all link `kd-theme.css` and use the kd-header /
kd-footer pattern.

### Skeleton of the kd-header

```html
<header class="kd-header">
    <div class="kd-title"><h1>{{ this.args.kd_header|e }}</h1></div>
    <nav class="kd-nav">
        <a class="kd-link" href="https://kunaldawn.com" target="_blank" rel="noopener">ABOUT</a>
    </nav>
</header>
```

`{{ this.args.kd_header }}` and `{{ this.args.kd_footer }}` are populated by
the CLI args `--kd-header` and `--kd-footer`, surfaced through environment
variables `KOPYPARTY_HEADER` and `KOPYPARTY_FOOTER` in `docker-compose.yml`.
The browser renderer's `j2a` dict was extended (`"this": self`) so `this.args`
is reachable in `browser.html` (`splash.html` already had `this`).

## Architecture & quirks

### URL prefix `/.kpr/` (was `/.cpr/`)

Renamed from upstream's `/.cpr/` to `/.kpr/` for branding. The change touches
HTML templates (`<link>`, `<script>` srcs), JS (any URL-construction in
`browser.js`), and `httpcli.py` routing (`startswith(".kpr/…")`). If you grep
for `cpr/` you should find **zero** hits in the source tree (excluding
`web/deps/marked` etc which are upstream third-party libs).

### Theme overrides in one file

`kopyparty/web/kd-theme.css` is the single source of truth for all kd theming.
It's loaded **after** copyparty's `browser.css` / `splash.css` / `ui.css` /
`md.css` so its rules win the cascade. For elements that copyparty's JS sets
inline (e.g., `#tree.style.height`, `#wrap.style.marginLeft`), you need
`!important` to override the inline style.

The theme's CSS custom properties at the top:

```css
--bg:  #071013;     /* page background */
--a:   #00ff99;     /* neon-green accent */
--fg:  #cfeee0;     /* body text */
--font-main: 'Inter', system-ui, …;
--font-mono: 'Share Tech Mono', monospace;
```

Change those four to reskin the fork for a different sub-site without
touching any structure.

### Sandbox iframe shares the parent's CSS

The markdown viewer (`?doc=`) renders inside a sandboxed `<iframe srcdoc=…>`.
copyparty's `sandbox()` function in `browser.js` injects every linked
external stylesheet into the iframe's `<head>` via `globalcss()`. **This
means kd-theme.css is automatically applied inside the iframe too** — so the
`.mdo` rules (markdown body styling) you write in `kd-theme.css` will style
both the inline-doc and the iframe-doc renderings consistently.

### `up2k.js` is a stub

The original 105 KB upload-manager JS was replaced with a 700-byte no-op
stub at `kopyparty/web/up2k.js`. It exists because `browser.js` has hard
references to `up2k.uc.ask_up`, `up2k.st.files`, `up2k.gotallfiles`, etc.,
inside event handlers (drag/drop, paste, fsearch). Without the stub, those
handlers `ReferenceError` even though they never produce useful output for
read-only volumes.

The stub also sets `var J_U2K = 2;` so the load-watchdog
(`jsldp("J_U2K","up2k")`) in `browser.html` doesn't fire its FATAL alert.
**If you rip out the stub or change its API surface, expect that alert.**

### `_spd` had to be restored

When I purged the upload pipeline I deleted `_spd` (it was grouped with the
upload helpers). But `tx_file()` (the read-only file-serving path) calls it
too. That caused `[AttributeError] 'HttpCli' object has no attribute '_spd'`
on every static asset GET, returning HTTP 500 with mismatched MIME, which
broke `up2k.js` script loading. **A small `_spd` is restored at the top of
the file-serving section.** Don't delete it again.

### ZIP button injection

`browser.html` ends with a small inline `<script>` that:

1. Polls until `#ghead` exists (the grid toolbar is created by
   `thegrid` IIFE in `browser.js` after init).
2. Inserts a neon-styled `<a id="kd-zip" href="?zip">📦 ZIP</a>` at the end
   of `#ghead`.
3. Skips injection when `location.pathname` is the root (so users can't
   accidentally trigger a whole-archive zip).
4. Also moves `#wfp` (the PREV/UP/NEXT nav) from below the file grid to
   right after `#ghead` so it sits between the toolbar and the grid.

Both injections run on the same polling timer; modifying the script is fine
but check both invariants.

### Tree sidebar layout

`#tree` is `position: absolute; left: 0` per upstream. Our overrides:

```css
left: 0.5em !important;     /* small gap so left rounded corner is visible */
bottom: 3.5em !important;   /* clear of the footer */
height: auto !important;    /* override JS-set inline height */
border-radius: 10px;
overflow: hidden;
```

When the tree is open, `treectl.js` sets `wrap.style.marginLeft` inline so
the file grid shifts right. Our `#wrap` rules **must not** include
`margin-left` so this JS keeps working.

### Footer pinning

Both `body#ht_brw` and `body#ht_spl` are `display: flex; flex-direction:
column; min-height: 100vh`, with `#wrap` set to `flex: 1 0 auto`. The
`.kd-footer` has `margin-top: auto` which pushes it to the viewport bottom
when content is short. The `.kd-footer` has `flex-shrink: 0` so it doesn't
collapse.

### Music player widget

`#widget` is hidden by default (`display:none` via `:not(.open)`); when
copyparty adds the `.open` class (a track is playing), the override
re-enables it as `position: fixed; bottom: 3em` so it sits above the footer.
Inside, `#np_inf` (the metadata panel with thumbnail) is permanently hidden;
only `#pctl` (play controls), `#barbuf` (progress), `#pvol` (volume) show.
The widget is wrapped in a rounded neon panel via `#widgeti` styling.

### Chiptune visualizer + tracker (`kd-chiptune.js`, `kd-visualizer.js`, `kd-tracker.js`)

Fork-only feature stack layered on the music widget. **Not upstream — don't
remove.**

- `kd-chiptune.js` — plays tracker modules (.mod/.it/.s3m/.xm/.mptm/…) via
  libopenmpt (WASM) + chiptune2 behind an `HTMLAudioElement`-shaped shim
  (`ChiptuneAudio`). Owns the shared `window.kdAudio.context` that both the
  visualizer and tracker tap.
- `kd-visualizer.js` — butterchurn (Milkdrop) WebGL panel `#kd-viz-panel`.
  Three states: **windowed → large → OS-fullscreen**. Large mode
  (`.kd-viz-large`, `L` key) is a tall in-tab overlay; it publishes its height
  to `--kd-viz-occupy`, which the `html#ht_brw.np_open #wrap` margin adds to its
  bottom reservation so the file browser ends *above* the panel and grid items
  stay clickable. `Escape` steps down one level. Preset name pill is fixed-width
  with a marquee for long names; the search dropdown is infinite-scroll over the
  full local preset list (no row cap). All offline.
- `kd-tracker.js` — compact **channel-tile grid** `#kd-tracker` (one tile per
  channel: number · live note · instrument · VU bar), max 8 columns, wrapping so
  every channel is visible; grid scrolls vertically for high-channel modules. The
  titlebar doubles as an **FFT spectrum-bar** display. A bottom status bar shows
  BPM/speed/order/pattern/row/channels/counts/format/time. Draggable;
  `kdTracker.clampPosition()` pulls it back into the panel after fullscreen exit.
  Reads libopenmpt getters (`get_current_*`, per-channel
  `get_current_channel_vu_left/right`, `get_metadata`).

**Performance is load-bearing here.** The tracker sits over the 60fps-animating
WebGL canvas. Two rules keep it from pegging the compositor: (1) **no
`backdrop-filter`** on any viz/tracker overlay (the PERFORMANCE block near the
bottom of `kd-theme.css` forces `backdrop-filter: none` — a blur over the
animating canvas forces a per-frame re-blur and was a major lag source); and (2)
the tracker renders only ~one node per channel (a few hundred total) and updates
text on row changes — an earlier full scrolling-pattern view rendered tens of
thousands of nodes and lagged hard while open. Don't reintroduce either.

**Shareable-setup link (`?kv=`).** The viz control bar has a 🔗 button that
snapshots the current setup — viz open/closed, mode (windowed/large; fullscreen
downgrades to large since you can't auto-enter fullscreen without a gesture),
auto-cycle + interval, preset index, and the tracker's scale/transparency/
collapsed — into a compact `[a-z0-9_]` blob under the `?kv=` query param, paired
with the playing track in the `#a<tid>` hash (which is copyparty's own
play-from-hash mechanism). On load `kd-visualizer.js` restores it. **Gotcha:
read `?kv=` from `performance.getEntriesByType('navigation')[0].name`, NOT
`location.search`** — copyparty's `browser.js` calls `hist_replace(evp +
location.hash)` during init (before this script loads), so the query is already
gone from `location.search` by the time the IIFE runs; the Navigation Timing
entry keeps the original fetched URL. `kd-tracker.js` exposes `getConfig()` /
`applyConfig()` for the tracker half. Sharing a *module* link inherits
copyparty's autoplay-needs-a-gesture quirk (a bare `#a…` module link shows the
autoplay-blocked popup too); regular audio autoplays fine.

**Play-from-start (⏮ / Home).** A recording helper: seeks the current track to 0
and plays, so you can preselect a song, start the screen recorder, then trigger
a clean start. Just `seek_au_sec(0)` + play.

### Cache headers (Cloudflare)

`permit_caching()` emits `public` on cacheable responses and adds `immutable`
for content-addressed/long-lived assets. Build-versioned static assets under
`/.kpr/w/*` are served by **`tx_file` with `oh_k == "oh_g"`** (not `tx_res` —
they exist on disk, so the routing in `httpcli.py` ~1380 prefers `tx_file`), and
that branch is gated on `oh_k == "oh_g"` to send `public, max-age=604869,
immutable` instead of the `no-cache` `cachectl` default. **Don't widen that gate
to `oh_f`** — user media + thumbnails use `oh_f` and must keep `permit_caching`
(thumbs still honour their `?cache=i`; user files follow `cachectl`). Thumbnails
and icons already request `?cache=i`, so they cache hard via that path. The whole
point is to let the Cloudflare edge + the browser skip conditional-GET round
trips on a freshly-opened folder.

### Directory cache (`kd-dircache`)

The fork is meant to run off a **slow USB HDD** whose contents rarely change.
Upstream does a live `os.scandir()` + a `stat()` per entry on **every**
directory listing and **every** tree-sidebar expansion (`authsrv._ls` →
`util.statdir`), and the `-e2dsa` index DB does **not** serve listings (it's
metadata/tags/dir-sizes only). On spinning rust that's a burst of random seeks
per browse.

`kopyparty/kdcache.py` (fork-only module) fixes this with an in-memory snapshot
of every directory's `(name, os.stat_result)` list:

- **One hook**, in `authsrv._ls` — the *sole* chokepoint both the grid listing
  (`httpcli.py` ~4178) and the tree (`~3256`) flow through. Keyed by the
  fully-resolved abspath (`absreal`), byte-identical to `_canonical()` so
  lookups hit.
- **Warmed at startup**, then a daemon **re-walks the whole tree every
  `--kd-dircache-secs`** (default `86400` = 24h; `0` disables). A container
  restart also forces an immediate re-warm — that's the intended way to pick up
  newly-added files on demand (there's no manual refresh endpoint; `?scan` was
  removed).
- **`?lt` (lstat) bypasses** to live disk. The **up2k indexer is unaffected** —
  it calls `statdir()` directly (`up2k.py:1549`), never via `_ls` — so indexing
  always sees the real disk.
- Snapshot is metadata only (~tens of MB even at hundreds of thousands of
  files); the listing serves a shallow copy so `_ls` can sort/filter freely.

**Critical: init point is `HttpSrv.__init__`, NOT `svchub`.** With `-j>1`,
`check_mp_enable()` selects `BrokerMp`, which spawns separate worker
**processes** (`broker_mpw.py` builds a fresh `AuthSrv` per worker) — and `_ls`
runs in those workers. A module-global singleton (`kdcache.INST`) created in the
parent `svchub` is `None` in the workers, so the cache **silently never
serves**. `HttpSrv` is constructed once per *serving* process for both broker
types (threaded `-j1`: one in the hub process; multiprocess: one per worker), so
`kdcache.start()` lives there and is idempotent. **Quick check that it's
serving:** add a file on disk after warm — if it appears in the listing
immediately (instead of after a restart/re-warm), the cache isn't serving in the
request process.

**Keep `-j1`.** This workload is disk-bound (HDD seek latency, not CPU). `-j1`
is a single process that already serves concurrently via a thread pool and
shares **one** warm cache; `-jN` makes each worker process re-walk and hold its
**own** copy, multiplying the daily scan across the slow disk. Only raise it if
you become genuinely CPU-bound (e.g. heavy concurrent thumbnail transcoding).

Knobs (env → `docker-compose.yml` → CLI): `KOPYPARTY_DIRCACHE_SECS`
(`--kd-dircache-secs`), `KOPYPARTY_WORKERS` (`-j`, default 1), and
`KOPYPARTY_MEM_LIMIT` (default `8g`) — the mem cap also bounds the kernel
page-cache for *file downloads* off the HDD, so keep it generous (~60–75% of
host RAM). The index DB + thumbnails must sit on **SSD** (the `kopyparty_cache`
named volume), never the HDD.

## Build & run

### Local Docker Compose

```bash
docker compose build --no-cache  # CSS/template edits sometimes miss the layer cache
docker compose up -d
docker compose logs --tail 20
docker compose down
```

The image is alpine + python 3.12 + jinja2. Build time ~5 s after first build.

### When the layer cache lies

`COPY` instructions occasionally cache stale CSS/JS. **Always use `--no-cache`
after editing files in `kopyparty/web/`.** Symptom: HTTP 200 returns the
right size but the browser shows old content.

### Smoke-test commands

```bash
# Quick HTTP probe
for u in '' '?h' '?ru' '?hc' 'extend.md?v' 'extend.md?doc'; do
  curl -s -A "Mozilla/5.0" -o /dev/null -w "%-15s HTTP:%{http_code}\n" \
    "http://127.0.0.1:8282/$u"
done

# Verify removed routes 404 / 405
for u in '?qr' '?shares' '?idp' '?stack' '?reload=cfg' '?scan' '.kpr/metrics'; do
  curl -s -o /dev/null -w "GET  $u → %{http_code}\n" \
    "http://127.0.0.1:8282/$u"
done
for u in '' '?delete' '?move' '?copy'; do
  curl -s -X POST -o /dev/null -w "POST $u → %{http_code}\n" \
    "http://127.0.0.1:8282/$u"
done

# Static asset probe
for f in baguettebox.js browser.css browser.js kd-theme.css md.css md.html \
         splash.html up2k.js util.js deps/marked.js deps/prism.js; do
  curl -s -o /dev/null -w "%-25s HTTP:%{http_code} %{size_download}\n" \
    "http://127.0.0.1:8282/.kpr/w/$f"
done
```

## Visual verification with Playwright

The whole UI was built and audited with **Playwright MCP** in headless
chromium. Key audit script template:

```js
// 1. navigate
await mcp__playwright__browser_navigate({ url: "http://127.0.0.1:8282/" });

// 2. inspect DOM positions / computed styles
const diag = await mcp__playwright__browser_evaluate({ function: `() => {
  const q = id => {
    const el = document.getElementById(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, h: r.height,
             display: getComputedStyle(el).display };
  };
  const f = document.querySelector('.kd-footer').getBoundingClientRect();
  return {
    title: document.querySelector('.kd-title h1').textContent,
    tree: q('tree'), wrap: q('wrap'), widget: q('widget'),
    footer_top: f.top,
    overlap_tree_footer: q('tree').bottom > f.top,
    J_U2K: window.J_U2K,
    grid_count: document.querySelectorAll('#ggrid > a').length
  };
}`});

// 3. consistent screenshot for visual diff
await mcp__playwright__browser_take_screenshot({ filename: "audit.png" });

// 4. check console errors
await mcp__playwright__browser_console_messages({ level: "error" });

await mcp__playwright__browser_close();
```

### Invariants the audit should confirm

- `J_U2K === 2` (up2k stub loaded successfully)
- `marked`/`DOMPurify` are defined when a `.md` page is open
- `tree.bottom < footer.top` (no overlap)
- `widget.bottom <= footer.top` (no overlap)
- `srv_info.bottom <= footer.top`
- top-gap (header→breadcrumb) ≈ bottom-gap (wrap→footer) ≈ 16 px
- `0` console errors except possibly `/favicon.ico 404`
- All 6 grid items render
- `kd-theme.css` URL is `/.kpr/w/kd-theme.css`, not `/.cpr/…`

## Adding a new themed page

1. **Template** — copy the kd-header / kd-footer block from `splash.html` to
   the new template:

   ```html
   <link rel="stylesheet" href="{{ r }}/.kpr/w/kd-theme.css?_={{ ts }}">
   <header class="kd-header">
       <div class="kd-title"><h1>{{ this.args.kd_header|e }}</h1></div>
       <nav class="kd-nav">
           <a class="kd-link" href="https://kunaldawn.com" target="_blank" rel="noopener">ABOUT</a>
       </nav>
   </header>
   …
   <footer class="kd-footer">{{ this.args.kd_footer|e }}</footer>
   ```

2. **Render-context** — make sure the call to `j2s()` passes either
   `this=self` or `args=self.args` so `kd_header` / `kd_footer` are
   accessible. (browser.html, splash.html, md.html, rups.html use `this`;
   svcs.html uses `args`. Both work.)

3. **Body layout** — add `html#ht_NEW body { display: flex; flex-direction:
   column; min-height: 100vh }` so the footer pins.

4. **Wrap** — give the main content `flex: 1 0 auto` and reuse the vault
   panel pattern (`background`, `border`, `border-radius: 10px`,
   `box-shadow`) from `#ht_spl #wrap` if it's a content-card layout.

## Pitfalls

- **Don't add `--ftp`, `--smb`, `--zm`, `--zs`, `--smb-port` etc. to the
  Docker command.** Their launchers were removed and the modules deleted.
  The CLI args are still defined in `__main__.py` (cosmetic dead text), but
  using them will raise ImportError on startup.
- **Don't link `mini-fa.css` from a new template.** It was deleted.
- **Don't call `tx_qr`, `tx_idp`, `tx_shares`, `handle_login`, `handle_post_*`,
  `handle_stash`, `handle_mkdir`.** They no longer exist.
- **Don't expect a `.cpr/…` resource URL to work.** The prefix is `.kpr/`.
- **Don't rely on `--lang xx` for a non-English UI.** All `tl/*.js` files
  are deleted.
- **Don't think `up2k.js` is doing anything.** It's a 700-byte stub. Treat
  any reference to upload-related state as no-op.
- **Don't break the `--no-cache` discipline.** Docker layer caching loves
  to skip CSS edits.
- **Don't init process-wide singletons in `svchub` if the request path needs
  them.** With `-j>1` the request path runs in `BrokerMp` worker *processes*;
  parent-process globals are `None` there. Init in `HttpSrv.__init__` (runs once
  per serving process). This is exactly the trap the `kd-dircache` hit — see
  *Directory cache* above.
- **Don't bump `-j` to "go faster" on the archive box.** It's disk-bound; more
  worker processes just multiply the dir-cache walks across the slow HDD. Keep
  `-j1` unless genuinely CPU-bound.

## When in doubt

- Re-read the upstream source at `https://github.com/9001/copyparty/blob/hovudstraum/`
  — the upstream module is the architectural reference.
- Use `git diff hovudstraum -- kopyparty/httpcli.py` (if you set up the
  upstream remote) to see exactly what was removed.
- Run the Playwright audit invariants before declaring a task done.

## License & attribution

Inherits MIT from upstream. The `__author__ = "ed <copyparty@ocv.me>"`,
the project URL constant `URL_PRJ = "https://github.com/9001/copyparty"`,
the security advisory link, and the upstream docs links inside source files
are intentionally preserved — don't replace them. The fork attribution lives
in this file and the `README.md`, not in the source files.

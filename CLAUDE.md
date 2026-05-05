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

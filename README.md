# kopyparty

A slim, read-only, themed personal HTTP file archive — forked from
[copyparty](https://github.com/9001/copyparty) (MIT, © ed). All credit for the
HTTP file-server engine goes to the upstream project; this fork strips it down
to one specific use case, reskins it, and bolts on an in-browser music player
that upstream doesn't have.

---

## What it is

A minimal HTTP front-end for browsing a folder tree on disk in a web browser.
That's it.

It serves files. It renders folder grids, the occasional Markdown file, plays
audio (including tracker/chiptune formats no browser decodes natively) and
video, shows images in a lightbox, and lets you download a sub-folder as a zip.
It does not let you upload, edit, delete, rename, share, or do anything that
mutates state on the server.

Two live deployments run this fork:

- **[chiptune.kunaldawn.com](https://chiptune.kunaldawn.com/)** — a tracker /
  chiptune archive (the music-player work below is built for this)
- **[tube.kunaldawn.com](https://tube.kunaldawn.com/)** — a video archive

## What it isn't

- not a file manager
- not a sync target
- not a webdav / ftp / smb / sftp / tftp server
- not a search engine
- not a media library with a database
- not a metrics endpoint
- not multi-user
- not authenticated

If you want any of those, use upstream copyparty instead — it's an excellent
piece of software. This fork is a deliberate downgrade in surface area, with a
deliberate upgrade in one direction: audio.

## Enhancements over upstream

The fork's distinctive feature is a self-contained music stack that turns the
read-only browser into a chiptune jukebox. Everything is vendored and runs
offline — no CDN, no server-side transcode.

| addition | file | what it does |
|---|---|---|
| **Tracker playback** | `web/kd-chiptune.js` | decodes `.mod` `.it` `.s3m` `.xm` `.mptm` `.stm` `.mo3` `.mt2` (+ gzip/xz variants) in-browser via libopenmpt (WASM), routed through the existing player widget |
| **Milkdrop visualizer** | `web/kd-visualizer.js` | a butterchurn (Milkdrop) WebGL panel driven by the live audio; preset cycling (manual / random / auto), fullscreen, settings persisted to `localStorage` |
| **Live pattern view** | `web/kd-tracker.js` | a scrolling Furnace-style channel/row grid read straight from libopenmpt while a module plays, with cross-pattern continuity; draggable overlay |
| **Client-side waveforms** | `web/kd-chiptune.js` | the seekbar waveform is rendered in-browser (the server emits no audio-peaks PNG in this fork) |

### How it works

**Tracker playback.** Browsers can't decode module formats, and this fork
dropped upstream's server-side transcode. So on the first tracker play,
`kd-chiptune.js` lazy-loads `libopenmpt.js` (a WASM port of the OpenMPT decoder,
~2.2 MB) plus `chiptune2.js`. It hooks `window.play`, sniffs the extension, and
swaps `mp.au` for a `ChiptuneAudio` shim that mimics enough of
`HTMLAudioElement` — `currentTime`, `duration`, `play`/`pause`, `volume`,
`timeupdate`/`ended` events — that copyparty's existing widget (progress bar,
prev/play/next, volume) drives it unchanged. Native formats (mp3, ogg, opus,
flac, m4a) keep the untouched `HTMLAudioElement` path.

**Visualizer.** All audio flows through one shared `AudioContext`
(`window.kdAudio.context`): native tracks via a `MediaElementSource` tapped off
`mp.au`, tracker tracks via the `ScriptProcessor` node chiptune2 already runs.
Switching formats just rewires that single source into butterchurn, so the
visualizer is format-agnostic. The rAF render loop runs only while the panel is
open, so a collapsed visualizer costs no CPU.

**Pattern view + waveforms.** `kd-tracker.js` polls libopenmpt for the current
order, row, and pattern data and paints a channel grid that scrolls with the
play-head, keeping the previous/next pattern visible across boundaries (the
Furnace behaviour). Because there's no server peaks PNG, the waveform under the
seekbar is generated client-side — Web-Audio-decoded for native files, sample
buffer for trackers — and handed to the player's `loadwaves` as a `data:` URL.

These modules are wired in as deferred `<script>` tags in `browser.html` and
patch upstream's player at runtime (re-applied after each SPA navigation), so
they stay isolated from the slimmed copyparty core.

## Design constraints

Constraints that shape this repo specifically:

- **Read-only.** Every POST / PUT / DELETE / WebDAV verb returns 405. The web
  UI exposes no login, no upload, no rename, no delete, no share.
- **Slim.** Stripped of FTP / SFTP / SMB / TFTP / mDNS / SSDP / OPDS / IDP /
  shares / Prometheus / QR-code / EasyMDE / fuse-client / 22 translations —
  roughly 60% of upstream by line count.
- **Offline-first.** No CDN and no network fonts: the font, `marked`,
  `DOMPurify`, `prism`, `libopenmpt`, and `butterchurn` are all vendored under
  `web/deps/`. The static surface is small enough to cache aggressively.
- **Single theme.** One CRT / neon-green theme in `kopyparty/web/kd-theme.css`,
  matched to the [kunaldawn.com](https://kunaldawn.com) family. No switcher, no
  light mode.
- **Aggressive defaults.** Grid view always on, list view dropped, view-mode
  toggle hidden, basic-browser fallback themed but rarely seen.

## Performance (slow-disk archives)

This fork is built to run off a slow USB HDD whose contents rarely change.
Upstream re-reads the disk (`scandir` + a `stat` per entry) on **every**
directory listing and **every** tree expansion — a burst of random seeks per
browse on spinning rust.

`kopyparty/kdcache.py` adds an **in-memory directory cache**: a snapshot of
every folder's entries, warmed once at startup and re-walked by a background
thread on an interval (default 24h). Listings and the tree sidebar then serve
from RAM, so day-to-day browsing does **zero** disk IOPS. Because content
rarely changes, newly-added files appear at the next background re-walk — or
immediately after a container restart, which forces a re-warm. The cache holds
metadata only (tens of MB even at hundreds of thousands of files) and the up2k
indexer still reads the real disk, so search/thumbnails are unaffected.

Two knobs matter for slow-disk deployments:

- **`KOPYPARTY_WORKERS` stays `1`.** The bottleneck is disk seek latency, not
  CPU; a single process already serves requests concurrently via a thread pool
  and shares one warm cache. Raising it spawns separate worker processes that
  each re-walk their own copy, multiplying scans across the slow disk.
- **The index DB + thumbnail cache live on SSD** (the `kopyparty_cache` Docker
  volume), never on the HDD, and `KOPYPARTY_MEM_LIMIT` is generous so the
  kernel can keep recently-downloaded files hot in its page cache.

## What's in the UI

- **Header** with a configurable archive title (`KD's Homebrew Data Archive`
  by default) and a single `ABOUT` link to the parent kunaldawn.com site.
- **Breadcrumb** at the top showing the current path; or a tree sidebar
  (toggleable, both modes are themed).
- **Grid toolbar** with multiselect, crop, 3×, zoom, chop, sort, and a
  bright-green `ZIP` button on the right (hidden at root to prevent
  whole-archive downloads).
- **File grid** with thumbnails (when supported by available libraries) or
  emoji-style placeholder tiles colored by extension.
- **Audio player** as a rounded panel above the footer; appears only when a
  track is playing, vanishes when stopped. Plays both native audio and tracker
  modules, with the optional Milkdrop visualizer and live pattern view (see
  [Enhancements](#enhancements-over-upstream)).
- **Image / video lightbox** with native HTML5 controls, prev/next navigation.
- **Markdown viewer** that renders both inline (`?doc=foo.md`) and standalone
  (`/foo.md?v`) — both with the same theme. TOC sidebar on the standalone
  view. Syntax highlighting via Prism, sanitization via DOMPurify, both
  vendored offline.
- **Footer** with a configurable tagline.

What you won't find in the UI: any login form, any upload form, any
folder-mutation control, any "share this with a password" button, any
view-mode dropdown, any theme switcher, any version banner, any PREV/UP/NEXT
at the bottom (it's at the top now), any π button, no idle-timeout warnings.

## Quick start

```bash
# default (read-only, grid view, "KD's Homebrew Data Archive" title)
docker compose up -d

# with a different archive name
KOPYPARTY_HEADER="KD Music Vault" \
KOPYPARTY_FOOTER="Stay tuned: Music Vault is read-only" \
KOPYPARTY_DATA_DIR=/media/kunaldawn/nas/music \
KOPYPARTY_PORT=9000 \
docker compose up -d
```

Then open `http://localhost:8282/` (or whatever port you chose).

The `srv/` directory in this repo is the default mount point — drop files
there and they appear instantly. For real deployments, point
`KOPYPARTY_DATA_DIR` at your archive root.

## Configuration

| env var | default | what it does |
|---|---|---|
| `KOPYPARTY_PORT` | `8282` | host port mapped to container's `3923` |
| `KOPYPARTY_DATA_DIR` | `./srv` | host directory mounted read-only at `/data` |
| `KOPYPARTY_MEM_LIMIT` | `8g` | container memory cap; also bounds the kernel page-cache for file reads, so keep it generous (~60–75% of host RAM) |
| `KOPYPARTY_DIRCACHE_SECS` | `86400` | in-memory directory-cache re-walk interval (seconds); `0` disables the cache |
| `KOPYPARTY_WORKERS` | `1` | worker count (`-j`); keep `1` for disk-bound archives (see [Performance](#performance-slow-disk-archives)) |
| `KOPYPARTY_HEADER` | `KD's Homebrew Data Archive` | top-of-page title text |
| `KOPYPARTY_FOOTER` | `Served offline via KD's Homebrew Data Archive` | bottom-of-page tagline (the `> ` prefix is added by CSS) |
| `TZ` | `UTC` | container timezone |

The defaults are baked into `docker-compose.yml`. To change the layout,
sub-pages, theme colors, or behavior beyond text labels, edit
`kopyparty/web/kd-theme.css` and the templates in `kopyparty/web/*.html`.

## Repository layout

```
kopyparty/                 main package (renamed from upstream copyparty/)
├── __main__.py            entrypoint (python -m kopyparty)
├── httpcli.py             HTTP request handler — heavily slimmed
├── httpsrv.py             HTTP server
├── svchub.py              service hub (lifecycle)
├── authsrv.py             volume + permission parsing (still loads, no UI)
├── up2k.py                file index (used for read-only listing/search)
├── kdcache.py             in-memory directory cache (fork-only; slow-disk perf)
├── th_srv.py              thumbnail server
├── …
└── web/                   static frontend
    ├── kd-theme.css       all KD theming overrides
    ├── kd-chiptune.js     tracker/chiptune playback + client waveforms
    ├── kd-visualizer.js   butterchurn (Milkdrop) visualizer panel
    ├── kd-tracker.js      live Furnace-style pattern view
    ├── browser.html       main grid / list view
    ├── splash.html        ?h control panel
    ├── md.html            standalone markdown viewer
    ├── rups.html          ?ru recent uploads (always empty in read-only)
    ├── svcs.html          ?hc connect page (trimmed to a minimal notice)
    ├── browser2.html      no-JS fallback (themed)
    ├── msg.html           transient redirect/notice page
    └── deps/              vendored marked + DOMPurify + prism + scp font,
                           libopenmpt (WASM) + chiptune2, butterchurn + presets

Dockerfile                 alpine + python3.12 + jinja2
docker-compose.yml         single-service compose with env-driven config
setup.py / pyproject.toml  package metadata (renamed to kopyparty)
contrib/, scripts/, docs/, bin/, tests/
                           upstream extras left untouched (not used by the fork)
```

## URL surface

| URL | result |
|---|---|
| `/` | grid view of root (or current folder) |
| `/<path>/` | grid view of subfolder |
| `/<path>/file.ext` | serve file (or open in viewer if it's `.md`/image/audio/video) |
| `/<path>/?zip` | download folder as zip (disabled at root) |
| `/?h` | splash / control panel |
| `/?hc` | "this archive is HTTP-only" connect notice |
| `/?ru` | recent uploads (always empty — readonly) |
| `/?b=u` | basic-browser HTML fallback |
| `/file.md?v` | standalone markdown viewer with TOC |
| `/.kpr/w/*` | static frontend assets (renamed from upstream `/.cpr/`) |

Everything else 404s. POST / PUT / DELETE / WebDAV-verbs return 405.

## Theming

All theme rules live in **one file**: `kopyparty/web/kd-theme.css`. It
overrides upstream's `browser.css`, `splash.css`, `md.css`, etc. via higher
specificity (`#ht_brw …`, `#ht_spl …`) or `!important` where the upstream
inline styles need to be pinned (e.g., the tree sidebar's JS-set `height`).

To reskin the fork for a different sub-site, edit just this file and the
header/footer templates. The CSS variables at the top of `kd-theme.css`
(`--bg`, `--a`, `--fg`, etc.) drive everything else.

## Audit / Verification

Throughout the development of this fork, every change was verified using
[Playwright MCP](https://github.com/microsoft/playwright-mcp) — the rendered
page in a real headless browser, with assertions on DOM positions, computed
styles, and console errors. The whole audit harness is captured in
[`CLAUDE.md`](CLAUDE.md), which is the source-of-truth for AI-assisted
maintenance of this fork.

## Upstream

For everything outside the read-only-archive use case (uploads, sharing,
auth, multi-user, FTP/WebDAV/SMB, search index, full media tagging), use
upstream copyparty:

- https://github.com/9001/copyparty — the source
- https://copyparty.ovh — the live demo

All of the heavy lifting of the HTTP server, the up2k chunked uploader, the
WebDAV layer, and the thumbnail pipeline was written by ed and contributors
to the upstream project. This fork is a thin re-skinning + a feature subset +
the music stack above. The original LICENSE (MIT) is preserved at the root.

The tracker/chiptune layer builds on third-party libraries vendored under
`web/deps/`: [libopenmpt](https://lib.openmpt.org/libopenmpt/) /
[chiptune2.js](https://github.com/deskjet/chiptune2.js) for decoding and
[butterchurn](https://github.com/jberg/butterchurn) for the Milkdrop
visualizer. Their respective licenses apply.

## License

MIT — see [LICENSE](LICENSE). This fork inherits the upstream license; the
attribution to ed and other contributors is preserved in source files
(`__author__` in `kopyparty/__main__.py`, the project URL in `util.py`, the
security advisory link in `httpcli.py`).

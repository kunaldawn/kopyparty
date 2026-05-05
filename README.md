# kopyparty

A slim, read-only, themed personal HTTP file archive — forked from
[copyparty](https://github.com/9001/copyparty) (MIT, © ed). All credit for the
HTTP file-server engine goes to the upstream project; this fork strips it down
to one specific use case and reskins it.

---

## What it is

A minimal HTTP front-end for browsing a folder tree on disk in a web browser.
That's it.

It serves files. It renders folder grids, the occasional Markdown file, plays
audio/video, shows images in a lightbox, and lets you download a sub-folder as
a zip. It does not let you upload, edit, delete, rename, share, or do anything
that mutates state on the server.

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
piece of software. This fork is a deliberate downgrade.

## Philosophy

> A shelf in a house, not a rack in a data centre.

- **Read-only**: every POST / PUT / DELETE / WebDAV verb returns 405. The web
  UI exposes no login, no upload, no rename, no delete.
- **Slim**: stripped of FTP / SFTP / SMB / TFTP / mDNS / SSDP / OPDS / IDP /
  shares / Prometheus / QR-code / EasyMDE / fuse-client / 22 translations.
  The remaining surface is roughly 60% the size of upstream by line count.
- **Themed**: a single CRT / neon-green theme matched to the sibling sites
  ([kunaldawn.com](https://kunaldawn.com), `wiki.kunaldawn.com`,
  `pdfarchive.kunaldawn.com`). No theme switcher. No light mode.
- **Self-hosted, low-power**: designed to live on a 2× Raspberry Pi 4 +
  N150 mini-PC cluster running on ~30 W of off-grid solar. So the static
  surface is small enough to cache aggressively and the server doesn't talk
  to the network for fonts or scripts.
- **Aggressive defaults**: grid view always on, view-mode toggle hidden,
  list view dropped, basic-browser fallback themed but rarely seen.

## What's in the UI

- **Header** with a configurable archive title (`KD's Homebrew Data Archive`
  by default), a single `ABOUT` link to the parent kunaldawn.com site.
- **Breadcrumb** at the top showing the current path; or a tree sidebar
  (toggleable, both modes are themed).
- **Grid toolbar** with multiselect, crop, 3×, zoom, chop, sort, and a
  bright-green `ZIP` button on the right (hidden at root to prevent
  whole-archive downloads).
- **File grid** with thumbnails (when supported by available libraries) or
  emoji-style placeholder tiles colored by extension.
- **Audio player** as a rounded panel above the footer; appears only when a
  music file is playing, vanishes when stopped.
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
| `KOPYPARTY_MEM_LIMIT` | `2g` | container memory cap |
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
├── th_srv.py              thumbnail server
├── …
└── web/                   static frontend
    ├── kd-theme.css       all KD theming overrides
    ├── browser.html       main grid / list view
    ├── splash.html        ?h control panel
    ├── md.html            standalone markdown viewer
    ├── rups.html          ?ru recent uploads (always empty in read-only)
    ├── svcs.html          ?hc connect page (trimmed to a minimal notice)
    ├── browser2.html      no-JS fallback (themed)
    ├── msg.html           transient redirect/notice page
    └── deps/              vendored marked + DOMPurify + prism + scp font

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
to the upstream project. This fork is a thin re-skinning + a feature subset.
The original LICENSE (MIT) is preserved at the root.

## License

MIT — see [LICENSE](LICENSE). This fork inherits the upstream license; the
attribution to ed and other contributors is preserved in source files
(`__author__` in `kopyparty/__main__.py`, the project URL in `util.py`, the
security advisory link in `httpcli.py`).

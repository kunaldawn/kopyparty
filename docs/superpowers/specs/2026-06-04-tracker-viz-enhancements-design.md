# Tracker & Visualizer Enhancements — Design

Date: 2026-06-04
Scope: `kopyparty/web/kd-tracker.js`, `kopyparty/web/kd-visualizer.js`,
`kopyparty/web/kd-theme.css` only. No Python, no new dependencies, no network
calls. Read-only fork invariants untouched.

## Background

The fork ships a custom chiptune stack on top of copyparty's music widget:

- `kd-chiptune.js` — routes tracker modules (.mod/.it/.s3m/.xm/.mptm/…) through
  libopenmpt (WASM) + chiptune2, behind an `HTMLAudioElement`-shaped shim
  (`ChiptuneAudio`). Owns the shared `window.kdAudio.context`.
- `kd-visualizer.js` — butterchurn (Milkdrop) WebGL panel `#kd-viz-panel`,
  slide-up above the music widget. Windowed (280px) or OS-fullscreen. Hosts a
  preset name pill `#kd-viz-info` + searchable dropdown `#kd-viz-search`.
- `kd-tracker.js` — Furnace-style live pattern view `#kd-tracker`, a draggable
  child of `#kd-viz-panel`. Position persisted to `localStorage`.

The vendored `libopenmpt.js` build exposes (verified):
`get_current_tempo`, `get_current_speed`, `get_current_pattern`,
`get_current_order`, `get_current_row`, `get_current_playing_channels`,
`get_current_channel_vu_left/right/mono`, `get_num_orders/patterns/channels/
instruments/samples`, `get_metadata`, `get_duration_seconds`,
`get_position_seconds`, `get_current_estimated_bpm`. It does **not** expose
per-channel PCM, so true per-sample per-channel waveforms are out of scope;
per-channel **VU levels** are available and used instead.

## Decisions (from brainstorming)

- Preset list: **local infinite scroll**, fully offline. No remote catalog.
- Large mode: **tall fixed panel** (~75–85vh) anchored above the widget; file
  browser must be resized to end *above* the panel so grid items stay clickable.
- Scopes: **per-channel VU meters AND a master oscilloscope**.
- Status bar: **all four field groups** (tempo+speed, order/pattern/row,
  channels+counts, format+time).
- Master scope placement: **dedicated full-width strip above the status bar**.
- VU bar orientation: **horizontal, under each channel label**.
- Process: write+commit spec, then build straight through.

---

## Feature 1 — Tracker returns to viewport after fullscreen exit (bug)

**Cause.** The tracker's dragged `left/top` are px relative to `#kd-viz-panel`
and saved to `localStorage` (`kd_tracker_pos`). In fullscreen the panel is
viewport-sized, so the box can be dragged far down/right; on exit the panel
shrinks back to 280px and those coordinates fall outside it → the tracker is
positioned off-panel and disappears.

**Fix.** Add `kdTracker.clampPosition()`:

- Read the panel rect and the tracker rect; clamp the tracker's *live*
  `style.left`/`style.top` into `[0, panelW − trackerW]` × `[0, panelH −
  trackerH]` (mirrors the clamp already in the drag `move()` handler).
- Only adjusts the live inline position; **does not** rewrite the saved
  `kd_tracker_pos`. So when space is available again the tracker can still honour
  the user's intended placement, but it is never stranded off-screen.
- No-op when `#kd-tracker` is not present / not `.kd-tracker-on`.

**Callers (in `kd-visualizer.js`).** Invoke `window.kdTracker.clampPosition()`:
on `fullscreenchange`/`webkitfullscreenchange` (after the panel resizes), on the
large-mode toggle, and inside the debounced window `resize` handler. Guard each
call with `window.kdTracker && window.kdTracker.clampPosition`.

## Feature 2 — "Large" visualizer mode (windowed → large → fullscreen)

**Control.** New anchor `#kd-viz-large` (icon `⤢`) inserted in `#kd-viz-ctrl`
between `#kd-viz-next` and `#kd-viz-fs`. Title "larger view (L)". Click toggles
`panel.classList.toggle('kd-viz-large')`. Keyboard `L`/`l` toggles it (added to
the existing keydown handler, same guards).

**Layout.** `.kd-viz-large` (when also `.kd-viz-open`, not `:fullscreen`):
- `height` grows to roughly `calc(100vh − var(--kd-footer-h) − var(--kd-widget-h)
  − 4*var(--kd-gap) − <top inset for chips>)`, clamped so the preset pill/track
  chip at the top stay on-screen (target ~75–85vh). Still `position:fixed`,
  anchored above the widget exactly like windowed mode (same `bottom`/`left`/
  `right`). The music widget is **not** moved into the panel (DOM move stays
  exclusive to OS fullscreen).

**File-browser overlap fix (explicit requirement).** The panel is a fixed
overlay; growing it must not cover grid items.
- Publish the panel's occupied height to a CSS custom property on `:root`
  (or `#ht_brw`), `--kd-viz-occupy`, set by `kd-visualizer.js`: `0px` in
  windowed/closed, the actual large-mode panel height (+ gap) in large mode.
- Add `--kd-viz-occupy` to the file-browser bottom reservation so `#wrap`/the
  grid ends *above* the panel. Mechanism: extend `#wrap`'s effective bottom
  spacing (the existing bottom padding/margin that already clears footer+widget)
  by `var(--kd-viz-occupy)`. In windowed mode the var is `0px`, so current layout
  is byte-for-byte unchanged.
- On large-mode exit / panel close, reset `--kd-viz-occupy` to `0px`.

**Escape semantics.** Escape steps down one level: if `:fullscreen` → exit
fullscreen; else if `.kd-viz-large` → drop to windowed; else → `closePanel()`.
Arrow/R/A/F unchanged. `F` still toggles OS fullscreen from any state.

**Canvas.** Call `resizeCanvas()` after the height transition on toggle (same
`setTimeout` pattern already used for open/fullscreen). Call
`kdTracker.clampPosition()` after resize so the tracker stays in view.

## Feature 3 — Preset dropdown: consistent width + marquee + infinite scroll

**Consistent width.** `#kd-viz-info` currently content-sizes (`max-width:
calc(50% − 24px)` + ellipsis), so it jiggles per preset and is narrower than the
dropdown. Change it to a **fixed** width equal to the dropdown
(`width: min(360px, calc(100% − 24px))`, `box-sizing: border-box`), right-
anchored, so pill and dropdown share one edge-aligned column. Mobile keeps a
proportional `min(...)`.

**Long-name marquee.** Replace the JS `slice(0,67)+'…'` truncation in
`applyPreset.setName()` with the full text in an inner `<span>`; CSS marquees it
only when it overflows the pill:
- Structure: `#kd-viz-name` (clip container, `overflow:hidden`) wrapping
  `<span class="kd-viz-name-inner">`.
- After setting text, JS measures `scrollWidth > clientWidth`; toggles a
  `.marquee` class. CSS keyframe translates the inner span from `0` to
  `calc(-1 * (scrollWidth − clientWidth) − pad)` and back (ping-pong), duration
  proportional to overflow, `animation-play-state: paused` on hover.
- When it fits, no animation (static, left-aligned).

**Infinite scroll.** Replace the 200-row cap + "… N more — refine search" line
in `buildSearchList()` with paged rendering:
- Keep the full `matched` array (filtered or all). Render an initial page
  (`PAGE = 60` rows) into `#kd-viz-search-list`.
- Append a sentinel `<li class="kd-viz-more-sentinel">`; an `IntersectionObserver`
  (root = the list) appends the next `PAGE` rows when the sentinel scrolls near.
  Re-observe the moved sentinel after each append; disconnect when exhausted.
- Re-filtering (on input) resets paging: clear list, rebuild observer, render
  page 1. Selection / lazy JSON fetch path unchanged.
- Row click handler, `.current` marker, and `li.title=key` semantics preserved.
- Fully local: operates over the already-loaded ~950 names; no network.

## Feature 4 — Tracker width adapts to channel count

Today `#kd-viz-panel #kd-tracker` is fixed `width: min(640px, calc(100% − 24px))`
and the body always allows horizontal scroll.

**New behaviour (JS-driven, in `rebuildTape` and on resize).**
- Compute desired content width in px from `activeChans.length`:
  `desired = rowidxWidth + chans*cellWidth + horizontalPaddings` where
  `cellWidth`/`rowidxWidth` are derived from the computed `font-size` (8.2em /
  2.4em desktop, 6.6em / 2em mobile — read from CSS or constants matching CSS).
- Available width = `panel.clientWidth − (2 * tracker side inset)`.
- Set `panel(tracker).style.width = min(desired, available) + 'px'`.
- If `desired ≤ available`: body fits, **no horizontal scrollbar** (`overflow-x:
  hidden` via a `.kd-tracker-fits` class). If `desired > available`: cap at
  available and enable `overflow-x:auto` (a thin neon-styled scrollbar) via the
  absence of `.kd-tracker-fits`. Header strip already syncs `scrollLeft`.
- Re-run on track change (channel count set in `rebuildTape`) and in the panel
  ResizeObserver. After width change, call `clampPosition()` so the tracker stays
  inside the panel.
- The CSS keeps a `max-width: calc(100% − 24px)` guard; the dragged-position
  clamp (Feature 1) prevents a wide tracker from overflowing the panel.

## Feature 5 — Tracker status bar (Furnace-style)

New element `<div class="kd-tracker-status">` appended after the body in
`buildPanel()`. Flex row, monospace, neon palette, `flex: 0 0 auto`.

**Fields & sources** (computed in `tick()`, ≤30fps):
- **Tempo (BPM)** `get_current_tempo(mp)` + **Speed** `get_current_speed(mp)`
  (ticks/row) — live.
- **Order / Pattern / Row** — `Ord {curOrd}/{nOrders-1} · Pat {curPat} · Row
  {row hex}/{nrows hex}`. `curPat = get_current_pattern(mp)`,
  `nrows = get_pattern_num_rows(mp, curPat)`. Live.
- **Channels + counts** — `Ch {get_current_playing_channels}/{numChannels}` +
  `Ins {numInstruments} · Smp {numSamples}`. Counts cached per track (on the
  track-change reset already in `tick()`), playing-count live.
- **Format + time** — module type label from `get_metadata(mp,"type_long")`
  (fallback `"type"`), cached per track; + `m:ss / m:ss` from
  `get_position_seconds` & cached `get_duration_seconds`. Live time.

**Implementation notes.**
- Reuse `rdStr`/`fmtCmdStr`-style C-string reading for `get_metadata` (it returns
  an allocated `char*`; free with `_openmpt_free_string`). Read metadata once per
  track and cache.
- Build the status string once per tick into spans with stable IDs/classes;
  update `textContent` only when changed to avoid layout thrash.
- Mobile (`max-width:760px`): drop the static labels, keep the values, allow the
  strip to wrap or shrink font; hide the lowest-priority group (counts) if space
  is tight via CSS.

## Feature 6 — Per-channel VU meters + master oscilloscope

### 6a. Per-channel VU (horizontal, under label)
- In `buildHeader()`, each channel header `.cell` gets a child
  `<span class="kd-vu"><i class="kd-vu-fill"></i></span>` rendered under the
  channel name (CSS: thin horizontal track, fill width = level).
- Each `tick()`: for each `activeChans[k]`, `vu = max(
  get_current_channel_vu_left(mp,ch), get_current_channel_vu_right(mp,ch))`
  (0..1). Set the fill element's `style.width = (vu*100)+'%'`; colour via a
  green→neon gradient (static gradient background, width reveals it). A short
  decay (track the displayed level, ease toward target) keeps it from flickering.
- Cheap integer FFI per channel per tick; bounded by `activeChans.length`.
- Header cell layout adjusts so name + VU bar stack vertically without changing
  the cell width contract used by Feature 4.

### 6b. Master oscilloscope (dedicated strip above status)
- New `<canvas class="kd-tracker-scope">` inserted above `.kd-tracker-status`,
  full panel width, fixed CSS height (~34px desktop / ~24px mobile), DPR-aware
  backing store.
- One `AnalyserNode` created on `window.kdAudio.context` (`fftSize` ~1024,
  `smoothingTimeConstant` ~0). Connect the **same source** the visualizer uses:
  - chiptune: `kdChiptune.getPlayer().currentPlayingNode`;
  - native audio: `mp.au._kdSource` (MediaElementSource).
  Tap in parallel (analyser is a sink; do not insert into the existing
  source→destination / source→butterchurn paths). Reconnect when the source
  changes — expose `kdTracker.onAudioChanged()` and call it from the same places
  `kd-chiptune.js` already calls `kdVisualizer.onAudioChanged()` (track load,
  `set_ev` wrap). Reuse the analyser node across reconnects.
- Draw in the existing tracker `tick()` (no second rAF): `getFloatTimeDomainData`
  → single-stroke neon waveform centred vertically. Clear + redraw each tick.
  Skip drawing when the scope canvas has zero size or no analyser yet.
- Works for both chiptune and native audio because both feed `window.kdAudio`.

## Visibility / lifecycle

- Status bar, scope, and VU all live inside `#kd-tracker` and are therefore shown
  only while `.kd-tracker-on` (a tracker module playing) — consistent with the
  existing panel. They reset on `hidePanel()`.
- The analyser connection is created lazily on first need and survives track
  changes; it is harmless when idle.

## Non-goals

- No per-sample per-channel waveforms (libopenmpt build can't supply per-channel
  PCM without expensive re-rendering).
- No remote/online preset catalog.
- No changes to Python, Docker, routing, or any read-only invariant.
- No DOM-move of the music widget in large mode (only OS fullscreen does that).

## Verification (Playwright, per CLAUDE.md audit template)

Existing invariants must still hold (`J_U2K===2`, no overlap of tree/widget/
footer, 0 console errors except favicon, grid renders, `.kpr/` URLs). New checks:

1. **F1:** open viz → fullscreen → drag tracker to a far corner → exit
   fullscreen → `#kd-tracker` rect is fully within `#kd-viz-panel` rect.
2. **F2:** toggle large mode → panel height ≈ target vh; the last grid item's
   `getBoundingClientRect().bottom` ≤ panel top (item is clickable, not covered);
   exit large → layout reverts to baseline.
3. **F3:** preset pill width constant across 3 different presets; long name
   marquees (inner span `scrollWidth > clientWidth` and `.marquee` present);
   dropdown scrolling appends rows beyond 200 (list length grows past cap).
4. **F4:** load a >12-channel module → tracker width caps at available and body
   `scrollWidth > clientWidth` (scrollbar present); load a ≤6-channel module →
   `scrollWidth ≈ clientWidth` (no scrollbar) and width ≈ content.
5. **F5:** status bar shows non-empty BPM, speed, Ord/Pat/Row, Ch counts, format,
   and a `m:ss / m:ss` time while a module plays; values change over time.
6. **F6:** VU fills animate (width changes across frames for active channels);
   scope canvas is non-blank (pixel sample varies) during playback for both a
   tracker module and an mp3/ogg.

Build with `docker compose build --no-cache && docker compose up -d` before
auditing (layer-cache discipline).

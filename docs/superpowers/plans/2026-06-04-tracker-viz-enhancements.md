# Tracker & Visualizer Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six enhancements to the kopyparty chiptune tracker/visualizer: fullscreen-exit tracker clamp, a "large" visualizer mode, a fixed-width/marquee/infinite-scroll preset dropdown, channel-count-adaptive tracker width, a Furnace-style status bar, and per-channel VU meters + a master oscilloscope.

**Architecture:** All logic lives in three existing front-end files — `kopyparty/web/kd-visualizer.js` (butterchurn panel + preset UI + fullscreen), `kopyparty/web/kd-tracker.js` (pattern view), and `kopyparty/web/kd-theme.css` (all styling). No Python, no new dependencies, no network. Audio scope/VU read from the already-shared `window.kdAudio.context` and the vendored libopenmpt WASM exports.

**Tech Stack:** Vanilla ES5-style IIFE JavaScript (match the existing files — `var`, no arrow funcs in shipped code), CSS custom properties, libopenmpt WASM FFI, WebAudio `AnalyserNode`, butterchurn. Docker Compose for build. Playwright MCP (headless chromium) for verification — this repo has **no unit-test harness**; "verify" steps are Playwright/curl probes per `CLAUDE.md`.

**Critical build discipline (from CLAUDE.md):** after any edit under `kopyparty/web/`, rebuild with `docker compose build --no-cache && docker compose up -d` or the browser may serve stale assets. The app serves on `http://127.0.0.1:8282/`. A folder containing at least one tracker module (.mod/.it/.s3m/.xm/.mptm) **and** at least one mp3/ogg is needed to exercise playback paths.

---

## File Structure

- **`kopyparty/web/kd-tracker.js`** (modify) — owns `#kd-tracker`. Adds: `clampPosition()` + `onAudioChanged()` on `window.kdTracker`; status-bar element + update; per-channel VU bars in the header; master oscilloscope canvas + analyser; channel-adaptive width.
- **`kopyparty/web/kd-visualizer.js`** (modify) — owns `#kd-viz-panel`. Adds: large-mode button + toggle + `--kd-viz-occupy` publishing; fixed-width pill + marquee; infinite-scroll dropdown; calls into `kdTracker.clampPosition()` on size changes; `L` key + Escape stepping.
- **`kopyparty/web/kd-theme.css`** (modify) — all styling for the above: `.kd-viz-large`, `--kd-viz-occupy` + `#wrap` reservation, fixed pill width + `.marquee` keyframes, status bar, VU bar, scope canvas, channel-fit scrollbar.

Helper functions added to `kd-tracker.js` are module-local; the only new public surface is two methods on the existing `window.kdTracker` object.

---

## Task 1: Fix tracker stranded off-panel after fullscreen exit

**Files:**
- Modify: `kopyparty/web/kd-tracker.js` (add `clampPosition` to the `window.kdTracker` object near line 604; it reuses `panel`/module state)
- Modify: `kopyparty/web/kd-visualizer.js` (call it from `onFullscreenChange` ~line 578 and the resize handler ~line 757)

- [ ] **Step 1: Add `clampPosition()` to `window.kdTracker` in `kd-tracker.js`.**

Locate the existing public object (around line 604):

```js
    window.kdTracker = {
        rebuild: function () { tapeOrd = -1; activeChans = null; prevTapePad = -1; },
        resetPosition: function () {
```

Insert a new method `clampPosition` as the first property:

```js
    window.kdTracker = {
        // Re-clamp the (possibly dragged) tracker box back inside the viz
        // panel. The dragged left/top are px relative to #kd-viz-panel and
        // persisted to localStorage; when the panel shrinks (e.g. exiting
        // fullscreen) a far-corner position lands outside the smaller panel
        // and the tracker vanishes. This pins it back into view WITHOUT
        // rewriting the saved position, and is a no-op when already inside.
        clampPosition: function () {
            if (!panel || !panel.classList.contains('kd-tracker-on')) return;
            var viz = document.getElementById('kd-viz-panel');
            if (!viz) return;
            var vr = viz.getBoundingClientRect();
            var r = panel.getBoundingClientRect();
            var curLeft = r.left - vr.left;
            var curTop = r.top - vr.top;
            var maxLeft = Math.max(0, vr.width - r.width);
            var maxTop = Math.max(0, vr.height - r.height);
            var nl = Math.max(0, Math.min(curLeft, maxLeft));
            var nt = Math.max(0, Math.min(curTop, maxTop));
            // only convert to inline positioning when actually out of bounds,
            // so an un-dragged tracker keeps its responsive CSS placement.
            if (Math.abs(nl - curLeft) > 0.5 || Math.abs(nt - curTop) > 0.5) {
                panel.style.left = nl + 'px';
                panel.style.top = nt + 'px';
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                panel.style.transform = 'none';
            }
        },
        rebuild: function () { tapeOrd = -1; activeChans = null; prevTapePad = -1; },
        resetPosition: function () {
```

- [ ] **Step 2: Call it after fullscreen change in `kd-visualizer.js`.**

Find `onFullscreenChange` (~line 578):

```js
    function onFullscreenChange() {
        var fs = document.fullscreenElement || document.webkitFullscreenElement;
        if (fs && panel && fs === panel) moveWidgetIntoPanel();
        else restoreWidget();
    }
```

Replace with (add a deferred clamp so it runs after the panel resizes):

```js
    function onFullscreenChange() {
        var fs = document.fullscreenElement || document.webkitFullscreenElement;
        if (fs && panel && fs === panel) moveWidgetIntoPanel();
        else restoreWidget();
        // panel size just changed; pull the tracker back into view once the
        // layout settles.
        setTimeout(function () {
            if (window.kdTracker && window.kdTracker.clampPosition)
                window.kdTracker.clampPosition();
        }, 60);
    }
```

- [ ] **Step 3: Call it from the resize handler in `kd-visualizer.js`.**

Find the resize handler (~line 757):

```js
    var resizeT = 0;
    window.addEventListener('resize', function () {
        if (!isOpen()) return;
        clearTimeout(resizeT);
        resizeT = setTimeout(resizeCanvas, 120);
    });
```

Replace the inner timeout body to also clamp:

```js
    var resizeT = 0;
    window.addEventListener('resize', function () {
        if (!isOpen()) return;
        clearTimeout(resizeT);
        resizeT = setTimeout(function () {
            resizeCanvas();
            if (window.kdTracker && window.kdTracker.clampPosition)
                window.kdTracker.clampPosition();
        }, 120);
    });
```

- [ ] **Step 4: Build.**

Run: `cd /home/kunaldawn/workspace/repos/kopyparty && docker compose build --no-cache && docker compose up -d`
Expected: build succeeds, container up.

- [ ] **Step 5: Verify with Playwright.** Navigate to a folder with a tracker module, play it, open the viz, go fullscreen, drag the tracker to the bottom-right corner, exit fullscreen, assert the tracker is inside the panel.

```js
await mcp__playwright__browser_navigate({ url: "http://127.0.0.1:8282/<tracker-folder>/" });
// play the module + open viz via UI clicks, then:
const r = await mcp__playwright__browser_evaluate({ function: `() => {
  const t = document.getElementById('kd-tracker').getBoundingClientRect();
  const p = document.getElementById('kd-viz-panel').getBoundingClientRect();
  return { inside: t.left >= p.left-1 && t.top >= p.top-1 && t.right <= p.right+1 && t.bottom <= p.bottom+1 };
}`});
```
Expected: `{ inside: true }` after exiting fullscreen from a far-corner drag.

- [ ] **Step 6: Commit.**

```bash
git add kopyparty/web/kd-tracker.js kopyparty/web/kd-visualizer.js
git commit -m "fix(tracker): clamp tracker back into viewport after fullscreen exit"
```

---

## Task 2: Large visualizer mode (windowed → large → fullscreen)

**Files:**
- Modify: `kopyparty/web/kd-visualizer.js` (button HTML ~line 191; `on(...)` bindings ~line 222; new `toggleLarge`/occupy helpers; keydown ~line 764; Escape stepping in `closePanel` path)
- Modify: `kopyparty/web/kd-theme.css` (`:root` var ~line 99 block; `.kd-viz-large` rule near the panel rules ~line 1164; `#wrap` reservation ~line 405; ctrl button styling reuses existing `#kd-viz-ctrl a`)

- [ ] **Step 1: Add the large-mode SVG + button in `kd-visualizer.js`.**

Near the other SVG consts (~line 25) add:

```js
    var SVG_LARGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><path d="M8 3H5a2 2 0 0 0-2 2v3 M16 3h3a2 2 0 0 1 2 2v3 M8 21H5a2 2 0 0 1-2-2v-3 M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
```

In `buildPanel()` find the controls block (~line 191) and insert the large button between `#kd-viz-next` and `#kd-viz-fs`:

```js
                '<a href="#" id="kd-viz-next" title="next preset (right arrow)">' + SVG_NEXT + '</a>' +
                '<a href="#" id="kd-viz-large" title="larger view (L)">' + SVG_LARGE + '</a>' +
                '<a href="#" id="kd-viz-fs" title="fullscreen (F)">' + SVG_FS + '</a>' +
```

- [ ] **Step 2: Add the toggle + occupy helpers and bind the button.**

In `buildPanel()` where the `on(...)` bindings are (~line 222) add after the `kd-viz-fs` binding:

```js
        on('kd-viz-large', toggleLarge);
```

Add these functions (place them near `toggleFullscreen`, ~line 706):

```js
    function isLarge() {
        return !!(panel && panel.classList.contains('kd-viz-large'));
    }

    // Publish how much vertical space the panel occupies so the file
    // browser can reserve room above it (keeps grid items clickable).
    // 0 in windowed mode -> layout unchanged.
    function updateOccupy() {
        var px = (isLarge() && isOpen() && !document.fullscreenElement)
            ? (panel.offsetHeight + 'px') : '0px';
        try { document.documentElement.style.setProperty('--kd-viz-occupy', px); } catch (e) {}
    }

    function setLarge(on) {
        if (!panel) return;
        panel.classList.toggle('kd-viz-large', !!on);
        updateLargeButtonState();
        // wait for the height transition, then resize the GL canvas, publish
        // the new occupy height, and re-clamp the tracker into the panel.
        setTimeout(function () {
            resizeCanvas();
            updateOccupy();
            if (window.kdTracker && window.kdTracker.clampPosition)
                window.kdTracker.clampPosition();
        }, 340);
    }

    function toggleLarge() { setLarge(!isLarge()); }

    function updateLargeButtonState() {
        var btn = document.getElementById('kd-viz-large');
        if (!btn) return;
        if (isLarge()) btn.classList.add('on');
        else btn.classList.remove('on');
    }
```

- [ ] **Step 3: Reset occupy when the panel closes, and update it on open.**

In `closePanel()` (~line 688) add, after `panel.classList.remove('kd-viz-open')`:

```js
        if (panel) panel.classList.remove('kd-viz-large');
        updateLargeButtonState();
        updateOccupy();
```

In `openPanel()` inside the `loadDeps().then(...)` block, after `panel.classList.add('kd-viz-open');` add:

```js
            updateLargeButtonState();
            updateOccupy();
```

- [ ] **Step 4: Make `F` exit large first via existing fullscreenchange occupy reset, and add `L` + Escape stepping in the keydown handler.**

Find the keydown handler (~line 764):

```js
    document.addEventListener('keydown', function (e) {
        if (!isOpen()) return;
        if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName)) return;
        if (e.key === 'Escape') closePanel();
        else if (e.key === 'ArrowLeft') stepPreset(-1);
        else if (e.key === 'ArrowRight') stepPreset(1);
        else if (e.key === 'r' || e.key === 'R') randomPreset();
        else if (e.key === 'a' || e.key === 'A') setAutoCycle(!autoCycle);
        else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    });
```

Replace the `Escape` branch and add an `L` branch (Escape steps down a level instead of always closing):

```js
    document.addEventListener('keydown', function (e) {
        if (!isOpen()) return;
        if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName)) return;
        if (e.key === 'Escape') {
            // step down one level: fullscreen -> large -> windowed -> closed
            if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e2) {} }
            else if (isLarge()) setLarge(false);
            else closePanel();
        }
        else if (e.key === 'ArrowLeft') stepPreset(-1);
        else if (e.key === 'ArrowRight') stepPreset(1);
        else if (e.key === 'r' || e.key === 'R') randomPreset();
        else if (e.key === 'a' || e.key === 'A') setAutoCycle(!autoCycle);
        else if (e.key === 'l' || e.key === 'L') toggleLarge();
        else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    });
```

- [ ] **Step 5: Update `onFullscreenChange` to refresh occupy** (entering fullscreen must zero the reservation; exiting large+fs must restore it). In `kd-visualizer.js` `onFullscreenChange` (modified in Task 1), add `updateOccupy();` before the `setTimeout`:

```js
    function onFullscreenChange() {
        var fs = document.fullscreenElement || document.webkitFullscreenElement;
        if (fs && panel && fs === panel) moveWidgetIntoPanel();
        else restoreWidget();
        updateOccupy();
        setTimeout(function () {
            if (window.kdTracker && window.kdTracker.clampPosition)
                window.kdTracker.clampPosition();
            updateOccupy();
        }, 60);
    }
```

- [ ] **Step 6: Add CSS — the occupy var, the large panel height, and the `#wrap` reservation.**

In `kd-theme.css`, inside the `:root`/variables block (near line 112, after `--kd-gap`) add:

```css
    /* vertical space the viz panel steals from the file browser in large
       mode; 0 otherwise so normal layout is unchanged. JS keeps it live. */
    --kd-viz-occupy: 0px;
```

Add a large-mode height rule immediately AFTER the existing `#ht_brw #kd-viz-panel.kd-viz-open` rule (~line 1167):

```css
/* "large" mode — a tall fixed panel (not OS fullscreen). Anchored above
   the widget exactly like windowed mode; just much taller. The widget
   stays at the bottom and is NOT moved into the panel (that is fullscreen
   only). The file-browser reservation below keeps grid items clickable. */
#ht_brw #kd-viz-panel.kd-viz-large.kd-viz-open {
    height: calc(100vh - var(--kd-header-h) - var(--kd-footer-h)
                 - var(--kd-widget-h) - 5 * var(--kd-gap)) !important;
}
```

Extend the file-browser bottom reservation (~line 405):

```css
html#ht_brw.np_open #wrap {
    margin-bottom: calc(2 * var(--kd-gap) + var(--kd-widget-h) + var(--kd-viz-occupy)) !important;
}
```

> Note: `--kd-header-h` is referenced by existing rules (e.g. line 716) so it is defined in the variables block; reuse it as-is.

- [ ] **Step 7: Build.**

Run: `cd /home/kunaldawn/workspace/repos/kopyparty && docker compose build --no-cache && docker compose up -d`
Expected: success.

- [ ] **Step 8: Verify with Playwright** — large mode grows the panel and the last grid item stays above it (clickable).

```js
// with a track playing and the viz open, click #kd-viz-large, then:
const r = await mcp__playwright__browser_evaluate({ function: `() => {
  const p = document.getElementById('kd-viz-panel').getBoundingClientRect();
  const cards = document.querySelectorAll('#ggrid > a');
  const last = cards[cards.length-1].getBoundingClientRect();
  const vh = window.innerHeight;
  return { panelTall: p.height > vh*0.6, lastCardAbovePanel: last.bottom <= p.top + 1,
           occupy: getComputedStyle(document.documentElement).getPropertyValue('--kd-viz-occupy').trim() };
}`});
```
Expected: `panelTall: true`, `lastCardAbovePanel: true`, `occupy` ≈ panel height in px. Then toggle off and confirm `occupy` is `0px` and layout reverts.

- [ ] **Step 9: Commit.**

```bash
git add kopyparty/web/kd-visualizer.js kopyparty/web/kd-theme.css
git commit -m "feat(viz): add large (maximized in-tab) visualizer mode"
```

---

## Task 3: Preset pill — fixed width + marquee for long names

**Files:**
- Modify: `kopyparty/web/kd-visualizer.js` (`buildPanel()` info-pill HTML ~line 177; `applyPreset.setName` ~line 335)
- Modify: `kopyparty/web/kd-theme.css` (`#kd-viz-info` ~line 1217; new marquee rules)

- [ ] **Step 1: Wrap the name in an inner span** so the pill can clip and the inner element can translate. In `buildPanel()` find (~line 177):

```js
            '<a href="#" id="kd-viz-info" title="click to search presets"><span id="kd-viz-name">…</span></a>' +
```

Replace with:

```js
            '<a href="#" id="kd-viz-info" title="click to search presets"><span id="kd-viz-name"><span class="kd-viz-name-inner">…</span></span></a>' +
```

- [ ] **Step 2: Update `nameEl` resolution and `setName` to use the inner span + marquee detection.**

Find (~line 216): `nameEl = document.getElementById('kd-viz-name');`
Leave it; add right after it:

```js
        nameInnerEl = panel.querySelector('.kd-viz-name-inner');
```

Declare `nameInnerEl` next to the other module vars near the top (~line 35, beside `var nameEl = null;`):

```js
    var nameInnerEl = null;
```

Replace the `setName` closure inside `applyPreset` (~line 335):

```js
        var setName = function () {
            if (!nameEl) return;
            var pretty = key.replace(/^[^-]+ - /, '');
            nameEl.textContent = pretty.length > 70 ? pretty.slice(0, 67) + '…' : pretty;
        };
```

with (full text, no truncation; marquee only when it overflows):

```js
        var setName = function () {
            var target = nameInnerEl || nameEl;
            if (!target) return;
            var pretty = key.replace(/^[^-]+ - /, '');
            target.textContent = pretty;
            // toggle marquee when the text overflows the fixed-width pill.
            // measure after the text is in the DOM.
            if (nameInnerEl && nameEl) {
                nameEl.classList.remove('marquee');
                var overflow = nameInnerEl.scrollWidth - nameEl.clientWidth;
                if (overflow > 2) {
                    // distance + duration scale with overflow (~60px/s)
                    nameEl.style.setProperty('--kd-marquee-dx', (-overflow - 8) + 'px');
                    nameEl.style.setProperty('--kd-marquee-dur', Math.max(4, (overflow + 8) / 60 * 2) + 's');
                    nameEl.classList.add('marquee');
                }
            }
        };
```

- [ ] **Step 3: CSS — fixed pill width + clip + marquee keyframes.** In `kd-theme.css` modify `#ht_brw #kd-viz-info` (~line 1217): change `max-width: calc(50% - 24px);` to a fixed width and ensure clipping happens on the inner element:

```css
#ht_brw #kd-viz-info {
    position: absolute;
    top: 10px;
    right: 12px;
    left: auto;
    width: min(360px, calc(100% - 24px));
    box-sizing: border-box;
    padding: 4px 10px;
    background: rgba(7, 24, 35, 0.35);
    border: 1px solid rgba(0, 255, 150, 0.25);
    border-radius: 6px;
    color: var(--a);
    font-family: var(--font-mono);
    font-size: 0.78em;
    letter-spacing: 0.04em;
    text-shadow: 0 0 6px rgba(0, 255, 150, 0.4);
    text-decoration: none;
    cursor: pointer;
    overflow: hidden;
    white-space: nowrap;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    z-index: 4;
    transition: background .15s ease, border-color .15s ease, box-shadow .15s ease;
    display: flex;
    align-items: center;
}
```

(Removed `max-width` and `text-overflow: ellipsis`; added fixed `width`, `box-sizing`, `display:flex`.)

Add new rules immediately after the `#kd-viz-info:after` rule (~line 1251):

```css
/* preset-name clip + marquee. The inner span holds the full text; when it
   overflows the fixed-width pill it ping-pong scrolls, paused on hover. */
#ht_brw #kd-viz-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    display: block;
}
#ht_brw #kd-viz-name .kd-viz-name-inner {
    display: inline-block;
    white-space: nowrap;
    will-change: transform;
}
#ht_brw #kd-viz-name.marquee .kd-viz-name-inner {
    animation: kd-viz-marquee var(--kd-marquee-dur, 8s) ease-in-out infinite alternate;
}
#ht_brw #kd-viz-info:hover #kd-viz-name.marquee .kd-viz-name-inner {
    animation-play-state: paused;
}
@keyframes kd-viz-marquee {
    0%   { transform: translateX(0); }
    100% { transform: translateX(var(--kd-marquee-dx, 0)); }
}
```

- [ ] **Step 4: Build.** `cd /home/kunaldawn/workspace/repos/kopyparty && docker compose build --no-cache && docker compose up -d`

- [ ] **Step 5: Verify** — pill width is constant across presets; a long name marquees.

```js
const r = await mcp__playwright__browser_evaluate({ function: `() => {
  const info = document.getElementById('kd-viz-info');
  const inner = document.querySelector('#kd-viz-name .kd-viz-name-inner');
  const name = document.getElementById('kd-viz-name');
  return { pillW: info.getBoundingClientRect().width,
           overflowing: inner.scrollWidth - name.clientWidth,
           marquee: name.classList.contains('marquee') };
}`});
```
Expected: `pillW` identical after stepping presets (e.g. ArrowRight a few times — re-measure each time); for a long preset name `overflowing > 0` and `marquee: true`.

- [ ] **Step 6: Commit.**

```bash
git add kopyparty/web/kd-visualizer.js kopyparty/web/kd-theme.css
git commit -m "feat(viz): fixed-width preset pill with marquee for long names"
```

---

## Task 4: Preset dropdown — infinite scroll (remove 200-row cap)

**Files:**
- Modify: `kopyparty/web/kd-visualizer.js` (`buildSearchList` ~line 451; `openSearch` ~line 491; add module vars + an IntersectionObserver)

- [ ] **Step 1: Add paging state vars** near the other dropdown-related module vars (top of IIFE, ~line 151 beside `weeklyCache`):

```js
    var searchMatched = [];     // current filtered key list
    var searchRendered = 0;     // how many rows appended so far
    var searchObserver = null;  // IntersectionObserver for the sentinel
    var SEARCH_PAGE = 60;       // rows appended per page
```

- [ ] **Step 2: Replace `buildSearchList` with a paged renderer.** Find the whole function (~line 451-489) and replace it:

```js
    function makeSearchRow(key) {
        var li = document.createElement('li');
        li.textContent = key.replace(/^[^-]+ - /, '');
        li.title = key;
        var globalIdx = presetKeys.indexOf(key);
        li.dataset.idx = globalIdx;
        if (globalIdx === presetIdx) li.className = 'current';
        li.addEventListener('click', function () {
            var idx = parseInt(this.dataset.idx, 10);
            if (isNaN(idx) || idx < 0) return;
            presetIdx = idx;
            applyPreset();
            scheduleAutoCycle(true);
            closeSearch();
        });
        return li;
    }

    function appendSearchPage() {
        var list = document.getElementById('kd-viz-search-list');
        if (!list) return;
        var sentinel = list.querySelector('.kd-viz-more-sentinel');
        var frag = document.createDocumentFragment();
        var end = Math.min(searchMatched.length, searchRendered + SEARCH_PAGE);
        for (var i = searchRendered; i < end; i++) frag.appendChild(makeSearchRow(searchMatched[i]));
        searchRendered = end;
        if (sentinel) list.insertBefore(frag, sentinel);
        else list.appendChild(frag);
        // when fully rendered, drop the sentinel + observer
        if (searchRendered >= searchMatched.length) {
            if (searchObserver) { searchObserver.disconnect(); searchObserver = null; }
            if (sentinel) sentinel.remove();
        }
    }

    function buildSearchList(filter) {
        var list = document.getElementById('kd-viz-search-list');
        if (!list || !presetKeys) return;
        list.innerHTML = '';
        if (searchObserver) { searchObserver.disconnect(); searchObserver = null; }
        var f = (filter || '').toLowerCase().trim();
        searchMatched = f
            ? presetKeys.filter(function (k) { return k.toLowerCase().indexOf(f) >= 0; })
            : presetKeys;
        searchRendered = 0;
        // sentinel row observed to trigger the next page
        var sentinel = document.createElement('li');
        sentinel.className = 'kd-viz-more-sentinel';
        list.appendChild(sentinel);
        appendSearchPage();
        if (searchRendered < searchMatched.length && window.IntersectionObserver) {
            searchObserver = new IntersectionObserver(function (entries) {
                for (var i = 0; i < entries.length; i++) {
                    if (entries[i].isIntersecting) { appendSearchPage(); break; }
                }
            }, { root: list, rootMargin: '120px' });
            searchObserver.observe(sentinel);
        }
    }
```

- [ ] **Step 3: Disconnect the observer on close.** In `closeSearch` (~line 505):

```js
    function closeSearch() {
        var s = document.getElementById('kd-viz-search');
        if (s) s.classList.remove('open');
        if (searchObserver) { searchObserver.disconnect(); searchObserver = null; }
    }
```

- [ ] **Step 4: CSS — give the sentinel zero height so it doesn't show as a blank row.** In `kd-theme.css` after the `li.more` rule (~line 1320) add:

```css
#ht_brw #kd-viz-search-list li.kd-viz-more-sentinel {
    height: 1px;
    padding: 0;
    border: none;
    pointer-events: none;
    list-style: none;
}
```

(The old `li.more` rule can stay; it is simply no longer produced.)

- [ ] **Step 5: Build.** `cd /home/kunaldawn/workspace/repos/kopyparty && docker compose build --no-cache && docker compose up -d`

- [ ] **Step 6: Verify** — scrolling the dropdown grows the list past the old 200 cap.

```js
// open the dropdown (click #kd-viz-info), then scroll the list to bottom repeatedly:
const r = await mcp__playwright__browser_evaluate({ function: `async () => {
  const list = document.getElementById('kd-viz-search-list');
  let last = 0;
  for (let i=0;i<8;i++){ list.scrollTop = list.scrollHeight; await new Promise(r=>setTimeout(r,80)); }
  return { rows: list.querySelectorAll('li:not(.kd-viz-more-sentinel)').length };
}`});
```
Expected: `rows > 200` (full local list is ~950; depends on how far it scrolled — should clearly exceed 200).

- [ ] **Step 7: Commit.**

```bash
git add kopyparty/web/kd-visualizer.js kopyparty/web/kd-theme.css
git commit -m "feat(viz): infinite-scroll preset dropdown (drop 200-row cap)"
```

---

## Task 5: Tracker width adapts to channel count

**Files:**
- Modify: `kopyparty/web/kd-tracker.js` (`rebuildTape` ~line 400 — add a width recompute; new `applyTrackerWidth()`; call from the ResizeObserver ~line 169)
- Modify: `kopyparty/web/kd-theme.css` (`#kd-viz-panel #kd-tracker` width ~line 1430; body `overflow-x`; scrollbar styling)

- [ ] **Step 1: Add `applyTrackerWidth()` to `kd-tracker.js`.** Place it after `applyBodyPadding` (~line 442). It reads the per-cell width from the rendered DOM (robust against the desktop/mobile font-size difference) and sizes the panel:

```js
    // Size the tracker to its channel count: content width when it fits,
    // capped at the available panel width (with a horizontal scrollbar)
    // when there are too many channels. Adds .kd-tracker-fits when no
    // horizontal scroll is needed so CSS can hide the scrollbar.
    function applyTrackerWidth() {
        if (!panel || !bodyEl || !activeChans) return;
        var viz = document.getElementById('kd-viz-panel');
        if (!viz) return;
        // measure a rendered row's natural width (rowidx + all cells).
        var firstRow = bodyEl.querySelector('.row');
        var content = firstRow ? firstRow.scrollWidth : 0;
        // panel chrome: the body sits flush; add the tracker's own L/R border.
        var cs = window.getComputedStyle(panel);
        var chrome = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
        var desired = content + chrome + 2; // +2 safety
        // available width inside the viz panel, leaving the same 12px side
        // inset the CSS uses, on both sides.
        var avail = viz.clientWidth - 24;
        var w = Math.min(desired, avail);
        if (w > 0) panel.style.width = Math.floor(w) + 'px';
        var fits = desired <= avail + 1;
        panel.classList.toggle('kd-tracker-fits', fits);
    }
```

- [ ] **Step 2: Call it at the end of `rebuildTape`.** Find the end of `rebuildTape` (~line 424):

```js
        panel.style.setProperty('--kd-tracker-chans', activeChans.length);
        applyBodyPadding();
    }
```

Replace with:

```js
        panel.style.setProperty('--kd-tracker-chans', activeChans.length);
        applyBodyPadding();
        applyTrackerWidth();
    }
```

- [ ] **Step 3: Recompute width on panel resize.** In `buildPanel()` find the ResizeObserver (~line 168):

```js
        if (window.ResizeObserver) {
            var ro = new ResizeObserver(function () {
                prevTapePad = -1;
                applyBodyPadding();
            });
            ro.observe(bodyEl);
        }
```

Replace with (also observe the viz panel so width tracks available space):

```js
        if (window.ResizeObserver) {
            var ro = new ResizeObserver(function () {
                prevTapePad = -1;
                applyBodyPadding();
                applyTrackerWidth();
            });
            ro.observe(bodyEl);
            var vizEl = document.getElementById('kd-viz-panel');
            if (vizEl) ro.observe(vizEl);
        }
```

- [ ] **Step 4: CSS — let width be JS-driven and gate horizontal scroll.** In `kd-theme.css` modify `#ht_brw #kd-viz-panel #kd-tracker` (~line 1426): change the fixed `width: min(640px, ...)` to a max-width guard (JS sets the actual width):

Find:
```css
    width: min(640px, calc(100% - 24px));
    height: min(180px, calc(100% - 140px));
```
Replace with:
```css
    width: min(640px, calc(100% - 24px));   /* initial; JS overrides via style.width */
    max-width: calc(100% - 24px);
    height: min(180px, calc(100% - 140px));
```

Add, after the body rule block (~line 1590, after the `::-webkit-scrollbar { display:none }` rule), a gate so the scrollbar shows only when NOT fitting:

```css
/* horizontal scroll only when channels overflow the panel width.
   .kd-tracker-fits (set by JS) means content fits -> no scrollbar. */
#ht_brw #kd-tracker.kd-tracker-fits .kd-tracker-body {
    overflow-x: hidden;
}
#ht_brw #kd-tracker:not(.kd-tracker-fits) .kd-tracker-body {
    overflow-x: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(0,255,150,0.4) transparent;
}
#ht_brw #kd-tracker:not(.kd-tracker-fits) .kd-tracker-body::-webkit-scrollbar {
    display: block;
    height: 6px;
}
#ht_brw #kd-tracker:not(.kd-tracker-fits) .kd-tracker-body::-webkit-scrollbar-thumb {
    background: rgba(0,255,150,0.4);
    border-radius: 3px;
}
```

> Note: the existing rule `.kd-tracker-body::-webkit-scrollbar { display: none }` (vertical) still hides the vertical scrollbar; the `:not(.kd-tracker-fits)` rule re-enables only the horizontal one. Both coexist because the second rule is more specific.

- [ ] **Step 5: Build.** `cd /home/kunaldawn/workspace/repos/kopyparty && docker compose build --no-cache && docker compose up -d`

- [ ] **Step 6: Verify** — wide module caps + scrolls; narrow module fits without scrollbar.

```js
// play a module with many channels (e.g. a .it/.xm with 12+), open viz, then:
const wide = await mcp__playwright__browser_evaluate({ function: `() => {
  const b = document.querySelector('#kd-tracker .kd-tracker-body');
  const t = document.getElementById('kd-tracker');
  return { overflows: b.scrollWidth > b.clientWidth + 1, fits: t.classList.contains('kd-tracker-fits') };
}`});
// expected for wide module: { overflows: true, fits: false }
// then play a <=6 channel module and re-check: { overflows: false, fits: true }
```

- [ ] **Step 7: Commit.**

```bash
git add kopyparty/web/kd-tracker.js kopyparty/web/kd-theme.css
git commit -m "feat(tracker): width adapts to channel count, scrollbar only when needed"
```

---

## Task 6: Furnace-style status bar

**Files:**
- Modify: `kopyparty/web/kd-tracker.js` (`buildPanel()` innerHTML ~line 149; new `getMeta`/`withCStr` helpers; per-track cache vars; `updateStatus()`; call from `tick()` ~line 516; reset in `hidePanel` ~line 196)
- Modify: `kopyparty/web/kd-theme.css` (new `.kd-tracker-status` rules)

- [ ] **Step 1: Add the status element to the panel HTML.** In `buildPanel()` (~line 149) change:

```js
        panel.innerHTML =
            '<div class="kd-tracker-head">' +
                '<span class="kd-tracker-title">tracker</span>' +
                '<a href="#" class="kd-tracker-toggle" title="minimize / restore">−</a>' +
            '</div>' +
            '<div class="kd-tracker-cols"></div>' +
            '<div class="kd-tracker-body"></div>';
```

to (add a status strip after the body):

```js
        panel.innerHTML =
            '<div class="kd-tracker-head">' +
                '<span class="kd-tracker-title">tracker</span>' +
                '<a href="#" class="kd-tracker-toggle" title="minimize / restore">−</a>' +
            '</div>' +
            '<div class="kd-tracker-cols"></div>' +
            '<div class="kd-tracker-body"></div>' +
            '<div class="kd-tracker-status">' +
                '<span class="kd-st-bpm">--</span>' +
                '<span class="kd-st-speed">--</span>' +
                '<span class="kd-st-pos">--</span>' +
                '<span class="kd-st-chans">--</span>' +
                '<span class="kd-st-counts">--</span>' +
                '<span class="kd-st-fmt">--</span>' +
                '<span class="kd-st-time">--</span>' +
            '</div>';
```

- [ ] **Step 2: Add C-string + metadata helpers** near `rdStr` (~line 99):

```js
    // write an ASCII JS string into the heap as a NUL-terminated C string,
    // run fn(ptr), then free. Used to pass keys to get_metadata.
    function withCStr(s, fn) {
        var L = window.libopenmpt;
        var ptr = L._malloc(s.length + 1);
        for (var i = 0; i < s.length; i++) L.HEAPU8[ptr + i] = s.charCodeAt(i) & 0x7f;
        L.HEAPU8[ptr + s.length] = 0;
        try { return fn(ptr); } finally { L._free(ptr); }
    }
    function getMeta(mp, key) {
        try {
            return withCStr(key, function (keyPtr) {
                var p = libopenmpt._openmpt_module_get_metadata(mp, keyPtr);
                var s = rdStr(p);
                if (libopenmpt._openmpt_free_string) libopenmpt._openmpt_free_string(p);
                return (s || '').replace(/^\s+|\s+$/g, '');
            });
        } catch (e) { return ''; }
    }
```

- [ ] **Step 3: Add per-track cache vars** beside the other state vars (~line 65):

```js
    // per-track cached status fields (recomputed on track change)
    var stFmt = '';
    var stDur = 0;
    var stNumChans = 0;
    var stNumIns = 0;
    var stNumSmp = 0;
    var stCached = false;
```

- [ ] **Step 4: Add `updateStatus()`** after `highlightRow` (~line 466):

```js
    function fmtMS(s) {
        if (!isFinite(s) || s < 0) s = 0;
        var m = Math.floor(s / 60), ss = Math.floor(s % 60);
        return m + ':' + (ss < 10 ? '0' : '') + ss;
    }
    function setSt(cls, txt) {
        var el = panel.querySelector('.' + cls);
        if (el && el.textContent !== txt) el.textContent = txt;
    }
    function cacheTrackStatus(mp) {
        stNumChans = libopenmpt._openmpt_module_get_num_channels(mp) || 0;
        stNumIns = libopenmpt._openmpt_module_get_num_instruments
            ? (libopenmpt._openmpt_module_get_num_instruments(mp) || 0) : 0;
        stNumSmp = libopenmpt._openmpt_module_get_num_samples
            ? (libopenmpt._openmpt_module_get_num_samples(mp) || 0) : 0;
        stDur = libopenmpt._openmpt_module_get_duration_seconds
            ? (libopenmpt._openmpt_module_get_duration_seconds(mp) || 0) : 0;
        stFmt = getMeta(mp, 'type_long') || getMeta(mp, 'type') || 'module';
        stCached = true;
    }
    function updateStatus(mp, curOrd, curRow) {
        if (!panel) return;
        if (!stCached) cacheTrackStatus(mp);
        var bpm = libopenmpt._openmpt_module_get_current_tempo(mp);
        var spd = libopenmpt._openmpt_module_get_current_speed(mp);
        var curPat = libopenmpt._openmpt_module_get_current_pattern(mp);
        var nrows = libopenmpt._openmpt_module_get_pattern_num_rows(mp, curPat);
        var nords = libopenmpt._openmpt_module_get_num_orders(mp);
        var playing = libopenmpt._openmpt_module_get_current_playing_channels
            ? libopenmpt._openmpt_module_get_current_playing_channels(mp) : 0;
        var pos = libopenmpt._openmpt_module_get_position_seconds
            ? libopenmpt._openmpt_module_get_position_seconds(mp) : 0;
        var hx = function (v) { return ('0' + (v & 0xFF).toString(16).toUpperCase()).slice(-2); };
        setSt('kd-st-bpm', 'BPM ' + bpm);
        setSt('kd-st-speed', 'SPD ' + spd);
        setSt('kd-st-pos', 'Ord ' + curOrd + '/' + (nords - 1) + ' · Pat ' + curPat + ' · Row ' + hx(curRow) + '/' + hx(nrows));
        setSt('kd-st-chans', 'Ch ' + playing + '/' + stNumChans);
        setSt('kd-st-counts', 'Ins ' + stNumIns + ' · Smp ' + stNumSmp);
        setSt('kd-st-fmt', stFmt);
        setSt('kd-st-time', fmtMS(pos) + ' / ' + fmtMS(stDur));
    }
```

- [ ] **Step 5: Call it from `tick()` and invalidate the cache on track change.** In `tick()` find the track-change reset (~line 504):

```js
        if (mp !== prevModPtr || curTid !== prevTid) {
            prevModPtr = mp;
            prevTid = curTid;
            tapeOrd = -1;
            activeChans = null;
        }
```

Add the cache invalidation:

```js
        if (mp !== prevModPtr || curTid !== prevTid) {
            prevModPtr = mp;
            prevTid = curTid;
            tapeOrd = -1;
            activeChans = null;
            stCached = false;
        }
```

Then at the end of `tick()` (after the `highlightRow` block, ~line 518) add:

```js
        updateStatus(mp, curOrd, curRow);
```

- [ ] **Step 6: Reset cache in `hidePanel`** (~line 196), add inside it:

```js
        stCached = false;
```

- [ ] **Step 7: CSS — status strip.** In `kd-theme.css` add after the cell-color rules (~line 1683, before the mobile `@media` block):

```css
/* Furnace-style status bar pinned to the bottom of the tracker panel */
#ht_brw #kd-tracker .kd-tracker-status {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    align-items: center;
    padding: 3px 8px;
    border-top: 1px solid rgba(0, 255, 150, 0.18);
    background: rgba(0, 0, 0, 0.32);
    font-family: var(--font-mono);
    font-size: 0.62em;
    letter-spacing: 0.04em;
    color: var(--a);
    text-transform: uppercase;
    white-space: nowrap;
    overflow: hidden;
}
#ht_brw #kd-tracker .kd-tracker-status > span {
    opacity: 0.92;
}
#ht_brw #kd-tracker .kd-tracker-status .kd-st-fmt {
    color: var(--fg-weak);
    opacity: 0.7;
}
#ht_brw #kd-tracker.kd-tracker-collapsed .kd-tracker-status {
    display: none;
}
@media (max-width: 760px) {
    #ht_brw #kd-tracker .kd-tracker-status { font-size: 0.56em; gap: 1px 6px; }
    #ht_brw #kd-tracker .kd-tracker-status .kd-st-counts { display: none; }
}
```

- [ ] **Step 8: Build.** `cd /home/kunaldawn/workspace/repos/kopyparty && docker compose build --no-cache && docker compose up -d`

- [ ] **Step 9: Verify** — fields populate during playback.

```js
const r = await mcp__playwright__browser_evaluate({ function: `() => {
  const q = c => (document.querySelector('#kd-tracker .'+c)||{}).textContent;
  return { bpm:q('kd-st-bpm'), spd:q('kd-st-speed'), pos:q('kd-st-pos'),
           chans:q('kd-st-chans'), counts:q('kd-st-counts'), fmt:q('kd-st-fmt'), time:q('kd-st-time') };
}`});
```
Expected: `bpm` like `BPM 125`, `spd` like `SPD 6`, `pos` like `Ord 0/12 · Pat 0 · Row 05/40`, `chans` `Ch n/m`, `fmt` non-empty (e.g. `Impulse Tracker`), `time` like `0:07 / 2:31`. Re-sample after ~1s and confirm `pos`/`time` advanced.

- [ ] **Step 10: Commit.**

```bash
git add kopyparty/web/kd-tracker.js kopyparty/web/kd-theme.css
git commit -m "feat(tracker): Furnace-style status bar (bpm/speed/pos/chans/format/time)"
```

---

## Task 7: Per-channel VU meters

**Files:**
- Modify: `kopyparty/web/kd-tracker.js` (`buildHeader` ~line 390; new `updateVU()`; call from `tick()`; reset state on rebuild)
- Modify: `kopyparty/web/kd-theme.css` (header cell layout + `.kd-vu` rules)

- [ ] **Step 1: Render a VU element inside each header cell.** Replace `buildHeader` (~line 390):

```js
    function buildHeader(mp, chans) {
        var h = '<span class="rowidx">  </span>';
        for (var ci = 0; ci < chans.length; ci++) {
            h += '<span class="cell" title="' + esc(channelLabel(mp, chans[ci])) + '">' +
                 '<span class="kd-ch-name">' + channelLabel(mp, chans[ci]) + '</span>' +
                 '<span class="kd-vu"><i class="kd-vu-fill"></i></span>' +
                 '</span>';
        }
        headEl.innerHTML = h;
        vuFills = headEl.querySelectorAll('.kd-vu-fill');
        vuLevels = new Float32Array(chans.length);
    }
```

- [ ] **Step 2: Add VU state vars** beside the other state (~line 65):

```js
    var vuFills = null;          // NodeList of .kd-vu-fill, one per channel
    var vuLevels = null;         // smoothed displayed levels (Float32Array)
```

- [ ] **Step 3: Add `updateVU()`** after `updateStatus` (added in Task 6):

```js
    // Per-channel VU bars (horizontal fill under each channel name). Uses
    // libopenmpt's per-channel VU; eased toward the target so it doesn't
    // strobe. Cheap: one FFI pair per active channel per tick.
    function updateVU(mp) {
        if (!vuFills || !vuLevels || !activeChans) return;
        for (var k = 0; k < activeChans.length && k < vuFills.length; k++) {
            var ch = activeChans[k];
            var l = libopenmpt._openmpt_module_get_current_channel_vu_left(mp, ch) || 0;
            var r = libopenmpt._openmpt_module_get_current_channel_vu_right(mp, ch) || 0;
            var target = Math.max(l, r);
            if (target > 1) target = 1; else if (target < 0) target = 0;
            // attack fast, release slow
            var cur = vuLevels[k];
            cur = target > cur ? target : cur + (target - cur) * 0.35;
            vuLevels[k] = cur;
            vuFills[k].style.width = (cur * 100).toFixed(1) + '%';
        }
    }
```

- [ ] **Step 4: Call from `tick()`** — add after the `updateStatus(...)` call:

```js
        updateVU(mp);
```

- [ ] **Step 5: Reset VU refs in `hidePanel`** (~line 196) add:

```js
        vuFills = null;
        vuLevels = null;
```

- [ ] **Step 6: CSS — header cell stacks name over VU, and the VU bar itself.** In `kd-theme.css` modify the header cell rule `#ht_brw #kd-tracker .kd-tracker-cols .cell` (~line 1555) to allow vertical stacking:

```css
#ht_brw #kd-tracker .kd-tracker-cols .cell {
    flex: 0 0 auto;
    width: 8.2em;            /* matches body cell width */
    display: flex;
    flex-direction: column;
    align-items: stretch;
    text-align: center;
    border-right: 1px solid rgba(0, 255, 150, 0.08);
    overflow: hidden;
    white-space: nowrap;
}
#ht_brw #kd-tracker .kd-tracker-cols .cell .kd-ch-name {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
#ht_brw #kd-tracker .kd-vu {
    display: block;
    height: 3px;
    margin: 1px 2px 0;
    background: rgba(0, 255, 150, 0.10);
    border-radius: 2px;
    overflow: hidden;
}
#ht_brw #kd-tracker .kd-vu .kd-vu-fill {
    display: block;
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, #008000, #00ff66 70%, #aaffcc);
    box-shadow: 0 0 4px rgba(0, 255, 120, 0.5);
}
```

(Mobile cell width override at line ~1706 still applies; the VU bar inherits the narrower cell.)

- [ ] **Step 7: Build.** `cd /home/kunaldawn/workspace/repos/kopyparty && docker compose build --no-cache && docker compose up -d`

- [ ] **Step 8: Verify** — fills animate during playback.

```js
const r = await mcp__playwright__browser_evaluate({ function: `async () => {
  const read = () => Array.from(document.querySelectorAll('#kd-tracker .kd-vu-fill')).map(e=>e.style.width);
  const a = read(); await new Promise(r=>setTimeout(r,400)); const b = read();
  return { count: a.length, changed: JSON.stringify(a) !== JSON.stringify(b) };
}`});
```
Expected: `count` = active channel count, `changed: true` (levels move).

- [ ] **Step 9: Commit.**

```bash
git add kopyparty/web/kd-tracker.js kopyparty/web/kd-theme.css
git commit -m "feat(tracker): per-channel VU meters under channel labels"
```

---

## Task 8: Master oscilloscope strip

**Files:**
- Modify: `kopyparty/web/kd-tracker.js` (panel HTML — add scope canvas above status; analyser connect helper; draw in `tick()`; reset on hide; `window.kdTracker.onAudioChanged`)
- Modify: `kopyparty/web/kd-theme.css` (`.kd-tracker-scope` rule)

- [ ] **Step 1: Add the scope canvas to the panel HTML.** In `buildPanel()` insert the canvas BETWEEN the body and the status strip (from Task 6):

```js
            '<div class="kd-tracker-body"></div>' +
            '<canvas class="kd-tracker-scope"></canvas>' +
            '<div class="kd-tracker-status">' +
```

Resolve the canvas in `buildPanel()` after `bodyEl` is set (~line 158):

```js
        scopeCanvas = panel.querySelector('.kd-tracker-scope');
        scopeCtx = scopeCanvas ? scopeCanvas.getContext('2d') : null;
```

- [ ] **Step 2: Add scope state vars** beside the other state (~line 65):

```js
    var scopeCanvas = null;
    var scopeCtx = null;
    var scopeAnalyser = null;     // AnalyserNode on window.kdAudio.context
    var scopeBuf = null;          // Float32Array time-domain buffer
    var scopeSrc = null;          // the audio node currently tapped
```

- [ ] **Step 3: Add analyser connect + draw helpers** after `updateVU` (from Task 7):

```js
    // Lazily create one AnalyserNode on the shared context and tap whatever
    // source the visualizer is feeding (chiptune ScriptProcessor or the
    // MediaElementSource). Re-taps when the source changes. The analyser is
    // a passive sink, so it does not disturb the existing audio graph.
    function ensureScopeAnalyser() {
        var ctx = window.kdAudio && window.kdAudio.context;
        if (!ctx) return false;
        if (!scopeAnalyser) {
            try {
                scopeAnalyser = ctx.createAnalyser();
                scopeAnalyser.fftSize = 1024;
                scopeAnalyser.smoothingTimeConstant = 0;
                scopeBuf = new Float32Array(scopeAnalyser.fftSize);
            } catch (e) { scopeAnalyser = null; return false; }
        }
        // resolve the current source the same way kd-visualizer does
        var src = null;
        if (window.kdChiptune && window.kdChiptune.ChiptuneAudio
            && window.mp && window.mp.au instanceof window.kdChiptune.ChiptuneAudio) {
            var p = window.kdChiptune.getPlayer && window.kdChiptune.getPlayer();
            src = p && p.currentPlayingNode;
        } else if (window.mp && window.mp.au) {
            src = window.mp.au._kdSource;
        }
        if (src && src !== scopeSrc) {
            try { src.connect(scopeAnalyser); scopeSrc = src; }
            catch (e) { /* already connected or incompatible */ scopeSrc = src; }
        }
        return !!scopeAnalyser;
    }

    function sizeScopeCanvas() {
        if (!scopeCanvas) return;
        var r = scopeCanvas.getBoundingClientRect();
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var W = Math.max(2, Math.floor(r.width * dpr));
        var H = Math.max(2, Math.floor(r.height * dpr));
        if (scopeCanvas.width !== W || scopeCanvas.height !== H) {
            scopeCanvas.width = W; scopeCanvas.height = H;
        }
    }

    function drawScope() {
        if (!scopeCtx || !ensureScopeAnalyser()) return;
        sizeScopeCanvas();
        var W = scopeCanvas.width, H = scopeCanvas.height;
        if (W < 2 || H < 2) return;
        scopeAnalyser.getFloatTimeDomainData(scopeBuf);
        var ctx = scopeCtx;
        ctx.clearRect(0, 0, W, H);
        ctx.lineWidth = Math.max(1, H / 24);
        ctx.strokeStyle = '#00ff99';
        ctx.shadowColor = 'rgba(0,255,150,0.5)';
        ctx.shadowBlur = ctx.lineWidth * 1.5;
        ctx.beginPath();
        var n = scopeBuf.length, mid = H / 2;
        for (var i = 0; i < n; i++) {
            var x = (i / (n - 1)) * W;
            var y = mid - scopeBuf[i] * (mid - ctx.lineWidth);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
    }
```

- [ ] **Step 4: Call `drawScope()` from `tick()`** — add after `updateVU(mp);`:

```js
        drawScope();
```

- [ ] **Step 5: Reset scope source on hide + expose `onAudioChanged`.** In `hidePanel` (~line 196) add:

```js
        scopeSrc = null;
```

In `window.kdTracker` (~line 604) add a method so external code can force a re-tap (optional but cheap):

```js
        onAudioChanged: function () { scopeSrc = null; },
```

- [ ] **Step 6: CSS — scope strip.** In `kd-theme.css` add after the status-bar rules (Task 6):

```css
/* master oscilloscope strip, just above the status bar */
#ht_brw #kd-tracker .kd-tracker-scope {
    flex: 0 0 auto;
    display: block;
    width: 100%;
    height: 34px;
    background: rgba(0, 0, 0, 0.35);
    border-top: 1px solid rgba(0, 255, 150, 0.14);
}
#ht_brw #kd-tracker.kd-tracker-collapsed .kd-tracker-scope {
    display: none;
}
@media (max-width: 760px) {
    #ht_brw #kd-tracker .kd-tracker-scope { height: 24px; }
}
```

- [ ] **Step 7: Build.** `cd /home/kunaldawn/workspace/repos/kopyparty && docker compose build --no-cache && docker compose up -d`

- [ ] **Step 8: Verify** — scope is non-blank during playback for BOTH a tracker module and an mp3/ogg.

```js
const r = await mcp__playwright__browser_evaluate({ function: `() => {
  const c = document.querySelector('#kd-tracker .kd-tracker-scope');
  const cx = c.getContext('2d');
  const d = cx.getImageData(0,0,c.width,c.height).data;
  let nonzero = 0; for (let i=3;i<d.length;i+=4) if (d[i]>0) nonzero++;
  return { painted: nonzero > 0, w: c.width, h: c.height };
}`});
```
Expected (tracker playing): `painted: true`. Note: the master scope canvas lives in `#kd-tracker`, which is only visible while a *tracker module* plays — so the mp3/ogg path is exercised by confirming `ensureScopeAnalyser` taps `mp.au._kdSource` (no console errors) when switching; the visible scope requirement is satisfied for tracker playback. (If a visible scope for non-tracker audio is later desired, the canvas would need a home outside `#kd-tracker` — out of scope here.)

- [ ] **Step 9: Commit.**

```bash
git add kopyparty/web/kd-tracker.js kopyparty/web/kd-theme.css
git commit -m "feat(tracker): master oscilloscope strip above status bar"
```

---

## Task 9: Full regression audit + CLAUDE.md note

**Files:**
- Modify: `CLAUDE.md` (add a short subsection documenting the new tracker/viz features so future agents don't "remove features")

- [ ] **Step 1: Run the documented Playwright audit invariants** (from CLAUDE.md "Invariants the audit should confirm") against a folder with a tracker module + viz open:
  - `J_U2K === 2`
  - `tree.bottom < footer.top`, `widget.bottom <= footer.top`
  - 0 console errors except possibly `/favicon.ico 404`
  - `kd-theme.css` URL uses `/.kpr/w/`
  - Plus the new checks F1–F6 from the spec (Tasks 1–8 verify steps).

- [ ] **Step 2: Smoke-test removed/oddball routes still behave** (no regression to the read-only surface):

```bash
for u in '?qr' '?shares' '?idp' '?stack' '?reload=cfg' '?scan' '.kpr/metrics'; do
  curl -s -o /dev/null -w "GET  $u -> %{http_code}\n" "http://127.0.0.1:8282/$u"; done
```
Expected: 404s as documented (unchanged by this work).

- [ ] **Step 3: Document the features in `CLAUDE.md`.** Under "What's there now" add a brief subsection:

```markdown
### Tracker / visualizer extras (kd-tracker.js, kd-visualizer.js)

- Viz panel has three states: windowed → large (`.kd-viz-large`, an in-tab
  maximized overlay; publishes `--kd-viz-occupy` so `#wrap` reserves space and
  grid items stay clickable) → OS fullscreen. `L` toggles large; Escape steps
  down one level.
- Preset pill is fixed-width and marquees long names; the search dropdown is
  infinite-scroll over the full local list (no 200-row cap). All offline.
- Tracker box width adapts to channel count; horizontal scrollbar only when
  channels overflow (`.kd-tracker-fits` gates it). `kdTracker.clampPosition()`
  pulls a dragged tracker back into the panel after fullscreen exit / resize.
- Tracker has a Furnace-style status bar (BPM/speed/order/pattern/row/channels/
  counts/format/time via libopenmpt getters + get_metadata), per-channel VU
  meters (get_current_channel_vu_left/right), and a master oscilloscope
  (one AnalyserNode on window.kdAudio.context tapping the shared source).
  All read-only; no new deps; no network.
```

- [ ] **Step 4: Commit.**

```bash
git add CLAUDE.md
git commit -m "docs: document tracker/viz enhancements in CLAUDE.md"
```

---

## Self-Review

**Spec coverage:**
- Spec §1 (fullscreen clamp) → Task 1. ✓
- Spec §2 (large mode + occupy + overlap fix + Escape stepping) → Task 2. ✓
- Spec §3 (consistent pill width + marquee) → Task 3; (infinite scroll) → Task 4. ✓
- Spec §4 (channel-adaptive width + scrollbar-only-when-needed) → Task 5. ✓
- Spec §5 (status bar, all four field groups) → Task 6. ✓
- Spec §6a (per-channel VU, horizontal under label) → Task 7; §6b (master scope, dedicated strip above status) → Task 8. ✓
- Spec verification checklist → Task 9 + per-task verify steps. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**Type/name consistency:** `clampPosition`, `onAudioChanged` added once to `window.kdTracker` (Tasks 1, 8). Status field classes (`kd-st-*`) defined in Task 6 HTML and used by `setSt`/CSS. `applyTrackerWidth`, `.kd-tracker-fits` consistent (Task 5). `.kd-vu`/`.kd-vu-fill`/`vuFills`/`vuLevels` consistent (Task 7). `scopeCanvas`/`scopeCtx`/`scopeAnalyser`/`scopeBuf`/`scopeSrc`/`.kd-tracker-scope` consistent (Task 8). `--kd-viz-occupy` defined in `:root` (Task 2 CSS) and set in JS (`updateOccupy`, Task 2). ✓

**Ordering note:** Tasks 6 and 8 both touch the panel `innerHTML`; Task 8 Step 1 assumes Task 6's `.kd-tracker-status` line exists. Execute in order (6 before 8). The body→scope→status DOM order matches the spec (scope above status). ✓

// kd-visualizer.js — Milkdrop-style music visualizer for the player.
//
// Wraps butterchurn (the JavaScript port of Milkdrop, same library
// Webamp uses) in a slide-up panel anchored above the music widget.
// The panel hosts a webgl canvas that the audio output is fed to via
// the shared AudioContext exposed by kd-chiptune.js (window.kdAudio).
// Both browser-native audio (MediaElementSource off mp.au) and
// chiptune playback (ScriptProcessor from chiptune2) feed the same
// visualizer — switching tracks just rewires connectAudio.
//
// UI: a 🎨 toggle button is injected into #pctl. When pressed, the
// panel slides up between the file grid and the music widget. It
// shows the current preset name, prev / random / next preset buttons,
// a fullscreen toggle, and a close button. Render loop runs via rAF
// only while the panel is visible (free CPU when collapsed).

(function () {
    'use strict';

    var SVG_VIZ = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><path d="M3 13l2.5 0 1.5 -7 3 14 2.5 -10 1.5 5 1.5 -2 1.5 0 4 0"/></svg>';
    var SVG_PREV = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><polygon points="18,5 18,19 8,12"/></svg>';
    var SVG_NEXT = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><polygon points="6,5 6,19 16,12"/></svg>';
    var SVG_RAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><path d="M3 7l4 0 8 10 6 0 M3 17l4 0 4-5 M19 7l2 0 M19 17l2 0 M21 5l0 4 M21 15l0 4"/></svg>';
    var SVG_AUTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><path d="M21 12a9 9 0 1 1-3.5-7.1 M21 4v5h-5"/></svg>';
    var SVG_FS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5"/></svg>';
    var SVG_LARGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><path d="M8 3H5a2 2 0 0 0-2 2v3 M16 3h3a2 2 0 0 1 2 2v3 M8 21H5a2 2 0 0 1-2-2v-3 M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
    var SVG_CLOSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><polygon points="6,9 18,9 12,17"/></svg>';
    var SVG_VOL = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width:1em;height:1em;display:block"><polygon points="3,10 3,14 7,14 12,18 12,6 7,10"/><path d="M15.5 12 a3 3 0 0 0 -1.5 -2.6 v5.2 a3 3 0 0 0 1.5 -2.6 z M17.5 12 a5 5 0 0 0 -3.5 -4.8 v1.6 a3.5 3.5 0 0 1 0 6.4 v1.6 a5 5 0 0 0 3.5 -4.8 z"/></svg>';

    var depsLoaded = false;
    var depsLoading = null;

    var viz = null;
    var canvas = null;
    var panel = null;
    var nameEl = null;
    var nameInnerEl = null;
    var rafId = null;
    var presets = null;
    var presetKeys = null;
    var presetIdx = 0;
    var connectedSrc = null;

    // ---- render config (matches Webamp's butterchurn settings) -----------
    // Webamp runs Milkdrop at a solid 60fps fullscreen on a GPU with: full
    // devicePixelRatio, a 32×24 warp mesh, and an UNCAPPED render loop
    // (render() every rAF). So butterchurn's render cost was never the real
    // problem — the lag came from (1) backdrop-blur overlays sitting over the
    // animating canvas (see "PERFORMANCE: no backdrop-blur" in kd-theme.css),
    // which force a per-frame compositor re-blur, and (2) my earlier
    // measurements being taken in headless Chromium, which has no GPU and
    // rasterises WebGL in software (SwiftShader) — unrepresentative of real
    // hardware. We therefore mirror Webamp's values rather than throttling.
    // pixelRatio is capped at 2 only so an ultra-HiDPI display doesn't render
    // 9× the pixels; on a normal/retina screen this is full native quality.
    //
    // NOTE: our vendored butterchurn is the JS-only build. Webamp also passes
    // `onlyUseWASM: true`, which runs the per-vertex preset equations as
    // compiled WASM instead of eval'd JS — a further CPU win available only
    // by upgrading butterchurn (+shipping its .wasm). Left as a follow-up.
    var MAX_PIXEL_RATIO = 2;
    function renderDpr() {
        return Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    }
    var MESH_W = 32;
    var MESH_H = 24;

    // auto-cycle: randomly swap preset on a fixed interval (and on
    // track change). Persisted to localStorage so the user's choice
    // survives reloads.
    var AUTO_INTERVAL_OPTIONS_S = [5, 10, 15, 30, 60, 120, 300];
    var autoIntervalIdx = 3;
    try {
        var savedIv = window.localStorage && window.localStorage.getItem('kd_viz_interval');
        if (savedIv !== null) {
            var n = parseInt(savedIv, 10);
            var idx = AUTO_INTERVAL_OPTIONS_S.indexOf(n);
            if (idx >= 0) autoIntervalIdx = idx;
        }
    } catch (e) {}
    var AUTO_INTERVAL_MS = AUTO_INTERVAL_OPTIONS_S[autoIntervalIdx] * 1000;
    var autoCycle = false;
    var autoTimer = null;
    try {
        autoCycle = window.localStorage && window.localStorage.getItem('kd_viz_auto') === '1';
    } catch (e) {}

    function fmtIntervalLabel(s) {
        return s < 60 ? (s + 's') : ((s / 60) + 'm');
    }
    function fmtTime(s) {
        if (!isFinite(s) || s < 0) s = 0;
        var m = Math.floor(s / 60);
        var ss = Math.floor(s % 60);
        return m + ':' + (ss < 10 ? '0' : '') + ss;
    }

    function rootSlash() {
        return (window.SR || '') + '/.kpr/w/deps/';
    }

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = function () { resolve(); };
            s.onerror = function () { reject(new Error('failed to load ' + src)); };
            document.head.appendChild(s);
        });
    }

    function loadDeps() {
        if (depsLoaded) return Promise.resolve();
        if (depsLoading) return depsLoading;
        var base = rootSlash();
        // Load butterchurn (engine) first, then in parallel pull the
        // four preset packs we ship: the default ~120 (Presets), plus
        // Extra (~50), Extra2 (~50), MD1 (Milkdrop 1 ports). We tolerate
        // any individual pack failing to load — the presets dict will
        // just have fewer entries.
        depsLoading = loadScript(base + 'butterchurn.min.js').then(function () {
            return Promise.all([
                loadScript(base + 'butterchurnPresets.min.js')
                    .catch(function (e) { console.warn(e); }),
                loadScript(base + 'butterchurnPresetsExtra.min.js')
                    .catch(function (e) { console.warn(e); }),
                loadScript(base + 'butterchurnPresetsExtra2.min.js')
                    .catch(function (e) { console.warn(e); }),
                loadScript(base + 'butterchurnPresetsMD1.min.js')
                    .catch(function (e) { console.warn(e); }),
                // weekly manifest — small JSON, lazy-loads each
                // individual preset on demand. served locally from
                // web/deps/weekly/ (no S3 round-trip).
                fetch(base + 'weekly/manifest.json', { credentials: 'same-origin' })
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (j) { if (j) window.kdViz_weekly = j; })
                    .catch(function (e) { console.warn('weekly manifest:', e); })
            ]);
        }).then(function () {
            // require at least the default pack to consider load successful
            if (!window.butterchurnPresets) throw new Error('butterchurnPresets not available');
            depsLoaded = true;
        });
        return depsLoading;
    }

    // ----- weekly preset lazy loader -----
    // Each weekly preset lives in its own JSON file under
    // /.kpr/w/deps/weekly/<hash>.json. The manifest maps preset name
    // → filename. We populate the dropdown with these names immediately
    // (so the user sees ~552 extra options), then fetch the actual JSON
    // the first time the user selects one. Cache by hash.
    var weeklyCache = Object.create(null);
    var weeklyInflight = Object.create(null);

    // preset-dropdown paging (infinite scroll)
    var searchMatched = [];     // current filtered key list
    var searchRendered = 0;     // how many rows appended so far
    var searchObserver = null;  // IntersectionObserver for the sentinel
    var SEARCH_PAGE = 60;       // rows appended per page

    function fetchWeeklyPreset(name) {
        if (!window.kdViz_weekly) return Promise.reject(new Error('no weekly manifest'));
        var fname = window.kdViz_weekly[name];
        if (!fname) return Promise.reject(new Error('not in manifest: ' + name));
        if (weeklyCache[fname]) return Promise.resolve(weeklyCache[fname]);
        if (weeklyInflight[fname]) return weeklyInflight[fname];
        var url = rootSlash() + 'weekly/' + encodeURIComponent(fname);
        weeklyInflight[fname] = fetch(url, { credentials: 'same-origin' })
            .then(function (r) { if (!r.ok) throw new Error('fetch ' + r.status); return r.json(); })
            .then(function (j) { weeklyCache[fname] = j; delete weeklyInflight[fname]; return j; })
            .catch(function (e) { delete weeklyInflight[fname]; throw e; });
        return weeklyInflight[fname];
    }

    function buildPanel() {
        if (panel) return;
        panel = document.createElement('div');
        panel.id = 'kd-viz-panel';
        panel.innerHTML =
            '<canvas id="kd-viz-canvas"></canvas>' +
            // top-left: currently playing track filename
            '<div id="kd-viz-track"><span id="kd-viz-track-name">—</span></div>' +
            // top-right: preset name (clickable → opens search dropdown)
            '<a href="#" id="kd-viz-info" title="click to search presets"><span id="kd-viz-name"><span class="kd-viz-name-inner">…</span></span></a>' +
            // searchable preset dropdown (anchored top-right under the
            // info pill, hidden until the pill is clicked)
            '<div id="kd-viz-search" role="dialog" aria-label="preset search">' +
                '<input type="text" id="kd-viz-search-input" placeholder="search presets…" autocomplete="off" spellcheck="false" />' +
                '<ul id="kd-viz-search-list"></ul>' +
            '</div>' +
            // bottom-left: hosts the real #widget when fullscreen is
            // active. JS moves the widget DOM in/out on fullscreenchange
            // so the actual copyparty player renders here — same buttons,
            // same progress canvas, same volume canvas — with a
            // transparent override applied via CSS.
            '<div id="kd-viz-music"></div>' +
            // bottom-right: viz controls
            '<div id="kd-viz-ctrl">' +
                '<a href="#" id="kd-viz-prev" title="previous preset (left arrow)">' + SVG_PREV + '</a>' +
                '<a href="#" id="kd-viz-rand" title="random preset (R)">' + SVG_RAND + '</a>' +
                '<a href="#" id="kd-viz-auto" title="auto-cycle on/off (A)">' + SVG_AUTO + '</a>' +
                '<a href="#" id="kd-viz-interval" title="cycle interval (click to change)"><span>' + fmtIntervalLabel(AUTO_INTERVAL_OPTIONS_S[autoIntervalIdx]) + '</span></a>' +
                '<a href="#" id="kd-viz-next" title="next preset (right arrow)">' + SVG_NEXT + '</a>' +
                '<a href="#" id="kd-viz-large" title="larger view (L)">' + SVG_LARGE + '</a>' +
                '<a href="#" id="kd-viz-fs" title="fullscreen (F)">' + SVG_FS + '</a>' +
                '<a href="#" id="kd-viz-close" title="close (Escape)">' + SVG_CLOSE + '</a>' +
            '</div>';

        var widget = document.getElementById('widget');
        if (widget && widget.parentNode) {
            widget.parentNode.insertBefore(panel, widget);
            // Mirror the widget's current dynamic margins so the panel
            // visually aligns with it. browser.html's sync routine keeps
            // both in lockstep on subsequent resizes / tree toggles.
            if (widget.style.marginLeft) panel.style.marginLeft = widget.style.marginLeft;
            if (widget.style.marginRight) panel.style.marginRight = widget.style.marginRight;
            // Nudge the sync to re-run so it picks up the new panel.
            try { window.dispatchEvent(new Event('resize')); } catch (e) {}
        } else {
            document.body.appendChild(panel);
        }

        canvas = document.getElementById('kd-viz-canvas');
        nameEl = document.getElementById('kd-viz-name');
        nameInnerEl = panel.querySelector('.kd-viz-name-inner');

        var on = function (id, fn) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('click', function (e) { e.preventDefault(); fn(); });
        };
        on('kd-viz-prev', function () { stepPreset(-1); });
        on('kd-viz-next', function () { stepPreset(1); });
        on('kd-viz-rand', function () { randomPreset(); });
        on('kd-viz-auto', function () { setAutoCycle(!autoCycle); });
        on('kd-viz-interval', cycleInterval);
        on('kd-viz-large', toggleLarge);
        on('kd-viz-fs', toggleFullscreen);
        on('kd-viz-close', closePanel);

        // info pill → preset search dropdown
        on('kd-viz-info', toggleSearch);

        // search input handlers
        var sInput = document.getElementById('kd-viz-search-input');
        if (sInput) {
            sInput.addEventListener('input', function () { buildSearchList(this.value); });
            sInput.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); }
                else if (e.key === 'Enter') {
                    var first = document.querySelector('#kd-viz-search-list li');
                    if (first) first.click();
                }
            });
        }
        // click-outside dismisses the dropdown
        document.addEventListener('click', function (e) {
            var s = document.getElementById('kd-viz-search');
            if (!s || !s.classList.contains('open')) return;
            var info = document.getElementById('kd-viz-info');
            if (s.contains(e.target) || (info && info.contains(e.target))) return;
            closeSearch();
        }, true);

        // reflect persisted state on the freshly-built buttons
        updateAutoButtonState();
        updateIntervalLabel();
        updateTrackName();
    }

    function ensureViz() {
        if (viz) return true;
        var ctx = window.kdAudio && window.kdAudio.context;
        if (!ctx) return false;
        if (!window.butterchurn || !window.butterchurnPresets) return false;
        if (!canvas) return false;

        resizeCanvas();

        try {
            var bc = window.butterchurn.default || window.butterchurn;
            viz = bc.createVisualizer(ctx, canvas, {
                width: canvas.width,
                height: canvas.height,
                pixelRatio: renderDpr(),
                textureRatio: 1,
                meshWidth: MESH_W,
                meshHeight: MESH_H
            });
        } catch (e) {
            console.warn('kdVisualizer createVisualizer failed:', e);
            return false;
        }

        try {
            // Merge the bundled packs into one dict so the user sees
            // ~395 presets eagerly available. Weekly presets (~552)
            // are added as keys-only — their JSON is lazy-fetched on
            // first selection in applyPreset().
            var packs = [
                window.butterchurnPresets,
                window.butterchurnPresetsExtra,
                window.butterchurnPresetsExtra2,
                window.butterchurnPresetsMD1
            ];
            presets = {};
            for (var i = 0; i < packs.length; i++) {
                var pack = packs[i];
                if (!pack) continue;
                var p = pack.default || pack;
                var dict = (typeof p.getPresets === 'function') ? p.getPresets() : p;
                if (dict && typeof dict === 'object') {
                    for (var k in dict) {
                        if (Object.prototype.hasOwnProperty.call(dict, k))
                            presets[k] = dict[k];
                    }
                }
            }
            // mix in the 552 weekly preset names. Sentinel value `null`
            // marks them as "not loaded yet"; applyPreset detects null
            // and falls back to fetchWeeklyPreset(name).
            if (window.kdViz_weekly) {
                for (var wk in window.kdViz_weekly) {
                    if (Object.prototype.hasOwnProperty.call(window.kdViz_weekly, wk)
                        && !Object.prototype.hasOwnProperty.call(presets, wk)) {
                        presets[wk] = null;
                    }
                }
            }
            presetKeys = Object.keys(presets).sort();
            presetIdx = Math.floor(Math.random() * presetKeys.length);
            applyPreset(0);
        } catch (e) {
            console.warn('kdVisualizer preset load failed:', e);
        }

        connectAudio(true);
        return true;
    }

    function applyPreset(blendSec) {
        if (!viz || !presetKeys || !presetKeys.length) return;
        var key = presetKeys[presetIdx];
        var blend = typeof blendSec === 'number' ? blendSec : 1.5;

        var setName = function () {
            // re-acquire/rebuild the inner span if it ever got detached
            // (defensive — keeps the marquee structure intact).
            if (nameEl && (!nameInnerEl || !nameEl.contains(nameInnerEl))) {
                nameEl.textContent = '';
                nameInnerEl = document.createElement('span');
                nameInnerEl.className = 'kd-viz-name-inner';
                nameEl.appendChild(nameInnerEl);
            }
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

        var preset = presets[key];
        if (preset) {
            try { viz.loadPreset(preset, blend); setName(); }
            catch (e) { console.warn('kdVisualizer applyPreset failed:', e); }
            return;
        }

        // null sentinel → weekly preset, fetch lazily and cache. Show a
        // brief "loading" hint in the name pill so it's clear that a
        // network round-trip is happening. Write to the inner span (never
        // nameEl directly) so the marquee structure survives.
        if (nameInnerEl || nameEl) {
            if (nameEl) nameEl.classList.remove('marquee');
            (nameInnerEl || nameEl).textContent = '⏳ loading…';
        }
        fetchWeeklyPreset(key).then(function (json) {
            // user may have skipped to a different preset while the
            // fetch was in flight — only apply if still selected.
            if (presetKeys[presetIdx] !== key) return;
            presets[key] = json;
            try { viz.loadPreset(json, blend); setName(); }
            catch (e) { console.warn('kdVisualizer applyPreset (weekly) failed:', e); setName(); }
        }).catch(function (e) {
            console.warn('kdVisualizer fetch weekly failed:', e);
            setName();
        });
    }

    function stepPreset(delta) {
        if (!presetKeys || !presetKeys.length) return;
        presetIdx = (presetIdx + delta + presetKeys.length) % presetKeys.length;
        applyPreset();
        scheduleAutoCycle(true); // user nudged manually — restart the countdown
    }

    function randomPreset() {
        if (!presetKeys || !presetKeys.length) return;
        if (presetKeys.length > 1) {
            var prev = presetIdx;
            do {
                presetIdx = Math.floor(Math.random() * presetKeys.length);
            } while (presetIdx === prev);
        }
        applyPreset();
        scheduleAutoCycle(true);
    }

    // ----- auto-cycle -----

    function scheduleAutoCycle(restart) {
        // tear down any pending timer; only start a fresh one if
        // auto is on AND the panel is currently open AND we're
        // either booting or the caller asked for a reset.
        if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
        if (!autoCycle) return;
        if (!isOpen()) return;
        if (!restart && autoTimer) return;
        autoTimer = setInterval(function () {
            if (!isOpen()) return;
            // randomPreset() recursively reschedules, so call the
            // applier directly to avoid stacking timers.
            if (presetKeys && presetKeys.length > 1) {
                var prev = presetIdx;
                do {
                    presetIdx = Math.floor(Math.random() * presetKeys.length);
                } while (presetIdx === prev);
                applyPreset(2.5);
            } else if (presetKeys && presetKeys.length === 1) {
                applyPreset(2.5);
            }
        }, AUTO_INTERVAL_MS);
    }

    function setAutoCycle(on) {
        autoCycle = !!on;
        try {
            if (window.localStorage)
                window.localStorage.setItem('kd_viz_auto', autoCycle ? '1' : '0');
        } catch (e) {}
        scheduleAutoCycle(true);
        updateAutoButtonState();
    }

    function updateAutoButtonState() {
        var btn = document.getElementById('kd-viz-auto');
        if (!btn) return;
        if (autoCycle) btn.classList.add('on');
        else btn.classList.remove('on');
        // also expose state on the panel so CSS can show/hide the
        // interval chip without JS.
        if (panel) panel.classList.toggle('kd-viz-auto-on', autoCycle);
    }

    function cycleInterval() {
        autoIntervalIdx = (autoIntervalIdx + 1) % AUTO_INTERVAL_OPTIONS_S.length;
        AUTO_INTERVAL_MS = AUTO_INTERVAL_OPTIONS_S[autoIntervalIdx] * 1000;
        try {
            if (window.localStorage)
                window.localStorage.setItem('kd_viz_interval', AUTO_INTERVAL_OPTIONS_S[autoIntervalIdx]);
        } catch (e) {}
        updateIntervalLabel();
        // restart the timer with the new interval
        scheduleAutoCycle(true);
    }

    function updateIntervalLabel() {
        var el = document.getElementById('kd-viz-interval');
        if (!el) return;
        var span = el.querySelector('span');
        if (span) span.textContent = fmtIntervalLabel(AUTO_INTERVAL_OPTIONS_S[autoIntervalIdx]);
    }

    // ----- preset search dropdown -----

    function makeSearchRow(key) {
        var li = document.createElement('li');
        // strip the "AuthorName - " prefix in the visible text but keep it
        // queryable via the original key (stored in title).
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

    function openSearch() {
        var s = document.getElementById('kd-viz-search');
        if (!s) return;
        s.classList.add('open');
        var input = document.getElementById('kd-viz-search-input');
        if (input) {
            input.value = '';
            buildSearchList('');
            // delay focus so the click that opened the dropdown doesn't
            // immediately re-blur it via the document click listener
            setTimeout(function () { input.focus(); }, 0);
        }
    }

    function closeSearch() {
        var s = document.getElementById('kd-viz-search');
        if (s) s.classList.remove('open');
        if (searchObserver) { searchObserver.disconnect(); searchObserver = null; }
    }

    function toggleSearch() {
        var s = document.getElementById('kd-viz-search');
        if (s && s.classList.contains('open')) closeSearch();
        else openSearch();
    }

    // ----- track-name + music time sync -----

    function updateTrackName() {
        var el = document.getElementById('kd-viz-track-name');
        if (!el) return;
        var fname = '';
        if (window.mp && window.mp.au && window.mp.au.tid && window.mp.tracks) {
            var url = window.mp.tracks[window.mp.au.tid];
            if (typeof url === 'string') {
                try {
                    fname = decodeURIComponent(url.split('/').pop().split('?')[0]);
                } catch (e) {
                    fname = url.split('/').pop().split('?')[0];
                }
            }
        }
        el.textContent = fname || '—';
    }

    // ----- host/restore the real #widget inside the viz panel on
    // ----- fullscreenchange. We physically move the DOM node so the
    // ----- player visible in fullscreen IS the same instance copyparty's
    // ----- code drives (same canvases, same buttons, same audio
    // ----- bindings). On exit, we put it back where it came from.

    var widgetHome = null;  // { parent, nextSibling }

    function moveWidgetIntoPanel() {
        var widget = document.getElementById('widget');
        var music = document.getElementById('kd-viz-music');
        if (!widget || !music) return;
        if (widget.parentNode === music) return;
        widgetHome = { parent: widget.parentNode, nextSibling: widget.nextSibling };
        music.appendChild(widget);
        // ping pbar so it re-measures the canvas after reparenting
        try {
            if (window.pbar && typeof window.pbar.onresize === 'function')
                window.pbar.onresize();
            if (window.vbar && typeof window.vbar.onresize === 'function')
                window.vbar.onresize();
        } catch (e) {}
    }

    function restoreWidget() {
        if (!widgetHome) return;
        var widget = document.getElementById('widget');
        if (widget) {
            try {
                widgetHome.parent.insertBefore(widget, widgetHome.nextSibling);
            } catch (e) {
                widgetHome.parent.appendChild(widget);
            }
        }
        widgetHome = null;
        try {
            if (window.pbar && typeof window.pbar.onresize === 'function')
                window.pbar.onresize();
            if (window.vbar && typeof window.vbar.onresize === 'function')
                window.vbar.onresize();
        } catch (e) {}
    }

    function onFullscreenChange() {
        var fs = document.fullscreenElement || document.webkitFullscreenElement;
        if (fs && panel && fs === panel) moveWidgetIntoPanel();
        else restoreWidget();
        updateOccupy();
        // panel size just changed; pull the tracker back into view once the
        // layout settles.
        setTimeout(function () {
            if (window.kdTracker && window.kdTracker.clampPosition)
                window.kdTracker.clampPosition();
            updateOccupy();
        }, 60);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);

    // route audio source → butterchurn analyser
    function connectAudio(force) {
        if (!viz) return;
        if (!window.mp || !window.mp.au) return;

        var src = null;
        if (window.kdChiptune
            && window.kdChiptune.ChiptuneAudio
            && window.mp.au instanceof window.kdChiptune.ChiptuneAudio) {
            var p = window.kdChiptune.getPlayer && window.kdChiptune.getPlayer();
            src = p && p.currentPlayingNode;
        } else {
            src = window.mp.au && window.mp.au._kdSource;
        }
        if (!src) return;
        if (!force && src === connectedSrc) return;

        try {
            viz.connectAudio(src);
            connectedSrc = src;
        } catch (e) {
            console.warn('kdVisualizer connectAudio failed:', e);
        }
    }

    function resizeCanvas() {
        if (!canvas) return;
        var r = canvas.getBoundingClientRect();
        var dpr = renderDpr();
        var w = Math.max(64, Math.floor(r.width));
        var h = Math.max(64, Math.floor(r.height));
        var W = Math.floor(w * dpr);
        var H = Math.floor(h * dpr);
        if (canvas.width !== W || canvas.height !== H) {
            canvas.width = W;
            canvas.height = H;
            if (viz && typeof viz.setRendererSize === 'function') {
                // butterchurn's setRendererSize(w, h, opts) dereferences
                // opts.meshWidth unconditionally — calling it without opts
                // throws (and the throw was silently swallowed, so the GL
                // viewport never actually resized). Pass our mesh + capped
                // pixelRatio so resize/fullscreen keeps the perf caps.
                try {
                    viz.setRendererSize(W, H, {
                        pixelRatio: dpr,
                        meshWidth: MESH_W,
                        meshHeight: MESH_H
                    });
                } catch (e) {}
            }
        }
    }

    function renderLoop() {
        rafId = requestAnimationFrame(renderLoop);
        if (!viz || !panel || !panel.classList.contains('kd-viz-open')) return;
        // render every frame (60fps), exactly like Webamp — see the render
        // config note above for why throttling was the wrong fix.
        try { viz.render(); } catch (e) {}
    }

    function isOpen() {
        return !!(panel && panel.classList.contains('kd-viz-open'));
    }

    function openPanel() {
        if (!window.mp || !window.mp.au) {
            // no track yet — silently no-op (the toggle is also a hint
            // that nothing's playing)
            return;
        }
        buildPanel();
        loadDeps().then(function () {
            // ensureViz() needs window.kdAudio.context, which only exists
            // once playback has wired up an audio source (chiptune player
            // or the MediaElementSource wrap on mp.au). On a first open —
            // especially right after pressing play, before the source is
            // live — it can legitimately return false. Originally this was
            // a one-shot call, so a single miss left viz=null and the panel
            // permanently black until it was closed and reopened. Retry on
            // a short timer so the visualizer self-heals as soon as the
            // context appears.
            if (!ensureViz()) {
                var tries = 0;
                var iv = setInterval(function () {
                    if (ensureViz() || !isOpen() || ++tries > 50)
                        clearInterval(iv);
                }, 100);
            }
            panel.classList.add('kd-viz-open');
            updateLargeButtonState();
            updateOccupy();
            // wait for the height transition to complete before sizing the GL
            // canvas and re-publishing the occupy height (offsetHeight is mid-
            // transition right after adding the class).
            setTimeout(function () { resizeCanvas(); updateOccupy(); }, 380);
            if (rafId === null) renderLoop();
            updateToggleState();
            updateTrackName();
            scheduleAutoCycle(true);
        }).catch(function (e) {
            console.warn('kdVisualizer load failed:', e && e.message || e);
        });
    }

    function closePanel() {
        // exit fullscreen first if active, so the widget gets restored
        // to its normal position before we hide the panel.
        if (document.fullscreenElement && document.exitFullscreen) {
            try { document.exitFullscreen(); } catch (e) {}
        }
        if (panel) panel.classList.remove('kd-viz-open');
        if (panel) panel.classList.remove('kd-viz-large');
        updateLargeButtonState();
        updateOccupy();
        closeSearch();
        updateToggleState();
        // stop the cycle while the panel is hidden — no point spinning
        // a 30 s timer just to advance an off-screen visualizer.
        if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    }

    function togglePanel() {
        if (isOpen()) closePanel(); else openPanel();
    }

    function isLarge() {
        return !!(panel && panel.classList.contains('kd-viz-large'));
    }

    // Publish how much vertical space the panel occupies so the file
    // browser can reserve room above it (keeps grid items clickable).
    // 0 in windowed mode -> layout unchanged.
    // Reserve file-browser space above the panel whenever it's open (windowed
    // OR large) so the grid ends a small gap above the visualizer instead of
    // being overlapped by it. The +12 is that visible gap; 0 when closed /
    // fullscreen so normal layout is untouched.
    var VIZ_GAP = 12;
    function updateOccupy() {
        var px = (isOpen() && !document.fullscreenElement)
            ? (panel.offsetHeight + VIZ_GAP + 'px') : '0px';
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

    function toggleFullscreen() {
        if (!panel) return;
        if (document.fullscreenElement) {
            try { document.exitFullscreen(); } catch (e) {}
        } else if (panel.requestFullscreen) {
            panel.requestFullscreen().then(function () {
                setTimeout(resizeCanvas, 200);
            }).catch(function (e) { console.warn('fullscreen denied:', e); });
        }
    }

    function updateToggleState() {
        var btn = document.getElementById('kd-viz-toggle');
        if (!btn) return;
        if (isOpen()) btn.classList.add('on');
        else btn.classList.remove('on');
    }

    // Add the 🎨 toggle as a tab anchored to the top-right corner of
    // the widget. Putting it inside #pctl would push the progress bar
    // (desktop) and overlap the volume canvas (mobile) since pctl
    // auto-sizes to its content. As a tab it sits in dead space above
    // the widget and stays out of the player chrome.
    function installToggleButton() {
        var widget = document.getElementById('widget');
        if (!widget) return false;
        if (document.getElementById('kd-viz-toggle')) return true;
        var btn = document.createElement('a');
        btn.id = 'kd-viz-toggle';
        btn.href = '#';
        btn.title = 'open visualizer';
        // SVG icon + visible "visualizer" label so the tab reads as a
        // clear interactive control instead of an unrecognisable chip.
        btn.innerHTML = '<span class="kd-viz-toggle-icon">' + SVG_VIZ + '</span>'
            + '<span class="kd-viz-toggle-label">visualizer</span>';
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            togglePanel();
        });
        widget.appendChild(btn);
        return true;
    }

    function tryInstallToggle(retries) {
        if (installToggleButton()) return;
        if (retries > 100) return;
        setTimeout(function () { tryInstallToggle(retries + 1); }, 100);
    }

    // resize tracker — keep canvas in sync with panel dimensions
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

    // keyboard nav — only when panel is open
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

    window.kdVisualizer = {
        toggle: togglePanel,
        open: openPanel,
        close: closePanel,
        setAutoCycle: setAutoCycle,
        // kd-chiptune.js calls this when the audio source changes
        // (track switch on chiptune, MediaElementSource freshly wrapped
        // for browser-native audio). When auto-cycle is on we also
        // randomise the preset for a "fresh look per track" feel.
        onAudioChanged: function () {
            connectedSrc = null;
            // If the panel is open but viz never initialized (e.g. it was
            // opened before any audio source existed), build it now that a
            // source is live. Otherwise just rewire to the new source.
            if (isOpen()) {
                if (viz) connectAudio(true);
                else ensureViz();
            }
            if (autoCycle && viz && isOpen()) {
                randomPreset();
            }
            // refresh the track-name strip in the corner whenever the
            // active track switches (works for both browser-native and
            // chiptune playback).
            updateTrackName();
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { tryInstallToggle(0); });
    } else {
        tryInstallToggle(0);
    }
})();

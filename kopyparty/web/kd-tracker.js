// kd-tracker.js — compact live channel monitor for chiptunes.
//
// While a tracker module (.mod/.it/.s3m/.xm/.mptm/etc.) is playing, this
// panel shows a compact grid of per-channel tiles (one tile per channel,
// 8 across, wrapping so every channel stays visible without horizontal
// scroll). Each tile shows the channel's currently-sounding note +
// instrument and a live VU bar. The titlebar doubles as an FFT spectrum
// display. The panel is a child of `#kd-viz-panel`; its header is a drag
// handle and its position persists to localStorage.
//
// This replaced an earlier full scrolling-pattern view. That view rendered
// the entire prev|cur|next patterns (tens of thousands of DOM nodes) inside
// a backdrop-blurred panel sitting over the animating WebGL visualizer — the
// per-frame compositor re-blur of that huge area was the dominant source of
// lag while the tracker was open. The tile grid keeps the node count to a
// few per channel, updates text only on row changes, and the panel uses a
// solid translucent background (NO backdrop-filter) — see kd-theme.css.
//
// Data is pulled directly from libopenmpt:
//   _openmpt_module_get_num_channels(modPtr)
//   _openmpt_module_get_current_order/pattern/row(modPtr)
//   _openmpt_module_get_pattern_row_channel_command(modPtr, pat, row, ch, cmd)
//       cmd 0=note  1=instrument (the only two the tile grid reads)
//   _openmpt_module_get_current_channel_vu_left/right(modPtr, ch)
//   _openmpt_module_get_current_tempo/speed(modPtr) + get_metadata (status bar)

(function () {
    'use strict';

    var panel = null;
    var headEl = null;          // titlebar (drag handle + FFT + toggle)
    var gridEl = null;          // channel-tile grid
    var fftCanvas = null;
    var fftCtx = null;
    var rafId = null;
    var prevModPtr = 0;
    var prevTid = null;         // copyparty track id of the displayed song
    var numChans = 0;           // channel count of the current module
    var prevPat = -1;
    var prevRow = -1;

    // per-tile element refs + sustained per-channel note/instrument state
    var tiles = null;           // NodeList of .kd-ch-tile
    var tileNote = null;        // NodeList of .kd-ch-note
    var tileInst = null;        // NodeList of .kd-ch-inst
    var tileFx = null;          // NodeList of .kd-ch-fx (current-row effect)
    var vuFills = null;         // NodeList of .kd-vu-fill
    var vuLevels = null;        // smoothed displayed VU levels
    var hitLevel = null;        // per-channel note-trigger flash (1 on strike, decays)
    var lastNote = null;        // Int16Array: last triggered note per channel (0 none, -1 silenced)
    var lastInst = null;        // Int16Array: last instrument per channel

    // effect display lingering: an effect shows at full opacity for a hold,
    // then fades out, so the user actually sees it (effects are 1-row events).
    var fxLevel = null;         // Float32Array: per-channel effect opacity 1->0
    var fxHold = null;          // Int8Array: ticks left at full before fading
    var sweepEl = null;         // panel-wide "scene change" sweep overlay
    var lastSweepTs = 0;        // throttle for the scene-change sweep
    var FX_HOLD_TICKS = 10;     // ~0.33s held full at 30fps
    var FX_FADE = 0.92;         // per-tick decay after the hold (~0.8s tail)

    var dragState = null;
    var SAVE_KEY = 'kd_tracker_pos';

    // user UI scale (zoom). Drives --kd-tracker-scale so the whole tracker —
    // font, tiles, spacing — scales together and the window grows with it.
    var SCALE_KEY = 'kd_tracker_scale';
    var uiScale = 1;
    var layoutT = 0;
    try { var _s = parseFloat(localStorage.getItem(SCALE_KEY)); if (_s >= 0.5 && _s <= 3) uiScale = _s; } catch (e) {}

    // background transparency multiplier (1 = default; lower = more see-through)
    var BGMUL_KEY = 'kd_tracker_bgmul';
    var bgMul = 1;
    try { var _b = parseFloat(localStorage.getItem(BGMUL_KEY)); if (_b >= 0.1 && _b <= 3) bgMul = _b; } catch (e) {}

    // per-track cached status fields (recomputed on track change)
    var stFmt = '';
    var stDur = 0;
    var stNumChans = 0;
    var stNumIns = 0;
    var stNumSmp = 0;
    var stCached = false;

    // FFT analyser feeding the titlebar spectrum bars
    var fftAnalyser = null;
    var fftBuf = null;          // Uint8Array frequency data
    var fftSrc = null;          // audio node currently tapped

    // ---- libopenmpt helpers --------------------------------------------
    var NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
    function fmtNote(n) {
        // regular notes only (1..120); 1 = C-0, 61 = C-5.
        var idx = (n - 1) % 12;
        var oct = Math.floor((n - 1) / 12);
        return NOTE_NAMES[idx] + oct;
    }
    function hex2(v) {
        return ('0' + (v & 0xFF).toString(16).toUpperCase()).slice(-2);
    }

    // Read a C string pointer from the emscripten heap (build doesn't expose
    // UTF8ToString on the module object, so probe aliases).
    function rdStr(ptr) {
        if (!ptr) return '';
        var L = window.libopenmpt;
        var fn = (typeof L.UTF8ToString === 'function') ? L.UTF8ToString
               : (typeof L.Pointer_stringify === 'function') ? L.Pointer_stringify
               : (typeof window.UTF8ToString === 'function') ? window.UTF8ToString
               : null;
        return fn ? fn(ptr) : '';
    }

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

    function esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    // channel label: libopenmpt channel name when defined, else 1-based number.
    function channelLabel(mp, ch) {
        var num = ('0' + (ch + 1)).slice(-2);
        try {
            var ptr = libopenmpt._openmpt_module_get_channel_name(mp, ch);
            if (ptr) {
                var s = rdStr(ptr);
                if (libopenmpt._openmpt_free_string) libopenmpt._openmpt_free_string(ptr);
                s = (s || '').replace(/^\s+|\s+$/g, '');
                if (s) return num + ' ' + s;
            }
        } catch (e) {}
        return num;
    }

    function isChiptunePlaying() {
        if (!window.kdChiptune || !window.kdChiptune.ChiptuneAudio) return false;
        if (!window.mp || !window.mp.au) return false;
        if (!(window.mp.au instanceof window.kdChiptune.ChiptuneAudio)) return false;
        var p = window.kdChiptune.getPlayer && window.kdChiptune.getPlayer();
        return !!(p && p.currentPlayingNode && p.currentPlayingNode.modulePtr
                  && window.libopenmpt
                  && typeof libopenmpt._openmpt_module_get_current_row === 'function');
    }

    function modPtr() {
        return window.kdChiptune.getPlayer().currentPlayingNode.modulePtr;
    }

    function getCmd(mp, pat, row, ch, cmd) {
        return libopenmpt._openmpt_module_get_pattern_row_channel_command(
            mp, pat, row, ch, cmd
        ) & 0xFF;
    }

    // libopenmpt's own formatted glyph for one command of a cell — used for
    // the format-native effect letter (IT "A", MOD "0", S3M "Q", …). Allocates
    // an openmpt string we must free; only called for cells that carry an
    // effect (sparse), so the alloc churn is negligible.
    function fmtCmdStr(mp, pat, row, ch, cmd) {
        var ptr = libopenmpt._openmpt_module_format_pattern_row_channel_command(mp, pat, row, ch, cmd);
        if (!ptr) return '';
        var s = rdStr(ptr);
        if (libopenmpt._openmpt_free_string) libopenmpt._openmpt_free_string(ptr);
        return (s || '').replace(/^\s+|\s+$/g, '');
    }

    // OpenMPT EffectCommand enum (cmd index 3) → Furnace effect-colour bucket,
    // so each effect gets the colour Furnace would give the equivalent op.
    // Values per soundlib/modcommand.h; unknown → 'sysprim'.
    var FX_CAT = {
        1: 'misc', 2: 'pitch', 3: 'pitch', 4: 'pitch', 5: 'pitch', 6: 'volume',
        7: 'volume', 8: 'volume', 9: 'panning', 10: 'misc', 11: 'volume',
        12: 'song', 13: 'volume', 14: 'song', 15: 'misc', 16: 'speed', 17: 'time',
        18: 'volume', 19: 'misc', 20: 'misc', 21: 'volume', 22: 'volume',
        23: 'volume', 24: 'volume', 25: 'misc', 26: 'pitch', 27: 'panning',
        28: 'pitch', 29: 'panning', 30: 'misc', 31: 'misc', 32: 'misc', 33: 'misc',
        34: 'misc', 35: 'pitch', 36: 'pitch', 37: 'invalid',
        38: 'pitch', 39: 'pitch', 40: 'pitch', 41: 'pitch', 42: 'misc', 43: 'misc',
        44: 'misc', 45: 'misc', 46: 'volume', 47: 'misc', 48: 'misc', 49: 'volume',
        50: 'pitch', 51: 'pitch', 52: 'pitch', 53: 'pitch', 54: 'pitch', 55: 'pitch',
        56: 'volume', 57: 'volume'
    };
    function effectColorClass(typ) {
        if (typ <= 0) return 'misc';
        return FX_CAT[typ] || 'sysprim';
    }

    // ---- panel ----------------------------------------------------------
    function buildPanel() {
        if (panel) return panel;
        var viz = document.getElementById('kd-viz-panel');
        if (!viz) return null;
        panel = document.createElement('div');
        panel.id = 'kd-tracker';
        panel.innerHTML =
            '<div class="kd-tracker-head">' +
                '<canvas class="kd-tracker-fft"></canvas>' +
                '<span class="kd-tracker-title">KD/TRACKER</span>' +
                '<a href="#" class="kd-tracker-zoom" data-z="out" title="smaller (font / UI scale)">A−</a>' +
                '<a href="#" class="kd-tracker-zoom" data-z="in" title="larger (font / UI scale)">A+</a>' +
                '<a href="#" class="kd-tracker-zoom" data-t="out" title="more transparent">◐−</a>' +
                '<a href="#" class="kd-tracker-zoom" data-t="in" title="more opaque">◐+</a>' +
                '<a href="#" class="kd-tracker-toggle" title="minimize / restore">−</a>' +
            '</div>' +
            '<div class="kd-tracker-grid"></div>' +
            '<div class="kd-tracker-status">' +
                '<span class="kd-st-bpm">--</span>' +
                '<span class="kd-st-speed">--</span>' +
                '<span class="kd-st-pos">--</span>' +
                '<span class="kd-st-chans">--</span>' +
                '<span class="kd-st-counts">--</span>' +
                '<span class="kd-st-fmt">--</span>' +
                '<span class="kd-st-time">--</span>' +
            '</div>' +
            '<div class="kd-tracker-sweep"></div>';
        viz.appendChild(panel);
        headEl = panel.querySelector('.kd-tracker-head');
        gridEl = panel.querySelector('.kd-tracker-grid');
        fftCanvas = panel.querySelector('.kd-tracker-fft');
        fftCtx = fftCanvas ? fftCanvas.getContext('2d') : null;
        sweepEl = panel.querySelector('.kd-tracker-sweep');
        panel.style.setProperty('--kd-tracker-scale', uiScale);
        panel.style.setProperty('--kd-tracker-bgmul', bgMul);
        applySavedPosition();
        applySavedCollapsedState();
        attachDrag(panel.querySelector('.kd-tracker-title'));
        var toggleBtn = panel.querySelector('.kd-tracker-toggle');
        toggleBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var collapsed = panel.classList.toggle('kd-tracker-collapsed');
            toggleBtn.textContent = collapsed ? '+' : '−';
            try { localStorage.setItem('kd_tracker_collapsed', collapsed ? '1' : '0'); } catch (e) {}
        });
        var zbtns = panel.querySelectorAll('.kd-tracker-zoom');
        for (var zi = 0; zi < zbtns.length; zi++) {
            zbtns[zi].addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (this.hasAttribute('data-z'))
                    setScale(this.getAttribute('data-z') === 'in' ? uiScale * 1.15 : uiScale / 1.15);
                else if (this.hasAttribute('data-t'))
                    setBgMul(this.getAttribute('data-t') === 'in' ? bgMul * 1.3 : bgMul / 1.3);
            });
        }
        // recompute column count when the available width changes. Entering /
        // exiting OS fullscreen fires a window resize; large-mode toggles don't,
        // so kd-visualizer.js also calls window.kdTracker.relayout().
        window.addEventListener('resize', function () {
            clearTimeout(layoutT);
            layoutT = setTimeout(function () {
                layoutGrid();
                if (window.kdTracker && window.kdTracker.clampPosition) window.kdTracker.clampPosition();
            }, 150);
        });
        return panel;
    }

    // Background transparency — clamp, persist, apply. Lower = more see-through.
    function setBgMul(m) {
        bgMul = Math.max(0.1, Math.min(3, m));
        if (panel) panel.style.setProperty('--kd-tracker-bgmul', bgMul.toFixed(3));
        try { localStorage.setItem(BGMUL_KEY, bgMul.toFixed(3)); } catch (e) {}
    }

    // User zoom — clamp, persist, apply, relayout columns, keep in view.
    function setScale(s) {
        uiScale = Math.max(0.5, Math.min(3, s));
        if (panel) panel.style.setProperty('--kd-tracker-scale', uiScale);
        try { localStorage.setItem(SCALE_KEY, uiScale.toFixed(3)); } catch (e) {}
        layoutGrid();
        if (window.kdTracker && window.kdTracker.clampPosition) window.kdTracker.clampPosition();
    }

    // Choose the column count: as many tiles as fit the available width at the
    // current scale, capped at 8 and the channel count. Fewer columns → more
    // rows → the grid grows taller and only scrolls when it can't grow more.
    function layoutGrid() {
        if (!panel || !gridEl || !numChans) return;
        var viz = document.getElementById('kd-viz-panel');
        var availW = (viz ? viz.clientWidth : window.innerWidth) - 24;
        var base = parseFloat(window.getComputedStyle(panel).fontSize) || 15;
        var tilePx = 5.6 * base + 2 * uiScale;   // 5.6em column + grid gap
        var fit = Math.max(1, Math.floor((availW + 2) / tilePx));
        var cols = Math.min(numChans, 8, fit);
        panel.style.setProperty('--kd-cols', cols);
    }

    function applySavedCollapsedState() {
        try {
            if (localStorage.getItem('kd_tracker_collapsed') === '1') {
                panel.classList.add('kd-tracker-collapsed');
                var btn = panel.querySelector('.kd-tracker-toggle');
                if (btn) btn.textContent = '+';
            }
        } catch (e) {}
    }

    function hidePanel() {
        if (!panel) return;
        panel.classList.remove('kd-tracker-on');
        numChans = 0;
        prevPat = -1;
        prevRow = -1;
        prevModPtr = 0;
        prevTid = null;
        stCached = false;
        tiles = tileNote = tileInst = tileFx = vuFills = vuLevels = hitLevel = lastNote = lastInst = null;
        fxLevel = fxHold = null;
        fftSrc = null;
    }

    // Build one tile per channel. Columns capped at 8 (CSS grid wraps the
    // rest), so all channels remain visible without horizontal scroll.
    function buildGrid(mp) {
        numChans = libopenmpt._openmpt_module_get_num_channels(mp) || 0;
        panel.style.setProperty('--kd-cols', Math.min(numChans, 8) || 1);  // provisional
        var html = '';
        for (var ch = 0; ch < numChans; ch++) {
            html += '<div class="kd-ch-tile" title="' + esc(channelLabel(mp, ch)) + '">' +
                '<span class="kd-ch-num">' + ('0' + (ch + 1)).slice(-2) + '</span>' +
                '<span class="kd-ch-note inactive">···</span>' +
                '<span class="kd-ch-inst inactive">··</span>' +
                '<span class="kd-ch-fx inactive">···</span>' +
                '<span class="kd-vu"><i class="kd-vu-fill"></i></span>' +
                '</div>';
        }
        gridEl.innerHTML = html;
        tiles = gridEl.querySelectorAll('.kd-ch-tile');
        tileNote = gridEl.querySelectorAll('.kd-ch-note');
        tileInst = gridEl.querySelectorAll('.kd-ch-inst');
        tileFx = gridEl.querySelectorAll('.kd-ch-fx');
        vuFills = gridEl.querySelectorAll('.kd-vu-fill');
        vuLevels = new Float32Array(numChans);
        hitLevel = new Float32Array(numChans);
        fxLevel = new Float32Array(numChans);
        fxHold = new Int8Array(numChans);
        lastNote = new Int16Array(numChans);   // 0 = never played
        lastInst = new Int16Array(numChans);
        layoutGrid();   // pick the real column count for the current width/scale
    }

    // Update each tile's note/instrument from the currently-playing row.
    // Notes sustain: a tile keeps showing its last triggered note until a
    // new note or a note-off/cut (>120) silences it. Only called on a row
    // or pattern change (≤~20×/s), never per frame.
    function updateGridNotes(mp, pat, row) {
        if (!tileNote || pat < 0 || row < 0) return;
        for (var ch = 0; ch < numChans; ch++) {
            var note = getCmd(mp, pat, row, ch, 0);
            if (note > 0) {
                if (note > 120) {                // key-off / cut / fade
                    lastNote[ch] = -1; lastInst[ch] = 0;
                } else {
                    lastNote[ch] = note;
                    var inst = getCmd(mp, pat, row, ch, 1);
                    if (inst > 0) lastInst[ch] = inst;
                    // trigger flash — fires on EVERY note-on, even a same-pitch
                    // re-strike, so the grid visibly pulses in rhythm with the
                    // pattern (the note text alone wouldn't change on re-hits).
                    if (hitLevel) hitLevel[ch] = 1;
                }
            }
            var nEl = tileNote[ch];
            if (nEl) {
                var ln = lastNote[ch];
                if (ln > 0) {
                    var t = fmtNote(ln);
                    if (nEl.textContent !== t) nEl.textContent = t;
                    if (nEl.className !== 'kd-ch-note') nEl.className = 'kd-ch-note';
                } else {
                    if (nEl.textContent !== '···') nEl.textContent = '···';
                    if (nEl.className !== 'kd-ch-note inactive') nEl.className = 'kd-ch-note inactive';
                }
            }
            var iEl = tileInst[ch];
            if (iEl) {
                var li = lastInst[ch];
                var it = li > 0 ? hex2(li) : '··';
                if (iEl.textContent !== it) iEl.textContent = it;
                var ic = li > 0 ? 'kd-ch-inst' : 'kd-ch-inst inactive';
                if (iEl.className !== ic) iEl.className = ic;
            }
            // effect column — Furnace-style glyph+param, coloured by category.
            // When an effect fires we show it at full opacity, then it HOLDS
            // and FADES (in the per-tick loop) so the user can actually read a
            // 1-row event, and a category-specific entrance animation plays.
            // Main effect column wins; falls back to the volume column.
            var fEl = tileFx[ch];
            if (fEl) {
                var fxt = getCmd(mp, pat, row, ch, 3);   // effect type
                var ft = null, cat = null;
                if (fxt > 0) {
                    ft = (fmtCmdStr(mp, pat, row, ch, 3) || '?') + hex2(getCmd(mp, pat, row, ch, 5));
                    cat = effectColorClass(fxt);
                } else {
                    var volCmd = getCmd(mp, pat, row, ch, 2);   // volume-column effect
                    if (volCmd > 0) {
                        ft = (fmtCmdStr(mp, pat, row, ch, 2) || '?') + hex2(getCmd(mp, pat, row, ch, 4));
                        cat = 'volume';
                    }
                }
                if (ft !== null) {
                    fEl.textContent = ft;
                    fEl.className = 'kd-ch-fx fx-' + cat;
                    fEl.style.opacity = '1';
                    if (fxLevel) { fxLevel[ch] = 1; fxHold[ch] = FX_HOLD_TICKS; }
                    animateEffect(fEl, cat);
                    if (cat === 'song') triggerSceneChange();
                }
                // no effect this row → leave the previous one to hold+fade.
            }
        }
    }

    // Category-specific entrance animation, evoking what the effect does.
    // transform/opacity only (GPU-composited) so it stays cheap over the
    // animating visualizer. Web Animations API: one-shot, auto-reverts.
    function animateEffect(fEl, cat) {
        if (!fEl || !fEl.animate) return;
        try { if (fEl._kdAnim) fEl._kdAnim.cancel(); } catch (e) {}
        var kf, opt = { duration: 360, easing: 'cubic-bezier(.2,.8,.2,1)' };
        switch (cat) {
            case 'pitch':                       // note bend — vertical
                kf = [{ transform: 'translateY(4px)' }, { transform: 'translateY(-2px)' }, { transform: 'translateY(0)' }];
                opt.duration = 420; break;
            case 'volume':                      // swell — scale pulse
                kf = [{ transform: 'scale(.65)', opacity: .5 }, { transform: 'scale(1.2)' }, { transform: 'scale(1)', opacity: 1 }];
                break;
            case 'panning':                     // pan — horizontal sweep
                kf = [{ transform: 'translateX(-7px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }];
                break;
            case 'speed':                       // speed — horizontal stretch snap
                kf = [{ transform: 'scaleX(1.6)' }, { transform: 'scaleX(.9)' }, { transform: 'scaleX(1)' }];
                opt.duration = 300; break;
            case 'time':                        // tempo — zoom-in pulse
                kf = [{ transform: 'scale(1.35)', opacity: .25 }, { transform: 'scale(1)', opacity: 1 }];
                break;
            case 'song':                        // jump/break — big pop (+sweep)
                kf = [{ transform: 'scale(1.6)', opacity: .2 }, { transform: 'scale(1)', opacity: 1 }];
                opt.duration = 300; break;
            default:                            // misc/sys — quick pop
                kf = [{ transform: 'scale(1.4)' }, { transform: 'scale(1)' }];
                opt.duration = 260; break;
        }
        try { fEl._kdAnim = fEl.animate(kf, opt); } catch (e) {}
    }

    // A song-structural effect (position jump / pattern break) sweeps a light
    // band across the whole grid — a "scene change" cue. Throttled so dense
    // sequences don't strobe.
    function triggerSceneChange() {
        if (!sweepEl || !sweepEl.animate) return;
        var now = performance.now ? performance.now() : Date.now();
        if (now - lastSweepTs < 380) return;
        lastSweepTs = now;
        try {
            sweepEl.animate(
                [{ transform: 'translateX(-110%)' }, { transform: 'translateX(110%)' }],
                { duration: 520, easing: 'ease-in-out' }
            );
        } catch (e) {}
    }

    // Per-channel VU bars (eased, attack-fast/release-slow). One FFI pair
    // per channel per tick — cheap.
    function updateVU(mp) {
        if (!vuFills || !vuLevels) return;
        for (var ch = 0; ch < numChans && ch < vuFills.length; ch++) {
            var l = libopenmpt._openmpt_module_get_current_channel_vu_left(mp, ch) || 0;
            var r = libopenmpt._openmpt_module_get_current_channel_vu_right(mp, ch) || 0;
            var target = Math.max(l, r);
            if (target > 1) target = 1; else if (target < 0) target = 0;
            var cur = vuLevels[ch];
            cur = target > cur ? target : cur + (target - cur) * 0.35;
            vuLevels[ch] = cur;
            vuFills[ch].style.width = (cur * 100).toFixed(1) + '%';
            // decay the note-trigger flash and push both intensities to the
            // tile as CSS vars (--hit drives the strike glow, --lvl the
            // note-text brightness so quiet/idle channels visibly dim).
            if (hitLevel && tiles && tiles[ch]) {
                var h = hitLevel[ch] * 0.80;
                if (h < 0.01) h = 0;
                hitLevel[ch] = h;
                var st = tiles[ch].style;
                st.setProperty('--hit', h.toFixed(3));
                st.setProperty('--lvl', cur.toFixed(3));
            }
            // effect hold-then-fade. During the hold we leave opacity alone so
            // the entrance animation owns it; after, we fade the text out and
            // finally reset to the idle "···".
            if (fxLevel && fxLevel[ch] > 0) {
                if (fxHold[ch] > 0) {
                    fxHold[ch]--;
                } else {
                    var fl = fxLevel[ch] * FX_FADE;
                    var fe = tileFx && tileFx[ch];
                    if (fl < 0.04) {
                        fl = 0;
                        if (fe) { fe.textContent = '···'; fe.className = 'kd-ch-fx inactive'; fe.style.opacity = ''; }
                    } else if (fe) {
                        fe.style.opacity = fl.toFixed(3);
                    }
                    fxLevel[ch] = fl;
                }
            }
        }
    }

    // ---- status bar -----------------------------------------------------
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
        setSt('kd-st-bpm', 'BPM ' + bpm);
        setSt('kd-st-speed', 'SPD ' + spd);
        setSt('kd-st-pos', 'Ord ' + curOrd + '/' + (nords - 1) + ' · Pat ' + curPat + ' · Row ' + hex2(curRow) + '/' + hex2(nrows));
        setSt('kd-st-chans', 'Ch ' + playing + '/' + stNumChans);
        setSt('kd-st-counts', 'Ins ' + stNumIns + ' · Smp ' + stNumSmp);
        setSt('kd-st-fmt', stFmt);
        setSt('kd-st-time', fmtMS(pos) + ' / ' + fmtMS(stDur));
    }

    // ---- titlebar FFT spectrum bars -------------------------------------
    // One AnalyserNode on the shared context, tapping the same source the
    // visualizer feeds. Passive sink — does not alter the audio graph.
    function ensureFftAnalyser() {
        var ctx = window.kdAudio && window.kdAudio.context;
        if (!ctx) return false;
        if (!fftAnalyser) {
            try {
                fftAnalyser = ctx.createAnalyser();
                fftAnalyser.fftSize = 256;
                fftAnalyser.smoothingTimeConstant = 0.6;
                fftBuf = new Uint8Array(fftAnalyser.frequencyBinCount);
            } catch (e) { fftAnalyser = null; return false; }
        }
        var src = null;
        if (window.kdChiptune && window.kdChiptune.ChiptuneAudio
            && window.mp && window.mp.au instanceof window.kdChiptune.ChiptuneAudio) {
            var p = window.kdChiptune.getPlayer && window.kdChiptune.getPlayer();
            src = p && p.currentPlayingNode;
        } else if (window.mp && window.mp.au) {
            src = window.mp.au._kdSource;
        }
        if (src && src !== fftSrc) {
            try { src.connect(fftAnalyser); fftSrc = src; }
            catch (e) { fftSrc = src; }
        }
        return !!fftAnalyser;
    }

    function drawFft() {
        if (!fftCtx || !ensureFftAnalyser()) return;
        var c = fftCanvas;
        var r = c.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var W = Math.max(2, Math.floor(r.width * dpr));
        var H = Math.max(2, Math.floor(r.height * dpr));
        if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
        fftAnalyser.getByteFrequencyData(fftBuf);
        var ctx = fftCtx;
        ctx.clearRect(0, 0, W, H);
        var bars = 40;
        var useBins = Math.floor(fftBuf.length * 0.7); // drop near-empty highs
        var gap = Math.max(1, W / bars * 0.18);
        var bw = (W - gap * (bars - 1)) / bars;
        for (var b = 0; b < bars; b++) {
            var lo = Math.floor(b / bars * useBins);
            var hi = Math.max(lo + 1, Math.floor((b + 1) / bars * useBins));
            var m = 0;
            for (var i = lo; i < hi; i++) if (fftBuf[i] > m) m = fftBuf[i];
            var v = m / 255;
            var bh = v * H;
            var x = b * (bw + gap);
            ctx.fillStyle = 'rgba(0,255,150,' + (0.18 + 0.5 * v) + ')';
            ctx.fillRect(x, H - bh, bw, bh);
        }
    }

    // ---- main loop ------------------------------------------------------
    // Tile text changes at most ~20×/s; VU + FFT animate but are cheap.
    // Cap to ~30fps so we don't starve the audio callback + visualizer.
    var TICK_FPS = 30;
    var TICK_MIN_INTERVAL = 1000 / TICK_FPS;
    var lastTickTs = 0;

    function tick(ts) {
        rafId = requestAnimationFrame(tick);

        var now = ts || performance.now();
        if (now - lastTickTs < TICK_MIN_INTERVAL - 2) return;
        lastTickTs = now;

        if (!isChiptunePlaying()) {
            if (panel && panel.classList.contains('kd-tracker-on')) hidePanel();
            return;
        }

        if (!buildPanel()) return;

        var mp = modPtr();
        var curOrd = libopenmpt._openmpt_module_get_current_order(mp);
        var curRow = libopenmpt._openmpt_module_get_current_row(mp);

        // Detect a track change. The module pointer alone is unreliable —
        // libopenmpt recycles addresses — so also key on copyparty's per-
        // track id (mp.au.tid).
        var curTid = (window.mp && window.mp.au && window.mp.au.tid != null)
            ? window.mp.au.tid : null;
        if (mp !== prevModPtr || curTid !== prevTid) {
            prevModPtr = mp;
            prevTid = curTid;
            numChans = 0;
            stCached = false;
            prevPat = -1;
            prevRow = -1;
        }

        if (!numChans) {
            panel.classList.add('kd-tracker-on');
            buildGrid(mp);
        }

        var curPat = libopenmpt._openmpt_module_get_current_pattern(mp);
        if (curPat !== prevPat || curRow !== prevRow) {
            updateGridNotes(mp, curPat, curRow);
            prevPat = curPat;
            prevRow = curRow;
        }

        updateStatus(mp, curOrd, curRow);
        updateVU(mp);
        drawFft();
    }

    function start() {
        if (rafId === null) rafId = requestAnimationFrame(tick);
    }

    // ---- drag handle ----------------------------------------------------
    function attachDrag(handle) {
        if (!handle) return;
        var down = function (clientX, clientY) {
            var r = panel.getBoundingClientRect();
            dragState = {
                offsetX: clientX - r.left,
                offsetY: clientY - r.top,
                w: r.width,
                h: r.height
            };
            panel.classList.add('kd-tracker-dragging');
        };
        var move = function (clientX, clientY) {
            if (!dragState) return;
            var viz = document.getElementById('kd-viz-panel');
            var vr = viz.getBoundingClientRect();
            var x = clientX - dragState.offsetX - vr.left;
            var y = clientY - dragState.offsetY - vr.top;
            x = Math.max(0, Math.min(x, vr.width - dragState.w));
            y = Math.max(0, Math.min(y, vr.height - dragState.h));
            panel.style.left = x + 'px';
            panel.style.top = y + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.style.transform = 'none';
        };
        var up = function () {
            if (!dragState) return;
            dragState = null;
            panel.classList.remove('kd-tracker-dragging');
            try {
                localStorage.setItem(SAVE_KEY, JSON.stringify({
                    left: panel.style.left,
                    top: panel.style.top
                }));
            } catch (e) {}
        };
        handle.addEventListener('mousedown', function (e) {
            e.preventDefault();
            down(e.clientX, e.clientY);
        });
        document.addEventListener('mousemove', function (e) {
            if (!dragState) return;
            move(e.clientX, e.clientY);
        });
        document.addEventListener('mouseup', up);
        handle.addEventListener('touchstart', function (e) {
            if (!e.touches.length) return;
            down(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: true });
        document.addEventListener('touchmove', function (e) {
            if (!dragState || !e.touches.length) return;
            e.preventDefault();
            move(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: false });
        document.addEventListener('touchend', up);
        document.addEventListener('touchcancel', up);
    }

    function applySavedPosition() {
        try {
            var saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
            if (saved && saved.left && saved.top) {
                panel.style.left = saved.left;
                panel.style.top = saved.top;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                panel.style.transform = 'none';
            }
        } catch (e) {}
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

    window.kdTracker = {
        // Re-clamp the (possibly dragged) tracker box back inside the viz
        // panel after the panel shrinks (e.g. exiting fullscreen). Adjusts
        // only the live inline position, never the saved one, and is a no-op
        // when already inside.
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
            if (Math.abs(nl - curLeft) > 0.5 || Math.abs(nt - curTop) > 0.5) {
                panel.style.left = nl + 'px';
                panel.style.top = nt + 'px';
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                panel.style.transform = 'none';
            }
        },
        onAudioChanged: function () { fftSrc = null; },
        relayout: function () { layoutGrid(); },
        rebuild: function () { numChans = 0; prevPat = -1; prevRow = -1; },
        resetPosition: function () {
            try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
            if (!panel) return;
            panel.style.left = '';
            panel.style.top = '';
            panel.style.right = '';
            panel.style.bottom = '';
            panel.style.transform = '';
        }
    };
})();

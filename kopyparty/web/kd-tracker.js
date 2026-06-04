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
    var vuFills = null;         // NodeList of .kd-vu-fill
    var vuLevels = null;        // smoothed displayed VU levels
    var hitLevel = null;        // per-channel note-trigger flash (1 on strike, decays)
    var lastNote = null;        // Int16Array: last triggered note per channel (0 none, -1 silenced)
    var lastInst = null;        // Int16Array: last instrument per channel

    var dragState = null;
    var SAVE_KEY = 'kd_tracker_pos';

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
                '<span class="kd-tracker-title">tracker</span>' +
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
            '</div>';
        viz.appendChild(panel);
        headEl = panel.querySelector('.kd-tracker-head');
        gridEl = panel.querySelector('.kd-tracker-grid');
        fftCanvas = panel.querySelector('.kd-tracker-fft');
        fftCtx = fftCanvas ? fftCanvas.getContext('2d') : null;
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
        return panel;
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
        tiles = tileNote = tileInst = vuFills = vuLevels = hitLevel = lastNote = lastInst = null;
        fftSrc = null;
    }

    // Build one tile per channel. Columns capped at 8 (CSS grid wraps the
    // rest), so all channels remain visible without horizontal scroll.
    function buildGrid(mp) {
        numChans = libopenmpt._openmpt_module_get_num_channels(mp) || 0;
        var cols = Math.min(numChans, 8) || 1;
        panel.style.setProperty('--kd-cols', cols);
        var html = '';
        for (var ch = 0; ch < numChans; ch++) {
            html += '<div class="kd-ch-tile" title="' + esc(channelLabel(mp, ch)) + '">' +
                '<span class="kd-ch-num">' + ('0' + (ch + 1)).slice(-2) + '</span>' +
                '<span class="kd-ch-note inactive">···</span>' +
                '<span class="kd-ch-inst inactive">··</span>' +
                '<span class="kd-vu"><i class="kd-vu-fill"></i></span>' +
                '</div>';
        }
        gridEl.innerHTML = html;
        tiles = gridEl.querySelectorAll('.kd-ch-tile');
        tileNote = gridEl.querySelectorAll('.kd-ch-note');
        tileInst = gridEl.querySelectorAll('.kd-ch-inst');
        vuFills = gridEl.querySelectorAll('.kd-vu-fill');
        vuLevels = new Float32Array(numChans);
        hitLevel = new Float32Array(numChans);
        lastNote = new Int16Array(numChans);   // 0 = never played
        lastInst = new Int16Array(numChans);
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
        }
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

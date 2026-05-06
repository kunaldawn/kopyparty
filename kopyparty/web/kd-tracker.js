// kd-tracker.js — live Furnace-style pattern view for chiptunes.
//
// While a tracker module (.mod/.it/.s3m/.xm/.mptm/etc.) is playing,
// this panel shows the actual channel-wise pattern data scrolling in
// real time. The panel is a child of `#kd-viz-panel` and CSS positions
// it as an overlay (windowed: above the player chrome; fullscreen:
// floating top-center). Header is a drag handle — the user can move
// the box anywhere on the viz canvas; position persists to
// localStorage.
//
// Furnace-fidelity behaviours:
//
//   - Cross-pattern continuity. The body holds three patterns at once:
//     [prev order's pattern | current order's pattern | next order's
//     pattern]. As the song advances past a pattern boundary, the
//     visible rows above the play-head are the *previous* pattern's
//     tail and below are the *next* pattern's head — no blank gap.
//     Mirrors `pattern.cpp:1246-1331` (`viewPrevPattern` loop).
//
//   - Single-row play-head. The currently playing row gets a
//     white-25 % background tint (`PATTERN_PLAY_HEAD`); the playing
//     row is centered by setting the body's scrollTop. The bar moves
//     with the row, but visually it stays put because we always
//     re-center.
//
//   - Padding. The body's vertical padding is computed in JS to
//     `(bodyH - rowH) / 2` so the play-head can centre even for the
//     very first / very last row of the tape. CSS `padding: 50%` is
//     unusable because percentage vertical padding resolves against
//     the parent's *width*.
//
// Data is pulled directly from libopenmpt:
//   _openmpt_module_get_num_orders(modPtr)
//   _openmpt_module_get_order_pattern(modPtr, ord)
//   _openmpt_module_get_current_order(modPtr)
//   _openmpt_module_get_current_row(modPtr)
//   _openmpt_module_get_pattern_num_rows(modPtr, pat)
//   _openmpt_module_get_pattern_row_channel_command(modPtr, pat, row,
//                                                   chan, cmd)
//     cmd 0=note, 1=instr, 2=volume-col, 3=effect-type, 4=effect-param

(function () {
    'use strict';

    var panel = null;
    var headEl = null;
    var bodyEl = null;
    var rafId = null;
    var prevModPtr = 0;
    var activeChans = null;       // channel indices used in song

    // tape state — the [prev|cur|next] strip the body currently renders
    var tapeOrd = -1;             // current order at last rebuild
    var tapeCurOffset = 0;        // index of cur-order's row 0 in body children
    var tapeCurLen = 0;           // row count of cur-order's pattern
    var prevPlayRow = -1;         // last drawn order-relative play row
    var prevTapePad = -1;         // last padding applied (px)

    var dragState = null;
    var SAVE_KEY = 'kd_tracker_pos';

    // ---- libopenmpt formatters (Furnace-style) -------------------------
    var NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
    function fmtNote(n) {
        if (n <= 0) return '...';
        if (n === 254) return '^^^';   // note cut (libopenmpt convention)
        if (n === 255) return '===';   // note off / release
        // openmpt note numbering: 1 = C-0, 13 = C-1, …, 61 = C-5.
        var idx = (n - 1) % 12;
        var oct = Math.floor((n - 1) / 12);
        return NOTE_NAMES[idx] + oct;
    }
    function fmtHex2(v) {
        if (v === 0) return '..';
        return ('0' + v.toString(16).toUpperCase()).slice(-2);
    }
    function fmtVol(v) {
        if (v <= 0) return '..';
        return ('0' + v.toString(16).toUpperCase()).slice(-2);
    }
    // Furnace prints both effect type and param as 2-digit upper hex
    // (`pattern.cpp` uses "%.2X" for both). Empty → '..' per side.
    function fmtFxType(t) { return t === 0 ? '..' : fmtHex2(t); }
    function fmtFxParam(p) { return p === 0 ? '..' : fmtHex2(p); }

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

    function buildPanel() {
        if (panel) return panel;
        var viz = document.getElementById('kd-viz-panel');
        if (!viz) return null;
        panel = document.createElement('div');
        panel.id = 'kd-tracker';
        panel.innerHTML =
            '<div class="kd-tracker-head">' +
                '<span class="kd-tracker-title">tracker</span>' +
                '<a href="#" class="kd-tracker-toggle" title="minimize / restore">−</a>' +
            '</div>' +
            '<div class="kd-tracker-cols"></div>' +
            '<div class="kd-tracker-body"></div>';
        viz.appendChild(panel);
        headEl = panel.querySelector('.kd-tracker-cols');
        bodyEl = panel.querySelector('.kd-tracker-body');
        applySavedPosition();
        applySavedCollapsedState();
        attachDrag(panel.querySelector('.kd-tracker-title'));
        bodyEl.addEventListener('scroll', function () {
            headEl.scrollLeft = bodyEl.scrollLeft;
        });
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
        tapeOrd = -1;
        tapeCurOffset = 0;
        tapeCurLen = 0;
        prevPlayRow = -1;
        prevModPtr = 0;
        activeChans = null;
    }

    // Compute channels that ever produce a note in the song. Effort
    // capped at 64 patterns × 256 rows so a pathological song can't
    // stall on first frame.
    function computeActiveChannels(mp) {
        var nchans = libopenmpt._openmpt_module_get_num_channels(mp);
        var npats = libopenmpt._openmpt_module_get_num_patterns(mp);
        var active = [];
        var seen = new Array(nchans).fill(false);
        var maxPats = Math.min(npats, 64);
        for (var p = 0; p < maxPats; p++) {
            var nrows = libopenmpt._openmpt_module_get_pattern_num_rows(mp, p);
            var maxRows = Math.min(nrows, 256);
            for (var r = 0; r < maxRows; r++) {
                for (var c = 0; c < nchans; c++) {
                    if (seen[c]) continue;
                    if (getCmd(mp, p, r, c, 0) > 0) seen[c] = true;
                }
            }
            if (seen.every(Boolean)) break;
        }
        for (var i = 0; i < nchans; i++) if (seen[i]) active.push(i);
        if (active.length === 0) for (var j = 0; j < nchans; j++) active.push(j);
        return active;
    }

    // ---- effect-type → Furnace category --------------------------------
    // Mirrors guiConst.cpp's effectColor[] table for low effect types.
    var EFFECT_COLOR_SUFFIX = [
        'misc',    // 00
        'pitch',   // 01
        'pitch',   // 02
        'pitch',   // 03
        'pitch',   // 04
        'volume',  // 05
        'volume',  // 06
        'volume',  // 07
        'panning', // 08
        'speed',   // 09
        'volume',  // 0A
        'song',    // 0B
        'time',    // 0C
        'song',    // 0D
        'invalid', // 0E
        'speed'    // 0F
    ];
    function effectColorClass(typ) {
        if (typ <= 0) return 'misc';
        if (typ < EFFECT_COLOR_SUFFIX.length) return EFFECT_COLOR_SUFFIX[typ];
        return 'sysprim';
    }

    // Volume colour gradient — Furnace lerps PATTERN_VOLUME_MIN..MAX
    // (#008000 → #00FF00) by vol/64.
    function volumeShade(vol) {
        if (vol <= 0) return null;
        var t = Math.min(1, Math.max(0, vol / 64));
        var g = Math.floor(0x80 + (0xFF - 0x80) * t);
        return 'rgb(0,' + g + ',0)';
    }

    // Render the rows of one pattern as HTML. Returns {html, rows}.
    function renderPatternRows(mp, pat, chans, ordOffset) {
        if (pat < 0) return { html: '', rows: 0 };
        var nrows = libopenmpt._openmpt_module_get_pattern_num_rows(mp, pat);
        if (nrows <= 0) return { html: '', rows: 0 };
        var html = '';
        for (var r = 0; r < nrows; r++) {
            var rowIdx = ('0' + r.toString(16)).slice(-2).toUpperCase();
            // Furnace beat highlights (PATTERN_HI_1 every 4, HI_2 every 16).
            var beatCls = '';
            if (r % 16 === 0) beatCls = ' beat-2';
            else if (r % 4 === 0) beatCls = ' beat-1';
            // ord-context class so rows belonging to prev/next patterns
            // can be visually de-emphasised (Furnace dims them slightly).
            var ctxCls = ordOffset === 0 ? '' : ' ord-other';
            html += '<div class="row' + beatCls + ctxCls + '" data-ord="' + ordOffset + '" data-row="' + r + '">';
            html += '<span class="rowidx">' + rowIdx + '</span>';
            for (var k = 0; k < chans.length; k++) {
                var ch = chans[k];
                var note = getCmd(mp, pat, r, ch, 0);
                var inst = getCmd(mp, pat, r, ch, 1);
                var vol  = getCmd(mp, pat, r, ch, 2);
                var fxt  = getCmd(mp, pat, r, ch, 3);
                var fxp  = getCmd(mp, pat, r, ch, 4);

                var noteTxt = fmtNote(note);
                var instTxt = fmtHex2(inst);
                var volTxt = fmtVol(vol);
                var fxtTxt = fmtFxType(fxt);
                var fxpTxt = fmtFxParam(fxp);

                var clsN = note > 0 && note < 254 ? 'note' :
                           (note >= 254 ? 'note-special' : 'inactive');
                var clsI = inst > 0 ? 'inst' : 'inactive';
                var clsV = vol > 0 ? 'volume' : 'inactive';
                var fxColor = effectColorClass(fxt);
                var hasFx = (fxt > 0 || fxp > 0);
                var clsFt = hasFx ? ('fx fx-' + fxColor) : 'inactive';
                var clsFp = hasFx ? ('fx fx-' + fxColor) : 'inactive';

                var volStyle = '';
                if (vol > 0) {
                    var shade = volumeShade(vol);
                    if (shade) volStyle = ' style="color:' + shade + '"';
                }

                html += '<span class="cell">' +
                    '<i class="' + clsN + '">' + noteTxt + '</i>' +
                    '<i class="' + clsI + '">' + instTxt + '</i>' +
                    '<i class="' + clsV + '"' + volStyle + '>' + volTxt + '</i>' +
                    '<i class="' + clsFt + '">' + fxtTxt + '</i>' +
                    '<i class="' + clsFp + '">' + fxpTxt + '</i>' +
                    '</span>';
            }
            html += '</div>';
        }
        return { html: html, rows: nrows };
    }

    function buildHeader(chans) {
        var h = '<span class="rowidx">  </span>';
        for (var ci = 0; ci < chans.length; ci++) {
            h += '<span class="cell">' + ('0' + (chans[ci] + 1)).slice(-2) + '</span>';
        }
        headEl.innerHTML = h;
    }

    // Build the [prev | cur | next] tape. Called when order changes.
    function rebuildTape(mp, ord) {
        if (!activeChans) activeChans = computeActiveChannels(mp);
        buildHeader(activeChans);

        var nords = libopenmpt._openmpt_module_get_num_orders(mp);
        var prevOrdIdx = ord - 1;
        var nextOrdIdx = ord + 1;

        var prevPat = (prevOrdIdx >= 0)
            ? libopenmpt._openmpt_module_get_order_pattern(mp, prevOrdIdx) : -1;
        var curPat = libopenmpt._openmpt_module_get_order_pattern(mp, ord);
        var nextPat = (nextOrdIdx < nords)
            ? libopenmpt._openmpt_module_get_order_pattern(mp, nextOrdIdx) : -1;

        var prev = renderPatternRows(mp, prevPat, activeChans, -1);
        var cur  = renderPatternRows(mp, curPat,  activeChans, 0);
        var next = renderPatternRows(mp, nextPat, activeChans, 1);

        bodyEl.innerHTML = prev.html + cur.html + next.html;
        tapeOrd = ord;
        tapeCurOffset = prev.rows;
        tapeCurLen = cur.rows;
        prevPlayRow = -1;

        panel.style.setProperty('--kd-tracker-chans', activeChans.length);
        applyBodyPadding();
    }

    // Pad the body with half its visible height (minus half a row) on
    // top and bottom so the very first / very last tape row can be
    // centred under the play-head. Recompute lazily — only on rebuild
    // and when the body's clientHeight changes.
    function applyBodyPadding() {
        if (!bodyEl) return;
        var bodyH = bodyEl.clientHeight;
        var sample = bodyEl.children[tapeCurOffset] || bodyEl.children[0];
        var rowH = (sample && sample.offsetHeight) || 14;
        var pad = Math.max(0, Math.floor((bodyH - rowH) / 2));
        if (pad === prevTapePad) return;
        bodyEl.style.paddingTop = pad + 'px';
        bodyEl.style.paddingBottom = pad + 'px';
        prevTapePad = pad;
    }

    // Mark the playing row, scroll it to the body's vertical centre.
    // The bg tint on `.row.current` *is* the play-head — Furnace draws
    // it the same way (RowBg0 with PATTERN_PLAY_HEAD = white 25 %).
    function highlightRow(orderRelativeIdx) {
        if (!bodyEl) return;
        if (prevPlayRow >= 0) {
            var prevEl = bodyEl.children[tapeCurOffset + prevPlayRow];
            if (prevEl) prevEl.classList.remove('current');
        }
        var newTapeIdx = tapeCurOffset + orderRelativeIdx;
        var cur = bodyEl.children[newTapeIdx];
        if (cur) {
            cur.classList.add('current');
            var rowH = cur.offsetHeight || 14;
            var bodyH = bodyEl.clientHeight;
            // offsetTop is relative to the scrolling container (bodyEl).
            // To place the row at the visual centre we want
            //   rowTop - scrollTop === (bodyH - rowH) / 2
            // -> scrollTop = rowTop - (bodyH - rowH) / 2
            bodyEl.scrollTop = cur.offsetTop - (bodyH - rowH) / 2;
        }
        prevPlayRow = orderRelativeIdx;
    }

    function tick() {
        rafId = requestAnimationFrame(tick);

        if (!isChiptunePlaying()) {
            if (panel && panel.classList.contains('kd-tracker-on')) hidePanel();
            return;
        }

        if (!buildPanel()) return;

        var mp = modPtr();
        var curOrd = libopenmpt._openmpt_module_get_current_order(mp);
        var curRow = libopenmpt._openmpt_module_get_current_row(mp);

        if (mp !== prevModPtr) {
            prevModPtr = mp;
            tapeOrd = -1;
            activeChans = null;
        }

        if (curOrd !== tapeOrd) {
            rebuildTape(mp, curOrd);
            panel.classList.add('kd-tracker-on');
        }

        // body might have resized (panel drag, window resize, fullscreen)
        applyBodyPadding();

        if (curRow !== prevPlayRow && curRow >= 0 && curRow < tapeCurLen) {
            highlightRow(curRow);
        }
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
        rebuild: function () { tapeOrd = -1; activeChans = null; prevTapePad = -1; },
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

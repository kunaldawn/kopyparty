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
//     cmd 0=note  1=instrument  2=volume-effect (VolumeCommand type)
//         3=effect (EffectCommand type)  4=volume value  5=effect param
//   (libopenmpt's OPENMPT_MODULE_COMMAND_* enum — verified empirically:
//    a "set volume = v0F" cell reads c2=1, c4=15; an "O04" sample-offset
//    reads c3=10 (CMD_OFFSET), c5=4. The cmd-3 integer is OpenMPT's
//    internal EffectCommand enum, mapped to Furnace effect-colour
//    categories below. Exact glyphs for effect letters and special
//    notes come from libopenmpt's own formatter.)

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
        // regular notes only (1..120). openmpt note numbering: 61 = C-5,
        // so 1 = C-0. Special notes (key-off / cut / fade / PC) are >120
        // and rendered via libopenmpt's own glyph — see noteText().
        var idx = (n - 1) % 12;
        var oct = Math.floor((n - 1) / 12);
        return NOTE_NAMES[idx] + oct;
    }
    // 2-digit hex that always renders the value, including 0 → "00". Used
    // for the volume value and effect parameter: once the field is known
    // to be present (a volume/effect command exists), a 0 is a real "00",
    // not an empty cell — libopenmpt prints it that way too.
    function hex2(v) {
        return ('0' + (v & 0xFF).toString(16).toUpperCase()).slice(-2);
    }

    // Read a C string pointer from the emscripten heap. This build does
    // NOT expose libopenmpt.UTF8ToString on the module object, so probe
    // the known aliases (resolved lazily once the runtime is up).
    function rdStr(ptr) {
        if (!ptr) return '';
        var L = window.libopenmpt;
        var fn = (typeof L.UTF8ToString === 'function') ? L.UTF8ToString
               : (typeof L.Pointer_stringify === 'function') ? L.Pointer_stringify
               : (typeof window.UTF8ToString === 'function') ? window.UTF8ToString
               : null;
        return fn ? fn(ptr) : '';
    }

    // Pull the exact display glyph libopenmpt would print for one command
    // of one cell (note off "===", cut "^^^", fade "~~~", PC notes, and
    // the format-native effect letter such as IT "O" / MOD "9"). Allocates
    // an openmpt string we must free; only called for the minority of
    // cells that actually carry a special note or an effect.
    function fmtCmdStr(mp, pat, row, ch, cmd) {
        var ptr = libopenmpt._openmpt_module_format_pattern_row_channel_command(mp, pat, row, ch, cmd);
        if (!ptr) return '';
        var s = rdStr(ptr);
        if (libopenmpt._openmpt_free_string) libopenmpt._openmpt_free_string(ptr);
        return (s || '').replace(/^\s+|\s+$/g, '');
    }

    // note text for a cell: empty, a regular note, or libopenmpt's exact
    // special-note glyph (>120 == key-off/cut/fade/PC*).
    function noteText(mp, pat, row, ch, n) {
        if (n <= 0) return '...';
        if (n <= 120) return fmtNote(n);
        var s = fmtCmdStr(mp, pat, row, ch, 0);
        return s || '===';
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
        // recompute the centring padding only when the body actually
        // resizes (drag-resize, fullscreen, window resize) instead of every
        // animation frame — keeps the tick's hot path free of layout reads.
        if (window.ResizeObserver) {
            var ro = new ResizeObserver(function () {
                prevTapePad = -1;
                applyBodyPadding();
            });
            ro.observe(bodyEl);
        }
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
    // The cmd-3 integer is OpenMPT's internal EffectCommand enum (NOT the
    // format-native letter, and NOT Furnace's effect numbering). We map it
    // to Furnace's effect-colour buckets (guiConst.cpp: PITCH / VOLUME /
    // PANNING / SPEED / SONG / TIME / MISC / SYS / INVALID) so each effect
    // gets the colour Furnace would give the equivalent operation.
    // Enum values per OpenMPT soundlib/modcommand.h (stable for the common
    // 1..37 since the ModPlug era; the test build agrees — CMD_OFFSET=10,
    // CMD_CHANNELVOLUME=21). Unknown → 'sysprim'.
    var FX_CAT = {
        1: 'misc',     // ARPEGGIO
        2: 'pitch',    // PORTAMENTOUP
        3: 'pitch',    // PORTAMENTODOWN
        4: 'pitch',    // TONEPORTAMENTO
        5: 'pitch',    // VIBRATO
        6: 'volume',   // TONEPORTAVOL  (porta + vol-slide)
        7: 'volume',   // VIBRATOVOL    (vibrato + vol-slide)
        8: 'volume',   // TREMOLO
        9: 'panning',  // PANNING8
        10: 'misc',    // OFFSET
        11: 'volume',  // VOLUMESLIDE
        12: 'song',    // POSITIONJUMP
        13: 'volume',  // VOLUME
        14: 'song',    // PATTERNBREAK
        15: 'misc',    // RETRIG
        16: 'speed',   // SPEED  (ticks/row)
        17: 'time',    // TEMPO  (BPM)
        18: 'volume',  // TREMOR
        19: 'misc',    // MODCMDEX  (Exy extended)
        20: 'misc',    // S3MCMDEX  (Sxy extended)
        21: 'volume',  // CHANNELVOLUME
        22: 'volume',  // CHANNELVOLSLIDE
        23: 'volume',  // GLOBALVOLUME
        24: 'volume',  // GLOBALVOLSLIDE
        25: 'misc',    // KEYOFF
        26: 'pitch',   // FINEVIBRATO
        27: 'panning', // PANBRELLO
        28: 'pitch',   // XFINEPORTAUPDOWN
        29: 'panning', // PANNINGSLIDE
        30: 'misc',    // SETENVPOSITION
        31: 'misc',    // MIDI
        32: 'misc',    // SMOOTHMIDI
        33: 'misc',    // DELAYCUT
        34: 'misc',    // XPARAM
        35: 'pitch',   // FINETUNE
        36: 'pitch',   // FINETUNE_SMOOTH
        37: 'invalid', // DUMMY
        38: 'pitch', 39: 'pitch', 40: 'pitch', 41: 'pitch', // NOTESLIDE*
        42: 'misc', 43: 'misc', 44: 'misc', 45: 'misc',
        46: 'volume',  // VOLUME8
        47: 'misc',    // HMN_MEGA_ARP
        48: 'misc',    // MED_SYNTH_JUMP
        49: 'volume',  // AUTO_VOLUMESLIDE
        50: 'pitch', 51: 'pitch', 52: 'pitch', 53: 'pitch', 54: 'pitch', // AUTO_PORTA*
        55: 'pitch',   // TONEPORTA_DURATION
        56: 'volume',  // VOLUMEDOWN_DURATION
        57: 'volume'   // VOLUMEDOWN_ETX
    };
    function effectColorClass(typ) {
        if (typ <= 0) return 'misc';
        return FX_CAT[typ] || 'sysprim';
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
                // correct libopenmpt command indices (see file header):
                var note   = getCmd(mp, pat, r, ch, 0);   // note
                var inst   = getCmd(mp, pat, r, ch, 1);   // instrument
                var volCmd = getCmd(mp, pat, r, ch, 2);   // volume-effect type
                var fxt    = getCmd(mp, pat, r, ch, 3);   // effect type
                var volVal = getCmd(mp, pat, r, ch, 4);   // volume value
                var fxp    = getCmd(mp, pat, r, ch, 5);   // effect param

                var hasVol = (volCmd > 0 || volVal > 0);
                var hasFx  = (fxt > 0);

                var noteTxt = noteText(mp, pat, r, ch, note);
                var instTxt = inst > 0 ? hex2(inst) : '..';
                var volTxt  = hasVol ? hex2(volVal) : '..';
                // effect: format-native letter (IT "O", MOD "9", …) + param
                var fxtTxt  = hasFx ? fmtCmdStr(mp, pat, r, ch, 3) : '.';
                var fxpTxt  = hasFx ? hex2(fxp) : '..';

                var clsN = note <= 0 ? 'inactive' : (note > 120 ? 'note-special' : 'note');
                var clsI = inst > 0 ? 'inst' : 'inactive';
                var clsV = hasVol ? 'volume' : 'inactive';
                var fxColor = effectColorClass(fxt);
                var clsFt = hasFx ? ('fx fx-' + fxColor) : 'inactive';
                var clsFp = hasFx ? ('fx fx-' + fxColor) : 'inactive';

                var volStyle = '';
                if (hasVol) {
                    var shade = volumeShade(volVal);
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

    // channel label: libopenmpt channel name when the module defines one
    // (IT/XM/MPTM often do — Furnace shows these), else the 1-based number.
    function channelLabel(mp, ch) {
        var num = ('0' + (ch + 1)).slice(-2);
        try {
            var ptr = libopenmpt._openmpt_module_get_channel_name(mp, ch);
            if (ptr) {
                var s = rdStr(ptr);
                if (libopenmpt._openmpt_free_string) libopenmpt._openmpt_free_string(ptr);
                s = (s || '').replace(/^\s+|\s+$/g, '');
                if (s) return esc(num + ' ' + s);
            }
        } catch (e) {}
        return num;
    }

    function esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    function buildHeader(mp, chans) {
        var h = '<span class="rowidx">  </span>';
        for (var ci = 0; ci < chans.length; ci++) {
            h += '<span class="cell" title="' + esc(channelLabel(mp, chans[ci])) + '">' +
                 channelLabel(mp, chans[ci]) + '</span>';
        }
        headEl.innerHTML = h;
    }

    // Build the [prev | cur | next] tape. Called when order changes.
    function rebuildTape(mp, ord) {
        if (!activeChans) activeChans = computeActiveChannels(mp);
        buildHeader(mp, activeChans);

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

    // Rows advance at most ~20×/s even on fast modules, so polling at 60fps
    // is pure waste (and keeps the main thread busy alongside the chiptune
    // audio callback + visualizer). Cap the work to ~30fps. Body-padding is
    // no longer recomputed here every frame — a ResizeObserver handles size
    // changes (see buildPanel) — removing a per-frame layout read.
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

        if (mp !== prevModPtr) {
            prevModPtr = mp;
            tapeOrd = -1;
            activeChans = null;
        }

        if (curOrd !== tapeOrd) {
            rebuildTape(mp, curOrd);
            panel.classList.add('kd-tracker-on');
        }

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

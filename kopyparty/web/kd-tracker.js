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
// Data is pulled directly from libopenmpt:
//   _openmpt_module_get_num_channels(modPtr)
//   _openmpt_module_get_pattern_num_rows(modPtr, pat)
//   _openmpt_module_get_pattern_row_channel_command(modPtr, pat, row,
//                                                   chan, cmd)
//     cmd 0=note, 1=instr, 2=volume-col, 3=effect-type, 4=effect-param
//   _openmpt_module_get_current_pattern(modPtr)
//   _openmpt_module_get_current_row(modPtr)
//
// Per-pattern data (note/instr/vol/fx for every cell) is fetched once
// when the playing pattern changes and cached in the DOM. Per-frame
// work is just toggling `.current` and scrolling.

(function () {
    'use strict';

    var panel = null;
    var headEl = null;
    var bodyEl = null;
    var rafId = null;
    var prevPat = -1;
    var prevRow = -1;
    var prevModPtr = 0;
    var activeChans = null;       // array of channel indices used in song
    var dragState = null;
    var SAVE_KEY = 'kd_tracker_pos';

    // ---- libopenmpt note formatter (12-tone grid + special markers) ----
    var NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
    function fmtNote(n) {
        // 0  -> empty, 254 -> note-cut (===), 255 -> note-off (---)
        if (n <= 0) return '...';
        if (n === 254) return '^^^';
        if (n === 255) return '===';
        // openmpt encodes notes as `name + octave * 12` (1..119), where
        // 49 = A4 (440 Hz). Map back to "A-4" style.
        var idx = (n - 1) % 12;
        var oct = Math.floor((n - 1) / 12);
        return NOTE_NAMES[idx] + oct;
    }
    function fmtHex2(v) {
        if (v === 0) return '..';
        return ('0' + v.toString(16).toUpperCase()).slice(-2);
    }
    function fmtVol(v) {
        // openmpt vol-col returns volume value 0..64 (or special). 0 = empty.
        if (v <= 0) return '..';
        return ('0' + v.toString(16).toUpperCase()).slice(-2);
    }
    function fmtEffect(typ, param) {
        if (typ === 0 && param === 0) return '...';
        var t = String.fromCharCode(typ < 10 ? 48 + typ : 55 + typ); // 0..9, A..Z
        if (typ === 0) t = '.';
        return t + fmtHex2(param);
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
        // _openmpt_module_get_pattern_row_channel_command returns int8
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
            '<div class="kd-tracker-body-wrap">' +
                '<div class="kd-tracker-cursor" aria-hidden="true"></div>' +
                '<div class="kd-tracker-body"></div>' +
            '</div>';
        viz.appendChild(panel);
        headEl = panel.querySelector('.kd-tracker-cols');   // channel labels
        bodyEl = panel.querySelector('.kd-tracker-body');
        applySavedPosition();
        applySavedCollapsedState();
        attachDrag(panel.querySelector('.kd-tracker-title'));
        // Keep the channel-label header horizontally aligned with the
        // body when the user pans through many channels.
        bodyEl.addEventListener('scroll', function () {
            headEl.scrollLeft = bodyEl.scrollLeft;
        });
        // toggle (minimize/restore)
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
        prevPat = -1;
        prevRow = -1;
        prevModPtr = 0;
        activeChans = null;
    }

    // Compute the set of channels that ever produce a note in the
    // entire song. If a channel is silent across all patterns it's
    // useless to display — modules often declare more channels than
    // they actually use. Cap effort at ~64 patterns × 256 rows so a
    // pathologically long song doesn't stall on the first frame.
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
                    // command 0 = note. >0 means a note is set.
                    if (getCmd(mp, p, r, c, 0) > 0) seen[c] = true;
                }
            }
            // early-out: all channels confirmed active
            if (seen.every(Boolean)) break;
        }
        for (var i = 0; i < nchans; i++) if (seen[i]) active.push(i);
        // fallback: if detection failed (e.g. only effect columns used),
        // show all declared channels rather than nothing.
        if (active.length === 0) for (var j = 0; j < nchans; j++) active.push(j);
        return active;
    }

    // ---- effect-type → Furnace category ---------------------------------
    // Mirrors guiConst.cpp's effectColor[] table: lower 16 effects map to
    // PITCH/VOLUME/PANNING/SPEED/SONG/TIME/INVALID/MISC. Returns the
    // CSS class suffix; the colors live in kd-theme.css.
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
        if (typ < 0 || typ === 0) return 'misc';
        if (typ < EFFECT_COLOR_SUFFIX.length) return EFFECT_COLOR_SUFFIX[typ];
        // anything beyond the 0..15 range: Furnace tags it as a system
        // command. We keep them under the SYS_PRIMARY (lime) bucket.
        return 'sysprim';
    }

    // Volume colour gradient — Furnace lerps PATTERN_VOLUME_MIN..MAX
    // (#008000 → #00FF00) by vol/64. We just expose the lerp ratio
    // through a CSS variable so the cell paints itself with hsl().
    function volumeShade(vol) {
        if (vol <= 0) return null;
        var max = 64;
        var t = Math.min(1, Math.max(0, vol / max));
        // green channel ramps 0x80 → 0xFF
        var g = Math.floor(0x80 + (0xFF - 0x80) * t);
        return 'rgb(0,' + g + ',0)';
    }

    function rebuildPattern(mp, pat) {
        var nrows = libopenmpt._openmpt_module_get_pattern_num_rows(mp, pat);
        if (!activeChans) activeChans = computeActiveChannels(mp);

        // header row — channel labels for active channels only
        var headHtml = '<span class="rowidx">  </span>';
        for (var ci = 0; ci < activeChans.length; ci++) {
            headHtml += '<span class="cell">' +
                ('0' + (activeChans[ci] + 1)).slice(-2) +
                '</span>';
        }
        headEl.innerHTML = headHtml;

        // body — every row × each active channel. Build as a single
        // string for one innerHTML hit (fastest in modern engines).
        var html = '';
        for (var r = 0; r < nrows; r++) {
            var rowIdx = ('0' + r.toString(16)).slice(-2).toUpperCase();
            // Furnace-style beat highlights:
            //   row % 16 == 0 → highlight 2 (light blue band)
            //   row %  4 == 0 → highlight 1 (light grey band)
            var beatCls = '';
            if (r % 16 === 0) beatCls = ' beat-2';
            else if (r % 4 === 0) beatCls = ' beat-1';
            html += '<div class="row' + beatCls + '" data-row="' + r + '">';
            html += '<span class="rowidx">' + rowIdx + '</span>';
            for (var k = 0; k < activeChans.length; k++) {
                var ch = activeChans[k];
                var note = getCmd(mp, pat, r, ch, 0);
                var inst = getCmd(mp, pat, r, ch, 1);
                var vol  = getCmd(mp, pat, r, ch, 2);
                var fxt  = getCmd(mp, pat, r, ch, 3);
                var fxp  = getCmd(mp, pat, r, ch, 4);

                var noteTxt = fmtNote(note);
                var instTxt = fmtHex2(inst);
                var volTxt = fmtVol(vol);
                var fxTxt = fmtEffect(fxt, fxp);

                // class names follow Furnace's GUI_COLOR_PATTERN_* roles
                var clsN = note > 0 ? 'note' : 'inactive';
                var clsI = inst > 0 ? 'inst' : 'inactive';
                var clsV = vol > 0 ? 'volume' : 'inactive';
                var fxColor = effectColorClass(fxt);
                var clsF = (fxt > 0 || fxp > 0) ? ('fx fx-' + fxColor) : 'inactive';

                var volStyle = '';
                if (vol > 0) {
                    var shade = volumeShade(vol);
                    if (shade) volStyle = ' style="color:' + shade + '"';
                }

                html += '<span class="cell">' +
                    '<i class="' + clsN + '">' + noteTxt + '</i>' +
                    '<i class="' + clsI + '">' + instTxt + '</i>' +
                    '<i class="' + clsV + '"' + volStyle + '>' + volTxt + '</i>' +
                    '<i class="' + clsF + '">' + fxTxt + '</i>' +
                    '</span>';
            }
            html += '</div>';
        }
        bodyEl.innerHTML = html;

        panel.style.setProperty('--kd-tracker-chans', activeChans.length);
        prevRow = -1;
    }

    // Furnace-style scroll: the play-head bar is a fixed overlay at
    // the body's vertical centre (rendered by CSS as
    // `.kd-tracker-cursor`); the playing row is positioned UNDER it by
    // scrolling the body so `currentRow.offsetTop === cursorTop`.
    // We also tag the row itself with `.current` so the row index +
    // any decorative styling can react to "this is the playing row"
    // without driving the centring logic.
    function highlightRow(idx) {
        if (!bodyEl) return;
        if (prevRow >= 0) {
            var prev = bodyEl.children[prevRow];
            if (prev) prev.classList.remove('current');
        }
        var cur = bodyEl.children[idx];
        if (cur) {
            cur.classList.add('current');
            // pin the playing row to the visual centre of the body
            var rowH = cur.offsetHeight || 14;
            var bodyH = bodyEl.clientHeight;
            bodyEl.scrollTop = cur.offsetTop - (bodyH - rowH) / 2;
        }
        prevRow = idx;
    }

    function tick() {
        rafId = requestAnimationFrame(tick);

        if (!isChiptunePlaying()) {
            if (panel && panel.classList.contains('kd-tracker-on')) hidePanel();
            return;
        }

        if (!buildPanel()) return;

        var mp = modPtr();
        var curPat = libopenmpt._openmpt_module_get_current_pattern(mp);
        var curRow = libopenmpt._openmpt_module_get_current_row(mp);

        if (mp !== prevModPtr) {
            prevModPtr = mp;
            prevPat = -1;
            activeChans = null;       // recompute for new song
        }

        if (curPat !== prevPat) {
            rebuildPattern(mp, curPat);
            prevPat = curPat;
            panel.classList.add('kd-tracker-on');
        }

        if (curRow !== prevRow && curRow >= 0) {
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
            // clamp so the panel stays within the viz canvas
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
            // persist the user's chosen position
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
        // touch support
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

    // expose for debugging
    window.kdTracker = {
        rebuild: function () { prevPat = -1; activeChans = null; },
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

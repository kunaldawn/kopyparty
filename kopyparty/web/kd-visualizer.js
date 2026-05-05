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
    var SVG_FS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5"/></svg>';
    var SVG_CLOSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><polygon points="6,9 18,9 12,17"/></svg>';

    var depsLoaded = false;
    var depsLoading = null;

    var viz = null;
    var canvas = null;
    var panel = null;
    var nameEl = null;
    var rafId = null;
    var presets = null;
    var presetKeys = null;
    var presetIdx = 0;
    var connectedSrc = null;

    function rootSlash() {
        return (window.SR || '') + '/.kpr/w/deps/';
    }

    function loadDeps() {
        if (depsLoaded) return Promise.resolve();
        if (depsLoading) return depsLoading;
        var base = rootSlash();
        depsLoading = new Promise(function (resolve, reject) {
            var s1 = document.createElement('script');
            s1.src = base + 'butterchurn.min.js';
            s1.onload = function () {
                var s2 = document.createElement('script');
                s2.src = base + 'butterchurnPresets.min.js';
                s2.onload = function () { depsLoaded = true; resolve(); };
                s2.onerror = function () { reject(new Error('butterchurnPresets load failed')); };
                document.head.appendChild(s2);
            };
            s1.onerror = function () { reject(new Error('butterchurn load failed')); };
            document.head.appendChild(s1);
        });
        return depsLoading;
    }

    function buildPanel() {
        if (panel) return;
        panel = document.createElement('div');
        panel.id = 'kd-viz-panel';
        panel.innerHTML =
            '<canvas id="kd-viz-canvas"></canvas>' +
            '<div id="kd-viz-info"><span id="kd-viz-name">…</span></div>' +
            '<div id="kd-viz-ctrl">' +
                '<a href="#" id="kd-viz-prev" title="previous preset (left arrow)">' + SVG_PREV + '</a>' +
                '<a href="#" id="kd-viz-rand" title="random preset (R)">' + SVG_RAND + '</a>' +
                '<a href="#" id="kd-viz-next" title="next preset (right arrow)">' + SVG_NEXT + '</a>' +
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
        var on = function (id, fn) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('click', function (e) { e.preventDefault(); fn(); });
        };
        on('kd-viz-prev', function () { stepPreset(-1); });
        on('kd-viz-next', function () { stepPreset(1); });
        on('kd-viz-rand', function () { randomPreset(); });
        on('kd-viz-fs', toggleFullscreen);
        on('kd-viz-close', closePanel);
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
                pixelRatio: window.devicePixelRatio || 1,
                textureRatio: 1
            });
        } catch (e) {
            console.warn('kdVisualizer createVisualizer failed:', e);
            return false;
        }

        try {
            var bcp = window.butterchurnPresets.default || window.butterchurnPresets;
            presets = (typeof bcp.getPresets === 'function') ? bcp.getPresets() : bcp;
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
        try {
            viz.loadPreset(presets[key], typeof blendSec === 'number' ? blendSec : 1.5);
            if (nameEl) {
                var pretty = key.replace(/^[^-]+ - /, '');  // strip "AuthorName - " prefix
                nameEl.textContent = pretty.length > 70 ? pretty.slice(0, 67) + '…' : pretty;
            }
        } catch (e) {
            console.warn('kdVisualizer applyPreset failed:', e);
        }
    }

    function stepPreset(delta) {
        if (!presetKeys || !presetKeys.length) return;
        presetIdx = (presetIdx + delta + presetKeys.length) % presetKeys.length;
        applyPreset();
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
    }

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
        var dpr = window.devicePixelRatio || 1;
        var w = Math.max(64, Math.floor(r.width));
        var h = Math.max(64, Math.floor(r.height));
        var W = Math.floor(w * dpr);
        var H = Math.floor(h * dpr);
        if (canvas.width !== W || canvas.height !== H) {
            canvas.width = W;
            canvas.height = H;
            if (viz && typeof viz.setRendererSize === 'function') {
                try { viz.setRendererSize(W, H); } catch (e) {}
            }
        }
    }

    function renderLoop() {
        rafId = requestAnimationFrame(renderLoop);
        if (!viz || !panel || !panel.classList.contains('kd-viz-open')) return;
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
            ensureViz();
            panel.classList.add('kd-viz-open');
            // wait for the height transition to complete before sizing
            // the GL canvas to its final dimensions.
            setTimeout(function () { resizeCanvas(); }, 380);
            if (rafId === null) renderLoop();
            updateToggleState();
        }).catch(function (e) {
            console.warn('kdVisualizer load failed:', e && e.message || e);
        });
    }

    function closePanel() {
        if (panel) panel.classList.remove('kd-viz-open');
        updateToggleState();
    }

    function togglePanel() {
        if (isOpen()) closePanel(); else openPanel();
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
        btn.title = 'visualizer';
        btn.innerHTML = SVG_VIZ;
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
        resizeT = setTimeout(resizeCanvas, 120);
    });

    // keyboard nav — only when panel is open
    document.addEventListener('keydown', function (e) {
        if (!isOpen()) return;
        if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName)) return;
        if (e.key === 'Escape') closePanel();
        else if (e.key === 'ArrowLeft') stepPreset(-1);
        else if (e.key === 'ArrowRight') stepPreset(1);
        else if (e.key === 'r' || e.key === 'R') randomPreset();
        else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    });

    window.kdVisualizer = {
        toggle: togglePanel,
        open: openPanel,
        close: closePanel,
        // kd-chiptune.js calls this when the audio source changes
        // (track switch on chiptune, MediaElementSource freshly wrapped
        // for browser-native audio).
        onAudioChanged: function () {
            connectedSrc = null;
            if (viz && isOpen()) connectAudio(true);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { tryInstallToggle(0); });
    } else {
        tryInstallToggle(0);
    }
})();

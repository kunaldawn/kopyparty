// kd-chiptune.js — tracker-format playback for kopyparty.
//
// Browsers cannot natively decode .mod / .it / .s3m / .xm / .stm / .mptm,
// and copyparty's server-side opus transcode (?th=opus) returns 415 for
// these formats in this fork. This shim downloads libopenmpt.js (a JS/WASM
// port of the OpenMPT module decoder) on first use and routes tracker
// playback through chiptune2.js, while everything else (mp3, ogg, opus,
// flac, m4a, …) keeps using copyparty's HTMLAudioElement path.
//
// We hook by replacing window.play with a wrapper that detects the file
// extension. When a tracker file is requested, we swap mp.au for a
// ChiptuneAudio shim that mimics enough of HTMLAudioElement for copyparty's
// existing widget UI (progress canvas, prev/play/next buttons, volume,
// timeupdate events, ended event for next-track) to keep working.

(function () {
    'use strict';

    var TRACKER_RE = /\.(it|itgz|itxz|itz|mod|mdgz|mdxz|mdz|mo3|mt2|mptm|s3m|s3gz|s3xz|s3z|stm|xm|xmgz|xmxz|xmz)(\?|$)/i;

    var lib_loaded = false;
    var lib_loading = null;

    function rootSlash() {
        return (window.SR || '') + '/.kpr/w/deps/';
    }

    // Load libopenmpt.js + chiptune2.js once. libopenmpt.js opens with
    //     var Module = typeof libopenmpt !== "undefined" ? libopenmpt : {};
    // so we pre-seed window.libopenmpt with locateFile (so the Emscripten
    // runtime finds libopenmpt.js.mem next to the .js) and an
    // onRuntimeInitialized callback that triggers chiptune2.js loading.
    function loadLibs() {
        if (lib_loaded) return Promise.resolve();
        if (lib_loading) return lib_loading;

        var base = rootSlash();
        lib_loading = new Promise(function (resolve, reject) {
            var seed = window.libopenmpt = window.libopenmpt || {};
            seed.locateFile = function (name) { return base + name; };

            var loaded2 = false;
            var ready = function () {
                if (loaded2) return;
                loaded2 = true;
                var s2 = document.createElement('script');
                s2.src = base + 'chiptune2.js';
                s2.onload = function () { lib_loaded = true; resolve(); };
                s2.onerror = function (e) { reject(new Error('chiptune2.js load failed')); };
                document.head.appendChild(s2);
            };

            var prevInit = seed.onRuntimeInitialized;
            seed.onRuntimeInitialized = function () {
                if (typeof prevInit === 'function') prevInit();
                ready();
            };

            var s1 = document.createElement('script');
            s1.src = base + 'libopenmpt.js';
            s1.onerror = function () { reject(new Error('libopenmpt.js load failed')); };
            // libopenmpt may have already initialized synchronously by the
            // time onload fires; if so, fire ready() directly.
            s1.onload = function () {
                if (window.libopenmpt && window.libopenmpt.calledRun) ready();
            };
            document.head.appendChild(s1);
        });
        return lib_loading;
    }

    // singleton ChiptuneJsPlayer (one Web Audio context for everything)
    var cplayer = null;
    function getPlayer() {
        if (!cplayer) {
            var cfg = new ChiptuneJsConfig(0 /*repeat*/, 50 /*stereoSep*/, 2 /*interp*/, null);
            cplayer = new ChiptuneJsPlayer(cfg);
        }
        return cplayer;
    }

    // Minimal HTMLAudioElement-like shim backed by chiptune2.
    // Implements the surface that copyparty's audio widget actually uses:
    //   src setter, play(), pause(), currentTime get/set, duration get,
    //   paused get, volume get/set, loop get/set, error get,
    //   onended/onerror/onloadeddata/onloadedmetadata/onprogress, plus
    //   addEventListener/removeEventListener for timeupdate, ended, etc.
    function ChiptuneAudio() {
        this._url = '';
        this._vol = 1;
        this._duration = NaN;
        this._paused = true;
        this._loop = false;
        this._error = null;
        this._loadId = 0;
        this._timer = null;
        this._listeners = {};

        // copyparty bookkeeping fields — assigned externally, kept here
        // so its `mp.au.tid`, `mp.au.osrc`, etc. accesses don't throw.
        this.tid = null;
        this.osrc = null;
        this.rsrc = null;
        this.evp = '';
        this.pt0 = 0;
        this.ld = 0;
        this.ded = 0;

        this.networkState = 0;  // NETWORK_EMPTY
        this.readyState = 0;    // HAVE_NOTHING
        // buffered TimeRanges shim — once src is loaded we mutate this so
        // pbar.drawbuf paints the entire bar as buffered (chiptunes are
        // fully decoded into memory once libopenmpt parses them).
        var self = this;
        this.buffered = {
            length: 0,
            start: function (i) { return 0; },
            end: function (i) { return self._duration || 0; }
        };
    }

    ChiptuneAudio.prototype.addEventListener = function (name, cb) {
        (this._listeners[name] = this._listeners[name] || []).push(cb);
    };

    ChiptuneAudio.prototype.removeEventListener = function (name, cb) {
        var arr = this._listeners[name]; if (!arr) return;
        var i = arr.indexOf(cb); if (i >= 0) arr.splice(i, 1);
    };

    ChiptuneAudio.prototype._fire = function (name) {
        var ev = { type: name, target: this };
        var arr = (this._listeners[name] || []).slice();
        for (var i = 0; i < arr.length; i++) {
            try { arr[i].call(this, ev); } catch (e) { console.error(e); }
        }
        var on = this['on' + name];
        if (typeof on === 'function') {
            try { on.call(this, ev); } catch (e) { console.error(e); }
        }
    };

    ChiptuneAudio.prototype._startTimer = function () {
        this._stopTimer();
        var self = this;
        this._timer = setInterval(function () {
            self._fire('timeupdate');
        }, 250);
    };

    ChiptuneAudio.prototype._stopTimer = function () {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    };

    Object.defineProperty(ChiptuneAudio.prototype, 'src', {
        get: function () { return this._url; },
        set: function (url) {
            this._url = url;
            this._duration = NaN;
            this._error = null;
            this._loadId++;
            this._stopTimer();
            this.networkState = 2;  // NETWORK_LOADING
            this.readyState = 0;
            if (!url) return;

            var self = this;
            var loadId = this._loadId;
            var player = getPlayer();
            player.unlock();
            player.stop();

            // chiptune2's onError/onEnded handlers are append-only with
            // no removal API; install them once globally and route via
            // the active shim instance pointer.
            installPlayerCallbacks();
            activeShim = self;

            player.load(url, function (buffer) {
                if (loadId !== self._loadId) return; // superseded
                if (!buffer) {
                    self._error = { code: 4, message: 'libopenmpt: empty buffer' };
                    self._fire('error');
                    return;
                }
                player.play(buffer);
                self._duration = player.duration() || NaN;
                self._paused = false;
                self.readyState = 4;   // HAVE_ENOUGH_DATA
                self.networkState = 1; // NETWORK_IDLE
                // pretend the entire track is buffered — the libopenmpt
                // module is fully resident in memory after load, so this
                // is accurate. lets pbar.drawbuf paint the green fill.
                self.buffered.length = 1;
                self.applyVolume();
                self.applyLoop();
                self._fire('loadeddata');
                self._fire('loadedmetadata');
                self._fire('canplay');
                self._fire('durationchange');
                // 'playing' is the event copyparty's mp.set_ev wires to
                // mpui.progress_updater, which in turn calls
                // widget.paused(false) → flips bplay icon to ⏸ and starts
                // the bar redraw loop. Without this, the widget never
                // animates while a chiptune is playing.
                self._fire('playing');
                self._fire('play');
                self._startTimer();
            });
        }
    });

    Object.defineProperty(ChiptuneAudio.prototype, 'currentTime', {
        get: function () {
            var p = getPlayer();
            if (!p.currentPlayingNode) return 0;
            try { return p.getCurrentTime() || 0; } catch (e) { return 0; }
        },
        set: function (t) {
            var p = getPlayer();
            if (p.currentPlayingNode && window.libopenmpt && libopenmpt._openmpt_module_set_position_seconds) {
                try { libopenmpt._openmpt_module_set_position_seconds(p.currentPlayingNode.modulePtr, t); }
                catch (e) { console.warn('chiptune seek failed', e); }
            }
        }
    });

    Object.defineProperty(ChiptuneAudio.prototype, 'duration', {
        get: function () { return this._duration; }
    });

    Object.defineProperty(ChiptuneAudio.prototype, 'paused', {
        get: function () { return this._paused; }
    });

    Object.defineProperty(ChiptuneAudio.prototype, 'volume', {
        get: function () { return this._vol; },
        set: function (v) { this._vol = v; this.applyVolume(); }
    });

    Object.defineProperty(ChiptuneAudio.prototype, 'loop', {
        get: function () { return this._loop; },
        set: function (v) { this._loop = !!v; this.applyLoop(); }
    });

    Object.defineProperty(ChiptuneAudio.prototype, 'error', {
        get: function () { return this._error; }
    });

    ChiptuneAudio.prototype.applyVolume = function () {
        var p = getPlayer();
        if (!p.currentPlayingNode || !window.libopenmpt) return;
        if (!libopenmpt._openmpt_module_set_render_param) return;
        // OPENMPT_MODULE_RENDER_MASTERGAIN_MILLIBEL = 1
        // mb = 2000 * log10(v)  (so 1.0 → 0 mb, 0.5 → -602 mb)
        var v = this._vol;
        if (v < 0.001) v = 0.001;
        var mb = Math.round(2000 * Math.log(v) / Math.LN10);
        try { libopenmpt._openmpt_module_set_render_param(p.currentPlayingNode.modulePtr, 1, mb); }
        catch (e) {}
    };

    ChiptuneAudio.prototype.applyLoop = function () {
        var p = getPlayer();
        if (!p.currentPlayingNode || !window.libopenmpt) return;
        if (!libopenmpt._openmpt_module_set_repeat_count) return;
        try { libopenmpt._openmpt_module_set_repeat_count(p.currentPlayingNode.modulePtr, this._loop ? -1 : 0); }
        catch (e) {}
    };

    ChiptuneAudio.prototype.play = function () {
        var p = getPlayer();
        if (p.currentPlayingNode && p.currentPlayingNode.paused) {
            p.currentPlayingNode.unpause();
        }
        this._paused = false;
        this._fire('play');
        this._fire('playing');
        this._startTimer();
        return Promise.resolve();
    };

    ChiptuneAudio.prototype.pause = function () {
        var p = getPlayer();
        if (p.currentPlayingNode && !p.currentPlayingNode.paused) {
            p.currentPlayingNode.pause();
        }
        this._paused = true;
        this._stopTimer();
        this._fire('pause');
    };

    ChiptuneAudio.prototype.canPlayType = function (mime) {
        return /^audio\/x?-?(mod|it|s3m|xm|stm|mptm|openmpt)/i.test(mime || '') ? 'probably' : '';
    };

    ChiptuneAudio.prototype.load = function () { /* no-op */ };

    // chiptune2 only supports global onEnded/onError handlers (push-only).
    // Route them to the currently active shim instance.
    var activeShim = null;
    var callbacksInstalled = false;
    function installPlayerCallbacks() {
        if (callbacksInstalled) return;
        callbacksInstalled = true;
        var p = getPlayer();
        p.onEnded(function () {
            if (activeShim) {
                activeShim._paused = true;
                activeShim._stopTimer();
                activeShim._fire('ended');
            }
        });
        p.onError(function (info) {
            if (activeShim) {
                activeShim._error = { code: 4, message: 'libopenmpt: ' + (info && info.type) };
                activeShim._fire('error');
            }
        });
    }

    // Decide whether `tid` (a copyparty track id) resolves to a tracker file.
    function trackUrlFor(tid) {
        if (!window.mp || !window.mp.tracks) return '';
        var u = window.mp.tracks[tid];
        if (typeof u === 'string') return u;
        if (u && typeof u === 'object' && typeof u.url === 'string') return u.url;
        return '';
    }

    function isTrackerTid(tid) {
        var u = trackUrlFor(tid);
        return !!u && TRACKER_RE.test(u);
    }

    // Replace mp.au with a ChiptuneAudio shim, run copyparty's normal
    // bookkeeping (set_ev, widget.open, highlight active row), then point
    // the shim at the raw track URL (without ?th=opus).
    function playTracker(tn, seek) {
        if (!window.mp.order || tn < 0 || tn >= window.mp.order.length) return;
        var tid = window.mp.order[tn];
        var url = trackUrlFor(tid);
        if (!url) return;

        // Stop any in-flight HTMLAudioElement.
        if (window.mp.au && !(window.mp.au instanceof ChiptuneAudio)) {
            try { window.mp.au.pause(); } catch (e) {}
            try { window.mp.au.src = ''; } catch (e) {}
        }

        if (!(window.mp.au instanceof ChiptuneAudio)) {
            window.mp.au = new ChiptuneAudio();
            window.mp.au2 = new ChiptuneAudio(); // unused — chiptune doesn't preload
            try { window.mp.set_ev(); } catch (e) {}
            try { window.widget.open(); } catch (e) {}
        }

        window.mp.au.tid = tid;
        window.mp.au.osrc = url;
        window.mp.au.rsrc = url;
        try { window.mp.au.evp = window.get_evpath(); } catch (e) {}
        window.mp.au.pt0 = Date.now();
        window.mp.au.src = url;
        try { window.mp.au.volume = window.mp.expvol(window.mp.vol); } catch (e) {}

        // highlight active row + grid item, exactly like copyparty's play()
        var trs = document.querySelectorAll('#files tr.play');
        for (var a = 0; a < trs.length; a++) trs[a].classList.remove('play');
        var t_a = document.getElementById('a' + tid);
        if (t_a) {
            // un-act others
            var acts = document.querySelectorAll('#ggrid > a.act, #files a.act');
            for (var b = 0; b < acts.length; b++) acts[b].classList.remove('act');
            t_a.classList.add('act');
            var t_tr = t_a.closest && t_a.closest('tr');
            if (t_tr) t_tr.classList.add('play');
        }
        if (window.thegrid && window.thegrid.loadsel) {
            try { window.thegrid.loadsel(); } catch (e) {}
        }

        // Apply seek if requested (copyparty passes seconds).
        if (seek) {
            setTimeout(function () { window.mp.au.currentTime = seek; }, 50);
        }
    }

    // Wrap window.play. The wrapper dispatches based on whether the target
    // track is a tracker module; everything else routes to the original.
    var origPlay = null;
    function installHook() {
        if (typeof window.play !== 'function' || typeof window.mp === 'undefined') return false;
        if (origPlay) return true;
        origPlay = window.play;

        window.play = function (tid, is_ev, seek) {
            if (!window.mp || !window.mp.order || !window.mp.order.length) {
                return origPlay.apply(this, arguments);
            }
            // Resolve to numeric index, copying copyparty's logic.
            var tn = tid;
            if ((tn + '').indexOf('f-') === 0) tn = window.mp.order.indexOf(tn);
            if (typeof tn !== 'number') tn = parseInt(tn, 10);
            if (isNaN(tn)) return origPlay.apply(this, arguments);

            // Bounds wrap, like copyparty does.
            if (tn >= window.mp.order.length || tn < 0) {
                return origPlay.apply(this, arguments);
            }

            var resolved = window.mp.order[tn];
            if (!isTrackerTid(resolved)) {
                // Non-tracker — clean up any chiptune state so the original
                // play creates a fresh HTMLAudioElement.
                if (window.mp.au instanceof ChiptuneAudio) {
                    try { window.mp.au.pause(); } catch (e) {}
                    try { getPlayer().stop(); } catch (e) {}
                    activeShim = null;
                    window.mp.au = null;
                    window.mp.au2 = null;
                }
                return origPlay.apply(this, arguments);
            }

            // Tracker path. Load libs (lazy) then play.
            loadLibs().then(function () {
                playTracker(tn, seek);
            }).catch(function (err) {
                console.error('kd-chiptune: lib load failed', err);
                // Fall back — the original play will set ?th=opus and the
                // browser will report a Format error, which is at least
                // visible to the user.
                if (origPlay) origPlay(tid, is_ev, seek);
            });
        };
        return true;
    }

    function tryInstall(retries) {
        if (installHook()) return;
        if (retries > 100) {
            console.warn('kd-chiptune: window.play never appeared');
            return;
        }
        setTimeout(function () { tryInstall(retries + 1); }, 100);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { tryInstall(0); });
    } else {
        tryInstall(0);
    }

    // Expose a few helpers for debugging from the console.
    window.kdChiptune = {
        TRACKER_RE: TRACKER_RE,
        isTracker: function (u) { return TRACKER_RE.test(u || ''); },
        getPlayer: getPlayer,
        ChiptuneAudio: ChiptuneAudio
    };

    // ===== Player UX patches (independent of chiptune routing) =====
    //
    // These run after browser.js has built `pbar` (the progress-bar
    // controller) and after window.play has been wrapped. They:
    //   1. Override pbar.drawpos so the time labels (mm:ss / mm:ss) sit
    //      at canvas y = h*2/3, matching the volume canvas's text y
    //      and removing the visual misalignment between the two.
    //   2. Fetch + decode each browser-native audio file with
    //      AudioContext.decodeAudioData, render a peak-sample waveform
    //      to a data URL, and feed it to pbar.loadwaves so the empty
    //      bar gets the same waveform overlay as upstream copyparty
    //      (which renders waveforms server-side via ffmpeg — disabled
    //      in this fork by --no-thumb). Skipped for tracker formats
    //      because we don't expose libopenmpt's PCM stream.

    var drawposPatched = false;

    function patchDrawpos() {
        if (drawposPatched) return true;
        if (!window.pbar || typeof window.pbar.drawpos !== 'function') return false;
        if (typeof window.s2ms !== 'function') return false;

        var orig = window.pbar.drawpos;
        window.pbar.drawpos = function () {
            orig.apply(this, arguments);
            try {
                if (!window.mp || !window.mp.au) return;
                var pc = window.pbar.pos;
                var bc = window.pbar.buf;
                if (!pc || !pc.ctx || !bc) return;
                var apos = window.mp.au.currentTime;
                var adur = window.mp.au.duration;
                if (!isFinite(adur) || !isFinite(apos) || apos < 0 || adur < apos) return;
                if (!window.widget || !window.widget.is_open) return;

                var pctx = pc.ctx;
                // Erase bottom-third strip where copyparty drew text at y=h*0.94
                var stripY = Math.floor(pc.h * 0.7);
                var stripH = pc.h - stripY;
                pctx.clearRect(0, stripY, pc.w, stripH);

                // Re-draw the position cursor in the strip we just cleared
                var sm = bc.w * 1.0 / adur;
                var x = sm * apos;
                var cw = 8;
                pctx.fillStyle = '#573'; pctx.fillRect((x - cw / 2) - 1, stripY, cw + 2, stripH);
                pctx.fillStyle = '#dfc'; pctx.fillRect((x - cw / 2), stripY, cw, stripH);

                // Re-draw the time labels at y = h*2/3 (same as volume).
                pctx.font = '.9em sans-serif';
                pctx.fillStyle = '#fff';
                pctx.strokeStyle = 'rgba(24,56,0,0.5)';
                pctx.lineWidth = 2.5;
                var t1 = window.s2ms(adur);
                var t2 = window.s2ms(apos);
                var m1 = pctx.measureText(t1);
                var m1b = pctx.measureText(t1 + ':88');
                var m2 = pctx.measureText(t2);
                var yt = pc.h * 0.667;
                var xt1 = pc.w - (m1.width + 12);
                var xt2 = x < m1.width * 1.4 ? (x + 12)
                    : (Math.min(pc.w - m1b.width, x - 12) - m2.width);
                pctx.strokeText(t1, xt1 + 1, yt + 1);
                pctx.strokeText(t2, xt2 + 1, yt + 1);
                pctx.strokeText(t1, xt1, yt);
                pctx.strokeText(t2, xt2, yt);
                pctx.fillText(t1, xt1, yt);
                pctx.fillText(t2, xt2, yt);
            } catch (e) {
                // never let the patch crash the original drawpos
                console.warn('kd-chiptune drawpos patch error:', e);
            }
        };
        drawposPatched = true;
        return true;
    }

    function tryPatchDrawpos(retries) {
        if (patchDrawpos()) return;
        if (retries > 100) return;
        setTimeout(function () { tryPatchDrawpos(retries + 1); }, 100);
    }

    // ----- client-side waveform -----
    var waveCache = Object.create(null);
    var waveAc = null;

    function audioCtx() {
        if (waveAc) return waveAc;
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { waveAc = new AC(); } catch (e) { return null; }
        return waveAc;
    }

    function generateWaveform(url) {
        if (!url || typeof url !== 'string') return;
        if (waveCache[url] === 'pending' || waveCache[url] === 'failed') return;
        if (waveCache[url]) {
            try { window.pbar && window.pbar.loadwaves && window.pbar.loadwaves(waveCache[url]); }
            catch (e) {}
            return;
        }
        var ac = audioCtx();
        if (!ac || !window.pbar || !window.pbar.loadwaves) return;

        waveCache[url] = 'pending';

        fetch(url, { credentials: 'same-origin', cache: 'force-cache' })
            .then(function (r) { if (!r.ok) throw new Error('fetch status ' + r.status); return r.arrayBuffer(); })
            .then(function (ab) {
                // decodeAudioData consumes the buffer; clone for cache safety
                return new Promise(function (resolve, reject) {
                    ac.decodeAudioData(ab.slice(0), resolve, reject);
                });
            })
            .then(function (buf) {
                var W = 800, H = 80;
                var ch0 = buf.getChannelData(0);
                var ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
                var samples = W;
                var block = Math.max(1, Math.floor(ch0.length / samples));

                var c = document.createElement('canvas');
                c.width = W; c.height = H;
                var cx = c.getContext('2d');
                cx.clearRect(0, 0, W, H);
                cx.strokeStyle = 'rgba(255,255,255,0.85)';
                cx.lineWidth = 1;
                cx.beginPath();
                for (var i = 0; i < samples; i++) {
                    var lo = 0, hi = 0;
                    var end = Math.min(ch0.length, (i + 1) * block);
                    for (var j = i * block; j < end; j++) {
                        var v = ch1 ? (ch0[j] + ch1[j]) * 0.5 : ch0[j];
                        if (v > hi) hi = v;
                        if (v < lo) lo = v;
                    }
                    var y1 = Math.round(H / 2 - hi * (H / 2 - 1));
                    var y2 = Math.round(H / 2 - lo * (H / 2 - 1));
                    cx.moveTo(i + 0.5, y1);
                    cx.lineTo(i + 0.5, y2 + 1);
                }
                cx.stroke();

                var dataUrl = c.toDataURL('image/png');
                waveCache[url] = dataUrl;
                if (window.pbar && window.pbar.loadwaves) {
                    try { window.pbar.loadwaves(dataUrl); } catch (e) {}
                }
            })
            .catch(function (err) {
                waveCache[url] = 'failed';
                console.warn('kd-chiptune waveform decode failed for', url, err && err.message || err);
            });
    }

    // hook waveform generation onto window.play. We wait for browser.js's
    // play to finish (which sets mp.au.src) then sample mp.au.rsrc and
    // dispatch the fetch+decode.
    function installWaveformHook() {
        if (typeof window.play !== 'function') return false;
        if (window.play._kdWaveHooked) return true;
        var prev = window.play;
        window.play = function () {
            var ret = prev.apply(this, arguments);
            try {
                if (window.mp && window.mp.au && !(window.mp.au instanceof ChiptuneAudio)) {
                    var u = window.mp.au.rsrc || window.mp.au.src;
                    // unbuffer query params from copyparty re-fetch dance can
                    // strip — our cache is keyed on the full URL so it's fine
                    if (u) generateWaveform(u);
                }
            } catch (e) {}
            return ret;
        };
        window.play._kdWaveHooked = true;
        return true;
    }

    function tryInstallWaveformHook(retries) {
        if (installWaveformHook()) return;
        if (retries > 100) return;
        setTimeout(function () { tryInstallWaveformHook(retries + 1); }, 100);
    }

    // run after install pass — the existing tryInstall above wraps
    // window.play first; we wrap it again to add the waveform side-effect.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            tryPatchDrawpos(0);
            tryInstallWaveformHook(0);
        });
    } else {
        tryPatchDrawpos(0);
        tryInstallWaveformHook(0);
    }
})();

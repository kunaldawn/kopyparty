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
        this.buffered = { length: 0, start: function () { return 0; }, end: function () { return 0; } };
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
                self.applyVolume();
                self.applyLoop();
                self._fire('loadeddata');
                self._fire('loadedmetadata');
                self._fire('canplay');
                self._fire('durationchange');
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
})();

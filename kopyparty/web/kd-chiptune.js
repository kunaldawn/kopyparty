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

    // Shared AudioContext used by both chiptune2 and the mp.au
    // MediaElementSource wrap (which the visualizer taps off). Keeping a
    // single context is what lets the visualizer connect to either
    // playback path without juggling separate graphs.
    //
    // Browsers will auto-suspend an AudioContext under various
    // conditions (idle, tab hidden, autoplay policy violation). When
    // suspended, a chiptune2 ScriptProcessor stops being asked for
    // samples and audio just dies until the user clicks somewhere.
    // Auto-resume on every statechange and on user gestures keeps a
    // chiptune playing across tab focus / idle transitions.
    function getKdAudioCtx() {
        if (!window.kdAudio) window.kdAudio = {};
        if (window.kdAudio.context) return window.kdAudio.context;
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        var ctx;
        try { ctx = window.kdAudio.context = new AC(); }
        catch (e) { return null; }
        var tryResume = function () {
            if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
                ctx.resume().catch(function () {});
            }
        };
        try { ctx.addEventListener('statechange', tryResume); } catch (e) {}
        // any user gesture is a chance to lift autoplay restrictions
        var resumeOpts = { capture: true, passive: true };
        var onGesture = function () { tryResume(); };
        document.addEventListener('click', onGesture, resumeOpts);
        document.addEventListener('touchstart', onGesture, resumeOpts);
        document.addEventListener('keydown', onGesture, resumeOpts);
        // also nudge it when the tab regains focus
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) tryResume();
        });
        return ctx;
    }

    // singleton ChiptuneJsPlayer pinned to the shared context above.
    var cplayer = null;
    function getPlayer() {
        if (!cplayer) {
            var cfg = new ChiptuneJsConfig(0 /*repeat*/, 50 /*stereoSep*/, 2 /*interp*/, getKdAudioCtx());
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
    // `isPreload`: this instance backs `mp.au2`, copyparty's preload Audio
    // element. It must not touch the singleton ChiptuneJsPlayer because
    // doing so would `player.stop()` the currently playing track on
    // `mp.au`. chiptune2 has no preload support anyway, so we leave the
    // shim inert and let copyparty's normal `play()` path drive the
    // actual track switch via `mp.au.src = ...`.
    function ChiptuneAudio(isPreload) {
        this._isPreload = !!isPreload;
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
            // mp.au2 (preload) MUST NOT touch the singleton player —
            // calling player.stop() here would kill the chiptune currently
            // playing on mp.au. copyparty also can't sniff the buffered
            // duration off a fake element so the swap-on-rsrc-match in
            // browser.js play() never matches; that's fine because our
            // wrapped window.play routes tracker tracks through
            // playTracker which assigns directly to mp.au.src.
            if (this._isPreload) return;

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
                // kick off an offline waveform render so the progress bar
                // gets the same translucent waveform overlay as mp3 files
                generateChiptuneWaveform(url, buffer, self._duration);
                // every chiptune2 play creates a fresh ScriptProcessor —
                // the visualizer's connectAudio reference is now stale
                if (window.kdVisualizer && window.kdVisualizer.onAudioChanged) {
                    window.kdVisualizer.onAudioChanged();
                }
            });
        }
    });

    Object.defineProperty(ChiptuneAudio.prototype, 'currentTime', {
        get: function () {
            var p = getPlayer();
            // chiptune2.onaudioprocess calls disconnect()+cleanup() (which
            // sets modulePtr=0) but doesn't null currentPlayingNode. Without
            // the modulePtr guard, libopenmpt floods the console with
            // "module * not valid" every time copyparty's progress_updater
            // polls currentTime after a track ends.
            if (!p.currentPlayingNode || !p.currentPlayingNode.modulePtr) return 0;
            try { return p.getCurrentTime() || 0; } catch (e) { return 0; }
        },
        set: function (t) {
            var p = getPlayer();
            if (p.currentPlayingNode && p.currentPlayingNode.modulePtr && window.libopenmpt && libopenmpt._openmpt_module_set_position_seconds) {
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
    function endActive() {
        // Null currentPlayingNode so the next currentTime poll bails out
        // cleanly. chiptune2's onaudioprocess only calls disconnect()+
        // cleanup() at natural end, leaving the node ref dangling with
        // modulePtr=0.
        var p = getPlayer();
        // Defense-in-depth against double-advance / track skipping: a real
        // track end arrives while currentPlayingNode is still set (chiptune2
        // nulls only the node's modulePtr, not player.currentPlayingNode —
        // we do that here). A duplicate/stale end event therefore finds it
        // already null, so swallow it instead of firing a second 'ended'
        // (which would skip the *next* track). Pairs with the chiptune2.js
        // end-guard typo fix that stops the spurious trailing event at source.
        if (!p.currentPlayingNode) return;
        p.currentPlayingNode = null;
        if (activeShim) {
            activeShim._paused = true;
            activeShim._stopTimer();
            activeShim._fire('ended');
        }
    }
    function installPlayerCallbacks() {
        if (callbacksInstalled) return;
        callbacksInstalled = true;
        var p = getPlayer();
        p.onEnded(endActive);
        p.onError(function (info) {
            // chiptune2 fires onError (type=='openmpt') when read returns
            // 0 frames AND the module pointer is invalid — this is its way
            // of signaling "song ended with a quirk." copyparty's
            // evau_error schedules next_song with a 15-second toast; that
            // makes a tracker module appear to "stop in between." Treat
            // openmpt-type as a normal end so song advance is immediate.
            // 'onxhr' (network) is a real error — keep that path.
            if (info && info.type === 'openmpt') {
                endActive();
                return;
            }
            if (activeShim) {
                activeShim._error = {
                    code: 4,  // MEDIA_ERR_DECODE-ish
                    message: 'libopenmpt: ' + (info && info.type),
                    MEDIA_ERR_ABORTED: 1,
                    MEDIA_ERR_NETWORK: 2,
                    MEDIA_ERR_DECODE: 3,
                    MEDIA_ERR_SRC_NOT_SUPPORTED: 4
                };
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
            window.mp.au2 = new ChiptuneAudio(true); // preload no-op
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

            // Tracker path. Open the music widget right away so the user
            // gets immediate feedback: libopenmpt.js is ~2.2 MB and on a
            // cold cache / new session the download can take several
            // seconds, during which widget.open() (deferred until inside
            // playTracker, after loadLibs resolves) made the player appear
            // to do nothing — the most visible "music player doesn't show"
            // symptom. Opening here is idempotent (widget.set short-circuits
            // when already open) and harmless if the load later fails.
            try { window.widget.open(); } catch (e) {}

            // Load libs (lazy) then play.
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

    // ----- Wrap mp.au with a MediaElementSource so the visualizer can tap
    // ----- the audio output. Done by patching mp.set_ev (which copyparty
    // ----- calls right after creating a fresh Audio() element, before
    // ----- any src is assigned).
    function patchMpSetEv() {
        if (typeof window.mp !== 'object' || typeof mp.set_ev !== 'function') return false;
        if (mp._kdSetEvPatched) return true;
        var orig = mp.set_ev;
        mp.set_ev = function () {
            orig.call(this);
            wrapAuForVisualizer();
        };
        mp._kdSetEvPatched = true;
        return true;
    }

    function wrapAuForVisualizer() {
        var au = window.mp && window.mp.au;
        if (!au) return;
        if (au instanceof ChiptuneAudio) return;     // chiptune2's ScriptProcessor is the visualizer source
        if (au._kdWrapped) {                         // already wrapped — just re-notify
            if (window.kdVisualizer && window.kdVisualizer.onAudioChanged) {
                window.kdVisualizer.onAudioChanged();
            }
            return;
        }
        var ctx = getKdAudioCtx();
        if (!ctx) return;
        try {
            // Resume the context if the browser put it in suspended state
            // (autoplay policy) — we got here off a user gesture, so this
            // tends to succeed.
            if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
                ctx.resume().catch(function () {});
            }
            au._kdSource = ctx.createMediaElementSource(au);
            au._kdSource.connect(ctx.destination);
            au._kdWrapped = true;
            if (window.kdVisualizer && window.kdVisualizer.onAudioChanged) {
                window.kdVisualizer.onAudioChanged();
            }
        } catch (e) {
            console.warn('kd MediaElementSource wrap failed:', e && e.message || e);
        }
    }

    function tryPatchMpSetEv(retries) {
        if (patchMpSetEv()) return;
        if (retries > 100) return;
        setTimeout(function () { tryPatchMpSetEv(retries + 1); }, 100);
    }

    // Hook `mp.preload` to skip its server-side waveform thumbnail
    // prefetch (`?th=p`). The fork runs with `--no-thumb` so the server
    // returns 404 and the browser logs an `ERR_ABORTED 404` for every
    // track transition; the kd-chiptune side renders waveforms in-page
    // via decodeAudioData so we never use the server PNGs anyway.
    function patchMpPreload() {
        if (typeof window.mp !== 'object' || typeof mp.preload !== 'function') return false;
        if (mp._kdPreloadPatched) return true;
        var orig = mp.preload;
        mp.preload = function (url, full) {
            var savedWaves = window.mpl && mpl.waves;
            if (window.mpl) mpl.waves = false;
            try { return orig.call(this, url, full); }
            finally { if (window.mpl) mpl.waves = savedWaves; }
        };
        mp._kdPreloadPatched = true;
        return true;
    }

    function tryPatchMpPreload(retries) {
        if (patchMpPreload()) return;
        if (retries > 100) return;
        setTimeout(function () { tryPatchMpPreload(retries + 1); }, 100);
    }

    // Strip video-only entries from `mp.order` after copyparty populates
    // it. Upstream's `re_au_all` regex marks every video extension as a
    // playable "audio source" so it can pipe the soundtrack through opus
    // transcoding — but transcoding often fails (415) in this fork, and
    // the user expectation is that the music player only deals with
    // actual music files. After filtering, hide the widget if the
    // current folder has zero audio AND nothing is loaded.
    var VIDEO_EXT_RE = /\.(3gp|asf|av1|avc|avi|flv|h26[45]|hevc|m4v|mjpeg|mjpg|mkv|mov|mp4|mpeg|mpeg2|mpegts|mpg|mpg2|mts|nut|ogm|ogv|rm|ts|vob|webm|wmv)(\?|$)/i;

    function isVideoTid(tid) {
        if (!window.mp || !window.mp.tracks) return false;
        var u = window.mp.tracks[tid];
        if (!u || typeof u !== 'string') return false;
        return VIDEO_EXT_RE.test(u);
    }

    function filterAudioOnly() {
        if (!window.mp || !Array.isArray(mp.order)) return;
        var changed = false;
        var keep = [];
        for (var i = 0; i < mp.order.length; i++) {
            if (isVideoTid(mp.order[i])) { changed = true; continue; }
            keep.push(mp.order[i]);
        }
        if (changed) mp.order = keep;
    }

    function maybeHideWidget() {
        var widget = document.getElementById('widget');
        if (!widget) return;
        if (window.mp && window.mp.au) return;        // a track is loaded — keep widget
        if (!window.mp || !Array.isArray(mp.order) || mp.order.length === 0) {
            // Use widget.close() (→ widget.set(false)) rather than poking the
            // class directly: widget.set() guards on an internal is_open flag,
            // and stripping the 'open' class behind its back desyncs that flag
            // (is_open stays true while the class is gone). A later
            // widget.open() then sees is_open===true and no-ops, leaving the
            // player STUCK HIDDEN even once a track starts — e.g. after landing
            // on a no-audio folder (the archive roots have only subdirs) the
            // music widget never reappears on play. close() keeps state in sync.
            if (window.widget && typeof window.widget.close === 'function')
                window.widget.close();
            else {
                widget.classList.remove('open');
                try { document.documentElement.classList.remove('np_open'); } catch (e) {}
            }
        }
    }

    function patchReadOrder() {
        if (typeof window.mp !== 'object' || typeof mp.read_order !== 'function') return false;
        if (mp._kdReadOrderPatched) return true;
        var orig = mp.read_order;
        mp.read_order = function () {
            orig.apply(this, arguments);
            filterAudioOnly();
            maybeHideWidget();
        };
        mp._kdReadOrderPatched = true;
        // run once for the initial state
        filterAudioOnly();
        maybeHideWidget();
        return true;
    }

    function tryPatchReadOrder(retries) {
        if (patchReadOrder()) return;
        if (retries > 100) return;
        setTimeout(function () { tryPatchReadOrder(retries + 1); }, 100);
    }

    // ----- re-apply the per-instance patches on every folder navigation.
    // copyparty's reload_mp() does `mp = new MPlayer()` on each in-app
    // navigation (and on column re-sort). Our patchMp* helpers stamp a
    // done-flag on the mp INSTANCE and tryPatch* stops polling after the
    // first success, so the fresh MPlayer created on navigation arrives
    // UNPATCHED — set_ev no longer wraps the visualizer source, read_order
    // no longer strips video / hides the empty widget, and preload no
    // longer suppresses the dead ?th=p waveform fetch. Wrapping the global
    // reload_mp() (which is stable — never reassigned) lets us re-stamp the
    // new instance immediately after it's built.
    function patchReloadMp() {
        if (typeof window.reload_mp !== 'function') return false;
        if (window.reload_mp._kdWrapped) return true;
        var orig = window.reload_mp;
        window.reload_mp = function () {
            var ret = orig.apply(this, arguments);
            // mp now points at the freshly-created MPlayer — re-stamp it.
            try { patchMpSetEv(); } catch (e) {}
            try { patchMpPreload(); } catch (e) {}
            try { patchReadOrder(); } catch (e) {}
            return ret;
        };
        window.reload_mp._kdWrapped = true;
        return true;
    }

    function tryPatchReloadMp(retries) {
        if (patchReloadMp()) return;
        if (retries > 100) return;
        setTimeout(function () { tryPatchReloadMp(retries + 1); }, 100);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            tryInstall(0);
            tryPatchMpSetEv(0);
            tryPatchMpPreload(0);
            tryPatchReadOrder(0);
            tryPatchReloadMp(0);
        });
    } else {
        tryInstall(0);
        tryPatchMpSetEv(0);
        tryPatchMpPreload(0);
        tryPatchReadOrder(0);
        tryPatchReloadMp(0);
    }

    // Expose a few helpers for debugging from the console.
    window.kdChiptune = {
        TRACKER_RE: TRACKER_RE,
        isTracker: function (u) { return TRACKER_RE.test(u || ''); },
        getPlayer: getPlayer,
        ChiptuneAudio: ChiptuneAudio
    };

    // ----- Crisp symmetric SVG transport icons -----
    //
    // Unicode ⏮/⏭ are not consistently mirror-symmetric across system
    // fonts (the embedded triangles end up different widths), and the
    // glyph hinting at small sizes makes the buttons look misaligned.
    // Replace the text content with inline SVG so the prev/next icons
    // are exact mirrors and play/pause stay solid at any zoom level.
    var SVG_PREV = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><rect x="6" y="6" width="2" height="12"/><polygon points="20,6 20,18 10,12"/></svg>';
    var SVG_NEXT = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><rect x="16" y="6" width="2" height="12"/><polygon points="4,6 4,18 14,12"/></svg>';
    var SVG_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><polygon points="6,5 6,19 20,12"/></svg>';
    var SVG_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width:1em;height:1em;display:block;pointer-events:none"><rect x="7" y="5" width="3" height="14"/><rect x="14" y="5" width="3" height="14"/></svg>';
    var iconsInstalled = false;

    function installSvgIcons() {
        if (iconsInstalled) return true;
        var bprev = document.getElementById('bprev');
        var bplay = document.getElementById('bplay');
        var bnext = document.getElementById('bnext');
        if (!bprev || !bplay || !bnext) return false;

        bprev.innerHTML = SVG_PREV;
        bnext.innerHTML = SVG_NEXT;
        // bplay starts paused → play icon visible.
        bplay.innerHTML = SVG_PLAY;

        // Patch widget.paused so it swaps SVGs, not the original ▶/⏸ chars.
        if (window.widget && typeof window.widget.paused === 'function' && !window.widget._kdPaused) {
            window.widget._kdPaused = true;
            var was = true;
            window.widget.paused = function (paused) {
                if (was === paused) return;
                was = paused;
                var b = document.getElementById('bplay');
                if (b) b.innerHTML = paused ? SVG_PLAY : SVG_PAUSE;
            };
        }
        iconsInstalled = true;
        return true;
    }

    function tryInstallSvgIcons(retries) {
        if (installSvgIcons()) return;
        if (retries > 100) return;
        setTimeout(function () { tryInstallSvgIcons(retries + 1); }, 100);
    }

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

    // Mirror pbar's lastmove/mousepos closure state via our own listener
    // on the position canvas. We can't read pbar's privates, but the
    // canvas mousemove still bubbles to addEventListener-attached handlers
    // even when pbar reassigns onmousemove on every mouseenter.
    var kdLastMove = 0, kdMousePos = 0;
    function attachHoverTracker() {
        if (!window.pbar || !window.pbar.pos || !window.pbar.pos.can) return;
        var can = window.pbar.pos.can;
        if (can._kdHoverHooked) return;
        can._kdHoverHooked = true;
        can.addEventListener('mousemove', function (e) {
            if (e.buttons || !window.mp || !window.mp.au) return;
            var d = window.mp.au.duration;
            if (!isFinite(d)) return;
            var rect = can.getBoundingClientRect();
            kdMousePos = d * (e.clientX - rect.left) / rect.width;
            kdLastMove = Date.now();
        });
        can.addEventListener('mouseleave', function () {
            kdLastMove = 0;
        });
    }

    function patchDrawpos() {
        if (drawposPatched) return true;
        if (!window.pbar || typeof window.pbar.drawpos !== 'function') return false;
        if (typeof window.s2ms !== 'function') return false;

        attachHoverTracker();

        // Replace pbar.drawpos entirely so we can position labels at
        // y = h*0.667 (matching vbar) AND draw the position marker
        // exactly once at the correct x — full-height. The original is
        // structurally fine but draws labels at y=h*0.94 which doesn't
        // line up with the volume canvas. Layering on top of orig caused
        // a "split marker" because the hover state lives in pbar's
        // closure and we'd redraw the marker at currentTime while orig
        // had drawn it at mousepos.
        var t_redraw = 0;
        window.pbar.drawpos = function () {
            try {
                if (t_redraw) { clearTimeout(t_redraw); t_redraw = 0; }
                var pbar = window.pbar;
                if (!pbar || !pbar.pos) return;
                var pc = pbar.pos, bc = pbar.buf;
                var pctx = pc.ctx;
                pctx.clearRect(0, 0, pc.w, pc.h);
                if (!window.mp || !window.mp.au) return;

                var adur = window.mp.au.duration;
                var apos = window.mp.au.currentTime;
                if (!isFinite(adur) || !isFinite(apos) || apos < 0 || adur < apos) {
                    if (Date.now() - (window.mp.au.pt0 || 0) < 500) return;
                    pctx.fillStyle = window.light ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)';
                    var rsrc = '' + (window.mp.au.rsrc || '');
                    var m = /[?&]th=(opus|owa|caf|mp3)/.exec(rsrc);
                    var L = window.L || {};
                    var txt = window.mp.au.ded ? (L.mm_playerr || '').replace(':', ' ;_;') :
                        m ? (L.mm_bconv || '').replace('{0}', m[1]) : (L.mm_bload || '');
                    pctx.fillText(txt, 16, pc.h / 1.5);
                    return;
                }

                if (!window.widget || !window.widget.is_open) return;
                if (!bc) return;

                // hover override (matches pbar's own logic)
                var w = 8;
                if (kdLastMove && Date.now() - kdLastMove < 400) {
                    apos = kdMousePos;
                    w = 0;
                }

                var sm = bc.w * 1.0 / adur;
                var x = sm * apos;

                // marker — full height (matches upstream)
                pctx.fillStyle = '#573'; pctx.fillRect((x - w / 2) - 1, 0, w + 2, pc.h);
                pctx.fillStyle = '#dfc'; pctx.fillRect((x - w / 2), 0, w, pc.h);

                // time labels at y = h*2/3 (vbar's text y, kd-theme tweak)
                pctx.font = '.7em sans-serif';
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

                // self-reschedule to keep cursor smooth (matches upstream)
                if (sm > 10)
                    t_redraw = setTimeout(window.pbar.drawpos, sm > 50 ? 20 : 50);
            } catch (e) {
                console.warn('kd-chiptune drawpos error:', e);
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

    // Suppress the dead server-side waveform fetch. browser.js play() asks the
    // server for a peaks PNG via `<track>&th=p`, but this fork never generates
    // audio-peaks thumbnails (docker --th-pregen lists only image variants:
    // j,jf,w,w3,wf,wf3 — no 'p'), so every track logged an ERR 404 for th=p.
    // We render the seekbar waveform client-side instead (generateWaveform /
    // generateChiptuneWaveform → pbar.loadwaves(data:…)). Wrap loadwaves to
    // drop server th=p URLs while letting our data: URLs through, so the
    // waveform still shows and the 404 noise disappears.
    function patchLoadwaves() {
        if (!window.pbar || typeof window.pbar.loadwaves !== 'function') return false;
        if (window.pbar._kdLoadwavesPatched) return true;
        var orig = window.pbar.loadwaves;
        window.pbar.loadwaves = function (url) {
            if (typeof url === 'string' && url.indexOf('data:') !== 0 && /[?&]th=p(?:&|$)/.test(url))
                return;
            return orig.call(this, url);
        };
        window.pbar._kdLoadwavesPatched = true;
        return true;
    }

    function tryPatchLoadwaves(retries) {
        if (patchLoadwaves()) return;
        if (retries > 100) return;
        setTimeout(function () { tryPatchLoadwaves(retries + 1); }, 100);
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

    // ----- Chiptune waveform (libopenmpt offline render) -----
    //
    // For tracker formats we already have the file as ArrayBuffer (loaded
    // by chiptune2 via XHR). Rather than re-fetch + decode, instantiate a
    // SECOND libopenmpt module from the same buffer — separate from the
    // one currently playing — and read it through end-to-end at a low
    // sample rate. Peak-sample the rendered audio per output column,
    // render to a 800x80 canvas, hand the data URL to pbar.loadwaves.
    // Cached per source URL so re-clicks don't re-render.
    var chiptuneWaveCache = Object.create(null);

    function generateChiptuneWaveform(url, buffer, duration) {
        if (!url || !buffer || !isFinite(duration) || duration <= 0) return;
        if (chiptuneWaveCache[url] === 'pending' || chiptuneWaveCache[url] === 'failed') return;
        if (chiptuneWaveCache[url]) {
            try { window.pbar && window.pbar.loadwaves && window.pbar.loadwaves(chiptuneWaveCache[url]); }
            catch (e) {}
            return;
        }
        if (!window.libopenmpt
            || typeof libopenmpt._malloc !== 'function'
            || typeof libopenmpt._openmpt_module_create_from_memory !== 'function'
            || typeof libopenmpt._openmpt_module_read_float_stereo !== 'function'
            || typeof libopenmpt._openmpt_module_destroy !== 'function'
            || !libopenmpt.HEAPU8 || !libopenmpt.HEAPF32) return;
        if (!window.pbar || !window.pbar.loadwaves) return;

        chiptuneWaveCache[url] = 'pending';

        // libopenmpt rendering is synchronous and CPU-bound. The chiptune
        // playback path uses ScriptProcessorNode which runs its
        // onaudioprocess callback on the main thread, so a long render
        // here would starve playback (silent gap, time cursor freeze).
        // To avoid that, render in tiny slices yielded to the event
        // loop between each — playback's audio buffer keeps refilling
        // while the waveform fills in incrementally over ~1-2 seconds.
        var W = 800, H = 80;
        var SR = 4000;                           // low sample rate is fine for a peak-sample waveform
        var totalSamples = Math.floor(duration * SR);
        var chunkFrames = 4000;                  // 1 sec per call into libopenmpt
        var samplesPerPeak = Math.max(1, Math.floor(totalSamples / W));
        var SLICE_BUDGET_MS = 8;                 // yield to audio thread every ~8 ms
        var INITIAL_DELAY_MS = 200;              // let playback settle before starting

        var ptr = 0, modPtr = 0, leftPtr = 0, rightPtr = 0;
        var peaks = [];
        var peaksCount = 0;
        var curMin = 0, curMax = 0, accum = 0;
        var rendered = 0;
        var aborted = false;

        function freeAll() {
            try { if (modPtr) libopenmpt._openmpt_module_destroy(modPtr); } catch (e) {}
            try { if (leftPtr) libopenmpt._free(leftPtr); } catch (e) {}
            try { if (rightPtr) libopenmpt._free(rightPtr); } catch (e) {}
            try { if (ptr) libopenmpt._free(ptr); } catch (e) {}
            modPtr = leftPtr = rightPtr = ptr = 0;
        }

        function finalize() {
            if (aborted) return;
            try {
                if (accum > 0 && peaksCount < W) {
                    peaks.push(curMin, curMax);
                    peaksCount++;
                }
                var c = document.createElement('canvas');
                c.width = W; c.height = H;
                var cx = c.getContext('2d');
                cx.clearRect(0, 0, W, H);
                cx.strokeStyle = 'rgba(255,255,255,0.85)';
                cx.lineWidth = 1;
                cx.beginPath();
                for (var p = 0; p < peaksCount; p++) {
                    var lo = peaks[p * 2];
                    var hi = peaks[p * 2 + 1];
                    var y1 = Math.round(H / 2 - hi * (H / 2 - 1));
                    var y2 = Math.round(H / 2 - lo * (H / 2 - 1));
                    cx.moveTo(p + 0.5, y1);
                    cx.lineTo(p + 0.5, y2 + 1);
                }
                cx.stroke();
                var dataUrl = c.toDataURL('image/png');
                chiptuneWaveCache[url] = dataUrl;
                try { window.pbar.loadwaves(dataUrl); } catch (e) {}
            } catch (e) {
                chiptuneWaveCache[url] = 'failed';
                console.warn('kd-chiptune wave finalize failed:', e && e.message || e);
            } finally {
                freeAll();
            }
        }

        function processSlice() {
            if (aborted) { freeAll(); return; }
            var sliceStart = (typeof performance !== 'undefined' && performance.now)
                ? performance.now() : Date.now();
            try {
                while (rendered < totalSamples && peaksCount < W) {
                    var want = Math.min(chunkFrames, totalSamples - rendered);
                    var got = libopenmpt._openmpt_module_read_float_stereo(modPtr, SR, want, leftPtr, rightPtr);
                    if (got <= 0) {
                        // module ended early — finalize with what we have
                        finalize();
                        return;
                    }
                    var l = libopenmpt.HEAPF32.subarray(leftPtr / 4, leftPtr / 4 + got);
                    var r = libopenmpt.HEAPF32.subarray(rightPtr / 4, rightPtr / 4 + got);
                    for (var i = 0; i < got; i++) {
                        var v = (l[i] + r[i]) * 0.5;
                        if (v > curMax) curMax = v;
                        if (v < curMin) curMin = v;
                        accum++;
                        if (accum >= samplesPerPeak) {
                            peaks.push(curMin, curMax);
                            peaksCount++;
                            curMin = 0; curMax = 0; accum = 0;
                            if (peaksCount >= W) break;
                        }
                    }
                    rendered += got;
                    var now = (typeof performance !== 'undefined' && performance.now)
                        ? performance.now() : Date.now();
                    if (now - sliceStart >= SLICE_BUDGET_MS) {
                        setTimeout(processSlice, 0);
                        return;
                    }
                }
                finalize();
            } catch (e) {
                chiptuneWaveCache[url] = 'failed';
                console.warn('kd-chiptune wave slice failed:', e && e.message || e);
                freeAll();
            }
        }

        // Kick off after a small initial delay so the audio thread has
        // already started feeding the chiptune2 ScriptProcessor before
        // we begin our render.
        setTimeout(function () {
            try {
                var byteArr = new Uint8Array(buffer);
                var fileLen = byteArr.byteLength;
                ptr = libopenmpt._malloc(fileLen);
                libopenmpt.HEAPU8.set(byteArr, ptr);
                modPtr = libopenmpt._openmpt_module_create_from_memory(ptr, fileLen, 0, 0, 0);
                if (!modPtr) throw new Error('module_create_from_memory returned 0');
                if (typeof libopenmpt._openmpt_module_set_repeat_count === 'function') {
                    libopenmpt._openmpt_module_set_repeat_count(modPtr, 0);
                }
                leftPtr = libopenmpt._malloc(4 * chunkFrames);
                rightPtr = libopenmpt._malloc(4 * chunkFrames);
            } catch (e) {
                chiptuneWaveCache[url] = 'failed';
                console.warn('kd-chiptune wave setup failed:', e && e.message || e);
                freeAll();
                return;
            }
            processSlice();
        }, INITIAL_DELAY_MS);
    }

    // run after install pass — the existing tryInstall above wraps
    // window.play first; we wrap it again to add the waveform side-effect.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            tryPatchDrawpos(0);
            tryInstallWaveformHook(0);
            tryInstallSvgIcons(0);
            tryPatchLoadwaves(0);
        });
    } else {
        tryPatchDrawpos(0);
        tryInstallWaveformHook(0);
        tryInstallSvgIcons(0);
        tryPatchLoadwaves(0);
    }
})();

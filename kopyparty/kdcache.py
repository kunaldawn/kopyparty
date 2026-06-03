# coding: utf-8
from __future__ import print_function, unicode_literals

"""
KD fork: in-memory directory cache.

Browsing the archive off a slow USB HDD made every directory listing and
every tree-sidebar expansion do a live os.scandir() + a stat() per entry on
the disk (authsrv._ls -> util.statdir). The contents rarely change, so we
keep an in-memory snapshot of every directory's (name, stat) list, warmed at
startup and re-walked by a background thread every --kd-dircache-secs (default
24h, 0 disables). authsrv._ls serves from this snapshot for the common
follow-symlink listing; the up2k indexer is unaffected because it calls
statdir() directly, not via _ls.

Keys are the fully-resolved absolute path (absreal), byte-identical to what
authsrv._canonical() produces, so _ls lookups hit.
"""

import stat
import threading
import time

from .util import Daemon, absreal, statdir

# the live KdDirCache singleton, or None when disabled / not yet started
INST = None


class KdDirCache(object):
    def __init__(self, args, log_func, asrv):
        self.args = args
        self.log_func = log_func
        self.asrv = asrv
        self.interval = max(0, int(getattr(args, "kd_dircache_secs", 86400) or 0))
        self.scandir = not args.no_scandir
        self.mutex = threading.Lock()
        self.snap = {}  # abspath -> list[(name, os.stat_result)]
        self.hits = 0
        self.misses = 0
        self.warms = 0

    def log(self, msg, c=0):
        self.log_func("dircache", msg, c)

    # ---- read path (called from authsrv._ls) --------------------------
    def get(self, abspath):
        with self.mutex:
            v = self.snap.get(abspath)
            if v is None:
                self.misses += 1
            else:
                self.hits += 1
            return v

    def put(self, abspath, entries):
        # populate a cold dir discovered between warms; store a copy so the
        # caller may sort/filter its own list freely.
        with self.mutex:
            self.snap[abspath] = list(entries)

    # ---- background warm ----------------------------------------------
    def _roots(self):
        roots = []
        seen = set()
        for vn in self.asrv.vfs.all_vols.values():
            if not vn.realpath:
                continue
            rp = absreal(vn.realpath)
            if rp not in seen:
                seen.add(rp)
                roots.append(rp)
        return roots

    def warm(self):
        """Walk every volume root once, building a fresh snapshot, then swap
        it in atomically. Iterative (no recursion limit on deep trees)."""
        t0 = time.time()
        new = {}
        stack = list(self._roots())
        while stack:
            top = stack.pop()
            if top in new:
                continue
            try:
                entries = list(statdir(self.log_func, self.scandir, False, top, False))
            except Exception:
                continue
            new[top] = entries
            for name, st in entries:
                try:
                    if stat.S_ISDIR(st.st_mode):
                        # keys must match _canonical(): absreal of each dir
                        child = absreal(top + "/" + name)
                        if child not in new:
                            stack.append(child)
                except Exception:
                    continue

        with self.mutex:
            self.snap = new
            self.warms += 1
        self.log("warmed %d dirs in %.2fs" % (len(new), time.time() - t0))

    def _bg(self):
        try:
            self.warm()
        except Exception as ex:
            self.log("initial warm failed: %r" % (ex,), 3)
        while self.interval > 0:
            time.sleep(self.interval)
            try:
                self.warm()
            except Exception as ex:
                self.log("warm failed: %r" % (ex,), 3)

    def start(self):
        Daemon(self._bg, "kd-dircache")


def start(args, log_func, asrv):
    """Create and start the per-process singleton, unless disabled
    (--kd-dircache-secs 0). Idempotent: a second call is a no-op so it's safe
    to invoke from HttpSrv.__init__ regardless of how many times that runs."""
    global INST
    if INST is not None:
        return INST
    if max(0, int(getattr(args, "kd_dircache_secs", 86400) or 0)) <= 0:
        return None
    INST = KdDirCache(args, log_func, asrv)
    INST.start()
    return INST

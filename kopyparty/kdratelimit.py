# coding: utf-8
from __future__ import print_function, unicode_literals

"""
KD fork: global download bandwidth cap.

The archive is served from a home connection; without a limit a single visitor
can saturate the uplink. This is ONE shared token bucket for the whole serving
process: every file-download thread draws from the same pool, so the *aggregate*
send rate across all visitors/connections converges to --kd-dl-limit MB/s.

Hooked into util.sendfile_py (the Python read/sendall loop). The default kernel
os.sendfile path cannot throttle, so httpcli.tx_file routes through sendfile_py
whenever a limiter is active. Started once per serving process from
HttpSrv.__init__ (same rule as kdcache: with -j>1 each BrokerMp worker is its
own process, so a parent-process global would be None in the workers; HttpSrv
runs once per serving process). The fork keeps -j1, so there is exactly one
bucket. Under -j>1 the cap would become per-worker.
"""

import threading
import time

# the live RateLimiter singleton, or None when disabled / not yet started
INST = None


class RateLimiter(object):
    def __init__(self, rate, burst=None, clock=time.monotonic, sleep=time.sleep):
        # rate: bytes/sec. burst (capacity): bytes that may be sent instantly;
        # defaults to ~1 second of rate so a fresh download isn't stalled.
        self.rate = float(rate)
        self.capacity = float(burst) if burst else self.rate
        self.tokens = self.capacity
        self._clock = clock
        self._sleep = sleep
        self.last = clock()
        self.lock = threading.Lock()

    def consume(self, nbytes):
        # Deduct nbytes (debt allowed to go negative so a chunk larger than the
        # burst still drains), then sleep off any debt OUTSIDE the lock so
        # threads serialize on bandwidth, not on the lock. A full bucket lets
        # many connections starting at once burst up to `capacity` bytes before
        # any throttling kicks in, so the aggregate can briefly exceed the cap;
        # it self-corrects to the cap in steady state (refill is wall-time based).
        n = float(nbytes)
        with self.lock:
            now = self._clock()
            self.tokens = min(
                self.capacity, self.tokens + (now - self.last) * self.rate
            )
            self.last = now
            self.tokens -= n
            if self.tokens >= 0:
                return
            wait = -self.tokens / self.rate
        self._sleep(wait)


def throttle(nbytes):
    """No-op when no limiter configured; otherwise block until nbytes may send."""
    if INST is not None:
        INST.consume(nbytes)


def start(args):
    """Create the per-process singleton unless disabled (--kd-dl-limit 0).
    Idempotent: a second call is a no-op, safe to invoke from HttpSrv.__init__."""
    global INST
    if INST is not None:
        return INST
    mbps = float(getattr(args, "kd_dl_limit", 0) or 0)
    if mbps <= 0:
        return None
    INST = RateLimiter(mbps * 1024 * 1024)
    return INST

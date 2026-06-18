# coding: utf-8
"""Deterministic tests for the fork's global download rate limiter.

Run: python3 tests/test_kdratelimit.py   (also works under pytest)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from kopyparty.kdratelimit import RateLimiter


def make_limiter(rate, burst=None):
    clk = [0.0]
    slept = []

    def clock():
        return clk[0]

    def sleep(n):
        slept.append(n)
        clk[0] += n  # waking up advances the clock by exactly the slept time

    lim = RateLimiter(rate, burst=burst, clock=clock, sleep=sleep)
    return lim, clk, slept


def test_burst_is_free():
    # capacity defaults to one second of rate; consuming <= capacity never sleeps
    lim, clk, slept = make_limiter(1000.0)  # 1000 B/s, capacity 1000
    lim.consume(1000)
    assert slept == [], "consuming the full burst should not sleep"


def test_overdraw_sleeps_the_debt():
    lim, clk, slept = make_limiter(1000.0)  # capacity 1000
    lim.consume(1000)          # drains bucket to 0, no sleep
    lim.consume(1000)          # bucket empty -> 1000 B debt -> 1.0s sleep
    assert abs(sum(slept) - 1.0) < 1e-9, slept


def test_refill_over_time():
    lim, clk, slept = make_limiter(1000.0)
    lim.consume(1000)          # drains to 0
    clk[0] += 0.5              # half a second passes -> 500 B refilled
    lim.consume(500)           # exactly the refilled amount -> no sleep
    assert slept == [], slept


def test_chunk_larger_than_capacity_still_drains():
    # a single request bigger than the burst must not deadlock; it just sleeps longer
    lim, clk, slept = make_limiter(1000.0, burst=1000)
    lim.consume(3000)          # 1000 free + 2000 debt -> 2.0s
    assert abs(sum(slept) - 2.0) < 1e-9, slept


def test_aggregate_throughput_matches_rate():
    # sending 10x the rate worth of bytes takes ~ (10x - burst)/rate seconds total
    lim, clk, slept = make_limiter(1000.0)  # capacity 1000
    for _ in range(10):
        lim.consume(1000)      # 10_000 B total; 1000 free -> 9000 debt -> 9.0s
    assert abs(sum(slept) - 9.0) < 1e-9, sum(slept)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
    print("ALL PASS")

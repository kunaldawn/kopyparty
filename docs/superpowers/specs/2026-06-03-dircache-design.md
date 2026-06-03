# In-memory directory cache for the read paths

**Date:** 2026-06-03
**Repo:** kopyparty fork (read-only HTTP file browser, served off a slow USB HDD)

## Problem

Every directory listing (grid `browser.html` data) and every tree-sidebar
expansion does a live `os.scandir()` + a `stat()` per entry on `/data`
(`httpcli.py:4178` and `:3256` → `authsrv._ls` → `util.statdir:3416`). On a
USB HDD this is a burst of random seeks per browse. The `-e2dsa` index DB does
**not** serve listings (metadata/tags/dir-sizes only). There is no in-memory
listing cache. Content rarely changes, so repeatedly hitting the disk is waste.

## Goal

Serve directory listings and the tree from an in-memory snapshot so per-request
disk IOPS for browsing drops to ~zero, refreshed in the background. Eventual
consistency (new/removed files visible after a refresh or restart) is acceptable.

## Design

### New module `kopyparty/kdcache.py`
A single focused unit (one purpose: cache directory `statdir` results).

- State: `snap: dict[str, list[tuple[str, os.stat_result]]]` keyed by absolute
  path, guarded by a lock. Whole-snapshot atomic swap so readers never see a
  half-built dict.
- `get(abspath) -> list | None` — cached entry or None.
- `put(abspath, entries)` — populate on a cold miss (dirs not yet warmed).
- `warm()` — walk every volume real-root once via
  `statdir(log, scandir=True, lstat=False, dir, throw=False)`, one scandir per
  directory, build a fresh dict, swap it in atomically.
- Daemon thread re-runs `warm()` every `KOPYPARTY_DIRCACHE_SECS` (default
  86400 = 24h; `0` disables the cache entirely).
- Module-global singleton `INST`, created + started from **`HttpSrv.__init__`**
  via an idempotent `kdcache.start()`. This is the single correct init point:
  `HttpSrv` is built once **in the process that actually serves requests** for
  BOTH broker types — threaded (`-j1`: one `HttpSrv` in the hub process) and
  multiprocessing (`-jN`: one `HttpSrv` per worker process, each with its own
  `AuthSrv`). Initializing in `svchub` (the parent) would NOT populate `INST`
  in multiprocess workers, where `_ls` runs — the cache would silently never
  serve. Module global because `VFS._ls` carries no `args` handle.

### Hook in `authsrv.py:_ls` (sole chokepoint)
Both read paths flow through `vn.ls()` → `_ls`. Replace the unconditional
`statdir` call (line 775) with:

```python
use_cache = (not lstat) and kdcache.INST is not None
cached = kdcache.INST.get(abspath) if use_cache else None
if cached is not None:
    real = list(cached)              # own copy; _ls sorts/filters it (775-806)
else:
    real = list(statdir(self.log, scandir, lstat, abspath, throw))
    if use_cache:
        kdcache.INST.put(abspath, real)
real.sort()
```

- `lstat=True` (the rare `?lt` listing param) bypasses the cache → live disk.
- Indexer reads disk via `statdir` **directly** (`up2k.py:1549`) and
  `os.listdir` (`:1904`), NOT via `_ls`, so indexing always sees real disk.
- The unreachable move/copy `walk()` paths are untouched.

### Config
- `__main__.py`: add `--kd-dircache-secs` (default 86400).
- `docker-compose.yml`: surface `KOPYPARTY_DIRCACHE_SECS`.
- Warm runs once at startup → first browse after boot is already instant.

### Ops tunings (`docker-compose.yml`)
- `mem_limit`/`memswap_limit` default `2g → 8g` (env `KOPYPARTY_MEM_LIMIT`),
  commented: bounds reclaimable page-cache for file downloads; set ~60–75% of
  host RAM. (Listing cache heap is tiny and separate.)
- **Keep `-j1`** (env `KOPYPARTY_WORKERS`, default 1). This is a disk-bound
  workload — the USB HDD seek latency is the bottleneck, not CPU. `-j1` runs a
  single process that already serves concurrently via a thread pool AND shares
  one warm cache. `-jN` spawns separate worker processes that each maintain and
  re-walk their OWN cache copy → multiplies the daily tree scan across the slow
  disk and the RAM. (Original plan said bump to 4; investigation showed that
  fights the cache design — reverted.)
- Comment + `docker volume inspect kopyparty_cache` snippet to confirm the index
  DB + thumbnails sit on SSD; how to bind-mount an explicit SSD path otherwise.

## Cost / correctness
- Snapshot is metadata only; ~500k files ≪ ~100 MB heap, well under the limit.
- Trade-off: added/removed files appear after the 24h refresh or a container
  restart (no manual trigger requested).
- Background walk = one full-tree scandir/day; also keeps the kernel dentry
  cache warm.

## Verification
- curl/Playwright smoke: listing + tree return the same entries as live disk.
- Instrument a hit counter to confirm `_ls` serves from cache after warm.
- Confirm indexer still scans disk (startup `-e2dsa` log unchanged).
- 0 console errors; resident memory stays bounded.
- Existing CLAUDE.md smoke-test suite (URL surface, 405/404 matrix) still green.

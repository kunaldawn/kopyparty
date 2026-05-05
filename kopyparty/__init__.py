# coding: utf-8
from __future__ import print_function, unicode_literals

import os
import platform
import sys
import time

# fmt: off
_:tuple[int,int]=(0,0)  # _____________________________________________________________________  hey there! if you are reading this, your python is too old to run kopyparty without some help. Please use https://github.com/9001/copyparty/releases/latest/download/copyparty-sfx.py or the pypi package instead, or see https://github.com/9001/copyparty/blob/hovudstraum/docs/devnotes.md#building if you want to build it yourself :-)  ************************************************************************************************************************************************
# fmt: on

try:
    from typing import TYPE_CHECKING
except:
    TYPE_CHECKING = False

if True:
    from typing import Any, Callable, Optional

PY2 = sys.version_info < (3,)
PY36 = sys.version_info > (3, 6)
if not PY2:
    unicode: Callable[[Any], str] = str
else:
    sys.dont_write_bytecode = True
    unicode = unicode  # type: ignore

WINDOWS: Any = (
    [int(x) for x in platform.version().split(".")]
    if platform.system() == "Windows"
    else False
)

VT100 = "--ansi" in sys.argv or (
    os.environ.get("NO_COLOR", "").lower() in ("", "0", "false")
    and sys.stdout.isatty()
    and "--no-ansi" not in sys.argv
    and (not WINDOWS or WINDOWS >= [10, 0, 14393])
)
# introduced in anniversary update

ANYWIN = WINDOWS or sys.platform in ["msys", "cygwin"]

MACOS = platform.system() == "Darwin"

FREEBSD = platform.system() == "FreeBSD"

OPENBSD = platform.system() == "OpenBSD"

ANYBSD = FREEBSD or OPENBSD

UNIX = MACOS or ANYBSD

GRAAL = platform.python_implementation() == "GraalVM"

EXE = bool(getattr(sys, "frozen", False))

try:
    CORES = len(os.sched_getaffinity(0))
except:
    CORES = (os.cpu_count() if hasattr(os, "cpu_count") else 0) or 2

# all embedded resources to be retrievable over http
zs = """
web/baguettebox.js
web/browser.css
web/browser.html
web/browser.js
web/browser2.html
web/deps/chiptune2.js
web/deps/libopenmpt.js
web/deps/libopenmpt.js.mem
web/deps/marked.js
web/deps/prism.css
web/deps/prism.js
web/deps/prismd.css
web/deps/scp.woff2
web/iiam.gif
web/kd-chiptune.js
web/kd-theme.css
web/md.css
web/md.html
web/md.js
web/msg.html
web/rups.css
web/rups.html
web/rups.js
web/splash.css
web/splash.html
web/splash.js
web/svcs.html
web/svcs.js
web/ui.css
web/up2k.js
web/util.js
"""
RES = set(zs.strip().split("\n"))
RESM = {}


class EnvParams(object):
    def __init__(self) -> None:
        self.t0 = time.time()
        self.mod = ""
        self.mod_ = ""
        self.cfg = ""
        self.scfg = True


E = EnvParams()

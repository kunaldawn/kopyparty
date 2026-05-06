# coding: utf-8
from __future__ import print_function, unicode_literals

import argparse  # typechk
import copy
import errno
import hashlib
import itertools
import json
import os
import random
import re
import socket
import stat
import sys
import threading  # typechk
import time
import uuid
from datetime import datetime
from operator import itemgetter

import jinja2  # typechk
from ipaddress import IPv6Network

try:
    if os.environ.get("PRTY_NO_LZMA"):
        raise Exception()

    import lzma
except:
    pass

from .__init__ import ANYWIN, RES, RESM, TYPE_CHECKING, EnvParams, unicode
from .__version__ import S_VERSION
from .authsrv import LEELOO_DALLAS, VFS  # typechk
from .bos import bos
from .star import StreamTar
from .sutil import StreamArc, gfilter
from .szip import StreamZip
from .up2k import up2k_chunksize
from .util import unquote  # type: ignore
from .util import (
    APPLESAN_RE,
    BITNESS,
    DAV_ALLPROPS,
    E_SCK_WR,
    HAVE_SQLITE3,
    HTTPCODE,
    SAFE_MIMES,
    UTC,
    VPTL_MAC,
    VPTL_OS,
    VPTL_WIN,
    Garda,
    MultipartParser,
    ODict,
    Pebkac,
    UnrecvEOF,
    WrongPostKey,
    absreal,
    afsenc,
    alltrace,
    atomic_move,
    b64dec,
    eol_conv,
    exclude_dotfiles,
    exclude_dotfiles_ls,
    exclude_dothidden,
    exclude_dothidden_ls,
    formatdate,
    fsenc,
    gen_content_disposition,
    gen_filekey,
    gen_filekey_dbg,
    gencookie,
    get_df,
    get_spd,
    guess_mime,
    gzip,
    gzip_file_orig_sz,
    gzip_orig_sz,
    has_resource,
    hashcopy,
    hidedir,
    html_bescape,
    html_escape,
    html_sh_esc,
    humansize,
    ipnorm,
    json_hesc,
    justcopy,
    load_resource,
    loadpy,
    log_reloc,
    min_ex,
    open_nolock,
    pathmod,
    quotep,
    rand_name,
    read_header,
    read_socket,
    read_socket_chunked,
    read_socket_unbounded,
    read_utf8,
    relchk,
    ren_open,
    runhook,
    s2hms,
    s3enc,
    safe_mime,
    sanitize_fn,
    sanitize_vpath,
    sendfile_kern,
    sendfile_py,
    set_fperms,
    stat_resource,
    str_anchor,
    ub64dec,
    ub64enc,
    ujoin,
    undot,
    unescape_cookie,
    unquotep,
    vjoin,
    vol_san,
    vroots,
    vsplit,
    wunlink,
    yieldfile,
)

if True:  # pylint: disable=using-constant-test
    import typing
    from typing import (
        Any,
        Generator,
        Iterable,
        Match,
        Optional,
        Pattern,
        Sequence,
        Type,
        Union,
    )

if TYPE_CHECKING:
    from .httpconn import HttpConn

if not hasattr(socket, "AF_UNIX"):
    setattr(socket, "AF_UNIX", -9001)

_ = (argparse, threading)

USED4SEC = {"usedforsecurity": False} if sys.version_info > (3, 9) else {}

ALL_COOKIES = "cplng cppwd cppws dots idxh js k304 no304".split()

BADXFF = " due to dangerous misconfiguration (the http-header specified by --xff-hdr was received from an untrusted reverse-proxy)"
BADXFF2 = ". Some kopyparty features are now disabled as a safety measure.\n\n\n"
BADXFP = ', or change the kopyparty global-option "xf-proto" to another header-name to read this value from. Alternatively, if your reverseproxy is not able to provide a header similar to "X-Forwarded-Proto", then you must tell kopyparty which protocol to assume; either "--xf-proto-fb=http" or "--xf-proto-fb=https"'
BADXFFB = "<b>NOTE: serverlog has a message regarding your reverse-proxy config</b>"
BADVER = '<a class="r" href="https://github.com/9001/copyparty/security/advisories">Please upgrade kopyparty; Your version has a vulnerability</a><p>(only users with permission "a" or "A" can see this message)</p>'

H_CONN_KEEPALIVE = "Connection: Keep-Alive"
H_CONN_CLOSE = "Connection: Close"

RSS_SORT = {"m": "mt", "u": "at", "n": "fn", "s": "sz"}
ACODE2_FMT = set(["opus", "owa", "caf", "mp3", "flac", "wav"])
IDX_HTML = set(["index.htm", "index.html"])

A_FILE = os.stat_result(
    (0o644, -1, -1, 1, 1000, 1000, 8, 0x39230101, 0x39230101, 0x39230101)
)

RE_CC = re.compile(r"[\x00-\x1f\x7f]")  # search always faster
RE_USAFE = re.compile(r'[\x00-\x1f\x7f<>"]')  # search always faster
RE_HSAFE = re.compile(r"[\x00-\x1f\x7f<>\"'&]")  # search always much faster
RE_HOST = re.compile(r"[^][0-9a-zA-Z.:_-]")  # search faster <=17ch
RE_MHOST = re.compile(r"^[][0-9a-zA-Z.:_-]+$")  # match faster >=18ch
RE_K = re.compile(r"[^0-9a-zA-Z_-]")  # search faster <=17ch
RE_HTTP1 = re.compile(r"(GET|HEAD|POST|PUT) [^ ]+ HTTP/1.1$")
RE_HR = re.compile(r"[<>\"'&]")
RE_MDV = re.compile(r"(.*)\.([0-9]+\.[0-9]{3})(\.[Mm][Dd])$")
RE_RSS_KW = re.compile(r"(\{[^} ]+\})")
RE_SETCK = re.compile(r"[^0-9a-z=]")

UPARAM_CC_OK = set("doc move tree".split())

PERMS_rwh = [
    [True, False],
    [False, True],
    [False, False, False, False, False, False, True],
]


def _build_zip_xcode() -> Sequence[str]:
    ret = "opus mp3 flac wav p".split()
    for codec in ("j", "w", "x"):
        for suf in ("", "f", "f3", "3"):
            ret.append("%s%s" % (codec, suf))
    return ret


ZIP_XCODE_L = _build_zip_xcode()
ZIP_XCODE_S = set(ZIP_XCODE_L)


def _arg2cfg(txt: str) -> str:
    return re.sub(r' "--([^=]{3,12})=', r' global-option "\1: ', txt)


class HttpCli(object):
    """
    Spawned by HttpConn to process one http transaction
    """

    def __init__(self, conn: "HttpConn") -> None:
        assert conn.sr  # !rm

        empty_stringlist: list[str] = []

        self.t0 = time.time()
        self.conn = conn
        self.u2mutex = conn.u2mutex  # mypy404
        self.s = conn.s
        self.sr = conn.sr
        self.ip = conn.addr[0]
        self.addr: tuple[str, int] = conn.addr
        self.args = conn.args  # mypy404
        self.E: EnvParams = self.args.E
        self.asrv = conn.asrv  # mypy404
        self.thumbcli = conn.hsrv.thumbcli
        self.u2fh = conn.u2fh  # mypy404
        self.pipes = conn.pipes  # mypy404
        self.log_func = conn.log_func  # mypy404
        self.log_src = conn.log_src  # mypy404
        self.gen_fk = self._gen_fk if self.args.log_fk else gen_filekey
        self.tls = self.is_https = hasattr(self.s, "cipher")
        self.is_vproxied = bool(self.args.R)

        # placeholders; assigned by run()
        self.keepalive = False
        self.in_hdr_recv = True
        self.headers: dict[str, str] = {}
        self.mode = " "  # http verb
        self.req = " "
        self.http_ver = ""
        self.hint = ""
        self.host = " "
        self.ua = " "
        self.is_rclone = False
        self.ouparam: dict[str, str] = {}
        self.uparam: dict[str, str] = {}
        self.cookies: dict[str, str] = {}
        self.avn: Optional[VFS] = None
        self.vn = self.asrv.vfs
        self.rem = " "
        self.vpath = " "
        self.vpaths = " "
        self.dl_id = ""
        self.gctx = " "  # additional context for garda
        self.trailing_slash = True
        self.uname = "*"
        self.pw = ""
        self.rvol = self.wvol = self.avol = empty_stringlist
        self.do_log = True
        self.can_read = False
        self.can_write = False
        self.can_move = False
        self.can_delete = False
        self.can_get = False
        self.can_upget = False
        self.can_html = False
        self.can_admin = False
        self.can_dot = False
        self.out_headerlist: list[tuple[str, str]] = []
        self.out_headers: dict[str, str] = {}
        # post
        self.parser: Optional[MultipartParser] = None
        # end placeholders

        self.html_head = ""

    def log(self, msg: str, c: Union[int, str] = 0) -> None:
        ptn = self.asrv.re_pwd
        if ptn and ptn.search(msg):
            if self.asrv.ah.on:
                msg = ptn.sub("\033[7m pw \033[27m", msg)
            else:
                msg = ptn.sub(self.unpwd, msg)

        self.log_func(self.log_src, msg, c)

    def unpwd(self, m: Match[str]) -> str:
        a, b, c = m.groups()
        uname = self.asrv.iacct.get(b) or self.asrv.sesa.get(b)
        return "%s\033[7m %s \033[27m%s" % (a, uname, c)

    def _assert_safe_rem(self, rem: str) -> None:
        # sanity check to prevent any disasters
        # (this function hopefully serves no purpose; validation has already happened at this point, this only exists as a last-ditch effort just in case)
        if rem.startswith(("/", "../")) or "/../" in rem:
            raise Exception("that was close")

    def _gen_fk(self, alg: int, salt: str, fspath: str, fsize: int, inode: int) -> str:
        return gen_filekey_dbg(
            alg, salt, fspath, fsize, inode, self.log, self.args.log_fk
        )

    def j2s(self, name: str, **ka: Any) -> str:
        tpl = self.conn.hsrv.j2[name]
        ka["r"] = self.args.SR if self.is_vproxied else ""
        ka["ts"] = self.conn.hsrv.cachebuster()
        ka["lang"] = self.cookies.get("cplng") or self.args.lang
        ka["favico"] = self.args.favico
        ka["s_doctitle"] = self.args.doctitle
        ka["tcolor"] = self.vn.flags["tcolor"]

        if self.args.js_other and "js" not in ka:
            zs = self.args.js_other
            zs += "&" if "?" in zs else "?"
            ka["js"] = zs

        if "html_head_d" in self.vn.flags:
            ka["this"] = self
            self._build_html_head(ka)

        ka["html_head"] = self.html_head
        return tpl.render(**ka)  # type: ignore

    def j2j(self, name: str) -> jinja2.Template:
        return self.conn.hsrv.j2[name]

    def run(self) -> bool:
        """returns true if connection can be reused"""
        self.out_headers = {
            "Cache-Control": "no-store, max-age=0",
        }

        if self.args.early_ban and self.is_banned():
            return False

        if self.conn.ipa_nm and not self.conn.ipa_nm.map(self.conn.addr[0]):
            self.log("client rejected (--ipa)", 3)
            self.terse_reply(b"", 500)
            return False

        try:
            self.s.settimeout(2)
            headerlines = read_header(self.sr, self.args.s_thead, self.args.s_thead)
            self.in_hdr_recv = False
            if not headerlines:
                return False

            try:
                self.mode, self.req, self.http_ver = headerlines[0].split(" ")

                # normalize incoming headers to lowercase;
                # outgoing headers however are Correct-Case
                for header_line in headerlines[1:]:
                    k, zs = header_line.split(":", 1)
                    self.headers[k.lower()] = zs.strip()
                    if zs.endswith(" HTTP/1.1") and RE_HTTP1.search(zs):
                        raise Exception()
            except:
                headerlines = [repr(x) for x in headerlines]
                msg = "#[ " + " ]\n#[ ".join(headerlines) + " ]"
                raise Pebkac(400, "bad headers", log=msg)

        except Pebkac as ex:
            self.mode = "GET"
            self.req = "[junk]"
            self.http_ver = "HTTP/1.1"
            # self.log("pebkac at httpcli.run #1: " + repr(ex))
            self.keepalive = False
            h = {"WWW-Authenticate": 'Basic realm="a"'} if ex.code == 401 else {}
            try:
                self.loud_reply(unicode(ex), status=ex.code, headers=h, volsan=True)
            except:
                pass

            if ex.log:
                self.log("additional error context:\n" + ex.log, 6)

            return False

        self.sr.nb = 0
        self.conn.hsrv.nreq += 1

        self.ua = self.headers.get("user-agent", "")
        self.is_rclone = self.ua.startswith("rclone/")

        zs = self.headers.get("connection", "").lower()
        self.keepalive = "close" not in zs and (
            self.http_ver != "HTTP/1.0" or zs == "keep-alive"
        )

        if (
            "transfer-encoding" in self.headers
            and self.headers["transfer-encoding"].lower() != "identity"
        ):
            self.sr.te = 1
            if "content-length" in self.headers:
                # rfc9112:6.2: ignore CL if TE
                self.keepalive = False
                self.headers.pop("content-length")
                t = "suspicious request (has both TE and CL); ignoring CL and disabling keepalive"
                self.log(t, 3)

        self.host = self.headers.get("host") or ""
        if not self.host:
            if self.s.family == socket.AF_UNIX:
                self.host = self.args.name
            else:
                zs = "%s:%s" % self.s.getsockname()[:2]
                self.host = zs[7:] if zs.startswith("::ffff:") else zs

        trusted_xff = False
        n = self.args.rproxy
        if n:
            zso = self.headers.get(self.args.xff_hdr)
            if zso:
                if n > 0:
                    n -= 1

                zsl = zso.split(",")
                try:
                    cli_ip = zsl[n].strip()
                except:
                    cli_ip = self.ip
                    self.bad_xff = True
                    if self.args.rproxy != 9999999:
                        t = "global-option --rproxy %d could not be used (out-of-bounds) for the received header [%s]"
                        self.log(t % (self.args.rproxy, zso) + BADXFF2, c=3)
                    else:
                        zsl = [
                            "  rproxy: %d   if this client's IP-address is [%s]"
                            % (-1 - zd, zs.strip())
                            for zd, zs in enumerate(zsl[::-1])
                        ]
                        t = 'could not determine the client\'s IP-address because the global-option --rproxy has not been configured, so the request-header [%s] specified by global-option --xff-hdr cannot be used safely! The raw header value was [%s]. Please see the "reverse-proxy" section in the readme. The best approach is to configure your reverse-proxy to give kopyparty the exact IP-address to assume (perhaps in another header), but you may also try the following:'
                        t = t % (self.args.xff_hdr, zso)
                        t = "%s\n\n%s\n" % (t, "\n".join(zsl))

                        zs = self.headers.get(self.args.xf_proto)
                        t2 = "\nFurthermore, the following request-headers are also relevant, and you should check that the values below are sensible:\n\n  request-header [%s] (configured with global-option --xf-proto) has the value [%s]; this should be the protocol that the webbrowser is using, so either 'http' or 'https'"
                        t += t2 % (self.args.xf_proto, zs or "NOT-PROVIDED")
                        if not zs:
                            t += ". Because the header is not provided by the reverse-proxy, you must either fix the reverseproxy config"
                            t += BADXFP
                        zs = self.headers.get(self.args.xf_host)
                        t2 = "\n\n  request-header [%s] (configured with global-option --xf-host) has the value [%s]; this should be the website domain or external IP-address which the webbrowser is accessing"
                        t += t2 % (self.args.xf_host, zs or "NOT-PROVIDED")
                        if not zs:
                            zs = self.headers.get("host")
                            t2 = ". Because the header is not provided by the reverse-proxy, kopyparty is using the standard [Host] header which has the value [%s]"
                            t += t2 % (zs or "NOT-PROVIDED")
                            if zs:
                                t += ". If that is the address that visitors are supposed to use to access your server -- or, in other words, it is not some internal address you wish to keep secret -- then the current choice of using the [Host] header is fine (usually the case)"
                        if self.args.c:
                            t = _arg2cfg(t)
                        self.log(t + "\n\n\n", 3)

                pip = self.conn.addr[0]
                xffs = self.conn.xff_nm
                if xffs and not xffs.map(pip):
                    t = 'got header "%s" from untrusted source "%s" claiming the true client ip is "%s" (raw value: "%s");  if you trust this, you must allowlist this proxy with "--xff-src=%s"%s'
                    if self.headers.get("cf-connecting-ip"):
                        t += '  Note: if you are behind cloudflare, then this default header is not a good choice; please first make sure your local reverse-proxy (if any) does not allow non-cloudflare IPs from providing cf-* headers, and then add this additional global setting: "--xff-hdr=cf-connecting-ip"'
                    else:
                        t += '  Note: depending on your reverse-proxy, and/or WAF, and/or other intermediates, you may want to read the true client IP from another header by also specifying "--xff-hdr=SomeOtherHeader"'
                    t += BADXFF2

                    if "." in pip:
                        zs = ".".join(pip.split(".")[:2]) + ".0.0/16"
                    else:
                        zs = IPv6Network(pip + "/64", False).compressed

                    zs2 = ' or "--xff-src=lan"' if self.conn.xff_lan.map(pip) else ""
                    t = t % (self.args.xff_hdr, pip, cli_ip, zso, zs, zs2)
                    if self.args.c:
                        t = _arg2cfg(t)
                    self.log(t, 3)
                    self.bad_xff = True
                else:
                    self.ip = cli_ip
                    self.log_src = self.conn.set_rproxy(self.ip)
                    self.host = self.headers.get(self.args.xf_host, self.host)
                    try:
                        self.is_https = len(self.headers[self.args.xf_proto]) == 5
                    except:
                        if self.args.xf_proto_fb:
                            self.is_https = len(self.args.xf_proto_fb) == 5
                        else:
                            self.bad_xff = True
                            self.host = "example.com"
                            t = 'got proxied request without header "%s" (global-option "xf-proto"). This header must contain either "http" or "https". Either fix your reverse-proxy config to include this header%s%s'
                            t = t % (self.args.xf_proto, BADXFP, BADXFF2)
                            if self.args.c:
                                t = _arg2cfg(t)
                            self.log(t, 3)

                    # the semantics of trusted_xff and bad_xff are different;
                    # trusted_xff is whether the connection came from a trusted reverseproxy,
                    # regardless of whether the client ip detection is correctly configured
                    # (the primary safeguard for idp is --idp-h-key)
                    trusted_xff = True

        m = RE_HOST.search(self.host)
        if m and self.host != self.args.name:
            zs = self.host
            t = "malicious user; illegal Host header; req(%r) host(%r) => %r"
            self.log(t % (self.req, zs, zs[m.span()[0] :]), 1)
            self.cbonk(self.conn.hsrv.gmal, zs, "bad_host", "illegal Host header")
            self.terse_reply(b"illegal Host header", 400)
            return False

        if self.is_banned():
            return False

        if self.conn.ipar_nm and not self.conn.ipar_nm.map(self.ip):
            self.log("client rejected (--ipar)", 3)
            self.terse_reply(b"", 500)
            return False

        if self.conn.aclose:
            nka = self.conn.aclose
            ip = ipnorm(self.ip)
            if ip in nka:
                rt = nka[ip] - time.time()
                if rt < 0:
                    self.log("client uncapped", 3)
                    del nka[ip]
                else:
                    self.keepalive = False

        ptn = self.conn.lf_url
        self.do_log = not ptn or not ptn.search(self.req)

        if self.args.ihead and self.do_log:
            keys = self.args.ihead
            if "*" in keys:
                keys = list(sorted(self.headers.keys()))

            for k in keys:
                zso = self.headers.get(k)
                if zso is not None:
                    self.log("[H] {}: \033[33m[{}]".format(k, zso), 6)

        if "&" in self.req and "?" not in self.req:
            self.hint = "did you mean '?' instead of '&'"

        if self.args.uqe and "/.uqe/" in self.req:
            try:
                vpath, query = self.req.split("?")[0].split("/.uqe/")
                query = query.split("/")[0]  # discard trailing junk
                # (usually a "filename" to trick discord into behaving)
                query = ub64dec(query.encode("utf-8")).decode("utf-8", "replace")
                if query.startswith("/"):
                    self.req = "%s/?%s" % (vpath, query[1:])
                else:
                    self.req = "%s?%s" % (vpath, query)
            except Exception as ex:
                t = "bad uqe in request [%s]: %r" % (self.req, ex)
                self.loud_reply(t, status=400)
                return False

        m = RE_USAFE.search(self.req)
        if m:
            zs = self.req
            t = "malicious user; Cc in req0 %r => %r"
            self.log(t % (zs, zs[m.span()[0] :]), 1)
            self.cbonk(self.conn.hsrv.gmal, zs, "cc_r0", "Cc in req0")
            self.terse_reply(b"", 500)
            return False

        # split req into vpath + uparam
        uparam = {}
        if "?" not in self.req:
            vpath = unquotep(self.req)  # not query, so + means +
            self.trailing_slash = vpath.endswith("/")
            vpath = undot(vpath)
        else:
            vpath, arglist = self.req.split("?", 1)
            vpath = unquotep(vpath)
            self.trailing_slash = vpath.endswith("/")
            vpath = undot(vpath)

            re_k = RE_K
            ptn_cc = RE_CC
            k_safe = UPARAM_CC_OK
            for k in arglist.split("&"):
                sv = ""
                if "=" in k:
                    k, zs = k.split("=", 1)
                    # x-www-form-urlencoded (url query part) uses
                    # either + or %20 for 0x20 so handle both
                    sv = unquotep(zs.strip().replace("+", " "))

                m = re_k.search(k)
                if m:
                    t = "malicious user; bad char in query key; req(%r) qk(%r) => %r"
                    self.log(t % (self.req, k, k[m.span()[0] :]), 1)
                    self.cbonk(self.conn.hsrv.gmal, self.req, "bc_q", "illegal qkey")
                    self.terse_reply(b"", 500)
                    return False

                k = k.lower()
                uparam[k] = sv

                if k in k_safe:
                    continue

                zs = "%s=%s" % (k, sv)
                m = ptn_cc.search(zs)
                if not m:
                    continue

                t = "malicious user; Cc in query; req(%r) qp(%r) => %r"
                self.log(t % (self.req, zs, zs[m.span()[0] :]), 1)
                self.cbonk(self.conn.hsrv.gmal, self.req, "cc_q", "Cc in query")
                self.terse_reply(b"", 500)
                return False

            if "k" in uparam:
                m = re_k.search(uparam["k"])
                if m:
                    zs = uparam["k"]
                    t = "malicious user; illegal filekey; req(%r) k(%r) => %r"
                    self.log(t % (self.req, zs, zs[m.span()[0] :]), 1)
                    self.cbonk(self.conn.hsrv.gmal, zs, "bad_k", "illegal filekey")
                    self.terse_reply(b"illegal filekey", 400)
                    return False

        if self.is_vproxied:
            if vpath.startswith(self.args.R):
                vpath = vpath[len(self.args.R) + 1 :]
            else:
                t = "incorrect --rp-loc or webserver config; expected vpath starting with %r but got %r"
                self.log(t % (self.args.R, vpath), 1)
                self.is_vproxied = False

        self.ouparam = uparam.copy()

        if self.args.rsp_slp:
            time.sleep(self.args.rsp_slp)
            if self.args.rsp_jtr:
                time.sleep(random.random() * self.args.rsp_jtr)

        zso = self.headers.get("cookie")
        if zso:
            if len(zso) > self.args.cookie_cmax:
                self.loud_reply("cookie header too big", status=400)
                return False
            zsll = [x.lstrip().split("=", 1) for x in zso.split(";") if "=" in x]
            cookies = {k.rstrip(): unescape_cookie(zs.strip(), k) for k, zs in zsll}
            cookie_pw = cookies.get("cppws" if self.is_https else "cppwd") or ""
            if "b" in cookies and "b" not in uparam:
                uparam["b"] = cookies["b"]
            if len(cookies) > self.args.cookie_nmax:
                self.loud_reply("too many cookies", status=400)
        else:
            cookies = {}
            cookie_pw = ""

        if len(uparam) > 12:
            t = "http-request rejected; num.params: %d %r"
            self.log(t % (len(uparam), self.req), 3)
            self.loud_reply("u wot m8", status=400)
            return False

        if VPTL_OS:
            vpath = vpath.translate(VPTL_OS)

        self.uparam = uparam
        self.cookies = cookies
        self.vpath = vpath
        self.vpaths = vpath + "/" if self.trailing_slash and vpath else vpath

        # KD fork: ?qr removed (qrkode.py removed). 404 on any qr request.
        if "qr" in uparam:
            return self.tx_404()

        if "\x00" in vpath or (ANYWIN and ("\n" in vpath or "\r" in vpath)):
            self.log("illegal relpath; req(%r) => %r" % (self.req, "/" + self.vpath))
            self.cbonk(self.conn.hsrv.gmal, self.req, "bad_vp", "invalid relpaths")
            return self.tx_404() and False

        zso = self.headers.get("authorization")
        bauth = ""
        if (
            zso
            and not self.args.no_bauth
            and (not cookie_pw or not self.args.bauth_last)
        ):
            try:
                zb = zso.split(" ")[1].encode("ascii")
                zs = b64dec(zb).decode("utf-8")
                # try "pwd", "x:pwd", "pwd:x"
                for bauth in [zs] + zs.split(":", 1)[::-1]:
                    if bauth in self.asrv.sesa:
                        break
                    hpw = self.asrv.ah.hash(bauth)
                    if self.asrv.iacct.get(hpw):
                        break
            except:
                pass

        self.pw = (
            uparam.get(self.args.pw_urlp)
            or self.headers.get(self.args.pw_hdr)
            or bauth
            or cookie_pw
        )
        self.uname = (
            self.asrv.sesa.get(self.pw)
            or self.asrv.iacct.get(self.asrv.ah.hash(self.pw))
            or "*"
        )

        if self.args.have_idp_hdrs and (
            self.uname == "*" or self.args.ao_idp_before_pw
        ):
            idp_usr = ""
            if self.args.idp_hm_usr:
                for hn, hmv in self.args.idp_hm_usr_p.items():
                    zs = self.headers.get(hn)
                    if zs:
                        for zs1, zs2 in hmv.items():
                            if zs == zs1:
                                idp_usr = zs2
                                break
                    if idp_usr:
                        break
            for hn in self.args.idp_h_usr:
                if idp_usr and not self.args.ao_h_before_hm:
                    break
                idp_usr = self.headers.get(hn) or idp_usr
            if idp_usr:
                idp_grp = (
                    self.headers.get(self.args.idp_h_grp) or ""
                    if self.args.idp_h_grp
                    else ""
                )
                if self.args.idp_chsub:
                    idp_usr = idp_usr.translate(self.args.idp_chsub_tr)
                    idp_grp = idp_grp.translate(self.args.idp_chsub_tr)

                if not trusted_xff:
                    pip = self.conn.addr[0]
                    xffs = self.conn.xff_nm
                    trusted_xff = xffs and xffs.map(pip)

                trusted_key = (
                    not self.args.idp_h_key
                ) or self.args.idp_h_key in self.headers

                if trusted_key and trusted_xff:
                    if idp_usr.lower() == LEELOO_DALLAS:
                        self.loud_reply("send her back", status=403)
                        return False
                    self.asrv.idp_checkin(self.conn.hsrv.broker, idp_usr, idp_grp)
                else:
                    if not trusted_key:
                        t = 'the idp-h-key header ("%s") is not present in the request; will NOT trust the other headers saying that the client\'s username is "%s" and group is "%s"'
                        self.log(t % (self.args.idp_h_key, idp_usr, idp_grp), 3)

                    if not trusted_xff:
                        t = 'got IdP headers from untrusted source "%s" claiming the client\'s username is "%s" and group is "%s";  if you trust this, you must allowlist this proxy with "--xff-src=%s"%s'
                        if not self.args.idp_h_key:
                            t += "  Note: you probably also want to specify --idp-h-key <SECRET-HEADER-NAME> for additional security"

                        pip = self.conn.addr[0]
                        zs = (
                            ".".join(pip.split(".")[:2]) + "."
                            if "." in pip
                            else ":".join(pip.split(":")[:4]) + ":"
                        ) + "0.0/16"
                        zs2 = (
                            ' or "--xff-src=lan"' if self.conn.xff_lan.map(pip) else ""
                        )
                        self.log(t % (pip, idp_usr, idp_grp, zs, zs2), 3)

                    idp_usr = "*"
                    idp_grp = ""

                if idp_usr in self.asrv.vfs.aread:
                    self.pw = ""
                    self.uname = idp_usr
                    if self.args.ao_have_pw or self.args.idp_logout:
                        self.html_head += "<script>var is_idp=1</script>\n"
                    else:
                        self.html_head += "<script>var is_idp=2</script>\n"
                    zs = self.asrv.ases.get(idp_usr)
                    if zs:
                        self.set_idp_cookie(zs)
                else:
                    self.log("unknown username: %r" % (idp_usr,), 1)

        if self.args.have_ipu_or_ipr:
            if self.args.ipu and (self.uname == "*" or self.args.ao_ipu_wins):
                self.uname = self.conn.ipu_iu[self.conn.ipu_nm.map(self.ip)]
            ipr = self.conn.hsrv.ipr
            if ipr and self.uname in ipr:
                if not ipr[self.uname].map(self.ip):
                    self.log("username [%s] rejected by --ipr" % (self.uname,), 3)
                    self.uname = "*"

        self.rvol = self.asrv.vfs.aread[self.uname]
        self.wvol = self.asrv.vfs.awrite[self.uname]
        self.avol = self.asrv.vfs.aadmin[self.uname]

        if self.pw and (
            self.pw != cookie_pw or self.conn.freshen_pwd + 30 < time.time()
        ):
            self.conn.freshen_pwd = time.time()
            self.get_pwd_cookie(self.pw)

        if self.is_rclone:
            # dots: always include dotfiles if permitted
            # lt: probably more important showing the correct timestamps of any dupes it just uploaded rather than the lastmod time of any non-kopyparty-managed symlinks
            # b: basic-browser if it tries to parse the html listing
            uparam["dots"] = ""
            uparam["lt"] = ""
            uparam["b"] = ""
            cookies["b"] = ""

        vn, rem = self.asrv.vfs.get(self.vpath, self.uname, False, False)
        if vn.realpath and ("xdev" in vn.flags or "xvol" in vn.flags):
            ap = vn.canonical(rem)
            avn = vn.chk_ap(ap)
        else:
            avn = vn

        if "bcasechk" in vn.flags and not vn.casechk(rem, True):
            return self.tx_404() and False

        try:
            assert avn  # type: ignore  # !rm
            (
                self.can_read,
                self.can_write,
                self.can_move,
                self.can_delete,
                self.can_get,
                self.can_upget,
                self.can_html,
                self.can_admin,
                self.can_dot,
            ) = avn.uaxs[self.uname]
        except:
            pass  # default is all-false

        self.avn = avn
        self.vn = vn  # note: do not dbv due to walk/zipgen
        self.rem = rem

        self.s.settimeout(self.args.s_tbody or None)

        if "html_head_s" in vn.flags:
            self.html_head += vn.flags["html_head_s"]

        try:
            cors_k = self._cors()
            if self.mode in ("GET", "HEAD"):
                return self.handle_get() and self.keepalive
            if self.mode == "OPTIONS":
                return self.handle_options() and self.keepalive

            if not cors_k:
                host = self.headers.get("host", "<?>")
                origin = self.headers.get("origin", "<?>")
                proto = "https://" if self.is_https else "http://"
                guess = "modifying" if (origin and host) else "stripping"
                t = "cors-reject %s because request-header Origin=%r does not match request-protocol %r and host %r based on request-header Host=%r (note: if this request is not malicious, check if your reverse-proxy is accidentally %s request headers, in particular 'Origin', for example by running kopyparty with --ihead='*' to show all request headers)"
                self.log(t % (self.mode, origin, proto, self.host, host, guess), 3)
                raise Pebkac(403, "rejected by cors-check (see fileserver log)")

            # KD fork: read-only HTTP — only GET/HEAD/OPTIONS supported.
            # POST/PUT/DELETE and all WebDAV verbs reject with 405.
            if self.mode == "POST":
                return self.handle_post() and self.keepalive
            elif self.mode in ("PUT", "DELETE", "PROPFIND", "PROPPATCH",
                               "LOCK", "UNLOCK", "MKCOL", "MOVE", "COPY"):
                raise Pebkac(405, "method not allowed (read-only archive)")
            else:
                raise Pebkac(400, "invalid HTTP verb %r" % (self.mode,))

        except Exception as ex:
            if not isinstance(ex, Pebkac):
                pex = Pebkac(500)
            else:
                pex: Pebkac = ex  # type: ignore

            try:
                if pex.code == 999:
                    self.terse_reply(b"", 500)
                    return False

                post = (
                    self.mode in ("POST", "PUT")
                    or "content-length" in self.headers
                    or self.sr.te
                )
                if pex.code >= (300 if post else 400):
                    self.keepalive = False

                em = str(ex)
                msg = em if pex is ex else min_ex()

                if pex.code != 404 or self.do_log:
                    self.log(
                        "http%d: %s\033[0m, %r" % (pex.code, msg, "/" + self.vpath),
                        6 if em.startswith("client d/c ") else 3,
                    )

                if self.hint and self.hint.startswith("<xml> "):
                    if self.args.log_badxml:
                        t = "invalid XML received from client: %r"
                        self.log(t % (self.hint[6:],), 6)
                    else:
                        t = "received invalid XML from client; enable --log-badxml to see the whole XML in the log"
                        self.log(t, 6)
                    self.hint = ""

                msg = "%s\r\nURL: %s\r\n" % (em, self.vpath)
                if self.hint:
                    msg += "hint: %s\r\n" % (self.hint,)

                if "database is locked" in em:
                    self.conn.hsrv.broker.say("log_stacks")
                    msg += "hint: important info in the server log\r\n"

                zb = b"<pre>" + html_escape(msg).encode("utf-8", "replace")
                h = {"WWW-Authenticate": 'Basic realm="a"'} if pex.code == 401 else {}
                self.reply(zb, status=pex.code, headers=h, volsan=True)
                if pex.log:
                    self.log("additional error context:\n" + pex.log, 6)

                return self.keepalive
            except Pebkac:
                return False

        finally:
            if self.dl_id:
                self.conn.hsrv.dli.pop(self.dl_id, None)
                self.conn.hsrv.dls.pop(self.dl_id, None)

    def dip(self) -> str:
        if self.args.plain_ip:
            return self.ip.replace(":", ".")
        else:
            return self.conn.iphash.s(self.ip)

    def cbonk(self, g: Garda, v: str, reason: str, descr: str) -> bool:
        cond = self.args.dont_ban
        if (
            cond == "any"
            or (cond == "auth" and self.uname != "*")
            or (cond == "aa" and self.avol)
            or (cond == "av" and self.can_admin)
            or (cond == "rw" and self.can_read and self.can_write)
        ):
            return False

        self.conn.hsrv.nsus += 1
        if not g.lim:
            return False

        bonk, ip = g.bonk(self.ip, v + self.gctx)
        if not bonk:
            return False

        xban = self.vn.flags.get("xban")
        if xban:
            hr = runhook(
                self.log,
                self.conn.hsrv.broker,
                None,
                "xban",
                xban,
                self.vn.canonical(self.rem),
                self.vpath,
                self.host,
                self.uname,
                "",
                time.time(),
                0,
                self.ip,
                time.time(),
                [reason, reason],
            )
            if hr.get("rv") == 0:
                return False

        self.log("client banned: %s" % (descr,), 1)
        self.conn.hsrv.bans[ip] = bonk
        self.conn.hsrv.nban += 1
        return True

    def is_banned(self) -> bool:
        if not self.conn.bans:
            return False

        bans = self.conn.bans
        ip = ipnorm(self.ip)
        if ip not in bans:
            return False

        rt = bans[ip] - time.time()
        if rt < 0:
            del bans[ip]
            self.log("client unbanned", 3)
            return False

        self.log("banned for {:.0f} sec".format(rt), 6)
        self.terse_reply(self.args.banmsg_b, 403)
        return True

    def permit_caching(self) -> None:
        cache = self.uparam.get("cache")
        if cache is None:
            self.out_headers["Cache-Control"] = self.vn.flags["cachectl"]
            return

        n = 69 if not cache else 604869 if cache == "i" else int(cache)
        self.out_headers["Cache-Control"] = "max-age=" + str(n)

    def k304(self) -> bool:
        k304 = self.cookies.get("k304")
        return k304 == "y" or (self.args.k304 == 2 and k304 != "n")

    def no304(self) -> bool:
        no304 = self.cookies.get("no304")
        return no304 == "y" or (self.args.no304 == 2 and no304 != "n")

    def _build_html_head(self, kv: dict[str, Any]) -> None:
        html = str(self.vn.flags["html_head_d"])
        is_jinja = html[:2] in "%@%"
        if is_jinja:
            html = html.replace("%", "", 1)

        if html.startswith("@"):
            html = read_utf8(self.log, html[1:], True)

        if html.startswith("%"):
            html = html[1:]
            is_jinja = True

        if is_jinja:
            with self.conn.hsrv.mutex:
                if html not in self.conn.hsrv.j2:
                    j2env = jinja2.Environment()
                    tpl = j2env.from_string(html)
                    self.conn.hsrv.j2[html] = tpl
                html = self.conn.hsrv.j2[html].render(**kv)

        self.html_head += html + "\n"

    def send_headers(
        self,
        oh_k: str,
        length: Optional[int],
        status: int = 200,
        mime: Optional[str] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> None:
        response = ["%s %s %s" % (self.http_ver, status, HTTPCODE[status])]

        # headers{} overrides anything set previously
        if headers:
            self.out_headers.update(headers)

        if status == 304:
            self.out_headers.pop("Content-Length", None)
            self.out_headers.pop("Content-Type", None)
            self.out_headerlist[:] = []
            if self.k304():
                self.keepalive = False
        else:
            if length is not None:
                response.append("Content-Length: " + unicode(length))

            if mime:
                self.out_headers["Content-Type"] = mime
            elif "Content-Type" not in self.out_headers:
                self.out_headers["Content-Type"] = "text/html; charset=utf-8"

        # close if unknown length, otherwise take client's preference
        response.append(H_CONN_KEEPALIVE if self.keepalive else H_CONN_CLOSE)
        response.append("Date: " + formatdate())

        for k, zs in list(self.out_headers.items()) + self.out_headerlist:
            response.append("%s: %s" % (k, zs))

        ptn_cc = RE_CC
        for zs in response:
            m = ptn_cc.search(zs)
            if m:
                t = "malicious user; Cc in out-hdr; req(%r) hdr(%r) => %r"
                self.log(t % (self.req, zs, zs[m.span()[0] :]), 1)
                self.cbonk(self.conn.hsrv.gmal, zs, "cc_hdr", "Cc in out-hdr")
                raise Pebkac(999)

        response.append(self.vn.flags[oh_k])

        if self.args.ohead and self.do_log:
            zs = response.pop()[:-4]
            response.extend(zs.split("\r\n"))
            keys = self.args.ohead
            if "*" in keys:
                lines = response[1:]
            else:
                lines = []
                for zs in response[1:]:
                    if zs.split(":")[0].lower() in keys:
                        lines.append(zs)
            for zs in lines:
                hk, hv = zs.split(": ")
                self.log("[O] {}: \033[33m[{}]".format(hk, hv), 5)
            response.append("\r\n")

        try:
            self.s.sendall("\r\n".join(response).encode("utf-8"))
        except:
            raise Pebkac(400, "client d/c while replying headers")

    def reply(
        self,
        body: bytes,
        status: int = 200,
        mime: Optional[str] = None,
        headers: Optional[dict[str, str]] = None,
        volsan: bool = False,
    ) -> bytes:
        if (
            status > 400
            and status in (403, 404, 422)
            and (
                status != 422
                or (
                    not body.startswith(b"<pre>partial upload exists")
                    and not body.startswith(b"<pre>source file busy")
                )
            )
            and (status != 404 or (self.can_get and not self.can_read))
        ):
            if status == 404:
                g = self.conn.hsrv.g404
            elif status == 403:
                g = self.conn.hsrv.g403
            else:
                g = self.conn.hsrv.g422

            gurl = self.conn.hsrv.gurl
            if (
                gurl.lim
                and (not g.lim or gurl.lim < g.lim)
                and self.args.sus_urls.search(self.vpath)
            ):
                g = self.conn.hsrv.gurl

            if g.lim and (
                g == self.conn.hsrv.g422
                or not self.args.nonsus_urls
                or not self.args.nonsus_urls.search(self.vpath)
            ):
                self.cbonk(g, self.vpath, str(status), "%ss" % (status,))

        if volsan:
            vols = list(self.asrv.vfs.all_vols.values())
            body = vol_san(vols, body)
            try:
                zs = absreal(__file__).rsplit(os.path.sep, 2)[0]
                body = body.replace(zs.encode("utf-8"), b"PP")
            except:
                pass

        self.send_headers("oh_g", len(body), status, mime, headers)

        try:
            if self.mode != "HEAD":
                self.s.sendall(body)
        except:
            raise Pebkac(400, "client d/c while replying body")

        return body

    def loud_reply(self, body: str, *args: Any, **kwargs: Any) -> None:
        if not kwargs.get("mime"):
            kwargs["mime"] = "text/plain; charset=utf-8"

        self.log(body.rstrip())
        self.reply(body.encode("utf-8") + b"\r\n", *list(args), **kwargs)

    def terse_reply(self, body: bytes, status: int = 200) -> None:
        self.keepalive = False

        lines = [
            "%s %s %s" % (self.http_ver or "HTTP/1.1", status, HTTPCODE[status]),
            H_CONN_CLOSE,
        ]

        if body:
            lines.append(
                "Content-Type: text/html; charset=utf-8\r\nContent-Length: "
                + unicode(len(body))
            )

        lines.append("\r\n")
        self.s.sendall("\r\n".join(lines).encode("utf-8") + body)

    def urlq(self, add: dict[str, str], rm: list[str]) -> str:
        """
        generates url query based on uparam (b, pw, all others)
        removing anything in rm, adding pairs in add

        also list faster than set until ~20 items
        """

        if self.is_rclone:
            return ""

        kv = {k: zs for k, zs in self.uparam.items() if k not in rm}
        # no reason to consider args.pw_urlp
        if "pw" in kv:
            pw = self.cookies.get("cppws") or self.cookies.get("cppwd")
            if kv["pw"] == pw:
                del kv["pw"]

        kv.update(add)
        if not kv:
            return ""

        r = ["%s=%s" % (quotep(k), quotep(zs)) if zs else k for k, zs in kv.items()]
        return "?" + "&amp;".join(r)

    def ourlq(self) -> str:
        # no reason to consider args.pw_urlp
        skip = ("pw", "h", "k")
        ret = []
        for k, v in self.ouparam.items():
            if k in skip:
                continue

            t = "%s=%s" % (quotep(k), quotep(v))
            ret.append(t.replace(" ", "+").rstrip("="))

        if not ret:
            return ""

        return "?" + "&".join(ret)

    def redirect(
        self,
        vpath: str,
        suf: str = "",
        msg: str = "aight",
        flavor: str = "go to",
        click: bool = True,
        status: int = 200,
        use302: bool = False,
    ) -> bool:
        vp = self.args.SRS + vpath
        html = self.j2s(
            "msg",
            h2='<a href="{}">{} {}</a>'.format(
                quotep(vp) + suf, flavor, html_escape(vp, crlf=True) + suf
            ),
            pre=msg,
            click=click,
        ).encode("utf-8", "replace")

        if use302:
            self.reply(html, status=302, headers={"Location": vp})
        else:
            self.reply(html, status=status)

        return True

    def _cors(self) -> bool:
        ih = self.headers
        origin = ih.get("origin")
        if not origin:
            sfsite = ih.get("sec-fetch-site")
            if sfsite and sfsite.lower().startswith("cross"):
                origin = ":|"  # sandboxed iframe
            else:
                return True

        host = self.host.lower()
        if host.startswith("["):
            if "]:" in host:
                host = host.split("]:")[0] + "]"
        else:
            host = host.split(":")[0]

        oh = self.out_headers
        origin = origin.lower()
        proto = "https" if self.is_https else "http"
        good_origins = self.args.acao + ["%s://%s" % (proto, host)]

        if (
            self.args.pw_hdr in ih
            or re.sub(r"(:[0-9]{1,5})?/?$", "", origin) in good_origins
        ):
            good_origin = True
            bad_hdrs = ("",)
        else:
            good_origin = False
            bad_hdrs = ("", self.args.pw_hdr)

        # '*' blocks auth through cookies / WWW-Authenticate;
        # exact-match for Origin is necessary to unlock those,
        # but the ?pw= param and PW: header are always allowed
        acah = ih.get("access-control-request-headers", "")
        acao = (origin if good_origin else None) or (
            "*" if "*" in good_origins else None
        )
        if self.args.allow_csrf:
            acao = origin or acao or "*"  # explicitly permit impersonation
            acam = ", ".join(self.conn.hsrv.mallow)  # and all methods + headers
            oh["Access-Control-Allow-Credentials"] = "true"
            good_origin = True
        else:
            acam = ", ".join(self.args.acam)
            # wash client-requested headers and roll with that
            if "range" not in acah.lower():
                acah += ",Range"  # firefox
            req_h = acah.split(",")
            req_h = [x.strip() for x in req_h]
            req_h = [x for x in req_h if x.lower() not in bad_hdrs]
            acah = ", ".join(req_h)

        if not acao:
            return False

        oh["Access-Control-Allow-Origin"] = acao
        oh["Access-Control-Allow-Methods"] = acam.upper()
        if acah:
            oh["Access-Control-Allow-Headers"] = acah

        return good_origin

    def handle_get(self) -> bool:
        if self.do_log:
            logmsg = "%-4s %s @%s" % (self.mode, self.req, self.uname)

            if "range" in self.headers:
                try:
                    rval = self.headers["range"].split("=", 1)[1]
                except:
                    rval = self.headers["range"]

                logmsg += " [\033[36m" + rval + "\033[0m]"

            self.log(logmsg)
            if "%" in self.req:
                self.log(" `-- %r" % (self.vpath,))

        # "embedded" resources
        if self.vpath.startswith(".kpr"):
            if self.vpath.startswith(".kpr/ico/"):
                return self.tx_ico(self.vpath.split("/")[-1], exact=True)

            # KD fork: SSDP responder removed (ssdp.py deleted)
            # KD fork: Prometheus /.kpr/metrics endpoint removed
            if self.vpath == ".kpr/metrics" or self.vpath.startswith(".kpr/ssdp"):
                return self.tx_404()

            if self.vpath.startswith(".kpr/w/"):
                res_path = "web/" + self.vpath[7:]
            else:
                res_path = "web/" + self.vpath[5:]

            if res_path in RES:
                ap = self.E.mod_ + res_path
                if bos.path.exists(ap) or bos.path.exists(ap + ".gz"):
                    return self.tx_file("oh_g", ap)
                else:
                    return self.tx_res(res_path)

            if res_path in RESM:
                ap = self.E.mod_ + RESM[res_path]
                if (
                    "txt" not in self.uparam
                    and "mime" not in self.uparam
                    and not self.ouparam.get("dl")
                ):
                    # return mimetype matching request extension
                    self.ouparam["dl"] = res_path.split("/")[-1]
                if bos.path.exists(ap) or bos.path.exists(ap + ".gz"):
                    return self.tx_file("oh_g", ap)
                else:
                    return self.tx_res(res_path)

            self.tx_404()
            return False

        # KD fork: cf.html template removed; just 404 the challenge URL
        if "cf_challenge" in self.uparam:
            return self.tx_404()

        if not self.can_read and not self.can_write and not self.can_get:
            t = "@%s has no access to %r"

            if self.vn.realpath and "on403" in self.vn.flags:
                t += " (on403)"
                self.log(t % (self.uname, "/" + self.vpath))
                ret = self.on40x(self.vn.flags["on403"], self.vn, self.rem)
                if ret == "true":
                    return True
                elif ret == "false":
                    return False
                elif ret == "home":
                    self.uparam["h"] = ""
                elif ret == "allow":
                    self.log("plugin override; access permitted")
                    self.can_read = self.can_write = self.can_move = True
                    self.can_delete = self.can_get = self.can_upget = True
                    self.can_admin = True
                else:
                    return self.tx_404(True)
            else:
                if (
                    self.asrv.badcfg1
                    and "h" not in self.ouparam
                    and "hc" not in self.ouparam
                ):
                    zs1 = "kopyparty refused to start due to a failsafe: invalid server config; check server log"
                    zs2 = 'you may <a href="/?h">access the controlpanel</a> but nothing will work until you shutdown the kopyparty container and %s config-file (or provide the configuration as command-line arguments)'
                    if self.asrv.is_lxc and len(self.asrv.cfg_files_loaded) == 1:
                        zs2 = zs2 % ("add a",)
                    else:
                        zs2 = zs2 % ("fix the",)

                    html = self.j2s("msg", h1=zs1, h2=zs2)
                    self.reply(html.encode("utf-8", "replace"), 500)
                    return True

                if "ls" in self.uparam:
                    return self.tx_ls_vols()

                if self.vpath:
                    ptn = self.args.nonsus_urls
                    if not ptn or not ptn.search(self.vpath):
                        self.log(t % (self.uname, "/" + self.vpath))

                    return self.tx_404(True)

                self.uparam["h"] = ""

        if "smsg" in self.uparam:
            return self.handle_smsg()

        if "tree" in self.uparam:
            return self.tx_tree()

        # KD fork: ?scan / ?reload / ?stack admin actions and ?delete/?move/?copy
        # GET-modifications removed (read-only archive)
        if "scan" in self.uparam or "reload" in self.uparam or "stack" in self.uparam:
            return self.tx_404()

        if not self.vpath and self.ouparam:
            if "setck" in self.uparam:
                return self.setck()

            if "reset" in self.uparam:
                return self.set_cfg_reset()

            if "hc" in self.uparam:
                return self.tx_svcs()

            # KD fork: ?shares and ?idp removed (templates deleted)
            if "shares" in self.uparam or "idp" in self.uparam:
                return self.tx_404()

            if "dls" in self.uparam:
                return self.tx_dls()

            if "ru" in self.uparam:
                return self.tx_rups()

        if "h" in self.uparam:
            return self.tx_mounts()

        if "ups" in self.uparam:
            # vpath is used for share translation
            return self.tx_ups()

        if "rss" in self.uparam:
            return self.tx_rss()

        return self.tx_browser()

    def tx_rss(self) -> bool:
        if self.do_log:
            self.log("RSS  %s @%s" % (self.req, self.uname))

        if not self.can_read:
            return self.tx_404(True)

        vn = self.vn
        if not vn.flags.get("rss"):
            raise Pebkac(405, "RSS is disabled in server config")

        rem = self.rem
        idx = self.conn.get_u2idx()
        if not idx or not hasattr(idx, "p_end"):
            if not HAVE_SQLITE3:
                raise Pebkac(500, "sqlite3 not found on server; rss is disabled")
            raise Pebkac(500, "server busy, cannot generate rss; please retry in a bit")

        uv = [rem]
        if "recursive" in self.uparam:
            uq = "up.rd like ?||'%'"
        else:
            uq = "up.rd == ?"

        zs = str(self.uparam.get("fext", self.args.rss_fext))
        if zs in ("True", "False"):
            zs = ""
        if zs:
            zsl = []
            for ext in zs.split(","):
                zsl.append("+up.fn like '%.'||?")
                uv.append(ext)
            uq += " and ( %s )" % (" or ".join(zsl),)

        zs1 = self.uparam.get("sort") or self.args.rss_sort
        zs2 = zs1.lower()
        zs = RSS_SORT.get(zs2)
        if not zs:
            raise Pebkac(400, "invalid sort key; must be m/u/n/s")

        uq += " order by up." + zs
        if zs1 == zs2:
            uq += " desc"

        nmax = int(self.uparam.get("nf") or self.args.rss_nf)

        hits = idx.run_query(self.uname, [self.vn], uq, uv, False, False, nmax)[0]

        q_pw = a_pw = ""
        pwk = self.args.pw_urlp
        if pwk in self.ouparam and "nopw" not in self.ouparam:
            zs = self.ouparam[pwk]
            q_pw = "?%s=%s" % (pwk, quotep(zs))
            a_pw = "&%s=%s" % (pwk, quotep(zs))
            for i in hits:
                i["rp"] += a_pw if "?" in i["rp"] else q_pw

        title = self.uparam.get("title") or self.vpath.split("/")[-1]
        etitle = html_escape(title, True, True)

        baseurl = "%s://%s/" % (
            "https" if self.is_https else "http",
            self.host,
        )
        feed = baseurl + self.req[1:]
        if pwk in self.ouparam and self.ouparam.get("nopw") == "a":
            feed = re.sub(r"&%s=[^&]*" % (pwk,), "", feed)
        if self.is_vproxied:
            baseurl += self.args.RS
        efeed = html_escape(feed, True, True)
        edirlink = efeed.split("?")[0] + q_pw

        ret = [
            """\
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
\t<channel>
\t\t<atom:link href="%s" rel="self" type="application/rss+xml" />
\t\t<title>%s</title>
\t\t<description></description>
\t\t<link>%s</link>
\t\t<generator>kopyparty-2</generator>
"""
            % (efeed, etitle, edirlink)
        ]

        q = "select fn from cv where rd=? and dn=?"
        crd, cdn = rem.rsplit("/", 1) if "/" in rem else ("", rem)
        try:
            cfn = idx.cur[self.vn.realpath].execute(q, (crd, cdn)).fetchone()[0]
            bos.stat(os.path.join(vn.canonical(rem), cfn))
            cv_url = "%s%s?th=jf%s" % (baseurl, vjoin(self.vpath, cfn), a_pw)
            cv_url = html_escape(cv_url, True, True)
            zs = """\
\t\t<image>
\t\t\t<url>%s</url>
\t\t\t<title>%s</title>
\t\t\t<link>%s</link>
\t\t</image>
"""
            ret.append(zs % (cv_url, etitle, edirlink))
        except:
            pass

        ap = ""
        use_magic = "rmagic" in self.vn.flags

        tpl_t = self.uparam.get("fmt_t") or self.vn.flags["rss_fmt_t"]
        tpl_d = self.uparam.get("fmt_d") or self.vn.flags["rss_fmt_d"]
        kw_t = [[x, x[1:-1]] for x in RE_RSS_KW.findall(tpl_t)]
        kw_d = [[x, x[1:-1]] for x in RE_RSS_KW.findall(tpl_d)]

        for i in hits:
            if use_magic:
                ap = os.path.join(self.vn.realpath, i["rp"])

            tags = i["tags"]
            iurl = html_escape("%s%s" % (baseurl, i["rp"]), True, True)
            fname = tags["fname"] = unquotep(i["rp"].split("?")[0].split("/")[-1])
            title = tpl_t
            desc = tpl_d
            for zs1, zs2 in kw_t:
                title = title.replace(zs1, str(tags.get(zs2, "")))
            for zs1, zs2 in kw_d:
                desc = desc.replace(zs1, str(tags.get(zs2, "")))
            title = html_escape(title.strip(), True, True)
            if desc.strip(" -,"):
                desc = html_escape(desc.strip(), True, True)
            else:
                desc = title

            mime = html_escape(guess_mime(fname, ap))
            lmod = formatdate(max(0, i["ts"]))
            zsa = (iurl, iurl, title, desc, lmod, iurl, mime, i["sz"])
            zs = (
                """\
\t\t<item>
\t\t\t<guid>%s</guid>
\t\t\t<link>%s</link>
\t\t\t<title>%s</title>
\t\t\t<description>%s</description>
\t\t\t<pubDate>%s</pubDate>
\t\t\t<enclosure url="%s" type="%s" length="%d"/>
"""
                % zsa
            )
            dur = i["tags"].get(".dur")
            if dur:
                zs += "\t\t\t<itunes:duration>%d</itunes:duration>\n" % (dur,)
            ret.append(zs + "\t\t</item>\n")

        ret.append("\t</channel>\n</rss>\n")
        bret = "".join(ret).encode("utf-8", "replace")
        self.reply(bret, 200, "text/xml; charset=utf-8")
        self.log("rss: %d hits, %d bytes" % (len(hits), len(bret)))
        return True

    def tx_zls(self, abspath) -> bool:
        if self.do_log:
            self.log("zls %s @%s" % (self.req, self.uname))
        if self.args.no_zls:
            raise Pebkac(405, "zip browsing is disabled in server config")

        import zipfile

        try:
            with zipfile.ZipFile(abspath, "r") as zf:
                filelist = [{"fn": f.filename} for f in zf.infolist()]
                ret = json.dumps(filelist).encode("utf-8", "replace")
                self.reply(ret, mime="application/json")
                return True
        except (zipfile.BadZipfile, RuntimeError):
            raise Pebkac(404, "requested file is not a valid zip file")

    def tx_zget(self, abspath) -> bool:
        maxsz = 1024 * 1024 * 64

        inner_path = self.uparam.get("zget")
        if not inner_path:
            raise Pebkac(405, "inner path is required")
        if self.do_log:
            self.log(
                "zget %s \033[35m%s\033[0m @%s" % (self.req, inner_path, self.uname)
            )
        if self.args.no_zls:
            raise Pebkac(405, "zip browsing is disabled in server config")

        import zipfile

        try:
            with zipfile.ZipFile(abspath, "r") as zf:
                zi = zf.getinfo(inner_path)
                if zi.file_size >= maxsz:
                    raise Pebkac(404, "zip bomb defused")
                with zf.open(zi, "r") as fi:
                    mime = guess_mime(inner_path)
                    if mime not in SAFE_MIMES and "nohtml" in self.vn.flags:
                        mime = safe_mime(mime)
                    self.send_headers("oh_f", length=zi.file_size, mime=mime)

                    sendfile_py(
                        self.log,
                        0,
                        zi.file_size,
                        fi,
                        self.s,
                        self.args.s_wr_sz,
                        self.args.s_wr_slp,
                        not self.args.no_poll,
                        {},
                        "",
                    )
        except KeyError:
            raise Pebkac(404, "no such file in archive")
        except (zipfile.BadZipfile, RuntimeError):
            raise Pebkac(404, "requested file is not a valid zip file")
        return True

    # KD fork: WebDAV (PROPFIND/PROPPATCH/LOCK/UNLOCK/MKCOL/MOVE/COPY) handlers removed

    def handle_options(self) -> bool:
        if self.do_log:
            self.log("OPTIONS %s @%s" % (self.req, self.uname))
            if "%" in self.req:
                self.log("    `-- %r" % (self.vpath,))

        # KD fork: read-only archive — only GET/HEAD/OPTIONS allowed
        self.out_headers["Allow"] = "GET, HEAD, OPTIONS"
        self.send_headers("oh_f", 0, 200)
        return True

    # KD fork: handle_delete / handle_put removed (read-only archive)

    def handle_post(self) -> bool:
        # KD fork: read-only archive — all POSTs are rejected
        self.log("POST %s @%s rejected (read-only)" % (self.req, self.uname))
        raise Pebkac(405, "POST not allowed (read-only archive)")

    def _spd(self, nbytes: int, add: bool = True) -> str:
        # KD fork: minimal speed reporter restored (also called from GET tx_file
        # which logs transfer speed). The full version tracked per-connection
        # totals — we just report this transfer's speed.
        if add:
            self.conn.nbyte += nbytes
        spd1 = get_spd(nbytes, self.t0)
        spd2 = get_spd(self.conn.nbyte, self.conn.t0)
        return "%s %s n%s" % (spd1, spd2, self.conn.nreq)

    # KD fork: handle_smsg removed (POST rejected)

    # KD fork: get_xml_enc / get_body_reader / dump_to_file / handle_stash / bakflip / _spd removed (POST rejected)

    # KD fork: handle_post_multipart / handle_zip_post / handle_post_json / handle_search / handle_post_binary removed (POST rejected)

    # KD fork: get_pwd_cookie / set_idp_cookie / handle_mkdir / _mkdir / handle_new_md / upload_flags / handle_plain_upload / handle_text_upload removed (read-only)

    def _chk_lastmod(self, file_ts: int) -> tuple[str, bool, bool]:
        # ret: lastmod, do_send, can_range
        file_lastmod = formatdate(file_ts)
        c_ifrange = self.headers.get("if-range")
        c_lastmod = self.headers.get("if-modified-since")

        if not c_ifrange and not c_lastmod:
            return file_lastmod, True, True

        if c_ifrange and c_ifrange != file_lastmod:
            t = "sending entire file due to If-Range; cli(%s) file(%s)"
            self.log(t % (c_ifrange, file_lastmod), 6)
            return file_lastmod, True, False

        do_send = c_lastmod != file_lastmod
        if do_send and c_lastmod:
            t = "sending body due to If-Modified-Since cli(%s) file(%s)"
            self.log(t % (c_lastmod, file_lastmod), 6)
        elif not do_send and self.no304():
            do_send = True
            self.log("sending body due to no304")

        return file_lastmod, do_send, True

    def _use_dirkey(self, vn: VFS, ap: str) -> bool:
        if self.can_read or not self.can_get:
            return False

        if vn.flags.get("dky"):
            return True

        req = self.uparam.get("k") or ""
        if not req:
            return False

        dk_len = vn.flags.get("dk")
        if not dk_len:
            return False

        if not ap:
            ap = vn.canonical(self.rem)

        zs = self.gen_fk(2, self.args.dk_salt, ap, 0, 0)[:dk_len]
        if req == zs:
            return True

        t = "wrong dirkey, want %s, got %s\n  vp: %r\n  ap: %r"
        self.log(t % (zs, req, self.req, ap), 6)
        return False

    def _use_filekey(self, vn: VFS, ap: str, st: os.stat_result) -> bool:
        if self.can_read or not self.can_get:
            return False

        req = self.uparam.get("k") or ""
        if not req:
            return False

        fk_len = vn.flags.get("fk")
        if not fk_len:
            return False

        if not ap:
            ap = self.vn.canonical(self.rem)

        alg = 2 if "fka" in vn.flags else 1

        zs = self.gen_fk(
            alg, self.args.fk_salt, ap, st.st_size, 0 if ANYWIN else st.st_ino
        )[:fk_len]

        if req == zs:
            return True

        t = "wrong filekey, want %s, got %s\n  vp: %r\n  ap: %r"
        self.log(t % (zs, req, self.req, ap), 6)
        return False

    def _add_logues(
        self, vn: VFS, abspath: str, lnames: Optional[dict[str, str]]
    ) -> tuple[list[str], list[str]]:
        logues = ["", ""]
        for n, fns1, fns2 in [] if self.args.no_logues else vn.flags["emb_lgs"]:
            for fn in fns1 if lnames is None else fns2:
                if lnames is not None:
                    fn = lnames.get(fn)
                    if not fn:
                        continue
                fn = "%s/%s" % (abspath, fn)
                if not bos.path.isfile(fn):
                    continue
                logues[n] = read_utf8(self.log, fsenc(fn), False)
                if "exp" in vn.flags:
                    logues[n] = self._expand(logues[n], vn.flags.get("exp_lg") or [])
                break

        readmes = ["", ""]
        for n, fns1, fns2 in [] if self.args.no_readme else vn.flags["emb_mds"]:
            if logues[n]:
                continue
            for fn in fns1 if lnames is None else fns2:
                if lnames is not None:
                    fn = lnames.get(fn.lower())
                    if not fn:
                        continue
                fn = "%s/%s" % (abspath, fn)
                if not bos.path.isfile(fn):
                    continue
                readmes[n] = read_utf8(self.log, fsenc(fn), False)
                if "exp" in vn.flags:
                    readmes[n] = self._expand(readmes[n], vn.flags.get("exp_md") or [])
                break

        return logues, readmes

    def _expand(self, txt: str, phs: list[str]) -> str:
        ptn_hsafe = RE_HSAFE
        for ph in phs:
            if ph.startswith("hdr."):
                sv = str(self.headers.get(ph[4:], ""))
            elif ph.startswith("self."):
                sv = str(getattr(self, ph[5:], ""))
            elif ph.startswith("cfg."):
                sv = str(getattr(self.args, ph[4:], ""))
            elif ph.startswith("vf."):
                sv = str(self.vn.flags.get(ph[3:]) or "")
            elif ph == "srv.itime":
                sv = str(int(time.time()))
            elif ph == "srv.htime":
                sv = datetime.now(UTC).strftime("%Y-%m-%d, %H:%M:%S")
            else:
                self.log("unknown placeholder in server config: [%s]" % (ph,), 3)
                continue

            sv = ptn_hsafe.sub("_", sv)
            txt = txt.replace("{{%s}}" % (ph,), sv)

        return txt

    def _can_tail(self, volflags: dict[str, Any]) -> bool:
        zp = self.args.ua_nodoc
        if zp and zp.search(self.ua):
            t = "this URL contains no valuable information for bots/crawlers"
            raise Pebkac(403, t)
        lvl = volflags["tail_who"]
        if "notail" in volflags or not lvl:
            raise Pebkac(400, "tail is disabled in server config")
        elif lvl <= 1 and not self.can_admin:
            raise Pebkac(400, "tail is admin-only on this server")
        elif lvl <= 2 and self.uname in ("", "*"):
            raise Pebkac(400, "you must be authenticated to use ?tail on this server")
        return True

    def _can_zip(self, volflags: dict[str, Any]) -> str:
        lvl = volflags["zip_who"]
        if self.args.no_zip or not lvl:
            return "download-as-zip/tar is disabled in server config"
        elif lvl <= 1 and not self.can_admin:
            return "download-as-zip/tar is admin-only on this server"
        elif lvl <= 2 and self.uname in ("", "*"):
            return "you must be authenticated to download-as-zip/tar on this server"
        elif self.args.ua_nozip and self.args.ua_nozip.search(self.ua):
            t = "this URL contains no valuable information for bots/crawlers"
            raise Pebkac(403, t)
        return ""

    def tx_res(self, req_path: str) -> bool:
        status = 200
        logmsg = "{:4} {} ".format("", self.req)
        logtail = ""

        editions = {}
        file_ts = 0

        if has_resource(self.E, req_path):
            st = stat_resource(self.E, req_path)
            if st:
                file_ts = max(file_ts, st.st_mtime)
            editions["plain"] = req_path

        if has_resource(self.E, req_path + ".gz"):
            st = stat_resource(self.E, req_path + ".gz")
            if st:
                file_ts = max(file_ts, st.st_mtime)
            if not st or st.st_mtime > file_ts:
                editions[".gz"] = req_path + ".gz"

        if not editions:
            return self.tx_404()

        #
        # force download

        if "dl" in self.ouparam:
            cdis = self.ouparam["dl"] or req_path
            zs = gen_content_disposition(os.path.basename(cdis))
            self.out_headers["Content-Disposition"] = zs
        else:
            cdis = req_path

        #
        # if-modified

        if file_ts > 0:
            file_lastmod, do_send, _ = self._chk_lastmod(int(file_ts))
            self.out_headers["Last-Modified"] = file_lastmod
            if not do_send:
                status = 304

            if self.can_write:
                self.out_headers["X-Lastmod3"] = str(int(file_ts * 1000))
        else:
            do_send = True

        #
        # Accept-Encoding and UA decides which edition to send

        decompress = False
        supported_editions = [
            x.strip()
            for x in self.headers.get("accept-encoding", "").lower().split(",")
        ]
        if ".gz" in editions:
            is_compressed = True
            selected_edition = ".gz"

            if "gzip" not in supported_editions:
                decompress = True
            else:
                if re.match(r"MSIE [4-6]\.", self.ua) and " SV1" not in self.ua:
                    decompress = True

            if not decompress:
                self.out_headers["Content-Encoding"] = "gzip"
        else:
            is_compressed = False
            selected_edition = "plain"

        res_path = editions[selected_edition]
        logmsg += "{} ".format(selected_edition.lstrip("."))

        res = load_resource(self.E, res_path)

        if decompress:
            file_sz = gzip_file_orig_sz(res)
            res = gzip.open(res)
        else:
            res.seek(0, os.SEEK_END)
            file_sz = res.tell()
            res.seek(0, os.SEEK_SET)

        #
        # send reply

        if is_compressed:
            self.out_headers["Cache-Control"] = "max-age=604869"
        else:
            self.permit_caching()

        if "txt" in self.uparam:
            mime = "text/plain; charset={}".format(self.uparam["txt"] or "utf-8")
        elif "mime" in self.uparam:
            mime = str(self.uparam.get("mime"))
        else:
            mime = guess_mime(cdis)

        logmsg += unicode(status) + logtail

        if self.mode == "HEAD" or not do_send:
            res.close()
            if self.do_log:
                self.log(logmsg)

            self.send_headers("oh_g", length=file_sz, status=status, mime=mime)
            return True

        ret = True
        self.send_headers("oh_g", length=file_sz, status=status, mime=mime)
        remains = sendfile_py(
            self.log,
            0,
            file_sz,
            res,
            self.s,
            self.args.s_wr_sz,
            self.args.s_wr_slp,
            not self.args.no_poll,
            {},
            "",
        )
        res.close()

        if remains > 0:
            logmsg += " \033[31m" + unicode(file_sz - remains) + "\033[0m"
            ret = False

        spd = self._spd(file_sz - remains)
        if self.do_log:
            self.log("{},  {}".format(logmsg, spd))

        return ret

    def tx_file(self, oh_k: str, req_path: str, ptop: Optional[str] = None) -> bool:
        status = 200
        logmsg = "{:4} {} ".format("", self.req)
        logtail = ""

        is_tail = "tail" in self.uparam and self._can_tail(self.vn.flags)

        if ptop is not None:
            ap_data = "<%s>" % (req_path,)
            try:
                dp, fn = os.path.split(req_path)
                tnam = fn + ".PARTIAL"
                if self.args.dotpart:
                    tnam = "." + tnam
                ap_data = os.path.join(dp, tnam)
                st_data = bos.stat(ap_data)
                if not st_data.st_size:
                    raise Exception("partial is empty")
                x = self.conn.hsrv.broker.ask("up2k.find_job_by_ap", ptop, req_path)
                job = json.loads(x.get())
                if not job:
                    raise Exception("not found in registry")
                self.pipes.set(req_path, job)
            except Exception as ex:
                if getattr(ex, "errno", 0) != errno.ENOENT:
                    self.log("will not pipe %r; %s" % (ap_data, ex), 6)
                ptop = None

        #
        # if request is for foo.js, check if we have foo.js.gz

        file_ts = 0.0
        editions: dict[str, tuple[str, int]] = {}
        for ext in ("", ".gz"):
            if ptop is not None:
                assert job and ap_data  # type: ignore  # !rm
                sz = job["size"]
                file_ts = max(0, job["lmod"])
                editions["plain"] = (ap_data, sz)
                break

            try:
                fs_path = req_path + ext
                st = bos.stat(fs_path)
                if stat.S_ISDIR(st.st_mode):
                    continue

                sz = st.st_size
                if stat.S_ISBLK(st.st_mode):
                    fd = bos.open(fs_path, os.O_RDONLY)
                    try:
                        sz = os.lseek(fd, 0, os.SEEK_END)
                    finally:
                        os.close(fd)

                file_ts = max(file_ts, st.st_mtime)
                editions[ext or "plain"] = (fs_path, sz)
            except:
                pass
            if not self.vpath.startswith(".kpr/"):
                break

        if not editions:
            return self.tx_404()

        #
        # force download

        if "dl" in self.ouparam:
            cdis = self.ouparam["dl"] or req_path
            zs = gen_content_disposition(os.path.basename(cdis))
            self.out_headers["Content-Disposition"] = zs
        else:
            cdis = req_path

        #
        # if-modified

        file_lastmod, do_send, can_range = self._chk_lastmod(int(file_ts))
        self.out_headers["Last-Modified"] = file_lastmod
        if not do_send:
            status = 304

        if self.can_write:
            self.out_headers["X-Lastmod3"] = str(int(file_ts * 1000))

        #
        # Accept-Encoding and UA decides which edition to send

        decompress = False
        supported_editions = [
            x.strip()
            for x in self.headers.get("accept-encoding", "").lower().split(",")
        ]
        if ".gz" in editions:
            is_compressed = True
            selected_edition = ".gz"
            fs_path, file_sz = editions[".gz"]
            if "gzip" not in supported_editions:
                decompress = True
            else:
                if re.match(r"MSIE [4-6]\.", self.ua) and " SV1" not in self.ua:
                    decompress = True

            if not decompress:
                self.out_headers["Content-Encoding"] = "gzip"
        else:
            is_compressed = False
            selected_edition = "plain"

        fs_path, file_sz = editions[selected_edition]
        logmsg += "{} ".format(selected_edition.lstrip("."))

        #
        # partial

        lower = 0
        upper = file_sz
        hrange = self.headers.get("range")

        # let's not support 206 with compression
        # and multirange / multipart is also not-impl (mostly because calculating contentlength is a pain)
        if (
            do_send
            and not is_compressed
            and hrange
            and can_range
            and file_sz
            and "," not in hrange
            and not is_tail
        ):
            try:
                if not hrange.lower().startswith("bytes"):
                    raise Exception()

                a, b = hrange.split("=", 1)[1].split("-")

                if a.strip():
                    lower = int(a.strip())
                else:
                    lower = 0

                if b.strip():
                    upper = int(b.strip()) + 1
                else:
                    upper = file_sz

                if upper > file_sz:
                    upper = file_sz

                if lower < 0 or lower >= upper:
                    raise Exception()

            except:
                err = "invalid range ({}), size={}".format(hrange, file_sz)
                self.loud_reply(
                    err,
                    status=416,
                    headers={"Content-Range": "bytes */{}".format(file_sz)},
                )
                return True

            status = 206
            self.out_headers["Content-Range"] = "bytes {}-{}/{}".format(
                lower, upper - 1, file_sz
            )

            logtail += " [\033[36m{}-{}\033[0m]".format(lower, upper)

        use_sendfile = False
        if decompress:
            open_func: Any = gzip.open
            open_args: list[Any] = [fsenc(fs_path), "rb"]
            # Content-Length := original file size
            upper = gzip_orig_sz(fs_path)
        else:
            open_func = open
            open_args = [fsenc(fs_path), "rb", self.args.iobuf]
            use_sendfile = (
                # fmt: off
                not self.tls
                and not self.args.no_sendfile
                and (BITNESS > 32 or file_sz < 0x7fffFFFF)
                # fmt: on
            )

        #
        # send reply

        if is_compressed:
            self.out_headers["Cache-Control"] = "max-age=604869"
        else:
            self.permit_caching()

        if "txt" in self.uparam:
            mime = "text/plain; charset={}".format(self.uparam["txt"] or "utf-8")
        elif "mime" in self.uparam:
            mime = str(self.uparam.get("mime"))
        elif "rmagic" in self.vn.flags:
            mime = guess_mime(req_path, fs_path)
        else:
            mime = guess_mime(cdis)

        if mime not in SAFE_MIMES and "nohtml" in self.vn.flags and oh_k != "oh_g":
            mime = safe_mime(mime)

        self.out_headers["Accept-Ranges"] = "bytes"
        logmsg += unicode(status) + logtail

        if self.mode == "HEAD" or not do_send:
            if self.do_log:
                self.log(logmsg)

            self.send_headers(oh_k, length=upper - lower, status=status, mime=mime)
            return True

        dls = self.conn.hsrv.dls
        if is_tail:
            upper = 1 << 30
            if len(dls) > self.args.tail_cmax:
                raise Pebkac(400, "too many active downloads to start a new tail")

        if upper - lower > 0x400000:  # 4m
            now = time.time()
            self.dl_id = "%s:%s" % (self.ip, self.addr[1])
            dls[self.dl_id] = (now, 0)
            self.conn.hsrv.dli[self.dl_id] = (
                now,
                0 if is_tail else upper - lower,
                self.vn,
                self.vpath,
                self.uname,
            )

        if ptop is not None:
            assert job and ap_data  # type: ignore  # !rm
            return self.tx_pipe(
                ptop, req_path, ap_data, job, lower, upper, status, mime, logmsg
            )
        elif is_tail:
            self.tx_tail(open_args, status, mime)
            return False

        ret = True
        with open_func(*open_args) as f:
            self.send_headers(oh_k, length=upper - lower, status=status, mime=mime)

            sendfun = sendfile_kern if use_sendfile else sendfile_py
            remains = sendfun(
                self.log,
                lower,
                upper,
                f,
                self.s,
                self.args.s_wr_sz,
                self.args.s_wr_slp,
                not self.args.no_poll,
                dls,
                self.dl_id,
            )

        if remains > 0:
            logmsg += " \033[31m" + unicode(upper - remains) + "\033[0m"
            ret = False

        spd = self._spd((upper - lower) - remains)
        if self.do_log:
            self.log("{},  {}".format(logmsg, spd))

        return ret

    def tx_tail(
        self,
        open_args: list[Any],
        status: int,
        mime: str,
    ) -> None:
        vf = self.vn.flags
        self.send_headers("oh_f", length=None, status=status, mime=mime)
        abspath: bytes = open_args[0]
        sec_rate = vf["tail_rate"]
        sec_max = vf["tail_tmax"]
        sec_fd = vf["tail_fd"]
        sec_ka = self.args.tail_ka
        wr_slp = self.args.s_wr_slp
        wr_sz = self.args.s_wr_sz
        dls = self.conn.hsrv.dls
        dl_id = self.dl_id

        # non-numeric = full file from start
        # positive = absolute offset from start
        # negative = start that many bytes from eof
        try:
            ofs = int(self.uparam["tail"])
        except:
            ofs = 0

        t0 = time.time()
        ofs0 = ofs
        f = None
        try:
            st = os.stat(abspath)
            f = open_nolock(*open_args)
            f.seek(0, os.SEEK_END)
            eof = f.tell()
            f.seek(0)
            if ofs < 0:
                ofs = max(0, ofs + eof)

            self.log("tailing from byte %d: %r" % (ofs, abspath), 6)

            # send initial data asap
            remains = sendfile_py(
                self.log,  # d/c
                ofs,
                eof,
                f,
                self.s,
                wr_sz,
                wr_slp,
                False,  # d/c
                dls,
                dl_id,
            )
            sent = (eof - ofs) - remains
            ofs = eof - remains
            f.seek(ofs)

            try:
                st2 = os.stat(open_args[0])
                if st.st_ino == st2.st_ino:
                    st = st2  # for filesize
            except:
                pass

            gone = 0
            unsent = False
            t_fd = t_ka = time.time()
            while True:
                assert f  # !rm
                buf = f.read(4096)
                now = time.time()

                if sec_max and now - t0 >= sec_max:
                    self.log("max duration exceeded; kicking client", 6)
                    zb = b"\n\n*** max duration exceeded; disconnecting ***\n"
                    self.s.sendall(zb)
                    break

                if buf:
                    t_fd = t_ka = now
                    self.s.sendall(buf)
                    sent += len(buf)
                    unsent = False
                    dls[dl_id] = (time.time(), sent)
                    continue

                time.sleep(sec_rate)
                if t_ka < now - sec_ka:
                    t_ka = now
                    self.s.send(b"\x00")
                if t_fd < now - sec_fd:
                    try:
                        st2 = os.stat(open_args[0])
                        szd = st2.st_size - st.st_size
                        if (
                            st2.st_ino != st.st_ino
                            or st2.st_size < sent
                            or szd < 0
                            or unsent
                        ):
                            assert f  # !rm
                            # open new file before closing previous to avoid toctous (open may fail; cannot null f before)
                            f2 = open_nolock(*open_args)
                            f.close()
                            f = f2
                            f.seek(0, os.SEEK_END)
                            eof = f.tell()
                            if eof < sent:
                                ofs = sent = 0  # shrunk; send from start
                                zb = b"\n\n*** file size decreased -- rewinding to the start of the file ***\n\n"
                                self.s.sendall(zb)
                                if ofs0 < 0 and eof > -ofs0:
                                    ofs = eof + ofs0
                            else:
                                ofs = sent  # just new fd? resume from same ofs
                            f.seek(ofs)
                            self.log("reopened at byte %d: %r" % (ofs, abspath), 6)
                            unsent = False
                            gone = 0
                        elif szd:
                            unsent = True
                        st = st2
                    except:
                        gone += 1
                        if gone > 3:
                            self.log("file deleted; disconnecting")
                            break
        except IOError as ex:
            if ex.errno not in E_SCK_WR:
                raise
        finally:
            if f:
                f.close()

    def tx_pipe(
        self,
        ptop: str,
        req_path: str,
        ap_data: str,
        job: dict[str, Any],
        lower: int,
        upper: int,
        status: int,
        mime: str,
        logmsg: str,
    ) -> bool:
        M = 1048576
        self.send_headers("oh_f", length=upper - lower, status=status, mime=mime)
        wr_slp = self.args.s_wr_slp
        wr_sz = self.args.s_wr_sz
        file_size = job["size"]
        chunk_size = up2k_chunksize(file_size)
        num_need = -1
        data_end = 0
        remains = upper - lower
        broken = False
        spins = 0
        tier = 0
        tiers = ["uncapped", "reduced speed", "one byte per sec"]

        while lower < upper and not broken:
            with self.u2mutex:
                job = self.pipes.get(req_path)
                if not job:
                    x = self.conn.hsrv.broker.ask("up2k.find_job_by_ap", ptop, req_path)
                    job = json.loads(x.get())
                    if job:
                        self.pipes.set(req_path, job)

            if not job:
                t = "pipe: OK, upload has finished; yeeting remainder"
                self.log(t, 2)
                data_end = file_size
                break

            if num_need != len(job["need"]) and data_end - lower < 8 * M:
                num_need = len(job["need"])
                data_end = 0
                for cid in job["hash"]:
                    if cid in job["need"]:
                        break
                    data_end += chunk_size
                t = "pipe: can stream %.2f MiB; requested range is %.2f to %.2f"
                self.log(t % (data_end / M, lower / M, upper / M), 6)
                with self.u2mutex:
                    if data_end > self.u2fh.aps.get(ap_data, data_end):
                        fhs: Optional[set[typing.BinaryIO]] = None
                        try:
                            fhs = self.u2fh.cache[ap_data].all_fhs
                            for fh in fhs:
                                fh.flush()
                            self.u2fh.aps[ap_data] = data_end
                            self.log("pipe: flushed %d up2k-FDs" % (len(fhs),))
                        except Exception as ex:
                            if fhs is None:
                                err = "file is not being written to right now"
                            else:
                                err = repr(ex)
                            self.log("pipe: u2fh flush failed: " + err)

            if lower >= data_end:
                if data_end:
                    t = "pipe: uploader is too slow; aborting download at %.2f MiB"
                    self.log(t % (data_end / M,))
                    raise Pebkac(416, "uploader is too slow")

                raise Pebkac(416, "no data available yet; please retry in a bit")

            slack = data_end - lower
            if slack >= 8 * M:
                ntier = 0
                winsz = M
                bufsz = wr_sz
                slp = wr_slp
            else:
                winsz = max(40, int(M * (slack / (12 * M))))
                base_rate = M if not wr_slp else wr_sz / wr_slp
                if winsz > base_rate:
                    ntier = 0
                    bufsz = wr_sz
                    slp = wr_slp
                elif winsz > 300:
                    ntier = 1
                    bufsz = winsz // 5
                    slp = 0.2
                else:
                    ntier = 2
                    bufsz = winsz = slp = 1

            if tier != ntier:
                tier = ntier
                self.log("moved to tier %d (%s)" % (tier, tiers[tier]))

            try:
                with open_nolock(ap_data, "rb", self.args.iobuf) as f:
                    f.seek(lower)
                    page = f.read(min(winsz, data_end - lower, upper - lower))
                if not page:
                    raise Exception("got 0 bytes (EOF?)")
            except Exception as ex:
                self.log("pipe: read failed at %.2f MiB: %s" % (lower / M, ex), 3)
                with self.u2mutex:
                    self.pipes.c.pop(req_path, None)
                spins += 1
                if spins > 3:
                    raise Pebkac(500, "file became unreadable")
                time.sleep(2)
                continue

            spins = 0
            pofs = 0
            while pofs < len(page):
                if slp:
                    time.sleep(slp)

                try:
                    buf = page[pofs : pofs + bufsz]
                    self.s.sendall(buf)
                    zi = len(buf)
                    remains -= zi
                    lower += zi
                    pofs += zi
                except:
                    broken = True
                    break

        if lower < upper and not broken:
            with open_nolock(req_path, "rb") as f:
                remains = sendfile_py(
                    self.log,
                    lower,
                    upper,
                    f,
                    self.s,
                    wr_sz,
                    wr_slp,
                    not self.args.no_poll,
                    self.conn.hsrv.dls,
                    self.dl_id,
                )

        spd = self._spd((upper - lower) - remains)
        if self.do_log:
            self.log("{},  {}".format(logmsg, spd))

        return not broken

    def tx_zip(
        self,
        fmt: str,
        uarg: str,
        vpath: str,
        vn: VFS,
        rem: str,
        items: list[str],
    ) -> bool:
        t = self._can_zip(vn.flags)
        if t:
            raise Pebkac(400, t)

        logmsg = "{:4} {} ".format("", self.req)
        self.keepalive = False

        cancmp = not self.args.no_tarcmp

        if fmt == "tar":
            packer: Type[StreamArc] = StreamTar
            if cancmp and "gz" in uarg:
                mime = "application/gzip"
                ext = "tar.gz"
            elif cancmp and "bz2" in uarg:
                mime = "application/x-bzip"
                ext = "tar.bz2"
            elif cancmp and "xz" in uarg:
                mime = "application/x-xz"
                ext = "tar.xz"
            else:
                mime = "application/x-tar"
                ext = "tar"
        else:
            mime = "application/zip"
            packer = StreamZip
            ext = "zip"

        dots = 0 if "nodot" in self.uparam else 1
        scandir = not self.args.no_scandir

        fn = self.vpath.split("/")[-1] or self.host.split(":")[0]
        if items:
            fn = "sel-" + fn

        if vn.flags.get("zipmax") and not (
            vn.flags.get("zipmaxu") and self.uname != "*"
        ):
            maxs = vn.flags.get("zipmaxs_v") or 0
            maxn = vn.flags.get("zipmaxn_v") or 0
            nf = 0
            nb = 0
            fgen = vn.zipgen(vpath, rem, set(items), self.uname, False, dots, scandir)
            t = "total size exceeds a limit specified in server config"
            t = vn.flags.get("zipmaxt") or t
            if maxs and maxn:
                for zd in fgen:
                    nf += 1
                    nb += zd["st"].st_size
                    if maxs < nb or maxn < nf:
                        raise Pebkac(400, t)
            elif maxs:
                for zd in fgen:
                    nb += zd["st"].st_size
                    if maxs < nb:
                        raise Pebkac(400, t)
            elif maxn:
                for zd in fgen:
                    nf += 1
                    if maxn < nf:
                        raise Pebkac(400, t)

        cdis = gen_content_disposition("%s.%s" % (fn, ext))
        self.log(repr(cdis))
        self.send_headers(
            "oh_f", None, mime=mime, headers={"Content-Disposition": cdis}
        )

        fgen = vn.zipgen(vpath, rem, set(items), self.uname, False, dots, scandir)
        # for f in fgen: print(repr({k: f[k] for k in ["vp", "ap"]}))
        cfmt = ""
        if self.thumbcli and not self.args.no_bacode:
            if uarg in ZIP_XCODE_S:
                cfmt = uarg
            else:
                for zs in ZIP_XCODE_L:
                    if zs in self.ouparam:
                        cfmt = zs

            if cfmt:
                self.log("transcoding to [{}]".format(cfmt))
                fgen = gfilter(fgen, self.thumbcli, self.uname, vpath, cfmt)

        now = time.time()
        self.dl_id = "%s:%s" % (self.ip, self.addr[1])
        self.conn.hsrv.dli[self.dl_id] = (
            now,
            0,
            self.vn,
            "%s :%s" % (self.vpath, ext),
            self.uname,
        )
        dls = self.conn.hsrv.dls
        dls[self.dl_id] = (time.time(), 0)

        bgen = packer(
            self.log,
            self.asrv,
            fgen,
            utf8="utf" in uarg or not uarg,
            pre_crc="crc" in uarg,
            cmp=uarg if cancmp or uarg == "pax" else "",
        )
        n = 0
        bsent = 0
        for buf in bgen.gen():
            if not buf:
                break

            try:
                self.s.sendall(buf)
                bsent += len(buf)
            except:
                logmsg += " \033[31m" + unicode(bsent) + "\033[0m"
                bgen.stop()
                break

            n += 1
            if n >= 4:
                n = 0
                dls[self.dl_id] = (time.time(), bsent)

        spd = self._spd(bsent)
        self.log("{},  {}".format(logmsg, spd))
        return True

    def tx_ico(self, ext: str, exact: bool = False) -> bool:
        self.permit_caching()
        if ext.endswith("/"):
            ext = "folder"
            exact = True

        bad = re.compile(r"[](){}/ []|^[0-9_-]*$")
        n = ext.split(".")[::-1]
        if not exact:
            n = n[:-1]

        ext = ""
        for v in n:
            if len(v) > 7 or bad.search(v):
                break

            ext = "{}.{}".format(v, ext)

        ext = ext.rstrip(".") or "unk"
        if len(ext) > 11:
            ext = "~" + ext[-9:]

        return self.tx_svg(ext, exact)

    def tx_svg(self, txt: str, small: bool = False) -> bool:
        # chrome cannot handle more than ~2000 unique SVGs
        # so url-param "raster" returns a png/webp instead
        # (useragent-sniffing kinshi due to caching proxies)
        mime, ico = self.conn.hsrv.ico.get(txt, not small, "raster" in self.uparam)

        lm = formatdate(self.E.t0)
        self.reply(ico, mime=mime, headers={"Last-Modified": lm})
        return True

    def tx_md(self, vn: VFS, fs_path: str) -> bool:
        logmsg = "     %s @%s " % (self.req, self.uname)

        # KD fork: editor templates removed; ?edit/?edit2 always 404
        if "edit" in self.uparam or "edit2" in self.uparam:
            return self.tx_404(True)

        tpl = "md"
        template = self.j2j(tpl)

        st = bos.stat(fs_path)
        ts_md = st.st_mtime

        max_sz = 1024 * self.args.txt_max
        sz_md = 0
        lead = b""
        fullfile = b""
        for buf in yieldfile(fs_path, self.args.iobuf):
            if sz_md < max_sz:
                fullfile += buf
            else:
                fullfile = b""

            if not sz_md and buf.startswith((b"\n", b"\r\n")):
                lead = b"\n" if buf.startswith(b"\n") else b"\r\n"
                sz_md += len(lead)

            sz_md += len(buf)
            for c, v in [(b"&", 4), (b"<", 3), (b">", 3)]:
                sz_md += (len(buf) - len(buf.replace(c, b""))) * v

        if (
            fullfile
            and "exp" in vn.flags
            and "edit" not in self.uparam
            and "edit2" not in self.uparam
            and vn.flags.get("exp_md")
        ):
            fulltxt = fullfile.decode("utf-8", "replace")
            fulltxt = self._expand(fulltxt, vn.flags.get("exp_md") or [])
            fullfile = fulltxt.encode("utf-8", "replace")

        if fullfile:
            fullfile = html_bescape(fullfile)
            sz_md = len(lead) + len(fullfile)

        file_ts = int(max(ts_md, self.E.t0))
        file_lastmod, do_send, _ = self._chk_lastmod(file_ts)
        self.out_headers["Last-Modified"] = file_lastmod
        self.out_headers["Cache-Control"] = "no-cache"
        status = 200 if do_send else 304

        arg_base = "?"
        if "k" in self.uparam:
            arg_base = "?k={}&".format(self.uparam["k"])

        boundary = "\roll\tide"
        targs = {
            "r": self.args.SR if self.is_vproxied else "",
            "ts": self.conn.hsrv.cachebuster(),
            "edit": "edit" in self.uparam,
            "title": html_escape(self.vpath, crlf=True),
            "lastmod": int(ts_md * 1000),
            "lang": self.cookies.get("cplng") or self.args.lang,
            "favico": self.args.favico,
            "have_emp": int(self.args.emp),
            "md_no_br": int(vn.flags.get("md_no_br") or 0),
            "md_chk_rate": self.args.mcr,
            "md": boundary,
            "arg_base": arg_base,
            "this": self,
        }

        if self.args.js_other and "js" not in targs:
            zs = self.args.js_other
            zs += "&" if "?" in zs else "?"
            targs["js"] = zs

        if "html_head_d" in self.vn.flags:
            targs["this"] = self
            self._build_html_head(targs)

        targs["html_head"] = self.html_head
        zs = template.render(**targs).encode("utf-8", "replace")
        html = zs.split(boundary.encode("utf-8"))
        if len(html) != 2:
            raise Exception("boundary appears in " + tpl)

        self.send_headers("oh_g", sz_md + len(html[0]) + len(html[1]), status)

        logmsg += unicode(status)
        if self.mode == "HEAD" or not do_send:
            if self.do_log:
                self.log(logmsg)

            return True

        try:
            self.s.sendall(html[0] + lead)
            if fullfile:
                self.s.sendall(fullfile)
            else:
                for buf in yieldfile(fs_path, self.args.iobuf):
                    self.s.sendall(html_bescape(buf))

            self.s.sendall(html[1])

        except:
            self.log(logmsg + " \033[31md/c\033[0m")
            return False

        if self.do_log:
            self.log(logmsg + " " + unicode(len(html)))

        return True

    def tx_svcs(self) -> bool:
        aname = re.sub("[^0-9a-zA-Z]+", "", self.args.vname) or "a"
        ep = self.host
        sep = "]:" if "]" in ep else ":"
        if sep in ep:
            host, hport = ep.rsplit(":", 1)
            hport = ":" + hport
        else:
            host = ep
            hport = ""

        if host.endswith(".local") and self.args.zm and not self.args.rclone_mdns:
            rip = self.conn.hsrv.nm.map(self.ip) or host
            if ":" in rip and "[" not in rip:
                rip = "[%s]" % (rip,)
        else:
            rip = host

        defpw = "dave:hunter2" if self.args.usernames else "hunter2"

        vp = (self.uparam["hc"] or "").lstrip("/")
        pw = self.ouparam.get(self.args.pw_urlp) or defpw
        if pw in self.asrv.sesa:
            pw = defpw

        unpw = pw
        try:
            un, pw = unpw.split(":")
        except:
            un = ""
            if self.args.usernames:
                un = "dave"

        html = self.j2s(
            "svcs",
            args=self.args,
            accs=bool(self.asrv.acct),
            s="s" if self.is_https else "",
            rip=html_sh_esc(rip),
            ep=html_sh_esc(ep),
            vp=html_sh_esc(vp),
            rvp=html_sh_esc(vjoin(self.args.R, vp)),
            host=html_sh_esc(host),
            hport=html_sh_esc(hport),
            aname=aname,
            b_un=("<b>%s</b>" % (html_sh_esc(un),)) if un else "k",
            un=html_sh_esc(un),
            pw=html_sh_esc(pw),
            unpw=html_sh_esc(unpw),
        )
        self.reply(html.encode("utf-8"))
        return True

    def tx_mounts(self) -> bool:
        suf = self.urlq({}, ["h"])
        rvol, wvol, avol = [
            [("/" + x).rstrip("/") + "/" for x in y]
            for y in [self.rvol, self.wvol, self.avol]
        ]
        for zs in self.asrv.vfs.all_fvols:
            if not zs:
                continue  # webroot
            zs2 = ("/" + zs).rstrip("/") + "/"
            for zsl in (rvol, wvol, avol):
                if zs2 in zsl:
                    zsl[zsl.index(zs2)] = zs2[:-1]

        ups = []
        now = time.time()
        get_vst = self.avol and not self.args.no_rescan
        get_ups = self.rvol and not self.args.no_up_list and self.uname or ""
        if get_vst or get_ups:
            x = self.conn.hsrv.broker.ask("up2k.get_state", get_vst, get_ups)
            vs = json.loads(x.get())
            vstate = {("/" + k).rstrip("/") + "/": v for k, v in vs["volstate"].items()}
            try:
                for rem, sz, t0, poke, vp in vs["ups"]:
                    fdone = max(0.001, 1 - rem)
                    td = max(0.1, now - t0)
                    rd, fn = vsplit(vp.replace(os.sep, "/"))
                    if rd:
                        rds = rd.replace("/", " / ")
                        erd = "/%s/" % (quotep(rd),)
                    else:
                        erd = rds = "/"
                    spd = humansize(sz * fdone / td, True) + "/s"
                    eta = s2hms((td / fdone) - td, True) if rem < 1 else "--"
                    idle = s2hms(now - poke, True)
                    ups.append((int(100 * fdone), spd, eta, idle, erd, rds, fn))
            except Exception as ex:
                self.log("failed to list upload progress: %r" % (ex,), 1)
        if not get_vst:
            vstate = {}
            vs = {
                "scanning": None,
                "hashq": None,
                "tagq": None,
                "mtpq": None,
                "dbwt": None,
            }

        assert vstate is not None and vstate.items and vs  # type: ignore  # !rm

        dls = dl_list = []
        if self.conn.hsrv.tdls:
            zi = self.args.dl_list
            if zi == 2 or (zi == 1 and self.avol):
                dl_list = self.get_dls()
        for t0, t1, sent, sz, vp, dl_id, uname in dl_list:
            td = max(0.1, now - t0)
            rd, fn = vsplit(vp)
            if rd:
                rds = rd.replace("/", " / ")
                erd = "/%s/" % (quotep(rd),)
            else:
                erd = rds = "/"
            spd = humansize(sent / td, True) + "/s"
            hsent = humansize(sent, True)
            idle = s2hms(now - t1, True)
            usr = "%s @%s" % (dl_id, uname) if dl_id else uname
            if sz and sent and td:
                eta = s2hms((sz - sent) / (sent / td), True)
                perc = int(100 * sent / sz)
            else:
                eta = perc = "--"

            fn = html_escape(fn) if fn else self.conn.hsrv.iiam
            dls.append((perc, hsent, spd, eta, idle, usr, erd, rds, fn))

        if self.args.have_unlistc:
            allvols = self.asrv.vfs.all_nodes
            rvol = [x for x in rvol if "unlistcr" not in allvols[x.strip("/")].flags]
            wvol = [x for x in wvol if "unlistcw" not in allvols[x.strip("/")].flags]

        fmt = self.uparam.get("ls", "")
        if not fmt and self.ua.startswith(("curl/", "fetch")):
            fmt = "v"

        if fmt in ["v", "t", "txt"]:
            if self.uname == "*":
                txt = "howdy stranger (you're not logged in)"
            else:
                txt = "welcome back {}".format(self.uname)

            if vstate:
                txt += "\nstatus:"
                for k in ["scanning", "hashq", "tagq", "mtpq", "dbwt"]:
                    txt += " {}({})".format(k, vs[k])

            if ups:
                txt += "\n\nincoming files:"
                for zt in ups:
                    txt += "\n%s" % (", ".join((str(x) for x in zt)),)
                txt += "\n"

            if dls:
                txt += "\n\nactive downloads:"
                for zt in dls:
                    txt += "\n%s" % (", ".join((str(x) for x in zt)),)
                txt += "\n"

            if rvol:
                txt += "\nyou can browse:"
                for v in rvol:
                    txt += "\n  " + v

            if wvol:
                txt += "\nyou can upload to:"
                for v in wvol:
                    txt += "\n  " + v

            zb = txt.encode("utf-8", "replace") + b"\n"
            self.reply(zb, mime="text/plain; charset=utf-8")
            return True

        re_btn = ""
        nre = self.args.ctl_re
        if "re" in self.uparam:
            self.out_headers["Refresh"] = str(nre)
        elif nre:
            re_btn = "&re=%s" % (nre,)

        zi = self.args.ver_iwho
        show_ver = zi and (
            zi == 9 or (zi == 6 and self.uname != "*") or (zi == 3 and avol)
        )

        html = self.j2s(
            "splash",
            this=self,
            qvpath=quotep(self.vpaths) + self.ourlq(),
            rvol=rvol,
            wvol=wvol,
            avol=avol,
            in_shr=self.args.shr and self.vpath.startswith(self.args.shr1),
            vstate=vstate,
            dls=dls,
            ups=ups,
            scanning=vs["scanning"],
            hashq=vs["hashq"],
            tagq=vs["tagq"],
            mtpq=vs["mtpq"],
            dbwt=vs["dbwt"],
            url_suf=suf,
            re=re_btn,
            k304=self.k304(),
            no304=self.no304(),
            k304vis=self.args.k304 > 0,
            no304vis=self.args.no304 > 0,
            msg=(
                BADVER
                if self.conn.hsrv.bad_ver and avol
                else BADXFFB
                if hasattr(self, "bad_xff")
                else ""
            ),
            ver=S_VERSION if show_ver else "",
            chpw=self.args.chpw and self.uname != "*",
            ahttps="" if self.is_https else "https://" + self.host + self.req,
        )
        self.reply(html.encode("utf-8"))
        return True

    def setck(self) -> bool:
        zs = self.uparam["setck"]
        if len(zs) > 9 or RE_SETCK.search(zs):
            raise Pebkac(400, "illegal value")
        k, v = zs.split("=")
        t = 0 if v in ("", "x") else 86400 * 299
        ck = gencookie(k, v, self.args.R, True, False, t)
        self.out_headerlist.append(("Set-Cookie", ck))
        if "cc" in self.ouparam:
            self.redirect("", "?h#cc")
        else:
            self.reply(b"o7\n")
        return True

    def set_cfg_reset(self) -> bool:
        for k in ALL_COOKIES:
            if k not in self.cookies:
                continue
            cookie = gencookie(k, "x", self.args.R, True, False)
            self.out_headerlist.append(("Set-Cookie", cookie))

        self.redirect("", "?h#cc")
        return True

    def tx_404(self, is_403: bool = False) -> bool:
        rc = 404
        if self.args.vague_403:
            t = '<h1 id="n">404 not found &nbsp;┐( ´ -`)┌</h1><p id="o">or maybe you don\'t have access -- try a password or <a href="{}/?h">go home</a></p>'
            pt = "404 not found  ┐( ´ -`)┌   (or maybe you don't have access -- try a password)"
        elif is_403:
            t = '<h1 id="p">403 forbiddena &nbsp;~┻━┻</h1><p id="q">use a password or <a href="{}/?h">go home</a></p>'
            pt = "403 forbiddena ~┻━┻   (you'll have to log in)"
            rc = 403
        else:
            t = '<h1 id="n">404 not found &nbsp;┐( ´ -`)┌</h1><p><a id="r" href="{}/?h">go home</a></p>'
            pt = "404 not found  ┐( ´ -`)┌"

        if self.ua.startswith(("curl/", "fetch")):
            pt = "# acct: %s\n%s\n" % (self.uname, pt)
            self.reply(pt.encode("utf-8"), status=rc)
            return True

        if "th" in self.ouparam and str(self.ouparam["th"])[:1] in "jw":
            return self.tx_svg("e" + pt[:3])

        # most webdav clients will not send credentials until they
        # get 401'd, so send a challenge if we're Absolutely Sure
        # that the client is not a graphical browser
        if rc == 403 and self.uname == "*":
            sport = self.s.getsockname()[1]
            if self.args.dav_port == sport or (
                "sec-fetch-site" not in self.headers
                and self.cookies.get("js") != "y"
                and sport not in self.args.p_nodav
                and (
                    not self.args.ua_nodav.search(self.ua)
                    or (self.args.dav_ua1 and self.args.dav_ua1.search(self.ua))
                )
            ):
                rc = 401
                self.out_headers["WWW-Authenticate"] = 'Basic realm="a"'

        t = t.format(self.args.SR)
        qv = quotep(self.vpaths) + self.ourlq()
        html = self.j2s(
            "splash",
            this=self,
            qvpath=qv,
            msg=t,
            in_shr=self.args.shr and self.vpath.startswith(self.args.shr1),
            ahttps="" if self.is_https else "https://" + self.host + self.req,
        )
        self.reply(html.encode("utf-8"), status=rc)
        return True

    def on40x(self, mods: list[str], vn: VFS, rem: str) -> str:
        for mpath in mods:
            try:
                mod = loadpy(mpath, self.args.hot_handlers)
            except Exception as ex:
                self.log("import failed: {!r}".format(ex))
                continue

            ret = mod.main(self, vn, rem)
            if ret:
                return ret.lower()

        return ""  # unhandled / fallthrough

    # KD fork: scanvol / handle_reload / tx_stack admin handlers removed

    def tx_tree(self) -> bool:
        top = self.uparam["tree"] or ""
        dst = self.vpath
        if top in [".", ".."]:
            top = undot(self.vpath + "/" + top)

        if top == dst:
            dst = ""
        elif top:
            if not dst.startswith(top + "/"):
                raise Pebkac(422, "arg funk")

            dst = dst[len(top) + 1 :]

        ret = self.gen_tree(top, dst, self.uparam.get("k", ""))
        if self.is_vproxied and not self.uparam["tree"]:
            # uparam is '' on initial load, which is
            # the only time we gotta fill in the blanks
            parents = self.args.R.split("/")
            for parent in reversed(parents):
                ret = {"k%s" % (parent,): ret, "a": []}

        zs = json.dumps(ret)
        self.reply(zs.encode("utf-8"), mime="application/json")
        return True

    def gen_tree(self, top: str, target: str, dk: str) -> dict[str, Any]:
        ret: dict[str, Any] = {}
        excl = None
        if target:
            excl, target = (target.split("/", 1) + [""])[:2]
            sub = self.gen_tree("/".join([top, excl]).strip("/"), target, dk)
            ret["k" + quotep(excl)] = sub

        vfs = self.asrv.vfs
        dk_sz = False
        if dk:
            vn, rem = vfs.get(top, self.uname, False, False)
            if vn.flags.get("dks") and self._use_dirkey(vn, vn.canonical(rem)):
                dk_sz = vn.flags.get("dk")

        dots = False
        fsroot = ""
        try:
            vn, rem = vfs.get(top, self.uname, not dk_sz, False)
            fsroot, vfs_ls, vfs_virt = vn.ls(
                rem,
                self.uname,
                not self.args.no_scandir,
                PERMS_rwh,
            )
            dots = self.uname in vn.axs.udot and "dots" in self.uparam
            dk_sz = vn.flags.get("dk")
        except:
            dk_sz = None
            vn = vfs
            vfs_ls = []
            vfs_virt = {}
            for v in self.rvol:
                d1, d2 = v.rsplit("/", 1) if "/" in v else ["", v]
                if d1 == top:
                    vfs_virt[d2] = vfs  # typechk, value never read

        dirs = [x[0] for x in vfs_ls if stat.S_ISDIR(x[1].st_mode)]

        if not dots:
            if "dothidden" in vn.flags and ".hidden" in [x[0] for x in vfs_ls]:
                dirs = exclude_dothidden(dirs, fsroot)
                self.dothid = True
            else:
                dirs = exclude_dotfiles(dirs)

        dirs = [quotep(x) for x in dirs if x != excl]

        if dk_sz and fsroot:
            kdirs = []
            fsroot_ = os.path.join(fsroot, "")
            for dn in dirs:
                ap = fsroot_ + dn
                zs = self.gen_fk(2, self.args.dk_salt, ap, 0, 0)[:dk_sz]
                kdirs.append(dn + "?k=" + zs)
            dirs = kdirs

        if vfs_virt:
            for x in vfs_virt:
                if x == excl:
                    continue
                try:
                    dvn, drem = vfs.get(vjoin(top, x), self.uname, False, False)
                    if (
                        self.uname not in dvn.axs.uread
                        and self.uname not in dvn.axs.uwrite
                        and self.uname not in dvn.axs.uhtml
                    ):
                        raise Exception()
                    bos.stat(dvn.canonical(drem, False))
                except:
                    x += "\n"
                dirs.append(quotep(x))
            if not dots:
                if "dothidden" in vn.flags and getattr(self, "dothid", False):
                    dirs = exclude_dothidden(dirs, fsroot)
                else:
                    dirs = exclude_dotfiles(dirs)

        ret["a"] = dirs
        return ret

    def get_dls(self) -> list[list[Any]]:
        ret = []
        dls = self.conn.hsrv.tdls
        enshare = self.args.shr
        shrs = enshare[1:]
        for dl_id, (t0, sz, vn, vp, uname) in self.conn.hsrv.tdli.items():
            t1, sent = dls[dl_id]
            if sent > 0x100000:  # 1m; buffers 2~4
                sent -= 0x100000
            if self.uname not in vn.axs.uread:
                vp = ""
            elif self.uname not in vn.axs.udot and (vp.startswith(".") or "/." in vp):
                vp = ""
            elif (
                enshare
                and vp.startswith(shrs)
                and self.uname != vn.shr_owner
                and self.uname not in vn.axs.uadmin
                and self.uname not in self.args.shr_adm
                and not dl_id.startswith(self.ip + ":")
            ):
                vp = ""
            if self.uname not in vn.axs.uadmin:
                dl_id = uname = ""

            ret.append([t0, t1, sent, sz, vp, dl_id, uname])
        return ret

    def tx_dls(self) -> bool:
        ret = [
            {
                "t0": x[0],
                "t1": x[1],
                "sent": x[2],
                "size": x[3],
                "path": x[4],
                "conn": x[5],
                "uname": x[6],
            }
            for x in self.get_dls()
        ]
        zs = json.dumps(ret, separators=(",\n", ": "))
        self.reply(zs.encode("utf-8", "replace"), mime="application/json")
        return True

    def tx_ups(self) -> bool:
        idx = self.conn.get_u2idx()
        if not idx or not hasattr(idx, "p_end"):
            if not HAVE_SQLITE3:
                raise Pebkac(500, "sqlite3 not found on server; unpost is disabled")
            raise Pebkac(500, "server busy, cannot unpost; please retry in a bit")

        sfilt = self.uparam.get("filter") or ""
        nfi, vfi = str_anchor(sfilt)
        lm = "ups %d%r" % (nfi, sfilt)

        if self.args.shr and self.vpath.startswith(self.args.shr1):
            shr_dbv, shr_vrem = self.vn.get_dbv(self.rem)
        else:
            shr_dbv = None

        wret: dict[str, Any] = {}
        ret: list[dict[str, Any]] = []
        t0 = time.time()
        lim = time.time() - self.args.unpost
        fk_vols = {
            vol: (vol.flags["fk"], 2 if "fka" in vol.flags else 1)
            for vp, vol in self.asrv.vfs.all_vols.items()
            if "fk" in vol.flags
            and (self.uname in vol.axs.uread or self.uname in vol.axs.upget)
        }

        if hasattr(self, "bad_xff"):
            allvols = []
            t = "will not return list of recent uploads" + BADXFF
            self.log(t, 1)
            if self.avol:
                raise Pebkac(500, t)

            x = self.conn.hsrv.broker.ask("up2k.get_unfinished_by_user", self.uname, "")
        else:
            x = self.conn.hsrv.broker.ask(
                "up2k.get_unfinished_by_user", self.uname, self.ip
            )
        zdsa: dict[str, Any] = x.get()
        uret: list[dict[str, Any]] = []
        if "timeout" in zdsa:
            wret["nou"] = 1
        else:
            uret = zdsa["f"]
        nu = len(uret)

        if not self.args.unpost:
            allvols = []
        else:
            allvols = list(self.asrv.vfs.all_vols.values())

        allvols = [
            x
            for x in allvols
            if "e2d" in x.flags
            and ("*" in x.axs.uwrite or self.uname in x.axs.uwrite or x == shr_dbv)
        ]

        q = ""
        qp = (0,)
        q_c = -1

        for vol in allvols:
            cur = idx.get_cur(vol)
            if not cur:
                continue

            nfk, fk_alg = fk_vols.get(vol) or (0, 0)

            zi = vol.flags["unp_who"]
            if q_c != zi:
                q_c = zi
                q = "select sz, rd, fn, at from up where "
                if zi == 1:
                    q += "ip=? and un=?"
                    qp = (self.ip, self.uname, lim)
                elif zi == 2:
                    q += "ip=?"
                    qp = (self.ip, lim)
                if zi == 3:
                    q += "un=?"
                    qp = (self.uname, lim)
                q += " and at>? order by at desc"

            n = 2000
            for sz, rd, fn, at in cur.execute(q, qp):
                vp = "/" + "/".join(x for x in [vol.vpath, rd, fn] if x)
                if nfi == 0 or (nfi == 1 and vfi in vp.lower()):
                    pass
                elif nfi == 2:
                    if not vp.lower().startswith(vfi):
                        continue
                elif nfi == 3:
                    if not vp.lower().endswith(vfi):
                        continue
                else:
                    continue

                n -= 1
                if not n:
                    break

                rv = {"vp": vp, "sz": sz, "at": at, "nfk": nfk}
                if nfk:
                    rv["ap"] = vol.canonical(vjoin(rd, fn))
                    rv["fk_alg"] = fk_alg

                ret.append(rv)
                if len(ret) > 3000:
                    ret.sort(key=lambda x: x["at"], reverse=True)  # type: ignore
                    ret = ret[:2000]

        ret.sort(key=lambda x: x["at"], reverse=True)  # type: ignore

        if len(ret) > 2000:
            ret = ret[:2000]
        if len(ret) >= 2000:
            wret["oc"] = 1

        for rv in ret:
            rv["vp"] = quotep(rv["vp"])
            nfk = rv.pop("nfk")
            if not nfk:
                continue

            alg = rv.pop("fk_alg")
            ap = rv.pop("ap")
            try:
                st = bos.stat(ap)
            except:
                continue

            fk = self.gen_fk(
                alg, self.args.fk_salt, ap, st.st_size, 0 if ANYWIN else st.st_ino
            )
            rv["vp"] += "?k=" + fk[:nfk]

        if not allvols:
            wret["noc"] = 1
            ret = []

        nc = len(ret)
        ret = uret + ret

        if shr_dbv:
            # translate vpaths from share-target to share-url
            # to satisfy access checks
            assert shr_vrem is not None and shr_vrem.split  # type: ignore  # !rm
            vp_shr, vp_vfs = vroots(self.vpath, vjoin(shr_dbv.vpath, shr_vrem))
            for v in ret:
                vp = v["vp"]
                if vp.startswith(vp_vfs):
                    v["vp"] = vp_shr + vp[len(vp_vfs) :]

        if self.is_vproxied:
            for v in ret:
                v["vp"] = self.args.SR + v["vp"]

        wret["f"] = ret
        wret["nu"] = nu
        wret["nc"] = nc
        jtxt = json.dumps(wret, separators=(",\n", ": "))
        self.log("%s #%d+%d %.2fsec" % (lm, nu, nc, time.time() - t0))
        self.reply(jtxt.encode("utf-8", "replace"), mime="application/json")
        return True

    def tx_rups(self) -> bool:
        if self.args.no_ups_page:
            raise Pebkac(500, "listing of recent uploads is disabled in server config")

        idx = self.conn.get_u2idx()
        if not idx or not hasattr(idx, "p_end"):
            if not HAVE_SQLITE3:
                raise Pebkac(500, "sqlite3 not found on server; recent-uploads n/a")
            raise Pebkac(500, "server busy, cannot list recent uploads; please retry")

        sfilt = self.uparam.get("filter") or ""
        nfi, vfi = str_anchor(sfilt)
        lm = "ru %d%r" % (nfi, sfilt)
        self.log(lm)

        ret: list[dict[str, Any]] = []
        t0 = time.time()
        allvols = [
            x
            for x in self.asrv.vfs.all_vols.values()
            if "e2d" in x.flags and ("*" in x.axs.uread or self.uname in x.axs.uread)
        ]
        fk_vols = {
            vol: (vol.flags["fk"], 2 if "fka" in vol.flags else 1)
            for vol in allvols
            if "fk" in vol.flags and "*" not in vol.axs.uread
        }

        for vol in allvols:
            cur = idx.get_cur(vol)
            if not cur:
                continue

            nfk, fk_alg = fk_vols.get(vol) or (0, 0)
            adm = "*" in vol.axs.uadmin or self.uname in vol.axs.uadmin
            dots = "*" in vol.axs.udot or self.uname in vol.axs.udot

            lvl = vol.flags["ups_who"]
            if not lvl:
                continue
            elif lvl == 1 and not adm:
                continue

            n = 1000
            q = "select sz, rd, fn, ip, at, un from up where at>0 order by at desc"
            for sz, rd, fn, ip, at, un in cur.execute(q):
                vp = "/" + "/".join(x for x in [vol.vpath, rd, fn] if x)
                if nfi == 0 or (nfi == 1 and vfi in vp.lower()):
                    pass
                elif nfi == 2:
                    if not vp.lower().startswith(vfi):
                        continue
                elif nfi == 3:
                    if not vp.lower().endswith(vfi):
                        continue
                else:
                    continue

                if not dots and "/." in vp:
                    continue

                rv = {
                    "vp": vp,
                    "sz": sz,
                    "ip": ip,
                    "at": at,
                    "un": un,
                    "nfk": nfk,
                    "adm": adm,
                }
                if nfk:
                    rv["ap"] = vol.canonical(vjoin(rd, fn))
                    rv["fk_alg"] = fk_alg

                ret.append(rv)
                if len(ret) > 2000:
                    ret.sort(key=lambda x: x["at"], reverse=True)  # type: ignore
                    ret = ret[:1000]

                n -= 1
                if not n:
                    break

        ret.sort(key=lambda x: x["at"], reverse=True)  # type: ignore

        if len(ret) > 1000:
            ret = ret[:1000]

        for rv in ret:
            rv["vp"] = quotep(rv["vp"])
            nfk = rv.pop("nfk")
            if not nfk:
                continue

            alg = rv.pop("fk_alg")
            ap = rv.pop("ap")
            try:
                st = bos.stat(ap)
            except:
                continue

            fk = self.gen_fk(
                alg, self.args.fk_salt, ap, st.st_size, 0 if ANYWIN else st.st_ino
            )
            rv["vp"] += "?k=" + fk[:nfk]

        if self.args.ups_when:
            for rv in ret:
                adm = rv.pop("adm")
                if not adm:
                    rv["ip"] = "(You)" if rv["ip"] == self.ip else "(?)"
                    if rv["un"] not in ("*", self.uname):
                        rv["un"] = "(?)"
        else:
            for rv in ret:
                adm = rv.pop("adm")
                if not adm:
                    rv["ip"] = "(You)" if rv["ip"] == self.ip else "(?)"
                    rv["at"] = 0
                    if rv["un"] not in ("*", self.uname):
                        rv["un"] = "(?)"

        if self.is_vproxied:
            for v in ret:
                v["vp"] = self.args.SR + v["vp"]

        now = time.time()
        self.log("%s #%d %.2fsec" % (lm, len(ret), now - t0))

        ret2 = {"now": int(now), "filter": sfilt, "ups": ret}
        jtxt = json.dumps(ret2, separators=(",\n", ": "))
        if "j" in self.ouparam:
            self.reply(jtxt.encode("utf-8", "replace"), mime="application/json")
            return True

        html = self.j2s("rups", this=self, v=json_hesc(jtxt))
        self.reply(html.encode("utf-8"), status=200)
        return True

    # KD fork: tx_idp / tx_shares removed (idp.html + shares.html templates deleted)

    # KD fork: handle_eshare / handle_share / handle_rm / handle_mv / _mv / handle_cp / _cp / handle_fs_abrt removed (read-only)

    def tx_ls_vols(self) -> bool:
        e_d = {}
        eses = ["", ""]
        rvol = self.rvol
        wvol = self.wvol
        allvols = self.asrv.vfs.all_nodes
        if self.args.have_unlistc:
            rvol = [x for x in rvol if "unlistcr" not in allvols[x].flags]
            wvol = [x for x in wvol if "unlistcw" not in allvols[x].flags]
        vols = [(x, allvols[x]) for x in list(set(rvol + wvol))]
        if self.vpath:
            zs = "%s/" % (self.vpath,)
            vols = [(x[len(zs) :], y) for x, y in vols if x.startswith(zs)]
        vols = [(x.split("/", 1)[0], y) for x, y in vols]
        vols = list(({x: y for x, y in vols if x}).items())
        if not vols and self.vpath:
            return self.tx_404(True)
        dirs = [
            {
                "lead": "",
                "href": "%s/" % (x,),
                "ext": "---",
                "sz": 0,
                "ts": 0,
                "tags": e_d,
                "dt": 0,
                "name": 0,
                "perms": vn.get_perms("", self.uname),
            }
            for x, vn in sorted(vols)
        ]
        ls = {
            "dirs": dirs,
            "files": [],
            "acct": self.uname,
            "perms": [],
            "taglist": [],
            "logues": eses,
            "readmes": eses,
            "srvinf": "" if self.args.nih else self.args.name,
        }
        return self.tx_ls(ls)

    def tx_ls(self, ls: dict[str, Any]) -> bool:
        dirs = ls["dirs"]
        files = ls["files"]
        arg = self.uparam["ls"]
        if arg in ["v", "t", "txt"]:
            try:
                biggest = max(ls["files"] + ls["dirs"], key=itemgetter("sz"))["sz"]
            except:
                biggest = 0

            if arg == "v":
                fmt = "\033[0;7;36m{{}}{{:>{}}}\033[0m {{}}"
                nfmt = "{}"
                biggest = 0
                f2 = "".join(
                    "{}{{}}".format(x)
                    for x in [
                        "\033[7m",
                        "\033[27m",
                        "",
                        "\033[0;1m",
                        "\033[0;36m",
                        "\033[0m",
                    ]
                )
                ctab = {"B": 6, "K": 5, "M": 1, "G": 3}
                for lst in [dirs, files]:
                    for x in lst:
                        a = x["dt"].replace("-", " ").replace(":", " ").split(" ")
                        x["dt"] = f2.format(*list(a))
                        sz = humansize(x["sz"], True)
                        x["sz"] = "\033[0;3{}m {:>5}".format(ctab.get(sz[-1:], 0), sz)
            else:
                fmt = "{{}}  {{:{},}}  {{}}"
                nfmt = "{:,}"

            for x in dirs:
                n = x["name"] + "/"
                if arg == "v":
                    n = "\033[94m" + n

                x["name"] = n

            fmt = fmt.format(len(nfmt.format(biggest)))
            retl = [
                ("# %s: %s" % (x, ls[x])).replace(r"</span> // <span>", " // ")
                for x in ["acct", "perms", "srvinf"]
                if x in ls
            ]
            retl += [
                fmt.format(x["dt"], x["sz"], x["name"])
                for y in [dirs, files]
                for x in y
            ]
            ret = "\n".join(retl)
            mime = "text/plain; charset=utf-8"
        else:
            [x.pop(k) for k in ["name", "dt"] for y in [dirs, files] for x in y]

            # nonce (tlnote: norwegian for flake as in snowflake)
            if self.args.no_fnugg:
                ls["fnugg"] = "nei"
            elif "fnugg" in self.headers:
                ls["fnugg"] = self.headers["fnugg"]

            ret = json.dumps(ls)
            mime = "application/json"

        ret += "\n\033[0m" if arg == "v" else "\n"
        self.reply(ret.encode("utf-8", "replace"), mime=mime)
        return True

    def tx_browser(self) -> bool:
        vpath = ""
        vpnodes = [["", "/"]]
        if self.vpath:
            for node in self.vpath.split("/"):
                if not vpath:
                    vpath = node
                else:
                    vpath += "/" + node

                vpnodes.append([quotep(vpath) + "/", html_escape(node, crlf=True)])

        vn = self.vn
        rem = self.rem
        abspath = vn.dcanonical(rem)
        dbv, vrem = vn.get_dbv(rem)

        try:
            st = bos.stat(abspath)
        except:
            if "on404" not in vn.flags:
                return self.tx_404(not self.can_read)

            ret = self.on40x(vn.flags["on404"], vn, rem)
            if ret == "true":
                return True
            elif ret == "false":
                return False
            elif ret == "retry":
                try:
                    st = bos.stat(abspath)
                except:
                    return self.tx_404(not self.can_read)
            else:
                return self.tx_404(not self.can_read)

        if rem.startswith(".hist/up2k.") or (
            rem.endswith("/dir.txt") and rem.startswith(".hist/th/")
        ):
            raise Pebkac(403)

        e2d = "e2d" in vn.flags
        e2t = "e2t" in vn.flags

        add_og = "og" in vn.flags
        if add_og:
            if "th" in self.uparam or "raw" in self.uparam or "opds" in self.uparam:
                add_og = False
            elif vn.flags["og_ua"]:
                add_og = vn.flags["og_ua"].search(self.ua)
            og_fn = ""

        if "v" in self.uparam:
            add_og = True
            og_fn = ""

        if "b" in self.uparam and "norobots" not in vn.flags:
            self.out_headers["X-Robots-Tag"] = "noindex, nofollow"

        is_dir = stat.S_ISDIR(st.st_mode)
        is_dk = False
        fk_pass = False
        icur = None
        if (e2t or e2d) and (is_dir or add_og):
            idx = self.conn.get_u2idx()
            if idx and hasattr(idx, "p_end"):
                icur = idx.get_cur(dbv)

        if "k" in self.uparam or "dky" in vn.flags:
            if is_dir:
                use_dirkey = self._use_dirkey(vn, abspath)
                use_filekey = False
            else:
                use_filekey = self._use_filekey(vn, abspath, st)
                use_dirkey = False
        else:
            use_dirkey = use_filekey = False

        th_fmt = self.uparam.get("th")
        if self.can_read or (
            self.can_get
            and (use_filekey or use_dirkey or (not is_dir and "fk" not in vn.flags))
        ):
            if th_fmt is not None:
                nothumb = "dthumb" in dbv.flags
                if is_dir:
                    vrem = vrem.rstrip("/")
                    if nothumb:
                        pass
                    elif icur and vrem:
                        q = "select fn from cv where rd=? and dn=?"
                        crd, cdn = vrem.rsplit("/", 1) if "/" in vrem else ("", vrem)
                        # no mojibake support:
                        try:
                            cfn = icur.execute(q, (crd, cdn)).fetchone()
                            if cfn:
                                fn = cfn[0]
                                fp = os.path.join(abspath, fn)
                                st = bos.stat(fp)
                                vrem = "{}/{}".format(vrem, fn).strip("/")
                                is_dir = False
                        except:
                            pass
                    else:
                        for fn in self.args.th_covers:
                            fp = os.path.join(abspath, fn)
                            try:
                                st = bos.stat(fp)
                                vrem = "{}/{}".format(vrem, fn).strip("/")
                                is_dir = False
                                break
                            except:
                                pass

                    if is_dir:
                        return self.tx_svg("folder")

                thp = None
                if self.thumbcli and not nothumb:
                    try:
                        # cache_only=True: kopyparty fork forbids on-demand
                        # thumbnail generation. The cache is populated
                        # exclusively by the --th-pregen background worker
                        # at startup; frontend requests serve cached thumbs
                        # or fall back to the SVG icon below.
                        thp = self.thumbcli.get(dbv, vrem, int(st.st_mtime), th_fmt, cache_only=True)
                    except Pebkac as ex:
                        if ex.code == 500 and th_fmt[:1] in "jw":
                            self.log("failed to convert [%s]:\n%s" % (abspath, ex), 3)
                            return self.tx_svg("--error--\ncheck\nserver\nlog")
                        raise

                if thp:
                    return self.tx_file("oh_f", thp)

                if th_fmt == "p":
                    raise Pebkac(404)
                elif th_fmt in ACODE2_FMT:
                    raise Pebkac(415)

                return self.tx_ico(rem)

        elif self.can_write and th_fmt is not None:
            return self.tx_svg("upload\nonly")

        if not self.can_read and self.can_get and self.avn:
            if not self.can_html:
                pass
            elif is_dir:
                for fn in ("index.htm", "index.html"):
                    ap2 = os.path.join(abspath, fn)
                    try:
                        st2 = bos.stat(ap2)
                    except:
                        continue

                    # might as well be extra careful
                    if not stat.S_ISREG(st2.st_mode):
                        continue

                    if not self.trailing_slash:
                        return self.redirect(
                            self.vpath + "/", flavor="redirecting to", use302=True
                        )

                    fk_pass = True
                    is_dir = False
                    add_og = False
                    rem = vjoin(rem, fn)
                    vrem = vjoin(vrem, fn)
                    abspath = ap2
                    break
            elif self.vpath.rsplit("/", 1)[-1] in IDX_HTML:
                fk_pass = True

        if not is_dir and (self.can_read or self.can_get):
            if (
                not self.can_read
                and not fk_pass
                and "fk" in vn.flags
                and not use_filekey
                and not self.vpath.startswith(self.args.shr1 or "\n")
            ):
                return self.tx_404(True)

            is_md = abspath.lower().endswith(".md")
            if add_og and not is_md:
                if self.host not in self.headers.get("referer", ""):
                    self.vpath, og_fn = vsplit(self.vpath)
                    vpath = self.vpath
                    vn, rem = self.asrv.vfs.get(self.vpath, self.uname, False, False)
                    abspath = vn.dcanonical(rem)
                    dbv, vrem = vn.get_dbv(rem)
                    is_dir = stat.S_ISDIR(st.st_mode)
                    is_dk = True
                    vpnodes.pop()

            if (
                (
                    (is_md and "v" in self.uparam)
                    or "edit" in self.uparam
                    or "edit2" in self.uparam
                )
                and "nohtml" not in vn.flags
                and (
                    is_md
                    or self.can_delete
                    or (
                        "." in abspath
                        and abspath.rsplit(".", 1)[1].lower() in vn.flags["rw_edit_set"]
                    )
                )
            ):
                return self.tx_md(vn, abspath)

            if "zls" in self.uparam:
                return self.tx_zls(abspath)
            if "zget" in self.uparam:
                return self.tx_zget(abspath)

            if not add_og or not og_fn:
                if st.st_size or "nopipe" in vn.flags:
                    return self.tx_file("oh_f", abspath, None)
                else:
                    return self.tx_file("oh_f", abspath, vn.get_dbv("")[0].realpath)

        elif is_dir and not self.can_read:
            if use_dirkey:
                is_dk = True
            elif self.can_get and "doc" in self.uparam:
                zs = vjoin(self.vpath, self.uparam["doc"]) + "?v"
                return self.redirect(zs, flavor="redirecting to", use302=True)
            elif not self.can_write:
                return self.tx_404(True)

        srv_info = []

        try:
            if not self.args.nih:
                srv_info.append(self.args.name_html)
        except:
            self.log("#wow #whoa")

        zi = vn.flags["du_iwho"]
        if zi and (
            zi == 9
            or (zi == 7 and self.uname != "*")
            or (zi == 5 and self.can_write)
            or (zi == 4 and self.can_write and self.can_read)
            or (zi == 3 and self.can_admin)
        ):
            free, total, zs = get_df(abspath, False)
            if total:
                if "vmaxb" in vn.flags:
                    assert vn.lim  # type: ignore  # !rm
                    total = vn.lim.vbmax
                    if free == vn.lim.c_vb_r:
                        free = min(free, max(0, vn.lim.vbmax - vn.lim.c_vb_v))
                    else:
                        try:
                            zi, _ = self.conn.hsrv.broker.ask(
                                "up2k.get_volsizes", [vn.realpath]
                            ).get()[0]
                            vn.lim.c_vb_v = zi
                            vn.lim.c_vb_r = free
                            free = min(free, max(0, vn.lim.vbmax - zi))
                        except:
                            pass
                h1 = humansize(free or 0)
                h2 = humansize(total)
                srv_info.append("{} free of {}".format(h1, h2))
            elif zs:
                self.log("diskfree(%r): %s" % (abspath, zs), 3)

        srv_infot = "</span> // <span>".join(srv_info)

        perms = []
        if self.can_read or is_dk:
            perms.append("read")
        if self.can_write:
            perms.append("write")
        if self.can_move:
            perms.append("move")
        if self.can_delete:
            perms.append("delete")
        if self.can_dot:
            perms.append("dot")
        if self.can_get:
            perms.append("get")
        if self.can_upget:
            perms.append("upget")
        if self.can_admin:
            perms.append("admin")

        url_suf = self.urlq({}, ["k"])
        is_ls = "ls" in self.uparam
        # KD fork: OPDS catalog feature removed (opds.xml templates deleted)
        is_opds = False
        is_js = self.args.force_js or self.cookies.get("js") == "y"

        if not is_ls and not add_og and self.ua.startswith(("curl/", "fetch")):
            self.uparam["ls"] = "v"
            is_ls = True

        tpl = "browser"
        if "b" in self.uparam:
            tpl = "browser2"
            is_js = False

        vf = vn.flags
        ls_ret = {
            "dirs": [],
            "files": [],
            "taglist": [],
            "srvinf": srv_infot,
            "acct": self.uname,
            "perms": perms,
            "cfg": vn.js_ls,
        }
        cgv = {
            "ls0": None,
            "acct": self.uname,
            "perms": perms,
        }
        # also see `js_htm` in authsrv.py
        j2a = {
            "cgv1": vn.js_htm,
            "cgv": cgv,
            "vpnodes": vpnodes,
            "files": [],
            "ls0": None,
            "taglist": [],
            "have_tags_idx": int(e2t),
            "have_b_u": (self.can_write and self.uparam.get("b") == "u"),
            "sb_lg": vn.js_ls["sb_lg"],
            "url_suf": url_suf,
            "title": html_escape("%s %s" % (self.args.bname, self.vpath), crlf=True),
            "srv_info": srv_infot,
            "dtheme": self.args.theme,
            "this": self,
        }

        if self.args.js_browser:
            zs = self.args.js_browser
            zs += "&" if "?" in zs else "?"
            j2a["js"] = zs

        if self.args.css_browser:
            zs = self.args.css_browser
            zs += "&" if "?" in zs else "?"
            j2a["css"] = zs

        if not self.conn.hsrv.prism:
            j2a["no_prism"] = True

        if not self.can_read and not is_dk:
            logues, readmes = self._add_logues(vn, abspath, None)
            ls_ret["logues"] = j2a["logues"] = logues
            ls_ret["readmes"] = cgv["readmes"] = readmes

            if is_ls:
                return self.tx_ls(ls_ret)

            if not stat.S_ISDIR(st.st_mode):
                return self.tx_404(True)

            if "zip" in self.uparam or "tar" in self.uparam:
                raise Pebkac(403)

            zsl = j2a["files"] = []
            if is_js:
                j2a["ls0"] = cgv["ls0"] = {
                    "dirs": zsl,
                    "files": zsl,
                    "taglist": zsl,
                }

            html = self.j2s(tpl, **j2a)
            self.reply(html.encode("utf-8", "replace"))
            return True

        for k in ["zip", "tar"]:
            v = self.uparam.get(k)
            if v is not None and (not add_og or not og_fn):
                if is_dk and "dks" not in vn.flags:
                    t = "server config does not allow download-as-zip/tar; only dk is specified, need dks too"
                    raise Pebkac(403, t)
                return self.tx_zip(k, v, self.vpath, vn, rem, [])

        fsroot, vfs_ls, vfs_virt = vn.ls(
            rem,
            self.uname,
            not self.args.no_scandir,
            PERMS_rwh,
            lstat="lt" in self.uparam,
            throw=True,
        )
        stats = {k: v for k, v in vfs_ls}
        ls_names = [x[0] for x in vfs_ls]
        ls_names.extend(list(vfs_virt))

        if add_og and og_fn and not self.can_read:
            ls_names = [og_fn]
            is_js = True

        # check for old versions of files,
        # [num-backups, most-recent, hist-path]
        hist: dict[str, tuple[int, float, str]] = {}
        try:
            if vf["md_hist"] != "s":
                raise Exception()
            histdir = os.path.join(fsroot, ".hist")
            ptn = RE_MDV
            for hfn in bos.listdir(histdir):
                m = ptn.match(hfn)
                if not m:
                    continue

                fn = m.group(1) + m.group(3)
                n, ts, _ = hist.get(fn, (0, 0, ""))
                hist[fn] = (n + 1, max(ts, float(m.group(2))), hfn)
        except:
            pass

        lnames = {x.lower(): x for x in ls_names}

        # show dotfiles if permitted and requested
        if not self.can_dot or (
            "dots" not in self.uparam and (is_ls or "dots" not in self.cookies)
        ):
            if "dothidden" in vf and ".hidden" in ls_names:
                ls_names = exclude_dothidden(ls_names, fsroot)
            else:
                ls_names = exclude_dotfiles(ls_names)

        add_dk = vf.get("dk")
        add_fk = vf.get("fk")
        fk_alg = 2 if "fka" in vf else 1
        if add_dk:
            if vf.get("dky"):
                add_dk = False
            else:
                zs = self.gen_fk(2, self.args.dk_salt, abspath, 0, 0)[:add_dk]
                ls_ret["dk"] = cgv["dk"] = zs

        no_zip = bool(self._can_zip(vf))

        dirs = []
        files = []
        ptn_hr = RE_HR
        use_abs_url = (
            not is_opds
            and not is_ls
            and not is_js
            and not self.trailing_slash
            and vpath
        )
        for fn in ls_names:
            base = ""
            href = fn
            if use_abs_url:
                base = "/" + vpath + "/"
                href = base + fn

            if fn in vfs_virt:
                fspath = vfs_virt[fn].realpath
            else:
                fspath = fsroot + "/" + fn

            try:
                linf = stats.get(fn) or bos.lstat(fspath)
                inf = bos.stat(fspath) if stat.S_ISLNK(linf.st_mode) else linf
            except:
                self.log("broken symlink: %r" % (fspath,))
                continue

            is_dir = stat.S_ISDIR(inf.st_mode)
            if is_dir:
                href += "/"
                if no_zip:
                    margin = "DIR"
                elif add_dk:
                    zs = absreal(fspath)
                    margin = '<a href="%s?k=%s&zip=crc" rel="nofollow">zip</a>' % (
                        quotep(href),
                        self.gen_fk(2, self.args.dk_salt, zs, 0, 0)[:add_dk],
                    )
                else:
                    margin = '<a href="%s?zip=crc" rel="nofollow">zip</a>' % (
                        quotep(href),
                    )
            elif fn in hist:
                margin = '<a href="%s.hist/%s" rel="nofollow">#%s</a>' % (
                    base,
                    html_escape(hist[fn][2], quot=True, crlf=True),
                    hist[fn][0],
                )
            else:
                margin = "-"

            sz = inf.st_size
            zd = datetime.fromtimestamp(max(0, linf.st_mtime), UTC)
            dt = "%04d-%02d-%02d %02d:%02d:%02d" % (
                zd.year,
                zd.month,
                zd.day,
                zd.hour,
                zd.minute,
                zd.second,
            )

            if is_dir:
                ext = "---"
            elif "." in fn:
                ext = ptn_hr.sub("@", fn.rsplit(".", 1)[1])
                if len(ext) > 16:
                    ext = ext[:16]
            else:
                ext = "%"

            if add_fk and not is_dir:
                href = "%s?k=%s" % (
                    quotep(href),
                    self.gen_fk(
                        fk_alg,
                        self.args.fk_salt,
                        fspath,
                        sz,
                        0 if ANYWIN else inf.st_ino,
                    )[:add_fk],
                )
            elif add_dk and is_dir:
                href = "%s?k=%s" % (
                    quotep(href),
                    self.gen_fk(2, self.args.dk_salt, fspath, 0, 0)[:add_dk],
                )
            else:
                href = quotep(href)

            item = {
                "lead": margin,
                "href": href,
                "name": fn,
                "sz": sz,
                "ext": ext,
                "dt": dt,
                "ts": int(linf.st_mtime),
            }
            if is_dir:
                dirs.append(item)
            else:
                files.append(item)

        if is_dk and not vf.get("dks"):
            dirs = []

        if (
            self.cookies.get("idxh") == "y"
            and "ls" not in self.uparam
            and "v" not in self.uparam
            and not is_opds
        ):
            for item in files:
                if item["name"] in IDX_HTML:
                    # do full resolve in case of shadowed file
                    vp = vjoin(self.vpath.split("?")[0], item["name"])
                    vn, rem = self.asrv.vfs.get(vp, self.uname, True, False)
                    ap = vn.canonical(rem)
                    if not self.trailing_slash and bos.path.isfile(ap):
                        return self.redirect(
                            self.vpath + "/", flavor="redirecting to", use302=True
                        )
                    return self.tx_file("oh_f", ap)  # is no-cache

        if icur:
            mte = vn.flags.get("mte") or {}
            tagset: set[str] = set()
            rd = vrem
            if self.can_admin:
                up_q = "select substr(w,1,16), ip, at, un from up where rd=? and fn=?"
                up_m = ["w", "up_ip", ".up_at", "up_by"]
            else:
                up_q, up_m = vn.flags["ls_q_m"]

            mt_q = "select mt.k, mt.v from up inner join mt on mt.w = substr(up.w,1,16) where up.rd = ? and up.fn = ? and +mt.k != 'x'"
            for fe in files:
                fn = fe["name"]
                erd_efn = (rd, fn)
                try:
                    r = icur.execute(mt_q, erd_efn)
                except Exception as ex:
                    if "database is locked" in str(ex):
                        break

                    try:
                        erd_efn = s3enc(idx.mem_cur, rd, fn)
                        r = icur.execute(mt_q, erd_efn)
                    except:
                        self.log("tag read error, %r / %r\n%s" % (rd, fn, min_ex()))
                        break

                tags = {k: v for k, v in r}

                if up_q:
                    try:
                        up_v = icur.execute(up_q, erd_efn).fetchone()
                        for zs1, zs2 in zip(up_m, up_v):
                            if zs2:
                                tags[zs1] = zs2
                    except:
                        pass

                _ = [tagset.add(k) for k in tags]
                fe["tags"] = tags

            for fe in dirs:
                fe["tags"] = ODict()

            lmte = list(mte)
            if self.can_admin:
                lmte.extend(("w", "up_by", "up_ip", ".up_at"))

            if "nodirsz" not in vf:
                tagset.add(".files")
                vdir = "%s/" % (rd,) if rd else ""
                q = "select sz, nf from ds where rd=? limit 1"
                for fe in dirs:
                    try:
                        hit = icur.execute(q, (vdir + fe["name"],)).fetchone()
                        (fe["sz"], fe["tags"][".files"]) = hit
                    except:
                        pass  # 404 or mojibake

            taglist = [k for k in lmte if k in tagset]
        else:
            taglist = []

        logues, readmes = self._add_logues(vn, abspath, lnames)
        ls_ret["logues"] = j2a["logues"] = logues
        ls_ret["readmes"] = cgv["readmes"] = readmes

        if (
            not files
            and not dirs
            and not readmes[0]
            and not readmes[1]
            and not logues[0]
            and not logues[1]
        ):
            logues[1] = "this folder is empty"

        if "descript.ion" in lnames and os.path.isfile(
            os.path.join(abspath, lnames["descript.ion"])
        ):
            rem = []
            items = {x["name"].lower(): x for x in files + dirs}
            with open(os.path.join(abspath, lnames["descript.ion"]), "rb") as f:
                for bln in [x.strip() for x in f]:
                    try:
                        if bln.endswith(b"\x04\xc2"):
                            # multiline comment; replace literal r"\n" with " // "
                            bln = bln.replace(br"\\n", b" // ")[:-2]
                        ln = bln.decode("utf-8", "replace")
                        if ln.startswith('"'):
                            fn, desc = ln.split('" ', 1)
                            fn = fn[1:]
                        else:
                            fn, desc = ln.split(" ", 1)
                        try:
                            item = items[fn.lower().strip("/")]
                        except:
                            t = "<li><code>%s</code> %s</li>"
                            rem.append(t % (html_escape(fn), html_escape(desc)))
                            continue
                        try:
                            item["tags"]["descript.ion"] = desc
                        except:
                            item["tags"] = {"descript.ion": desc}
                    except:
                        pass
            if "descript.ion" not in taglist:
                taglist.insert(0, "descript.ion")
            if rem and not logues[1]:
                t = "<h3>descript.ion</h3><ul>\n"
                logues[1] = t + "\n".join(rem) + "</ul>"

        if is_ls:
            ls_ret["dirs"] = dirs
            ls_ret["files"] = files
            ls_ret["taglist"] = taglist
            return self.tx_ls(ls_ret)

        doc = self.uparam.get("doc") if self.can_read else None
        if doc:
            zp = self.args.ua_nodoc
            if zp and zp.search(self.ua):
                t = "this URL contains no valuable information for bots/crawlers"
                raise Pebkac(403, t)
            j2a["docname"] = doc
            doctxt = None
            dfn = lnames.get(doc.lower())
            if dfn and dfn != doc:
                # found Foo but want FOO
                dfn = next((x for x in files if x["name"] == doc), None)
            if dfn:
                docpath = os.path.join(abspath, doc)
                sz = bos.path.getsize(docpath)
                if sz < 1024 * self.args.txt_max:
                    doctxt = read_utf8(self.log, fsenc(docpath), False)
                    if doc.lower().endswith(".md") and "exp" in vn.flags:
                        doctxt = self._expand(doctxt, vn.flags.get("exp_md") or [])
                else:
                    self.log("doc 2big: %r" % (doc,), 6)
                    doctxt = "( size of textfile exceeds serverside limit )"
                    # NOTE: browser.js expects this exact message
            else:
                self.log("doc 404: %r" % (doc,), 6)
                doctxt = "( textfile not found )"

            if doctxt is not None:
                j2a["doc"] = doctxt

        for d in dirs:
            d["name"] += "/"

        dirs.sort(key=itemgetter("name"))

        if is_opds:
            # OpenSearch Description format requires a full-qualified URL and a "Short Name" under 16 characters
            # which will be the longname truncated in the template.
            # Relevant specs:
            # https://specs.opds.io/opds-1.2#3-search
            # https://developer.mozilla.org/en-US/docs/Web/XML/Guides/OpenSearch
            if "osd" in self.uparam:
                j2a["longname"] = "%s %s" % (self.args.bname, self.vpath)
                j2a["search_url"] = self.args.SRS + vpath

                xml = self.j2s("opds_osd", **j2a)
                self.reply(
                    xml.encode("utf-8"), mime="application/opensearchdescription+xml"
                )
                return True

            if "q" in self.uparam:
                q = self.uparam["q"]
                idx = self.conn.get_u2idx()
                if not idx:
                    raise Pebkac(500, "indexer not available")

                # generate a raw query similar to web interface for multiple words
                r = " and ".join(("name like *%s*" % (x,)) for x in q.split())

                hits, _, _ = idx.search(self.uname, [self.vn], r, 1000)

                files = []
                dirs = []

                prefix = quotep(vpath + "/" if vpath else "")

                for h in hits:
                    rp = h["rp"]
                    if not rp.startswith(prefix):
                        continue

                    zd = datetime.fromtimestamp(h["ts"], UTC)
                    dt = "%04d-%02d-%02d %02d:%02d:%02d" % (
                        zd.year,
                        zd.month,
                        zd.day,
                        zd.hour,
                        zd.minute,
                        zd.second,
                    )

                    item = {
                        "href": self.args.SRS + rp,
                        "name": unquotep(rp[len(prefix) :].split("?")[0]),
                        "sz": h["sz"],
                        "dt": dt,
                        "ts": h["ts"],
                    }
                    files.append(item)

            # exclude files which don't match --opds-exts
            allowed_exts = vf.get("opds_exts") or self.args.opds_exts
            if allowed_exts:
                files = [
                    x for x in files if x["name"].rsplit(".", 1)[-1] in allowed_exts
                ]

            j2a["opds_osd"] = "%s%s?opds&osd" % (self.args.SRS, quotep(vpath))

            for item in dirs:
                href = item["href"]
                href += ("&" if "?" in href else "?") + "opds"
                item["href"] = href
                item["iso8601"] = "%sZ" % (item["dt"].replace(" ", "T"),)

            for item in files:
                href = item["href"]
                href += ("&" if "?" in href else "?") + "dl"
                item["href"] = href
                item["iso8601"] = "%sZ" % (item["dt"].replace(" ", "T"),)

                if "rmagic" in self.vn.flags:
                    ap = "%s/%s" % (fsroot, item["name"])
                    item["mime"] = guess_mime(item["name"], ap)
                else:
                    item["mime"] = guess_mime(item["name"])

                # Make sure we can actually generate JPEG thumbnails
                if (
                    not self.args.th_no_jpg
                    and self.thumbcli
                    and "dthumb" not in dbv.flags
                    and "dithumb" not in dbv.flags
                ):
                    item["jpeg_thumb_href"] = href + "&th=jf"
                    item["jpeg_thumb_href_hires"] = item["jpeg_thumb_href"] + "3"

            j2a["files"] = files
            j2a["dirs"] = dirs
            html = self.j2s("opds", **j2a)
            mime = "application/atom+xml;profile=opds-catalog"
            self.reply(html.encode("utf-8", "replace"), mime=mime)
            return True

        if is_js:
            j2a["ls0"] = cgv["ls0"] = {
                "dirs": dirs,
                "files": files,
                "taglist": taglist,
            }
            j2a["files"] = []
        else:
            j2a["files"] = dirs + files

        j2a["taglist"] = taglist

        if add_og and "raw" not in self.uparam:
            j2a["this"] = self
            cgv["og_fn"] = og_fn
            if og_fn and vn.flags.get("og_tpl"):
                tpl = vn.flags["og_tpl"]
                if "EXT" in tpl:
                    zs = og_fn.split(".")[-1].lower()
                    tpl2 = tpl.replace("EXT", zs)
                    if os.path.exists(tpl2):
                        tpl = tpl2
                with self.conn.hsrv.mutex:
                    if tpl not in self.conn.hsrv.j2:
                        tdir, tname = os.path.split(tpl)
                        j2env = jinja2.Environment()
                        j2env.loader = jinja2.FileSystemLoader(tdir)
                        self.conn.hsrv.j2[tpl] = j2env.get_template(tname)
            thumb = ""
            is_pic = is_vid = is_au = False
            for fn in self.args.th_coversd:
                if fn in lnames:
                    thumb = lnames[fn]
                    break
            if og_fn:
                ext = og_fn.split(".")[-1].lower()
                if self.thumbcli and ext in self.thumbcli.thumbable:
                    is_pic = (
                        ext in self.thumbcli.fmt_pil
                        or ext in self.thumbcli.fmt_vips
                        or ext in self.thumbcli.fmt_ffi
                    )
                    is_vid = ext in self.thumbcli.fmt_ffv
                    is_au = ext in self.thumbcli.fmt_ffa
                    if not thumb or not is_au:
                        thumb = og_fn
                file = next((x for x in files if x["name"] == og_fn), None)
            else:
                file = None

            url_base = "%s://%s/%s" % (
                "https" if self.is_https else "http",
                self.host,
                self.args.RS + quotep(vpath),
            )
            j2a["og_is_pic"] = is_pic
            j2a["og_is_vid"] = is_vid
            j2a["og_is_au"] = is_au
            if thumb:
                fmt = vn.flags.get("og_th", "j")
                th_base = ujoin(url_base, quotep(thumb))
                query = "th=%s&cache" % (fmt,)
                if use_filekey:
                    query += "&k=" + self.uparam["k"]
                query = ub64enc(query.encode("utf-8")).decode("ascii")
                # discord looks at file extension, not content-type...
                query += "/th.jpg" if "j" in fmt else "/th.webp"
                j2a["og_thumb"] = "%s/.uqe/%s" % (th_base, query)

            j2a["og_fn"] = og_fn
            j2a["og_file"] = file
            if og_fn:
                og_fn_q = quotep(og_fn)
                query = "raw"
                if use_filekey:
                    query += "&k=" + self.uparam["k"]
                query = ub64enc(query.encode("utf-8")).decode("ascii")
                query += "/%s" % (og_fn_q,)
                j2a["og_url"] = ujoin(url_base, og_fn_q)
                j2a["og_raw"] = j2a["og_url"] + "/.uqe/" + query
            else:
                j2a["og_url"] = j2a["og_raw"] = url_base

            if not vn.flags.get("og_no_head"):
                ogh = {"twitter:card": "summary"}

                title = str(vn.flags.get("og_title") or "")

                if thumb:
                    ogh["og:image"] = j2a["og_thumb"]

                zso = vn.flags.get("og_desc") or ""
                if zso != "-":
                    ogh["og:description"] = str(zso)

                zs = vn.flags.get("og_site") or self.args.name
                if zs not in ("", "-"):
                    ogh["og:site_name"] = zs

                try:
                    assert file is not None  # type: ignore  # !rm
                    zs1, zs2 = file["tags"]["res"].split("x")
                    file["tags"][".resw"] = zs1
                    file["tags"][".resh"] = zs2
                except:
                    pass

                tagmap = {}

                if is_au:
                    title = str(vn.flags.get("og_title_a") or "")
                    ogh["og:type"] = "music.song"
                    ogh["og:audio"] = j2a["og_raw"]
                    tagmap = {
                        "artist": "og:music:musician",
                        "album": "og:music:album",
                        ".dur": "og:music:duration",
                    }
                elif is_vid:
                    title = str(vn.flags.get("og_title_v") or "")
                    ogh["og:type"] = "video.other"
                    ogh["og:video"] = j2a["og_raw"]

                    tagmap = {
                        "title": "og:title",
                        ".dur": "og:video:duration",
                        ".resw": "og:video:width",
                        ".resh": "og:video:height",
                    }
                elif is_pic:
                    title = str(vn.flags.get("og_title_i") or "")
                    ogh["twitter:card"] = "summary_large_image"
                    ogh["twitter:image"] = ogh["og:image"] = j2a["og_raw"]

                    tagmap = {
                        ".resw": "og:image:width",
                        ".resh": "og:image:height",
                    }

                try:
                    assert file is not None  # type: ignore  # !rm
                    for k, v in file["tags"].items():
                        zs = "{{ %s }}" % (k,)
                        title = title.replace(zs, str(v))
                except:
                    pass
                title = re.sub(r"\{\{ [^}]+ \}\}", "", title)
                while title.startswith(" - "):
                    title = title[3:]
                while title.endswith(" - "):
                    title = title[:3]

                if vn.flags.get("og_s_title") or not title:
                    title = str(vn.flags.get("og_title") or "")

                for tag, hname in tagmap.items():
                    try:
                        assert file is not None  # type: ignore  # !rm
                        v = file["tags"][tag]
                        if not v:
                            continue
                        ogh[hname] = int(v) if tag == ".dur" else v
                    except:
                        pass

                ogh["og:title"] = title

                oghs = [
                    '\t<meta property="%s" content="%s">'
                    % (k, html_escape(str(v), True, True))
                    for k, v in ogh.items()
                ]
                zs = self.html_head + "\n%s\n" % ("\n".join(oghs),)
                self.html_head = zs.replace("\n\n", "\n")

        html = self.j2s(tpl, **j2a)
        self.reply(html.encode("utf-8", "replace"))
        return True

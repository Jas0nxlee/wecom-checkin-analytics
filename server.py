#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
打卡分析看板本地服务（零第三方依赖）

  python3 server.py                 # 打开 http://127.0.0.1:8787
  python3 server.py --port 9000

路由：
  /                       静态看板（web/）
  /api/dataset            看板数据（可带 ?start=&end=&dept= 过滤，gzip 传输）
  /api/meta               数据源元信息（区间、条数、是否演示数据、抓取状态）
  /api/fetch              POST 触发企业微信接口抓取（后台线程 + 轮询进度）
  /api/fetch_status       抓取进度
  /api/export             导出 CSV（records / daily）
"""
import argparse
import gzip
import io
import json
import mimetypes
import os
import sys
import threading
import time
import urllib.parse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
DATA = os.path.join(ROOT, "data")
DATASET = os.path.join(DATA, "checkin_data.json")
STATUS = os.path.join(DATA, "fetch_status.json")
sys.path.insert(0, ROOT)
import fetch_checkin as fc  # noqa: E402
from checkin_policy import apply_attendance_scope

_CACHE = {"path": None, "mtime": 0, "data": None}
_FETCH_LOCK = threading.Lock()

# 前端不需要的大字段，出接口时剔除以减小体积
DROP_REC_FIELDS = {"dept_names", "wifimac", "media_count"}


def load_dataset():
    """按 mtime 缓存整个数据集，避免每次请求重新解析。"""
    try:
        mtime = os.path.getmtime(DATASET)
    except OSError:
        return None
    if _CACHE["path"] == DATASET and _CACHE["mtime"] == mtime and _CACHE["data"] is not None:
        return _CACHE["data"]
    try:
        with open(DATASET, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        if _CACHE["data"] is not None:
            return _CACHE["data"]
        return None
    data["records_slim"] = [{k: v for k, v in r.items() if k not in DROP_REC_FIELDS}
                            for r in data.get("records", [])]
    _CACHE.update(path=DATASET, mtime=mtime, data=data)
    return data


def filter_dataset(data, qs):
    data = apply_attendance_scope(data)
    start, end, dept = qs.get("start"), qs.get("end"), qs.get("dept")
    recs = data["records_slim"]
    if start:
        recs = [r for r in recs if (r.get("attendance_date") or r["date"]) >= start]
    if end:
        recs = [r for r in recs if (r.get("attendance_date") or r["date"]) <= end]
    if dept and dept != "全部":
        recs = [r for r in recs if r.get("dept") == dept]
    daily = data.get("daily", [])
    if start:
        daily = [d for d in daily if d["date"] >= start]
    if end:
        daily = [d for d in daily if d["date"] <= end]
    if dept and dept != "全部":
        daily = [d for d in daily if d.get("dept") == dept]
    users = data.get("users", [])
    if dept and dept != "全部":
        users = [u for u in users if dept in (u.get("dept_names") or []) or u.get("main_dept") == dept]
    group, scope = qs.get("group"), qs.get("scope", "all")
    if group and group != "全部":
        recs = [r for r in recs if (r.get("groupname") or "未分组") == group]
        daily = [d for d in daily if (d.get("groupname") or "未分组") == group]
    if scope in ("office", "outside"):
        recs = [r for r in recs if (r.get("type") == "外出打卡") == (scope == "outside")]
    ids = {u["userid"] for u in users}
    def in_date(row):
        return (not start or row.get("date", "") >= start) and (not end or row.get("date", "") <= end)
    monthly = [m for m in data.get("monthly", []) if (m.get("base_info") or {}).get("acctid") in ids
               and (not start or m.get("query_start", "") >= start) and (not end or m.get("query_end", "9999") <= end)]
    return {"meta": data.get("meta", {}), "users": users, "records": recs,
            "daily": daily, "monthly": monthly,
            "rules": [r for r in data.get("rules", []) if r.get("userid") in ids and in_date(r)],
            "approvals": [a for a in data.get("approvals", []) if a.get("userid") in ids and in_date(a)],
            "filtered": bool(start or end or (dept and dept != "全部"))}


def fetch_status():
    try:
        with open(STATUS, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"running": False, "step": "尚未执行过抓取", "done": 0, "total": 0, "errors": []}


def run_fetch(params):
    """后台线程执行 fetch_checkin.main()。"""
    try:
        params = validate_fetch_params(params)
        argv = ["--status-file", STATUS, "--refresh-month"]
        if params.get("start"):
            argv += ["--start", params["start"], "--end", params.get("end") or params["start"]]
        else:
            argv += ["--days", str(params.get("days", 30))]
        for key in ("users", "depts"):
            if params.get(key):
                argv += ["--" + key, params[key]]
        for key, flag in (("noDaily", "--no-daily"), ("noMonthly", "--no-monthly")):
            if params.get(key):
                argv.append(flag)
        fc.main(argv)
        _CACHE["mtime"] = 0
    except SystemExit as e:
        st = fetch_status()
        st.update(running=False, step="参数有误", message=str(e.code))
        fc.atomic_json(STATUS, st)
    except Exception as e:                                    # noqa: BLE001
        st = fetch_status()
        st.update(running=False, step="抓取失败", message=fc.explain("%s: %s" % (type(e).__name__, e)))
        st["errors"] = (st.get("errors") or []) + [str(e)[:400]]
        fc.atomic_json(STATUS, st)
    finally:
        _FETCH_LOCK.release()


def validate_fetch_params(params):
    if not isinstance(params, dict):
        raise ValueError("请求体必须为JSON对象")
    result = dict(params)
    for key in ("start", "end", "users", "depts"):
        if result.get(key) is not None and (not isinstance(result[key], str) or len(result[key]) > 20000):
            raise ValueError("%s格式无效" % key)
    if result.get("start"):
        result["end"] = result.get("end") or result["start"]
        start, end = (datetime.strptime(result[k], "%Y-%m-%d") for k in ("start", "end"))
        if not 0 <= (end - start).days < 92:
            raise ValueError("日期顺序无效或超过92天")
    else:
        if result.get("end"):
            raise ValueError("必须同时指定开始日期")
        if isinstance(result.get("days"), bool):
            raise ValueError("days必须为整数")
        result["days"] = int(result.get("days") or 30)
        if not 1 <= result["days"] <= 92:
            raise ValueError("days必须在1至92之间")
    for key in ("noDaily", "noMonthly"):
        if key in result and not isinstance(result[key], bool):
            raise ValueError("%s必须为布尔值" % key)
    return result

class Handler(BaseHTTPRequestHandler):
    server_version = "WecomCheckinAnalytics/1.0"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------ helpers
    def log_message(self, fmt, *args):
        if os.getenv("VERBOSE"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, body, ctype="application/json; charset=utf-8", status=200, inline=None, gzip_ok=True):
        if isinstance(body, str):
            body = body.encode("utf-8")
        headers = {"Cache-Control": "no-store", "Content-Type": ctype,
                   "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
                   "Referrer-Policy": "no-referrer",
                   "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.is.autonavi.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"}
        accept = self.headers.get("Accept-Encoding", "")
        if gzip_ok and "gzip" in accept and len(body) > 1024:
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
                gz.write(body)
            body = buf.getvalue()
            headers["Content-Encoding"] = "gzip"
        if inline:
            headers["Content-Disposition"] = 'attachment; filename="%s"' % inline
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, status=200, inline=None):
        self._send(json.dumps(obj, ensure_ascii=False), status=status, inline=inline)

    def _err(self, msg, status=400):
        self._json({"ok": False, "error": msg}, status=status)

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n < 0 or n > 65536:
            raise ValueError("请求体过大")
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise ValueError("请求体必须为有效JSON")

    # ------------------------------------------------------------ routes
    def do_HEAD(self):
        self.do_GET(api_only=True)

    def do_GET(self, api_only=False):
        if not self._local_host_allowed():
            return self._err("Host不允许访问本机服务", 403)
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        if path in ("/api/dataset", "/api/dataset/"):
            data = load_dataset()
            if data is None:
                return self._err("还没有数据：先执行 python3 tools/make_demo_data.py 生成演示数据，"
                                 "或 python3 fetch_checkin.py --days 30 拉取真实数据", 404)
            return self._json({"ok": True, "data": filter_dataset(data, qs)})
        if path == "/api/meta":
            data = load_dataset()
            meta = apply_attendance_scope(data).get("meta", {}) if data else {}
            return self._json({"ok": data is not None, "meta": meta, "fetch": fetch_status(),
                               "credentials": bool(os.getenv("WECOM_CORPID") or os.path.exists(os.path.join(ROOT, "config.json")))})
        if path == "/api/fetch_status":
            return self._json({"ok": True, "fetch": fetch_status()})
        if path == "/api/export":
            data = load_dataset()
            if data is None:
                return self._err("无数据", 404)
            which = qs.get("name", "records")
            if which not in ("records", "daily"):
                return self._err("只支持 name=records（打卡原始记录）或 name=daily（打卡日报）", 404)
            rows = filter_dataset(data, qs).get(which, [])
            if not rows:
                return self._err("该数据集为空", 404)
            text = fc.daily_csv_text(rows) if which == "daily" else fc.records_csv_text(rows)
            return self._send(("\ufeff" + text).encode("utf-8"),
                              ctype="text/csv; charset=utf-8",
                              inline="checkin_%s_%s.csv" % (which, time.strftime("%Y%m%d")))
        if api_only:
            return self._send(b"", ctype="text/plain", gzip_ok=False)

        # 静态文件（.. 一律直接拒绝，不给 SPA 回退机会）
        rel = path.lstrip("/") or "index.html"
        if ".." in rel:
            return self._err("404 Not Found: %s" % path, 404)
        target = os.path.normpath(os.path.join(WEB, rel))
        if not target.startswith(WEB) or not os.path.isfile(target):
            if os.path.isfile(os.path.join(WEB, "index.html")) and "." not in os.path.basename(target):
                target = os.path.join(WEB, "index.html")
            else:
                return self._err("404 Not Found: %s" % path, 404)
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        with open(target, "rb") as f:
            self._send(f.read(), ctype=ctype, gzip_ok=ctype != "image/png")

    def do_POST(self):
        if not self._local_host_allowed():
            return self._err("Host不允许访问本机服务", 403)
        path = urllib.parse.urlparse(self.path).path
        if path != "/api/fetch":
            return self._err("未知接口 %s" % path, 404)
        if not (os.getenv("WECOM_CORPID") or os.path.exists(os.path.join(ROOT, "config.json"))):
            return self._err("未配置企业微信凭证：请 cp config.example.json config.json 并填写 corpid / "
                             "corpsecret（该应用需配置到「打卡 - 可调用接口的应用」中），然后重启服务", 412)
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        if (origin and urllib.parse.urlparse(origin).netloc != host) or self.headers.get("Sec-Fetch-Site") == "cross-site":
            return self._err("拒绝跨站抓取请求", 403)
        try:
            params = validate_fetch_params(self._body())
        except (ValueError, TypeError):
            return self._err("参数格式无效：请检查日期、天数及JSON类型", 400)
        if not _FETCH_LOCK.acquire(blocking=False):
            return self._err("已有抓取任务正在执行，请等待完成", 409)
        try:
            fc.atomic_json(STATUS, {"running": True, "step": "排队中", "done": 0, "total": 0,
                                  "started_at": time.time(), "errors": []})
        except Exception:                                        # noqa: BLE001
            _FETCH_LOCK.release()
            raise
        threading.Thread(target=run_fetch, args=(params,), daemon=True).start()
        return self._json({"ok": True, "message": "抓取任务已启动，请轮询 /api/fetch_status"})

    def _local_host_allowed(self):
        bound = self.server.server_address[0]
        if bound not in ("127.0.0.1", "::1"):
            return True  # 管理层内网部署的网络访问控制由部署环境承担。
        host = urllib.parse.urlparse("http://" + self.headers.get("Host", "")).hostname
        return host in ("127.0.0.1", "localhost", "::1")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--demo", action="store_true", help="无数据时自动生成演示数据")
    args = ap.parse_args()
    os.makedirs(DATA, exist_ok=True)
    if not os.path.exists(DATASET):
        if args.demo:
            print("未发现数据，生成演示数据…")
            import subprocess
            subprocess.call([sys.executable, os.path.join(ROOT, "tools", "make_demo_data.py")])
        else:
            print("提示：data/checkin_data.json 不存在。可执行 python3 tools/make_demo_data.py 先看演示效果。")
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print("打卡分析看板 -> http://%s:%d" % (args.host, args.port))
    print("Ctrl+C 停止")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("已停止")


if __name__ == "__main__":
    main()

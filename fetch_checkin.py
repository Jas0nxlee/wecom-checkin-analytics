#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
企业微信打卡数据抓取脚本（零第三方依赖，Python 3.8+）

调用接口：
  gettoken                     获取 access_token
  user/list_id + user/list     通讯录成员（可选，缺权限时自动降级）
  checkin/getcheckindata       打卡原始记录（含经纬度/WiFi/设备/异常）
  checkin/getcheckin_daydata   打卡日报（迟到/早退/缺卡/旷工/加班/请假）
  checkin/getcheckin_monthdata 打卡月报
  checkin/getcheckinoption     打卡规则（标准上下班时间）

输出（data/ 目录）：
  checkin_data.json  前端看板唯一数据源（records + daily + monthly + rules + users + meta）
  checkin_records.csv / checkin_daily.csv  便于用 Excel 复核

用法：
  python3 fetch_checkin.py --start 2026-08-01 --end 2026-08-28
  python3 fetch_checkin.py --days 30 --depts 1            # 最近30天，指定部门
  python3 fetch_checkin.py --users zhangsan,lisi --no-monthly
"""

import argparse
import csv
import io
import json
import math
import os
import re
import sys
import time
import tempfile
import shutil
import uuid
import fcntl
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from checkin_policy import POLICY, segments, rule_day, fetch_approvals, fetch_shift_calendar, apply_attendance_scope

BASE = "https://qyapi.weixin.qq.com/cgi-bin"
ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")

# 接口限制（见企业微信开发者文档）
MAX_USER_PER_CALL = 100      # getcheckindata useridlist 上限
MAX_DAYS_PER_CALL = 28       # getcheckindata 时间跨度不超过 30 天，留余量
RATE_SLEEP = 0.22            # 600 次/分钟 -> ~10 次/秒，保守一点
TZ = timezone(timedelta(hours=8))


def atomic_json(path, value):
    """同目录暂存 + fsync + replace；读取者只会看到完整版本。"""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".checkin-", dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


class FetchedRows(list):
    """记录成功分片，空结果和失败不是同一种状态。"""
    def __init__(self):
        super().__init__()
        self.coverage = []
        self.errors = []

    def success(self, users, start, end):
        self.coverage.append({"users": list(users), "start": start.strftime("%Y-%m-%d"),
                              "end": end.strftime("%Y-%m-%d")})

    def fail(self, error):
        self.errors.append(explain(error))


def log(msg):
    print("[%s] %s" % (datetime.now().strftime("%H:%M:%S"), msg), flush=True)


def http_json(url, payload=None, timeout=30):
    """GET/POST 并解析 JSON。payload 不为 None 时用 POST + JSON body。"""
    data = None
    headers = {"User-Agent": "wecom-checkin-analytics/1.0"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:                    # noqa: BLE001
        raw = e.read().decode("utf-8", "ignore")
    except Exception as e:                                  # noqa: BLE001
        return {"errcode": -1, "errmsg": "网络异常: %s" % e}
    try:
        result = json.loads(raw)
        return result if isinstance(result, dict) else {"errcode": -1, "errmsg": "接口顶层不是JSON对象"}
    except Exception:
        return {"errcode": -1, "errmsg": "返回非 JSON: %s" % raw[:300]}


class Progress:
    """给 server.py 读的进度状态。"""

    def __init__(self, sink=None):
        self.sink = sink if sink is not None else os.path.join(DATA_DIR, "fetch_status.json")
        self.state = {"running": True, "step": "初始化", "done": 0, "total": 0,
                      "started_at": time.time(), "message": "", "errors": []}
        self.flush()

    def update(self, **kw):
        self.state.update(kw)
        self.flush()

    def error(self, msg):
        msg = explain(msg)
        if msg in self.state["errors"]:
            return
        self.state["errors"].append(str(msg)[:500])
        self.state["errors"] = self.state["errors"][-50:]
        self.flush()

    def finish(self, **kw):
        self.state.update(kw)
        self.state["running"] = False
        self.state["finished_at"] = time.time()
        self.flush()

    def flush(self):
        try:
            atomic_json(self.sink, self.state)
        except Exception:
            pass


class WeComClient:
    def __init__(self, corpid, corpsecret, progress=None):
        self.corpid = corpid
        self.corpsecret = corpsecret
        self.token = None
        self.token_expire = 0
        self.progress = progress
        self.calls = 0

    def get_token(self, force=False):
        if not force and self.token and time.time() < self.token_expire - 120:
            return self.token
        url = "%s/gettoken?corpid=%s&corpsecret=%s" % (
            BASE, urllib.parse.quote(self.corpid), urllib.parse.quote(self.corpsecret))
        r = http_json(url)
        if r.get("errcode"):
            raise RuntimeError("gettoken 失败 errcode=%s errmsg=%s" % (r.get("errcode"), r.get("errmsg")))
        self.token = r["access_token"]
        self.token_expire = time.time() + int(r.get("expires_in", 7200))
        return self.token

    def call(self, path, payload=None, get=False, retry=2):
        """带 40014/42001 自动刷新 token 与限流重试的调用。"""
        for attempt in range(retry + 1):
            token = self.get_token()
            if get:
                url = "%s/%s?access_token=%s&%s" % (BASE, path, token, urllib.parse.urlencode(payload or {}))
                r = http_json(url)
            else:
                url = "%s/%s?access_token=%s" % (BASE, path, token)
                r = http_json(url, payload or {})
            self.calls += 1
            code = r.get("errcode")
            if code == 0:
                if self.progress:
                    self.progress.update(api_calls=self.calls)
                return r
            if code in (40014, 42001, 40001) and attempt < retry:      # token 失效
                self.token_expire = 0
                time.sleep(0.5)
                continue
            if code == 45009 and attempt < retry:                      # 接口调用超过限制
                time.sleep(3)
                continue
            raise RuntimeError("%s 失败 errcode=%s errmsg=%s" % (path, code, r.get("errmsg")))
        return r


def explain(msg):
    """把 errcode 翻成可执行的排查建议，让前端抽屉不用翻文档就知道改哪里。"""
    msg = str(msg)
    m = re.search(r"errcode=(-?\d+)", msg)
    if m:
        tip = friendly(int(m.group(1)))
        if tip and tip not in msg:
            return "%s\n   \u2192 排查建议：%s" % (msg, tip)
    return msg


def load_config(args):
    """凭证优先级：命令行 > 环境变量 > config.json / config.local.json。"""
    cfg = {}
    for name in ("config.json", "config.local.json"):
        p = os.path.join(ROOT, name)
        if os.path.exists(p):
            try:
                with open(p, encoding="utf-8") as f:
                    cfg.update(json.load(f) or {})
            except Exception as e:                                       # noqa: BLE001
                log("配置文件 %s 解析失败：%s" % (name, e))
    corpid = args.corpid or os.getenv("WECOM_CORPID") or cfg.get("corpid")
    secret = args.corpsecret or os.getenv("WECOM_CORPSECRET") or cfg.get("corpsecret")
    if not corpid or not secret:
        sys.exit("缺少凭证：请用 --corpid/--corpsecret、环境变量 WECOM_CORPID/WECOM_CORPSECRET "
                 "或 config.json 提供。\n可先执行 cp config.example.json config.json 后填写。")
    return corpid, secret, cfg


def day_ts(d):
    """中国考勤归属日的0点，不受服务器时区或传入时分秒影响。"""
    return int(datetime(d.year, d.month, d.day, tzinfo=TZ).timestamp())

def chunked(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def date_windows(start, end, days):
    cur, out = start, []
    while cur <= end:
        last = min(cur + timedelta(days=days - 1), end)
        out.append((cur, last))
        cur = last + timedelta(days=1)
    return out


def _dict(value):
    """外部 JSON 对象兜底；接口偶发缺字段/类型异常时不要把字符串当字典。"""
    return value if isinstance(value, dict) else {}


def _rows(response, field, context, progress=None):
    """读取接口中的对象数组，并过滤异常元素，同时留下可读诊断。"""
    response = _dict(response)
    value = response.get(field, [])
    if value is None:
        return []
    if isinstance(value, dict):
        value = [value]
    if not isinstance(value, list):
        msg = "%s 返回 %s 类型异常：期望数组，实际 %s" % (
            context, field, type(value).__name__)
        log(msg)
        if progress:
            progress.error(msg)
        return []
    rows = [item for item in value if isinstance(item, dict)]
    skipped = len(value) - len(rows)
    if skipped:
        msg = "%s 返回 %s 时跳过 %d 个非对象元素" % (context, field, skipped)
        log(msg)
        if progress:
            progress.error(msg)
    return rows


def checked_rows(response, field):
    value = response.get(field) if isinstance(response, dict) else None
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise RuntimeError("%s响应结构异常，该分片不参与覆盖" % field)
    return value


def _department_ids(value, fallback=None):
    """把成员 department 字段统一成 ID 列表，兼容单值、数组和字符串。"""
    if isinstance(value, (list, tuple)):
        values = list(value)
    elif value not in (None, ""):
        values = [value]
    else:
        values = [fallback] if fallback is not None else []
    return [item for item in values if isinstance(item, (int, str)) and item != ""]


# ---------------------------------------------------------------- 通讯录
def fetch_departments(cli, progress=None):
    r = cli.call("department/list", get=True)
    if not isinstance(r.get("department"), list) or any(not isinstance(d, dict) for d in r.get("department", [])):
        cli.roster_complete = False
    depts = _rows(r, "department", "department/list", progress)
    log("部门 %d 个" % len(depts))
    return depts


def fetch_user_ids(cli, dept_ids=None):
    """通讯录接口受 IP 限制时，尝试用 user/list_id 只取 userid。"""
    out, seen, cursor = [], set(), ""
    while True:
        r = _dict(cli.call("user/list_id", {"cursor": cursor, "limit": 10000}))
        for item in _rows(r, "dept_user", "user/list_id"):
            uid = item.get("userid")
            if not uid:
                # 新版/第三方接口可能只给 open_userid，不能直接用于 checkin 接口。
                continue
            item_depts = _department_ids(item.get("department"))
            if dept_ids and not ({str(x) for x in item_depts} & {str(x) for x in dept_ids}):
                continue
            if uid not in seen:
                seen.add(uid)
                out.append({"userid": uid, "name": uid,
                            "main_dept": "未分组", "dept_names": [],
                            "dept_ids": item_depts})
        cursor = r.get("next_cursor") or ""
        if not cursor:
            break
    log("通讯录 ID %d 人" % len(out))
    return out


def fetch_users(cli, dept_ids=None, progress=None):
    """返回 [{userid, name, dept_ids, dept_names, position, mobile_hide}]；无通讯录权限时返回 None。"""
    cli.roster_complete = True
    try:
        depts = fetch_departments(cli, progress)
    except RuntimeError as e:
        cli.roster_complete = False
        if progress:
            progress.error("department/list: %s" % e)
        log("部门列表读取失败，尝试只取成员 ID（%s）" % e)
        try:
            users = fetch_user_ids(cli, dept_ids)
            if progress:
                progress.update(user_ids=len(users))
            return users
        except RuntimeError as id_error:
            if progress:
                progress.error("user/list_id: %s" % id_error)
            log("成员 ID 读取也失败，无法自动确定 userid（%s）" % id_error)
            return None
    dept_name = {}
    for d in depts:
        did, name = d.get("id"), d.get("name", "")
        if did is not None:
            dept_name[did] = name
            dept_name[str(did)] = name
    users, seen = [], set()
    targets = dept_ids or [d.get("id") for d in depts if d.get("id") is not None] or [1]
    for did in targets:
        try:
            r = cli.call("user/list", get=True, payload={"department_id": did, "fetch_child": "0"})
        except RuntimeError as e:
            cli.roster_complete = False
            if progress:
                progress.error("user/list: %s" % e)
            log("部门 %s 成员读取失败：%s" % (did, e))
            continue
        for u in _rows(r, "userlist", "user/list"):
            uid = u.get("userid")
            if not uid or uid in seen or u.get("status", 1) == 5:      # 5=已离职
                continue
            seen.add(uid)
            uids = _department_ids(u.get("department"), did)
            users.append({
                "userid": uid,
                "name": u.get("name") or uid,
                "en_name": u.get("en_name", ""),
                "position": u.get("position", ""),
                "dept_ids": uids,
                "dept_names": [dept_name.get(i, "部门%s" % i) for i in uids],
                "main_dept": dept_name.get(uids[0] if uids else did, "未分组"),
            })
        if not isinstance(r.get("userlist"), list) or any(not isinstance(u, dict) for u in r.get("userlist", [])):
            cli.roster_complete = False
    log("通讯录成员 %d 人" % len(users))
    return users


# ---------------------------------------------------------------- 打卡数据
def fetch_checkin_records(cli, userids, start, end, progress=None):
    """打卡原始记录：<=100 人/批，<=28 天/段。opencheckindatatype=3 全部打卡。"""
    records = FetchedRows()
    batches = list(chunked(userids, MAX_USER_PER_CALL))
    windows = date_windows(start, end, MAX_DAYS_PER_CALL)
    total = len(batches) * len(windows)
    done = 0
    if progress:
        progress.update(step="拉取打卡原始记录", done=0, total=total)
    for bu in batches:
        for s, e in windows:
            try:
                r = cli.call("checkin/getcheckindata", {
                    "opencheckindatatype": 3,
                    "starttime": day_ts(s),
                    "endtime": day_ts(e + timedelta(days=1)) - 1,
                    "useridlist": bu,
                })
                got = checked_rows(r, "checkindata")
            except RuntimeError as ex:
                records.fail(ex)
                log("getcheckindata 失败：%s" % ex)
                if progress:
                    progress.error("getcheckindata: %s" % ex)
                done += 1
                continue
            records.extend(got)
            records.success(bu, s, e)
            done += 1
            log("  记录 %d 条（累计 %d）人数批 %d / 区间 %s~%s" % (len(got), len(records), len(bu), s, e))
            if progress:
                progress.update(done=done, records=len(records))
            time.sleep(RATE_SLEEP)
    return records


def fetch_daydata(cli, userids, start, end, progress=None):
    """打卡日报：迟到/早退/缺卡/旷工/地点异常/设备异常 + 加班 + 请假。"""
    out = FetchedRows()
    batches = list(chunked(userids, MAX_USER_PER_CALL))
    windows = date_windows(start, end, 28)
    total = len(batches) * len(windows)
    done = 0
    if progress:
        progress.update(step="拉取打卡日报", done=0, total=total)
    for bu in batches:
        for s, e in windows:
            try:
                r = cli.call("checkin/getcheckin_daydata", {
                    "starttime": day_ts(s), "endtime": day_ts(e), "useridlist": bu})
                rows = checked_rows(r, "datas")
            except RuntimeError as ex:
                out.fail(ex)
                log("getcheckin_daydata 失败：%s" % ex)
                if progress:
                    progress.error("getcheckin_daydata: %s" % ex)
                continue
            out.extend(rows)
            out.success(bu, s, e)
            done += 1
            log("  日报 %d 条（累计 %d）" % (len(rows), len(out)))
            if progress:
                progress.update(done=done, daily=len(out))
            time.sleep(RATE_SLEEP * 3)      # 日报限流 100 次/分钟
    return out


def fetch_monthdata(cli, userids, start, end, progress=None):
    out = FetchedRows()
    batches = list(chunked(userids, MAX_USER_PER_CALL))
    total = len(batches)
    if progress:
        progress.update(step="拉取打卡月报", done=0, total=total)
    for i, bu in enumerate(batches, 1):
        try:
            r = cli.call("checkin/getcheckin_monthdata", {
                "starttime": day_ts(start), "endtime": day_ts(end), "useridlist": bu})
            rows = checked_rows(r, "datas")
        except RuntimeError as ex:
            out.fail(ex)
            log("getcheckin_monthdata 失败：%s" % ex)
            if progress:
                progress.error("getcheckin_monthdata: %s" % ex)
            continue
        for row in rows:
            row["query_start"] = start.strftime("%Y-%m-%d")
            row["query_end"] = end.strftime("%Y-%m-%d")
        out.extend(rows)
        out.success(bu, start, end)
        log("  月报 %d 条" % len(rows))
        if progress:
            progress.update(done=i, monthly=len(out))
        time.sleep(1.1)                      # 月报限流 60 次/分钟
    return out


def fetch_rules(cli, userids, progress=None, start=None, end=None):
    """打卡规则（含标准上下班时间 option_time / 打卡方式 checkin_type）。"""
    out = FetchedRows()
    start = start or datetime.now(TZ)
    end = end or start
    for day, _ in date_windows(start, end, 1):
        for bu in chunked(userids, MAX_USER_PER_CALL):
            try:
                r = cli.call("checkin/getcheckinoption", {"datetime": day_ts(day), "useridlist": bu})
                if not isinstance(r.get("info"), list):
                    raise RuntimeError("打卡规则响应缺少info数组")
                out.extend(rule_day(item, day.strftime("%Y-%m-%d")) for item in r["info"] if isinstance(item, dict))
                out.success(bu, day, day)
            except RuntimeError as ex:
                out.fail(ex)
                if progress:
                    progress.error("getcheckinoption: %s" % ex)
                # 权限/可信IP错误不会因更换日期恢复，停止该接口，保留原快照。
                if any("errcode=%s" % code in str(ex) for code in (60020, 60011, 301055, 48002)):
                    return out
            if progress:
                progress.update(step="同步逐日排班规则", rule_date=day.strftime("%Y-%m-%d"), rules=len(out))
            time.sleep(RATE_SLEEP)
    log("打卡规则 %d 条" % len(out))
    shift_users = list({r["userid"] for r in out if r.get("grouptype") == 2})
    if shift_users:
        try:
            shifts = fetch_shift_calendar(cli, shift_users, start, end)
            lookup = {(r["userid"], r["date"]): r for r in shifts}
            for row in out:
                if (row["userid"], row["date"]) in lookup:
                    row.update(lookup[(row["userid"], row["date"])])
        except RuntimeError as error:
            out.fail(error)
            if progress:
                progress.error(error)
    return out


# ---------------------------------------------------------------- 规整化
EXCEPTION_CODE = {1: "迟到", 2: "早退", 3: "缺卡", 4: "旷工", 5: "地点异常", 6: "设备异常"}
SP_TYPE = {1: "请假", 2: "补卡", 3: "出差", 4: "外出", 15: "审批打卡", 100: "外勤"}


def _coordinate(value):
    """接口坐标是微度数；同时兼容少数已经是度数的回放数据。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if abs(number) > 180:
        number /= 1000000.0
    return number if math.isfinite(number) else None


def _valid_coordinate_pair(lat, lng):
    """本看板使用中国境内 GCJ-02；0/0、负纬度等占位/脏值按无坐标处理。"""
    return (lat is not None and lng is not None and 0 < lat <= 60 and 70 <= lng <= 140)


def norm_record(r, users_by_id):
    """打卡原始记录 -> 前端友好的扁平结构（经纬度还原、日期时间派生）。"""
    r = _dict(r)
    ts = int(r.get("checkin_time") or 0)
    dt = datetime.fromtimestamp(ts, TZ) if ts else None
    lat, lng = _coordinate(r.get("lat")), _coordinate(r.get("lng"))
    # 接口返回的是实际经纬度的 1e6 倍（GCJ-02，与腾讯/高德地图一致）
    if not _valid_coordinate_pair(lat, lng):
        lat, lng = None, None
    sch = int(r.get("sch_checkin_time") or 0)
    sch_minute = ((datetime.fromtimestamp(sch, TZ).hour * 60 + datetime.fromtimestamp(sch, TZ).minute)
                  if sch > 172800 else sch // 60) if sch else None
    attendance_date = datetime.fromtimestamp(sch, TZ).strftime("%Y-%m-%d") if sch > 172800 else (dt.strftime("%Y-%m-%d") if dt else "")
    u = users_by_id.get(r.get("userid"), {})
    return {
        "userid": r.get("userid"),
        "name": u.get("name") or r.get("userid"),
        "dept": u.get("main_dept") or "未分组",
        "dept_names": u.get("dept_names") or [],
        "groupname": r.get("groupname", ""),
        "type": r.get("checkin_type", ""),
        "exception": r.get("exception_type", "") or "",
        "ts": ts,
        "attendance_date": attendance_date,
        "is_placeholder": "未打卡" in (r.get("exception_type") or ""),
        "raw_exception": r.get("exception_type") or "",
        "datetime": dt.strftime("%Y-%m-%d %H:%M:%S") if dt else "",
        "date": dt.strftime("%Y-%m-%d") if dt else "",
        "hour": dt.hour if dt else None,
        "minute": dt.minute if dt else None,
        "minute_of_day": (dt.hour * 60 + dt.minute) if dt else None,
        "weekday": dt.weekday() if dt else None,
        "month": dt.strftime("%Y-%m") if dt else "",
        "week": "%04d-W%02d" % (dt.isocalendar()[0], dt.isocalendar()[1]) if dt else "",
        "location_title": r.get("location_title", "") or "",
        "location_detail": r.get("location_detail", "") or "",
        "lat": lat,
        "lng": lng,
        "wifiname": r.get("wifiname", "") or "",
        "wifimac": r.get("wifimac", "") or "",
        "deviceid": r.get("deviceid", "") or "",
        "notes": r.get("notes", "") or "",
        "media_count": len(r.get("mediaids") or []),
        "sch_minute_of_day": sch_minute,
        "sch_time": ("%02d:%02d" % (sch_minute // 60, sch_minute % 60)) if sch_minute is not None else "",
        "sch_ts": sch if sch > 172800 else None,
        "groupid": r.get("groupid"),
        "schedule_id": r.get("schedule_id"),
        "timeline_id": r.get("timeline_id"),
    }


def _holiday_text(value):
    """提取假勤摘要标题；缺字段或非对象值按空标题处理。"""
    title = _dict(_dict(value).get("sp_title"))
    data = title.get("data") or []
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        return ""
    for item in data:
        if isinstance(item, dict) and item.get("text"):
            return item.get("text", "")
    return ""


def norm_daily(d, users_by_id):
    d = _dict(d)
    b = d.get("base_info", {}) or {}
    s = d.get("summary_info", {}) or {}
    b = _dict(b)
    s = _dict(s)
    ts = int(b.get("date") or 0)
    date = datetime.fromtimestamp(ts, TZ).strftime("%Y-%m-%d") if ts else ""
    uid = b.get("acctid", "")
    u = users_by_id.get(uid, {})
    exc = {}
    for e in d.get("exception_infos", []) or []:
        if not isinstance(e, dict):
            continue
        exc[EXCEPTION_CODE.get(e.get("exception"), str(e.get("exception")))] = {
            "count": int(e.get("count") or 0), "duration": int(e.get("duration") or 0)}
    ot = _dict(d.get("ot_info", {}) or {})
    sp = []
    for i in d.get("sp_items", []) or []:
        if not isinstance(i, dict):
            continue
        dur = int(i.get("duration") or 0)
        if int(i.get("time_type") or 0) == 0:      # 按天统计 -> 秒/86400*8 折算成小时不严谨，保留原值+单位
            dur_hours = round(dur / 86400.0 * 8, 2)
        else:
            dur_hours = round(dur / 3600.0, 2)
        sp.append({"name": i.get("name", ""), "type": SP_TYPE.get(i.get("type"), i.get("type")),
                   "count": int(i.get("count") or 0), "hours": dur_hours,
                   "duration": dur, "time_type": i.get("time_type", 0)})
    ri = _dict(b.get("rule_info", {}) or {})
    checkin_times = ri.get("checkintime") or [{}]
    if isinstance(checkin_times, dict):
        checkin_times = [checkin_times]
    ci = _dict(checkin_times[0]) if isinstance(checkin_times, list) and checkin_times else {}
    shifts = segments(checkin_times)
    dept_value = b.get("departs_name") or ""
    if isinstance(dept_value, (list, tuple)):
        dept_fallback = [str(x) for x in dept_value if x]
    else:
        dept_fallback = [x for x in str(dept_value).split(";") if x]
    depts = u.get("dept_names") or dept_fallback
    return {
        "userid": uid,
        "name": (u.get("name") if u.get("name") not in (uid, "", None) else None) or b.get("name") or uid,
        "dept": (u.get("main_dept") if u.get("main_dept") not in ("未分组", "", None) else None) or (depts[0].split("/")[-1] if depts else "未分组"),
        "dept_names": depts,
        "date": date,
        "month": date[:7],
        "weekday": (datetime.fromtimestamp(ts, TZ).weekday() if ts else None),
        "week": ("%04d-W%02d" % (datetime.fromtimestamp(ts, TZ).isocalendar()[0],
                                 datetime.fromtimestamp(ts, TZ).isocalendar()[1])) if ts else "",
        "day_type": int(b.get("day_type") or 0),
        "record_type": int(b.get("record_type") or 0),
        "groupname": ri.get("groupname", ""),
        "groupid": ri.get("groupid"), "schedule_id": ri.get("scheduleid"),
        "segments": shifts,
        "std_work_min": shifts[0]["work_sec"] // 60 if shifts else 0,
        "std_off_min": shifts[-1]["off_work_sec"] // 60 if shifts else 0,
        "checkin_count": int(s.get("checkin_count") or 0),
        "actual_work_sec": int(s["regular_work_sec"]) if s.get("regular_work_sec") is not None else None,
        "standard_work_sec": int(s["standard_work_sec"]) if s.get("standard_work_sec") is not None else None,
        "earliest_min": int(s.get("earliest_time") or 0) // 60,
        "lastest_min": int(s.get("lastest_time") or 0) // 60,
        "exceptions": exc,
        "ot_status": int(ot.get("ot_status") or 0),
        "ot_sec": int(ot.get("ot_duration") or 0),
        "sp_items": sp,
        "holiday_titles": [_holiday_text(h) for h in (d.get("holiday_infos") or [])],
        "approval_refs": [h.get("sp_number") for h in d.get("holiday_infos", []) or [] if isinstance(h, dict) and h.get("sp_number")],
        "fetched_at": datetime.now(TZ).isoformat(), "schema_version": 2,
    }


RECORD_CSV_FIELDS = ["name", "userid", "dept", "date", "attendance_date", "datetime", "type", "exception", "is_placeholder", "location_title",
                     "location_detail", "lat", "lng", "wifiname", "deviceid", "notes", "sch_time"]
# 日报里的异常字典展平成中文列，Excel 打开不用自己再算
DAILY_CSV_TITLES = {"迟到": "迟到次数", "早退": "早退次数", "缺卡": "缺卡次数",
                    "旷工": "旷工次数", "地点异常": "地点异常次数", "设备异常": "设备异常次数"}
DAILY_CSV_BASE = ["name", "userid", "dept", "date", "month", "weekday", "groupname", "checkin_count",
                  "actual_work_sec", "standard_work_sec", "earliest_min", "lastest_min",
                  "std_work_min", "std_off_min", "ot_sec"]
DAILY_CSV_FIELDS = DAILY_CSV_BASE + list(DAILY_CSV_TITLES.values())


def daily_csv_row(d):
    """打卡日报 -> Excel 友好的一行（异常次数/时长都按中文列名展开）。"""
    exc = d.get("exceptions") or {}
    row = {k: d.get(k, "") for k in DAILY_CSV_BASE}
    for zh, col in DAILY_CSV_TITLES.items():
        item = exc.get(zh) or {}
        row[col] = item.get("count", 0)
    return row


def write_csv(path, rows, fields):
    fd, temp = tempfile.mkstemp(prefix=".csv-", dir=os.path.dirname(os.path.abspath(path)))
    with os.fdopen(fd, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: csv_safe("|".join(r[k]) if isinstance(r.get(k), list) else r.get(k, "")) for k in fields})
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)


def csv_safe(value):
    if isinstance(value, str) and (re.match(r"^\s*[=+@-]", value) or value.startswith(("\t", "\r", "\n"))):
        return "'" + value
    return value


def daily_csv_text(rows):
    """给 /api/export 用的 CSV 文本（带 BOM，Excel 不乱码）。"""
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=DAILY_CSV_FIELDS, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow({k: csv_safe(v) for k, v in daily_csv_row(r).items()})
    return out.getvalue()


def records_csv_text(rows):
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=RECORD_CSV_FIELDS, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow({k: csv_safe("|".join(r[k]) if isinstance(r.get(k), list) else r.get(k, ""))
                    for k in RECORD_CSV_FIELDS})
    return out.getvalue()


def save_dataset(payload):
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, "checkin_data.json")
    # 先校验，避免在备份之前损坏唯一快照。
    json.dumps(payload, ensure_ascii=False, allow_nan=False)
    if load_existing(path) is not None:
        shutil.copy2(path, path + ".previous")
    scoped = apply_attendance_scope(payload)
    recs = scoped.get("records", [])
    write_csv(os.path.join(DATA_DIR, "checkin_records.csv"), recs, RECORD_CSV_FIELDS)
    daily = scoped.get("daily", [])
    write_csv(os.path.join(DATA_DIR, "checkin_daily.csv"), [daily_csv_row(d) for d in daily], DAILY_CSV_FIELDS)
    # JSON是唯一发布点；导出准备失败时，当前看板继续读取旧快照。
    atomic_json(path, payload)


def load_existing(path=None):
    """读上一次抓取结果（增量合并用）。不存在/格式不对时返回 None。"""
    path = path or os.path.join(DATA_DIR, "checkin_data.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    return data if isinstance(data, dict) and isinstance(data.get("records"), list) else None


def _hist_entry(meta, start, end):
    """一次抓取的痕迹（存进 meta.fetch_history，最多保留最近 10 次）。"""
    return {"start": start, "end": end,
            "generated_at": meta.get("generated_at", ""),
            "records": meta.get("record_count", 0),
            "api_calls": meta.get("api_calls", 0)}


def assign_attendance_dates(records, daily, rules):
    """跨夜下班归属前一班次；导出与前端使用同一归属日。"""
    lookup = {(d.get("userid"), d.get("date")): d for d in rules if d.get("segments")}
    lookup.update({(d.get("userid"), d.get("date")): d for d in daily if d.get("segments")})
    for row in records:
        if row.get("type") != "下班打卡" or not row.get("date"):
            continue
        original = row["date"]
        prior = (datetime.strptime(original, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
        previous = lookup.get((row.get("userid"), prior), {})
        if any(s["off_work_sec"] >= 86400 and row.get("minute_of_day", 9999) <= s["off_work_sec"]/60-1440 for s in previous.get("segments", [])):
            row["attendance_date"] = prior




def merge_dataset(old, new, start, end):
    """只替换成功分片；未请求、失败及跳过的接口保留历史。"""
    if not old or old.get("meta", {}).get("demo") or new.get("meta", {}).get("demo"):
        merged = dict(new)
        merged["meta"] = dict(new.get("meta", {}), fetch_history=[_hist_entry(new.get("meta", {}), start, end)])
        if old and old.get("meta", {}).get("demo"):
            merged["meta"]["merge"] = "演示数据不参与增量合并，已整份覆盖"
        return merged
    meta = new.get("meta", {})
    scope = meta.get("requested_users")
    if scope is None:  # 兼容旧版数据，正式采集总会携带逐接口coverage。
        scope = list({r.get("userid") for section in ("records", "daily", "users") for r in new.get(section, [])})
    coverage = meta.get("coverage")
    def replaces(row, section):
        windows = coverage.get(section, []) if coverage is not None else [{"users": scope, "start": start, "end": end}]
        return any(row.get("userid") in w["users"] and w["start"] <= row.get("date", "") <= w["end"] for w in windows)
    merged, kept = dict(new), {}
    keys = {
        "records": lambda r: (r.get("userid"), r.get("ts"), r.get("type"), r.get("schedule_id"), r.get("timeline_id")),
        "daily": lambda r: (r.get("userid"), r.get("date")),
        "rules": lambda r: (r.get("userid"), r.get("date"), r.get("groupid"))}
    for section, key in keys.items():
        history = [r for r in old.get(section, []) if not replaces(r, section)]
        kept[section] = len(history)
        rows = {key(r): r for r in history}
        rows.update({key(r): r for r in new.get(section, [])})
        merged[section] = list(rows.values())
    merged["records"].sort(key=lambda r: (r.get("ts") or 0, r.get("userid") or ""))
    merged["daily"].sort(key=lambda r: (r.get("date", ""), r.get("userid", "")))
    def monthkey(row):
        b = row.get("base_info") or {}
        return (b.get("acctid"), row.get("query_start") or str(b.get("date", ""))[:7], row.get("query_end") or "")
    monthly = {monthkey(m): m for m in old.get("monthly", [])}
    monthly.update({monthkey(m): m for m in new.get("monthly", [])})
    merged["monthly"] = list(monthly.values())
    approval_key = lambda a: (a.get("approval_no"), a.get("userid"), a.get("date"), a.get("item_index", 0))
    approvals = {approval_key(a): a for a in old.get("approvals", [])}
    approvals.update({approval_key(a): a for a in new.get("approvals", [])})
    merged["approvals"] = list(approvals.values())
    users = {} if meta.get("roster_complete") else {u["userid"]: u for u in old.get("users", [])}
    users.update({u["userid"]: u for u in new.get("users", [])})
    merged["users"] = list(users.values())
    assign_attendance_dates(merged["records"], merged["daily"], merged["rules"])
    # 用户已确认历史报表一律按当前组织关系展示。
    for section in ("records", "daily"):
        for row in merged[section]:
            u = users.get(row.get("userid"), {})
            for dest, source in (("name", "name"), ("dept", "main_dept"), ("dept_names", "dept_names")):
                if u.get(source):
                    row[dest] = u[source]
    previous = old.get("meta", {})
    merged["meta"] = dict(meta, start=min(previous.get("start", start), start), end=max(previous.get("end", end), end),
                          users=len(merged["users"]), record_count=len(merged["records"]), daily_count=len(merged["daily"]),
                          monthly_count=len(merged["monthly"]), rule_count=len(merged["rules"]),
                          fetch_history=(previous.get("fetch_history", []) + [_hist_entry(meta, start, end)])[-10:],
                          merge={"window": [start, end], "kept_records": kept["records"], "kept_daily": kept["daily"],
                                 "replaced_records": len(new.get("records", []))})
    return merged


def _main(argv=None):
    ap = argparse.ArgumentParser(description="企业微信打卡数据抓取")
    ap.add_argument("--corpid"), ap.add_argument("--corpsecret")
    ap.add_argument("--start", help="YYYY-MM-DD")
    ap.add_argument("--end", help="YYYY-MM-DD")
    ap.add_argument("--days", type=int, default=30, help="未指定 start/end 时取最近 N 天")
    ap.add_argument("--users", help="逗号分隔 userid；缺省抓可见范围全员")
    ap.add_argument("--depts", help="逗号分隔部门 id，仅取这些部门（需通讯录权限）")
    ap.add_argument("--no-daily", action="store_true", help="跳过打卡日报")
    ap.add_argument("--no-monthly", action="store_true", help="跳过打卡月报")
    ap.add_argument("--no-rules", action="store_true", help="跳过打卡规则")
    ap.add_argument("--no-approvals", action="store_true", help="跳过补卡审批（页面明确显示未同步）")
    ap.add_argument("--refresh-month", action="store_true", help="回补本月，捕获补卡与审批修订")
    ap.add_argument("--no-merge", action="store_true",
                    help="不用增量合并，直接用本次区间覆盖 data/checkin_data.json")
    ap.add_argument("--status-file", help="进度文件路径（server.py 使用）")
    args = ap.parse_args(argv)

    corpid, secret, cfg = load_config(args)
    now = datetime.now(TZ).replace(tzinfo=None)
    if args.start and args.end:
        start = datetime.strptime(args.start, "%Y-%m-%d")
        end = datetime.strptime(args.end, "%Y-%m-%d")
    else:
        end = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1)
        start = end - timedelta(days=max(1, args.days) - 1)
    if args.refresh_month and end.strftime("%Y-%m") == now.strftime("%Y-%m"):
        start = min(start, now.replace(day=1, hour=0, minute=0, second=0, microsecond=0))
        end = max(end, now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1))
    if start > end:
        sys.exit("结束日期不能早于开始日期")
    if (end - start).days + 1 > 92:
        sys.exit("时间跨度 %d 天过长，建议单次不超过 92 天（接口限 30 天/段，跨度大时调用次数很多）"
                 % ((end - start).days + 1))

    progress = Progress(args.status_file) if args.status_file else None
    cli = WeComClient(corpid, secret, progress)
    log("corpid=%s*** 区间 %s ~ %s" % (corpid[:8], start.date(), end.date()))
    cli.get_token()
    log("access_token OK")

    users = fetch_users(cli, None, progress)
    users_by_id = {u.get("userid"): u for u in (users or [])
                   if isinstance(u, dict) and u.get("userid")}

    if args.users:
        userids = list(dict.fromkeys(u.strip() for u in args.users.split(",") if u.strip()))
    else:
        userids = list(users_by_id.keys())
        if args.depts:
            targets = set(args.depts.split(","))
            userids = [uid for uid in userids if targets.intersection(str(x) for x in users_by_id[uid].get("dept_ids", []))]
        if not userids:
            msg = ("未能获取成员 userid，无法拉取打卡数据。请配置通讯录读取权限/接口白名单，"
                   "或在界面/命令行显式填写 --users userid1,userid2")
            if progress:
                progress.error(msg)
                progress.finish(step="抓取失败", message=msg)
            raise RuntimeError(msg)

    progress_update = progress.update if progress else (lambda **k: None)
    approvals, approval_sync = [], {"available": False, "errors": ["本次跳过审批同步"]}
    if not args.no_approvals:
        approval_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        previous_approvals = (load_existing() or {}).get("approvals", [])
        prior_numbers = [a["approval_no"] for a in previous_approvals if a.get("status") == "pending" and a.get("approval_no")]
        approvals, approval_sync = fetch_approvals(cli, list(users_by_id) or userids, approval_start, now, progress, prior_numbers=prior_numbers)
    progress_update(step="拉取打卡原始记录")
    raw = fetch_checkin_records(cli, userids, start, end, progress)
    # 通讯录取不到姓名/部门时，用日报里的 name/departs_name 兜底
    if not users_by_id:
        for r in raw:
            uid = r.get("userid")
            if uid and uid not in users_by_id:
                users_by_id[uid] = {"userid": uid, "name": uid, "main_dept": "未分组", "dept_names": []}

    records = [norm_record(r, users_by_id) for r in raw]
    records.sort(key=lambda x: x["ts"])

    daily, monthly, rules = [], [], []
    coverage = {"records": getattr(raw, "coverage", []), "daily": [], "rules": [], "monthly": []}
    fetch_errors = list(getattr(raw, "errors", []))
    if not getattr(cli, "roster_complete", False):
        fetch_errors.append("通讯录未完整同步，保留已知人员和部门；当前组织关系待复核")
    if not args.no_daily:
        daily = fetch_daydata(cli, userids, start, end, progress)
        coverage["daily"] = getattr(daily, "coverage", [])
        fetch_errors.extend(getattr(daily, "errors", []))
        daily = [norm_daily(d, users_by_id) for d in daily]
    if not args.no_monthly:
        monthly = fetch_monthdata(cli, userids, start, end, progress)
        coverage["monthly"] = getattr(monthly, "coverage", [])
        fetch_errors.extend(getattr(monthly, "errors", []))
    if not args.no_rules:
        rules = fetch_rules(cli, userids, progress, start, end)
        coverage["rules"] = getattr(rules, "coverage", [])
        fetch_errors.extend(getattr(rules, "errors", []))
    if not coverage["records"] and not coverage["daily"]:
        if progress:
            progress.finish(step="抓取失败", message="记录与日报均未成功，原快照未改动")
        raise RuntimeError("记录与日报均未成功，原快照未改动")

    if daily:      # 日报能补全姓名/部门时，回填到 records
        for d in daily:
            u = users_by_id.setdefault(d["userid"], {"userid": d["userid"], "name": d["name"],
                                                     "main_dept": d["dept"], "dept_names": d["dept_names"]})
            if u.get("name") == u.get("userid") and d.get("name"):
                u["name"], u["main_dept"] = d["name"], d["dept"]
                u["dept_names"] = d.get("dept_names", [])
        records = [norm_record(r, users_by_id) for r in raw]

    assign_attendance_dates(records, daily, rules)
    dataset = {
        "meta": {
            "source": "wecom_api",
            "schema_version": 2, "dataset_version": uuid.uuid4().hex, "policy": POLICY,
            "coverage": coverage, "requested_users": userids, "roster_complete": bool(users) and getattr(cli, "roster_complete", False),
            "approval_sync": approval_sync,
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "start": start.strftime("%Y-%m-%d"),
            "end": end.strftime("%Y-%m-%d"),
            "users": len(users_by_id),
            "record_count": len(records),
            "daily_count": len(daily),
            "monthly_count": len(monthly),
            "rule_count": len(rules),
            "api_calls": cli.calls,
            "demo": False,
            "warnings": list(dict.fromkeys(fetch_errors + approval_sync.get("errors", []) + (progress.state.get("errors", []) if progress else []))),
        },
        "users": list(users_by_id.values()),
        "records": records,
        "daily": daily,
        "monthly": monthly,
        "rules": rules,
        "approvals": approvals,
    }
    dataset_path = os.path.join(DATA_DIR, "checkin_data.json")
    if not args.no_merge:
        old = load_existing(dataset_path)
        new_rec = len(dataset.get("records") or [])
        new_daily = len(dataset.get("daily") or [])
        dataset = merge_dataset(old, dataset, start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))
        info = dataset.get("meta", {}).get("merge")
        if isinstance(info, dict):
            log("增量合并 %s~%s：本次 %d 条记录 / %d 条日报，保留区间外历史 %d 条记录 / %d 条日报"
                " -> 合并后 %d 条记录 / %d 条日报 / %d 条月报"
                % (start.date(), end.date(), new_rec, new_daily,
                   info["kept_records"], info["kept_daily"], dataset["meta"]["record_count"],
                   dataset["meta"]["daily_count"], dataset["meta"]["monthly_count"]))
        elif info:
            log("增量合并：%s" % info)
    save_dataset(dataset)
    size = os.path.getsize(os.path.join(DATA_DIR, "checkin_data.json"))
    meta = dataset["meta"]
    log("完成：记录 %d 条 / 日报 %d 条 / 月报 %d 条 / 规则 %d 条（区间 %s~%s，API 调用 %d 次）"
        " -> data/checkin_data.json (%.1f MB)"
        % (meta["record_count"], meta["daily_count"], meta["monthly_count"], meta["rule_count"],
           meta["start"], meta["end"], cli.calls, size / 1048576.0))
    if progress:
        progress.finish(step="部分完成" if meta.get("warnings") else "完成", message="记录 %d 条（%s~%s）；失败分片保留旧数据" % (meta["record_count"], meta["start"], meta["end"]),
                        records=meta["record_count"], daily=meta["daily_count"],
                        window=[start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")],
                        dataset_bytes=size)
    return dataset


def main(argv=None):
    """HTTP线程和独立CLI共用跨进程锁，避免并发合并覆盖对方。"""
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, ".fetch.lock"), "a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("该数据目录已有抓取任务运行，请等待完成")
        try:
            return _main(argv)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


HINTS = [
    (60020, "当前出口IP不在企业可信IP白名单：请在自建应用后台更新可信IP"),
    (301055, "审批读取无权限：请把自建应用加入「审批 - 可调用接口的应用」"),
    (40013, "corpid 无效：请到企业微信管理后台「我的企业 → 企业ID」复制"),
    (40001, "secret 不正确或已重置：请用自建应用当前的 Secret"),
    (42001, "access_token 已过期（脚本会自动重试）"),
    (60011, "无权限：该自建应用未配置到「打卡 → 设置 → 可调用接口的应用」，或不在打卡数据可见范围"),
    (301002, "通讯录无权限：可忽略，脚本会改用打卡日报里的姓名/部门"),
    (45009, "接口调用超过频率限制：请缩小时间范围或稍后重试"),
    (48002, "接口权限不足：请在应用详情里开启对应权限"),
    (301021, "不在打卡应用可见范围内：请在打卡规则里把该应用/人员加入可见范围"),
]


def friendly(errcode):
    for code, msg in HINTS:
        if code == errcode:
            return msg
    return ""


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if e.code not in (0, None):
            print("❌ 参数有误：%s" % e.code)
        sys.exit(1 if e.code else 0)
    except RuntimeError as e:
        msg = str(e)
        print("❌ 调用企业微信接口失败：%s" % msg)
        import re as _re
        m = _re.search(r"errcode=(-?\d+)", msg)
        if m:
            tip = friendly(int(m.group(1)))
            if tip:
                print("   → 排查建议：%s" % tip)
        print("   → 常见原因：corpid/secret 不对、应用未加入「打卡 - 可调用接口的应用」、"
              "打卡数据可见范围不含目标人员")
        sys.exit(2)

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓取脚本与本地服务的自测（零第三方依赖，不联网）：

  python3 -m unittest discover -s tests -v
  或  python3 tests/test_fetch_checkin.py

网络调用全部用假响应替代，真实接口行为靠 fetch_checkin.WeComClient 的重试逻辑单测覆盖。
"""
import contextlib
import gzip
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import fetch_checkin as fc  # noqa: E402
import server as server_mod  # noqa: E402


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def ts(day, hour=0, minute=0):
    d = datetime.strptime(day, "%Y-%m-%d").replace(hour=hour, minute=minute)
    return int(time.mktime(d.timetuple()))


class TestWindows(unittest.TestCase):
    """接口硬限制：单次时间跨度 <=30 天、useridlist <=100 人。"""

    def test_chunked(self):
        self.assertEqual(list(fc.chunked([1, 2, 3], 2)), [[1, 2], [3]])
        self.assertEqual(list(fc.chunked([], 5)), [])
        self.assertTrue(all(len(b) <= 100 for b in fc.chunked(list(range(250)), 100)))

    def test_date_windows_cover_range_once(self):
        wins = fc.date_windows(datetime(2026, 8, 1), datetime(2026, 8, 28), 28)
        self.assertEqual(len(wins), 1)
        self.assertEqual(wins[0], (datetime(2026, 8, 1), datetime(2026, 8, 28)))

        wins = fc.date_windows(datetime(2026, 6, 30), datetime(2026, 8, 28), 28)
        days = []
        for i, (s, e) in enumerate(wins):
            self.assertLessEqual((e - s).days + 1, 28, "每段不超过 28 天")
            if i:
                self.assertEqual(s, wins[i - 1][1] + timedelta(days=1), "段与段连续无空洞")
            cur = s
            while cur <= e:
                days.append(cur)
                cur += timedelta(days=1)
        self.assertEqual(days[0], datetime(2026, 6, 30))
        self.assertEqual(days[-1], datetime(2026, 8, 28))
        self.assertEqual(len(days), len(set(days)), "没有重复日期")
        self.assertEqual(len(days), 60)

    def test_single_day(self):
        self.assertEqual(fc.date_windows(datetime(2026, 8, 5), datetime(2026, 8, 5), 28),
                         [(datetime(2026, 8, 5), datetime(2026, 8, 5))])


class TestApiShapeGuards(unittest.TestCase):
    def test_malformed_department_items_do_not_index_strings(self):
        class Cli(object):
            def call(self, path, payload=None, get=False, retry=2):
                if path == "department/list":
                    return {"errcode": 0, "department": ["not-an-object"]}
                if path == "user/list":
                    return {"errcode": 0, "userlist": [{"userid": "u1", "name": "员工",
                                                         "department": 2}]}
                raise AssertionError(path)

        users = fc.fetch_users(Cli())
        self.assertEqual(users[0]["userid"], "u1")
        self.assertEqual(users[0]["dept_ids"], [2])

    def test_malformed_daily_optional_fields_are_ignored(self):
        d = fc.norm_daily({"base_info": "bad", "summary_info": "bad",
                           "exception_infos": ["bad"], "sp_items": ["bad"],
                           "holiday_infos": ["bad"]}, {})
        self.assertEqual(d["date"], "")
        self.assertEqual(d["exceptions"], {})
        self.assertEqual(d["sp_items"], [])
        self.assertEqual(d["holiday_titles"], [""])


class TestNormRecord(unittest.TestCase):
    def test_full_record(self):
        r = fc.norm_record({
            "userid": "emp001", "checkin_type": "上班打卡", "exception_type": "时间异常",
            "checkin_time": ts("2026-08-03", 9, 37), "lat": 22540000, "lng": 113934000,
            "location_title": "腾讯大厦", "location_detail": "深圳市南山区", "wifiname": "office-5G",
            "wifimac": "aa:bb", "deviceid": "DEV-1", "notes": "堵车", "mediaids": ["m1", "m2"],
            "sch_checkin_time": 9 * 3600 + 30 * 60, "groupname": "固定班", "groupid": 10,
        }, {"emp001": {"userid": "emp001", "name": "张三", "main_dept": "研发", "dept_names": ["示例/研发"]}})
        self.assertEqual(r["name"], "张三")
        self.assertEqual(r["dept"], "研发")
        self.assertEqual(r["date"], "2026-08-03")
        self.assertEqual(r["datetime"], "2026-08-03 09:37:00")
        self.assertEqual(r["hour"], 9)
        self.assertEqual(r["minute_of_day"], 9 * 60 + 37)
        self.assertAlmostEqual(r["lat"], 22.54, places=5)
        self.assertAlmostEqual(r["lng"], 113.934, places=5)
        self.assertEqual(r["sch_minute_of_day"], 570)
        self.assertEqual(r["sch_time"], "09:30")
        self.assertEqual(r["week"], "2026-W32")
        self.assertEqual(r["month"], "2026-08")
        self.assertEqual(r["weekday"], 0, "周一")
        self.assertEqual(r["media_count"], 2)

    def test_missing_optional_fields(self):
        r = fc.norm_record({"userid": "x", "checkin_time": ts("2026-08-04", 18, 0)}, {})
        self.assertEqual(r["name"], "x", "没有通讯录时用 userid 兜底")
        self.assertEqual(r["dept"], "未分组")
        self.assertIsNone(r["lat"], "WiFi 打卡没有坐标")
        self.assertEqual(r["exception"], "")
        self.assertEqual(r["sch_time"], "")
        self.assertIsNone(r["sch_minute_of_day"])

    def test_no_timestamp(self):
        r = fc.norm_record({"userid": "x", "checkin_time": 0}, {})
        self.assertEqual(r["date"], "")
        self.assertIsNone(r["hour"])
        self.assertIsNone(r["minute_of_day"])

    def test_invalid_china_coordinate_is_treated_as_missing(self):
        r = fc.norm_record({"userid": "x", "checkin_time": ts("2026-08-04", 9),
                            "lat": 0, "lng": 0}, {})
        self.assertIsNone(r["lat"])
        self.assertIsNone(r["lng"])
        r = fc.norm_record({"userid": "x", "checkin_time": ts("2026-08-04", 9),
                            "lat": -41328886, "lng": 174811793}, {})
        self.assertIsNone(r["lat"])
        self.assertIsNone(r["lng"])


class TestNormDaily(unittest.TestCase):
    def test_official_counts(self):
        d = fc.norm_daily({
            "base_info": {"acctid": "emp001", "name": "张三", "departs_name": "示例科技/研发部",
                          "date": ts("2026-08-03"), "day_type": 0, "record_type": 1,
                          "rule_info": {"groupname": "固定班",
                                        "checkintime": [{"work_sec": 9 * 3600, "off_work_sec": 18 * 3600}]}},
            "summary_info": {"checkin_count": 4, "regular_work_sec": 28800, "standard_work_sec": 28800,
                             "earliest_time": 8 * 3600, "lastest_time": 20 * 3600 + 30 * 60},
            "exception_infos": [{"exception": 1, "count": 1, "duration": 420},
                                {"exception": 3, "count": 2},
                                {"exception": 99, "count": 1, "duration": 0}],
            "ot_info": {"ot_status": 1, "ot_duration": 3600},
            "sp_items": [{"name": "年假", "type": 1, "count": 1, "duration": 86400, "time_type": 0},
                         {"name": "外勤", "type": 100, "count": 3, "duration": 7200, "time_type": 1}],
            "holiday_infos": [{"sp_title": {"data": [{"text": "端午节"}]}}],
        }, {})
        self.assertEqual(d["date"], "2026-08-03")
        self.assertEqual(d["name"], "张三")
        self.assertEqual(d["dept"], "研发部", "无通讯录时取 departs_name 第一个部门的最后一级")
        self.assertEqual(d["std_work_min"], 540)
        self.assertEqual(d["std_off_min"], 1080)
        self.assertEqual(d["exceptions"]["迟到"], {"count": 1, "duration": 420})
        self.assertEqual(d["exceptions"]["缺卡"]["count"], 2)
        self.assertNotIn("旷工", d["exceptions"], "接口没返回的异常类型不填零（前端按 0 处理）")
        self.assertIn("99", d["exceptions"], "未知异常类型保留原始编号不丢")
        self.assertEqual(d["earliest_min"], 480)
        self.assertEqual(d["lastest_min"], 1230)
        self.assertEqual(d["ot_sec"], 3600)
        self.assertEqual(d["groupname"], "固定班")
        self.assertEqual(d["holiday_titles"], ["端午节"])
        sp = {i["name"]: i for i in d["sp_items"]}
        self.assertEqual(sp["年假"]["type"], "请假")
        self.assertEqual(sp["年假"]["hours"], 8.0, "按天统计折算成 8 小时")
        self.assertEqual(sp["外勤"]["type"], "外勤")
        self.assertEqual(sp["外勤"]["hours"], 2.0, "按小时统计直接换算")

    def test_contacts_win_over_daily(self):
        d = fc.norm_daily({"base_info": {"acctid": "emp001", "name": "日报名",
                                         "departs_name": "A;B", "date": ts("2026-08-03")}},
                          {"emp001": {"userid": "emp001", "name": "通讯录名",
                                      "main_dept": "研发", "dept_names": ["示例/研发"]}})
        self.assertEqual(d["name"], "通讯录名")
        self.assertEqual(d["dept"], "研发")
        self.assertEqual(d["dept_names"], ["示例/研发"])

    def test_multi_dept_takes_first_department(self):
        d = fc.norm_daily({"base_info": {"acctid": "x", "date": ts("2026-08-03"),
                                         "departs_name": "示例科技/研发部;市场部/品牌组"}}, {})
        self.assertEqual(d["dept"], "研发部", "多部门取第一个部门，与通讯录 main_dept 同口径")
        self.assertEqual(d["dept_names"], ["示例科技/研发部", "市场部/品牌组"])
        empty = fc.norm_daily({"base_info": {"acctid": "x", "date": ts("2026-08-03"), "departs_name": ""}}, {})
        self.assertEqual(empty["dept"], "未分组")

    def test_empty_daily(self):
        d = fc.norm_daily({}, {})
        self.assertEqual(d["date"], "")
        self.assertEqual(d["exceptions"], {})
        self.assertEqual(d["std_work_min"], 0)


class TestExplain(unittest.TestCase):
    def test_known_errcode(self):
        msg = fc.explain("checkin/getcheckindata 失败 errcode=60011 errmsg=no permission")
        self.assertIn("60011", msg)
        self.assertIn("可调用接口的应用", msg, "把排查建议一起写进进度文件，前端抽屉直接能看到")

    def test_unknown_errcode_unchanged(self):
        self.assertEqual(fc.explain("boom"), "boom")
        self.assertEqual(fc.explain("errcode=-1 网络异常"), "errcode=-1 网络异常")


class FakeClient(object):
    """假的 WeComClient：按调用次数回放预设响应，用来测重试逻辑。"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0
        self.token_calls = 0

    def get_token(self, force=False):
        if force:
            self.token_calls += 1
        return "tok"

    def call(self, path, payload=None, get=False, retry=2):
        self.calls += 1
        r = self.responses.pop(0)
        code = r.get("errcode")
        if code == 0:
            return r
        if code in (40014, 42001, 45009) and self.responses:
            return self.call(path, payload, get, retry)
        raise RuntimeError("%s 失败 errcode=%s errmsg=%s" % (path, code, r.get("errmsg")))


class TestProgress(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.sink = os.path.join(self.dir, "sub", "fetch_status.json")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_creates_dir_and_flushes(self):
        p = fc.Progress(self.sink)
        p.update(step="拉取打卡原始记录", done=3, total=10)
        with open(self.sink, encoding="utf-8") as f:
            st = json.load(f)
        self.assertEqual(st["step"], "拉取打卡原始记录")
        self.assertTrue(st["running"])
        p.finish(step="完成", records=42)
        with open(self.sink, encoding="utf-8") as f:
            st = json.load(f)
        self.assertFalse(st["running"])
        self.assertEqual(st["records"], 42)

    def test_errors_deduped_and_capped(self):
        p = fc.Progress(self.sink)
        for _ in range(80):
            p.error("checkin/getcheckindata 失败 errcode=45009 errmsg=reach max api")
        self.assertEqual(len(p.state["errors"]), 1, "同一条错误不重复堆")
        self.assertIn("接口调用超过频率限制", p.state["errors"][0], "errcode 自动附带排查建议")
        for i in range(80):
            p.error("第 %d 条错误" % i)
        self.assertLessEqual(len(p.state["errors"]), 50, "错误列表有上限")
        with open(self.sink, encoding="utf-8") as f:
            self.assertLessEqual(len(json.load(f)["errors"]), 50)


class TestMerge(unittest.TestCase):
    """增量合并：拉小区间不能把已拉过的历史顶掉。"""

    def rec(self, uid, day, hh=9):
        return {"userid": uid, "date": day, "ts": ts(day, hh), "name": uid}

    def daily(self, uid, day):
        return {"userid": uid, "date": day, "name": uid, "exceptions": {}, "sp_items": []}

    def payload(self, start, end, recs, daily=(), monthly=(), users=(), demo=False):
        return {"meta": {"source": "wecom_api", "demo": demo, "start": start, "end": end,
                         "record_count": len(recs), "daily_count": len(daily),
                         "monthly_count": len(monthly), "rule_count": 0, "users": len(users),
                         "api_calls": 3, "generated_at": "2026-09-01 10:00:00"},
                "users": list(users), "records": list(recs), "daily": list(daily),
                "monthly": list(monthly), "rules": []}

    def test_keeps_history_outside_window(self):
        old = self.payload("2026-07-01", "2026-08-28",
                           [self.rec("a", "2026-07-02"), self.rec("a", "2026-08-20"),
                            self.rec("b", "2026-08-27")],
                           [self.daily("a", "2026-07-02"), self.daily("a", "2026-08-20")])
        new = self.payload("2026-08-27", "2026-08-28",
                           [self.rec("a", "2026-08-27"), self.rec("b", "2026-08-27")],
                           [self.daily("a", "2026-08-27")])
        m = fc.merge_dataset(old, new, "2026-08-27", "2026-08-28")
        dates = sorted(r["date"] for r in m["records"])
        self.assertEqual(dates, ["2026-07-02", "2026-08-20", "2026-08-27", "2026-08-27"])
        self.assertEqual(m["meta"]["start"], "2026-07-01", "区间向前扩展")
        self.assertEqual(m["meta"]["end"], "2026-08-28")
        self.assertEqual(m["meta"]["record_count"], len(m["records"]))
        self.assertEqual(m["meta"]["merge"]["kept_records"], 2)
        self.assertEqual(sorted(d["date"] for d in m["daily"]), ["2026-07-02", "2026-08-20", "2026-08-27"])
        self.assertEqual(len(m["meta"]["fetch_history"]), 1)

    def test_window_refetch_replaces_and_dedupes(self):
        old = self.payload("2026-08-01", "2026-08-10",
                           [self.rec("a", "2026-08-05", 9), self.rec("a", "2026-08-05", 18)])
        new = self.payload("2026-08-05", "2026-08-05", [self.rec("a", "2026-08-05", 9)])
        m = fc.merge_dataset(old, new, "2026-08-05", "2026-08-05")
        self.assertEqual(len(m["records"]), 1, "区间内以接口结果为准，不重复堆叠")

    def test_no_old_data(self):
        new = self.payload("2026-08-01", "2026-08-02", [self.rec("a", "2026-08-01")])
        m = fc.merge_dataset(None, new, "2026-08-01", "2026-08-02")
        self.assertEqual(m["records"], new["records"], "没有旧数据时直接用本次抓取")
        self.assertEqual(len(m["meta"]["fetch_history"]), 1, "首次抓取也要留下痕迹")

    def test_demo_data_never_mixes(self):
        real = self.payload("2026-08-01", "2026-08-02", [self.rec("a", "2026-08-01")])
        demo = self.payload("2026-08-03", "2026-08-04", [self.rec("e001", "2026-08-03")], demo=True)
        m = fc.merge_dataset(real, demo, "2026-08-03", "2026-08-04")
        self.assertEqual([r["userid"] for r in m["records"]], ["e001"], "演示数据不混进真实数据")
        m2 = fc.merge_dataset(demo, real, "2026-08-01", "2026-08-02")
        self.assertEqual([r["userid"] for r in m2["records"]], ["a"], "真实数据直接覆盖演示数据")
        self.assertIn("merge", m2["meta"])

    def test_monthly_keyed_merge(self):
        def mon(uid, month):
            return {"base_info": {"acctid": uid, "name": uid, "date": month + "-28"}}
        old = self.payload("2026-07-01", "2026-08-28", [self.rec("a", "2026-08-01")],
                           monthly=[mon("a", "2026-06"), mon("a", "2026-07")])
        new = self.payload("2026-08-01", "2026-08-28", [self.rec("a", "2026-08-01")], monthly=[])
        m = fc.merge_dataset(old, new, "2026-08-01", "2026-08-28")
        months = sorted(x["base_info"]["date"][:7] for x in m["monthly"])
        self.assertEqual(months, ["2026-06", "2026-07"], "本次没重拉月报时保留旧月报")
        new2 = self.payload("2026-08-01", "2026-08-28", [self.rec("a", "2026-08-01")],
                            monthly=[mon("a", "2026-07")])
        m2 = fc.merge_dataset(old, new2, "2026-08-01", "2026-08-28")
        self.assertEqual(sorted(x["base_info"]["date"][:7] for x in m2["monthly"]), ["2026-06", "2026-07"])
        self.assertEqual(len(m2["monthly"]), 2, "同月只留新值")

    def test_rules_and_users_merged(self):
        old = {"meta": {"start": "2026-07-01", "end": "2026-08-28"}, "records": [self.rec("a", "2026-07-02")],
               "users": [{"userid": "a", "name": "旧名"}], "daily": [], "monthly": [],
               "rules": [{"groupid": 1, "groupname": "老规则"}]}
        new = self.payload("2026-08-27", "2026-08-28", [self.rec("a", "2026-08-27")],
                           [self.daily("a", "2026-08-27")], users=[{"userid": "a", "name": "新名"},
                                                                   {"userid": "b", "name": "乙"}])
        m = fc.merge_dataset(old, new, "2026-08-27", "2026-08-28")
        self.assertEqual(len(m["rules"]), 1, "本次没取规则时沿用旧规则")
        self.assertEqual(len(m["users"]), 2)
        self.assertEqual([u for u in m["users"] if u["userid"] == "a"][0]["name"], "新名", "人员以新数据为准")

class TestClientRetry(unittest.TestCase):
    """token 失效 / 限流自动重试（用假 HTTP，不联网）。"""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.sink = os.path.join(self.dir, "fetch_status.json")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _client(self, replies):
        p = fc.Progress(self.sink)
        cli = fc.WeComClient("wwid", "secret", p)
        cli.get_token = lambda force=False: "tok"
        self._replies = replies
        self._n = 0

        def fake(url, payload=None, timeout=30):
            r = self._replies[min(self._n, len(self._replies) - 1)]
            self._n += 1
            return r
        fc.http_json = fake
        self.addCleanup(setattr, fc, "http_json", _REAL_HTTP_JSON)
        return cli

    def test_token_refresh_then_success(self):
        cli = self._client([{"errcode": 42001, "errmsg": "token expired"},
                            {"errcode": 0, "checkindata": [{"userid": "a"}]}])
        r = cli.call("checkin/getcheckindata", {"useridlist": ["a"]})
        self.assertEqual(r["errcode"], 0)
        self.assertEqual(self._n, 2, "过期后自动换 token 重试一次")

    def test_rate_limit_retries(self):
        cli = self._client([{"errcode": 45009, "errmsg": "reach max"}, {"errcode": 0, "datas": []}])
        t0 = time.time()
        self.assertEqual(cli.call("checkin/getcheckin_daydata", {})["errcode"], 0)
        self.assertGreaterEqual(time.time() - t0, 2.5, "限流后确实等过")

    def test_permission_error_raises_with_hint(self):
        cli = self._client([{"errcode": 60011, "errmsg": "no permission"}])
        with self.assertRaises(RuntimeError) as cm:
            cli.call("checkin/getcheckindata", {})
        self.assertIn("60011", str(cm.exception))

    def test_progress_records_explained_error(self):
        cli = self._client([{"errcode": 60011, "errmsg": "no permission"}])
        try:
            cli.call("checkin/getcheckindata", {})
        except RuntimeError as e:
            cli.progress.error(e)
        with open(self.sink, encoding="utf-8") as f:
            st = json.load(f)
        self.assertIn("可调用接口的应用", st["errors"][0])


_REAL_HTTP_JSON = fc.http_json


class TestFetchWrappers(unittest.TestCase):
    """抓取包装函数：分批/分段/失败降级。"""

    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_batches_and_windows(self):
        calls = []

        class Cli(object):
            calls = 0

            def call(self, path, payload=None, get=False, retry=2):
                self.calls += 1
                calls.append(payload)
                return {"checkindata": [{"userid": payload["useridlist"][0],
                                         "checkin_time": ts("2026-08-05", 9)}]}
        users = ["u%03d" % i for i in range(120)]
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            out = fc.fetch_checkin_records(Cli(), users, datetime(2026, 8, 1), datetime(2026, 8, 4), None)
        self.assertIn("人数批 100", buf.getvalue(), "日志里说清分批与区间")
        self.assertEqual(len(calls), 2, "120 人拆成 2 批")
        self.assertTrue(all(len(c["useridlist"]) <= 100 for c in calls))
        self.assertTrue(all(c["endtime"] - c["starttime"] <= 30 * 86400 for c in calls), "单次跨度不超接口上限")
        self.assertEqual(len(out), 2)

    def test_api_failure_does_not_abort(self):
        class Cli(object):
            def call(self, path, payload=None, get=False, retry=2):
                raise RuntimeError("checkin/getcheckin_daydata 失败 errcode=60011 errmsg=no permission")

        prog = fc.Progress(os.path.join(self.dir, "st.json"))
        with contextlib.redirect_stdout(io.StringIO()):
            out = fc.fetch_daydata(Cli(), ["a"], datetime(2026, 8, 1), datetime(2026, 8, 3), prog)
        self.assertEqual(out, [], "日报取不到时返回空，看板退回按记录推算")
        with open(os.path.join(self.dir, "st.json"), encoding="utf-8") as f:
            self.assertIn("可调用接口的应用", json.load(f)["errors"][0])


class TestSaveDataset(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self._dir = fc.DATA_DIR
        fc.DATA_DIR = self.dir

    def tearDown(self):
        fc.DATA_DIR = self._dir
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_writes_json_and_csv(self):
        users = {"a": {"userid": "a", "name": "甲", "main_dept": "研发部", "dept_names": ["示例科技/研发部"]}}
        rec = fc.norm_record({"userid": "a", "checkin_type": "上班打卡", "checkin_time": ts("2026-08-03", 9, 30),
                              "lat": 22540000, "lng": 113934000, "location_title": "腾讯大厦",
                              "notes": "备注,含逗号", "mediaids": []}, users)
        day = fc.norm_daily({"base_info": {"acctid": "a", "date": ts("2026-08-03"), "departs_name": "研发部"},
                             "summary_info": {"regular_work_sec": 28800},
                             "exception_infos": [{"exception": 1, "count": 2, "duration": 600}]}, users)
        fc.save_dataset({"meta": {"start": "2026-08-03", "end": "2026-08-03", "record_count": 1,
                                  "daily_count": 1}, "users": [], "records": [rec],
                         "daily": [day], "monthly": [], "rules": []})
        with open(os.path.join(self.dir, "checkin_data.json"), encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["meta"]["record_count"], 1)

        def read_csv(name):
            with open(os.path.join(self.dir, name), encoding="utf-8-sig") as f:
                lines = [ln.rstrip("\r\n") for ln in f]
            return lines

        rec_csv = read_csv("checkin_records.csv")
        self.assertIn("location_title", rec_csv[0])
        self.assertEqual(len(rec_csv), 2, "1 条记录 + 表头")
        self.assertIn('"备注,含逗号"', rec_csv[1], "含逗号的字段有引号包裹，Excel 不会拆列")
        daily_csv = read_csv("checkin_daily.csv")
        self.assertIn("迟到次数", daily_csv[0])
        cols = [c.strip() for c in daily_csv[0].split(",")]
        row = dict(zip(cols, [c.strip() for c in daily_csv[1].split(",")]))
        self.assertEqual(row["迟到次数"], "2")
        self.assertEqual(row["name"], "甲")
        self.assertEqual(len(cols), len(fc.DAILY_CSV_FIELDS), "日报 CSV 列数与表头一致")

    def test_empty_sections_skip_csv(self):
        fc.save_dataset({"meta": {}, "users": [], "records": [], "daily": [], "monthly": [], "rules": []})
        self.assertTrue(os.path.exists(os.path.join(self.dir, "checkin_data.json")))
        self.assertTrue(os.path.exists(os.path.join(self.dir, "checkin_records.csv")), "空快照写出仅表头CSV，不能残留旧记录")

    def test_load_existing_tolerates_corruption(self):
        p = os.path.join(self.dir, "checkin_data.json")
        self.assertIsNone(fc.load_existing(p))
        with open(p, "w", encoding="utf-8") as f:
            f.write("{not json")
        self.assertIsNone(fc.load_existing(p))
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"meta": {}}, f)
        self.assertIsNone(fc.load_existing(p), "缺 records 的半截文件不当作可用历史")
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"meta": {}, "records": [{"userid": "a"}]}, f)
        self.assertEqual(len(fc.load_existing(p)["records"]), 1)


class TestHttpApi(unittest.TestCase):
    """本地服务：真实起一个临时端口的 server，打真实 HTTP 请求。"""

    USERS = {"a": {"userid": "a", "name": "甲", "main_dept": "研发部", "dept_names": ["示例科技/研发部"]}}

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        rec = fc.norm_record({"userid": "a", "checkin_type": "上班打卡", "checkin_time": ts("2026-08-03", 9, 30),
                              "lat": 22540000, "lng": 113934000, "location_title": "腾讯大厦",
                              "wifiname": "office", "notes": "备注", "wifimac": "aa:bb"}, cls.USERS)
        rec2 = fc.norm_record({"userid": "a", "checkin_type": "外出打卡", "checkin_time": ts("2026-08-04", 11, 0),
                               "lat": 22540000, "lng": 113934000, "location_title": "客户现场"}, cls.USERS)
        day = fc.norm_daily({"base_info": {"acctid": "a", "date": ts("2026-08-03"), "departs_name": "研发部",
                                           "rule_info": {"groupname": "固定班",
                                                         "checkintime": [{"work_sec": 32400, "off_work_sec": 64800}]}},
                             "summary_info": {"regular_work_sec": 28800},
                             "exception_infos": [{"exception": 1, "count": 2, "duration": 600}],
                             "sp_items": [{"name": "外勤", "type": 100, "count": 3, "duration": 7200, "time_type": 1}]}, {})
        cls.dataset = {"meta": {"source": "test", "demo": False, "start": "2026-08-03", "end": "2026-08-04",
                                "users": 1, "record_count": 2, "daily_count": 1, "monthly_count": 0,
                                "rule_count": 0, "api_calls": 0},
                       "users": [{"userid": "a", "name": "甲", "main_dept": "研发部", "dept_names": ["研发部"]}],
                       "records": [rec, rec2], "daily": [day], "monthly": [], "rules": []}
        cls._cache = dict(server_mod._CACHE)
        cls._paths = (server_mod.DATA, server_mod.DATASET, server_mod.STATUS)
        server_mod.DATA = cls.dir
        server_mod.DATASET = os.path.join(cls.dir, "checkin_data.json")
        server_mod.STATUS = os.path.join(cls.dir, "fetch_status.json")
        server_mod._CACHE.update(path=None, mtime=0, data=None)
        with open(server_mod.DATASET, "w", encoding="utf-8") as f:
            json.dump(cls.dataset, f, ensure_ascii=False)
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), server_mod.Handler)
        cls.base = "http://127.0.0.1:%d" % cls.srv.server_address[1]
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        (server_mod.DATA, server_mod.DATASET, server_mod.STATUS) = cls._paths
        server_mod._CACHE.clear()
        server_mod._CACHE.update(cls._cache)
        shutil.rmtree(cls.dir, ignore_errors=True)

    def get(self, path, headers=None, raw=False):
        req = urllib.request.Request(self.base + path, headers=headers or {})
        try:
            resp = urllib.request.urlopen(req, timeout=10)
            body, encoding = resp.read(), resp.headers.get("Content-Encoding")
            headers_out, status = dict(resp.headers), resp.status
            resp.close()
        except urllib.error.HTTPError as e:
            body = e.read()
            encoding, headers_out, status = e.headers.get("Content-Encoding"), dict(e.headers), e.code
            e.close()
        if encoding == "gzip":
            body = gzip.decompress(body)
        return status, headers_out, body if raw else body.decode("utf-8", "ignore")

    def post(self, path, obj):
        req = urllib.request.Request(self.base + path, data=json.dumps(obj).encode("utf-8"),
                                    headers={"Content-Type": "application/json"})
        try:
            r = urllib.request.urlopen(req, timeout=10)
            out = (r.status, json.loads(r.read().decode("utf-8")))
            r.close()
            return out
        except urllib.error.HTTPError as e:
            raw = e.read()
            e.close()
            try:
                return e.code, json.loads(raw.decode("utf-8"))
            except Exception:
                return e.code, {"raw": raw[:200].decode("utf-8", "ignore")}

    def test_index_served(self):
        status, _, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("企业微信打卡分析看板", body)
        self.assertIn("js/metrics.js", body)

    def test_meta(self):
        status, _, body = self.get("/api/meta")
        meta = json.loads(body)
        self.assertTrue(meta["ok"])
        self.assertEqual(meta["meta"]["record_count"], 2)
        self.assertFalse(meta["fetch"]["running"])

    def test_dataset_and_filters(self):
        status, _, body = self.get("/api/dataset")
        d = json.loads(body)
        self.assertTrue(d["ok"])
        self.assertEqual(len(d["data"]["records"]), 2)
        self.assertIn("notes", d["data"]["records"][0], "明细备注必须保留")
        self.assertNotIn("wifimac", d["data"]["records"][0])
        status, _, body = self.get("/api/dataset?start=2026-08-04")
        d = json.loads(body)
        self.assertEqual(len(d["data"]["records"]), 1)
        self.assertTrue(d["data"]["filtered"])
        status, _, body = self.get("/api/dataset?dept=" + urllib.parse.quote("研发部"))
        self.assertEqual(len(json.loads(body)["data"]["records"]), 2)
        status, _, body = self.get("/api/dataset?dept=" + urllib.parse.quote("不存在的部门"))
        self.assertEqual(len(json.loads(body)["data"]["records"]), 0)

    def test_export_csv(self):
        status, headers, body = self.get("/api/export?name=records")
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers.get("Content-Disposition", ""))
        self.assertTrue(body.startswith("\ufeff"), "带 BOM，Excel 中文不乱码")
        self.assertIn("location_title", body.split("\r\n")[0])
        self.assertIn("甲", body)
        status, _, body = self.get("/api/export?name=daily")
        self.assertIn("迟到次数", body.split("\r\n")[0])
        self.assertIn("研发部", body)
        self.assertIn("ot_sec", body.split("\r\n")[0])
        status, _, body = self.get("/api/export?name=nope")
        self.assertEqual(status, 404)
        self.assertIn("records", body, "报错说清只支持哪两种")

    def test_fetch_status_without_history(self):
        status, _, body = self.get("/api/fetch_status")
        st = json.loads(body)
        self.assertTrue(st["ok"])
        self.assertFalse(st["fetch"]["running"])

    def test_gzip_for_large_body(self):
        status, headers, body = self.get("/api/dataset", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Encoding"), "gzip")

    def test_static_assets_and_404(self):
        for path in ("/js/metrics.js", "/js/store.js", "/js/app.js", "/css/app.css"):
            status, _, _ = self.get(path)
            self.assertEqual(status, 200, path)
        status, _, _ = self.get("/nope-not-here.js")
        self.assertEqual(status, 404)

    def test_path_traversal_blocked(self):
        for path in ("/../server.py", "/..%2fserver.py", "/%2e%2e/fetch_checkin.py", "/../../etc/passwd"):
            status, _, body = self.get(path)
            self.assertIn(status, (403, 404), path)
            self.assertNotIn("WECOM_CORPSECRET", body, path)
            self.assertNotIn("root:x:", body, path)

    def test_head_request(self):
        req = urllib.request.Request(self.base + "/api/meta", method="HEAD")
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertEqual(r.status, 200)
            self.assertEqual(r.read(), b"")

    def test_fetch_requires_credentials(self):
        with patch.dict(os.environ, {"WECOM_CORPID": "", "WECOM_CORPSECRET": ""}), patch("os.path.exists", return_value=False):
            status, body = self.post("/api/fetch", {"start": "2026-08-01", "end": "2026-08-02"})
        self.assertEqual(status, 412)
        self.assertIn("未配置企业微信凭证", body["error"])

    def test_unknown_post_route(self):
        status, body = self.post("/api/nope", {})
        self.assertEqual(status, 404)

    def test_dataset_mtime_cache(self):
        self.get("/api/dataset")
        first = server_mod._CACHE["data"]
        self.get("/api/dataset")
        self.assertIs(server_mod._CACHE["data"], first, "同一 mtime 复用缓存")
        time.sleep(0.01)
        os.utime(server_mod.DATASET, (time.time() + 2, time.time() + 2))
        self.get("/api/dataset")
        self.assertIsNot(server_mod._CACHE["data"], first, "文件更新后缓存失效")


class TestDemoData(unittest.TestCase):
    """演示数据生成器输出的结构必须和真实接口一致，否则看板会错位。"""

    def test_demo_output_shape(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("make_demo_data",
                                                      os.path.join(ROOT, "tools", "make_demo_data.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        users = mod.make_users(6)
        days = mod.gen_days(datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=9), 10)
        raw = mod.gen_records(users, days)
        recs = [fc.norm_record(r, {u["userid"]: u for u in users}) for r in raw]
        self.assertTrue(recs)
        by_user = {}
        for r in recs:
            by_user.setdefault(r["userid"], []).append(r)
        daily = mod.build_daily(users, by_user)
        self.assertTrue(daily)
        for d in daily:
            self.assertEqual(sorted(d["exceptions"]), sorted(fc.EXCEPTION_CODE.values()))
            self.assertGreaterEqual(d["checkin_count"], 1)
            self.assertEqual(len(d["date"]), 10)
            self.assertLessEqual(d["std_work_min"], d["std_off_min"])
            self.assertTrue(all(isinstance(i, str) for i in d["holiday_titles"]))
        monthly = [{"base_info": {"acctid": users[0]["userid"], "date": daily[0]["month"] + "-28"},
                    "overwork_info": mod.demo_over([d for d in daily if d["userid"] == users[0]["userid"]])}]
        ow = monthly[0]["overwork_info"]
        for k in ("workday_over_sec", "restdays_over_sec", "workdays_over_as_vacation",
                  "workdays_over_as_money", "restdays_over_as_vacation", "restdays_over_as_money"):
            self.assertIn(k, ow)
        self.assertGreaterEqual(ow["workdays_over_as_vacation"] + ow["workdays_over_as_money"], 0)


class FakeWeComAPI(object):
    """假的企业微信接口：按官方返回结构给数据，用来跑通 fetch_checkin.main()。"""

    def __init__(self, users=None, fail_paths=()):
        self.users = users or ["emp001", "emp002"]
        self.calls = []
        self.fail_paths = set(fail_paths)

    def __call__(self, url, payload=None, timeout=30):
        path = url.split("?")[0].split("cgi-bin/", 1)[-1]
        self.calls.append((path, payload))
        if path in self.fail_paths:
            return {"errcode": 60011, "errmsg": "no permission"}
        if path == "gettoken":
            return {"errcode": 0, "access_token": "tok", "expires_in": 7200}
        if path == "department/list":
            return {"errcode": 0, "department": [{"id": 1, "name": "示例科技"}, {"id": 2, "name": "研发部"}]}
        if path == "user/list":
            return {"errcode": 0, "userlist": [{"userid": u, "name": "员工" + u[-1:], "department": [2],
                                                "status": 1, "name_en": ""} for u in self.users]}
        if path == "checkin/getcheckinoption":
            return {"errcode": 0, "info": [{"userid": uid,"group":{"groupid":7,"groupname":"固定上下班","grouptype":1,"checkindate":[{"workdays":[1,2,3,4,5],"checkintime":[{"work_sec":32400,"off_work_sec":64800}]}]}} for uid in payload['useridlist']]}
        if path == "oa/getapprovalinfo":
            return {"errcode": 0, "sp_no_list": []}
        start = datetime.fromtimestamp((payload or {}).get("starttime", 0))
        end = datetime.fromtimestamp((payload or {}).get("endtime", 0))
        ids = (payload or {}).get("useridlist") or self.users
        if path == "checkin/getcheckindata":
            data = []
            day = start.replace(hour=0, minute=0, second=0, microsecond=0)
            while day <= end:
                for uid in ids:
                    if day.weekday() >= 5:
                        continue
                    data.append({"userid": uid, "checkin_type": "上班打卡", "exception_type": "",
                                 "checkin_time": int(time.mktime(day.replace(hour=9, minute=5).timetuple())),
                                 "sch_checkin_time": 9 * 3600, "location_title": "腾讯大厦",
                                 "location_detail": "深圳市南山区", "lat": 22540000, "lng": 113934000,
                                 "wifiname": "office", "deviceid": "DEV-1", "groupname": "固定上下班"})
                    data.append({"userid": uid, "checkin_type": "下班打卡", "exception_type": "",
                                 "checkin_time": int(time.mktime(day.replace(hour=19, minute=20).timetuple())),
                                 "sch_checkin_time": 18 * 3600, "location_title": "腾讯大厦",
                                 "location_detail": "深圳市南山区", "lat": 22540000, "lng": 113934000,
                                 "wifiname": "office", "deviceid": "DEV-1", "groupname": "固定上下班"})
                day += timedelta(days=1)
            return {"errcode": 0, "checkindata": data}
        if path == "checkin/getcheckin_daydata":
            data = []
            day = start.replace(hour=0, minute=0, second=0, microsecond=0)
            while day <= end:
                for uid in ids:
                    if day.weekday() >= 5:
                        continue
                    late = day.day % 5 == 0
                    data.append({
                        "base_info": {"acctid": uid, "name": "员工" + uid[-1:], "departs_name": "示例科技/研发部",
                                      "date": int(time.mktime(day.timetuple())), "day_type": 0, "record_type": 1,
                                      "rule_info": {"groupname": "固定上下班",
                                                    "checkintime": [{"work_sec": 9 * 3600, "off_work_sec": 18 * 3600}]}},
                        "summary_info": {"checkin_count": 2, "regular_work_sec": 10 * 3600,
                                         "standard_work_sec": 8 * 3600, "earliest_time": 9 * 3600,
                                         "lastest_time": 19 * 3600 + 20 * 60},
                        "exception_infos": [{"exception": 1, "count": 1 if late else 0, "duration": 300 if late else 0}],
                        "ot_info": {"ot_status": 1, "ot_duration": 5400}})
                day += timedelta(days=1)
            return {"errcode": 0, "datas": data}
        if path == "checkin/getcheckin_monthdata":
            return {"errcode": 0, "datas": [{"base_info": {"acctid": uid, "name": "员工" + uid[-1:],
                                                           "date": end.strftime("%Y-%m") + "-28"},
                                             "summary_info": {"regular_work_sec": 8 * 3600 * 20},
                                             "overwork_info": {"workday_over_sec": 3600 * 10}} for uid in ids]}
        return {"errcode": -1, "errmsg": "未知接口 %s" % path}


class TestEndToEndFetch(unittest.TestCase):
    """跑整条抓取链路 + 增量合并（假接口，不联网）。"""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self._data, self._http = fc.DATA_DIR, fc.http_json
        fc.DATA_DIR = self.dir
        fc.RATE_SLEEP = 0

    def tearDown(self):
        fc.DATA_DIR, fc.http_json = self._data, self._http
        fc.RATE_SLEEP = 0.22
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_fetch(self, start, end, extra=()):
        api = FakeWeComAPI()
        fc.http_json = api
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            fc.main(["--corpid", "wwfake", "--corpsecret", "s", "--start", start, "--end", end,
                     "--status-file", os.path.join(self.dir, "status.json")] + list(extra))
        data = read_json(os.path.join(self.dir, "checkin_data.json"))
        status = read_json(os.path.join(self.dir, "status.json"))
        return data, status, api, buf.getvalue()

    def test_two_windows_accumulate(self):
        first, st1, api1, log1 = self.run_fetch("2026-08-01", "2026-08-07")
        self.assertEqual(first["meta"]["record_count"], 2 * 5 * 2, "5 个工作日 × 2 人 × 2 次卡")
        self.assertEqual(first["meta"]["start"], "2026-08-01")
        self.assertFalse(st1["running"], "跑完要把 running 置回 false，否则前端永远转圈")
        self.assertEqual(st1["step"], "完成")
        self.assertEqual(sorted(u["userid"] for u in first["users"]), ["emp001", "emp002"])
        self.assertIn("checkin/getcheckindata", [c[0] for c in api1.calls])

        second, st2, _, log2 = self.run_fetch("2026-08-10", "2026-08-14")
        self.assertEqual(second["meta"]["record_count"], 40, "新两周 + 上一周都还在")
        self.assertEqual(second["meta"]["start"], "2026-08-01", "区间向前延伸")
        self.assertEqual(second["meta"]["end"], "2026-08-14")
        self.assertEqual(second["meta"]["merge"]["kept_records"], 20)
        self.assertEqual(len({r["date"] for r in second["records"]}), 10, "10 个打卡日")
        self.assertEqual(len(second["daily"]), 20, "日报也累加")
        self.assertEqual(len(second["meta"]["fetch_history"]), 2, "留下每次抓取的痕迹")
        self.assertIn("增量合并", log2)

    def test_refetch_same_window_is_idempotent(self):
        a, _, _, _ = self.run_fetch("2026-08-01", "2026-08-07")
        b, _, _, _ = self.run_fetch("2026-08-01", "2026-08-07")
        self.assertEqual(a["meta"]["record_count"], b["meta"]["record_count"])
        keys = [(r["userid"], r["ts"]) for r in b["records"]]
        self.assertEqual(len(keys), len(set(keys)), "重拉同一区间不产生重复记录")
        self.assertEqual(len(b["daily"]), len({(d["userid"], d["date"]) for d in b["daily"]}))

    def test_no_merge_flag_overwrites(self):
        self.run_fetch("2026-08-01", "2026-08-07")
        data, _, _, log = self.run_fetch("2026-08-10", "2026-08-14", extra=["--no-merge"])
        self.assertEqual(data["meta"]["record_count"], 20, "--no-merge 直接用本次区间")
        self.assertNotIn("merge", data["meta"])
        self.assertNotIn("增量合并", log)

    def test_real_fetch_over_demo_data_does_not_index_merge_message(self):
        demo = {"meta": {"source": "demo", "demo": True, "start": "2026-08-01", "end": "2026-08-02",
                          "record_count": 1, "daily_count": 0, "monthly_count": 0, "rule_count": 0,
                          "users": 0},
                "users": [], "records": [{"userid": "demo", "date": "2026-08-01", "ts": 1, "name": "demo"}],
                "daily": [], "monthly": [], "rules": []}
        fc.save_dataset(demo)
        data, status, _, log = self.run_fetch("2026-08-03", "2026-08-05")
        self.assertEqual(data["meta"]["source"], "wecom_api")
        self.assertFalse(status["running"])
        self.assertNotIn("TypeError", log)
        self.assertIn("演示数据不参与增量合并", log)

    def test_partial_failure_keeps_other_data_and_reports_hint(self):
        api = FakeWeComAPI(fail_paths=["checkin/getcheckin_daydata"])
        fc.http_json = api
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            fc.main(["--corpid", "wwfake", "--corpsecret", "s", "--start", "2026-08-03",
                     "--end", "2026-08-05", "--status-file", os.path.join(self.dir, "status.json")])
        data = read_json(os.path.join(self.dir, "checkin_data.json"))
        status = read_json(os.path.join(self.dir, "status.json"))
        self.assertGreater(data["meta"]["record_count"], 0, "日报失败不影响打卡记录入库")
        self.assertEqual(data["meta"]["daily_count"], 0)
        self.assertFalse(status["running"])
        self.assertIn("可调用接口的应用", " ".join(status["errors"]), "进度文件里带上权限排查建议")

    def test_contact_permission_failure_is_explicit(self):
        fc.http_json = FakeWeComAPI(fail_paths=["department/list", "user/list_id"])
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError) as cm:
                fc.main(["--corpid", "wwfake", "--corpsecret", "s", "--start", "2026-08-03",
                         "--end", "2026-08-05", "--status-file", os.path.join(self.dir, "status.json")])
        self.assertIn("userid", str(cm.exception))
        status = read_json(os.path.join(self.dir, "status.json"))
        self.assertIn("userid", " ".join(status["errors"]))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "checkin_data.json")))

    def test_no_credentials_exits(self):
        with contextlib.redirect_stdout(io.StringIO()), patch.dict(os.environ, {"WECOM_CORPID": "", "WECOM_CORPSECRET": ""}), patch("os.path.exists", return_value=False):
            with self.assertRaises(SystemExit) as cm:
                fc.main(["--start", "2026-08-01", "--end", "2026-08-02"])
        self.assertIn("缺少凭证", str(cm.exception.code))

    def test_range_too_long_rejected(self):
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                fc.main(["--corpid", "ww", "--corpsecret", "s", "--start", "2026-01-01",
                         "--end", "2026-08-28"])
        self.assertIn("92", str(cm.exception.code))


if __name__ == "__main__":
    unittest.main(verbosity=2)

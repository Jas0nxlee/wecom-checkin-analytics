#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成演示数据（无企业微信凭证时预览看板效果用），输出结构与 fetch_checkin.py 完全一致。
数据是随机合成的，不是任何真实员工数据。

  python3 tools/make_demo_data.py --days 60
"""
import argparse
import json
import math
import os
import random
import sys
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import fetch_checkin as fc  # noqa: E402  复用规整化/保存逻辑

random.seed(20260829)

OFFICES = [
    {"name": "腾讯大厦（总部）", "detail": "深圳市南山区高新区科技中一路腾讯大厦", "lat": 22.5400, "lng": 113.9340, "wifi": "腾讯办公区-5G", "wmac": "3c:46:d8:0c:7a:70", "share": 0.62},
    {"name": "科兴科学园 B 座", "detail": "深圳市南山区科苑南路科兴科学园B栋", "lat": 22.5290, "lng": 113.9430, "wifi": "科兴办公区", "wmac": "3c:46:d8:0c:7a:71", "share": 0.16},
    {"name": "成都天府软件园 D4", "detail": "成都市武侯区益州大道中段天府软件园D4区", "lat": 30.5476, "lng": 104.0632, "wifi": "成都办公区", "wmac": "3c:46:d8:0c:7a:72", "share": 0.14},
]
FIELD_CITIES = [
    ("广州珠江新城财富大厦", "广州市天河区珠江东路", 23.1200, 113.3200),
    ("上海陆家嘴金融中心", "上海市浦东新区世纪大道", 31.2400, 121.5000),
    ("杭州未来科技城", "杭州市余杭区文一西路", 30.2800, 120.0200),
    ("北京望京SOHO", "北京市朝阳区望京街", 40.0000, 116.4800),
    ("东莞松山湖工厂", "东莞市松山湖高新产业园", 22.9200, 113.9000),
    ("武汉光谷软件园", "武汉市东湖高新区关山大道", 30.5000, 114.4200),
]
DEPTS = ["产品研发部", "市场与销售部", "客户成功部", "供应链与制造部", "职能中台"]
SURNAMES = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦许何吕施张孔曹严华金魏陶姜"
GIVEN = ["伟", "芳", "娜", "敏", "静", "磊", "洋", "勇", "艳", "杰", "涛", "明", "超", "秀英", "霞", "平", "刚", "桂英", "文博", "晨", "子墨", "浩然", "雨桐", "思远"]


def make_users(n):
    users, used = [], set()
    for i in range(n):
        while True:
            nm = random.choice(SURNAMES) + random.choice(GIVEN)
            if nm not in used:
                used.add(nm)
                break
        dept = random.choices(DEPTS, weights=[0.28, 0.22, 0.18, 0.17, 0.15])[0]
        users.append({"userid": "emp%03d" % (i + 1), "name": nm, "en_name": "",
                      "position": random.choice(["工程师", "高级工程师", "专员", "经理", "主管", "总监"]),
                      "dept_ids": [i % 5 + 2], "dept_names": ["%s/%s" % ("示例科技", dept)], "main_dept": dept})
    return users


def work_minutes(u):
    """不同部门的制度班次（标准上下班，单位=距 0 点分钟）。"""
    return {"产品研发部": (570, 1080), "市场与销售部": (540, 1080), "客户成功部": (540, 1260),
            "供应链与制造部": (480, 1020), "职能中台": (540, 1050)}.get(u["main_dept"], (540, 1080))


def pick_office():
    r = random.random()
    acc = 0.0
    for o in OFFICES:
        acc += o["share"]
        if r <= acc:
            return o
    return OFFICES[0]


def jitter(v, n=0.004):
    return round(v + random.gauss(0, n), 6)


def fmt(day, minute):
    return "%02d:%02d" % (minute // 60, minute % 60)


def one_record(u, dt, ctype, place, sch_minute, exception="", notes="", device=None, wifi=None):
    r = {
        "userid": u["userid"], "groupname": "示例-固定上下班", "checkin_type": ctype,
        "exception_type": exception, "checkin_time": int(dt.timestamp()),
        "location_title": place[0], "location_detail": place[1],
        "wifiname": wifi or "", "wifimac": "", "notes": notes,
        "lat": int(place[2] * 1000000), "lng": int(place[3] * 1000000),
        "deviceid": device or u["device"], "sch_checkin_time": int(sch_minute * 60),
        "groupid": 10, "schedule_id": 0, "timeline_id": 1,
    }
    return r


def gen_days(start, days):
    out, d = [], start
    for i in range(days):
        out.append(d)
        d = d + timedelta(days=1)
    return out

def gen_records(users, days):
    """按人按天合成打卡记录：到岗、外出、下班，含迟到/早退/缺卡/地点异常/设备异常。"""
    raw = []
    for u in users:
        u["device"] = "DEV-%s" % random.choice(["iPhone15", "iPhone14", "Mate60", "X100", "iPad", "Android"])
        u["home"] = random.choice(FIELD_CITIES) if random.random() < 0.18 else None
        u["risk"] = random.random()                      # 高风险人群（迟到多）
        u["workload"] = random.random()                  # 加班强度
        u["base_office"] = pick_office()
        std_in, std_out = work_minutes(u)
        for day in days:
            wd = day.weekday()
            if wd >= 5 and random.random() > (0.10 + 0.25 * u["workload"]):
                continue                                  # 周末多数人不来
            roll = random.random()
            if roll < 0.035:                              # 整天无记录（缺卡/请假）
                continue
            office = u["base_office"] if random.random() < 0.9 else pick_office()
            # GPS 漂移：同一地点每次打卡坐标有 30~200m 抖动，贴近真实定位
            off_loc = (office["name"], office["detail"], jitter(office["lat"], 0.0012), jitter(office["lng"], 0.0012))
            wifi, wmac = office["wifi"], office["wmac"]
            # 到岗时间：多数人落在标准时间前 25 分钟内，高风险人群明显右移
            if u["risk"] > 0.82:
                arrive = std_in + int(random.gauss(11, 12))
            else:
                arrive = std_in + int(random.gauss(-9, 8))
            arrive = max(6 * 60, min(13 * 60, arrive))
            late = arrive > std_in + 1
            morning_exc = ""
            if late:
                morning_exc = "时间异常"
            if random.random() < 0.02:
                morning_exc = (morning_exc + ";" if morning_exc else "") + "地点异常"
                off_loc = (off_loc[0] + "附近", off_loc[1], off_loc[2] + random.uniform(-0.02, 0.02),
                           off_loc[3] + random.uniform(-0.02, 0.02))
            dev = u["device"]
            if random.random() < 0.015:
                dev = "DEV-未知设备"
                morning_exc = (morning_exc + ";" if morning_exc else "") + "非常用设备"
            if random.random() < 0.02:                    # WiFi 打卡（无经纬度）
                m_ts = day.timestamp() + arrive * 60
                raw.append({"userid": u["userid"], "groupname": "示例-固定上下班", "checkin_type": "上班打卡",
                            "exception_type": morning_exc, "checkin_time": int(m_ts),
                            "location_title": "%s（WiFi定位）" % office["name"], "location_detail": office["detail"],
                            "wifiname": wifi, "wifimac": wmac, "notes": "", "deviceid": dev,
                            "sch_checkin_time": std_in * 60, "groupid": 10, "schedule_id": 0, "timeline_id": 1})
            else:
                m_dt = day + timedelta(minutes=arrive)
                raw.append(one_record(u, m_dt, "上班打卡", off_loc, std_in, morning_exc,
                                      "路上堵车" if (late and random.random() < 0.35) else "", dev, wifi))
            # 外出（外勤）打卡
            n_out = 0
            if u["main_dept"] in ("市场与销售部", "客户成功部"):
                n_out = int(random.random() < 0.45) + (1 if random.random() < 0.12 else 0)
            elif random.random() < 0.08:
                n_out = 1
            for _ in range(n_out):
                city = random.choice(FIELD_CITIES)
                place = (city[0], city[1], jitter(city[2], 0.01), jitter(city[3], 0.01))
                t = day + timedelta(minutes=random.randint(9 * 60, 17 * 60))
                exc = "时间异常" if random.random() < 0.05 else ""
                raw.append(one_record(u, t, "外出打卡", place, arrive + 240, exc,
                                      random.choice(["拜访客户", "门店巡检", "项目现场支持", ""]),
                                      dev, ""))
            # 下班
            if random.random() < 0.03:                    # 忘打下班卡
                continue
            extra = int(random.expovariate(1 / (35 + 150 * u["workload"])))
            leave = std_out + extra + (0 if wd < 5 else 60)
            leave = min(leave, 23 * 60 + 40)
            early = leave < std_out - 1
            if random.random() < 0.07:                      # 早退
                leave = std_out - random.randint(4, 55)
                early = True
            e_exc = "时间异常" if early else ""
            if random.random() < 0.015:
                e_exc = (e_exc + ";" if e_exc else "") + "地点异常"
            e_dt = day + timedelta(minutes=leave)
            raw.append(one_record(u, e_dt, "下班打卡", off_loc, std_out, e_exc, "", dev, wifi))
    raw.sort(key=lambda r: r["checkin_time"])
    return raw


def demo_sp(u, date, outside_n):
    """构造日报 sp_items：请假/补卡/出差/外勤（真实数据由审批-假期接口返回）。"""
    items = []
    if outside_n:
        items.append({"name": "外勤次数", "type": "外勤", "count": outside_n, "hours": 0})
    r = random.random()
    if r < 0.05:
        items.append({"name": "年假", "type": "请假", "count": 1, "hours": 8})
    elif r < 0.09:
        items.append({"name": "事假", "type": "请假", "count": 1, "hours": 4})
    elif r < 0.115:
        items.append({"name": "病假", "type": "请假", "count": 1, "hours": 4})
    elif r < 0.13:
        items.append({"name": "出差", "type": "出差", "count": 1, "hours": 24})
    elif r < 0.15:
        items.append({"name": "补卡", "type": "补卡", "count": 1, "hours": 0})
    return items


def build_daily(users, records_by_user):
    """按 fetch_checkin.norm_daily 的输出结构合成日报（迟到/早退/缺卡/旷工/加班）。"""
    daily = []
    for u in users:
        std_in, std_out = work_minutes(u)
        recs = records_by_user.get(u["userid"], [])
        by_date = {}
        for r in recs:
            by_date.setdefault(r["date"], []).append(r)
        for date, rs in sorted(by_date.items()):
            rs.sort(key=lambda x: x["ts"])
            first, last = rs[0], rs[-1]
            mins = [r["minute_of_day"] for r in rs if r["minute_of_day"] is not None]
            late_n = sum(1 for r in rs if r["type"] == "上班打卡" and "时间异常" in r["exception"])
            early_n = sum(1 for r in rs if r["type"] == "下班打卡" and "时间异常" in r["exception"])
            late_sec = sum(max(0, r["minute_of_day"] - std_in) * 60 for r in rs
                           if r["type"] == "上班打卡" and "时间异常" in r["exception"] and std_in)
            early_sec = sum(max(0, std_out - r["minute_of_day"]) * 60 for r in rs
                            if r["type"] == "下班打卡" and "时间异常" in r["exception"] and std_out)
            absent_n = 1 if random.random() < 0.008 else 0     # 旷工（真实数据由接口 exception 返回）
            place_exc = sum(1 for r in rs if "地点异常" in r["exception"])
            dev_exc = sum(1 for r in rs if "非常用设备" in r["exception"])
            outside_n = sum(1 for r in rs if r["type"] == "外出打卡")
            has_morning = any(r["type"] == "上班打卡" for r in rs)
            has_evening = any(r["type"] == "下班打卡" for r in rs)
            miss_n = (0 if has_morning else 1) + (0 if has_evening else 1)
            span = (max(mins) - min(mins)) * 60 if len(mins) > 1 else 0
            actual = max(0, span - 3600) if span else 0
            ot = max(0, (last["minute_of_day"] or 0) - std_out) * 60 if last["type"] == "下班打卡" else 0
            daily.append({
                "userid": u["userid"], "name": u["name"], "dept": u["main_dept"],
                "dept_names": u["dept_names"], "date": date, "month": date[:7],
                "weekday": datetime.strptime(date, "%Y-%m-%d").weekday(),
                "week": "%s-W%02d" % (date[:4], datetime.strptime(date, "%Y-%m-%d").isocalendar()[1]),
                "day_type": 1 if datetime.strptime(date, "%Y-%m-%d").weekday() >= 5 else 0,
                "record_type": 1, "groupname": "示例-固定上下班",
                "std_work_min": std_in, "std_off_min": std_out,
                "checkin_count": len(rs), "actual_work_sec": actual,
                "standard_work_sec": (std_out - std_in - 60) * 60,
                "earliest_min": min(mins) if mins else 0, "lastest_min": max(mins) if mins else 0,
                "exceptions": {"迟到": {"count": late_n, "duration": late_sec},
                               "早退": {"count": early_n, "duration": early_sec},
                               "缺卡": {"count": miss_n, "duration": 0},
                               "旷工": {"count": absent_n, "duration": absent_n * 8 * 3600},
                               "地点异常": {"count": place_exc, "duration": 0},
                               "设备异常": {"count": dev_exc, "duration": 0}},
                "ot_status": 1 if ot else 0, "ot_sec": ot,
                "sp_items": demo_sp(u, date, outside_n),
                "holiday_titles": [],
                "miss_total": miss_n,
            })
    return daily


def demo_over(mr):
    """构造月报 overwork_info：工作日/休息日加班与调休、加班费去向（day_type 0=工作日）。"""
    wd_ot = sum(d["ot_sec"] for d in mr if d["day_type"] == 0)
    rd_ot = sum(d["ot_sec"] for d in mr if d["day_type"] != 0)
    return {"workday_over_sec": wd_ot, "restdays_over_sec": rd_ot, "holidays_over_sec": 0,
            "workdays_over_as_vacation": int(wd_ot * 0.6), "workdays_over_as_money": int(wd_ot * 0.4),
            "restdays_over_as_vacation": int(rd_ot * 0.5), "restdays_over_as_money": int(rd_ot * 0.5),
            "holidays_over_as_vacation": 0, "holidays_over_as_money": 0}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--users", type=int, default=68)
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "checkin_data.json"))
    args = ap.parse_args()

    end = datetime.now() - timedelta(days=1)
    start = end - timedelta(days=args.days - 1)
    days = gen_days(start.replace(hour=0, minute=0, second=0, microsecond=0), args.days)
    users = make_users(args.users)
    raw = gen_records(users, days)
    records = [fc.norm_record(r, {u["userid"]: u for u in users}) for r in raw]
    by_user = {}
    for r in records:
        by_user.setdefault(r["userid"], []).append(r)
    daily = build_daily(users, by_user)

    monthly = []
    for u in users:
        rows = [d for d in daily if d["userid"] == u["userid"]]
        if not rows:
            continue
        for month in sorted({d["month"] for d in rows}):
            mr = [d for d in rows if d["month"] == month]
            exc = {}
            for d in mr:
                for k, v in d["exceptions"].items():
                    e = exc.setdefault(k, {"count": 0, "duration": 0})
                    e["count"] += v["count"]
                    e["duration"] += v["duration"]
            monthly.append({"base_info": {"acctid": u["userid"], "name": u["name"],
                                          "departs_name": ";".join(u["dept_names"]),
                                          "rule_info": {"groupid": 10, "groupname": "示例-固定上下班"}},
                            "summary_info": {"work_days": len(mr), "regular_days": len(mr) - sum(
                                1 for d in mr if d["exceptions"].get("缺卡", {}).get("count")),
                                "rest_days": 0, "except_days": sum(1 for d in mr if d["exceptions"].get("缺卡", {}).get("count")),
                                "regular_work_sec": sum(d["actual_work_sec"] for d in mr),
                                "standard_work_sec": sum(d["standard_work_sec"] for d in mr)},
                            "exception_infos": [{"exception": k, "count": v["count"], "duration": v["duration"]}
                                                for k, v in exc.items()],
                            "sp_items": [],
                            "overwork_info": demo_over(mr)})
    rules = [{"groupid": 10, "groupname": "示例-固定上下班", "groupid_checkin_time": [
        {"work_time": [{"normal_time": 540, "time_type": 0, "check_before": 120, "check_after": 120}],
         "off_work_time": [{"normal_time": 1080, "time_type": 1, "check_before": 120, "check_after": 240}]}]}]
    payload = {
        "meta": {"source": "demo", "demo": True,
                 "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                 "start": start.strftime("%Y-%m-%d"), "end": end.strftime("%Y-%m-%d"),
                 "users": len(users), "record_count": len(records), "daily_count": len(daily),
                 "monthly_count": len(monthly), "rule_count": len(rules), "api_calls": 0,
                 "warnings": ["当前为合成演示数据（tools/make_demo_data.py 生成），非真实员工数据"]},
        "users": users, "records": records, "daily": daily, "monthly": monthly, "rules": rules,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    fc.save_dataset(payload)
    print("演示数据：%d 人 / %d 条打卡记录 / %d 条日报 -> %s"
          % (len(users), len(records), len(daily), args.out))


if __name__ == "__main__":
    main()

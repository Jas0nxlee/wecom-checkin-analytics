"""企业微信排班与审批的最小只读投影，不保存审批正文和附件。"""
from datetime import datetime, timedelta, timezone
import re

TZ = timezone(timedelta(hours=8))
POLICY = {"version": 3, "roster": "all_except_excluded_departments", "department": "current",
          "excluded_departments": ["其他人员", "辅助账号", "董事长", "总经办"],
          "zero_work_is_zero": True, "overtime_start_min": 1140,
          "correction_window": "current_month", "correction_scope": "whole_result",
          "timezone": "Asia/Shanghai"}
APPROVAL_STATUS = {1: "pending", 2: "approved", 3: "rejected", 4: "withdrawn",
                   6: "revoked", 7: "deleted", 10: "approved"}


def department_excluded(*values):
    """精确匹配当前部门或部门路径，不将相似名称误排除。"""
    for value in values:
        items = value if isinstance(value, (list, tuple)) else [value]
        for item in items:
            if any(part.strip() in POLICY["excluded_departments"] for part in re.split(r"[/;；\\]", str(item or ""))):
                return True
    return False


def apply_attendance_scope(data):
    """分析/导出统一投影。原始JSON全量保留，不删除历史或审批资料。"""
    original_meta = data.get("meta", {})
    if original_meta.get("scope_applied") and original_meta.get("policy", {}).get("excluded_departments") == POLICY["excluded_departments"]:
        return data
    users = data.get("users", [])
    roster = {u.get("userid"): u for u in users}
    excluded = {uid for uid, u in roster.items() if department_excluded(u.get("main_dept"), u.get("dept_names"))}

    def keep(row):
        base = row.get("base_info") or {}
        uid = row.get("userid") or base.get("acctid")
        if uid in roster:
            return uid not in excluded  # 已调岗员工按当前组织关系，不按历史行的旧部门排除。
        return not department_excluded(row.get("dept"), row.get("dept_names"), base.get("departs_name"))

    result = dict(data)
    result["users"] = [u for u in users if u.get("userid") not in excluded]
    for section in ("records", "records_slim", "daily", "monthly", "rules", "approvals"):
        if section in data:
            result[section] = [row for row in data[section] if keep(row)]
            if section in ("records", "records_slim", "daily"):
                result[section] = [dict(row, dept=(roster.get(row.get("userid")) or {}).get("main_dept") or row.get("dept", "未分组"),
                                        name=(roster.get(row.get("userid")) or {}).get("name") or row.get("name"))
                                   for row in result[section]]
    meta = dict(original_meta)
    meta.update(policy=dict(POLICY), scope_applied=True, users=len(result["users"]),
                source_users=len(users), excluded_users=len(excluded),
                source_counts={s: len(data.get(s, [])) for s in ("records", "daily", "monthly", "rules", "approvals")})
    for section, field in (("records", "record_count"), ("daily", "daily_count"), ("monthly", "monthly_count"), ("rules", "rule_count"), ("approvals", "approval_count")):
        meta[field] = len(result.get(section, []))
    if "requested_users" in meta:
        meta["requested_users"] = [uid for uid in meta["requested_users"] if uid not in excluded]
    if "coverage" in meta:
        meta["coverage"] = {section: [dict(w, users=[uid for uid in w.get("users", []) if uid not in excluded]) for w in windows]
                            for section, windows in meta["coverage"].items()}
    result["meta"] = meta
    return result


def stamp_date(value):
    try:
        return datetime.fromtimestamp(int(value), TZ).strftime("%Y-%m-%d") if value else ""
    except (TypeError, ValueError, OverflowError):
        return ""


def segments(values):
    result = []
    for value in values if isinstance(values, list) else []:
        if not isinstance(value, dict) or value.get("work_sec") is None:
            continue
        start = int(value["work_sec"])
        end = int(value.get("off_work_sec", value.get("offwork_sec", 0)))
        if end < start:
            end += 86400
        result.append({"work_sec": start, "off_work_sec": end})
    return sorted(result, key=lambda x: x["work_sec"])


def rule_day(item, date):
    """按日接口规则投影。缺失规则不猜成周一至周五。"""
    group = item.get("group") or {}
    out = {"userid": item.get("userid"), "date": date, "groupid": group.get("groupid"), "grouptype": group.get("grouptype"),
           "groupname": group.get("groupname", ""), "expected": None,
           "source": "wecom_rule", "segments": [], "reason": "未返回有效规则",
           "locations": [{k: loc.get(k) for k in ("lat", "lng", "loc_title", "loc_detail", "distance")}
                         for loc in group.get("loc_infos", []) if isinstance(loc, dict)]}
    if not group:
        return out
    for special in group.get("spe_offdays", []):
        if stamp_date(special.get("timestamp")) == date:
            return dict(out, expected=False, reason="企业微信特殊休息日")
    for special in group.get("spe_workdays", []):
        if stamp_date(special.get("timestamp")) == date:
            return dict(out, expected=True, segments=segments(special.get("checkintime")), reason="企业微信调班工作日")
    day = datetime.strptime(date, "%Y-%m-%d")
    weekday = (day.weekday() + 1) % 7
    configs = group.get("checkindate") or []
    matched = []
    has_schedule = False
    for config in configs:
        workdays = config.get("workdays")
        biweekly = config.get("biweekly") or {}
        if biweekly.get("enable_weekday_recurrence"):
            odd = ((day - datetime(2024, 1, 1)).days // 7 + 1) % 2 == 1
            workdays = biweekly.get("odd_workdays" if odd else "even_workdays")
        if workdays is None:
            continue
        has_schedule = True
        if group.get("grouptype") == 2:
            hit = any(stamp_date(x) == date or str(x) in (date, date.replace("-", "")) for x in workdays)
        else:
            hit = weekday in workdays
        if hit:
            matched.extend(segments(config.get("checkintime")))
    # sync_holidays仅表明自动节假日开关，不能凭空提供某天的日历结果。
    # 由同日day_type覆盖；无日报时明确保留未核定，避免假造法定节假日。
    if group.get("sync_holidays"):
        return dict(out, segments=matched, reason="自动节假日需同日日报确认")
    if has_schedule:
        return dict(out, expected=bool(matched) if group.get("grouptype") == 2 else any(
            weekday in (c.get("workdays") or []) for c in configs) if not any(c.get("biweekly") for c in configs) else bool(matched),
                    segments=matched, reason="企业微信当日规则")
    return out


def fetch_shift_calendar(cli, userids, start, end):
    """仅排班制人员使用此接口；休息班次是明确False，不返回日期仍是未知。"""
    import time
    rows = []
    cursor = start.replace(day=1)
    while cursor <= end:
        next_month = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)
        first, last = max(start, cursor), min(end, next_month - timedelta(days=1))
        for offset in range(0, len(userids), 100):
            page = cli.call("checkin/getcheckinschedulist", {
                "starttime": int(datetime(first.year, first.month, first.day, tzinfo=TZ).timestamp()),
                "endtime": int(datetime(last.year, last.month, last.day, tzinfo=TZ).timestamp()),
                "useridlist": userids[offset:offset+100]})
            if not isinstance(page.get("schedule_list"), list):
                raise RuntimeError("排班响应缺少schedule_list")
            for item in page["schedule_list"]:
                month = str(item.get("yearmonth", ""))
                if len(month) != 6:
                    continue
                for slot in (item.get("schedule") or {}).get("scheduleList", []):
                    date = "%s-%s-%02d" % (month[:4], month[4:], int(slot["day"]))
                    if not first.strftime("%Y-%m-%d") <= date <= last.strftime("%Y-%m-%d"):
                        continue
                    info = slot.get("schedule_info") or {}
                    rows.append({"userid": item.get("userid"), "date": date, "groupid": item.get("groupid"),
                                 "groupname": item.get("groupname", ""), "expected": info.get("schedule_id") != 0,
                                 "segments": segments(info.get("time_section", [])), "schedule_id": info.get("schedule_id"),
                                 "source": "wecom_shift", "reason": "企业微信个人排班表"})
            time.sleep(1.1)
        cursor = next_month
    return rows


def normalize_approval(info, allowed_users):
    """只取PunchCorrection控件的考勤归属日，不把提交日期当补卡日。"""
    if not isinstance(info, dict):
        return []
    controls = []
    def walk(value):
        if isinstance(value, dict):
            if value.get("control") == "PunchCorrection":
                controls.append((value.get("value") or {}).get("punch_correction") or {})
            else:
                for nested in value.values():
                    walk(nested)
        elif isinstance(value, list):
            for nested in value:
                walk(nested)
    walk((info.get("apply_data") or {}).get("contents", []))
    users = [(info.get("applyer") or {}).get("userid")]
    users += [u.get("userid") for u in info.get("batch_applyer", []) if isinstance(u, dict)]
    result = []
    for uid in dict.fromkeys(users):
        if not uid or uid not in allowed_users:
            continue
        for i, control in enumerate(controls):
            date = stamp_date(control.get("daymonthyear") or control.get("time"))
            if not date:
                continue
            result.append({"approval_no": info.get("sp_no", ""), "item_index": i,
                           "userid": uid, "date": date, "correction_ts": control.get("time"),
                           "original_state": control.get("state", ""),
                           "status": APPROVAL_STATUS.get(info.get("sp_status"), "unknown"),
                           "status_code": info.get("sp_status"), "apply_time": info.get("apply_time"),
                           "fetched_at": datetime.now(TZ).isoformat()})
    return result


def fetch_approvals(cli, userids, start, end, progress=None, template_ids=(), prior_numbers=()):
    """官方 /oa/getapprovalinfo + /oa/getapprovaldetail；只落地补卡控件。"""
    rows, errors, seen = [], [], set()
    first = datetime(start.year, start.month, 1, tzinfo=TZ)
    # 包含查询月内直到当前时刻提交的申请，才能回补早于提交日的考勤。
    now = datetime.now(TZ)
    cursor = ""
    try:
        while True:
            body = {"starttime": str(int(first.timestamp())),
                    "endtime": str(int(min(now, datetime(end.year, end.month, end.day, tzinfo=TZ) + timedelta(days=1)).timestamp())),
                    "new_cursor": cursor, "size": 100,
                    "filters": [{"key": "record_type", "value": "2"}]}
            if template_ids:
                # 一个模板一次分页，调用方可配置官方补卡模板以减少无关详情读取。
                body["filters"].append({"key": "template_id", "value": template_ids[0]})
            page = cli.call("oa/getapprovalinfo", body)
            numbers = page.get("sp_no_list")
            if not isinstance(numbers, list):
                raise RuntimeError("审批单列表结构异常")
            for number in numbers:
                if number in seen:
                    continue
                seen.add(number)
                detail = cli.call("oa/getapprovaldetail", {"sp_no": number})
                if not isinstance(detail.get("info"), dict):
                    raise RuntimeError("审批详情缺少info对象，保留旧状态")
                rows.extend(normalize_approval(detail.get("info"), set(userids)))
                if progress:
                    progress.update(step="同步本月补卡审批", approval_checked=len(seen), approval_items=len(rows))
                import time
                time.sleep(0.12)
            next_cursor = page.get("new_next_cursor") or page.get("next_cursor") or ""
            if not next_cursor:
                break
            if next_cursor == cursor:
                raise RuntimeError("审批分页游标未推进")
            cursor = next_cursor
        # 上月提交、尚未完结的申请可以在本月通过；只复核已知单号，不扩大列表扫描。
        for number in set(prior_numbers) - seen:
            detail = cli.call("oa/getapprovaldetail", {"sp_no": number})
            if not isinstance(detail.get("info"), dict):
                raise RuntimeError("历史待审批详情缺少info对象")
            rows.extend(normalize_approval(detail["info"], set(userids)))
            seen.add(number)
    except RuntimeError as error:
        errors.append(str(error))
        if progress:
            progress.error(str(error))
    return rows, {"available": not errors, "errors": errors, "checked": len(seen),
                  "start": first.strftime("%Y-%m-%d"), "end": end.strftime("%Y-%m-%d"),
                  "fetched_at": now.isoformat()}

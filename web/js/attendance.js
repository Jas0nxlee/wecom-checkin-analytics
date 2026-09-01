/* 有效考勤模型：全员 × 日历；原始卡、官方结果和补卡状态不混为一谈。 */
(function (global) {
  'use strict';
  function build(S, U) {
    var byDay = U.groupBy(S.attendanceRecords || [], function (r) { return (r.attendance_date || r.date) + '|' + r.userid; });
    var calendar = {}, approvals = {};
    (S.raw.rules || []).forEach(function (r) { calendar[r.date + '|' + r.userid] = r; });
    (S.raw.approvals || []).forEach(function (a) { (approvals[a.date + '|' + a.userid] || (approvals[a.date + '|' + a.userid] = [])).push(a); });
    var out = [], date = S.filters.start;
    while (date && date <= S.filters.end) {
      S.staffIds.forEach(function (uid) {
        var key = date + '|' + uid, d = S.dailyIndex[key] || null, rule = calendar[key] || {};
        var raw = (byDay[key] || []).slice().sort(function (a, b) { return a.ts - b.ts; });
        var rs = raw.filter(function (r) { return !r.is_placeholder && String(r.exception || '').indexOf('未打卡') < 0; });
        var group = (d && d.groupname) || rule.groupname || (raw[0] && raw[0].groupname) || '未分组';
        if (S.filters.group !== '全部' && group !== S.filters.group) return;
        var expected = d && (d.day_type === 0 || d.day_type === 1) ? d.day_type === 0 : rule.expected;
        if (expected !== true && expected !== false) expected = null;
        var shifts = (d && d.segments && d.segments.length ? d.segments : rule.segments) || [];
        var stdIn = shifts.length ? shifts[0].work_sec / 60 : (d && d.std_work_min != null ? d.std_work_min : null);
        var stdOut = shifts.length ? shifts[shifts.length - 1].off_work_sec / 60 : (d && d.std_off_min != null ? d.std_off_min : null);
        if(!shifts.length && stdIn===0 && stdOut===0){stdIn=null;stdOut=null;}
        // 旧快照丢过多段班次，不再把上午下班当全天标准下班。
        if (d && !d.schema_version && d.standard_work_sec > 0 && stdOut - stdIn < d.standard_work_sec / 60) stdOut = null;
        var actualMin = function (r) {
          return U.dayDiff(date, r.date) * 1440 + Number(r.minute_of_day);
        };
        var ins = rs.filter(function (r) { return r.type === U.TYPE_IN; });
        var offs = rs.filter(function (r) { return r.type === U.TYPE_OFF; });
        var min = rs.length ? Math.min.apply(null, rs.map(actualMin)) : null;
        var max = rs.length ? Math.max.apply(null, rs.map(actualMin)) : null;
        var arrive = d && d.earliest_min > 0 ? d.earliest_min : (ins.length ? actualMin(ins[0]) : min);
        var leave = d && d.lastest_min > 0 ? d.lastest_min : (offs.length ? actualMin(offs[offs.length - 1]) : max);
        if (arrive != null && leave != null && leave < arrive && shifts.some(function (s) { return s.off_work_sec >= 86400; })) leave += 1440;
        var exc = {};
        U.EXC_TYPES.forEach(function (t) {
          var e = d && (d.exceptions || {})[t];
          exc[t] = e ? Number(e.count) || 0 : 0;
          exc['dur_' + t] = e ? Number(e.duration) || 0 : 0;
        });
        var officialKnown = !!d;
        var appBySlot={};
        (approvals[key] || []).slice().sort(function(a,b){return (a.apply_time||0)-(b.apply_time||0);}).forEach(function(a){appBySlot[a.correction_ts || a.item_index || 0]=a;});
        var apps = Object.keys(appBySlot).map(function(k){return appBySlot[k];}).sort(function (a, b) { return (a.apply_time || 0) - (b.apply_time || 0); });
        var pending = apps.some(function (a) { return a.status === 'pending'; });
        var approved = apps.some(function (a) { return a.status === 'approved'; });
        var correctionCount = d ? U.sum((d.sp_items || []).filter(function (i) { return i.type === '补卡'; }), function (i) { return i.count || 0; }) : 0;
        var excTotal = U.sum(U.EXC_TYPES.map(function (t) { return exc[t]; }));
        var approvedSync = approved && d && d.fetched_at && apps.filter(function(a){return a.status==='approved';}).every(function(a){return !a.fetched_at || Date.parse(d.fetched_at)>=Date.parse(a.fetched_at);});
        var correctionStatus = pending ? 'pending' : approved ? (approvedSync ? (excTotal?'corrected_with_exceptions':'corrected') : 'sync_pending')
          : correctionCount > 0 && officialKnown && !excTotal ? 'corrected_daily' : apps.length ? apps[apps.length - 1].status : 'none';
        var present = d ? (d.checkin_count > 0 || d.actual_work_sec > 0 || (correctionCount > 0 && !excTotal)) : rs.length > 0;
        var work = d && d.actual_work_sec != null ? Math.max(0, Number(d.actual_work_sec)) : null;
        // 加班是19:00后有效到离岗区间的交集，不是审批加班/计薪加班。
        var timeKnown = present && arrive != null && leave != null && leave > arrive && (d ? d.checkin_count > 1 || correctionCount > 0 : rs.length > 1);
        var ot = timeKnown ? Math.max(0, leave - Math.max(1140, arrive)) * 60 : 0;
        out.push({key:key, date:date, month:date.slice(0,7), week:U.weekKey(date), weekday:U.parseDate(date).getDay(),
          userid:uid, name:S.name(uid), dept:S.dept(uid), groupname:group, expected:expected,
          isWorkday:expected === true, dayType:expected === true ? 0 : expected === false ? 1 : null,
          present:present, punches:rs.length, rawPunches:raw.length, records:rs, rawRecords:raw,
          morning:ins[0] || null, evening:offs[offs.length-1] || null,
          arriveMin:present ? arrive : null, leaveMin:present ? leave : null, firstMin:present ? arrive : null, lastMin:present ? leave : null,
          stdIn:stdIn, stdOut:stdOut, offsetIn:present && arrive != null && stdIn != null ? arrive-stdIn : null,
          offsetOut:present && leave != null && stdOut != null ? leave-stdOut : null,
          workSec:work, standardWorkSec:d ? d.standard_work_sec : shifts.length ? U.sum(shifts,function(s){return s.off_work_sec-s.work_sec;}) : null,
          otSec:ot, otKnown:timeKnown, officialOtSec:d ? d.ot_sec : null,
          outside:rs.filter(function(r){return r.type === U.TYPE_OUT;}).length,
          hasDaily:!!d, officialKnown:officialKnown, exc:exc, correctionStatus:correctionStatus,
          correctionCount:correctionCount, approvals:apps,
          noGeo:rs.filter(function(r){return !U.validCoord(r);}).length,
          wifi:rs.filter(function(r){return r.wifiname;}).map(function(r){return r.wifiname;}),
          devices:rs.filter(function(r){return r.deviceid;}).map(function(r){return r.deviceid;})});
      });
      date = U.addDays(date, 1);
    }
    return out;
  }
  global.Attendance = {build:build};
})(window);

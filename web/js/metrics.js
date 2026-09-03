/* 指标层：全部统计口径集中在 Metrics，便于与 HR 复核口径 */
(function (global) {
  'use strict';
  var S = null, U = null;
  var cache = { sig: null, days: null, memo: {} };

  function sig() {
    var f = S.filters;
    return [S.version, f.start, f.end, f.dept, f.group, f.scope, S.records.length, S.daily.length].join('#');
  }

  /* 同一筛选条件下只算一次的派生结果：地点统计/人员汇总/工时负荷会被多张图重复调用 */
  function once(key, fn) {
    days();
    if (!cache.memo) cache.memo = {};
    if (!(key in cache.memo)) cache.memo[key] = fn();
    return cache.memo[key];
  }
  function memoized(key, fn) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      return once(args.length ? key + '(' + args.join(',') + ')' : key, function () {
        return fn.apply(null, args);
      });
    };
  }

  /* 把打卡记录按 (日期,人) 聚成“人日”，优先采用打卡日报的官方统计口径 */
  function buildDays() { return global.Attendance.build(S, U); }

  function days() {
    if (cache.sig !== sig()) { cache = { sig: sig(), days: buildDays(), memo: {} }; }
    return cache.days;
  }

  function workdayList() {
    return U.uniq(days().filter(function(d){return d.expected===true;}).map(function(d){return d.date;})).sort();
  }

  /* 人日维度的常用汇总 */
  function agg(list) {
    var heads=U.uniq(list.map(function(d){return d.userid;}));
    var expected=list.filter(function(d){return d.expected===true;});
    var unknown=list.filter(function(d){return d.expected==null;}).length;
    var present=list.filter(function(d){return d.present;});
    var expectedPresent=expected.filter(function(d){return d.present;}).length;
    var officialExpected=expected.filter(function(d){return d.hasDaily;});
    // 同一组已核定应出勤人日作为比率分子、分母；未知日期不猜测为缺勤。
    var missingExpectedDaily=expected.length-officialExpected.length;
    var rateMissingRows=list.filter(function(d){return d.expected==null || (d.expected===true && !d.hasDaily);});
    var rateMissing=rateMissingRows.length;
    var ratePresent=officialExpected.filter(function(d){return d.present;}).length;
    var rate=function(n){return officialExpected.length ? n/officialExpected.length : null;};
    var lateDays=officialExpected.filter(function(d){return d.exc['迟到']>0;}).length;
    var earlyDays=officialExpected.filter(function(d){return d.exc['早退']>0;}).length;
    var missDays=officialExpected.filter(function(d){return d.exc['缺卡']>0;}).length;
    var onTime=officialExpected.filter(function(d){return d.present && !d.exc['迟到'];}).length;
    var rateExcTotal=U.sum(officialExpected,function(d){return U.sum(U.EXC_TYPES.map(function(t){return d.exc[t]||0;}));});
    var excSum={};
    U.EXC_TYPES.forEach(function(t){excSum[t]=U.sum(list,function(d){return d.exc[t]||0;});excSum['dur_'+t]=U.sum(list,function(d){return d.exc['dur_'+t]||0;});});
    var workKnown=list.filter(function(d){return d.workSec!=null;});
    var workSec=U.sum(workKnown,function(d){return d.workSec;});
    var standardKnown=list.filter(function(d){return d.standardWorkSec!=null && d.expected===true;});
    var otSec=U.sum(list,function(d){return d.otSec;});
    var records=[].concat.apply([],list.map(function(d){return d.records;}));
    function avg(field){var values=present.map(function(d){return d[field];}).filter(function(v){return v!=null&&isFinite(v);});return values.length?U.mean(values):null;}
    var offsets=present.map(function(d){return d.offsetIn;}).filter(function(v){return v!=null&&d_isPlausible(v);});
    var punches=records.length,outside=records.filter(function(r){return r.type===U.TYPE_OUT;}).length;
    var workExpected=officialExpected.filter(function(d){return d.workSec!=null;});
    return {
      headcount:heads.length, modelDays:list.length, personDays:present.length, presentPersonDays:expectedPresent,
      expPersonDays:expected.length, unknownSchedule:unknown, missingDaily:list.filter(function(d){return !d.hasDaily;}).length,
      ratePersonDays:officialExpected.length, ratePresentPersonDays:ratePresent,
      rateMissingPersonDays:rateMissing, missingExpectedDaily:missingExpectedDaily,
      rateMissingPeople:U.uniq(rateMissingRows.map(function(d){return d.userid;})).length,
      dataCoveredPersonDays:list.length-rateMissing, dataCoverageRate:list.length?(list.length-rateMissing)/list.length:null,
      ratePartial:rateMissing>0, rateExcTotal:rateExcTotal,
      attendanceRate:rate(ratePresent), workDays:expected.length, restDays:list.filter(function(d){return d.expected===false;}).length,
      dates:U.uniq(list.map(function(d){return d.date;})),dateCount:U.uniq(list.map(function(d){return d.date;})).length,
      late:excSum['迟到'],early:excSum['早退'],miss:excSum['缺卡'],absent:excSum['旷工'],placeExc:excSum['地点异常'],devExc:excSum['设备异常'],
      durLate:excSum.dur_迟到,durEarly:excSum.dur_早退,durAbsent:excSum.dur_旷工,
      lateDays:lateDays,earlyDays:earlyDays,missDays:missDays,lateRate:rate(lateDays),earlyRate:rate(earlyDays),missRate:rate(missDays),onTimeRate:rate(onTime),
      excTotal:U.sum(U.EXC_TYPES.map(function(t){return excSum[t];})),
      seriousExc:excSum['旷工']+excSum['地点异常']+excSum['设备异常'],
      excRate:rate(rateExcTotal),
      workSec:workSec,workKnownDays:workKnown.length,otSec:otSec,expectedWorkSec:U.sum(standardKnown,function(d){return d.standardWorkSec;}),
      standardDays:standardKnown.length,avgWorkHours:workExpected.length?U.sum(workExpected,function(d){return d.workSec;})/workExpected.length/3600:null,
      otIntensity:workSec?otSec/workSec:0,otHoursPerDay:U.uniq(list.map(function(d){return d.date;})).length?otSec/3600/U.uniq(list.map(function(d){return d.date;})).length:0,
      otUnknownDays:present.filter(function(d){return !d.otKnown;}).length,
      punches:punches,outsidePunch:outside,placeCount:U.uniq(records.map(function(r){return r.location_title;}).filter(Boolean)).length,
      wifiCount:U.uniq(records.map(function(r){return r.wifiname;}).filter(Boolean)).length,
      deviceCount:U.uniq(records.map(function(r){return r.deviceid;}).filter(Boolean)).length,noGeo:records.filter(function(r){return !U.validCoord(r);}).length,
      outsideRate:punches?outside/punches:0,avgOffsetIn:offsets.length?U.mean(offsets):null,medOffsetIn:offsets.length?U.quantile(offsets.sort(function(a,b){return a-b;}),.5):null,
      avgOffsetOut:avg('offsetOut'),records:records,avgArriveMin:avg('arriveMin'),avgLeaveMin:avg('leaveMin'),
      pendingCorrections:list.filter(function(d){return d.correctionStatus==='pending';}).length,
      syncedCorrections:list.filter(function(d){return /^corrected/.test(d.correctionStatus);}).length
    };
  }
  // 到岗偏移过大的（跨天/异常时间戳）不计入分布
  function d_isPlausible(v) { return v > -480 && v < 480; }

  function sliceByDate(list, dates) {
    var set = {}; dates.forEach(function (d) { set[d] = 1; });
    return list.filter(function (d) { return set[d.date]; });
  }

  /* ---------------- 总览 KPI ---------------- */
  function kpis() {
    var all = days(), a = agg(all);
    var dates = U.uniq(all.map(function (d) { return d.date; })).sort();
    var half = Math.floor(dates.length / 2);
    var prev = half ? sliceByDate(all, dates.slice(0, half)) : [];
    var cur = half ? sliceByDate(all, dates.slice(-half)) : [];
    var pa = agg(prev), ca = agg(cur);
    function trend(key, better) {
      if (!pa.modelDays || !ca.modelDays || pa[key]==null || ca[key]==null) return null;
      if (['attendanceRate','lateRate','earlyRate','missRate','onTimeRate','excRate'].indexOf(key)>=0 && (pa.ratePartial || ca.ratePartial))
        return {text:'覆盖不齐，暂不环比',cls:''};
      var diff = ca[key] - pa[key];
      var text = fmtDelta(key, diff);
      if (text === '0.0pp' || text === '0.0' || text === '0.0′' || text === '0.0h' || Math.abs(diff) < 1e-9) return { text: '持平', cls: '' };
      var up = diff > 0;
      return { text: (up ? '▲' : '▼') + text, cls: (up === (better === 'up')) ? 'good' : 'bad' };
    }
    function fmtDelta(key, diff) {
      if (['attendanceRate','lateRate','earlyRate','missRate','onTimeRate','otIntensity','outsideRate'].indexOf(key)>=0)
        return Math.abs(diff * 100).toFixed(1) + 'pp';
      if (key === 'excRate') return Math.abs(diff).toFixed(2) + '次/人日';
      if (key === 'otSec') return Math.abs(diff/3600).toFixed(1)+'h';
      if (key === 'avgWorkHours') return Math.abs(diff).toFixed(1) + 'h';
      if (key === 'avgOffsetIn' || key === 'avgOffsetOut') return Math.abs(diff).toFixed(1) + '′';
      return Math.abs(diff).toFixed(1);
    }
    var noGeo = a.noGeo;
    var sp = function (kind) { return seriesByDate(all, kind).slice(-14); };
    return [
      { label: '应考勤人数', val: a.headcount, unit: '人', foot: a.dateCount + ' 个自然日 · 有效出勤人日 ' + a.personDays, trend: trend('headcount', 'up'), spark: sp('head') },
      { label: '出勤率（已核定）', val: U.rateText(a.attendanceRate), unit: '%', cls: a.attendanceRate==null?'':a.attendanceRate > 0.93 ? 'good' : (a.attendanceRate > 0.85 ? 'warn' : 'bad'), foot: a.ratePersonDays ? '出勤/核定应出勤 '+a.ratePresentPersonDays+'/'+a.ratePersonDays+' · 依据覆盖 '+U.rateText(a.dataCoverageRate)+'%' : '无可核定应出勤人日', trend: trend('attendanceRate', 'up'), spark: sp('attendance') },
      { label: '准点率（核定）', val: U.rateText(a.onTimeRate), unit: '%', foot: '已出勤且核定无迟到/核定应出勤', trend: trend('onTimeRate', 'up'), spark: sp('onTime') },
      { label: '迟到率', val: U.rateText(a.lateRate), unit: '%', cls: a.lateRate==null?'':a.lateRate > 0.15 ? 'bad' : (a.lateRate > 0.07 ? 'warn' : 'good'), foot: a.late + ' 次 · 累计 ' + (a.durLate / 3600).toFixed(1) + 'h', trend: trend('lateRate', 'down'), spark: sp('late') },
      { label: '早退率', val: U.rateText(a.earlyRate), unit: '%', cls: a.earlyRate==null?'':a.earlyRate > 0.12 ? 'warn' : 'good', foot: a.early + ' 次 · 累计 ' + (a.durEarly / 3600).toFixed(1) + 'h', trend: trend('earlyRate', 'down'), spark: sp('early') },
      { label: '缺卡率', val: U.rateText(a.missRate), unit: '%', cls: a.missRate==null?'':a.missRate > 0.15 ? 'bad' : (a.missRate > 0.06 ? 'warn' : 'good'), foot: a.miss + ' 次 · 按最新日报修正结果', trend: trend('missRate', 'down'), spark: sp('miss') },
      { label: '旷工 / 严重异常', val: a.absent, unit: '人次', cls: a.absent > 0 ? 'bad' : 'good', foot: '地点异常 ' + a.placeExc + ' · 设备异常 ' + a.devExc, trend: trend('seriousExc', 'down'), spark: sp('serious') },
      { label: '人均日工时', val: a.avgWorkHours!=null?a.avgWorkHours.toFixed(2):'—', unit: 'h', foot: '含零值日报 · 标准 ' + (a.expectedWorkSec / Math.max(1, a.standardDays) / 3600).toFixed(2) + 'h', trend: trend('avgWorkHours', 'up'), spark: sp('work') },
      { label: '19点后加班', val: (a.otSec / 3600).toFixed(1), unit: 'h', foot: '非审批/计薪加班 · 时刻待核定 ' + a.otUnknownDays + ' 人日', trend: trend('otSec', 'down'), spark: sp('ot') },
      { label: '平均到岗时刻', val: U.fmtMin(a.avgArriveMin), unit: '', foot: '较标准 ' + U.fmtOffset(a.avgOffsetIn) + ' · 中位 ' + U.fmtOffset(a.medOffsetIn), trend: trend('avgOffsetIn', 'down'), spark: sp('arrive') },
      { label: '平均离岗时刻', val: U.fmtMin(a.avgLeaveMin), unit: '', foot: '较标准 ' + U.fmtOffset(a.avgOffsetOut), trend: trend('avgOffsetOut', 'down'), spark: sp('leave') },
      { label: '外勤打卡占比', val: (a.outsideRate * 100).toFixed(1), unit: '%', foot: a.outsidePunch + ' 次外出打卡', trend: trend('outsideRate', 'down'), spark: sp('outside') },
      { label: '打卡地点数', val: a.placeCount, unit: '个', foot: 'WiFi ' + a.wifiCount + ' 个 · 设备 ' + a.deviceCount + ' 台', trend: trend('placeCount', 'up'), spark: sp('places') },
      { label: '无坐标打卡', val: noGeo, unit: '次', cls: noGeo > a.records.length * 0.1 ? 'warn' : '', foot: 'WiFi 打卡/定位失败，占 ' + U.pct(noGeo, a.records.length), trend: trend('noGeo', 'down'), spark: sp('noGeo') },
      { label: '人均异常次数', val: a.excRate==null?'—':a.excRate.toFixed(2), unit: '次/人日', cls: a.excRate==null?'':a.excRate > 0.6 ? 'bad' : (a.excRate > 0.3 ? 'warn' : 'good'), foot: '核定工作日异常 '+a.rateExcTotal+' 次 / '+a.ratePersonDays+' 人日', trend: trend('excRate', 'down'), spark: sp('excRate') }
    ];
  }

  /* KPI 迷你趋势：按日期聚合（近 14 天，休息日出勤率/准点率为空） */
  function seriesByDate(list, kind) {
    var g=U.groupBy(list,function(d){return d.date;});
    return Object.keys(g).sort().map(function(date){
      var a=agg(g[date]),keys={head:'headcount',attendance:'attendanceRate',onTime:'onTimeRate',late:'lateRate',early:'earlyRate',miss:'missRate',
        serious:'seriousExc',work:'avgWorkHours',arrive:'avgArriveMin',leave:'avgLeaveMin',outside:'outsideRate',places:'placeCount',noGeo:'noGeo',excRate:'excRate'};
      if(kind==='ot')return a.otSec/3600;
      var value=a[keys[kind]];
      return ['attendance','onTime','late','early','miss','outside'].indexOf(kind)>=0 ? (value==null?null:value*100) : value;
    });
  }
  function agg0(rows) {
    var a=agg(rows);
    return {late:a.late,miss:a.miss,ot:a.otSec,punch:a.punches,outside:a.outsidePunch,workdayPresent:a.presentPersonDays,
      workdayExpect:a.ratePersonDays,workSecTotal:a.workSec,early:a.early,absent:a.absent,placeExc:a.placeExc,devExc:a.devExc,
      noGeo:a.noGeo,onTime:a.onTimeRate==null?0:a.onTimeRate*a.ratePersonDays,excTotal:a.excTotal,serious:a.seriousExc,
      arriveN:a.avgArriveMin==null?0:1,arriveSum:a.avgArriveMin||0,leaveN:a.avgLeaveMin==null?0:1,leaveSum:a.avgLeaveMin||0};
  }

  /* ---------------- 时间维度 ---------------- */
  function hourDist() {
    var types = [U.TYPE_IN, U.TYPE_OUT, U.TYPE_OFF];
    var data = types.map(function () { return new Array(24).fill(0); });
    S.records.forEach(function (r) {
      var i = types.indexOf(r.type);
      if (i < 0) i = 2;
      data[i][r.hour]++;
    });
    return { types: types, data: data };
  }

  function wdHourHeat() {
    var m = {};
    S.records.forEach(function (r) {
      var wd = (U.parseDate(r.date).getDay() + 6) % 7;
      var k = wd + '|' + r.hour;
      m[k] = (m[k] || 0) + 1;
    });
    var data = [], max = 0;
    for (var wd = 0; wd < 7; wd++) for (var h = 0; h < 24; h++) {
      var v = m[wd + '|' + h] || 0; max = Math.max(max, v);
      data.push([h, wd, v]);
    }
    return { data: data, max: max };
  }

  function calendarHeat() {
    var m = U.countBy(S.records, function (r) { return r.date; });
    var data = Object.keys(m).sort().map(function (d) { return [d, m[d]]; });
    return { data: data, max: data.reduce(function (a, b) { return Math.max(a, b[1]); }, 0) };
  }

  function offsetHist(which, bins) {
    var list = days().map(function (d) { return which === 'in' ? d.offsetIn : d.offsetOut; })
      .filter(function (v) { return v != null && isFinite(v); });
    var lo = which === 'in' ? -60 : -120, hi = which === 'in' ? 60 : 240, step = (hi - lo) / bins;
    var arr = new Array(bins).fill(0);
    list.forEach(function (v) {
      var i = Math.floor((v - lo) / step);
      if (i < 0) i = 0; if (i >= bins) i = bins - 1;
      arr[i]++;
    });
    var labels = arr.map(function (_, i) { return Math.round(lo + i * step) + '~' + Math.round(lo + (i + 1) * step); });
    labels[0]='<'+Math.round(lo+step);labels[labels.length-1]='≥'+Math.round(hi-step);
    return { labels: labels, values: arr, zeroIndex: Math.round((0 - lo) / step), count: list.length };
  }

  function avgTimesSeries() {
    var g = U.groupBy(days(), function (d) { return d.date; });
    var dates = Object.keys(g).sort();
    var arrive = [], leave = [], stdIn = [], stdOut = [];
    dates.forEach(function (date) {
      var rows = g[date];
      var a = rows.map(function (d) { return d.arriveMin; }).filter(function (v) { return v != null && v > 240 && v < 1080; });
      var l = rows.map(function (d) { return d.leaveMin; }).filter(function (v) { return v != null && v > 600; });
      var si = rows.map(function (d) { return d.stdIn; }).filter(function (v) { return v != null; });
      var so = rows.map(function (d) { return d.stdOut; }).filter(function (v) { return v != null; });
      arrive.push(a.length ? +(U.mean(a)).toFixed(1) : null);
      leave.push(l.length ? +(U.mean(l)).toFixed(1) : null);
      stdIn.push(si.length ? +(U.mean(si)).toFixed(1) : null);
      stdOut.push(so.length ? +(U.mean(so)).toFixed(1) : null);
    });
    return { dates: dates, arrive: arrive, leave: leave, stdIn: stdIn, stdOut: stdOut };
  }

  function boxByWeek() {
    var g = U.groupBy(days().filter(function (d) { return d.isWorkday; }), function (d) { return d.week; });
    var weeks = Object.keys(g).sort().slice(-12);
    function box(rows, pick, std) {
      var vals = rows.map(pick).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });
      if (vals.length < 3) return null;
      var q1 = U.quantile(vals, .25), q2 = U.quantile(vals, .5), q3 = U.quantile(vals, .75);
      var lo = Math.max(vals[0], q1 - 1.5 * (q3 - q1)), hi = Math.min(vals[vals.length - 1], q3 + 1.5 * (q3 - q1));
      return [Math.round(lo), Math.round(q1), Math.round(q2), Math.round(q3), Math.round(hi)];
    }
    // 用「相对标准时刻的偏移分钟」，避免 0-24 点坐标把箱体压成一条线
    var arrive = weeks.map(function (w) { return box(g[w], function (d) { return d.offsetIn; }); });
    var leave = weeks.map(function (w) { return box(g[w], function (d) { return d.offsetOut; }); });
    return { weeks: weeks, arrive: arrive.map(function (v) { return v || []; }), leave: leave.map(function (v) { return v || []; }) };
  }

  function deptHourHeat() {
    var depts = U.uniq(days().map(function (d) { return d.dept; })).sort();
    var m = {}, max = 0;
    days().forEach(function (d) {
      d.records.forEach(function (r) {
        var k = depts.indexOf(d.dept) + '|' + r.hour;
        m[k] = (m[k] || 0) + 1; max = Math.max(max, m[k]);
      });
    });
    var data = [];
    depts.forEach(function (_, i) { for (var h = 0; h < 24; h++) { data.push([h, i, m[i + '|' + h] || 0]); } });
    return { depts: depts, data: data, max: max };
  }

  function scatterTime() {
    var pts = days().filter(function (d) { return d.arriveMin != null && d.leaveMin != null && d.isWorkday; })
      .map(function (d) { return [d.arriveMin, d.leaveMin > d.arriveMin ? d.leaveMin : null, d.name, d.date, d.dept, d.exc['迟到'] ? 1 : 0]; })
      .filter(function (p) { return p[1] != null; });
    return { pts: pts };
  }

  /* ---------------- 地点维度 ---------------- */
  function geoRecords(type) {
    return S.records.filter(function (r) {
      if (!U.validCoord(r)) return false;
      if (type === 'all') return true;
      if (type === 'in') return r.type === U.TYPE_IN;
      if (type === 'out') return r.type === U.TYPE_OUT;
      if (type === 'off') return r.type === U.TYPE_OFF;
      if (type === 'exc') return !!r.effective_exception;
      if (type === 'raw_exc') return !!r.exception;
      return true;
    });
  }

  function placeStat(type) {
    var recs = geoRecords(type);
    var c = U.countBy(recs.filter(function (r) { return r.location_title; }), function (r) { return r.location_title; });
    var top = U.topN(c, 25);
    var typeComp = U.countBy(recs, function (r) { return U.classifyPlace(r, S.mainOffice(r.userid)); });
    var city = U.countBy(recs, function (r) { return U.extractCity(r.location_detail || r.location_title); });
    var cityExc = U.countBy(recs.filter(function (r) { return !!r.effective_exception; }), function (r) { return U.extractCity(r.location_detail || r.location_title); });
    var dist = [];
    recs.forEach(function (r) {
      var mo = S.mainOffice(r.userid);
      var d = mo ? U.haversine(mo, r) : null;
      if (d != null) dist.push(d);
    });
    var buckets = [{ name: '<100m', max: 100 }, { name: '100-300m', max: 300 }, { name: '300-500m', max: 500 },
      { name: '500m-1km', max: 1000 }, { name: '1-3km', max: 3000 }, { name: '3-10km', max: 10000 },
      { name: '10-50km', max: 50000 }, { name: '>50km', max: Infinity }];
    buckets.forEach(function (b) { b.count = 0; });
    dist.forEach(function (d) { for (var i = 0; i < buckets.length; i++) { if (d < buckets[i].max) { buckets[i].count++; break; } } });
    var wifi = U.topN(U.countBy(S.records.filter(function (r) { return r.wifiname; }), function (r) { return r.wifiname; }), 12);
    var dev = U.topN(U.countBy(S.records.filter(function (r) { return r.deviceid; }), function (r) { return r.deviceid; }), 12);
    var perUser = U.groupBy(recs, function (r) { return r.userid; });
    var diversity = Object.keys(perUser).map(function (uid) {
      var rs = perUser[uid];
      var places = U.uniq(rs.map(function (r) {
        return (r.location_title || '未知') + '|' + Math.round(r.lat * 200) + '|' + Math.round(r.lng * 200);
      }));
      var cities = U.uniq(rs.map(function (r) { return U.extractCity(r.location_detail || r.location_title); })
        .filter(function (city) { return city !== '未知'; }));
      return { name: S.name(uid), dept: rs[0].dept, places: places.length, cities: cities.length,
        punches: rs.length, outside: rs.filter(function (r) { return r.type === U.TYPE_OUT; }).length };
    }).sort(function (a, b) { return b.places - a.places || b.cities - a.cities; });
    // 同名地点可能跨城市（例如“国科环宇”），不能把不同坐标平均成一个不存在的地点。
    var centers = U.groupBy(recs.filter(function (r) { return r.location_title; }), function (r) {
      return r.location_title + '|' + Math.round(r.lat * 200) + '|' + Math.round(r.lng * 200);
    });
    var clusters = Object.keys(centers).map(function (name) {
      var rs = centers[name];
      return { name: name, lat: U.mean(rs.map(function (r) { return r.lat; })), lng: U.mean(rs.map(function (r) { return r.lng; })),
        count: rs.length, users: U.uniq(rs.map(function (r) { return r.userid; })).length,
        detail: rs[0].location_detail || '', type: U.classifyPlace(rs[0], S.mainOffice(rs[0].userid)) };
    }).sort(function (a, b) { return b.count - a.count; });
    return { recs: recs, top: top, typeComp: typeComp, city: city, cityExc: cityExc,
      distBuckets: buckets.map(function (b) { return { name: b.name, count: b.count }; }),
      distCount: dist.length, wifi: wifi, device: dev, diversity: diversity, clusters: clusters,
      noGeo: S.records.length - geoRecords('all').length };
  }

  /* ---------------- 趋势维度 ---------------- */
  function dailySeries() {
    var g=U.groupBy(days(),function(d){return d.date;});
    return Object.keys(g).sort().map(function(date){
      var a=agg(g[date]);return {date:date,weekday:U.parseDate(date).getDay(),isWorkday:a.expPersonDays>0,present:a.personDays,
        head:a.headcount,attendanceRate:a.attendanceRate,lateRate:a.lateRate,missRate:a.missRate,earlyRate:a.earlyRate,
        punches:a.punches,outside:a.outsidePunch,avgWorkHours:a.avgWorkHours,otHours:a.otSec/3600,
        avgArrive:a.avgArriveMin,avgLeave:a.avgLeaveMin,late:a.late,miss:a.miss,early:a.early,
        placeExc:a.placeExc,devExc:a.devExc,absent:a.absent,expected:a.expPersonDays,unknownSchedule:a.unknownSchedule,
        ratePersonDays:a.ratePersonDays,rateMissingPersonDays:a.rateMissingPersonDays,dataCoverageRate:a.dataCoverageRate};
    });
  }
  function periodCompare(field) {
    var g=U.groupBy(days(),function(d){return d[field];});
    return Object.keys(g).sort().map(function(key){
      var rows=g[key],a=agg(rows),dates=U.uniq(rows.map(function(d){return d.date;})).sort();
      var value={head:a.headcount,personDays:a.personDays,workdays:U.uniq(rows.filter(function(d){return d.expected;}).map(function(d){return d.date;})).length,
        attendanceRate:a.attendanceRate,lateRate:a.lateRate,missRate:a.missRate,avgWorkHours:a.avgWorkHours,
        otHours:a.otSec/3600,workdayShare:a.modelDays?a.expPersonDays/a.modelDays:0,outside:a.outsidePunch,punches:a.punches,
        start:dates[0],end:dates[dates.length-1],expected:a.expPersonDays,unknownSchedule:a.unknownSchedule,
        ratePersonDays:a.ratePersonDays,rateMissingPersonDays:a.rateMissingPersonDays,dataCoverageRate:a.dataCoverageRate};
      value[field]=key;return value;
    });
  }
  function weekCompare(){return periodCompare('week');}
  function monthCompare(){return periodCompare('month');}
  function weekdayProfile() {
    var g=U.groupBy(days(),function(d){return (d.weekday+6)%7;});
    return [0,1,2,3,4,5,6].map(function(i){
      var rows=g[i]||[],a=agg(rows),n=U.uniq(rows.map(function(d){return d.date;})).length||1;
      return {name:U.weekdayCN(i),present:a.personDays/n,head:a.headcount,rate:a.attendanceRate,
        lateRate:a.lateRate,missRate:a.missRate,avgWorkHours:a.avgWorkHours,otHours:a.otSec/3600/n};
    });
  }
  function deptDayHeat() {
    var all=days(),depts=U.uniq(all.map(function(d){return d.dept;})).sort(),dates=U.uniq(all.map(function(d){return d.date;})).sort();
    var g=U.groupBy(all,function(d){return d.dept+'|'+d.date;}),data=[];
    depts.forEach(function(dept,di){dates.forEach(function(date,xi){
      var rate=agg(g[dept+'|'+date]||[]).attendanceRate;data.push([xi,di,rate==null?null:Math.round(rate*100)]);
    });});return {depts:depts,dates:dates,data:data,max:100};
  }

  /* ---------------- 异常与人员 ---------------- */
  function personSummary() {
    var g=U.groupBy(days(),function(d){return d.userid;});
    return Object.keys(g).map(function(uid){
      var rows=g[uid],a=agg(rows);return {
        userid:uid,name:S.name(uid),dept:S.dept(uid),personDays:a.personDays,workdays:a.presentPersonDays,expectDays:a.expPersonDays,
        attendanceRate:a.attendanceRate,late:a.late,early:a.early,miss:a.miss,absent:a.absent,placeExc:a.placeExc,devExc:a.devExc,
        excTotal:a.excTotal,excRate:a.excRate,lateRate:a.lateRate,missRate:a.missRate,avgArrive:a.avgArriveMin,avgLeave:a.avgLeaveMin,avgOffsetIn:a.avgOffsetIn,
        workSec:a.workSec,otSec:a.otSec,outside:a.outsidePunch,punches:a.punches,places:a.placeCount,
        pendingCorrections:a.pendingCorrections,unknownSchedule:a.unknownSchedule,missingDaily:a.missingDaily,
        ratePersonDays:a.ratePersonDays,rateMissingPersonDays:a.rateMissingPersonDays,missingExpectedDaily:a.missingExpectedDaily,dataCoverageRate:a.dataCoverageRate,
        cities:U.uniq(a.records.map(function(r){return U.extractCity(r.location_detail||r.location_title);})).filter(function(c){return c!=='未知';}).length};
    }).sort(function(a,b){if(a.excRate==null&&b.excRate!=null)return 1;if(b.excRate==null&&a.excRate!=null)return -1;return b.excRate-a.excRate||b.excTotal-a.excTotal;});
  }

  function excTrend() {
    var s = dailySeries();
    return { dates: s.map(function (d) { return d.date; }),
      '迟到': s.map(function (d) { return d.late; }), '早退': s.map(function (d) { return d.early; }),
      '缺卡': s.map(function (d) { return d.miss; }), '旷工': s.map(function (d) { return d.absent; }),
      '地点异常': s.map(function (d) { return d.placeExc; }), '设备异常': s.map(function (d) { return d.devExc; }) };
  }

  function spStructure() {
    var m = {}, hours = {};
    days().forEach(function (d) {
      var dd = S.dailyIndex[d.date + '|' + d.userid];
      if (!dd || !dd.sp_items) return;
      dd.sp_items.forEach(function (i) {
        var k = i.name || i.type || '其他';
        m[k] = (m[k] || 0) + (i.count || 0);
        if (i.hours) hours[k] = (hours[k] || 0) + i.hours;
      });
    });
    if (!Object.keys(m).length) {
      days().forEach(function (d) { if (d.outside) m['外勤次数'] = (m['外勤次数'] || 0) + d.outside; });
    }
    return U.topN(m, 12);
  }

  function excDetailRows() {
    var rows = [];
    days().forEach(function (d) {
      var dd = S.dailyIndex[d.date + '|' + d.userid];
      U.EXC_TYPES.forEach(function (t) {
        var cnt = d.exc[t] || 0;
        if (!cnt) return;
        var dur = d.exc['dur_' + t] || 0;
        var rec = d.records.filter(function (r) { return r.exception && r.exception.indexOf(t) >= 0; })[0];
        rows.push({
          date: d.date, weekday: U.weekdayCN((U.parseDate(d.date).getDay() + 6) % 7), name: d.name, dept: d.dept,
          type: t, count: cnt, durSec: dur,
          durText: dur ? (dur >= 3600 ? (dur / 3600).toFixed(1) + 'h' : Math.round(dur / 60) + '′') : '-',
          timeMin: rec ? rec.minute_of_day : (t === '缺卡' ? null : d.arriveMin),
          time: rec ? U.fmtMin(rec.minute_of_day) : (t === '缺卡' ? '无打卡' : (d.arriveMin != null ? U.fmtMin(d.arriveMin) : '-')),
          std: d.stdIn && d.stdOut ? U.fmtMin(d.stdIn) + '-' + U.fmtMin(d.stdOut) : '-',
          place: rec ? (rec.location_title || '-') : (d.records[0] ? d.records[0].location_title : '-'),
          wifi: rec ? (rec.wifiname || '-') : '-', notes: rec ? (rec.notes || '') : '',
          userid: d.userid
        });
      });
    });
    return rows.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  }

  /* ---------------- 工时与加班 ---------------- */
  function workLoad() {
    var rows = days();
    var hist = { '0-2h': 0, '2-4h': 0, '4-6h': 0, '6-7h': 0, '7-8h': 0, '8-9h': 0, '9-10h': 0, '10-12h': 0, '≥12h': 0 };
    var order = Object.keys(hist);
    rows.forEach(function (d) {
      if (d.workSec == null || (!d.expected && !d.present)) return;
      var h = d.workSec / 3600;
      if (h < 2) hist['0-2h']++; else if (h < 4) hist['2-4h']++; else if (h < 6) hist['4-6h']++;
      else if (h < 7) hist['6-7h']++; else if (h < 8) hist['7-8h']++; else if (h < 9) hist['8-9h']++;
      else if (h < 10) hist['9-10h']++; else if (h < 12) hist['10-12h']++; else hist['≥12h']++;
    });
    // 连续在岗（含周末与外出打卡）：当天有出勤或任何实际打卡（含上下班/外出）即算在岗
    function onDuty(d) { return d.present || d.punches > 0; }
    var byUser = U.groupBy(rows.filter(onDuty), function (d) { return d.userid; });
    var streak = Object.keys(byUser).map(function (uid) {
      var dates = U.uniq(byUser[uid].map(function (d) { return d.date; })).sort();
      var best = 1, cur = 1;
      for (var i = 1; i < dates.length; i++) {
        cur = U.dayDiff(dates[i - 1], dates[i]) === 1 ? cur + 1 : 1;
        best = Math.max(best, cur);
      }
      var restDays = U.uniq(byUser[uid].filter(function (d) { return !d.isWorkday; }).map(function (d) { return d.date; })).length;
      return { name: S.name(uid), dept: byUser[uid][0].dept, streak: best, days: dates.length, restDays: restDays,
        otHours: U.sum(byUser[uid], function (d) { return d.otSec; }) / 3600, userid: uid };
    }).sort(function (a, b) {
      return b.streak - a.streak || b.restDays - a.restDays || b.days - a.days || b.otHours - a.otHours;
    });
    var otRank = personSummary().map(function (p) { return { name: p.name, dept: p.dept, otHours: p.otSec / 3600, workHours: p.workSec / 3600, days: p.personDays, outside: p.outside, userid: p.userid }; })
      .sort(function (a, b) { return b.otHours - a.otHours; });
    var otComp = { '工作日19点后': 0, '休息日19点后': 0, '排班待核定19点后': 0 };
    rows.forEach(function (d) {
      otComp[d.expected === true ? '工作日19点后' : d.expected === false ? '休息日19点后' : '排班待核定19点后'] += d.otSec;
    });
    var night = dailySeries().map(function (d) {
      var rows2 = rows.filter(function (r) { return r.date === d.date; });
      var v = rows2.map(function (r) { return r.lastMin; }).filter(function (x) { return x != null && x > 600; });
      var p90 = v.length ? U.quantile(v.slice().sort(function (a, b) { return a - b; }), 0.9) : null;
      var avg = v.length ? U.mean(v) : null;
      return { date: d.date, p90: p90, avg: avg, over21: v.filter(function (x) { return x >= 1260; }).length, over23: v.filter(function (x) { return x >= 1380; }).length };
    });
    return { workHist: order.map(function (k) { return { name: k, count: hist[k] }; }), streak: streak,
      otRank: otRank, otComp: Object.keys(otComp).map(function (k) { return { name: k, hours: otComp[k] / 3600 }; }), night: night };
  }

  /* ---------------- 部门对比 ---------------- */
  function deptCompare() {
    var g=U.groupBy(days(),function(d){return d.dept;});
    return Object.keys(g).map(function(dept){
      var a=agg(g[dept]);return {dept:dept,head:a.headcount,personDays:a.personDays,punches:a.punches,
        attendanceRate:a.attendanceRate,lateRate:a.lateRate,missRate:a.missRate,earlyRate:a.earlyRate,onTimeRate:a.onTimeRate,
        avgWorkHours:a.avgWorkHours,otHoursPerHead:a.headcount?a.otSec/3600/a.headcount:0,outsideRate:a.outsideRate,
        avgArrive:a.avgArriveMin,places:a.placeCount,unknownSchedule:a.unknownSchedule,pendingCorrections:a.pendingCorrections,
        ratePersonDays:a.ratePersonDays,rateMissingPersonDays:a.rateMissingPersonDays,dataCoverageRate:a.dataCoverageRate};
    }).sort(function(a,b){return b.head-a.head;});
  }

  /* ---------------- 个人画像 ---------------- */
  function person(uid) {
    var rows = days().filter(function (d) { return d.userid === uid; });
    var a = agg0(rows);
    var recs = [].concat.apply([], rows.map(function (d) { return d.records; }));
    return {
      uid: uid, name: S.name(uid), dept: rows.length ? rows[0].dept : '-',
      kpi: (function () {
        var p = personSummary().filter(function (x) { return x.userid === uid; })[0] || {};
        return [
          { label: '有效出勤人日', val: p.personDays || 0 }, { label: '出勤率（已核定）', val: U.rateText(p.attendanceRate), unit: '%', foot:'核定应出勤 '+(p.ratePersonDays||0)+' 人日 · 缺少依据 '+(p.rateMissingPersonDays||0)+' 人日' },
          { label: '迟到', val: a.late, unit: '次' }, { label: '早退', val: U.sum(rows, function (d) { return d.exc['早退'] || 0; }), unit: '次' },
          { label: '缺卡', val: a.miss, unit: '次' }, { label: '19点后加班', val: (a.ot / 3600).toFixed(1), unit: 'h' },
          { label: '外勤打卡', val: a.outside, unit: '次' }, { label: '地点数', val: p.places || 0, unit: '个' },
          { label: '城市数', val: p.cities || 0, unit: '个' }
        ];
      })(),
      time: rows.map(function (d) { return [d.date, d.arriveMin, d.leaveMin, d.offsetIn, d.exc['迟到'] ? 1 : 0, d.outside]; }),
      cal: rows.map(function (d) { return [d.date, d.punches]; }),
      places: U.topN(U.countBy(recs, function (r) { return (r.location_title || '未知') + '｜' + (r.location_detail || ''); }), 12),
      exc: excDetailRows().filter(function (r) { return r.userid === uid; }).slice(0, 60),
      days: rows
    };
  }

  global.Metrics = {
    days: days, agg: agg, workdayList: workdayList, kpis: memoized('kpis', kpis), seriesByDate: seriesByDate,
    hourDist: memoized('hourDist', hourDist), wdHourHeat: memoized('wdHourHeat', wdHourHeat),
    calendarHeat: memoized('calendarHeat', calendarHeat), offsetHist: memoized('offsetHist', offsetHist),
    avgTimesSeries: memoized('avgTimesSeries', avgTimesSeries), boxByWeek: memoized('boxByWeek', boxByWeek),
    deptHourHeat: memoized('deptHourHeat', deptHourHeat), scatterTime: memoized('scatterTime', scatterTime),
    placeStat: memoized('placeStat', placeStat), geoRecords: geoRecords,
    dailySeries: memoized('dailySeries', dailySeries), weekCompare: memoized('weekCompare', weekCompare),
    monthCompare: memoized('monthCompare', monthCompare), weekdayProfile: memoized('weekdayProfile', weekdayProfile),
    deptDayHeat: memoized('deptDayHeat', deptDayHeat),
    personSummary: memoized('personSummary', personSummary), excTrend: memoized('excTrend', excTrend),
    spStructure: memoized('spStructure', spStructure), excDetailRows: memoized('excDetailRows', excDetailRows),
    workLoad: memoized('workLoad', workLoad), deptCompare: memoized('deptCompare', deptCompare),
    person: memoized('person', person), agg0: agg0, clearCache: function () { cache = { sig: null, days: null, memo: {} }; }
  };
  S = global.Store; U = global.U;
})(window);

/* 指标层自测：零依赖，直接跑 web/js 里的真实代码（不启浏览器）。
   用法：node tests/test_metrics.js [data/checkin_data.json]
   数据文件不存在时会跳过（先执行 python3 tools/make_demo_data.py）。 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..');
var DATA = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'data', 'checkin_data.json');

var pass = 0, fail = 0, skipped = [];
function ok(cond, name, extra) {
  if (cond) { pass++; return true; }
  fail++;
  console.log('  ✗ ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra)));
  return false;
}
function eq(actual, expected, name) {
  return ok(actual === expected, name, { actual: actual, expected: expected });
}
function same(actual, expected, name) {
  var a = JSON.stringify(actual), b = JSON.stringify(expected);
  return ok(a === b, name, { actual: a, expected: b });
}
function near(actual, expected, tol, name) {
  return ok(typeof actual === 'number' && Math.abs(actual - expected) <= tol, name,
    { actual: actual, expected: expected, tol: tol });
}
function section(t) { console.log('\n' + t); }
function group(name, fn) {
  try { fn(); } catch (e) {
    fail++;
    console.log('  ! ' + name + ' 抛异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
  }
}

if (!fs.existsSync(DATA)) {
  console.log('跳过：' + DATA + ' 不存在。先执行 python3 tools/make_demo_data.py 生成演示数据。');
  process.exit(0);
}

/* ---------------- 装载被测代码（和浏览器同一份源码） ---------------- */
var sandbox = { console: console, JSON: JSON, Math: Math, Date: Date, isNaN: isNaN, isFinite: isFinite,
  fetch: function () { return Promise.reject(new Error('测试不发网络请求')); },
  setTimeout: setTimeout, URL: URL, Blob: typeof Blob !== 'undefined' ? Blob : function () {} };
sandbox.window = sandbox;
vm.createContext(sandbox);
['web/js/store.js', 'web/js/attendance.js', 'web/js/metrics.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
});
var Store = sandbox.Store, U = sandbox.U, M = sandbox.Metrics;
var raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));

function ingest(payload) { Store.ingest(payload || raw); return Store; }
function setFilters(patch) { Object.assign(Store.filters, patch); Store.applyFilters(); }
function fullRange() { setFilters({ start: Store.range.start, end: Store.range.end, dept: '全部', group: '全部', scope: 'all' }); }
function uniq(arr) { return Object.keys(arr.reduce(function (m, x) { m[x] = 1; return m; }, {})); }
function sum(arr) { return arr.reduce(function (a, b) { return a + b; }, 0); }

/* ---------------- 工具函数 ---------------- */
section('U 工具函数');
group('weekKey', function () {
  eq(U.weekKey('2026-08-28'), '2026-W35', '周五 ISO 周');
  eq(U.weekKey('2026-08-03'), '2026-W32', '周一 ISO 周');
  eq(U.weekKey('2025-12-29'), '2026-W01', '上一年末仍属新年 ISO 第 1 周');
  eq(U.weekKey('2026-01-01'), '2026-W01', '1 月 1 日');
});
group('时刻格式化', function () {
  eq(U.fmtMin(0), '00:00', '0 点');
  eq(U.fmtMin(570), '09:30', '常规时刻');
  eq(U.fmtMin(1500), '次日01:00', '跨天显示为次日');
  eq(U.fmtMin(null), '-', '空值');
  eq(U.fmtOffset(0), '准点', '0 偏移');
  eq(U.fmtOffset(-12), '-12′', '提前到岗');
  eq(U.fmtHourSec(7200), '2.0h', '秒转小时');
  eq(U.pct(1, 4), '25.0%', '百分比');
});
group('几何与文本', function () {
  var sh = { lat: 31.2304, lng: 121.4737 }, bj = { lat: 39.9042, lng: 116.4074 };
  var km = U.haversine(sh, bj) / 1000;
  ok(km > 1050 && km < 1090, '上海-北京球面距离约 1068km', Math.round(km));
  eq(U.haversine(sh, { lat: null, lng: 1 }), null, '缺坐标返回 null');
  eq(U.extractCity('深圳市南山区科苑南路'), '深圳市', '解析城市');
  eq(U.extractCity(''), '未知', '空文本');
  eq(U.classifyPlace({ type: U.TYPE_OUT, location_title: '某地' }, null), '外勤现场', '外出打卡算外勤');
  eq(U.classifyPlace({ type: U.TYPE_IN, location_title: '腾讯大厦', wifiname: 'x' },
    { name: '腾讯大厦', wifi: 'y' }), '主办公点', '同名地点算主办公点');
  eq(U.classifyPlace({ type: U.TYPE_IN, location_title: '阳光花园 3 栋' }, { name: '腾讯大厦', wifi: 'y' }),
    '住宅区', '住宅关键词');
  eq(U.addDays('2026-02-28', 1), '2026-03-01', '跨月加天数');
  eq(U.dayDiff('2026-03-01', '2026-03-05'), 4, '日期差');
});

/* ---------------- 数据装载 ---------------- */
section('Store 装载与筛选');
ingest();
ok(Store.recordsAll.length > 0, '有打卡记录', Store.recordsAll.length);
eq(Store.range.start, uniq(Store.recordsAll.map(function (r) { return r.date; })).sort()[0], 'range.start');
eq(Store.filters.end, Store.range.end, '默认筛选到区间末');
ok(Store.depts.length >= 1, '部门列表');
ok(Object.keys(Store.users).length >= 1, '人员字典');
var allStaff = uniq(Store.recordsAll.map(function (r) { return r.userid; })).length;

group('筛选生效', function () {
  var dept = Store.depts[0];
  setFilters({ dept: dept });
  ok(Store.records.every(function (r) { return r.dept === dept; }), '部门筛选后只剩该部门');
  ok(Store.daily.every(function (d) { return d.dept === dept; }), '日报同步过滤');
  fullRange();
  eq(Store.records.length, Store.recordsAll.filter(function(r){var date=r.attendance_date||r.date;return date>=Store.filters.start&&date<=Store.filters.end&&!r.is_placeholder && String(r.exception||'').indexOf('未打卡')<0;}).length, '还原当前归属日内全部实际打卡，保留占位原始记录但不计打卡动作');
  setFilters({ scope: 'office' });
  ok(Store.records.every(function (r) { return r.type !== U.TYPE_OUT; }), '仅上下班口径剔除外出打卡');
  setFilters({ scope: 'outside' });
  ok(Store.records.every(function (r) { return r.type === U.TYPE_OUT; }), '仅外勤口径只留外出');
  fullRange();
});

group('主办公点索引随筛选失效', function () {
  fullRange();
  var uid = uniq(Store.records.filter(function (r) { return r.type === U.TYPE_IN && r.lat != null; })
    .map(function (r) { return r.userid; }))[0];
  ok(!!Store.mainOffice(uid), '能取到主办公点');
  setFilters({ scope: 'outside' });
  eq(Store.mainOffice(uid), null, '仅外勤口径下没有上班打卡，主办公点应为空');
  fullRange();});

/* ---------------- 人日与官方口径 ---------------- */
section('人日模型（metrics.buildDays）');
var days = M.days();
group('结构', function () {
  ok(days.length > 0, '有人日', days.length);
  eq(uniq(days.map(function (d) { return d.key; })).length, days.length, 'key 唯一（日期+人）');
  ok(days.every(function (d) { return U.EXC_TYPES.every(function (t) { return typeof d.exc[t] === 'number'; }); }),
    '六类异常计数齐全');
  ok(days.every(function(d){return d.isWorkday===(d.expected===true);}), '工作日来自核定排班，而非硬编码星期');
  eq(days.length, Store.staffIds.length*(U.dayDiff(Store.filters.start,Store.filters.end)+1), '全员×自然日完整底表');
});
group('官方口径优先', function () {
  var withDaily = days.filter(function (d) { return d.hasDaily; });
  ok(withDaily.length > 0, '有日报可用');
  var bad = withDaily.filter(function (d) {
    var row = Store.dailyIndex[d.date + '|' + d.userid];
    return U.EXC_TYPES.some(function (t) {
      var off = row.exceptions && row.exceptions[t];
      return off && d.exc[t] !== +off.count;
    });
  });
  eq(bad.length, 0, '有日报时异常次数直接取日报官方值', bad.slice(0, 2));
  eq(uniq(withDaily.map(function (d) { return d.stdIn; })).length > 0, true, '标准上班时刻来自日报');
});
group('无日报时保留未知，不伪造官方异常', function () {
  var saved = Store.dailyAll;
  Store.dailyAll = [];
  Store.applyFilters();
  var d2 = M.days();
  ok(d2.every(function (d) { return !d.hasDaily; }), '无日报标记');
  var miss = d2.filter(function (d) { return d.exc['缺卡'] > 0; });
  eq(miss.length,0,'没有日报不生成核定缺卡');
  ok(d2.every(function(d){return d.workSec===null && !d.officialKnown;}),'无日报工时和官方核定状态明确缺失');
  ok(d2.every(function (d) { return d.exc['缺卡'] <= 2; }), '单日缺卡最多 2 次');
  Store.dailyAll = saved;
  Store.applyFilters();
});

/* ---------------- 汇总一致性 ---------------- */
section('汇总口径一致性');
group('agg()', function () {
  var a = M.agg(days);
  eq(a.personDays, days.filter(function(d){return d.present;}).length, '有效出勤人日数');
  eq(a.lateRate, a.ratePersonDays ? a.lateDays/a.ratePersonDays : null, '迟到率=核定异常人日/核定应出勤，不因其他日期未知隐藏');
  eq(a.headcount, Store.staffIds.length, '在册人数');
  ok(a.ratePersonDays ? a.attendanceRate>=0 && a.attendanceRate<=1 : a.attendanceRate===null, '仅核定分母为空时不出率', a.attendanceRate);
  eq(a.placeCount, uniq(Store.records.map(function (r) { return r.location_title; }).filter(Boolean)).length, '打卡地点数');
  eq(a.noGeo, Store.records.filter(function (r) { return !U.validCoord(r); }).length, '无坐标打卡次数');
  eq(a.excTotal, sum(days.map(function (d) { return U.EXC_TYPES.reduce(function (s, t) { return s + d.exc[t]; }, 0); })),
    '异常合计');
  eq(a.seriousExc, a.absent + a.placeExc + a.devExc, '旷工+地点+设备合计');
  ok(a.workSec > 0, '实际工时合计');
});
group('KPI 卡片', function () {
  var k = M.kpis();
  eq(k.length, 15, '15 张 KPI 卡');
  ok(k.every(function (x) { return x.label && x.val !== undefined && x.val !== null; }), '标签与取值齐全');
  var noSpark = k.filter(function (x) { return !x.spark || x.spark.filter(function (v) { return v != null && !isNaN(v); }).length < 2; });
  ok(noSpark.every(function(x){return x.val==='—'||M.agg(days).missingDaily>0;}),'数据未知时允许趋势断点，不填假零');
  var noTrend = k.filter(function (x) { return !x.trend; });
  ok(noTrend.every(function(x){return x.val==='—'||M.agg(days).missingDaily>0||x.label==='平均离岗时刻';}),'不可比区间不强制生成环比');
  ok(Math.max.apply(null, k.map(function (x) { return x.spark.length; })) <= 14, '迷你趋势最多 14 天',
    Math.max.apply(null, k.map(function (x) { return x.spark.length; })));
  var att = M.seriesByDate(days, 'attendance');
  var num = att.filter(function (v) { return v != null; });
  ok(num.every(function (v) { return v >= 0 && v <= 100; }), '已核定出勤率趋势范围', num.slice(0, 3));
  ok(num.length || M.agg(days).unknownSchedule>0, '没有可核定趋势时必须有排班缺口');
});
group('seriesByDate', function () {
  var dates = uniq(days.map(function (d) { return d.date; })).sort();
  eq(M.seriesByDate(days, 'head').length, dates.length, '按日期逐日给值');
  eq(M.seriesByDate(days, 'attendance').length, dates.length, '出勤率逐日');
  var late = M.seriesByDate(days, 'late');
  var date0 = uniq(days.map(function (d) { return d.date; })).sort()[0];
  var rows0 = days.filter(function (d) { return d.date === date0; });
  var a0=M.agg(rows0);eq(late[0],a0.lateRate==null?null:a0.lateRate*100,'迟到趋势与总览使用同一人日率口径');
  ok(late.every(function (v) { return v >= 0 && v <= 100; }), '迟到趋势是 0~100 的比率');
  ok(M.seriesByDate(days, 'places').every(function (v) { return v >= 1; }), '每日地点数');
  eq(M.seriesByDate(days, 'noGeo').reduce(function (a, b) { return a + b; }, 0),
    Store.records.filter(function (r) { return !U.validCoord(r); }).length, '无坐标趋势求和=总无坐标数');
});

/* ---------------- 时间维度 ---------------- */
section('时间维度');
group('offsetHist', function () {
  ['in', 'out'].forEach(function (which) {
    var h = M.offsetHist(which, which === 'in' ? 24 : 30);
    ok(h.labels.length === h.values.length, '分箱标签与取值等长');
    ok(h.zeroIndex >= 0 && h.zeroIndex < h.values.length, '标准时刻分箱在范围内', [which, h.zeroIndex]);
    var inside = h.values.reduce(function (a, b) { return a + b; }, 0);
    var clipped = days.filter(function (d) {
      var v = which === 'in' ? d.offsetIn : d.offsetOut;
      return v != null && isFinite(v);
    }).length;
    eq(inside, clipped, '分箱总数=参与统计的人日（' + which + '）');
  });
});
group('其他时间图', function () {
  var h = M.hourDist();
  eq(h.types.length, 3, '上班/外出/下班三系列');
  eq(sum(h.data.reduce(function (a, b) { return a.concat(b); }, [])), Store.records.length, '0-23 时分布=全部打卡次数');
  var wd = M.wdHourHeat();
  eq(wd.data.length, 7 * 24, '星期×小时 168 格');
  var box = M.boxByWeek();
  ok(box.weeks.length <= 12, '箱线图最多 12 周');
  ok(box.arrive.filter(function (v) { return v.length; }).every(function (v) { return v.length === 5; }), '箱体五元组');
  ok(box.arrive.filter(function (v) { return v.length; }).every(function (v) { return v[0] <= v[1] && v[1] <= v[2] && v[2] <= v[3] && v[3] <= v[4]; }), '箱体数值有序');
  var sc = M.scatterTime();
  ok(sc.pts.every(function (p) { return p[1] > p[0]; }), '散点离岗晚于到岗');
  var at = M.avgTimesSeries();
  eq(at.dates.length, uniq(days.map(function (d) { return d.date; })).length, '平均到岗离岗按日');
  ok(at.arrive.filter(function (v) { return v != null; }).every(function (v) { return v > 240 && v < 1080; }), '平均到岗在合理时段');
});

/* ---------------- 地点维度 ---------------- */
section('地点维度');
group('placeStat', function () {
  var p = M.placeStat('all');
  ok(U.validCoord({ lat: 39.9, lng: 116.4 }), '中国境内 GCJ-02 坐标有效');
  ok(!U.validCoord({ lat: 0, lng: 0 }) && !U.validCoord({ lat: -41.3, lng: 174.8 }), '占位/脏坐标无效');
  ok(p.recs.length > 0, '有带坐标的打卡');
  ok(p.recs.every(function (r) { return r.lat != null && r.lng != null; }), '热力图数据点都有坐标');
  ok(p.recs.every(U.validCoord), '热力图数据点坐标在中国境内有效范围');
  eq(sum(p.distBuckets.map(function (b) { return b.count; })), p.distCount, '距离分箱总数=参与计算次数');
  eq(p.noGeo, Store.records.length - p.recs.length, '无坐标次数=总次数-带坐标次数');
  ok(p.clusters.length > 0 && p.clusters[0].count >= p.clusters[p.clusters.length - 1].count, '地点聚合按次数降序');
  ok(p.top.length <= 25, '地点排行最多 25');
  var outside = M.geoRecords('all').filter(function (r) { return r.type === U.TYPE_OUT; });
  ok(p.typeComp['外勤现场'] >= outside.length, '带坐标的外出打卡归入外勤现场');
  ok(outside.every(function (r) { return U.classifyPlace(r, Store.mainOffice(r.userid)) === '外勤现场'; }), '每条外出打卡分类正确');
});
group('人员活动地点多样性', function () {
  var p = M.placeStat('all');
  ok(p.diversity.length === uniq(p.recs.map(function (r) { return r.userid; })).length, '覆盖所有带坐标的人');
  var multi = p.diversity.filter(function (d) { return d.cities > 1; });
  ok(multi.length > 0, '涉及城市数按每条打卡解析（回归：曾固定取第一条）', multi.slice(0, 2));
  var worst = p.diversity.filter(function (d) { return d.cities > d.places; });
  eq(worst.length, 0, '城市数不会多于地点数', worst.slice(0, 2));
  ok(p.diversity.every(function (d) { return d.places >= 1 && d.punches >= 1; }), '每人至少 1 个地点');
});
group('坐标筛选与类型筛选', function () {
  var excOnly = M.geoRecords('exc');
  ok(excOnly.every(function (r) { return !!r.exception; }), '仅异常打卡');
  ok(excOnly.length <= M.geoRecords('all').length, '异常子集');
  eq(M.geoRecords('in').every(function (r) { return r.type === U.TYPE_IN; }), true, '上班打卡子集');
  setFilters({ scope: 'outside' });
  var out = M.placeStat('outside');
  ok(out.recs.every(function (r) { return r.type === U.TYPE_OUT; }), '仅外勤口径下地点只含外出打卡');
  fullRange();
});

/* ---------------- 趋势与对比 ---------------- */
section('趋势与对比');
group('dailySeries', function () {
  var s = M.dailySeries();
  var dates = uniq(days.map(function (d) { return d.date; })).sort();
  eq(s.length, dates.length, '逐日一条');
  eq(s.map(function (d) { return d.date; }).join(','), dates.join(','), '日期升序且无缺日');
  ok(s.filter(function (d) { return !d.isWorkday; }).every(function (d) { return d.attendanceRate === null; }),
    '休息日不计算出勤率（断点而非 0）');
  ok(s.filter(function (d) { return d.isWorkday; }).every(function (d) { return d.ratePersonDays?d.attendanceRate>=0 && d.attendanceRate<=1:d.attendanceRate===null; }),
    '每天按核定分母计算，其他人的未知日期不阻断');
  ok(s.every(function (d) { return d.present >= 0 && d.present <= Store.staffIds.length; }), '出勤人数不超过在册人数');
});
group('周/月/星期', function () {
  var w = M.weekCompare();
  ok(w.length > 0 && w.length <= uniq(days.map(function (d) { return d.week; })).length, 'ISO 周汇总');
  eq(w.map(function (x) { return x.week; }).join(','), uniq(w.map(function (x) { return x.week; })).sort().join(','), '按周升序');
  var m = M.monthCompare();
  ok(m.length >= 1, '月度对比');
  ok(m.every(function (x) { return x.attendanceRate <= 1 && x.lateRate >= 0; }), '月度比率有效');
  var wd = M.weekdayProfile();
  eq(wd.length, 7, '周一~周日 7 条');
  eq(wd.map(function (x) { return x.name; }).join(','), '周一,周二,周三,周四,周五,周六,周日', '星期名称顺序');
});
group('部门×日期热力', function () {
  var h = M.deptDayHeat();
  eq(h.data.length, h.depts.length * h.dates.length, '格子数=部门×日期');
  ok(h.data.every(function (c) { return c[2] === null || (c[2] >= 0 && c[2] <= 100); }), '出勤率百分比或空');
  var dh = M.deptHourHeat();
  eq(dh.data.length, dh.depts.length * 24, '部门×小时格子数');
});

/* ---------------- 异常与人员 ---------------- */
section('异常与人员');
group('personSummary', function () {
  var p = M.personSummary();
  eq(p.length, Store.staffIds.length, '每人一条');
  eq(sum(p.map(function (x) { return x.personDays; })), days.filter(function(d){return d.present;}).length, '有效出勤人日合计');
  ok(p.every(function (x, i) { return i === 0 || p[i - 1].excRate >= x.excRate; }), '按人均异常次数降序');
  ok(p.every(function (x) { return x.attendanceRate <= 1.0001; }), '个人出勤率不超过 100%');
  ok(p.every(function (x) { return x.excTotal >= 0 && x.places >= 0; }), '取值非负');
});
group('异常明细行', function () {
  var rows = M.excDetailRows();
  ok(rows.length > 0, '有异常明细', rows.length);
  ok(rows.every(function (r) { return U.EXC_TYPES.indexOf(r.type) >= 0; }), '异常类型合法');
  ok(rows.every(function (r) { return r.count > 0; }), '次数为正');
  ok(rows.every(function (r) { return typeof r.durSec === 'number'; }), '带数值时长供排序');
  ok(rows.every(function (r) { return r.date >= Store.filters.start && r.date <= Store.filters.end; }), '只含筛选区间');
  var expected = days.reduce(function (s, d) {
    return s + U.EXC_TYPES.filter(function (t) { return (d.exc[t] || 0) > 0; }).length;
  }, 0);
  eq(rows.length, expected, '每个「人日×异常类型」一行');
});
group('假勤/外勤结构', function () {
  var sp = M.spStructure();
  ok(sp.length >= 1, '有假勤/外勤构成');
  ok(sp.every(function (p) { return p[1] > 0; }), '次数为正');
});
group('部门对比', function () {
  var d = M.deptCompare();
  eq(sum(d.map(function (x) { return x.head; })), Store.staffIds.length, '部门人数合计=在册人数');
  ok(d.every(function (x) { return x.attendanceRate <= 1.0001 && x.lateRate <= 1 && x.missRate <= 1; }), '比率合法');
  ok(d.every(function (x) { return x.head > 0 && x.personDays>=0; }), '无出勤部门也保留其应考勤人数');
});

/* ---------------- 工时与加班 ---------------- */
section('工时与加班');
group('workLoad', function () {
  var w = M.workLoad();
  eq(sum(w.workHist.map(function (b) { return b.count; })), days.filter(function(d){return d.workSec!=null&&(d.expected||d.present);}).length, '工时分箱仅含有官方工时的工作日或出勤人日');
  ok(w.streak.every(function (r) { return r.streak >= 1 && r.streak <= r.days; }), '连续在岗不超过在岗天数');
  ok(w.streak.every(function (r) { return r.restDays >= 0; }), '休息日在岗天数非负');
  ok(w.otRank[0].otHours >= w.otRank[w.otRank.length - 1].otHours, '加班排行降序');
  var byDay = w.night.filter(function (n) { return n.avg != null; });
  ok(byDay.every(function (n) { return n.avg >= 600 && n.avg <= 1500; }), '平均离岗时刻合理', byDay.slice(0, 2));
  ok(byDay.every(function (n) { return n.over23 <= n.over21; }), '23 点后人数不超过 21 点后人数');
  ok(sum(w.otComp.map(function (x) { return x.hours; })) >= 0, '加班构成可求和');
});

/* ---------------- 个人画像 ---------------- */
section('个人画像');
group('person()', function () {
  var uid = M.personSummary()[0].userid;
  var p = M.person(uid);
  eq(p.kpi.length, 9, '9 个个人 KPI');
  var mine = days.filter(function (d) { return d.userid === uid; });
  eq(p.time.length, mine.length, '时间线行数=该人人日数');
  ok(p.exc.every(function (r) { return r.userid === uid; }), '明细只含本人');
  ok(p.places.length <= 12, '个人 TOP12 地点');
  eq(sum(p.cal.map(function (c) { return c[1]; })), sum(mine.map(function (d) { return d.punches; })), '日历热力=个人打卡总次数');
});

/* ---------------- 缓存与筛选联动 ---------------- */
section('缓存与筛选联动');
group('派生结果随筛选失效', function () {
  fullRange();
  var all = M.personSummary().length;
  var dept = Store.depts[0];
  setFilters({ dept: dept });
  var one = M.personSummary().length;
  ok(one < all, '切到单个部门后人员汇总变小', [one, all]);
  ok(M.days().every(function (d) { return d.dept === dept; }), '人日也只剩该部门');
  fullRange();
  eq(M.personSummary().length, all, '还原后恢复全量');
  ok(M.days() === M.days(), '同一筛选条件下人日数组复用（缓存生效）');
});
group('空结果不崩', function () {
  setFilters({ start: '2020-01-01', end: '2020-01-02' });
  eq(M.days().filter(function(d){return d.present;}).length, 0, '区间外无出勤证据');
  eq(M.kpis().length, 15, 'KPI 仍然渲染（显示为 0/空）');
  eq(M.excDetailRows().length, 0, '无异常明细');
  eq(M.placeStat('all').recs.length, 0, '无地点');
  eq(M.personSummary().length, Store.staffIds.length, '无记录区间仍保留全体人员，不能隐去');
  fullRange();
  ok(M.days().length > 0, '恢复后又有数据');
});

console.log('\n================================');
console.log('指标层自测：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (skipped.length) console.log('跳过：' + skipped.join(', '));
console.log('数据：' + path.relative(ROOT, DATA) + ' 人日 ' + Store.records.length + ' 条打卡 / ' + M.days().length + ' 人日');
if (fail) console.log('结果：FAILED');
process.exit(fail ? 1 : 0);

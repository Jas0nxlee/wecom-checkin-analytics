/* 数据层：加载接口数据、维护筛选状态、构建索引与派生字段 */
(function (global) {
  'use strict';

  var EXC_TYPES = ['迟到', '早退', '缺卡', '旷工', '地点异常', '设备异常'];
  var EXC_COLOR = { '迟到': '#e59118', '早退': '#5b8dff', '缺卡': '#e14b4b', '旷工': '#8b3fd6', '地点异常': '#12a06a', '设备异常': '#39b6c4' };
  var TYPE_IN = '上班打卡', TYPE_OUT = '外出打卡', TYPE_OFF = '下班打卡';

  var Store = {
    raw: null,          // 原始接口数据
    meta: {},           // 数据源元信息
    records: [],        // 过滤后的打卡记录
    daily: [],          // 过滤后的打卡日报
    dailyIndex: {},     // 'date|userid' -> daily 行
    users: {},          // userid -> user
    depts: [],
    groups: [],
    filters: { start: null, end: null, dept: '全部', group: '全部', scope: 'all' },
    range: { start: null, end: null },   // 数据可用区间
    listeners: []
  };

  /* ---------------- 通用工具 ---------------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDate(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(s, n) { var d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); }
  function dayDiff(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
  function fmtMin(m) {
    if (m === null || m === undefined || isNaN(m)) return '-';
    var t = Math.round(m), h = Math.floor(t / 60) % 24, mm = t % 60, s = pad(h) + ':' + pad(mm);
    return Math.floor(t / 60) >= 24 ? '次日' + pad(Math.floor(t / 60) - 24) + ':' + pad(mm) : s;
  }
  function fmtOffset(m) {
    if (m === null || m === undefined || isNaN(m)) return '-';
    m = Math.round(m);
    if (m === 0) return '准点';
    return (m > 0 ? '+' : '-') + Math.abs(m) + '′';
  }
  function fmtHourSec(sec) {
    if (!sec) return '0h';
    var h = sec / 3600;
    return (h >= 10 ? h.toFixed(0) : h.toFixed(1)) + 'h';
  }
  function pct(a, b, digits) { return b ? (a / b * 100).toFixed(digits === undefined ? 1 : digits) + '%' : '-'; }
  function sum(arr, f) { return arr.reduce(function (s, x) { return s + (f ? f(x) : x); }, 0); }
  function mean(arr) { return arr.length ? sum(arr) / arr.length : 0; }
  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function uniq(arr) { return Object.keys(arr.reduce(function (m, x) { m[x] = 1; return m; }, Object.create(null))); }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function rateText(value, digits) { return value == null || !isFinite(value) ? '—' : (value * 100).toFixed(digits == null ? 1 : digits); }
  function groupBy(arr, keyFn) {
    var out = Object.create(null);
    arr.forEach(function (x) { var k = keyFn(x); (out[k] || (out[k] = [])).push(x); });
    return out;
  }
  function countBy(arr, keyFn) {
    var out = Object.create(null);
    arr.forEach(function (x) { var k = keyFn(x); out[k] = (out[k] || 0) + 1; });
    return out;
  }
  function topN(obj, n) {
    return Object.keys(obj).map(function (k) { return [k, obj[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, n);
  }
  /* 企业微信打卡坐标是中国境内 GCJ-02 微度数；0/0、负纬度等占位值不能送进地图投影。 */
  function validCoord(p) {
    if (!p) return false;
    var lat = Number(p.lat), lng = Number(p.lng);
    return isFinite(lat) && isFinite(lng) && lat > 0 && lat <= 60 && lng >= 70 && lng <= 140;
  }
  function weekKey(dateStr_) {
    var d = parseDate(dateStr_), target = new Date(d.getTime());
    target.setDate(target.getDate() + 3 - ((d.getDay() + 6) % 7));      // ISO: 周四所在周
    var first = new Date(target.getFullYear(), 0, 1);
    var n = Math.ceil(((target - first) / 86400000 + 1) / 7);
    return target.getFullYear() + '-W' + pad(n);
  }
  function weekdayCN(i) { return ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][i]; }
  function haversine(a, b) {
    if (!validCoord(a) || !validCoord(b)) return null;
    var R = 6371008.8, d2r = Math.PI / 180;
    var dLat = (b.lat - a.lat) * d2r, dLng = (b.lng - a.lng) * d2r;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * d2r) * Math.cos(b.lat * d2r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /* 地点分类：公司/主办公点、外勤现场、家（WiFi 或异地）、其他 */
  var OFFICE_WORDS = ['大厦', '科技园', '科学园', '软件园', '总部', '办公', '产业园', '写字楼', '中心', '厂区', '工厂', '公司'];
  var FIELD_WORDS = ['客户', '门店', '现场', '项目', '工厂', '仓', '4S', '医院', '学校', '政府', '银行', '营业部', '支行', '分厂'];
  function classifyPlace(rec, mainOffice) {
    var t = (rec.location_title || '') + (rec.location_detail || '');
    if (rec.type === TYPE_OUT) return '外勤现场';
    if (mainOffice && (rec.location_title === mainOffice.name || t.indexOf(mainOffice.name.slice(0, 4)) >= 0)) return '主办公点';
    if (rec.wifiname && mainOffice && rec.wifiname === mainOffice.wifi) return '主办公点';
    for (var i = 0; i < FIELD_WORDS.length; i++) { if (t.indexOf(FIELD_WORDS[i]) >= 0) return '外勤现场'; }
    for (var j = 0; j < OFFICE_WORDS.length; j++) { if (t.indexOf(OFFICE_WORDS[j]) >= 0) return '其他办公点'; }
    if (/小区|苑|府|花园|公寓|家园|村|住宅|里\d|号楼/.test(t)) return '住宅区';
    return '其他地点';
  }
  function extractCity(detail) {
    if (!detail) return '未知';
    var s = String(detail).replace(/^(?:中国)?(?:[\u4e00-\u9fa5]{2,10}?(?:省|自治区|特别行政区))?/, '');
    var m = /([\u4e00-\u9fa5]{2,8}?(?:市|自治州|地区|盟))/.exec(s);
    if (m) return m[1];
    var m2 = /^([\u4e00-\u9fa5]{2,4}(?:市|区|县))/.exec(s);
    return m2 ? m2[1] : '未知';
  }
  function excList(str) {
    if (!str) return [];
    var out = [];
    String(str).split(/[;；]/).forEach(function (s) {
      s = s.trim(); if (!s) return;
      if (s.indexOf('时间异常') >= 0) out.push('时间异常');
      else if (s.indexOf('地点异常') >= 0) out.push('地点异常');
      else if (s.indexOf('wifi') >= 0 || s.indexOf('WiFi') >= 0) out.push('WiFi异常');
      else if (s.indexOf('设备') >= 0) out.push('设备异常');
      else out.push(s);
    });
    return out;
  }

  /* ---------------- 加载与过滤 ---------------- */
  /* 把接口返回的数据集装进 Store（不拉网络），浏览器与 tests/test_metrics.js 共用同一条路径 */
  Store.ingest = function (payload) {
    Store.raw = payload;
    Store.meta = payload.meta || {};
    Store.version = (Store.version || 0) + 1;
    if (global.Metrics) global.Metrics.clearCache();
    Store.users = Object.create(null);
    (payload.users || []).forEach(function (u) { Store.users[u.userid] = u; });
    function current(row) { var u = Store.users[row.userid]; return Object.assign({}, row, u ? {name:u.name || row.name,dept:u.main_dept || row.dept} : {}); }
    Store.recordsAll = (payload.records || []).map(current);
    Store.dailyAll = (payload.daily || []).map(current);
    var dayLookup={};Store.dailyAll.forEach(function(d){dayLookup[d.date+'|'+d.userid]=d;});
    var ruleLookup={};(payload.rules||[]).forEach(function(r){ruleLookup[r.date+'|'+r.userid]=r;});
    Store.recordsAll.forEach(function(r){
      if(r.type!==TYPE_OFF)return;
      var prev=addDays(r.date,-1), prior=dayLookup[prev+'|'+r.userid]||ruleLookup[prev+'|'+r.userid];
      if(prior && (prior.segments||[]).some(function(s){return s.off_work_sec>=86400 && Number(r.minute_of_day)<=s.off_work_sec/60-1440;}))r.attendance_date=prev;
    });
    var dates = uniq(Store.recordsAll.map(function (r) { return r.date; })).sort();
    Store.range = { start: Store.meta.start || dates[0], end: Store.meta.end || dates[dates.length - 1] };
    Store.users = Object.create(null);
    (payload.users || []).forEach(function (u) { Store.users[u.userid] = u; });
    Store.depts = uniq(Object.keys(Store.users).map(function(uid) { return Store.dept(uid); }).concat(Store.dailyAll.map(function(r){return r.dept || '未分组';}))).sort();
    Store.groups = uniq(Store.dailyAll.concat(payload.rules || []).map(function (r) { return r.groupname || '未分组'; })).sort();
    Store.filters = { start: Store.range.start, end: Store.range.end, dept: '全部', group: '全部', scope: 'all' };
    // 默认展示最近 30 天
    var last = parseDate(Store.range.end);
    var s = new Date(last.getTime() - 29 * 86400000);
    Store.filters.start = dateStr(s) < Store.range.start ? Store.range.start : dateStr(s);
    Store.applyFilters();
    return Store;
  };

  Store.load = function () {
    return fetch('/api/dataset').then(function (r) {
      return r.json().then(function (j) { if (!j.ok) throw new Error(j.error); return j; });
    }).then(function (j) { return Store.ingest(j.data); });
  };

  Store.inScope = function (r) {
    var sc = Store.filters.scope;
    if (sc === 'office') return r.type !== TYPE_OUT;
    if (sc === 'outside') return r.type === TYPE_OUT;
    return true;
  };

  Store.applyFilters = function () {
    Store.version = (Store.version || 0) + 1;
    var f = Store.filters;
    Store._mo = null;         // 主办公点会随筛选区间/口径变化，必须一起失效（null=待重建）
    Store.attendanceRecords = Store.recordsAll.filter(function (r) {
      var date = r.attendance_date || r.date;
      if (f.start && date < f.start) return false;
      if (f.end && date > f.end) return false;
      if (f.dept !== '全部' && r.dept !== f.dept) return false;
      if (f.group !== '全部' && (r.groupname || '未分组') !== f.group) return false;
      return true;
    });
    Store.daily = Store.dailyAll.filter(function (d) {
      if (f.start && d.date < f.start) return false;
      if (f.end && d.date > f.end) return false;
      if (f.dept !== '全部' && d.dept !== f.dept) return false;
      if (f.group !== '全部' && (d.groupname || '未分组') !== f.group) return false;
      return true;
    });
    Store.dailyIndex = Object.create(null);
    Store.daily.forEach(function (d) { Store.dailyIndex[d.date + '|' + d.userid] = d; });
    Store.records = Store.attendanceRecords.filter(function(r) { return Store.inScope(r) && !r.is_placeholder && String(r.exception || '').indexOf('未打卡') < 0; });
    Store.records.forEach(function(r) {
      var d=Store.dailyIndex[(r.attendance_date || r.date)+'|'+r.userid];
      r.effective_exception = d ? EXC_TYPES.filter(function(t) {
        if (!((d.exceptions || {})[t] || {}).count) return false;
        if ((r.exception || '').indexOf(t) >= 0) return true;
        return (r.exception || '').indexOf('时间异常') >= 0 && ((t==='迟到' && r.type===TYPE_IN) || (t==='早退' && r.type===TYPE_OFF));
      }).join(';') : '';
      r.effective_known = !!d;
    });
    Store.dates = []; for (var date=f.start; date && date<=f.end; date=addDays(date,1)) Store.dates.push(date);
    Store.staffIds = Object.keys(Store.users).filter(function(uid){ return f.dept==='全部' || Store.dept(uid)===f.dept; });
    if (!Store.staffIds.length && !Object.keys(Store.users).length) Store.staffIds=uniq(Store.attendanceRecords.concat(Store.daily).map(function(r){return r.userid;}));
    var deptOf = {};
    Store.staffIds.forEach(function(uid){deptOf[uid]=Store.dept(uid);});
    Store.deptOf = deptOf;
    Store.staffByDept = groupBy(Store.staffIds.map(function (id) {
      return Object.assign({}, Store.users[id] || { userid: id, name: id }, { dept: deptOf[id] || '未分组' });
    }), function (u) { return u.dept; });
    Store.emit();
  };

  Store.setRange = function (days) {
    if (days === 'all') { this.filters.start = this.range.start; this.filters.end = this.range.end; }
    else {
      var last = parseDate(this.range.end);
      var s = new Date(last.getTime() - (+days - 1) * 86400000);
      this.filters.start = dateStr(s) < this.range.start ? this.range.start : dateStr(s);
      this.filters.end = this.range.end;
    }
    this.applyFilters();
  };

  Store.on = function (fn) { this.listeners.push(fn); };
  Store.emit = function () { this.listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); };

  Store.name = function (uid) { return (this.users[uid] && this.users[uid].name) || uid; };
  Store.dept = function (uid) { return (this.users[uid] && (this.users[uid].main_dept || (this.users[uid].dept_names || [])[0])) || '未分组'; };

  /* 每个 userid 的主办公点：当前筛选区间内出现最多的“上班打卡”地点。
     一次构建索引（O(打卡次数)），避免地点分类/距离分箱时反复扫全量记录。 */
  function officeIndex() {
    if (this._mo) return this._mo;
    var cnt = Object.create(null), sample = Object.create(null);
    this.records.forEach(function (r) {
      if (r.type !== TYPE_IN || !validCoord(r)) return;
      var t = r.location_title || '未知';
      var c = cnt[r.userid] || (cnt[r.userid] = Object.create(null));
      c[t] = (c[t] || 0) + 1;
      var k = r.userid + '|' + t;
      if (!sample[k]) sample[k] = r;
    });
    var idx = Object.create(null);
    Object.keys(cnt).forEach(function (uid) {
      var t = topN(cnt[uid], 1)[0][0], r = sample[uid + '|' + t];
      idx[uid] = { name: t, wifi: r.wifiname, lat: r.lat, lng: r.lng };
    });
    this._mo = idx;
    return idx;
  }
  Store.mainOffice = function (uid) { return officeIndex.call(this)[uid] || null; };

  global.Store = Store;
  global.U = {
    pad: pad, dateStr: dateStr, parseDate: parseDate, addDays: addDays, dayDiff: dayDiff, fmtMin: fmtMin,
    fmtOffset: fmtOffset, fmtHourSec: fmtHourSec, pct: pct, sum: sum, mean: mean, quantile: quantile,
    uniq: uniq, groupBy: groupBy, countBy: countBy, topN: topN, weekKey: weekKey, weekdayCN: weekdayCN,
    haversine: haversine, classifyPlace: classifyPlace, extractCity: extractCity, excList: excList,
    validCoord: validCoord,
    escapeHtml: escapeHtml, rateText: rateText,
    EXC_TYPES: EXC_TYPES, EXC_COLOR: EXC_COLOR, TYPE_IN: TYPE_IN, TYPE_OUT: TYPE_OUT, TYPE_OFF: TYPE_OFF
  };
})(window);

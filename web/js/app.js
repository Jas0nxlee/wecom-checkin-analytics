/* 应用层：加载数据、渲染 KPI/表格、切换 tab、地图与抓取抽屉交互 */
(function (global) {
  'use strict';
  var S = null, U = null, M = null;
  var mapView = null, activeTab = 'overview', mapFitted = false;
  var tbl = { rows: [], sort: 'date', dir: -1, page: 0, size: 40 };
  var pollTimer = null;
  var correctionPage = 0;

  function $(id) { return document.getElementById(id); }
  function esc(v) { return global.U.escapeHtml(v); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function banner(msg, kind) {
    var b = $('banner');
    if (!msg) { b.classList.add('hidden'); return; }
    b.className = 'banner' + (kind === 'err' ? ' err' : '');
    b.textContent = msg;
  }

  /* ---------------- KPI ---------------- */
  function sparkSvg(input, color) {
    var vals = (input || []).filter(function (v) { return v != null && !isNaN(v); });
    if (vals.length < 2) return '';
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), span = (max - min) || 1;
    var pts = vals.map(function (v, i) {
      return (i / (vals.length - 1) * 100).toFixed(2) + ',' + (24 - (v - min) / span * 21).toFixed(2);
    });
    var area = 'M0,26 L' + pts.join(' L') + ' L100,26 Z';
    return '<svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none">' +
      '<path d="' + area + '" fill="' + color + '" fill-opacity=".13"/>' +
      '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>';
  }

  function renderKpis(target, list, small) {
    var box = $(target);
    box.innerHTML = '';
    list.forEach(function (k) {
      var cls = 'kpi' + (k.cls ? ' ' + k.cls : '');
      var color = k.cls === 'bad' ? '#e14b4b' : (k.cls === 'warn' ? '#e59118' : '#2f6fed');
      var foot = (k.trend ? '<span class="' + k.trend.cls + '">' + esc(k.trend.text) + '</span>' : '') + (k.foot ? '<span class="k-detail">'+esc(k.foot)+'</span>' : '');
      var spark = (!small && k.spark && k.spark.length > 3) ? sparkSvg(k.spark, color) : '';
      box.appendChild(el('div', cls,
        '<div class="k-label">' + k.label + '</div>' +
        '<div class="k-val">' + (k.val == null ? '-' : k.val) + (k.unit ? '<small>' + k.unit + '</small>' : '') + '</div>' +
        (foot ? '<div class="k-foot">' + foot + '</div>' : '') + spark));
    });
  }

  /* ---------------- 明细表 ---------------- */
  var TBL_COLS = [
    { k: 'date', t: '日期' }, { k: 'weekday', t: '星期' }, { k: 'name', t: '姓名' }, { k: 'dept', t: '部门' },
    { k: 'type', t: '异常类型' }, { k: 'count', t: '次数', num: 1 }, { k: 'durText', t: '时长' },
    { k: 'time', t: '打卡时刻' }, { k: 'std', t: '标准班次' }, { k: 'place', t: '地点' },
    { k: 'wifi', t: 'WiFi' }, { k: 'notes', t: '备注' }
  ];
  var SORT_KEY = { durText: 'durSec', time: 'timeMin' };   // 时长/时刻按数值排，避免“1.5h”排在“30′”后面
  function sortRows(rows) {
    var key = SORT_KEY[tbl.sort] || tbl.sort;
    return rows.sort(function (a, b) {
      var x = a[key], y = b[key];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * tbl.dir;
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return String(x).localeCompare(String(y), 'zh') * tbl.dir;
    });
  }

  /* 当前筛选（关键字 + 异常类型）下的异常明细，表格与 CSV 导出共用同一口径 */
  function filteredExceptionRows() {
    var q = ($('tblSearch').value || '').trim().toLowerCase();
    var f = $('tblExc').value;
    if (f === '外勤') return sortRows(spRows().filter(function(r){return !q || [r.name,r.dept,r.place,r.notes].join(' ').toLowerCase().indexOf(q)>=0;}));
    return sortRows(M.excDetailRows().filter(function (r) {
      if (f !== 'all' && r.type !== f) return false;
      if (!q) return true;
      return [r.name, r.dept, r.place, r.notes, r.wifi, r.type, r.date].join(' ').toLowerCase().indexOf(q) >= 0;
    }));
  }

  function renderTable() {
    var rows = tbl.rows = filteredExceptionRows();
    var pages = Math.max(1, Math.ceil(rows.length / tbl.size));
    if (tbl.page > pages - 1) tbl.page = 0;
    var slice = rows.slice(tbl.page * tbl.size, tbl.page * tbl.size + tbl.size);
    var thead = $('tbl').querySelector('thead');
    thead.innerHTML = '<tr>' + TBL_COLS.map(function (c) {
      return '<th data-k="' + c.k + '">' + c.t + (tbl.sort === c.k ? ' <span class="ar">' + (tbl.dir > 0 ? '▲' : '▼') + '</span>' : '') + '</th>';
    }).join('') + '</tr>';
    Array.prototype.forEach.call(thead.querySelectorAll('th'), function (th) {
      th.onclick = function () {
        var k = th.dataset.k;
        if (tbl.sort === k) tbl.dir = -tbl.dir; else { tbl.sort = k; tbl.dir = -1; }
        renderTable();
      };
    });
    var tagCls = { '迟到': 'late', '早退': 'early', '缺卡': 'miss', '旷工': 'miss', '地点异常': 'out', '设备异常': 'out', '外勤': 'out' };
    $('tbl').querySelector('tbody').innerHTML = slice.map(function (r) {
      return '<tr>' + TBL_COLS.map(function (c) {
        var raw = r[c.k] == null ? '' : String(r[c.k]), v = esc(raw);
        if (c.k === 'type') return '<td><span class="tag ' + (tagCls[v] || '') + '">' + v + '</span></td>';
        if (c.k === 'name') return '<td class="name" data-uid="' + esc(r.userid) + '">' + v + '</td>';
        if (c.k === 'place' || c.k === 'notes') return '<td title="' + v + '">' + esc(raw.length > 24 ? raw.slice(0,23)+'…' : raw) + '</td>';
        return '<td' + (c.num ? ' class="num"' : '') + '>' + v + '</td>';
      }).join('') + '</tr>';
    }).join('') || '<tr><td colspan="' + TBL_COLS.length + '" style="text-align:center;padding:20px;color:var(--sub)">无匹配记录</td></tr>';
    Array.prototype.forEach.call($('tbl').querySelectorAll('td.name'), function (td) {
      td.onclick = function () { showPerson(td.dataset.uid); };
    });
    $('tblCount').textContent = rows.length + ' 条';
    $('pgInfo').textContent = (rows.length ? (tbl.page + 1) : 0) + ' / ' + pages + ' 页';
    if ($('pgPrev')) $('pgPrev').disabled = tbl.page === 0;
    if ($('pgNext')) $('pgNext').disabled = tbl.page >= pages - 1;
  }
  function spRows() {
    var out = [];
    M.days().forEach(function (d) {
      if (!d.outside) return;
      d.records.filter(function (r) { return r.type === U.TYPE_OUT; }).forEach(function (r) {
        out.push({ date: d.date, weekday: U.weekdayCN((U.parseDate(d.date).getDay() + 6) % 7), name: d.name, dept: d.dept,
          type: '外勤', count: 1, durSec: 0, durText: '-', timeMin: r.minute_of_day,
          time: U.fmtMin(r.minute_of_day), std: d.stdIn ? U.fmtMin(d.stdIn) + '-' + U.fmtMin(d.stdOut) : '-',
          place: r.location_title, wifi: r.wifiname || '-', notes: r.notes || '', userid: d.userid });
      });
    });
    return out;
  }

  var DEPT_COLS = [
    { k: 'dept', t: '部门' }, { k: 'head', t: '人数', num: 1 }, { k: 'personDays', t: '出勤人日', num: 1 },
    { k: 'attendanceRate', t: '核定出勤率', fmt: 'pct' }, { k: 'lateRate', t: '迟到率', fmt: 'pct' },
    { k: 'ratePersonDays', t: '核定应出勤人日', num: 1 }, { k: 'dataCoverageRate', t: '依据覆盖率', fmt: 'pct' },
    { k: 'earlyRate', t: '早退率', fmt: 'pct' }, { k: 'missRate', t: '缺卡率', fmt: 'pct' },
    { k: 'avgWorkHours', t: '人均工时(h/人日)', fmt: 'h' }, { k: 'otHoursPerHead', t: '人均加班(h)', fmt: 'h' },
    { k: 'outsideRate', t: '外勤占比', fmt: 'pct' }, { k: 'avgArrive', t: '平均到岗', fmt: 'min' },
    { k: 'places', t: '打卡地点数', num: 1 }, { k: 'punches', t: '打卡次数', num: 1 }
  ];
  var deptSort = 'head', deptDir = -1;
  function renderDeptTable() {
    var rows = M.deptCompare().slice().sort(function (a, b) {
      var x = a[deptSort], y = b[deptSort];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * deptDir;
      return String(x).localeCompare(String(y), 'zh') * deptDir;
    });
    function fmt(c, v) {
      if (v == null) return '-';
      if (c.fmt === 'pct') return U.rateText(v) + '%';
      if (c.fmt === 'h') return v.toFixed(1);
      if (c.fmt === 'min') return U.fmtMin(v);
      return v;
    }
    var thead = $('deptTbl').querySelector('thead');
    thead.innerHTML = '<tr>' + DEPT_COLS.map(function (c) {
      return '<th data-k="' + c.k + '">' + c.t + (deptSort === c.k ? ' <span class="ar">' + (deptDir > 0 ? '▲' : '▼') + '</span>' : '') + '</th>';
    }).join('') + '</tr>';
    Array.prototype.forEach.call(thead.querySelectorAll('th'), function (th) {
      th.onclick = function () { if (deptSort === th.dataset.k) deptDir = -deptDir; else { deptSort = th.dataset.k; deptDir = -1; } renderDeptTable(); };
    });
    function cell(c, v, warnHigh) {
      var txt = fmt(c, v);
      var cls = '';
      if (v != null && c.fmt === 'pct' && warnHigh) cls = v > 0.15 ? 'style="color:var(--bad);font-weight:600"' : (v > 0.07 ? 'style="color:var(--warn);font-weight:600"' : '');
      if (v != null && c.fmt === 'pct' && warnHigh === false) cls = v < 0.85 ? 'style="color:var(--bad);font-weight:600"' : 'style="color:var(--ok)"';
      return '<td class="num" ' + cls + '>' + txt + '</td>';
    }
    $('deptTbl').querySelector('tbody').innerHTML = rows.map(function (r) {
      return '<tr>' + DEPT_COLS.map(function (c) {
        if (c.k === 'dept') return '<td><b>' + esc(r.dept) + '</b></td>';
        if (c.k === 'attendanceRate') return cell(c, r[c.k], false);
        if (c.k === 'dataCoverageRate') return cell(c, r[c.k]);
        return cell(c, r[c.k], ['lateRate', 'missRate', 'earlyRate'].indexOf(c.k) >= 0);
      }).join('') + '</tr>';
    }).join('');
  }

  /* ---------------- CSV 导出 ---------------- */
  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(cols, rows) {
    var lines = [cols.map(function (c) { return csvCell(c.t); }).join(',')];
    rows.forEach(function (r) { lines.push(cols.map(function (c) { return csvCell(r[c.k]); }).join(',')); });
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }
  function download(filename, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function stamp() { return (Store.meta.generated_at || '').replace(/[^0-9]/g, '').slice(0, 8) || 'export'; }
  function exportExceptionCsv() {
    var rows = filteredExceptionRows();
    if (!rows.length) { banner('当前筛选下没有异常明细可导出', 'err'); return 0; }
    download('checkin_exceptions_' + stamp() + '.csv', toCsv(TBL_COLS, rows));
    return rows.length;
  }

  /* ---------------- 个人画像 ---------------- */
  function showPerson(uid) {
    var p = M.person(uid);
    $('mTitle').innerHTML = esc(p.name) + ' <span class="hint">' + esc(p.dept) + '</span>';
    renderKpis('mKpi', p.kpi, true);
    Charts.person(uid);
    var cols = ['地点', '打卡次数'];
    $('mPlace').querySelector('thead').innerHTML = '<tr>' + cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr>';
    $('mPlace').querySelector('tbody').innerHTML = p.places.map(function (x) {
      var parts = x[0].split('｜');
      return '<tr><td title="' + esc(parts[1]) + '"><b>' + esc(parts[0]) + '</b><br><span class="hint">' + esc(parts[1]) + '</span></td><td class="num">' + x[1] + '</td></tr>';
    }).join('') || '<tr><td colspan="2" style="color:var(--sub);text-align:center">无打卡地点</td></tr>';
    var ec = ['日期', '星期', '类型', '次数', '时长', '时刻', '地点'];
    $('mExc').querySelector('thead').innerHTML = '<tr>' + ec.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr>';
    $('mExc').querySelector('tbody').innerHTML = p.exc.map(function (r) {
      return '<tr><td>' + r.date + '</td><td>' + r.weekday + '</td><td><span class="tag">' + r.type + '</span></td><td class="num">' + r.count +
        '</td><td>' + r.durText + '</td><td>' + r.time + '</td><td>' + esc(r.place || '-') + '</td></tr>';
    }).join('') || '<tr><td colspan="7" style="color:var(--sub);text-align:center">区间内无异常，表现良好</td></tr>';
    $('modal').classList.remove('hidden');
    setTimeout(function () { Charts.resizeAll(); }, 60);
  }

  /* ---------------- 地图 ---------------- */
  function renderMap(fit) {
    if (!mapView) mapView = new MapView($('map'));
    var type = $('mapType').value;
    Charts.setMapType(type);
    var p = M.placeStat(type);
    var pts = p.recs.filter(function (r) { return U.validCoord(r); }).map(function (r) {
      return { lat: r.lat, lng: r.lng, weight: 1, place: r.location_title || '未知地点',
        detail: r.location_detail || '', name: S.name(r.userid), dept: r.dept,
        type: r.type, time: r.datetime ? r.datetime.slice(5, 16) : '' };
    });
    mapView.mode = $('mapMode').value;
    mapView.heatSpread = Number($('mapSpread').value);
    updateMapAppearance();
    // 默认视野：打卡跨多座城市时先定位到打卡最多的城市，其余用「定位到城市」切换
    var cityOf = function (p) { return U.extractCity(p.detail || p.place); };
    var cityCount = Object.keys(U.countBy(pts, cityOf)).length;
    if (fit !== false && pts.length) {
      if (cityCount > 2) {
        var top = U.topN(U.countBy(pts, cityOf), 1)[0][0];
        var sub = pts.filter(function (p) { return cityOf(p) === top; });
        mapView.fit(sub.length >= 10 ? sub : pts);
      } else mapView.fit(pts);
    }
    mapView.clusters = p.clusters;
    mapView.points = pts;
    mapView.render();
    var cities = U.topN(U.countBy(p.recs, function (r) { return U.extractCity(r.location_detail || r.location_title); }), 12);
    // 地图 hover 也显示城市，便于定位
    var sel = $('mapFocus'), cur = sel.value;
    sel.innerHTML = '<option value="">定位到城市…</option>' + cities.map(function (c) {
      return '<option' + (c[0] === cur ? ' selected' : '') + ' value="' + c[0] + '">' + c[0] + '（' + c[1] + '）</option>';
    }).join('');
    $('mapStat').textContent = '带坐标打卡 ' + p.recs.length + ' 次 · 地点 ' + p.clusters.length + ' 处 · 城市 ' + cityCount + ' 座 · 无坐标 ' + p.noGeo + ' 次' +
      (global.__mapOffline ? ' · 底图瓦片不可用（' + (mapView.tileOk + mapView.tileFail) + ' 张试过 ' + mapView.tileFail + ' 张失败），已降级为坐标分布图' : '') +
      (location.search.indexOf('debug') >= 0 ? ' [DBG zoom=' + mapView.zoom + ' c=' + mapView.center.lat.toFixed(3) + ',' + mapView.center.lng.toFixed(3) + ' mode=' + mapView.mode + ']' : '');
  }

  function updateMapAppearance() {
    var mode=$('mapMode').value,heat=mode==='heat'||mode==='density';
    $('mapGradient').dataset.mode=mode;
    document.querySelectorAll('.density-key').forEach(function(el){el.classList.toggle('hidden',!heat);});
    $('mapSpreadControl').classList.toggle('hidden',!heat);
    $('mapSpread').disabled=!heat;
    $('mapLegendCaption').textContent=heat?'相对密度 · 当前视野归一化，扩散不代表实际范围':mode==='point'?'上班蓝色 / 外出红色 / 下班绿色':'气泡越大，打卡次数越多';
  }

  /* ---------------- 抓取抽屉 ---------------- */
  function openDrawer() {
    $('drawer').classList.remove('hidden');
    var now = new Date();
    $('dEnd').value = U.addDays(U.dateStr(now), -1);
    $('dStart').value = $('dEnd').value.slice(0, 8) + '01';
  }
  function log(msg) { var l = $('dLog'); l.textContent += msg + '\n'; l.scrollTop = l.scrollHeight; }
  log.cache = [];          // 已写进日志的错误，避免轮询时反复刷同一条
  function runFetch() {
    var body = {
      start: $('dStart').value || null, end: $('dEnd').value || null,
      users: ($('dUsers').value || '').trim(), depts: ($('dDepts').value || '').trim(),
      noDaily: $('dNoDaily').checked, noMonthly: $('dNoMonthly').checked
    };
    if (!body.start) { alert('请填写开始日期'); return; }
    if (body.start > body.end) { alert('结束日期不能早于开始日期'); return; }
    $('dLog').textContent = ''; log.cache = []; $('dRun').disabled = true; $('dBar').style.width = '0';
    log('POST /api/fetch ' + JSON.stringify(body));
    log('本月自动回补补卡历史；仅替换成功分片，失败和未请求人员保留旧数据。');
    fetch('/api/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) { log('❌ ' + j.error); $('dRun').disabled = false; banner(j.error, 'err'); return; }
        log('✅ 任务已启动，等待接口返回…');
        poll();
      }).catch(function (e) { log('❌ ' + e); $('dRun').disabled = false; });
  }
  function poll() {
    clearTimeout(pollTimer);
    fetch('/api/fetch_status').then(function (r) { return r.json(); }).then(function (j) {
      var f = j.fetch || {};
      var pctv = f.total ? Math.round((f.done || 0) / f.total * 100) : (f.running ? 8 : 0);
      $('dBar').style.width = Math.min(100, pctv) + '%';
      $('dMsg').textContent = (f.step || '') + (f.total ? ' ' + (f.done || 0) + '/' + f.total : '') + (f.api_calls ? ' · API ' + f.api_calls + ' 次' : '');
      note(f.message ? '· ' + f.message : '');
      (f.errors || []).slice(-3).forEach(function (e) { note('⚠ ' + e); });
      if (f.running) { pollTimer = setTimeout(poll, 1500); return; }
      $('dRun').disabled = false;
      if (/失败|参数有误/.test(f.step || '')) { log('❌ ' + (f.message || f.step)); return; }
      log('✅ 完成，正在刷新看板…');
      setTimeout(function () { location.reload(); }, 600);
    }).catch(function (e) { log('轮询暂时失败，3秒后重试：' + e); pollTimer=setTimeout(poll,3000); });
  }
  /* 同一条进度/错误只写一次，避免 1.5s 轮询把日志刷屏 */
  function note(msg) {
    if (!msg) return;
    if (log.cache.indexOf(msg) >= 0) return;
    log.cache.push(msg);
    if (log.cache.length > 200) log.cache = log.cache.slice(-100);
    log(msg);
  }
  /* ---------------- 渲染调度 ---------------- */
  function renderActiveTab() {
    if (activeTab === 'place') { renderMap(!mapFitted); mapFitted = true; }
    Charts.renderTab(activeTab);
    if (activeTab === 'risk') renderTable();
    if (activeTab === 'dept') renderDeptTable();
  }

  function renderAll() {
    var kpis = M.kpis();
    renderKpis('kpiCards', kpis);
    renderActiveTab();
  }

  /* ---------------- 顶栏 ---------------- */
  function fillFilters() {
    $('fStart').value = S.filters.start;
    $('fEnd').value = S.filters.end;
    $('fStart').min = S.range.start; $('fStart').max = S.range.end;
    $('fEnd').min = S.range.start; $('fEnd').max = S.range.end;
    var dept = $('fDept');
    dept.innerHTML = ['全部'].concat(S.depts).map(function (d) {
      return '<option' + (d === S.filters.dept ? ' selected' : '') + '>' + esc(d) + '</option>';
    }).join('');
    var grp = $('fGroup');
    grp.innerHTML = ['全部'].concat(S.groups).map(function (g) {
      return '<option' + (g === S.filters.group ? ' selected' : '') + '>' + esc(g) + '</option>';
    }).join('');
  }

  /* 口径切换会改变分母，说清楚免得把参考值当成官方考勤口径 */
  var SCOPE_NOTE = {
    office: '仅上下班：只影响原始打卡与地点图；有效考勤指标仍按当前部门的全员、全天核定结果计算。',
    outside: '仅外勤：只影响原始打卡与地点图；有效考勤指标仍保留全员分母，不用外勤记录重新推断缺卡。'
  };

  function applyFromToolbar() {
    var s = $('fStart').value, e = $('fEnd').value;
    if (!s || !e) { banner('请选择起止日期', 'err'); return; }
    if (s > e) { banner('开始日期不能晚于结束日期', 'err'); return; }
    banner('');
    S.filters = { start: s, end: e, dept: $('fDept').value, group: $('fGroup').value, scope: $('fScope').value };
    S.applyFilters();
    sourceLine();
    if (SCOPE_NOTE[S.filters.scope]) {
      var existing=$('banner').classList.contains('hidden')?'':$('banner').textContent;
      banner(existing+(existing?' ':'')+SCOPE_NOTE[S.filters.scope], S.meta.warnings && S.meta.warnings.length?'err':undefined);
    }
  }

  function sourceLine() {
    var m = S.meta || {};
    var bits = [];
    bits.push(m.demo ? '演示数据（合成，非真实员工数据）' : '企业微信打卡接口');
    bits.push('区间 ' + (m.start || '-') + ' ~ ' + (m.end || '-'));
    bits.push('打卡记录 ' + (m.record_count || 0) + ' 条 · 日报 ' + (m.daily_count || 0) + ' 条 · 人员 ' + (m.users || 0) + ' 人');
    if (m.generated_at) bits.push('数据生成于 ' + m.generated_at);
    if (m.api_calls) bits.push('API 调用 ' + m.api_calls + ' 次');
    $('sourceLine').textContent = bits.join(' · ');
    var a=M.agg(M.days()),sync=m.approval_sync || {};
    var excluded=(m.policy||{}).excluded_departments||[];
    $('policyLine').textContent = (excluded.length?'应考勤范围已排除 '+excluded.join('、')+'（'+(m.excluded_users||0)+'人）':'全员应考勤')+' · 当前部门关系 · 零工时保留0 · 加班为19:00后有效时段 · 拉取时回补本月补卡；环比为区间首尾等长自然日窗。';
    $('qualityLine').textContent = '应考勤 '+a.headcount+' 人 · 考勤依据覆盖 '+U.rateText(a.dataCoverageRate)+'%（'+a.dataCoveredPersonDays+'/'+a.modelDays+' 人日，含已知休息日） · 比率基数 '+a.ratePersonDays+' 个核定应出勤人日 · 依据缺口涉及 '+a.rateMissingPeople+' 人，暂不参与比率 '+a.rateMissingPersonDays+' 人日 · 补卡待审批 '+a.pendingCorrections+' 人日 · 已补正 '+a.syncedCorrections+' 人日 · 审批接口'+(sync.available?'已同步':'未同步/不完整');
    correctionPage=0;renderCorrections();
    renderCoverage();
    if (m.warnings && m.warnings.length) banner('部分数据未同步，已保留失败分片旧数据：'+m.warnings.join('；'),'err');
    else if(a.rateMissingPersonDays) banner((a.ratePersonDays?'已按 '+a.ratePersonDays+' 个核定应出勤人日显示考勤比率。':'当前没有可核定应出勤人日。')+a.rateMissingPeople+' 人的 '+a.rateMissingPersonDays+' 个人日缺少排班或日报依据，暂不参与比率，不当作缺勤；也未推断入职日期。明细见“全员数据覆盖”。');
    else if(!sync.available) banner('补卡审批数据尚未同步；已同步日报的核定结果仍保留，请勿把申请列表缺失当作没有申请。');
    else banner('');
    if (m.demo) banner('当前展示的是合成演示数据（tools/make_demo_data.py 生成），仅用于预览看板效果。' +
      '要接真实数据：填写 config.json（corpid + 已配置到「打卡 - 可调用接口的应用」的自建应用 secret），再点右上角「拉取新数据」。');
  }

  function renderCorrections() {
    var statusNames={pending:'待审批',approved:'已通过',rejected:'已驳回',withdrawn:'已撤回',revoked:'通过后撤销',deleted:'已删除',unknown:'待核对'};
    var keys={};M.days().forEach(function(d){keys[d.key]=d;});
    var filter=$('correctionStatus').value;
    var rows=(S.raw.approvals || []).filter(function(a){return keys[a.date+'|'+a.userid] && (filter==='all'||a.status===filter);});
    rows.sort(function(a,b){return b.date.localeCompare(a.date)||(b.apply_time||0)-(a.apply_time||0);});
    var pages=Math.max(1,Math.ceil(rows.length/40));correctionPage=Math.min(correctionPage,pages-1);
    $('correctionCount').textContent=rows.length+' 个补卡卡位（不是申请单数）';
    $('correctionPageInfo').textContent=(correctionPage+1)+' / '+pages+' 页';
    $('correctionPrev').disabled=correctionPage===0;$('correctionNext').disabled=correctionPage>=pages-1;
    $('correctionBody').innerHTML=rows.slice(correctionPage*40,correctionPage*40+40).map(function(a){var d=keys[a.date+'|'+a.userid];var effective=d.correctionStatus==='pending'?'待审批':d.correctionStatus==='sync_pending'?'待回写核定':d.correctionStatus==='corrected_with_exceptions'?'已同步，仍有核定异常':/^corrected/.test(d.correctionStatus)?'已补正正常':d.hasDaily?'以最新日报为准':'日报未同步';return '<tr><td>'+esc(a.date)+'</td><td>'+esc(S.name(a.userid))+'</td><td>'+esc(S.dept(a.userid))+'</td><td>'+esc(a.original_state)+'</td><td>'+esc(statusNames[a.status]||'待核对')+'</td><td>'+esc(effective)+'</td></tr>';}).join('') || '<tr><td colspan="6">'+((S.meta.approval_sync||{}).available?'当前筛选没有补卡记录':'审批未同步，不能判断是否存在申请')+'</td></tr>';
  }

  function renderCoverage() {
    var query=($('coverageSearch').value||'').trim().toLowerCase(),mode=$('coverageFilter').value;
    var rows=M.personSummary().filter(function(p){return (!query||(p.name+' '+p.dept).toLowerCase().indexOf(query)>=0) && (mode==='all'||p.rateMissingPersonDays>0);});
    $('coverageCount').textContent=rows.length+' 人';
    $('coverageBody').innerHTML=rows.map(function(p){return '<tr><td class="name" data-uid="'+esc(p.userid)+'">'+esc(p.name)+'</td><td>'+esc(p.dept)+'</td><td class="num">'+p.ratePersonDays+'</td><td class="num">'+p.personDays+'</td><td class="num">'+p.unknownSchedule+'</td><td class="num">'+p.missingExpectedDaily+'</td></tr>';}).join('')||'<tr><td colspan="6">没有匹配的人员</td></tr>';
    $('coverageBody').querySelectorAll('td.name').forEach(function(td){td.onclick=function(){showPerson(td.dataset.uid);};});
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    S = Store; U = U || global.U; M = global.Metrics;
    global.addEventListener('error', function (e) {
      banner('页面脚本报错（已忽略，可能部分图表未渲染）：' + e.message + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno, 'err');
    });
    if (location.hash) {
      var t = location.hash.slice(1);
      var tab = document.querySelector('.tab[data-tab="' + t + '"]');
      if (tab) { document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x === tab); }); document.querySelectorAll('.panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + t); }); activeTab = t; }
    }
    S.on(function () { mapFitted = false; fillFilters(); renderAll(); });
    $('correctionStatus').onchange=function(){correctionPage=0;renderCorrections();};
    $('correctionPrev').onclick=function(){correctionPage=Math.max(0,correctionPage-1);renderCorrections();};
    $('correctionNext').onclick=function(){correctionPage++;renderCorrections();};
    $('coverageSearch').oninput=renderCoverage;
    $('coverageFilter').onchange=renderCoverage;
    $('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('.tab');
      if (!b) return;
      Array.prototype.forEach.call($('tabs').querySelectorAll('.tab'), function (t) { t.classList.toggle('active', t === b); });
      document.querySelectorAll('.panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + b.dataset.tab); });
      activeTab = b.dataset.tab;
      location.hash = b.dataset.tab;
      renderActiveTab();
      setTimeout(Charts.resizeAll, 40);
    });
    // 窗口尺寸变化时同步 ECharts 画布大小，避免图表与容器错位（地图已自行处理 resize）
    var resizeTimer;
    global.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { Charts.resizeAll(); }, 80);
    });
    $('btnApply').onclick = applyFromToolbar;
    $('fQuick').onchange = function () {
      if (this.value === 'all') { $('fStart').value = S.range.start; $('fEnd').value = S.range.end; }
      else {
        $('fEnd').value = S.range.end;
        var s = U.addDays(S.range.end, -(+this.value - 1));
        $('fStart').value = s < S.range.start ? S.range.start : s;
      }
      applyFromToolbar();
    };
    $('btnFetch').onclick = openDrawer;
    $('btnExport').onclick = function (e) {
      e.stopPropagation();
      $('exportMenu').classList.toggle('hidden');
    };
    Array.prototype.forEach.call($('exportMenu').querySelectorAll('button'), function (b) {
      b.onclick = function () {
        $('exportMenu').classList.add('hidden');
        var kind = b.dataset.kind;
        if (kind === 'exceptions') { var n = exportExceptionCsv(); if (n) banner('已导出当前筛选的异常明细 ' + n + ' 条（CSV，含汉字 BOM，Excel 可直接打开）'); }
        else window.open('/api/export?name=' + encodeURIComponent(kind) + '&start=' + encodeURIComponent(S.filters.start) + '&end=' + encodeURIComponent(S.filters.end) + '&dept=' + encodeURIComponent(S.filters.dept) + '&group=' + encodeURIComponent(S.filters.group) + '&scope=' + encodeURIComponent(S.filters.scope), '_blank');
      };
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#exportMenu') && e.target !== $('btnExport')) $('exportMenu').classList.add('hidden');
    });
    $('tblExport').onclick = function () {
      var n = exportExceptionCsv();
      if (n) $('tblCount').textContent = tbl.rows.length + ' 条 · 已导出 ' + n + ' 条';
    };
    $('btnTheme').onclick = function () {
      var dark = document.documentElement.dataset.theme === 'dark';
      document.documentElement.dataset.theme = dark ? '' : 'dark';
      Charts.disposeAll();
      renderAll();
    };
    $('mapMode').onchange = function () { updateMapAppearance(); if (mapView) { mapView.mode = this.value; mapView.renderOverlay(); } };
    $('mapType').onchange = function () { renderMap(true); Charts.renderTab('place'); };
    $('mapSpread').oninput = function () { if (mapView) { mapView.heatSpread=Number(this.value); mapView.renderOverlay(); } };
    $('mapReset').onclick = function () { mapView.reset(); };
    $('mapIn').onclick = function () { mapView.zoomBy(1); };
    $('mapOut').onclick = function () { mapView.zoomBy(-1); };
    $('mapFocus').onchange = function () {
      if (!this.value) return;
      var v = this.value;
      var hit = mapView.points.filter(function (p) { return U.extractCity(p.detail || p.place) === v; });
      if (hit.length >= 3) { mapView.fit(hit); mapView.render(); }
    };
    $('tblSearch').oninput = function () { tbl.page = 0; renderTable(); };
    $('tblExc').onchange = function () { tbl.page = 0; renderTable(); };
    $('pgPrev').onclick = function () { if (tbl.page > 0) { tbl.page--; renderTable(); } };
    $('pgNext').onclick = function () {
      var pages = Math.max(1, Math.ceil(tbl.rows.length / tbl.size));
      if (tbl.page < pages - 1) { tbl.page++; renderTable(); }
    };
    $('mClose').onclick = function () { $('modal').classList.add('hidden'); };
    $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) $('modal').classList.add('hidden'); });
    $('dRun').onclick = runFetch;
    $('dClose').onclick = function () { $('drawer').classList.add('hidden'); };
    $('drawer').addEventListener('click', function (e) { if (e.target === $('drawer')) $('drawer').classList.add('hidden'); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { $('modal').classList.add('hidden'); $('drawer').classList.add('hidden'); }
    });

    fetch('/api/meta').then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) {
        banner('没有可用数据。请执行 <code>python3 tools/make_demo_data.py</code> 生成演示数据，' +
          '或 <code>python3 fetch_checkin.py --days 30</code> 拉取真实打卡数据后刷新。', 'err');
        $('boot').textContent = 'no-data';
        return;
      }
      if (j.fetch && j.fetch.running) { openDrawer(); log('检测到后台正在抓取，已自动跟踪进度…'); poll(); }
      return S.load().then(function () {
        sourceLine();
        fillFilters();
        renderAll();
        $('boot').textContent = 'ready';
        // 深链：/?person=emp016 直接打开某人个人画像（方便从报表/邮件跳转）
        var pid = (new URLSearchParams(location.search).get('person') || '').trim();
        if (pid && Store.users[pid]) setTimeout(function () { showPerson(pid); }, 200);
        if (!j.credentials && !S.meta.demo) {
          banner('看板已就绪。当前数据来自上一次抓取结果；配置 config.json 后可点「拉取新数据」增量更新。');
        }
      });
    }).catch(function (e) {
      banner('数据加载失败：' + e, 'err');
      $('boot').textContent = 'error';
    });
  }

  global.App = { showPerson: showPerson, renderActiveTab: renderActiveTab, get mapView() { return mapView; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);

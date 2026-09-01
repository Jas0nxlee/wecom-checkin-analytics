/* 图表层：每个图表一个 option 构造函数，app.js 按当前 tab 渲染 */
(function (global) {
  'use strict';
  var M = null, U = null, S = null;
  var insts = {};

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function theme() {
    return {
      ink: css('--ink') || '#1d2531', sub: css('--sub') || '#69738a', line: css('--line') || '#e4e8f0',
      card: css('--card') || '#fff', pri: css('--pri') || '#2f6fed',
      series: ['#2f6fed', '#12a06a', '#e59118', '#e14b4b', '#7b61d6', '#39b6c4', '#d9457f', '#6b7b95']
    };
  }
  function base(title) {
    var t = theme();
    return {
      color: t.series,
      textStyle: { color: t.ink, fontFamily: '-apple-system,PingFang SC,Microsoft YaHei,sans-serif' },
      tooltip: { trigger: 'item', backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0,
        textStyle: { color: '#eef2fa', fontSize: 12 }, confine: true },
      grid: { left: 46, right: 22, top: title ? 38 : 24, bottom: 34, containLabel: true },
      legend: { textStyle: { color: t.sub, fontSize: 11 }, top: 2, itemWidth: 12, itemHeight: 8, icon: 'roundRect' },
      _t: t
    };
  }
  function axis(cat, name, type) {
    var t = theme();
    return {
      type: type || 'category', data: cat, name: name || '',
      nameTextStyle: { color: t.sub, fontSize: 11 },
      axisLine: { lineStyle: { color: t.line } }, axisTick: { show: false },
      axisLabel: { color: t.sub, fontSize: 11, hideOverlap: true },
      splitLine: { lineStyle: { color: t.line, type: 'dashed' } }
    };
  }
  function vAxis(name, fmt) {
    var a = axis(null, name, 'value');
    a.axisLabel.formatter = fmt || '{value}';
    if (name) { a.nameLocation = 'end'; a.nameGap = 14; a.nameTextStyle = { color: a.nameTextStyle.color, fontSize: 11, align: 'left', verticalAlign: 'bottom' }; }
    return a;
  }
  function rowsLayout(id, count, minHeight, rowHeight, extra) {
    var el = document.getElementById(id);
    if (!el) return;
    var h = Math.max(minHeight || 280, count * (rowHeight || 24) + (extra || 48));
    el.style.height = h + 'px';
  }
  function rowAxis(cat, name) {
    return Object.assign(axis(cat, name), {
      axisLabel: { color: theme().sub, fontSize: 11, interval: 0, hideOverlap: false }
    });
  }
  function shortDate(d) { return d.slice(5); }
  function percent(v) { return v==null?null:+(v*100).toFixed(1); }
  function mk(id, option, notMerge) {
    // 自定义tooltip来自接口字段，只允许最基本的格式标签。
    if(option.tooltip && typeof option.tooltip.formatter==='function'){
      var original=option.tooltip.formatter;
      option.tooltip.formatter=function(){return U.escapeHtml(String(original.apply(this,arguments)).replace(/<\/?span\b[^>]*>/gi,''))
        .replace(/&lt;br\s*\/?&gt;/gi,'<br>').replace(/&lt;b&gt;/gi,'<b>').replace(/&lt;\/b&gt;/gi,'</b>');};
    }
    var el = document.getElementById(id);
    if (!el) return null;
    var c = insts[id] || echarts.init(el, null, { renderer: 'canvas' });
    insts[id] = c;
    c.setOption(option, notMerge !== false);
    return c;
  }
  function noData(id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    var c = insts[id] || echarts.init(el);
    insts[id] = c;
    c.setOption({ title: { text: msg || '暂无数据', left: 'center', top: 'middle', textStyle: { color: css('--sub'), fontSize: 13, fontWeight: 400 } }, series: [] }, true);
  }
  function resizeAll() { Object.keys(insts).forEach(function (k) { insts[k].resize(); }); }

  /* ============================== 总览 ============================== */
  function dailyAttendance() {
    var s = M.dailySeries();
    if (!s.length) return noData('c_dailyAttendance');
    var o = base();
    o.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.grid.bottom = 46;
    o.legend.top = 0;
    o.xAxis = Object.assign(axis(s.map(function (d) { return shortDate(d.date); })), {
      axisLabel: { color: o._t.sub, fontSize: 10, rotate: s.length > 35 ? 45 : 0, hideOverlap: true }, splitLine: { show: false } });
    o.yAxis = [Object.assign(vAxis(''), { minInterval: 1 }), Object.assign(vAxis('出勤率'), { max: 100, axisLabel: { formatter: '{value}%', color: o._t.sub, fontSize: 11 } })];
    o.series = [
      { name: '出勤人数', type: 'bar', data: s.map(function (d) { return d.present; }), itemStyle: { color: '#2f6fed', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 18 },
      { name: '迟到人次', type: 'bar', stack: 'exc', data: s.map(function (d) { return d.late; }), itemStyle: { color: '#e59118' }, barMaxWidth: 18 },
      { name: '缺卡人次', type: 'bar', stack: 'exc', data: s.map(function (d) { return d.miss; }), itemStyle: { color: '#e14b4b' }, barMaxWidth: 18 },
      { name: '外勤打卡', type: 'bar', stack: 'exc', data: s.map(function (d) { return d.outside; }), itemStyle: { color: '#12a06a' }, barMaxWidth: 18 },
      { name: '出勤率', type: 'line', yAxisIndex: 1, smooth: true, symbol: 'none', lineStyle: { width: 2.5 },
        connectNulls: false, data: s.map(function (d) { return d.attendanceRate == null ? null : percent(d.attendanceRate); }) }
    ];
    return mk('c_dailyAttendance', o);
  }

  function hourDist() {
    var h = M.hourDist(), o = base();
    o.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.xAxis = Object.assign(axis(Array.apply(null, { length: 24 }).map(function (_, i) { return i + '时'; })), { splitLine: { show: false }, name: '' });
    o.yAxis = vAxis('');
    o.series = h.types.map(function (t, i) {
      return { name: t, type: 'bar', stack: 'a', data: h.data[i], barMaxWidth: 22,
        itemStyle: { color: ['#2f6fed', '#12a06a', '#e59118'][i], borderRadius: i === 2 ? [3, 3, 0, 0] : 0 } };
    });
    return mk('c_hourDist', o);
  }

  function wdHour() {
    var h = M.wdHourHeat(), o = base();
    o.grid = { left: 48, right: 18, top: 16, bottom: 60, containLabel: true };
    o.tooltip = { formatter: function (p) { return U.weekdayCN(p.value[1]) + ' ' + p.value[0] + '时<br>打卡 <b>' + p.value[2] + '</b> 次'; },
      backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.xAxis = Object.assign(axis(Array.apply(null, { length: 24 }).map(function (_, i) { return i; })), {
      splitLine: { show: false }, axisLabel: { color: o._t.sub, fontSize: 10 } });
    o.yAxis = Object.assign(axis(['周一', '周二', '周三', '周四', '周五', '周六', '周日']), { splitLine: { show: false }, inverse: true });
    o.visualMap = { min: 0, max: h.max || 1, calculable: false, orient: 'horizontal', left: 'center', bottom: 4,
      itemWidth: 12, itemHeight: 90, textStyle: { color: o._t.sub, fontSize: 11 },
      inRange: { color: ['#eef3fb', '#bcd0f5', '#7fa8ee', '#f7d471', '#f2884b', '#e03b3b'] } };
    o.series = [{ type: 'heatmap', data: h.data, progressive: 0,
      emphasis: { itemStyle: { borderColor: '#333', borderWidth: 1 } },
      itemStyle: { borderColor: 'rgba(0,0,0,.04)', borderWidth: 1 } }];
    return mk('c_wdHour', o);
  }

  function topPlaceMini() {
    var p = M.placeStat('all');
    var top = p.top.slice(0, 10);
    if (!top.length) return noData('c_topPlaceMini');
    var o = base();
    rowsLayout('c_topPlaceMini', top.length, 280, 24, 36);
    o.grid = { left: 112, right: 40, top: 8, bottom: 6, containLabel: true };
    o.tooltip = { formatter: function (x) { return x.name + '<br>打卡 <b>' + x.value + '</b> 次'; }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.xAxis = Object.assign(vAxis(), { splitLine: { lineStyle: { color: o._t.line, type: 'dashed' } } });
    o.yAxis = Object.assign(rowAxis(top.map(function (t) { return t[0].length > 12 ? t[0].slice(0, 11) + '…' : t[0]; }).reverse()), { splitLine: { show: false } });
    o.series = [{ type: 'bar', data: top.map(function (t) { return t[1]; }).reverse(), barMaxWidth: 14,
      label: { show: true, position: 'right', fontSize: 11, color: o._t.sub },
      itemStyle: { color: function (p2) { return p2.dataIndex >= top.length - 1 ? '#e03b3b' : '#5b8dff'; }, borderRadius: [0, 3, 3, 0] } }];
    return mk('c_topPlaceMini', o);
  }

  /* ============================== 时间 ============================== */
  function offsetHist(id, which) {
    var h = M.offsetHist(which, which === 'in' ? 24 : 30);
    if (!h.count) return noData(id);
    var o = base();
    o.grid.bottom = 52;
    o.legend = { show: false };
    o.tooltip = { formatter: function (x) { return '偏移 ' + x.name + ' 分钟<br><b>' + x.value + '</b> 人日'; }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.xAxis = Object.assign(axis(h.labels), { axisLabel: { color: o._t.sub, fontSize: 9, rotate: 55, interval: which === 'in' ? 1 : 2 }, splitLine: { show: false } });
    o.yAxis = vAxis('人日数');
    o.series = [{ type: 'bar', data: h.values.map(function (v, i) {
      return { value: v, itemStyle: { color: i < h.zeroIndex ? '#2f6fed' : (i === h.zeroIndex ? '#12a06a' : '#e14b4b'), borderRadius: [2, 2, 0, 0] } };
    }), barCategoryGap: '18%' },
    { name: '标准时刻', type: 'line', markLine: { silent: true, symbol: 'none',
        label: { show: false },
        lineStyle: { color: '#e59118', width: 2, type: 'solid' }, data: [{ xAxis: h.zeroIndex }] }, data: [] }];
    return mk(id, o);
  }

  function avgTimes() {
    var s = M.avgTimesSeries();
    if (!s.dates.length) return noData('c_avgTimes');
    var o = base();
    o.tooltip = { trigger: 'axis', formatter: function (ps) { return ps[0].axisValue + '<br>' + ps.map(function (p) { return p.marker + p.seriesName + ' ' + (p.value == null ? '-' : U.fmtMin(p.value)); }).join('<br>'); }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.grid.bottom = 46;
    o.xAxis = Object.assign(axis(s.dates.map(shortDate)), { axisLabel: { color: o._t.sub, fontSize: 10, rotate: 45, hideOverlap: true }, splitLine: { show: false } });
    var allv = [].concat(s.arrive, s.leave, s.stdIn, s.stdOut).filter(function (v) { return v != null; });
    var lo = allv.length ? Math.floor((Math.min.apply(null, allv) - 45) / 60) * 60 : 6 * 60;
    var hi = allv.length ? Math.ceil((Math.max.apply(null, allv) + 45) / 60) * 60 : 22 * 60;
    o.yAxis = Object.assign(vAxis(), { axisLabel: { formatter: function (v) { return U.fmtMin(v); }, color: o._t.sub, fontSize: 11 }, min: lo, max: hi });
    o.series = [
      { name: '平均到岗', type: 'line', smooth: true, symbol: 'none', lineStyle: { width: 2.5 }, data: s.arrive, itemStyle: { color: '#2f6fed' } },
      { name: '平均离岗', type: 'line', smooth: true, symbol: 'none', lineStyle: { width: 2.5 }, data: s.leave, itemStyle: { color: '#e59118' } },
      { name: '标准上班', type: 'line', symbol: 'none', lineStyle: { type: 'dashed', width: 1.5 }, data: s.stdIn, itemStyle: { color: '#98a4bb' } },
      { name: '标准下班', type: 'line', symbol: 'none', lineStyle: { type: 'dashed', width: 1.5 }, data: s.stdOut, itemStyle: { color: '#b6c0d4' } }
    ];
    return mk('c_avgTimes', o);
  }

  function calendar() {
    var h = M.calendarHeat();
    if (!h.data.length) return noData('c_calendar');
    var o = base();
    o.grid = { left: 40, right: 20, top: 12, bottom: 46 };
    o.tooltip = { formatter: function (p) { return p.value[0] + '<br>打卡 <b>' + p.value[1] + '</b> 人次'; }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    var start = h.data[0][0], end = h.data[h.data.length - 1][0];
    o.visualMap = { min: 0, max: h.max, type: 'continuous', orient: 'horizontal', left: 'center', bottom: 2,
      itemWidth: 12, itemHeight: 90, text: ['多', '少'], textStyle: { color: o._t.sub, fontSize: 11 },
      inRange: { color: ['#e9eef8', '#b9d3f7', '#6fa4ef', '#f2c05a', '#e03b3b'] } };
    o.calendar = { range: [start, end], orient: 'vertical', cellSize: [46, 16], top: 34, left: 52, right: 24, bottom: 46,
      splitLine: { lineStyle: { color: o._t.line } },
      itemStyle: { borderColor: o._t.line, borderWidth: 1, borderRadius: 2 },
      yearLabel: { show: false }, monthLabel: { color: o._t.ink, fontSize: 11, nameMap: 'cn', position: 'start' },
      dayLabel: { color: o._t.sub, fontSize: 10, position: 'start', nameMap: ['日', '一', '二', '三', '四', '五', '六'] },
      weekLabel: { show: false } };
    o.series = [{ type: 'heatmap', coordinateSystem: 'calendar', data: h.data }];
    return mk('c_calendar', o);
  }

  function boxWeek() {
    var b = M.boxByWeek();
    if (!b.weeks.length) return noData('c_boxWeek');
    var o = base();
    o.grid = { left: 50, right: 20, top: 30, bottom: 44, containLabel: true };
    o.tooltip = { trigger: 'item', formatter: function (p) {
      if (p.seriesType !== 'boxplot') return '';
      return p.seriesName + ' · ' + p.name + '<br>最早 ' + U.fmtMin(p.value[1]) + '<br>下四分位 ' + U.fmtMin(p.value[2]) +
        '<br>中位 <b>' + U.fmtMin(p.value[3]) + '</b><br>上四分位 ' + U.fmtMin(p.value[4]) + '<br>最晚 ' + U.fmtMin(p.value[5]);
    }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.xAxis = Object.assign(axis(b.weeks.map(function (w) { return w.slice(5); })), { splitLine: { show: false } });
    o.yAxis = Object.assign(vAxis('相对标准时刻（分钟）'), { axisLabel: { formatter: function (v) { return (v > 0 ? '+' : '') + v; }, color: o._t.sub, fontSize: 11 } });
    o.series = [
      { name: '到岗偏移', type: 'boxplot', data: b.arrive, itemStyle: { color: 'rgba(47,111,237,.25)', borderColor: '#2f6fed' } },
      { name: '离岗偏移', type: 'boxplot', data: b.leave, itemStyle: { color: 'rgba(229,145,24,.22)', borderColor: '#e59118' } },
      { name: '标准时刻', type: 'line', markLine: { silent: true, symbol: 'none', label: { formatter: '标准时刻 0', color: '#e14b4b', fontSize: 10, position: 'insideEndTop' }, lineStyle: { color: '#e14b4b', width: 1.6, type: 'dashed' }, data: [{ yAxis: 0 }] }, data: [] }
    ];
    return mk('c_boxWeek', o);
  }

  function deptHour() {
    var h = M.deptHourHeat();
    if (!h.depts.length) return noData('c_deptHour');
    var o = base();
    rowsLayout('c_deptHour', h.depts.length, 360, 24, 72);
    o.grid = { left: 132, right: 20, top: 12, bottom: 56, containLabel: true };
    o.tooltip = { formatter: function (p) { return h.depts[p.value[1]] + '<br>' + p.value[0] + '时 <b>' + p.value[2] + '</b> 次'; }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.xAxis = Object.assign(axis(Array.apply(null, { length: 24 }).map(function (_, i) { return i; })), { splitLine: { show: false }, axisLabel: { fontSize: 10, color: o._t.sub } });
    o.yAxis = Object.assign(rowAxis(h.depts), { splitLine: { show: false }, inverse: true });
    o.visualMap = { min: 0, max: h.max || 1, left: 'center', bottom: 2, orient: 'horizontal', itemWidth: 12, itemHeight: 90,
      textStyle: { color: o._t.sub, fontSize: 11 }, inRange: { color: ['#eef3fb', '#bcd0f5', '#7fa8ee', '#f7d471', '#f2884b', '#e03b3b'] } };
    o.series = [{ type: 'heatmap', data: h.data, label: { show: false }, itemStyle: { borderColor: 'rgba(0,0,0,.05)', borderWidth: 1 } }];
    return mk('c_deptHour', o);
  }

  function scatterTime() {
    var d = M.scatterTime();
    if (!d.pts.length) return noData('c_scatterTime');
    var o = base();
    o.grid = { left: 52, right: 20, top: 16, bottom: 46, containLabel: true };
    o.tooltip = { formatter: function (p) { return p.value[2] + ' · ' + p.value[3] + '<br>' + p.value[4] + '<br>到岗 ' + U.fmtMin(p.value[0]) + ' → 离岗 ' + U.fmtMin(p.value[1]) + (p.value[5] ? '<br><span style="color:#f6b26b">迟到</span>' : ''); }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.xAxis = Object.assign(vAxis('到岗'), { axisLabel: { formatter: function (v) { return U.fmtMin(v); }, color: o._t.sub, fontSize: 10 }, min: Math.min(6*60,Math.floor(Math.min.apply(null,d.pts.map(function(x){return x[0];}))/60)*60), max: Math.max(14*60,Math.ceil(Math.max.apply(null,d.pts.map(function(x){return x[0];}))/60)*60), splitLine: { lineStyle: { color: o._t.line, type: 'dashed' } } });
    o.yAxis = Object.assign(vAxis('离岗'), { axisLabel: { formatter: function (v) { return U.fmtMin(v); }, color: o._t.sub, fontSize: 10 }, min: Math.min(12*60,Math.floor(Math.min.apply(null,d.pts.map(function(x){return x[1];}))/60)*60), max: Math.max(25*60,Math.ceil(Math.max.apply(null,d.pts.map(function(x){return x[1];}))/60)*60) });
    o.series = [
      { type: 'scatter', symbolSize: 5.5, data: d.pts.filter(function (p) { return !p[5]; }), itemStyle: { color: 'rgba(47,111,237,.5)' } },
      { type: 'scatter', symbolSize: 7, data: d.pts.filter(function (p) { return p[5]; }), itemStyle: { color: 'rgba(225,75,75,.85)' } },
      { type: 'line', symbol: 'none', silent: true, lineStyle: { color: '#12a06a', type: 'dashed', width: 1.5 },
        data: [[6 * 60, 12 * 60], [25 * 60, 25 * 60]], tooltip: { show: false }, name: '在岗等时线' }
    ];
    return mk('c_scatterTime', o);
  }
  /* ============================== 地点 ============================== */
  function hBar(id, pairs, colorFn, unit) {
    if (!pairs.length) return noData(id);
    var o = base();
    rowsLayout(id, pairs.length, 280, 24, 36);
    o.grid = { left: 112, right: 44, top: 8, bottom: 6, containLabel: true };
    o.tooltip = { formatter: function (x) { return x.name + '<br><b>' + x.value + '</b> ' + (unit || '次'); }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.xAxis = Object.assign(vAxis(), { splitLine: { lineStyle: { color: o._t.line, type: 'dashed' } } });
    o.yAxis = Object.assign(rowAxis(pairs.map(function (p) { return String(p[0]).length > 14 ? String(p[0]).slice(0, 13) + '…' : String(p[0]); }).reverse()), { splitLine: { show: false } });
    o.series = [{ type: 'bar', data: pairs.map(function (p) { return p[1]; }).reverse(), barMaxWidth: 15,
      label: { show: true, position: 'right', fontSize: 11, color: o._t.sub },
      itemStyle: { borderRadius: [0, 3, 3, 0], color: colorFn || '#5b8dff' } }];
    return mk(id, o);
  }

  function donut(id, pairs, unit) {
    if (!pairs.length) return noData(id);
    var o = base();
    o.grid = undefined;
    o.tooltip = { formatter: function (p) { return p.name + '<br><b>' + p.value + '</b> ' + (unit || '次') + '（' + p.percent + '%）'; }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.legend = { orient: 'vertical', right: 4, top: 'center', textStyle: { color: o._t.sub, fontSize: 11 }, itemWidth: 10, itemHeight: 8, icon: 'roundRect' };
    o.series = [{ type: 'pie', radius: ['46%', '72%'], center: ['36%', '50%'], avoidLabelOverlap: true,
      itemStyle: { borderColor: o._t.card, borderWidth: 2 }, label: { show: false }, labelLine: { show: false },
      data: pairs.map(function (p) { return { name: p[0], value: p[1] }; }) }];
    return mk(id, o);
  }

  function placeType() { var p = M.placeStat(currentMapType()); donut('c_placeType', U.topN(p.typeComp, 8), '次'); }
  function cityChart() {
    var p = M.placeStat(currentMapType());
    var cities = U.topN(p.city, 12);
    if (!cities.length) return noData('c_city');
    var o = base();
    o.grid = { left: 40, right: 20, top: 26, bottom: 26, containLabel: true };
    o.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.legend.top = 0;
    o.xAxis = Object.assign(axis(cities.map(function (c) { return c[0]; })), { splitLine: { show: false }, axisLabel: { fontSize: 10, color: o._t.sub, rotate: 30 } });
    o.yAxis = vAxis('打卡次数');
    o.series = [
      { name: '全部打卡', type: 'bar', data: cities.map(function (c) { return c[1]; }), barMaxWidth: 16, itemStyle: { color: '#5b8dff', borderRadius: [3, 3, 0, 0] } },
      { name: '其中异常打卡', type: 'bar', data: cities.map(function (c) { return p.cityExc[c[0]] || 0; }), barMaxWidth: 16, itemStyle: { color: '#e14b4b', borderRadius: [3, 3, 0, 0] } }
    ];
    return mk('c_city', o);
  }
  function distanceChart() {
    var p = M.placeStat(currentMapType());
    if (!p.distCount) return noData('c_distance', '缺少坐标，无法计算距离');
    var o = base();
    o.grid = { left: 40, right: 18, top: 26, bottom: 46, containLabel: true };
    o.tooltip = { formatter: function (x) { return x.name + '<br><b>' + x.value + '</b> 次'; }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.xAxis = Object.assign(axis(p.distBuckets.map(function (b) { return b.name; })), { splitLine: { show: false }, axisLabel: { fontSize: 10, color: o._t.sub, rotate: 30 } });
    o.yAxis = vAxis('打卡次数');
    o.series = [{ type: 'bar', data: p.distBuckets.map(function (b, i) { return { value: b.count, itemStyle: { color: i <= 2 ? '#12a06a' : (i <= 4 ? '#e59118' : '#e14b4b'), borderRadius: [3, 3, 0, 0] } }; }), barMaxWidth: 22, label: { show: true, position: 'top', fontSize: 10, color: o._t.sub } }];
    return mk('c_distance', o);
  }
  function topPlace() { var p = M.placeStat(currentMapType()); hBar('c_topPlace', p.top.slice(0, 20)); }
  function diversityChart() {
    var p = M.placeStat(currentMapType());
    var rows = p.diversity.slice(0, 18);
    if (!rows.length) return noData('c_diversity');
    var o = base();
    rowsLayout('c_diversity', rows.length, 280, 24, 48);
    o.grid = { left: 112, right: 30, top: 24, bottom: 26, containLabel: true };
    o.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.legend.top = 0;
    o.yAxis = Object.assign(rowAxis(rows.map(function (r) { return r.name; }).reverse()), { splitLine: { show: false } });
    o.xAxis = vAxis('数量');
    o.series = [
      { name: '打卡地点数', type: 'bar', stack: 'a', data: rows.map(function (r) { return r.places; }).reverse(), barMaxWidth: 14, itemStyle: { color: '#5b8dff' } },
      { name: '外勤打卡次数', type: 'bar', stack: 'a', data: rows.map(function (r) { return r.outside; }).reverse(), barMaxWidth: 14, itemStyle: { color: '#12a06a' } },
      { name: '涉及城市数', type: 'bar', stack: 'a', data: rows.map(function (r) { return r.cities; }).reverse(), barMaxWidth: 14, itemStyle: { color: '#e59118' } }
    ];
    return mk('c_diversity', o);
  }
  function wifiChart() { var p = M.placeStat(currentMapType()); hBar('c_wifi', p.wifi, '#39b6c4'); }
  function deviceChart() { var p = M.placeStat(currentMapType()); hBar('c_device', p.device, '#7b61d6'); }

  /* ============================== 趋势 ============================== */
  function rateTrend() {
    var s = M.dailySeries();
    if (!s.length) return noData('c_rateTrend');
    var o = trendBase(s, ['出勤率', '迟到率', '缺卡率', '早退率'], function (d) {
      return [d.attendanceRate == null ? null : percent(d.attendanceRate), percent(d.lateRate), percent(d.missRate), percent(d.earlyRate)];
    }, '{value}%');
    return mk('c_rateTrend', o);
  }
  function workTrend() {
    var s = M.dailySeries();
    if (!s.length) return noData('c_workTrend');
    var o = trendBase(s, ['人均工时', '人均加班', '外勤打卡次数'], function (d) {
      return [+d.avgWorkHours.toFixed(2), +(d.otHours / Math.max(1, d.present)).toFixed(2), d.outside];
    }, null, ['#2f6fed', '#e59118', '#39b6c4']);
    o.yAxis = [vAxis('小时'), Object.assign(vAxis('次'), { splitLine: { show: false } })];
    o.series[2].yAxisIndex = 1;
    o.series[2].type = 'bar';
    o.series[2].barMaxWidth = 12;
    o.series[2].itemStyle = { color: '#39b6c4', opacity: 0.55, borderRadius: [2, 2, 0, 0] };
    return mk('c_workTrend', o);
  }
  function trendBase(s, names, pick, fmt, colors_) {
    var o = base();
    o.grid = { left: 46, right: 46, top: 30, bottom: 44, containLabel: true };
    o.tooltip = { trigger: 'axis', backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 },
      formatter: function (ps) { return ps[0].axisValue + '<br>' + ps.map(function (p) { return p.marker + p.seriesName + ' <b>' + (p.value == null ? '-' : p.value) + '</b>'; }).join('<br>'); } };
    o.legend.top = 0;
    o.xAxis = Object.assign(axis(s.map(function (d) { return shortDate(d.date); })), {
      splitLine: { show: false }, axisLabel: { color: o._t.sub, fontSize: 10, rotate: s.length > 32 ? 45 : 0, hideOverlap: true } });
    o.yAxis = [Object.assign(vAxis('', fmt || '{value}'), { splitLine: { lineStyle: { color: o._t.line, type: 'dashed' } } }), vAxis('')];
    var colors = colors_ || ['#2f6fed', '#e59118', '#e14b4b', '#7b61d6'];
    o.series = names.map(function (n, i) {
      return { name: n, type: 'line', smooth: true, symbol: 'circle', symbolSize: 4, showSymbol: s.length <= 45,
        connectNulls: false, lineStyle: { width: 2.2 }, itemStyle: { color: colors[i] },
        areaStyle: null,
        data: s.map(function (d) { return pick(d)[i]; }) };
    });
    return o;
  }

  function deptDay() {
    var h = M.deptDayHeat();
    if (!h.depts.length) return noData('c_deptDay');
    var o = base();
    rowsLayout('c_deptDay', h.depts.length, 360, 24, 72);
    o.grid = { left: 132, right: 24, top: 12, bottom: 58, containLabel: true };
    o.tooltip = { formatter: function (p) { return h.dates[p.value[0]] + '<br>' + h.depts[p.value[1]] + ' 出勤率 <b>' + (p.value[2] == null ? '无数据' : p.value[2] + '%') + '</b>'; }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.xAxis = Object.assign(axis(h.dates.map(shortDate)), { splitLine: { show: false }, axisLabel: { color: o._t.sub, fontSize: 9, rotate: 50, hideOverlap: true } });
    o.yAxis = Object.assign(rowAxis(h.depts), { splitLine: { show: false }, inverse: true });
    o.visualMap = { min: 0, max: 100, left: 'center', bottom: 2, orient: 'horizontal', itemWidth: 12, itemHeight: 90,
      precision: 0, text: ['100%', '0%'], textStyle: { color: o._t.sub, fontSize: 11 },
      inRange: { color: ['#f0a0a0', '#f7e3b5', '#eef3fb', '#9dc0f5', '#2f6fed'] } };
    o.series = [{ type: 'heatmap', data: h.data, itemStyle: { borderColor: o._t.card, borderWidth: 1 } }];
    return mk('c_deptDay', o);
  }

  function weekCmp() {
    var w = M.weekCompare();
    if (!w.length) return noData('c_weekCmp');
    var o = base();
    o.grid = { left: 46, right: 46, top: 30, bottom: 40, containLabel: true };
    o.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.legend.top = 0;
    o.xAxis = Object.assign(axis(w.map(function (x) { return x.week.slice(5); })), { splitLine: { show: false } });
    o.yAxis = [Object.assign(vAxis('人日'), { splitLine: { lineStyle: { color: o._t.line, type: 'dashed' } } }), Object.assign(vAxis('比率 %'), { axisLabel: { formatter: '{value}%', color: o._t.sub, fontSize: 11 } })];
    o.series = [
      { name: '出勤人日', type: 'bar', data: w.map(function (x) { return x.personDays; }), barMaxWidth: 20, itemStyle: { color: '#5b8dff', borderRadius: [3, 3, 0, 0] } },
      { name: '加班时长', type: 'bar', data: w.map(function (x) { return +x.otHours.toFixed(1); }), barMaxWidth: 20, itemStyle: { color: '#12a06a', borderRadius: [3, 3, 0, 0] } },
      { name: '迟到率', type: 'line', yAxisIndex: 1, smooth: true, data: w.map(function (x) { return percent(x.lateRate); }), itemStyle: { color: '#e59118' } },
      { name: '缺卡率', type: 'line', yAxisIndex: 1, smooth: true, data: w.map(function (x) { return percent(x.missRate); }), itemStyle: { color: '#e14b4b' } }
    ];
    return mk('c_weekCmp', o);
  }

  function weekdayProfile() {
    var w = M.weekdayProfile();
    var o = base();
    o.grid = { left: 46, right: 46, top: 30, bottom: 30, containLabel: true };
    o.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.legend.top = 0;
    o.xAxis = Object.assign(axis(w.map(function (x) { return x.name; })), { splitLine: { show: false } });
    o.yAxis = [Object.assign(vAxis('平均出勤人数'), { splitLine: { lineStyle: { color: o._t.line, type: 'dashed' } } }), Object.assign(vAxis('%'), { axisLabel: { formatter: '{value}%', color: o._t.sub, fontSize: 11 } })];
    o.series = [
      { name: '平均出勤人数', type: 'bar', data: w.map(function (x) { return +x.present.toFixed(1); }), barMaxWidth: 24, itemStyle: { color: '#5b8dff', borderRadius: [3, 3, 0, 0] } },
      { name: '迟到率', type: 'line', yAxisIndex: 1, smooth: true, data: w.map(function (x) { return percent(x.lateRate); }), itemStyle: { color: '#e59118' } },
      { name: '缺卡率', type: 'line', yAxisIndex: 1, smooth: true, data: w.map(function (x) { return percent(x.missRate); }), itemStyle: { color: '#e14b4b' } }
    ];
    return mk('c_weekday', o);
  }

  function monthCmp() {
    var m = M.monthCompare();
    if (!m.length) return noData('c_month');
    var o = base();
    o.grid = { left: 46, right: 46, top: 30, bottom: 30, containLabel: true };
    o.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.legend.top = 0;
    o.xAxis = Object.assign(axis(m.map(function (x) { return x.month; })), { splitLine: { show: false } });
    o.yAxis = [Object.assign(vAxis('小时/人日'), { splitLine: { lineStyle: { color: o._t.line, type: 'dashed' } } }), Object.assign(vAxis('%'), { axisLabel: { formatter: '{value}%', color: o._t.sub, fontSize: 11 } })];
    o.series = [
      { name: '人均工时', type: 'bar', data: m.map(function (x) { return +x.avgWorkHours.toFixed(2); }), barMaxWidth: 22, itemStyle: { color: '#5b8dff', borderRadius: [3, 3, 0, 0] } },
      { name: '人均加班(h)', type: 'bar', data: m.map(function (x) { return +(x.otHours / Math.max(1, x.head)).toFixed(1); }), barMaxWidth: 22, itemStyle: { color: '#12a06a', borderRadius: [3, 3, 0, 0] } },
      { name: '出勤率', type: 'line', yAxisIndex: 1, smooth: true, data: m.map(function (x) { return percent(x.attendanceRate); }), itemStyle: { color: '#2f6fed' } },
      { name: '迟到率', type: 'line', yAxisIndex: 1, smooth: true, data: m.map(function (x) { return percent(x.lateRate); }), itemStyle: { color: '#e59118' } },
      { name: '缺卡率', type: 'line', yAxisIndex: 1, smooth: true, data: m.map(function (x) { return percent(x.missRate); }), itemStyle: { color: '#e14b4b' } }
    ];
    return mk('c_month', o);
  }

  /* ============================== 异常与人员 ============================== */
  function excPie() {
    var days = M.days();
    var m = {};
    U.EXC_TYPES.forEach(function (t) {
      var v = U.sum(days, function (d) { return d.exc[t] || 0; });
      if (v) m[t] = v;
    });
    var pairs = U.topN(m, 8);
    if (!pairs.length) return noData('c_excPie', '筛选区间内无异常记录');
    var o = base();
    o.grid = undefined;
    o.tooltip = { formatter: function (p) { return p.name + ' <b>' + p.value + '</b> 人次（' + p.percent + '%）'; }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.legend = { orient: 'vertical', right: 4, top: 'middle', textStyle: { color: o._t.sub, fontSize: 11.5 }, itemWidth: 10, itemHeight: 8, icon: 'roundRect',
      formatter: function (n) { var hit = pairs.filter(function (x) { return x[0] === n; })[0]; return hit ? n + '  ' + hit[1] : n; } };
    o.series = [{ type: 'pie', radius: ['38%', '70%'], center: ['32%', '50%'],
      itemStyle: { borderColor: o._t.card, borderWidth: 2, borderRadius: 3 },
      label: { show: false }, labelLine: { show: false },
      emphasis: { label: { show: true, position: 'center', fontSize: 15, fontWeight: 'bold', color: o._t.ink,
        formatter: function (x) { return x.name + '\n' + x.value + ' 人次' } } },
      data: pairs.map(function (p) { return { name: p[0], value: p[1], itemStyle: { color: U.EXC_COLOR[p[0]] } }; }) }];
    return mk('c_excPie', o);
  }

  function excTrend() {
    var t = M.excTrend();
    if (!t.dates.length) return noData('c_excTrend');
    var o = base();
    o.grid = { left: 42, right: 20, top: 44, bottom: 42, containLabel: true };
    o.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.legend = { top: 0, left: 0, textStyle: { color: o._t.sub, fontSize: 11 }, itemWidth: 11, itemHeight: 8, icon: 'roundRect' };
    o.xAxis = Object.assign(axis(t.dates.map(shortDate)), { splitLine: { show: false }, axisLabel: { color: o._t.sub, fontSize: 10, rotate: 45, hideOverlap: true } });
    o.yAxis = vAxis('');
    o.series = U.EXC_TYPES.filter(function (k) { return t[k].some(function (v) { return v; }); }).map(function (k) {
      return { name: k, type: 'bar', stack: 'e', data: t[k], barMaxWidth: 18, itemStyle: { color: U.EXC_COLOR[k] } };
    });
    return mk('c_excTrend', o);
  }

  function spChart() {
    var pairs = M.spStructure();
    return hBar('c_sp', pairs, '#6b7b95', '次');
  }

  function personRank() {
    var rows = M.personSummary().filter(function(r){return r.excRate!=null;}).slice(0, 20);
    if (!rows.length) return noData('c_personRank');
    var o = base();
    rowsLayout('c_personRank', rows.length, 360, 24, 48);
    o.grid = { left: 112, right: 54, top: 26, bottom: 26, containLabel: true };
    o.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 },
      formatter: function (ps) {
        var r = rows[rows.length - 1 - ps[0].dataIndex];
        return '<b>' + r.name + '</b>（' + r.dept + '）<br>人均异常 <b>' + r.excRate.toFixed(2) + '</b> 次/人日<br>迟到 ' + r.late + ' · 早退 ' + r.early + ' · 缺卡 ' + r.miss +
          '<br>加班 ' + (r.otSec / 3600).toFixed(1) + 'h · 出勤率 ' + U.rateText(r.attendanceRate,0) + '%<br><span style="opacity:.7">点击查看个人画像</span>';
      } };
    o.yAxis = Object.assign(rowAxis(rows.map(function (r) { return r.name; }).reverse()), { splitLine: { show: false } });
    o.xAxis = Object.assign(vAxis(''), { axisLabel: { formatter: '{value}', color: o._t.sub, fontSize: 11 } });
    o.grid.bottom = 34;
    o.series = [{ type: 'bar', data: rows.map(function (r) { return +r.excRate.toFixed(2); }).reverse(), barMaxWidth: 15,
      label: { show: true, position: 'right', fontSize: 10.5, color: o._t.sub },
      itemStyle: { borderRadius: [0, 3, 3, 0], color: function (p) { return p.value > 1 ? '#e14b4b' : (p.value > 0.5 ? '#e59118' : '#5b8dff'); } } }];
    var c = mk('c_personRank', o);
    if (c) c.off('click'); 
    if (c) c.on('click', function (p) {
      var r = rows[rows.length - 1 - p.dataIndex];
      if (r) global.App && global.App.showPerson(r.userid);
    });
    return c;
  }

  function excMatrix() {
    var rows = M.personSummary().filter(function (r) { return r.excTotal > 0; }).slice(0, 18);
    if (!rows.length) return noData('c_excMatrix', '筛选区间内无异常记录');
    var types = ['迟到', '早退', '缺卡', '旷工', '地点异常', '设备异常'];
    var KEY = { '迟到': 'late', '早退': 'early', '缺卡': 'miss', '旷工': 'absent', '地点异常': 'placeExc', '设备异常': 'devExc' };
    var data = [], max = 1;
    rows.forEach(function (r, yi) {
      types.forEach(function (t, xi) {
        var v = r[KEY[t]] || 0;
        max = Math.max(max, v);
        data.push([xi, yi, v]);
      });
    });
    var o = base();
    rowsLayout('c_excMatrix', rows.length, 360, 24, 72);
    o.grid = { left: 112, right: 26, top: 26, bottom: 52, containLabel: true };
    o.tooltip = { formatter: function (p) { return rows[p.value[1]].name + ' · ' + types[p.value[0]] + '<br><b>' + p.value[2] + '</b> 次'; }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.xAxis = Object.assign(axis(types), { splitLine: { show: false }, axisLabel: { color: o._t.sub, fontSize: 10, rotate: 25 } });
    o.yAxis = Object.assign(rowAxis(rows.map(function (r) { return r.name; })), { splitLine: { show: false }, inverse: true });
    o.visualMap = { min: 0, max: max, left: 'center', bottom: 2, orient: 'horizontal', itemWidth: 12, itemHeight: 90,
      textStyle: { color: o._t.sub, fontSize: 11 }, inRange: { color: ['#eef3fb', '#f7d471', '#ef7a5a', '#d63030'] } };
    o.series = [{ type: 'heatmap', data: data, label: { show: true, fontSize: 10, color: o._t.ink, formatter: function (p) { return p.value[2] || ''; } }, itemStyle: { borderColor: o._t.card, borderWidth: 1 } }];
    return mk('c_excMatrix', o);
  }

  /* ============================== 工时与加班 ============================== */
  function workHist() {
    var w = M.workLoad();
    var o = base();
    o.grid = { left: 42, right: 20, top: 26, bottom: 40, containLabel: true };
    o.tooltip = { formatter: function (x) { return x.name + '<br><b>' + x.value + '</b> 人日'; }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.xAxis = Object.assign(axis(w.workHist.map(function (b) { return b.name; })), { splitLine: { show: false }, axisLabel: { color: o._t.sub, fontSize: 10, rotate: 30 } });
    o.yAxis = vAxis('人日数');
    o.series = [{ type: 'bar', barMaxWidth: 26, label: { show: true, position: 'top', fontSize: 10, color: o._t.sub },
      data: w.workHist.map(function (b, i) { return { value: b.count, itemStyle: { borderRadius: [3, 3, 0, 0], color: i <= 3 ? '#e59118' : (i <= 6 ? '#5b8dff' : '#e14b4b') } }; }) }];
    return mk('c_workHist', o);
  }

  function streakChart() {
    var rows = M.workLoad().streak.filter(function (r) { return r.streak > 5; }).slice(0, 15);
    if (!rows.length) return noData('c_streak', '无连续在岗超过 5 天的记录');
    var o = base();
    rowsLayout('c_streak', rows.length, 280, 24, 48);
    o.grid = { left: 112, right: 46, top: 26, bottom: 26, containLabel: true };
    o.tooltip = { formatter: function (p) { var r = rows[rows.length - 1 - p.dataIndex]; return r.name + '（' + r.dept + '）<br>最长连续在岗 <b>' + r.streak + '</b> 天<br>区间内在岗 ' + r.days + ' 天，其中休息日 ' + r.restDays + ' 天<br>加班 ' + r.otHours.toFixed(1) + 'h'; }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.yAxis = Object.assign(rowAxis(rows.map(function (r) { return r.name; }).reverse()), { splitLine: { show: false } });
    o.xAxis = Object.assign(vAxis(''), { minInterval: 1 });
    o.grid.bottom = 34;
    o.series = [{ type: 'bar', barMaxWidth: 14, label: { show: true, position: 'right', fontSize: 10.5, color: o._t.sub },
      data: rows.map(function (r) { return { value: r.streak, itemStyle: { borderRadius: [0, 3, 3, 0], color: r.streak >= 12 ? '#e14b4b' : (r.streak >= 8 ? '#e59118' : '#5b8dff') } }; }).reverse() }];
    return mk('c_streak', o);
  }

  function otCompChart() {
    var rows = M.workLoad().otComp.filter(function (r) { return r.hours > 0.05; });
    return donut('c_ot', rows.map(function (r) { return [r.name, +r.hours.toFixed(1)]; }), '小时');
  }

  function otRankChart() {
    var rows = M.workLoad().otRank.slice(0, 20);
    if (!rows.length) return noData('c_otRank');
    var o = base();
    rowsLayout('c_otRank', rows.length, 360, 24, 48);
    o.grid = { left: 112, right: 52, top: 28, bottom: 26, containLabel: true };
    o.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 },
      formatter: function (ps) { var r = rows[rows.length - 1 - ps[0].dataIndex]; return '<b>' + r.name + '</b>（' + r.dept + '）<br>加班 ' + r.otHours.toFixed(1) + 'h / 总工时 ' + r.workHours.toFixed(0) + 'h<br>出勤人日 ' + r.days + ' · 外勤 ' + r.outside + ' 次'; } };
    o.legend.top = 0;
    o.yAxis = Object.assign(rowAxis(rows.map(function (r) { return r.name; }).reverse()), { splitLine: { show: false } });
    o.xAxis = vAxis('小时');
    o.series = [
      { name: '加班时长', type: 'bar', stack: 'w', barMaxWidth: 16, itemStyle: { color: '#e14b4b' }, data: rows.map(function (r) { return +r.otHours.toFixed(1); }).reverse() },
      { name: '标准工时内', type: 'bar', stack: 'w', barMaxWidth: 16, itemStyle: { color: '#5b8dff', borderRadius: [0, 3, 3, 0] }, data: rows.map(function (r) { return +(Math.max(0, r.workHours - r.otHours)).toFixed(1); }).reverse() }
    ];
    o.series = [o.series[0]];
    o.series[0].name = '19点后加班';
    return mk('c_otRank', o);
  }

  function lateNightChart() {
    var n = M.workLoad().night;
    if (!n.length) return noData('c_lateNight');
    var o = base();
    o.grid = { left: 46, right: 46, top: 30, bottom: 42, containLabel: true };
    o.tooltip = { trigger: 'axis', backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 },
      formatter: function (ps) { var d = n[ps[0].dataIndex]; return d.date + '<br>平均最晚离岗 <b>' + U.fmtMin(d.avg) + '</b><br>90 分位离岗 ' + U.fmtMin(d.p90) + '<br>21 点后离岗 ' + d.over21 + ' 人 · 23 点后 ' + d.over23 + ' 人'; } };
    o.legend.top = 0;
    o.xAxis = Object.assign(axis(n.map(function (d) { return shortDate(d.date); })), { splitLine: { show: false }, axisLabel: { color: o._t.sub, fontSize: 10, rotate: 45, hideOverlap: true } });
    o.yAxis = [Object.assign(vAxis(), { axisLabel: { formatter: function (v) { return U.fmtMin(v); }, color: o._t.sub, fontSize: 11 }, min: 15 * 60, max: Math.max(25*60,Math.ceil(Math.max.apply(null,n.map(function(x){return x.p90||0;}))/60)*60) }), vAxis('')];
    o.series = [
      { name: '平均离岗时刻', type: 'line', smooth: true, symbol: 'none', lineStyle: { width: 2.4 }, itemStyle: { color: '#e59118' }, data: n.map(function (d) { return d.avg; }) },
      { name: '90 分位离岗时刻', type: 'line', smooth: true, symbol: 'none', lineStyle: { width: 1.6, type: 'dashed' }, itemStyle: { color: '#7b61d6' }, data: n.map(function (d) { return d.p90; }) },
      { name: '21 点后离岗人数', type: 'bar', yAxisIndex: 1, barMaxWidth: 14, itemStyle: { color: 'rgba(225,75,75,.55)' }, data: n.map(function (d) { return d.over21; }) }
    ];
    return mk('c_lateNight', o);
  }

  /* ============================== 部门对比 ============================== */
  function deptRadar() {
    var rows=M.deptCompare().filter(function(r){return r.attendanceRate!=null;});
    if(!rows.length)return noData('c_deptRadar','没有可核定应出勤人日');
    var o=base();
    rowsLayout('c_deptRadar',rows.length,360,24,60);
    o.grid={left:100,right:35,top:30,bottom:35,containLabel:true};
    o.yAxis=rowAxis(rows.map(function(r){return r.dept;}).reverse());
    o.xAxis=Object.assign(vAxis('核定比率 %'),{min:0,max:100});
    o.series=[
      {name:'出勤率',type:'bar',data:rows.map(function(r){return r.attendanceRate*100;}).reverse()},
      {name:'准点率',type:'bar',data:rows.map(function(r){return r.onTimeRate==null?null:r.onTimeRate*100;}).reverse()}];
    return mk('c_deptRadar',o);
  }

  function deptBar() {
    var rows = M.deptCompare();
    if (!rows.length) return noData('c_deptBar');
    var metrics = [
      { name: '出勤率', get: function (r) { return percent(r.attendanceRate); }, ax: 0 },
      { name: '迟到率', get: function (r) { return percent(r.lateRate); }, ax: 0 },
      { name: '缺卡率', get: function (r) { return percent(r.missRate); }, ax: 0 },
      { name: '人均工时(h/人日)', get: function (r) { return +r.avgWorkHours.toFixed(2); }, ax: 1 },
      { name: '人均加班(h)', get: function (r) { return +r.otHoursPerHead.toFixed(1); }, ax: 1 },
      { name: '外勤占比', get: function (r) { return percent(r.outsideRate); }, ax: 0 }
    ];
    var o = base();
    o.grid = { left: 44, right: 20, top: 30, bottom: 60, containLabel: true };
    o.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    o.legend = { type: 'scroll', bottom: 0, textStyle: { color: o._t.sub, fontSize: 11 }, itemWidth: 10, itemHeight: 8 };
    o.xAxis = Object.assign(axis(rows.map(function (r) { return r.dept; })), { splitLine: { show: false }, axisLabel: { color: o._t.sub, fontSize: 10, rotate: 25 } });
    o.yAxis = [Object.assign(vAxis('比率 %'), { axisLabel: { formatter: '{value}%', color: o._t.sub, fontSize: 11 },
        splitLine: { lineStyle: { color: o._t.line, type: 'dashed' } } }),
      Object.assign(vAxis('小时'), { splitLine: { show: false } })];
    o.series = metrics.map(function (m) {
      return { name: m.name, type: 'bar', yAxisIndex: m.ax, barMaxWidth: 16,
        itemStyle: { borderRadius: [3, 3, 0, 0] }, data: rows.map(m.get) };
    });
    return mk('c_deptBar', o);
  }

  /* ============================== 个人画像 ============================== */
  function personTime(uid) {
    var p = M.person(uid);
    var o = base();
    o.grid = { left: 46, right: 20, top: 30, bottom: 36, containLabel: true };
    o.tooltip = { trigger: 'axis', backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 },
      formatter: function (ps) { var row = p.time[ps[0].dataIndex]; return row[0] + (row[5] ? '（外勤 ' + row[5] + ' 次）' : '') + '<br>到岗 ' + U.fmtMin(row[1]) + '（' + U.fmtOffset(row[3]) + '）<br>离岗 ' + U.fmtMin(row[2]) + (row[4] ? '<br><span style="color:#f6b26b">迟到</span>' : ''); } };
    o.legend.top = 0;
    o.xAxis = Object.assign(axis(p.time.map(function (r) { return r[0].slice(5); })), { splitLine: { show: false }, axisLabel: { color: o._t.sub, fontSize: 10, rotate: 45, hideOverlap: true } });
    var vals = [].concat(p.time.map(function (r) { return r[1]; }), p.time.map(function (r) { return r[2]; })).filter(function (v) { return v != null; });
    var lo = vals.length ? Math.floor((Math.min.apply(null, vals) - 45) / 60) * 60 : 6 * 60;
    var hi = vals.length ? Math.ceil((Math.max.apply(null, vals) + 45) / 60) * 60 : 22 * 60;
    o.yAxis = Object.assign(vAxis(), { axisLabel: { formatter: function (v) { return U.fmtMin(v); }, color: o._t.sub, fontSize: 11 }, min: lo, max: hi });
    o.series = [
      { name: '到岗', type: 'line', smooth: true, symbol: 'circle', symbolSize: 5, data: p.time.map(function (r) { return r[1]; }), itemStyle: { color: '#2f6fed' }, lineStyle: { width: 2 } },
      // 只打了一次卡（缺卡）的那天没有“离岗”概念，置空避免画成 07:00 下班
      { name: '离岗', type: 'line', smooth: true, symbol: 'circle', symbolSize: 5, connectNulls: false,
        data: p.time.map(function (r) { return r[2] > r[1] ? r[2] : null; }), itemStyle: { color: '#e59118' }, lineStyle: { width: 2 } },
      { name: '迟到', type: 'scatter', symbolSize: 9, itemStyle: { color: '#e14b4b' }, data: p.time.filter(function (r) { return r[4]; }).map(function (r) { return r[1]; }) }
    ];
    return mk('c_personTime', o);
  }

  function personCal(uid) {
    var p = M.person(uid);
    if (!p.cal.length) return noData('c_personCal');
    var o = base();
    o.grid = undefined;
    o.tooltip = { formatter: function (x) { return x.value[0] + ' 打卡 <b>' + x.value[1] + '</b> 次'; }, backgroundColor: 'rgba(24,30,42,.94)', borderWidth: 0, textStyle: { color: '#eef2fa', fontSize: 12 } };
    var dates = p.cal.map(function (c) { return c[0]; }).sort();
    var max = p.cal.reduce(function (a, c) { return Math.max(a, c[1]); }, 1);
    o.visualMap = { min: 0, max: max, show: false };
    o.visualMap = { min: 0, max: max, show: false, calculable: false };
    o.calendar = { range: [dates[0], dates[dates.length - 1]], orient: 'vertical', cellSize: [44, 15], top: 26, left: 40, right: 14, bottom: 34,
      itemStyle: { borderColor: o._t.line, borderWidth: 1, borderRadius: 2 }, splitLine: { lineStyle: { color: o._t.line } },
      yearLabel: { show: false }, monthLabel: { color: o._t.ink, fontSize: 10, nameMap: 'cn', position: 'start' },
      dayLabel: { color: o._t.sub, fontSize: 9, position: 'start', nameMap: ['日', '一', '二', '三', '四', '五', '六'] }, weekLabel: { show: false } };
    o.series = [{ type: 'heatmap', coordinateSystem: 'calendar', data: p.cal }];
    return mk('c_personCal', o);
  }

  var currentMapType = function () { return 'all'; };

  var builders = {
    overview: [dailyAttendance, hourDist, wdHour, topPlaceMini],
    time: [function () { offsetHist('c_arriveOffset', 'in'); }, function () { offsetHist('c_leaveOffset', 'out'); },
      avgTimes, calendar, boxWeek, deptHour, scatterTime],
    place: [placeType, cityChart, distanceChart, topPlace, diversityChart, wifiChart, deviceChart],
    trend: [rateTrend, workTrend, deptDay, weekCmp, weekdayProfile, monthCmp],
    risk: [excPie, excTrend, spChart, personRank, excMatrix],
    load: [workHist, streakChart, otCompChart, otRankChart, lateNightChart],
    dept: [deptRadar, deptBar]
  };

  global.Charts = {
    renderTab: function (tab) { (builders[tab] || []).forEach(function (f) { try { f(); } catch (e) { console.error(tab, e); } }); },
    renderAll: function () { Object.keys(builders).forEach(function (t) { this.renderTab(t); }, this); },
    resizeAll: resizeAll,
    setMapType: function (t) { currentMapType = function () { return t; }; },
    person: function (uid) { personTime(uid); personCal(uid); },
    insts: insts,
    disposeAll: function () { Object.keys(insts).forEach(function (k) { insts[k].dispose(); }); for (var k in insts) delete insts[k]; }
  };
  M = Metrics; U = global.U; S = global.Store;
})(window);

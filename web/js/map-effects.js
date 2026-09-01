/* 地图视觉与输入算法：浮点密度、平滑扩散和滚轮防抖。无DOM/网络依赖，便于回归。 */
(function (root) {
  'use strict';
  // 高饱和蓝→青→绿→黄→橙→红，与 app.css 图例渐变保持一致；低饱和中间色在浅色底图上会糊成一片。
  var HEAT_STOPS = [
    [0, 40, 90, 240], [.25, 0, 185, 245], [.45, 60, 215, 120],
    [.65, 255, 220, 60], [.82, 255, 130, 45], [1, 232, 45, 45]
  ];

  function blurAxis(input, output, width, height, kernel, radius, vertical) {
    var lines = vertical ? width : height, length = vertical ? height : width;
    var stride = vertical ? width : 1;
    for (var line = 0; line < lines; line++) {
      var base = vertical ? line : line * width;
      for (var i = 0; i < length; i++) {
        var sum = 0, first = Math.max(0,i-radius), last = Math.min(length-1,i+radius);
        for(var k=first;k<=last;k++)sum += input[base+k*stride]*kernel[k-i+radius];
        output[base + i * stride] = sum;
      }
    }
  }

  function density(points, width, height, spread) {
    var cell = Math.max(3, Math.ceil(width / 450));
    var cols = Math.max(0, Math.ceil(width / cell)), rows = Math.max(0, Math.ceil(height / cell));
    if (!cols || !rows) return {width:0,height:0,values:new Float32Array(0),max:0};
    var sigma = Math.max(1, (spread || 30) / cell), radius = Math.ceil(5 * sigma);
    var kernel = new Float64Array(radius*2+1), kernelSum=0;
    for(var kk=-radius;kk<=radius;kk++){var kv=Math.exp(-.5*kk*kk/(sigma*sigma));kernel[kk+radius]=kv;kernelSum+=kv;}
    for(var ki=0;ki<kernel.length;ki++)kernel[ki]/=kernelSum;
    var pad = radius + 3, w = cols + 2 * pad, h = rows + 2 * pad;
    var field = new Float32Array(w * h), scratch = new Float32Array(w * h);
    points.forEach(function (point) {
      var weight = point.weight == null ? 1 : Number(point.weight);
      if (!isFinite(point.x) || !isFinite(point.y) || !isFinite(weight) || weight <= 0) return;
      var x = point.x / cell + pad, y = point.y / cell + pad;
      var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
      if (ix < 0 || iy < 0 || ix >= w - 1 || iy >= h - 1) return;
      // 双线性散点，避免拖动或缩放时跳到整格；浮点累加不会在255饱和。
      field[iy*w+ix] += weight*(1-fx)*(1-fy);
      field[iy*w+ix+1] += weight*fx*(1-fy);
      field[(iy+1)*w+ix] += weight*(1-fx)*fy;
      field[(iy+1)*w+ix+1] += weight*fx*fy;
    });
    // 可分离高斯卷积，截断到5σ处时尾部已不可见，避免圆盘或方形边界。
    blurAxis(field, scratch, w, h, kernel, radius, false);
    blurAxis(scratch, field, w, h, kernel, radius, true);
    var values = new Float32Array(cols * rows), peak = 0;
    for (var yy = 0; yy < rows; yy++) for (var xx = 0; xx < cols; xx++) {
      var value = field[(yy+pad)*w+xx+pad];
      values[yy*cols+xx] = value;
      peak = Math.max(peak, value);
    }
    return {width:cols,height:rows,values:values,max:peak,cellSize:cell};
  }

  function colorAt(value, mono) {
    if (mono) return [47, 111, 237];
    for (var i = 1; i < HEAT_STOPS.length; i++) {
      if (value <= HEAT_STOPS[i][0]) {
        var lo = HEAT_STOPS[i-1], hi = HEAT_STOPS[i];
        var t = (value-lo[0])/(hi[0]-lo[0]);
        return [lo[1]+(hi[1]-lo[1])*t,lo[2]+(hi[2]-lo[2])*t,lo[3]+(hi[3]-lo[3])*t];
      }
    }
    return HEAT_STOPS[HEAT_STOPS.length-1].slice(1);
  }

  function colorize(field, mono) {
    var rgba = new Uint8ClampedArray(field.values.length * 4);
    if (!(field.max > 0)) return rgba;
    for (var i = 0; i < field.values.length; i++) {
      var relative = Math.max(0, Math.min(1, field.values[i] / field.max));
      // 温和幂次（原 log1p 压缩把中低密度全推到橙红段），让色带全程展开、密度分层可辨；
      // 指数不能更小，否则远端尾部不再衰减到 0，热区边界会残留底色。
      var intensity = Math.pow(relative, .75);
      // 热核满饱和，不再封顶 190；半透明热区在浅色底图上不够醒目。
      var alpha = Math.round(255 * Math.pow(intensity, .75));
      if (!alpha) continue;
      var rgb = colorAt(intensity, mono), offset = i * 4;
      rgba[offset] = rgb[0]; rgba[offset+1] = rgb[1]; rgba[offset+2] = rgb[2]; rgba[offset+3] = alpha;
    }
    return rgba;
  }

  function wheelStep(state, event, now, viewportHeight) {
    var delta = Number(event.deltaY);
    if (!isFinite(delta) || delta === 0) return 0;
    if (event.deltaMode === 1) delta *= 40;
    if (event.deltaMode === 2) delta *= viewportHeight || 520;
    if (state.lastInput == null || now-state.lastInput > 180 || state.pinch !== !!event.ctrlKey || state.sum*delta < 0) state.sum = 0;
    state.lastInput = now; state.pinch = !!event.ctrlKey;
    // 限制惯性事件，不在冷却期积攒大量“欠账”。
    if (state.lastZoom != null && now-state.lastZoom < 240) { state.sum = 0; return 0; }
    state.sum = (state.sum || 0) + delta;
    var threshold = event.ctrlKey ? 50 : 120;
    if (Math.abs(state.sum) < threshold) return 0;
    var step = state.sum < 0 ? 1 : -1;
    state.sum = 0; state.lastZoom = now;
    return step;
  }

  var api = {density:density,colorize:colorize,wheelStep:wheelStep};
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MapEffects = api;
})(typeof window === 'undefined' ? {} : window);

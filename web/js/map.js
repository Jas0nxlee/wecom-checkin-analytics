/* 打卡地点热力图：自绘 Web Mercator 瓦片地图 + canvas 热力层，无需任何地图 Key。
   底图用高德栅格瓦片（GCJ-02，与企业微信返回坐标同源）；瓦片不可用时自动降级为坐标分布图。 */
(function (global) {
  'use strict';

  var TILE = 256;


  function lng2x(lng, z) { return (lng + 180) / 360 * TILE * Math.pow(2, z); }
  function lat2y(lat, z) {
    var s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * Math.pow(2, z);
  }
  function x2lng(x, z) { return x / (TILE * Math.pow(2, z)) * 360 - 180; }
  function y2lat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / (TILE * Math.pow(2, z));
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
  // 每像素多少米：世界周长 40075016.686m / (256 * 2^z) 像素，再乘纬度收缩
  function mPerPx(lat, z) {
    return 40075016.686 * Math.cos(lat * Math.PI / 180) / (TILE * Math.pow(2, z));
  }

  function MapView(el) {
    this.el = el;
    this.center = { lat: 31.23, lng: 121.47 };
    this.zoom = 11;
    this.mode = 'heat';
    this.points = [];
    this.clusters = [];
    this.heatSpread = 30;
    this.wheelState = {};
    this.tilesOff = false;
    this.tileOk = 0; this.tileFail = 0; this.tileChecked = false;
    this.build();
    this.bind();
  }

  MapView.prototype.build = function () {
    this.el.innerHTML = '';
    this.tiles = document.createElement('div');
    this.tiles.className = 'tiles';
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.tiles);
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.tip = document.createElement('div');
    this.tip.style.cssText = 'position:absolute;pointer-events:none;background:rgba(20,26,38,.92);color:#fff;' +
      'font-size:11.5px;padding:5px 8px;border-radius:6px;display:none;z-index:9;max-width:260px;line-height:1.5';
    this.el.appendChild(this.tip);
  };

  MapView.prototype.resize = function () {
    var r = this.el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  };

  MapView.prototype.setOptions = function (o) {
    Object.assign(this, o);
    this.render();
  };

  /* points: [{lat,lng,weight,name,dept,type,time,place}] */
  MapView.prototype.setData = function (points, opt) {
    opt = opt || {};
    this.points = (points || []).filter(function (p) { return global.U && global.U.validCoord ? global.U.validCoord(p) : true; });
    this.clusters = opt.clusters || [];
    if (opt.fit !== false && points.length) this.fit(points);
    this.render();
  };

  MapView.prototype.fit = function (pts) {
    if (!this.w || !this.h) this.resize();
    if (!this.w) return;
    var lats = pts.map(function (p) { return p.lat; }).sort(function (a, b) { return a - b; });
    var lngs = pts.map(function (p) { return p.lng; }).sort(function (a, b) { return a - b; });
    // 用 2%~98% 分位数做边界，避免个别跨城/漂点把视野拉到全国尺度
    var minLa = U_quantile(lats, 0.02), maxLa = U_quantile(lats, 0.98);
    var minLo = U_quantile(lngs, 0.02), maxLo = U_quantile(lngs, 0.98);
    if (!(maxLa > minLa) || !(maxLo > minLo)) { minLa = lats[0]; maxLa = lats[lats.length - 1]; minLo = lngs[0]; maxLo = lngs[lngs.length - 1]; }
    this.center = { lat: (minLa + maxLa) / 2, lng: (minLo + maxLo) / 2 };
    var picked = 3;
    for (var z = 18; z >= 3; z--) {
      var w = Math.abs(lng2x(maxLo, z) - lng2x(minLo, z));
      var h = Math.abs(lat2y(minLa, z) - lat2y(maxLa, z));
      if (w < this.w * 0.88 && h < this.h * 0.88) { picked = z; break; }   // 从大到小，取能装下的最大级别
    }
    this.zoom = picked;
  };
  function U_quantile(sorted, q) {
    if (!sorted.length) return 0;
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  MapView.prototype.centerPx = function () {
    return { x: lng2x(this.center.lng, this.zoom), y: lat2y(this.center.lat, this.zoom) };
  };
  MapView.prototype.proj = function (p) {
    var c = this.centerPx();
    return { x: lng2x(p.lng, this.zoom) - c.x + this.w / 2, y: lat2y(p.lat, this.zoom) - c.y + this.h / 2 };
  };

  /* ---------------- 瓦片 ---------------- */
  MapView.prototype.renderTiles = function () {
    if (this.tilesOff) { this.tiles.style.display = 'none'; return; }
    this.tiles.style.display = '';
    var z = this.zoom, c = this.centerPx();
    var x0 = Math.floor((c.x - this.w / 2) / TILE), x1 = Math.floor((c.x + this.w / 2) / TILE);
    var y0 = Math.floor((c.y - this.h / 2) / TILE), y1 = Math.floor((c.y + this.h / 2) / TILE);
    var max = Math.pow(2, z), html = [];
    var n = 0;
    for (var x = x0; x <= x1; x++) {
      for (var y = y0; y <= y1; y++) {
        if (y < 0 || y >= max) continue;
        var tx = ((x % max) + max) % max;
        var host = 'webrd0' + (1 + ((tx + y) % 4)) + '.is.autonavi.com';
        var url = 'https://' + host + '/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=' + tx + '&y=' + y + '&z=' + z;
        html.push('<img src="' + url + '" data-u="' + url + '" style="left:' + (x * TILE - c.x + this.w / 2) +
          'px;top:' + (y * TILE - c.y + this.h / 2) + 'px;width:' + TILE + 'px;height:' + TILE + 'px">');
        n++;
      }
    }
    this.tiles.innerHTML = html.join('');
    if (!this.tileChecked && n) {
      var imgs = this.tiles.querySelectorAll('img'), done = 0;
      var check = function (ok) {
        done++; if (ok) this.tileOk++; else this.tileFail++;
        if (done >= Math.min(n, 6)) {
          this.tileChecked = true;
          if (this.tileFail >= Math.min(n, 6)) { this.tilesOff = true; this.tiles.innerHTML = ''; this.renderOverlay(); global.__mapOffline = true; }
        }
      }.bind(this);
      Array.prototype.forEach.call(imgs, function (im) {
        if (im.complete && im.naturalWidth) return check(true);
        im.onload = function () { check(true); };
        im.onerror = function () { check(false); };
      });
      setTimeout(function () { if (!this.tileChecked) { this.tileChecked = true; } }.bind(this), 4000);
    }
  };

  /* ---------------- 热力/点位覆盖层 ---------------- */
  MapView.prototype.renderOverlay = function () {
    if (!this.w) return;
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.tilesOff) this.drawGridBg();
    if (!this.points.length) {
      ctx.fillStyle = 'rgba(128,140,160,.75)';
      ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('当前筛选条件下没有带经纬度的打卡记录', this.w / 2, this.h / 2);
      return;
    }
    if (this.mode === 'heat' || this.mode === 'density') this.drawHeat();
    else if (this.mode === 'point') this.drawPoints();
    else this.drawClusters();
    this.drawScale();
  };

  MapView.prototype.drawGridBg = function () {
    var ctx = this.ctx, c = this.centerPx();
    this._bb = {la0:y2lat(c.y+this.h/2,this.zoom),la1:y2lat(c.y-this.h/2,this.zoom),lo0:x2lng(c.x-this.w/2,this.zoom),lo1:x2lng(c.x+this.w/2,this.zoom)};
    ctx.save();
    ctx.strokeStyle = 'rgba(128,140,160,.18)'; ctx.lineWidth = 1;
    for (var i = 0; i <= 10; i++) {
      var x = this.w / 10 * i, y = this.h / 10 * i;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.w, y); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(128,140,160,.8)'; ctx.font = '11px sans-serif';
    ctx.textAlign = 'left'; ctx.fillText('离线底图：坐标分布（GCJ-02）', 10, 18);
    ctx.textAlign = 'right';
    ctx.fillText('经度 ' + this._bb.lo0.toFixed(3) + ' ~ ' + this._bb.lo1.toFixed(3), this.w - 8, this.h - 8);
    ctx.textAlign = 'left';
    ctx.fillText('纬度 ' + this._bb.la0.toFixed(3) + ' ~ ' + this._bb.la1.toFixed(3), 10, this.h - 8);
    ctx.restore();
  };

  // 在线/离线采用同一投影；底图失效不会改变点位，也不会让缩放失效。
  MapView.prototype.project = function (p) { return this.proj(p); };

  MapView.prototype.drawHeat = function () {
    var effects=global.MapEffects;
    var key=[this.w,this.h,this.zoom,this.center.lat,this.center.lng,this.heatSpread].join('|');
    if(!this._heatCache || this._heatCache.key!==key || this._heatCache.points!==this.points){
      var projected=this.points.map(function(p){var q=this.project(p);return {x:q.x,y:q.y,weight:p.weight};},this);
      this._heatCache={key:key,points:this.points,field:effects.density(projected,this.w,this.h,this.heatSpread)};
    }
    var field=this._heatCache.field;
    if(!field.width || !field.height)return;
    var off=this._heatCanvas || (this._heatCanvas=document.createElement('canvas'));
    off.width=field.width;off.height=field.height;
    var o=off.getContext('2d'),img=o.createImageData(field.width,field.height);
    img.data.set(effects.colorize(field,this.mode==='density'));
    o.putImageData(img,0,0);
    this.ctx.save();
    this.ctx.imageSmoothingEnabled=true;
    this.ctx.imageSmoothingQuality='high';
    this.ctx.drawImage(off,0,0,field.width,field.height,0,0,this.w,this.h);
    this.ctx.restore();
  };

  MapView.prototype.drawPoints = function () {
    var ctx = this.ctx, self = this;
    var maxW = this.points.reduce(function (a, p) { return Math.max(a, p.weight || 1); }, 1);
    this.points.forEach(function (p) {
      var q = self.project(p);
      if (q.x < -20 || q.x > self.w + 20 || q.y < -20 || q.y > self.h + 20) return;
      var r = 3 + 9 * Math.sqrt((p.weight || 1) / maxW);
      ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.fillStyle = p.type === '外出打卡' ? 'rgba(225,75,75,.55)' : (p.type === '下班打卡' ? 'rgba(18,160,106,.5)' : 'rgba(47,111,237,.5)');
      ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.stroke();
    });
  };

  MapView.prototype.drawClusters = function () {
    var ctx = this.ctx, self = this;
    var max = this.clusters.reduce(function (a, c) { return Math.max(a, c.count); }, 1);
    this.clusters.slice(0, 60).forEach(function (c) {
      var q = self.project(c);
      if (q.x < -30 || q.x > self.w + 30 || q.y < -30 || q.y > self.h + 30) return;
      var r = 9 + 17 * Math.sqrt(c.count / max);
      ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.fillStyle = c.type === '外勤现场' ? 'rgba(225,75,75,.82)' : (c.type === '主办公点' ? 'rgba(47,111,237,.82)' : 'rgba(90,120,170,.7)');
      ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold ' + (10 + r / 3) + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(c.count, q.x, q.y);
      if (r > 15) {
        ctx.font = '11px sans-serif'; ctx.fillStyle = 'rgba(230,238,250,.95)';
        ctx.fillText(c.name.length > 10 ? c.name.slice(0, 9) + '…' : c.name, q.x, q.y + r + 9);
      }
    });
  };



  MapView.prototype.drawScale = function () {
    var ctx = this.ctx;
    if (this.tilesOff) return;
    var mp = mPerPx(this.center.lat, this.zoom);
    var targetPx = 90, meters = targetPx * mp;
    var pow = Math.pow(10, Math.floor(Math.log(meters) / Math.LN10));
    var nice = [1, 2, 5, 10].map(function (k) { return k * pow; }).filter(function (v) { return v >= meters * 0.4; })[0] || pow;
    var px = nice / mp;
    ctx.save();
    ctx.strokeStyle = 'rgba(120,130,150,.9)'; ctx.lineWidth = 2;
    var x = this.w - px - 14, y = this.h - 16;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + px, y); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
    ctx.moveTo(x + px, y - 4); ctx.lineTo(x + px, y + 4); ctx.stroke();
    ctx.fillStyle = 'rgba(120,130,150,.95)'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(nice >= 1000 ? (nice / 1000) + ' km' : nice + ' m', x + px / 2, y - 7);
    ctx.restore();
  };

  MapView.prototype.render = function () {
    if (!this.resize()) return;
    this.renderTiles();
    this.renderOverlay();
  };

  MapView.prototype.zoomBy = function (d) {
    this.zoom = Math.max(3, Math.min(18, this.zoom + d));
    this.render();
  };

  MapView.prototype.zoomAt = function (step, x, y) {
    var next=Math.max(3,Math.min(18,this.zoom+step));
    if(next===this.zoom || !this.w || !this.h)return false;
    var c=this.centerPx(),dx=x-this.w/2,dy=y-this.h/2,factor=Math.pow(2,next-this.zoom);
    var cx=(c.x+dx)*factor-dx,cy=(c.y+dy)*factor-dy;
    this.zoom=next;this.center={lng:x2lng(cx,next),lat:y2lat(cy,next)};
    this.render();
    return true;
  };

  /* ---------------- 交互 ---------------- */
  MapView.prototype.bind = function () {
    var self = this, drag = null;
    this.el.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, y: e.clientY, center: self.centerPx() };
      self.el.classList.add('drag');
      self.el.setPointerCapture && self.el.setPointerCapture(e.pointerId);
    });
    this.el.addEventListener('pointermove', function (e) {
      if (drag) {
        var c = drag.center;
        var nx = c.x - (e.clientX - drag.x), ny = c.y - (e.clientY - drag.y);
        self.center = { lng: x2lng(nx, self.zoom), lat: y2lat(ny, self.zoom) };
        self.render();
        return;
      }
      self.hover(e);
    });
    var up = function () { drag = null; self.el.classList.remove('drag'); };
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointerleave', function () { up(); self.tip.style.display = 'none'; });
    this.el.addEventListener('wheel', function (e) {
      e.preventDefault();
      var step=global.MapEffects.wheelStep(self.wheelState,e,Date.now(),self.h);
      if(!step)return;
      var rect=self.el.getBoundingClientRect();
      self.zoomAt(step,e.clientX-rect.left,e.clientY-rect.top);
    }, { passive: false });
    this.el.addEventListener('dblclick', function (e) {
      self.zoom = Math.min(18, self.zoom + 1); self.render();
    });
    global.addEventListener('resize', function () { self.render(); });
  };

  MapView.prototype.hover = function (e) {
    var rect = this.el.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var pool = this.mode === 'cluster' ? this.clusters : this.points;
    var best = null, bestD = 1e9, self = this;
    for (var i = 0; i < pool.length; i++) {
      var q = this.project(pool[i]);
      var d = (q.x - mx) * (q.x - mx) + (q.y - my) * (q.y - my);
      if (d < bestD) { bestD = d; best = pool[i]; }
    }
    if (best && bestD < 22 * 22) {
      var html = best.name
        ? '<b>' + U.escapeHtml(best.name) + '</b><br>' + U.escapeHtml(best.detail || '') + '<br>' + (best.count ? '打卡 ' + best.count + ' 次 · ' + best.users + ' 人' : '')
        : '';
      if (!html && best.place) html = '<b>' + U.escapeHtml(best.place) + '</b><br>' + U.escapeHtml(best.name || '') + ' · ' + U.escapeHtml(best.dept || '') + '<br>' + U.escapeHtml(best.time || '') + ' ' + U.escapeHtml(best.type || '');
      if (!html) return (this.tip.style.display = 'none');
      this.tip.innerHTML = html;
      this.tip.style.display = 'block';
      this.tip.style.left = Math.min(this.w - 270, mx + 12) + 'px';
      this.tip.style.top = (my + 12) + 'px';
    } else this.tip.style.display = 'none';
  };

  MapView.prototype.reset = function () { if (this.points.length) { this.fit(this.points); this.render(); } };

  MapView.prototype.focusCity = function (name) {
    var pool = this.points.filter(function (p) { return (p.place || '').indexOf(name) >= 0 || (p.detail || '').indexOf(name) >= 0; });
    if (pool.length >= 3) { this.fit(pool); this.render(); }
  };

  global.MapView = MapView;
})(window);

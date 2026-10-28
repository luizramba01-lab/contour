/* CONTOUR · staging v4 "Carta bianca"
   Live contour engine: marching squares over real elevation data
   (Cervinia/Matterhorn DEM -> blank -> Teufelsberg DEM), driven by time, scroll and touch.
   Vanilla, no dependencies. */
(function () {
  "use strict";
  var W = window, D = document, root = D.documentElement;
  var REDUCE = W.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var FINE = W.matchMedia("(hover: hover) and (pointer: fine)").matches;
  var $ = function (s, c) { return (c || D).querySelector(s); };
  var $$ = function (s, c) { return [].slice.call((c || D).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var sstep = function (a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  var fmt = function (n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); };

  /* ---------- palette ---------- */
  var C = { forest: [30, 70, 54], bone: [239, 233, 220], lichen: [169, 184, 154], ink: [21, 21, 21] };
  function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function rgba(c, a) { return "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + a + ")"; }

  /* ---------- DEM loading ---------- */
  var DEM = {
    cervinia: { url: "assets/data/cervinia.bin", n: 208, peak: [109, 62], data: null },
    teufelsberg: { url: "assets/data/teufelsberg.bin", n: 144, peak: [65, 73], data: null }
  };
  function loadDEM(d) {
    return fetch(d.url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then(function (buf) {
      var u = new Uint16Array(buf), f = new Float32Array(u.length);
      for (var i = 0; i < u.length; i++) f[i] = u[i] / 65535;
      d.data = f; return d;
    });
  }
  function sample(d, u, v) { /* bilinear with mirrored edges */
    var n = d.n, m = n - 1;
    u = u < 0 ? -u : u > m ? 2 * m - u : u; v = v < 0 ? -v : v > m ? 2 * m - v : v;
    u = clamp(u, 0, m - 0.001); v = clamp(v, 0, m - 0.001);
    var x = u | 0, y = v | 0, fx = u - x, fy = v - y, a = d.data, i = y * n + x;
    return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + n] * (1 - fx) + a[i + n + 1] * fx) * fy;
  }

  /* ---------- contour field renderer ---------- */
  function Field(canvas, opt) {
    this.cv = canvas; this.ctx = canvas.getContext("2d"); this.opt = opt || {};
    this.cols = 0; this.rows = 0; this.F = null; this.A = null; this.B = null;
  }
  Field.prototype.resize = function () {
    var r = this.cv.getBoundingClientRect(), w = Math.max(1, r.width), h = Math.max(1, r.height);
    var dpr = Math.min(W.devicePixelRatio || 1, 2);
    this.w = w; this.h = h; this.dpr = dpr;
    this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
    var cs = this.opt.cell || (w < 700 ? 5 : 7);
    this.cs = cs; this.cols = Math.ceil(w / cs) + 2; this.rows = Math.ceil(h / cs) + 2;
    var N = this.cols * this.rows;
    this.F = new Float32Array(N); this.A = new Float32Array(N); this.B = new Float32Array(N);
    this.mapLayers();
  };
  /* map each DEM onto the grid: DEM peak sits at the focal point (fx,fy) of the screen */
  Field.prototype.mapLayers = function () {
    var o = this.opt, w = this.w, h = this.h, cs = this.cs, cols = this.cols, rows = this.rows;
    var mobile = w < 700, fx = w * (mobile ? o.fxM : o.fx), fy = h * (mobile ? o.fyM : o.fy);
    this.fx = fx; this.fy = fy;
    var layers = [[o.a, this.A, mobile ? o.spanAM : o.spanA], [o.b, this.B, mobile ? o.spanBM : o.spanB]];
    for (var L = 0; L < 2; L++) {
      var d = layers[L][0], out = layers[L][1];
      if (!d || !d.data) { out.fill(0); continue; }
      var s = layers[L][2] / w; /* DEM px per css px */
      /* keep the view inside the DEM so mirrored edges stay invisible */
      var m = d.n - 1, px = d.peak[0], py = d.peak[1];
      var fit = Math.min(px / fx, (m - px) / Math.max(1, w - fx), py / fy, (m - py) / Math.max(1, h - fy));
      if (s > fit) s = fit;
      for (var r = 0; r < rows; r++) {
        var v = py + (r * cs - fy) * s;
        for (var c = 0; c < cols; c++) out[r * cols + c] = sample(d, px + (c * cs - fx) * s, v);
      }
    }
  };
  /* state: {a, b, phase, step, bg, minor, major, bump:{x,y,amp,sig}, scrim} */
  Field.prototype.draw = function (st) {
    var ctx = this.ctx, F = this.F, A = this.A, B = this.B, cols = this.cols, rows = this.rows, cs = this.cs, N = cols * rows;
    var a = st.a, b = st.b, i, r, c;
    for (i = 0; i < N; i++) F[i] = a * A[i] + b * B[i];
    var bm = st.bump;
    if (bm && bm.amp > 0.002) {
      var sg = bm.sig, k = -1 / (2 * sg * sg), rad = sg * 3;
      var c0 = Math.max(0, ((bm.x - rad) / cs) | 0), c1 = Math.min(cols - 1, Math.ceil((bm.x + rad) / cs));
      var r0 = Math.max(0, ((bm.y - rad) / cs) | 0), r1 = Math.min(rows - 1, Math.ceil((bm.y + rad) / cs));
      for (r = r0; r <= r1; r++) { var dy = r * cs - bm.y; for (c = c0; c <= c1; c++) { var dx = c * cs - bm.x; F[r * cols + c] += bm.amp * Math.exp((dx * dx + dy * dy) * k); } }
    }
    /* summit = highest grid node (ignore a 3-cell border) */
    var best = -1, bi = 0;
    for (r = 3; r < rows - 3; r++) for (c = 3; c < cols - 3; c++) { i = r * cols + c; if (F[i] > best) { best = F[i]; bi = i; } }
    this.peakX = (bi % cols) * cs; this.peakY = ((bi / cols) | 0) * cs; this.peakV = best;

    var dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = st.bg; ctx.fillRect(0, 0, this.w, this.h);
    var step = st.step, ph = st.phase, inv = 1 / step;
    var major = this.major || (this.major = []); major.length = 0;
    ctx.beginPath();
    for (r = 0; r < rows - 1; r++) {
      var y0 = r * cs, y1 = y0 + cs;
      for (c = 0; c < cols - 1; c++) {
        i = r * cols + c;
        var tl = F[i], tr = F[i + 1], bl = F[i + cols], br = F[i + cols + 1];
        var mn = tl, mx = tl;
        if (tr < mn) mn = tr; else if (tr > mx) mx = tr;
        if (bl < mn) mn = bl; else if (bl > mx) mx = bl;
        if (br < mn) mn = br; else if (br > mx) mx = br;
        var k0 = Math.ceil(mn * inv - ph), k1 = Math.floor(mx * inv - ph);
        if (k1 < k0) continue;
        var x0 = c * cs, x1 = x0 + cs;
        for (var kk = k0; kk <= k1; kk++) {
          var lv = (kk + ph) * step;
          var idx = (tl > lv ? 8 : 0) | (tr > lv ? 4 : 0) | (br > lv ? 2 : 0) | (bl > lv ? 1 : 0);
          if (idx === 0 || idx === 15) continue;
          /* edge points */
          var tx = x0 + cs * (lv - tl) / (tr - tl), ry = y0 + cs * (lv - tr) / (br - tr);
          var bx = x0 + cs * (lv - bl) / (br - bl), ly = y0 + cs * (lv - tl) / (bl - tl);
          var isMajor = ((kk % 5) + 5) % 5 === 0;
          var s1x, s1y, s2x, s2y, s3x = NaN, s3y, s4x, s4y;
          switch (idx) {
            case 1: case 14: s1x = x0; s1y = ly; s2x = bx; s2y = y1; break;
            case 2: case 13: s1x = bx; s1y = y1; s2x = x1; s2y = ry; break;
            case 3: case 12: s1x = x0; s1y = ly; s2x = x1; s2y = ry; break;
            case 4: case 11: s1x = tx; s1y = y0; s2x = x1; s2y = ry; break;
            case 6: case 9: s1x = tx; s1y = y0; s2x = bx; s2y = y1; break;
            case 7: case 8: s1x = x0; s1y = ly; s2x = tx; s2y = y0; break;
            case 5: case 10:
              var ctr = (tl + tr + bl + br) / 4;
              if ((idx === 5) === (ctr > lv)) { s1x = x0; s1y = ly; s2x = tx; s2y = y0; s3x = bx; s3y = y1; s4x = x1; s4y = ry; }
              else { s1x = x0; s1y = ly; s2x = bx; s2y = y1; s3x = tx; s3y = y0; s4x = x1; s4y = ry; }
              break;
          }
          if (isMajor) { major.push(s1x, s1y, s2x, s2y); if (s3x === s3x) major.push(s3x, s3y, s4x, s4y); }
          else { ctx.moveTo(s1x, s1y); ctx.lineTo(s2x, s2y); if (s3x === s3x) { ctx.moveTo(s3x, s3y); ctx.lineTo(s4x, s4y); } }
        }
      }
    }
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = st.minor; ctx.lineWidth = st.minorW || 0.8; ctx.stroke();
    ctx.beginPath();
    for (i = 0; i < major.length; i += 4) { ctx.moveTo(major[i], major[i + 1]); ctx.lineTo(major[i + 2], major[i + 3]); }
    ctx.strokeStyle = st.major; ctx.lineWidth = st.majorW || 1.35; ctx.stroke();
    /* scrim behind type: fades the lines, never a visible box */
    if (st.scrim) {
      var g, s = st.scrim;
      if (this.w < 860) { g = ctx.createLinearGradient(0, this.h * 0.42, 0, this.h); }
      else { g = ctx.createLinearGradient(0, 0, this.w * 0.62, 0); }
      g.addColorStop(0, rgba(s.c, 0)); g.addColorStop(0.55, rgba(s.c, s.a * 0.8)); g.addColorStop(1, rgba(s.c, s.a));
      if (this.w < 860) { ctx.fillStyle = g; ctx.fillRect(0, this.h * 0.42, this.w, this.h * 0.58); }
      else {
        g = ctx.createLinearGradient(this.w * 0.62, 0, 0, 0);
        g.addColorStop(0, rgba(s.c, 0)); g.addColorStop(0.5, rgba(s.c, s.a * 0.75)); g.addColorStop(1, rgba(s.c, s.a));
        ctx.fillStyle = g; ctx.fillRect(0, 0, this.w * 0.62, this.h);
      }
    }
  };

  /* =========================================================
     STAGE: hero + origin descent
     ========================================================= */
  var stage = $("#top"), canvas = $("#terrain");
  var field = canvas && canvas.getContext ? new Field(canvas, {
    a: DEM.cervinia, b: DEM.teufelsberg,
    fx: 0.68, fy: 0.42, fxM: 0.6, fyM: 0.3,
    spanA: 150, spanAM: 74, spanB: 120, spanBM: 60
  }) : null;
  var hero = $("#hero"), hud = $("#hud"), hudAlt = $("#hud-alt"), hudPlace = $("#hud-place"), hudCoord = $("#hud-coord");
  var summit = $("#summit"), summitLabel = $("#summit-label"), cue = $("#cue"), credit = $("#credit");
  var beats = $$(".beat"), barRead = $("#bar-read-v"), barReadK = $("#bar-read-k");
  var vh = W.innerHeight, stageTop = 0, stageH = 1, inView = true, live = false, needs = true;
  var phase = 0, lastT = 0, avgDt = 16, frames = 0;
  var pointer = { x: 0, y: 0, tx: 0, ty: 0, on: false, amp: 0 };
  var dot = { x: -100, y: -100, init: false };
  var lastLabel = "";

  function measure() {
    vh = W.innerHeight;
    var r = stage.getBoundingClientRect();
    stageTop = r.top + W.scrollY; stageH = stage.offsetHeight;
  }
  /* progress in viewport-heights through the pinned stage */
  function stageY() { return (W.scrollY - stageTop) / vh; }

  /* timeline (units = viewport heights scrolled) */
  var TL = { heroOut: [0.05, 0.55], b0: [0.5, 1.3], desc: [1.15, 1.95], b1: [1.8, 2.55], rise: [2.4, 3.05], b2: [2.9, 9] };
  function beatAlpha(y, w) {
    var inA = sstep(w[0], w[0] + 0.28, y), outA = 1 - sstep(w[1] - 0.25, w[1], y);
    return Math.min(inA, outA);
  }
  function stageState(y) {
    var q;
    if (y < TL.desc[0]) q = 0;
    else if (y < TL.desc[1]) q = 0.5 * sstep(TL.desc[0], TL.desc[1], y);
    else if (y < TL.rise[0]) q = 0.5;
    else q = 0.5 + 0.5 * sstep(TL.rise[0], TL.rise[1], y);
    if (REDUCE) q = y < (TL.desc[0] + TL.desc[1]) / 2 ? 0 : y < (TL.rise[0] + TL.rise[1]) / 2 ? 0.5 : 1;
    return q;
  }
  function altitudeFor(q) {
    if (q <= 0.5) { var t = q / 0.5; return Math.exp(lerp(Math.log(2050), Math.log(34), t)); }
    return lerp(34, 120, (q - 0.5) / 0.5);
  }

  function frame(t) {
    if (!live) return;
    W.requestAnimationFrame(frame);
    if (!inView || D.hidden) { lastT = t; return; }
    var dt = lastT ? Math.min(64, t - lastT) : 16; lastT = t;
    avgDt = avgDt * 0.92 + dt * 0.08;
    if (++frames > 90 && avgDt > 30 && field.cs < 9 && !field.opt.cell) { field.opt.cell = field.cs + 2; field.resize(); frames = 0; }
    var y = stageY();
    if (y > (stageH / vh) + 0.2) return;
    if (!REDUCE) phase = (phase + dt * 0.00022) % 5; /* lines climb slowly toward the summit */

    /* pointer bump grows while held / hovered */
    if (!REDUCE) {
      var target = pointer.on ? 1 : 0;
      pointer.amp += (target - pointer.amp) * (pointer.on ? 0.018 : 0.04) * (dt / 16);
      pointer.x += (pointer.tx - pointer.x) * 0.16; pointer.y += (pointer.ty - pointer.y) * 0.16;
    }
    var q = stageState(y);
    var aC = 1 - sstep(0.02, 0.46, q);
    var aT = 0.035 + 0.6 * sstep(0.55, 0.98, q);
    var k = sstep(0.18, 0.42, q); /* 0 = forest night map, 1 = bone paper */
    var bg = mix(C.forest, C.bone, k);
    var minorC = mix(C.lichen, C.forest, k), majorC = mix(C.bone, C.forest, k);
    var heroA = 1 - sstep(TL.heroOut[0], TL.heroOut[1], y);
    var bumpScale = (aC + aT * 1.2) * 0.62;
    field.draw({
      a: aC, b: aT, phase: phase, step: 1 / 27,
      bg: rgba(bg, 1), minor: rgba(minorC, lerp(0.5, 0.42, k)), major: rgba(majorC, lerp(0.92, 0.78, k)),
      minorW: field.w < 700 ? 0.75 : 0.85, majorW: field.w < 700 ? 1.2 : 1.4,
      bump: { x: pointer.x, y: pointer.y, amp: pointer.amp * bumpScale, sig: field.w < 700 ? 46 : 70 },
      scrim: { c: bg, a: 0.86 }
    });

    /* tone switch: forest -> bone */
    var tone = k > 0.5 ? "light" : "dark";
    if (stage.getAttribute("data-tone") !== tone) { stage.setAttribute("data-tone", tone); updateBar(); }

    /* hero + beats */
    hero.style.opacity = heroA.toFixed(3);
    hero.style.transform = "translate3d(0," + (-(1 - heroA) * 40).toFixed(1) + "px,0)";
    hero.style.visibility = heroA < 0.01 ? "hidden" : "visible";
    if (cue) cue.style.opacity = heroA.toFixed(3);
    var wins = [TL.b0, TL.b1, TL.b2];
    for (var b = 0; b < beats.length; b++) {
      var al = beatAlpha(y, wins[b]);
      beats[b].style.opacity = al.toFixed(3);
      beats[b].style.transform = "translate3d(0," + ((1 - al) * 26).toFixed(1) + "px,0)";
      beats[b].style.visibility = al < 0.01 ? "hidden" : "visible";
    }
    var hudA = sstep(0.35, 0.75, y);
    hud.style.opacity = hudA.toFixed(3);
    var alt = altitudeFor(q);
    hudAlt.textContent = fmt(alt);
    var place = q < 0.12 ? "Cervinia" : q < 0.62 ? "Berlin" : "Teufelsberg, Berlin";
    var coord = q < 0.12 ? "45.93°N 7.63°E" : q < 0.62 ? "52.52°N 13.40°E" : "52.50°N 13.24°E";
    if (hudPlace.textContent !== place) { hudPlace.textContent = place; hudCoord.textContent = coord; }
    if (y < stageH / vh - 1) barRead.textContent = fmt(alt) + " m";

    /* summit marker follows the highest point of the live field */
    var blank = aC < 0.06 && aT < 0.1;
    var px = field.peakX, py = field.peakY;
    if (!dot.init) { dot.x = px; dot.y = py; dot.init = true; }
    var jump = Math.abs(px - dot.x) + Math.abs(py - dot.y) > 120;
    var ease = jump ? 0.22 : 0.3;
    dot.x += (px - dot.x) * ease; dot.y += (py - dot.y) * ease;
    summit.style.transform = "translate3d(" + dot.x.toFixed(1) + "px," + dot.y.toFixed(1) + "px,0)";
    var own = pointer.amp > 0.2 && Math.abs(px - pointer.x) < 60 && Math.abs(py - pointer.y) < 60;
    var label;
    if (own) {
      var m = q < 0.5 ? 1646 + field.peakV / Math.max(aC, 0.05) * 2684 : 35 + field.peakV / Math.max(aT, 0.05) * 85;
      label = "Your summit · " + fmt(Math.round(m / 10) * 10) + " m";
    } else label = q < 0.25 ? "Matterhorn · 4,478 m" : "Teufelsberg · 120 m";
    if (label !== lastLabel) { summitLabel.textContent = label; lastLabel = label; }
    summit.classList.toggle("is-on", !blank && (q < 0.2 || q > 0.62));
    summit.classList.toggle("is-left", dot.x > field.w - 190);
    if (credit) credit.style.opacity = (0.6 * (1 - sstep(0.1, 0.4, y))).toFixed(3);
  }

  function startStage() {
    if (!field) return;
    measure(); field.resize();
    live = true; stage.classList.add("is-live");
    W.requestAnimationFrame(frame);
  }
  if (field) {
    loadDEM(DEM.cervinia).then(function () {
      startStage();
      return loadDEM(DEM.teufelsberg);
    }).then(function () { field.mapLayers(); }).catch(function () { /* poster stays */ });

    if ("IntersectionObserver" in W) new IntersectionObserver(function (e) { inView = e[0].isIntersecting; }, { rootMargin: "100px" }).observe(stage);

    /* pointer: hover (mouse) or touch & hold raises a summit; never blocks scrolling */
    var pin = $(".stage__pin");
    function setP(e) { var r = canvas.getBoundingClientRect(); pointer.tx = e.clientX - r.left; pointer.ty = e.clientY - r.top; }
    pin.addEventListener("pointermove", function (e) { if (e.pointerType === "mouse") { setP(e); if (!pointer.on) { pointer.x = pointer.tx; pointer.y = pointer.ty; } pointer.on = true; } }, { passive: true });
    pin.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse") pointer.on = false; }, { passive: true });
    pin.addEventListener("touchstart", function (e) {
      if (e.target.closest("a,button")) return;
      var t = e.touches[0], r = canvas.getBoundingClientRect();
      pointer.tx = pointer.x = t.clientX - r.left; pointer.ty = pointer.y = t.clientY - r.top; pointer.on = true;
    }, { passive: true });
    pin.addEventListener("touchmove", function (e) { var t = e.touches[0], r = canvas.getBoundingClientRect(); pointer.tx = t.clientX - r.left; pointer.ty = t.clientY - r.top; }, { passive: true });
    pin.addEventListener("touchend", function () { pointer.on = false; }, { passive: true });
    pin.addEventListener("touchcancel", function () { pointer.on = false; }, { passive: true });
  }

  /* =========================================================
     header: tone + readout per section
     ========================================================= */
  var bar = $("#bar"), sections = $$("[data-tone][data-label]").filter(function (s) { return s !== bar; });
  var marks = [];
  function measureSections() {
    marks = sections.map(function (s) { var r = s.getBoundingClientRect(); return { el: s, top: r.top + W.scrollY, bottom: r.bottom + W.scrollY }; });
  }
  function updateBar() {
    var y = W.scrollY + 64, cur = null;
    for (var i = 0; i < marks.length; i++) if (y >= marks[i].top && y < marks[i].bottom) { cur = marks[i].el; }
    if (!cur) return;
    var tone = cur.getAttribute("data-tone");
    if (bar.getAttribute("data-tone") !== tone) bar.setAttribute("data-tone", tone);
    var inStage = cur === stage && W.scrollY < stageTop + stageH - vh * 1.05;
    bar.classList.toggle("is-solid", !inStage && W.scrollY > 10);
    if (!inStage) {
      var lab = cur.getAttribute("data-label"), parts = lab.split(" / ");
      barReadK.textContent = parts.length > 1 ? parts[0] : "";
      barRead.textContent = parts.length > 1 ? parts[1] : lab;
    } else { barReadK.textContent = "Alt"; if (!live) barRead.textContent = "2,050 m"; }
  }
  var ticking = false;
  W.addEventListener("scroll", function () {
    if (ticking) return; ticking = true;
    W.requestAnimationFrame(function () { ticking = false; updateBar(); });
  }, { passive: true });
  var rzT;
  function onResize() {
    clearTimeout(rzT);
    rzT = setTimeout(function () {
      var w0 = field && field.w;
      measure(); measureSections(); updateBar();
      if (field && live && (Math.abs(canvas.getBoundingClientRect().width - w0) > 1 || Math.abs(canvas.getBoundingClientRect().height - field.h) > 120)) field.resize();
      if (joinField) drawJoin();
    }, 120);
  }
  W.addEventListener("resize", onResize, { passive: true });
  W.addEventListener("load", function () { measure(); measureSections(); updateBar(); });
  measure(); measureSections(); updateBar();

  /* =========================================================
     mobile menu
     ========================================================= */
  var sheet = $("#sheet"), openB = $("#menu-open"), closeB = $("#menu-close");
  function openMenu() { sheet.hidden = false; void sheet.offsetWidth; sheet.classList.add("is-open"); openB.setAttribute("aria-expanded", "true"); root.style.overflow = "hidden"; closeB.focus(); }
  function closeMenu(noFocus) { sheet.classList.remove("is-open"); openB.setAttribute("aria-expanded", "false"); root.style.overflow = ""; setTimeout(function () { sheet.hidden = true; }, REDUCE ? 0 : 300); if (!noFocus) openB.focus(); }
  openB.addEventListener("click", openMenu);
  closeB.addEventListener("click", function () { closeMenu(); });
  $$("a", sheet).forEach(function (a) { a.addEventListener("click", function () { closeMenu(true); }); });
  D.addEventListener("keydown", function (e) { if (e.key === "Escape" && !sheet.hidden) closeMenu(); });

  /* =========================================================
     colourways + front/back + loupe
     ========================================================= */
  var CW = { cw01: "Keep Climbing", cw02: "Field Manual", cw03: "First Light" };
  var plates = $("#plates"), imgF = $("#img-front"), imgB = $("#img-back");
  function swap(img, cw, side) {
    var base = "assets/img/" + cw + "-" + side;
    var pre = new Image(); pre.decoding = "async";
    pre.srcset = base + "-560.webp 560w, " + base + "-1000.webp 1000w"; pre.sizes = img.sizes; pre.src = base + "-560.webp";
    img.classList.add("is-swap");
    var done = function () {
      img.srcset = pre.srcset; img.src = pre.src; img.alt = "CTR-LS01 " + CW[cw] + ", " + side;
      W.requestAnimationFrame(function () { img.classList.remove("is-swap"); });
    };
    (pre.decode ? pre.decode().catch(function () {}) : Promise.resolve()).then(function () { setTimeout(done, REDUCE ? 0 : 160); });
  }
  $$(".cw").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var cw = btn.getAttribute("data-cw");
      if (btn.classList.contains("is-on")) return;
      $$(".cw").forEach(function (b) { var on = b === btn; b.classList.toggle("is-on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); });
      $$(".cw__body").forEach(function (p) { p.hidden = p.getAttribute("data-for") !== cw; });
      swap(imgF, cw, "front"); swap(imgB, cw, "back");
      $$(".cap-cw").forEach(function (c) { c.textContent = cw.toUpperCase() + " · " + CW[cw]; });
    });
  });
  $$("[data-flip]").forEach(function (b) {
    b.addEventListener("click", function () {
      var f = b.getAttribute("data-flip") === "front";
      plates.classList.toggle("show-front", f);
      $$("[data-flip]").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    });
  });
  if (FINE) {
    $$("[data-loupe]").forEach(function (box) {
      var lp = D.createElement("div"); lp.className = "loupe"; lp.setAttribute("aria-hidden", "true"); box.appendChild(lp);
      var img = $("img", box), Z = 2.4;
      box.addEventListener("pointerenter", function () {
        var src = img.currentSrc || img.src; src = src.replace("-560.webp", "-1000.webp");
        lp.style.backgroundImage = "url(" + src + ")"; lp.classList.add("is-on");
      });
      box.addEventListener("pointerleave", function () { lp.classList.remove("is-on"); });
      box.addEventListener("pointermove", function (e) {
        var r = box.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        lp.style.left = (x - 100) + "px"; lp.style.top = (y - 100) + "px";
        lp.style.backgroundSize = (r.width * Z) + "px " + (r.height * Z) + "px";
        lp.style.backgroundPosition = (-(x * Z - 100)) + "px " + (-(y * Z - 100)) + "px";
      });
    });
  }

  /* =========================================================
     sticker board: mouse drags, touch = hold to peel
     ========================================================= */
  var board = $("#board");
  if (board) {
    var stks = $$("[data-stk]", board), zTop = 30;
    stks.forEach(function (s, i) { s.style.setProperty("--d", (i * 70) + "ms"); s.draggable = false; });
    var drag = null;
    function begin(s, cx, cy) {
      var br = board.getBoundingClientRect();
      drag = { s: s, ox: cx - (s.offsetLeft + br.left), oy: cy - (s.offsetTop + br.top) };
      s.classList.add("is-lift"); s.style.zIndex = ++zTop;
    }
    function move(cx, cy) {
      if (!drag) return;
      var br = board.getBoundingClientRect(), s = drag.s;
      var x = clamp(cx - br.left - drag.ox, -s.offsetWidth * 0.4, br.width - s.offsetWidth * 0.6);
      var y = clamp(cy - br.top - drag.oy, -s.offsetHeight * 0.4, br.height - s.offsetHeight * 0.6);
      s.style.left = (x / br.width * 100) + "%"; s.style.top = (y / br.height * 100) + "%";
    }
    function end() { if (!drag) return; drag.s.classList.remove("is-lift"); drag = null; }
    stks.forEach(function (s) {
      s.addEventListener("pointerdown", function (e) {
        if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
        e.preventDefault(); s.setPointerCapture(e.pointerId); begin(s, e.clientX, e.clientY);
      });
      s.addEventListener("pointermove", function (e) { if (e.pointerType === "mouse" || e.pointerType === "pen") move(e.clientX, e.clientY); });
      s.addEventListener("pointerup", end); s.addEventListener("lostpointercapture", end);
      /* touch: hold 220 ms without moving to pick it up */
      var timer = null, sx = 0, sy = 0;
      s.addEventListener("touchstart", function (e) {
        var t = e.touches[0]; sx = t.clientX; sy = t.clientY;
        timer = setTimeout(function () { timer = null; begin(s, sx, sy); }, 220);
      }, { passive: true });
      s.addEventListener("touchmove", function (e) {
        var t = e.touches[0];
        if (drag && drag.s === s) { e.preventDefault(); move(t.clientX, t.clientY); return; }
        if (timer && (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8)) { clearTimeout(timer); timer = null; }
      }, { passive: false });
      s.addEventListener("touchend", function () { if (timer) { clearTimeout(timer); timer = null; } end(); });
      s.addEventListener("touchcancel", function () { if (timer) { clearTimeout(timer); timer = null; } end(); });
      s.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    });
  }

  /* =========================================================
     reveals, board entrance, video
     ========================================================= */
  if ("IntersectionObserver" in W && !REDUCE) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    $$("[data-rv]").forEach(function (el) { io.observe(el); });
    if (board) io.observe(board);
  } else {
    $$("[data-rv]").forEach(function (el) { el.classList.add("is-in"); });
    if (board) board.classList.add("is-in");
  }

  var vid = $("#mezza-video");
  if (vid) {
    if (REDUCE) { vid.controls = true; }
    else if ("IntersectionObserver" in W) {
      new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (e.isIntersecting) { if (vid.preload === "none") { vid.preload = "auto"; } var p = vid.play(); if (p && p.catch) p.catch(function () { vid.controls = true; }); }
          else vid.pause();
        });
      }, { threshold: 0.35 }).observe(vid);
    }
  }

  /* sticker parallax in the race section */
  var mstk = $$(".mstk"), mez = $("#mezza");
  if (mstk.length && !REDUCE) {
    var mt = false;
    W.addEventListener("scroll", function () {
      if (mt) return; mt = true;
      W.requestAnimationFrame(function () {
        mt = false;
        var r = mez.getBoundingClientRect(); if (r.bottom < 0 || r.top > vh) return;
        var p = (r.top + r.height / 2 - vh / 2) / vh;
        mstk.forEach(function (s, i) { s.style.transform = "translate3d(0," + (p * (i % 2 ? -40 : 30)).toFixed(1) + "px,0) rotate(var(--r))"; });
      });
    }, { passive: true });
  }

  /* countdown to 20.12.2026 (calendar days, visitor's local date) */
  var cd = $("#countdown");
  if (cd) {
    var now = new Date(), a0 = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()), race = Date.UTC(2026, 11, 20);
    var days = Math.round((race - a0) / 864e5);
    if (days > 1) cd.textContent = "Mancano " + days + " giorni";
    else if (days === 1) cd.textContent = "Domani";
    else if (days === 0) cd.textContent = "Oggi";
  }

  /* =========================================================
     join: a quiet static contour field (Teufelsberg)
     ========================================================= */
  var joinCv = $("#join-canvas"), joinField = null;
  function drawJoin() {
    if (!joinField || !DEM.teufelsberg.data) return;
    joinField.resize();
    joinField.draw({ a: 0, b: 1, phase: 0.5, step: 1 / 22, bg: "rgb(30,70,54)", minor: "rgba(169,184,154,.16)", major: "rgba(169,184,154,.32)", minorW: 0.8, majorW: 1.2 });
  }
  if (joinCv && joinCv.getContext) {
    joinField = new Field(joinCv, { a: null, b: DEM.teufelsberg, fx: 0.8, fy: 0.5, fxM: 0.7, fyM: 0.28, spanA: 1, spanAM: 1, spanB: 90, spanBM: 70, cell: 8 });
    var jio = "IntersectionObserver" in W ? new IntersectionObserver(function (es) {
      if (es[0].isIntersecting) { jio.disconnect(); (DEM.teufelsberg.data ? Promise.resolve() : loadDEM(DEM.teufelsberg)).then(drawJoin).catch(function () {}); }
    }, { rootMargin: "300px" }) : null;
    if (jio) jio.observe(joinCv);
  }

  /* =========================================================
     early-access form (same endpoint + fields as the live site)
     ========================================================= */
  var form = $("#x-form"), input = $("#x-email"), err = $("#x-err"), join = $("#join");
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var v = input.value.trim();
    if (!v || !input.checkValidity()) { err.textContent = "Enter a valid email to log your position."; input.focus(); return; }
    err.textContent = "";
    var btn = form.querySelector("button"); btn.disabled = true;
    fetch("https://formsubmit.co/ajax/luizramba01@gmail.com", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ email: v, _subject: "CONTOUR early access signup", _template: "table" })
    }).then(function (r) { return r.json(); }).then(function () {
      join.classList.add("is-sent");
    }).catch(function () {
      btn.disabled = false; err.textContent = "Signal lost. Try again in a moment.";
    });
  });
})();

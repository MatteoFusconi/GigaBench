// Image compression results: a 3D scatter (ratio × quality × time) drawn in SVG.
// The 2D views are camera angles of the same scene, so switching view rotates it.
(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const singleColumn = window.matchMedia("(max-width: 980px)");   // matches the CSS breakpoint

  // Axis definitions. World axes: x = compression ratio, y = quality, z = time.
  const AXES = {
    cr:   { title: "Compression Ratio", short: "Size", log: true, min: 3, max: 5000, ticks: [10, 100, 1000], fmt: (v) => `${v}×` },
    psnr: { title: "PSNR (dB)", short: "PSNR (dB)", log: false, min: 0, max: 35, ticks: [0, 10, 20, 30], fmt: (v) => `${v}` },
    ssim: { title: "SSIM", short: "SSIM", log: false, min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], fmt: (v) => `${v}` },
    it:   { title: "Inference Time", short: "Inference", log: true, min: 0.4, max: 1200, ticks: [1, 10, 60, 600], fmt: (v) => (v < 60 ? `${v} s` : `${v / 60} min`) },
    ct:   { title: "Compression Time", short: "Compression", log: true, min: 0.8, max: 300, ticks: [1, 10, 60, 180], fmt: (v) => (v < 60 ? `${v} min` : `${v / 60} h`) },
  };

  // Minor gridlines on log axes: 2..9 × each decade, inside the range.
  function minorTicks(axis) {
    const a = AXES[axis];
    if (!a.log) return [];
    const out = [];
    for (let e = Math.floor(Math.log10(a.min)); e <= Math.ceil(Math.log10(a.max)); e++) {
      for (let k = 2; k <= 9; k++) {
        const v = k * 10 ** e;
        if (v > a.min && v < a.max && !a.ticks.includes(v)) out.push(v);
      }
    }
    return out;
  }
  const FIELD = { psnr: "psnr", ssim: "ssim", it: "it_s", ct: "ct_min" };
  const DESC = {
    psnr: "Pixel-level fidelity, in decibels.",
    ssim: "Structural similarity, from 0 to 1.",
    it: "Seconds to decode the full gigapixel image.",
    ct: "Minutes to fit the model to one image.",
  };
  const VIEWS = {
    "3d":   { yaw: -38, pitch: -22 },
    "q-cr": { yaw: 0, pitch: 0 },
    "q-t":  { yaw: 90, pitch: 0 },
    "t-cr": { yaw: 0, pitch: -90 },
  };
  const FAMILIES = ["Implicit", "Hybrid", "Explicit"];
  const SHAPES = { Implicit: "triangle", Hybrid: "circle", Explicit: "diamond" };
  const MARGIN = { top: 18, right: 26, bottom: 66, left: 84 };

  // Take-home messages from the paper. Each highlights some points and turns to the telling view.
  const TAKEAWAYS = [
    { figure: "33.6 dB", title: "Hybrids reconstruct best",
      text: "MetricGrids and I-NGP lead on quality, but only at ratios up to about 16×.",
      ids: ["MetricGrids (T=24)", "MetricGrids (T=22)", "I-NGP (T=24)", "I-NGP (T=22)", "NeuRBF (T=24)", "NeuRBF (T=22)"],
      view: "q-cr", quality: "psnr" },
    { figure: "1.7 min", title: "I-NGP fits a gigapixel fastest",
      text: "Custom CUDA kernels make it an order of magnitude faster to fit than the other hybrids.",
      ids: ["I-NGP (T=24)", "I-NGP (T=22)"], view: "t-cr", time: "ct" },
    { figure: "0.6 s", title: "Splatting decodes fastest",
      text: "SmartSplat rebuilds the full image in 0.6 to 3.4 s and stays above 24 dB even at 3000×.",
      ids: ["SmartSplat (CR=15)", "SmartSplat (CR=100)", "SmartSplat (CR=3000)"], view: "q-t", quality: "psnr", time: "it" },
    { figure: "2600×", title: "Implicit compresses most, slowly",
      text: "The smallest files, but at 18 to 20 dB, and the large variants need up to 3.4 hours to fit.",
      ids: ["SIREN (5,256)", "FINER (5,256)", "FDHO (5,256)", "SIREN (8,1024)", "FINER (8,1024)", "FDHO (8,1024)"],
      view: "3d", time: "ct" },
  ];

  const $ = (id) => document.getElementById(id);
  const svg = $("chart-svg");
  const chartEl = $("chart");
  const tip = $("chart-tip");

  const state = {
    quality: "psnr", time: "it", view: "3d",
    cam: { ...VIEWS["3d"] },
    highlight: null,   // Set of point ids, or null
  };
  let rows = [];
  let points = [];     // { row, id, coords: [x,y,z] current, target: [x,y,z], g }
  let layers = {};
  let size = { w: 720, h: 520 };

  // Geometry ------------------------------------------------------------------

  function norm(axis, v) {
    const a = AXES[axis];
    const t = a.log
      ? (Math.log10(v) - Math.log10(a.min)) / (Math.log10(a.max) - Math.log10(a.min))
      : (v - a.min) / (a.max - a.min);
    return t * 2 - 1;
  }

  function targetCoords(row) {
    return [norm("cr", row.cr), norm(state.quality, row[FIELD[state.quality]]), norm(state.time, row[FIELD[state.time]])];
  }

  // Orthographic camera: yaw around the vertical axis, then pitch around the horizontal one.
  function rotate([x, y, z], cam) {
    const a = (cam.yaw * Math.PI) / 180;
    const b = (cam.pitch * Math.PI) / 180;
    const x1 = x * Math.cos(a) + z * Math.sin(a);
    const z1 = -x * Math.sin(a) + z * Math.cos(a);
    const y2 = y * Math.cos(b) - z1 * Math.sin(b);
    const z2 = y * Math.sin(b) + z1 * Math.cos(b);
    return { x: x1, y: y2, d: z2 };
  }

  const CORNERS = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) CORNERS.push([x, y, z]);

  // Fit the rotated unit cube into the plot area (separately per screen axis).
  function makeProjector(cam) {
    const r = CORNERS.map((c) => rotate(c, cam));
    const minX = Math.min(...r.map((p) => p.x)), maxX = Math.max(...r.map((p) => p.x));
    const minY = Math.min(...r.map((p) => p.y)), maxY = Math.max(...r.map((p) => p.y));
    const plotW = size.w - MARGIN.left - MARGIN.right;
    const plotH = size.h - MARGIN.top - MARGIN.bottom;
    const kx = plotW / Math.max(maxX - minX, 1e-6);
    const ky = plotH / Math.max(maxY - minY, 1e-6);
    return (p) => {
      const q = rotate(p, cam);
      return { x: MARGIN.left + (q.x - minX) * kx, y: MARGIN.top + (maxY - q.y) * ky, d: q.d };
    };
  }

  // Shapes are centred on (0, 0), about 12px across.
  function shapePath(shape) {
    if (shape === "triangle") return "M0,-7L6.3,4.5L-6.3,4.5z";
    if (shape === "diamond") return "M0,-6.8L6.8,0L0,6.8L-6.8,0z";
    return "M-5.8,0a5.8,5.8 0 1,0 11.6,0a5.8,5.8 0 1,0 -11.6,0";
  }

  // Building the scene -----------------------------------------------------------

  function el(tag, attrs = {}, parent) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  function label(row) {
    return `${row.method} (${row.config})`;
  }

  function build() {
    svg.replaceChildren();
    layers = {
      minor: el("g", { class: "grid" }, svg),
      grid: el("g", { class: "grid" }, svg),
      edges: el("g", { class: "edges" }, svg),
      axes: el("g", { class: "axes" }, svg),
      points: el("g", { class: "points" }, svg),
    };

    points = rows.map((row) => {
      const id = label(row);
      const g = el("g", { class: `pt fam-${row.family.toLowerCase()}`, tabindex: "0", role: "img" }, layers.points);
      g.setAttribute("aria-label", `${id}: PSNR ${row.psnr} dB, SSIM ${row.ssim}, compression ratio ${Math.round(row.cr)}, inference ${row.it_s} s, compression ${row.ct_min} min`);
      el("circle", { class: "hit", r: 13 }, g);
      el("path", { class: "mark", d: shapePath(SHAPES[row.family]) }, g);
      const text = el("text", { class: "pt-label", x: 11, y: 4 }, g);
      text.textContent = id;
      const p = { row, id, g, text, coords: targetCoords(row), target: targetCoords(row) };
      g.addEventListener("pointerenter", () => showTip(p));
      g.addEventListener("pointerleave", hideTip);
      g.addEventListener("focus", () => showTip(p));
      g.addEventListener("blur", hideTip);
      return p;
    });
  }

  // Drawing ------------------------------------------------------------------------

  function draw() {
    const P = makeProjector(state.cam);
    drawFrame(P);
    for (const p of points) {
      const s = P(p.coords);
      p.screen = s;
      p.g.setAttribute("transform", `translate(${s.x.toFixed(1)},${s.y.toFixed(1)})`);
    }
    placeLabels();
  }

  // Labels of highlighted points: right of the point (left near the right edge),
  // pushed apart vertically when two would overlap.
  function placeLabels() {
    const placed = [];
    const shown = points.filter((p) => state.highlight && state.highlight.has(p.id)).sort((a, b) => a.screen.y - b.screen.y);
    for (const p of shown) {
      const left = p.screen.x > size.w - 170;
      let y = p.screen.y + 4;
      for (const q of placed) {
        if (q.left === left && Math.abs(q.x - p.screen.x) < 150 && y - q.y < 14) y = q.y + 14;
      }
      placed.push({ left, x: p.screen.x, y });
      p.text.setAttribute("x", left ? -11 : 11);
      p.text.setAttribute("y", (y - p.screen.y).toFixed(1));
      p.text.setAttribute("text-anchor", left ? "end" : "start");
    }
  }

  // Grid on the three far planes, box edges, and ticks on the outer edges.
  function drawFrame(P) {
    const axisKeys = ["cr", state.quality, state.time];
    const grid = [], minor = [], edges = [];

    // Far plane for each axis: the side (±1) whose centre is deeper.
    const far = [0, 1, 2].map((i) => {
      const a = [0, 0, 0], b = [0, 0, 0];
      a[i] = -1; b[i] = 1;
      return P(a).d > P(b).d ? -1 : 1;
    });
    for (let plane = 0; plane < 3; plane++) {
      for (let q = 0; q < 3; q++) {
        if (q === plane) continue;
        const r = 3 - plane - q;
        for (const [ticks, out] of [[AXES[axisKeys[q]].ticks, grid], [minorTicks(axisKeys[q]), minor]]) {
          for (const t of ticks) {
            const a = [0, 0, 0], b = [0, 0, 0];
            a[plane] = b[plane] = far[plane];
            a[q] = b[q] = norm(axisKeys[q], t);
            a[r] = -1; b[r] = 1;
            out.push([P(a), P(b)]);
          }
        }
      }
    }
    for (const c of CORNERS) {
      for (let i = 0; i < 3; i++) {
        if (c[i] !== -1) continue;
        const d = [...c]; d[i] = 1;
        edges.push([P(c), P(d)]);
      }
    }
    const seg = ([a, b]) => `M${a.x.toFixed(1)},${a.y.toFixed(1)}L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    setPath(layers.minor, "grid-minor", minor.map(seg).join(""));
    setPath(layers.grid, "grid-lines", grid.map(seg).join(""));
    setPath(layers.edges, "edge-lines", edges.map(seg).join(""));
    drawAxes(P, axisKeys);
  }

  function setPath(layer, cls, d) {
    let path = layer.querySelector("path");
    if (!path) path = el("path", { class: cls }, layer);
    path.setAttribute("d", d);
  }

  function drawAxes(P, axisKeys) {
    layers.axes.replaceChildren();
    for (let i = 0; i < 3; i++) {
      // The four edges parallel to axis i; label the outermost one.
      const candidates = [];
      for (const u of [-1, 1]) for (const v of [-1, 1]) {
        const a = [0, 0, 0], b = [0, 0, 0];
        const [j, k] = [0, 1, 2].filter((n) => n !== i);
        a[j] = b[j] = u; a[k] = b[k] = v;
        a[i] = -1; b[i] = 1;
        candidates.push({ a, b, pa: P(a), pb: P(b) });
      }
      const { pa, pb } = candidates[0];
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const len = Math.hypot(dx, dy);
      const opacity = Math.max(0, Math.min(1, (len - 30) / 80));
      if (opacity === 0) continue;
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      const pick = horizontal
        ? candidates.reduce((m, c) => ((c.pa.y + c.pb.y) > (m.pa.y + m.pb.y) ? c : m))
        : candidates.reduce((m, c) => ((c.pa.x + c.pb.x) < (m.pa.x + m.pb.x) ? c : m));

      // Labels go outward from the box, perpendicular to the edge.
      const axis = AXES[axisKeys[i]];
      const m = P(pick.a.map((v, n) => (n === i ? 0 : v)));
      const c = P([0, 0, 0]);
      let nx = -(pick.pb.y - pick.pa.y), ny = pick.pb.x - pick.pa.x;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      if (nx * (m.x - c.x) + ny * (m.y - c.y) < 0) { nx = -nx; ny = -ny; }
      const anchor = nx < -0.5 ? "end" : nx > 0.5 ? "start" : "middle";

      const g = el("g", { class: "axis", opacity: opacity.toFixed(2) }, layers.axes);
      for (const t of axis.ticks) {
        const p = [...pick.a];
        p[i] = norm(axisKeys[i], t);
        const s = P(p);
        const txt = el("text", { x: s.x + nx * 12, y: s.y + ny * 14 + 4, "text-anchor": anchor }, g);
        txt.textContent = axis.fmt(t);
      }
      const title = horizontal
        ? el("text", { x: m.x + nx * 40, y: m.y + ny * 40 + 4, "text-anchor": anchor, class: "axis-title" }, g)
        : el("text", { x: m.x + nx * 62, y: m.y, "text-anchor": "middle", class: "axis-title", transform: `rotate(-90 ${m.x + nx * 62} ${m.y})` }, g);
      title.textContent = size.w < 520 ? axis.short : axis.title;
    }
  }

  // Depth order: far points first. Skipped while a point has focus, so focus is never lost.
  function sortByDepth() {
    if (layers.points.contains(document.activeElement)) return;
    [...points].sort((a, b) => b.screen.d - a.screen.d).forEach((p) => layers.points.appendChild(p.g));
  }

  // Animation ------------------------------------------------------------------------

  let anim = null;
  function animateTo(cam) {
    const from = { cam: { ...state.cam }, coords: points.map((p) => [...p.coords]) };
    for (const p of points) p.target = targetCoords(p.row);
    if (reducedMotion) {
      state.cam = { ...cam };
      points.forEach((p) => { p.coords = [...p.target]; });
      draw(); sortByDepth();
      return;
    }
    cancelAnimationFrame(anim);
    const t0 = performance.now(), dur = 750;
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => {
      const t = ease(Math.min(1, (now - t0) / dur));
      state.cam.yaw = from.cam.yaw + (cam.yaw - from.cam.yaw) * t;
      state.cam.pitch = from.cam.pitch + (cam.pitch - from.cam.pitch) * t;
      points.forEach((p, i) => { p.coords = from.coords[i].map((v, k) => v + (p.target[k] - v) * t); });
      draw();
      if (t < 1) anim = requestAnimationFrame(step);
      else sortByDepth();
    };
    anim = requestAnimationFrame(step);
  }

  // Controls ------------------------------------------------------------------------

  function setPressed(selector, attr, value) {
    document.querySelectorAll(selector).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === value)));
  }

  function update({ view, quality, time } = {}) {
    if (view) state.view = view;
    if (quality) state.quality = quality;
    if (time) state.time = time;
    setPressed("[data-view]", "view", state.view);
    setPressed("[data-quality]", "quality", state.quality);
    setPressed("[data-time]", "time", state.time);
    $("quality-desc").textContent = DESC[state.quality];
    $("time-desc").textContent = DESC[state.time];
    animateTo(state.view === "custom" ? state.cam : VIEWS[state.view]);
  }

  function setHighlight(ids) {
    state.highlight = ids ? new Set(ids) : null;
    svg.classList.toggle("has-highlight", !!ids);
    points.forEach((p) => p.g.classList.toggle("on", !!ids && state.highlight.has(p.id)));
    placeLabels();
  }

  // Select a family, a method or a take-home message; selecting it again clears it.
  function select(button, ids, settings) {
    const wasActive = button.getAttribute("aria-pressed") === "true";
    document.querySelectorAll("#legend button, #takeaways button").forEach((b) => b.setAttribute("aria-pressed", "false"));
    if (wasActive) { setHighlight(null); return; }
    button.setAttribute("aria-pressed", "true");
    setHighlight(ids);
    if (settings) update(settings);
  }

  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => update({ view: b.dataset.view })));
  document.querySelectorAll("[data-quality]").forEach((b) => b.addEventListener("click", () => update({ quality: b.dataset.quality })));
  document.querySelectorAll("[data-time]").forEach((b) => b.addEventListener("click", () => update({ time: b.dataset.time })));

  // Drag to rotate (mouse: both directions; touch: horizontal only, so the page still scrolls).
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".pt")) return;
    drag = { x: e.clientX, y: e.clientY, yaw: state.cam.yaw, pitch: state.cam.pitch, touch: e.pointerType !== "mouse" };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add("dragging");
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    cancelAnimationFrame(anim);
    state.cam.yaw = drag.yaw + (e.clientX - drag.x) * 0.4;
    if (!drag.touch) state.cam.pitch = Math.max(-90, Math.min(0, drag.pitch + (e.clientY - drag.y) * 0.4));
    if (state.view !== "custom") { state.view = "custom"; setPressed("[data-view]", "view", "custom"); }
    draw();
  });
  const endDrag = () => { if (drag) { drag = null; svg.classList.remove("dragging"); sortByDepth(); } };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  // Tooltip ---------------------------------------------------------------------------

  const fmt = (v, d) => v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

  function showTip(p) {
    const r = p.row;
    const lines = [
      [`${fmt(r.psnr, 2)} dB`, "PSNR"],
      [fmt(r.ssim, 3), "SSIM"],
      [`${fmt(r.cr, r.cr < 100 ? 1 : 0)}×`, "Compression Ratio"],
      [`${fmt(r.it_s, 2)} s`, "Inference Time"],
      [`${fmt(r.ct_min, 1)} min`, "Compression Time"],
    ];
    tip.replaceChildren();
    const head = document.createElement("p");
    head.className = "tip-head";
    const key = document.createElement("span");
    key.className = `tip-key fam-${r.family.toLowerCase()}`;
    head.append(key, document.createTextNode(p.id));
    tip.append(head);
    for (const [value, name] of lines) {
      const row = document.createElement("p");
      const strong = document.createElement("strong");
      strong.textContent = value;
      row.append(strong, document.createTextNode(` ${name}`));
      tip.append(row);
    }
    tip.hidden = false;
    const s = p.screen;
    const left = Math.min(Math.max(s.x + 14, 8), size.w - tip.offsetWidth - 8);
    const top = s.y - tip.offsetHeight - 12 < 0 ? s.y + 16 : s.y - tip.offsetHeight - 12;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  function hideTip() { tip.hidden = true; }

  // Legend, table, take-home messages -----------------------------------------------------

  function legendButton(cls, content, ids) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = cls;
    btn.setAttribute("aria-pressed", "false");
    btn.append(...content);
    btn.addEventListener("click", () => select(btn, ids));
    return btn;
  }

  function renderLegend() {
    const legend = $("legend");
    legend.replaceChildren();
    for (const fam of FAMILIES) {
      const col = document.createElement("div");
      col.className = "legend-col";
      const icon = el("svg", { viewBox: "-8 -8 16 16", class: `legend-icon fam-${fam.toLowerCase()}`, "aria-hidden": "true" });
      el("path", { d: shapePath(SHAPES[fam]) }, icon);
      const famIds = points.filter((p) => p.row.family === fam).map((p) => p.id);
      col.append(legendButton("legend-family", [icon, document.createTextNode(`${fam} methods`)], famIds));
      const methods = document.createElement("div");
      methods.className = "legend-methods";
      for (const m of [...new Set(rows.filter((r) => r.family === fam).map((r) => r.method))]) {
        const ids = points.filter((p) => p.row.method === m).map((p) => p.id);
        methods.append(legendButton("legend-method", [document.createTextNode(m)], ids));
      }
      col.append(methods);
      legend.append(col);
    }
  }

  function renderTable() {
    const table = $("numbers-table");
    table.replaceChildren();
    const head = table.createTHead().insertRow();
    for (const h of ["Family", "Method", "PSNR (dB)", "SSIM", "Compression Ratio", "Inference Time (s)", "Compression Time (min)"]) {
      const th = document.createElement("th");
      th.textContent = h;
      head.append(th);
    }
    const body = table.createTBody();
    for (const r of rows) {
      const tr = body.insertRow();
      for (const v of [r.family, label(r), fmt(r.psnr, 2), fmt(r.ssim, 3), `${fmt(r.cr, r.cr < 100 ? 1 : 0)}×`, fmt(r.it_s, 2), fmt(r.ct_min, 1)]) {
        tr.insertCell().textContent = v;
      }
    }
  }

  function renderTakeaways() {
    const list = $("takeaways");
    list.replaceChildren();
    TAKEAWAYS.forEach((tk) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("aria-pressed", "false");
      const fig = document.createElement("span");
      fig.className = "tk-figure";
      fig.textContent = tk.figure;
      const title = document.createElement("span");
      title.className = "tk-title";
      title.textContent = tk.title;
      const text = document.createElement("span");
      text.className = "tk-text";
      text.textContent = tk.text;
      btn.append(fig, title, text);
      btn.addEventListener("click", () => {
        select(btn, tk.ids, { view: tk.view, quality: tk.quality, time: tk.time });
        // Single-column layout: the plot is above the messages, so bring it into view.
        if (btn.getAttribute("aria-pressed") === "true" && singleColumn.matches) {
          const r = chartEl.getBoundingClientRect();
          if (r.top < 0 || r.bottom > window.innerHeight) {
            document.querySelector(".view-switch").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
          }
        }
      });
      li.append(btn);
      list.append(li);
    });
  }

  // Start -------------------------------------------------------------------------------

  function resize() {
    const w = chartEl.clientWidth;
    size = { w, h: Math.round(Math.min(560, Math.max(380, w * 0.72))) };
    svg.setAttribute("width", size.w);
    svg.setAttribute("height", size.h);
    svg.setAttribute("viewBox", `0 0 ${size.w} ${size.h}`);
    if (points.length) { draw(); sortByDepth(); }
  }

  fetch("assets/compression.json")
    .then((r) => r.json())
    .then((data) => {
      rows = data;
      build();
      renderLegend();
      renderTable();
      renderTakeaways();
      new ResizeObserver(resize).observe(chartEl);
      resize();
      update();
    })
    .catch((err) => {
      chartEl.textContent = "The results couldn't be loaded. Reload the page to try again.";
      console.error(err);
    });
})();

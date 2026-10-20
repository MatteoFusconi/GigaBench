// Super-resolution results: bars per configuration (PSNR, SSIM, LPIPS), as in the paper,
// and box plots of the human-evaluation Elo per image when Elo is selected.
(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const singleColumn = window.matchMedia("(max-width: 980px)");   // matches the CSS breakpoint

  const FAMILIES = ["Implicit", "Hybrid", "Explicit", "Classic"];
  // Bar order of the paper's figure
  const ORDER = [
    "SIREN (5,256)", "SIREN (8,1024)", "FDHO (5,256)", "FDHO (8,1024)", "FINER (5,256)", "FINER (8,1024)",
    "MetricGrids (T=24)", "MetricGrids (T=22)", "NeuRBF (T=24)", "NeuRBF (T=22)", "I-NGP (T=24)", "I-NGP (T=22)",
    "SmartSplat (CR=15)", "SmartSplat (CR=100)", "SmartSplat (CR=3000)",
    "GaussianImage (CR=15)", "GaussianImage (CR=100)", "GaussianImage (CR=3000)",
    "Bicubic", "Lanczos", "Nearest Neighbour",
  ];
  const METRICS = {
    psnr:  { title: "PSNR (dB)", digits: 2, desc: "Pixel-level fidelity to the original, in decibels." },
    ssim:  { title: "SSIM", digits: 3, desc: "Structural similarity to the original, from 0 to 1." },
    lpips: { title: "LPIPS", digits: 3, desc: "Learned perceptual distance to the original." },
    elo:   { title: "Elo (bootstrap)", digits: 0, desc: "Human preference: 170 people ranked the families on 2048² crops, without knowing which was which." },
  };
  const SCALE_DESC = {
    x4: "Fitted on a quarter of the resolution per side, rendered at full size.",
    x8: "Fitted on an eighth of the resolution per side, rendered at full size.",
  };
  const HINT = {
    bars: "Hover a bar for its numbers, or pick a family or method below to highlight it.",
    elo: "Bootstrapped Elo. Each family is represented by its best method; Andromeda was left out of the study. Boxes span the middle 50% of the resamples.",
  };
  const PANELS = ["Overall", "Venice", "Statuario", "Calacatta Viola", "Breast Cancer", "Kidney", "Munich", "Italy", "Lynxsdesign", "House of Chores"];

  // Take-home messages from the paper. Each selects families and/or configurations and sets the view.
  const TAKEAWAYS = [
    { figure: "+1.1 dB", title: "Only hybrids beat bicubic",
      text: "I-NGP reaches 27.1 dB at ×4, 1.1 dB above bicubic. The lead narrows to 0.7 dB at ×8.",
      sel: { ids: ["I-NGP (T=24)", "MetricGrids (T=24)", "Bicubic"] }, metric: "psnr", scale: "x4" },
    { figure: "26.0 dB", title: "Bicubic beats every implicit method",
      text: "Even the large implicit models stay 3 to 7 dB below bicubic interpolation at ×4.",
      sel: { families: ["Implicit"], ids: ["Bicubic"] }, metric: "psnr", scale: "x4" },
    { figure: "1228", title: "People prefer classic at ×4",
      text: "In the human study classic interpolation leads at ×4. At ×8 hybrids catch up and the two are level.",
      sel: { families: ["Classic", "Hybrid"] }, metric: "elo", scale: "x4" },
    { figure: "9.2 dB", title: "Splatting is unstable",
      text: "GaussianImage at 15× collapses at ×8, while SmartSplat at 3000× still holds 22.8 dB.",
      sel: { ids: ["GaussianImage (CR=15)", "SmartSplat (CR=3000)"] }, metric: "psnr", scale: "x8" },
  ];

  const $ = (id) => document.getElementById(id);
  const svg = $("sr-chart-svg");
  const chartEl = $("sr-chart");
  const tip = $("sr-tip");

  const state = { metric: "psnr", scale: "x4", sel: null };
  let data = null;
  let size = { w: 720, h: 460 };
  let shown = {};      // id -> currently drawn value (animated)

  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const fmt = (v, d) => v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
  const label = (r) => (r.config ? `${r.method} (${r.config})` : r.method);
  const famClass = (f) => `fam-${f.toLowerCase()}`;

  function rowsFor(scale) {
    const rows = data.bars.filter((r) => r.scale === scale);
    return ORDER.map((id) => rows.find((r) => label(r) === id));
  }

  // Selection: a set of families and/or configuration ids
  function isOn(row) {
    const s = state.sel;
    return !!s && ((s.families || []).includes(row.family) || (s.ids || []).includes(label(row)));
  }
  function familyOn(fam) {
    const s = state.sel;
    if (!s) return false;
    return (s.families || []).includes(fam) || (s.ids || []).some((id) => data.bars.find((r) => label(r) === id)?.family === fam);
  }

  // Value axis: a range around the data with round ticks (the paper's bars do not start at zero)
  function niceStep(span) {
    const raw = span / 6;
    const p = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  }
  function valueScale(values) {
    const lo = Math.min(...values), hi = Math.max(...values);
    const step = niceStep(hi - lo);
    const min = Math.max(0, Math.floor((lo - step / 2) / step) * step);
    const max = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let t = min; t <= max + step / 1e3; t += step) ticks.push(+t.toFixed(6));
    return { min, max, ticks, step };
  }

  // Bars ----------------------------------------------------------------------------

  function drawBars(values) {
    const rows = rowsFor(state.scale);
    const vs = valueScale(rows.map((r) => r[state.metric]));
    const horizontal = size.w < 600;
    const groups = FAMILIES.map((f) => rows.filter((r) => r.family === f).length);
    const slots = rows.length + FAMILIES.length - 1;     // one empty slot between families
    svg.replaceChildren();

    const m = horizontal ? { top: 8, right: 52, bottom: 40, left: 158 } : { top: 14, right: 12, bottom: 128, left: 60 };
    const plotW = size.w - m.left - m.right;
    const plotH = size.h - m.top - m.bottom;
    const along = horizontal ? plotH : plotW;
    const slot = along / slots;
    const thick = Math.min(26, slot * 0.78);
    const across = horizontal ? plotW : plotH;
    const pos = (v) => ((v - vs.min) / (vs.max - vs.min)) * across;

    // Grid and value ticks
    const grid = el("g", { class: "axis" }, svg);
    for (const t of vs.ticks) {
      const p = pos(t);
      if (horizontal) {
        el("line", { class: "bar-grid", x1: m.left + p, x2: m.left + p, y1: m.top, y2: m.top + plotH }, grid);
        el("text", { x: m.left + p, y: m.top + plotH + 16, "text-anchor": "middle" }, grid).textContent = fmt(t, vs.step < 1 ? (vs.step < 0.1 ? 2 : 1) : 0);
      } else {
        el("line", { class: "bar-grid", x1: m.left, x2: m.left + plotW, y1: m.top + plotH - p, y2: m.top + plotH - p }, grid);
        el("text", { x: m.left - 8, y: m.top + plotH - p + 4, "text-anchor": "end" }, grid).textContent = fmt(t, vs.step < 1 ? (vs.step < 0.1 ? 2 : 1) : 0);
      }
    }
    const title = horizontal
      ? el("text", { class: "axis-title", x: m.left + plotW / 2, y: size.h - 6, "text-anchor": "middle" }, grid)
      : el("text", { class: "axis-title", x: 16, y: m.top + plotH / 2, "text-anchor": "middle", transform: `rotate(-90 16 ${m.top + plotH / 2})` }, grid);
    title.textContent = METRICS[state.metric].title;

    // Bars, grouped by family
    const barsG = el("g", {}, svg);
    let i = 0;
    FAMILIES.forEach((fam, g) => {
      for (let k = 0; k < groups[g]; k++, i++) {
        const r = rows[i];
        const id = label(r);
        const center = (i + g + 0.5) * slot;
        const len = Math.max(0, pos(values[id]));
        const bar = el("g", { class: `bar ${famClass(fam)}${isOn(r) ? " on" : ""}`, tabindex: "0", role: "img" }, barsG);
        bar.setAttribute("aria-label", `${id}: ${METRICS[state.metric].title} ${fmt(r[state.metric], METRICS[state.metric].digits)}`);
        const rect = horizontal
          ? { x: m.left, y: m.top + center - thick / 2, width: len, height: thick }
          : { x: m.left + center - thick / 2, y: m.top + plotH - len, width: thick, height: len };
        el("rect", { class: "bar-hit", x: rect.x - 2, y: horizontal ? rect.y - 2 : m.top, width: horizontal ? plotW : thick + 4, height: horizontal ? thick + 4 : plotH }, bar);
        el("rect", { class: "bar-fill", ...rect }, bar);
        // Category label under (or beside) the bar
        const lab = horizontal
          ? el("text", { class: "bar-label", x: m.left - 8, y: m.top + center + 4, "text-anchor": "end" }, bar)
          : el("text", { class: "bar-label", x: m.left + center, y: m.top + plotH + 14, "text-anchor": "end", transform: `rotate(-35 ${m.left + center} ${m.top + plotH + 14})` }, bar);
        lab.textContent = id;
        // Value label, shown on highlighted bars only
        const val = horizontal
          ? el("text", { class: "bar-value", x: m.left + len + 6, y: m.top + center + 4 }, bar)
          : el("text", { class: "bar-value", x: m.left + center, y: m.top + plotH - len - 6, "text-anchor": "middle" }, bar);
        val.textContent = fmt(r[state.metric], METRICS[state.metric].digits);
        bar.addEventListener("pointerenter", () => showBarTip(r, rect));
        bar.addEventListener("pointerleave", hideTip);
        bar.addEventListener("focus", () => showBarTip(r, rect));
        bar.addEventListener("blur", hideTip);
      }
    });
    el("line", { class: "bar-base", ...(horizontal
      ? { x1: m.left, x2: m.left, y1: m.top, y2: m.top + plotH }
      : { x1: m.left, x2: m.left + plotW, y1: m.top + plotH, y2: m.top + plotH }) }, svg);
  }

  function showBarTip(r, rect) {
    const lines = [[fmt(r.psnr, 2) + " dB", "PSNR"], [fmt(r.ssim, 3), "SSIM"], [fmt(r.lpips, 3), "LPIPS"]];
    placeTip(r.family, label(r), `${state.scale === "x4" ? "×4" : "×8"} upsampling`, lines, rect.x + rect.width / 2, rect.y);
  }

  // Box plots (Elo) -----------------------------------------------------------------------

  function drawBoxes() {
    const elo = data.elo[state.scale];
    const all = PANELS.flatMap((p) => FAMILIES.map((f) => elo[p][f]));
    const vs = valueScale([...all.map((b) => b.lo), ...all.map((b) => b.hi)]);
    const cols = size.w < 600 ? 2 : 5;
    const rowsN = Math.ceil(PANELS.length / cols);
    const m = { top: 8, right: 8, bottom: 8, left: 66 };
    const gapX = 14, gapY = 30, titleH = 22;
    const panelW = (size.w - m.left - m.right - gapX * (cols - 1)) / cols;
    const panelH = (size.h - m.top - m.bottom - gapY * (rowsN - 1)) / rowsN - titleH;
    svg.replaceChildren();

    PANELS.forEach((panel, n) => {
      const c = n % cols, rr = Math.floor(n / cols);
      const x0 = m.left + c * (panelW + gapX);
      const y0 = m.top + rr * (panelH + titleH + gapY) + titleH;
      const y = (v) => y0 + panelH - ((v - vs.min) / (vs.max - vs.min)) * panelH;
      const g = el("g", { class: `elo-panel${panel === "Overall" ? " overall" : ""}` }, svg);
      el("text", { class: "panel-title", x: x0 + panelW / 2, y: y0 - 8, "text-anchor": "middle" }, g).textContent = panel;
      const axis = el("g", { class: "axis" }, g);
      for (const t of vs.ticks) {
        el("line", { class: "bar-grid", x1: x0, x2: x0 + panelW, y1: y(t), y2: y(t) }, axis);
        if (c === 0) el("text", { x: x0 - 6, y: y(t) + 4, "text-anchor": "end" }, axis).textContent = fmt(t, 0);
      }
      const bw = panelW / FAMILIES.length;
      FAMILIES.forEach((fam, k) => {
        const b = elo[panel][fam];
        const cx = x0 + (k + 0.5) * bw, half = Math.min(14, bw * 0.32);
        const box = el("g", { class: `box ${famClass(fam)}${familyOn(fam) ? " on" : ""}`, tabindex: "0", role: "img" }, g);
        box.setAttribute("aria-label", `${panel}, ${fam}: median Elo ${fmt(b.median, 0)}, middle half ${fmt(b.q1, 0)} to ${fmt(b.q3, 0)}`);
        el("rect", { class: "bar-hit", x: cx - bw / 2, y: y0, width: bw, height: panelH }, box);
        el("line", { class: "whisker", x1: cx, x2: cx, y1: y(b.hi), y2: y(b.q3) }, box);
        el("line", { class: "whisker", x1: cx, x2: cx, y1: y(b.q1), y2: y(b.lo) }, box);
        el("line", { class: "whisker", x1: cx - half / 2, x2: cx + half / 2, y1: y(b.hi), y2: y(b.hi) }, box);
        el("line", { class: "whisker", x1: cx - half / 2, x2: cx + half / 2, y1: y(b.lo), y2: y(b.lo) }, box);
        el("rect", { class: "box-fill", x: cx - half, y: y(b.q3), width: half * 2, height: Math.max(1.5, y(b.q1) - y(b.q3)) }, box);
        el("line", { class: "median", x1: cx - half, x2: cx + half, y1: y(b.median), y2: y(b.median) }, box);
        const tipRect = { x: cx, y: y(b.hi) };
        box.addEventListener("pointerenter", () => showBoxTip(panel, fam, b, tipRect));
        box.addEventListener("pointerleave", hideTip);
        box.addEventListener("focus", () => showBoxTip(panel, fam, b, tipRect));
        box.addEventListener("blur", hideTip);
      });
    });
    const ty = m.top + (size.h - m.top - m.bottom) / 2;
    el("text", { class: "axis-title", x: 12, y: ty, "text-anchor": "middle", transform: `rotate(-90 12 ${ty})` }, svg).textContent = METRICS.elo.title;
  }

  function showBoxTip(panel, fam, b, at) {
    const lines = [[fmt(b.median, 0), "median Elo"], [`${fmt(b.q1, 0)}–${fmt(b.q3, 0)}`, "middle 50%"], [`${fmt(b.mean, 0)} ± ${fmt(b.std, 0)}`, "mean ± std"]];
    placeTip(fam, `${fam} methods`, `${panel}, ${state.scale === "x4" ? "×4" : "×8"}`, lines, at.x, at.y);
  }

  // Tooltip ---------------------------------------------------------------------------------

  function placeTip(fam, head, sub, lines, x, y) {
    tip.replaceChildren();
    const h = document.createElement("p");
    h.className = "tip-head";
    const key = document.createElement("span");
    key.className = `tip-key ${famClass(fam)}`;
    h.append(key, document.createTextNode(head));
    const s = document.createElement("p");
    s.className = "tip-sub";
    s.textContent = sub;
    tip.append(h, s);
    for (const [value, name] of lines) {
      const p = document.createElement("p");
      const strong = document.createElement("strong");
      strong.textContent = value;
      p.append(strong, document.createTextNode(` ${name}`));
      tip.append(p);
    }
    tip.hidden = false;
    const left = Math.min(Math.max(x + 12, 8), size.w - tip.offsetWidth - 8);
    const top = y - tip.offsetHeight - 10 < 0 ? y + 14 : y - tip.offsetHeight - 10;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  // Rendering and controls ----------------------------------------------------------------------

  let anim = null;
  function render(animate = true) {
    const elo = state.metric === "elo";
    svg.classList.toggle("has-highlight", !!state.sel);
    $("sr-hint").textContent = elo ? HINT.elo : HINT.bars;
    if (elo) { cancelAnimationFrame(anim); drawBoxes(); return; }

    const target = Object.fromEntries(rowsFor(state.scale).map((r) => [label(r), r[state.metric]]));
    const from = { ...shown };
    const keys = Object.keys(target);
    const sameAxis = keys.every((k) => k in from) && animate && !reducedMotion;
    if (!sameAxis) { shown = target; drawBars(shown); return; }
    cancelAnimationFrame(anim);
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / 450);
      const e = 1 - Math.pow(1 - t, 3);
      shown = Object.fromEntries(keys.map((k) => [k, from[k] + (target[k] - from[k]) * e]));
      drawBars(shown);
      if (t < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  function setPressed(selector, attr, value) {
    document.querySelectorAll(selector).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === value)));
  }

  function update({ metric, scale } = {}) {
    const axisChanged = (metric && metric !== state.metric) || (scale && scale !== state.scale);
    if (metric) state.metric = metric;
    if (scale) state.scale = scale;
    setPressed("[data-sr-metric]", "srMetric", state.metric);
    setPressed("[data-sr-scale]", "srScale", state.scale);
    $("sr-metric-desc").textContent = METRICS[state.metric].desc;
    $("sr-scale-desc").textContent = SCALE_DESC[state.scale];
    // Bars only animate when the value axis keeps its meaning; a new metric redraws directly.
    if (axisChanged && metric) shown = {};
    applySize();
    render();
    renderTable();
  }

  document.querySelectorAll("[data-sr-metric]").forEach((b) => b.addEventListener("click", () => update({ metric: b.dataset.srMetric })));
  document.querySelectorAll("[data-sr-scale]").forEach((b) => b.addEventListener("click", () => update({ scale: b.dataset.srScale })));

  // Select a family, a method or a take-home message; selecting it again clears it.
  function select(button, sel, settings) {
    const wasActive = button.getAttribute("aria-pressed") === "true";
    document.querySelectorAll("#sr-legend button, #sr-takeaways button").forEach((b) => b.setAttribute("aria-pressed", "false"));
    state.sel = wasActive ? null : sel;
    if (!wasActive) button.setAttribute("aria-pressed", "true");
    if (settings && !wasActive) update(settings);
    else render(false);
  }

  function renderLegend() {
    const legend = $("sr-legend");
    legend.replaceChildren();
    for (const fam of FAMILIES) {
      const col = document.createElement("div");
      col.className = "legend-col";
      const fb = document.createElement("button");
      fb.type = "button";
      fb.className = "legend-family";
      fb.setAttribute("aria-pressed", "false");
      const sw = document.createElement("span");
      sw.className = `legend-swatch ${famClass(fam)}`;
      fb.append(sw, document.createTextNode(`${fam} methods`));
      fb.addEventListener("click", () => select(fb, { families: [fam] }));
      const methods = document.createElement("div");
      methods.className = "legend-methods";
      const famIds = ORDER.filter((id) => data.bars.find((r) => label(r) === id).family === fam);
      for (const m of [...new Set(famIds.map((id) => id.replace(/ \(.*\)$/, "")))]) {
        const mb = document.createElement("button");
        mb.type = "button";
        mb.className = "legend-method";
        mb.setAttribute("aria-pressed", "false");
        mb.textContent = m;
        const ids = ORDER.filter((id) => id === m || id.startsWith(`${m} (`));
        mb.addEventListener("click", () => select(mb, { ids }));
        methods.append(mb);
      }
      col.append(fb, methods);
      legend.append(col);
    }
  }

  function renderTable() {
    const table = $("sr-numbers-table");
    table.replaceChildren();
    const head = table.createTHead().insertRow();
    const body = table.createTBody();
    const th = (t) => { const c = document.createElement("th"); c.textContent = t; head.append(c); };
    if (state.metric === "elo") {
      ["Image", ...FAMILIES].forEach(th);
      for (const p of PANELS) {
        const tr = body.insertRow();
        tr.insertCell().textContent = p;
        for (const f of FAMILIES) {
          const b = data.elo[state.scale][p][f];
          tr.insertCell().textContent = `${fmt(b.mean, 0)} ± ${fmt(b.std, 0)}`;
        }
      }
      return;
    }
    ["Family", "Method", "PSNR (dB)", "SSIM", "LPIPS"].forEach(th);
    for (const r of rowsFor(state.scale)) {
      const tr = body.insertRow();
      for (const v of [r.family, label(r), fmt(r.psnr, 2), fmt(r.ssim, 3), fmt(r.lpips, 3)]) tr.insertCell().textContent = v;
    }
  }

  function renderTakeaways() {
    const list = $("sr-takeaways");
    list.replaceChildren();
    for (const tk of TAKEAWAYS) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("aria-pressed", "false");
      for (const [cls, text] of [["tk-figure", tk.figure], ["tk-title", tk.title], ["tk-text", tk.text]]) {
        const s = document.createElement("span");
        s.className = cls;
        s.textContent = text;
        btn.append(s);
      }
      btn.addEventListener("click", () => {
        select(btn, tk.sel, { metric: tk.metric, scale: tk.scale });
        // Single-column layout: the chart is above the messages, so bring it into view.
        if (btn.getAttribute("aria-pressed") === "true" && singleColumn.matches) {
          const r = chartEl.getBoundingClientRect();
          if (r.top < 0 || r.bottom > window.innerHeight) {
            $("superres").querySelector(".metric-boxes").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
          }
        }
      });
      li.append(btn);
      list.append(li);
    }
  }

  // Bars and box plots need different heights; horizontal bars on narrow screens.
  function applySize() {
    const w = chartEl.clientWidth;
    const horizontal = w < 600;
    size = { w, h: horizontal ? 21 * 22 + 3 * 22 + 56 : Math.round(Math.min(520, Math.max(400, w * 0.62))) };
    if (state.metric === "elo") size.h = horizontal ? 760 : Math.round(Math.min(520, Math.max(420, w * 0.6)));
    svg.setAttribute("width", size.w);
    svg.setAttribute("height", size.h);
    svg.setAttribute("viewBox", `0 0 ${size.w} ${size.h}`);
  }

  function resize() {
    applySize();
    if (data) render(false);
  }

  fetch("assets/superres.json")
    .then((r) => r.json())
    .then((json) => {
      data = json;
      renderLegend();
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

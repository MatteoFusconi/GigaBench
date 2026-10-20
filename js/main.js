// Where the Deep Zoom tiles live: the public R2 bucket, one folder per tile version.
// Use "tiles" to work offline with a local copy (see DEVELOPING.md).
const TILE_BASE = "https://pub-7c353a394194427793251c3ddda02484.r2.dev/v1";
const DEFAULT_IMAGE = "venice";
const STRIP_SPEED = 28;       // px per second; positive moves the cards to the right
const STRIP_RESUME_MS = 2500; // idle time after a manual scroll before the strip moves again

const $ = (id) => document.getElementById(id);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

let images = [];
let current = null;

// Gallery strip ------------------------------------------------------------

const strip = $("strip");
const track = $("track");

function cardHTML(img) {
  const [w, h] = img.orientation === "landscape" ? [640, 480] : [360, 480];
  return `
    <button type="button" class="card" data-id="${img.id}" aria-pressed="false">
      <span class="frame"><img src="assets/previews/${img.id}.webp" width="${w}" height="${h}" alt="" loading="lazy" decoding="async"></span>
      <span class="card-name">${img.name}</span>
      <span class="card-domain">${img.domain}</span>
    </button>`;
}

// Three copies of the set: the middle one is "home" and the outer ones let the strip wrap without a jump.
function buildStrip() {
  const set = images.map((img) => `<li>${cardHTML(img)}</li>`).join("");
  track.innerHTML = set.repeat(3);
  const items = [...track.children];
  items.forEach((li, i) => {
    if (i < images.length || i >= 2 * images.length) {
      li.setAttribute("aria-hidden", "true");
      li.querySelector("button").tabIndex = -1;
    }
  });
  track.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (card) select(card.dataset.id, { scroll: true });
  });
}

const setWidth = () => track.scrollWidth / 3;

function wrapScroll() {
  const w = setWidth();
  if (strip.scrollLeft < 0.5 * w) strip.scrollLeft += w;
  else if (strip.scrollLeft > 1.5 * w) strip.scrollLeft -= w;
}

function startStrip() {
  // Start with the selected card (in the middle copy) near the left edge.
  const selected = [...track.children].slice(images.length).find((li) => li.querySelector('[aria-pressed="true"]'));
  let pos = (selected ? selected.offsetLeft : setWidth()) - 0.1 * strip.clientWidth;
  strip.scrollLeft = pos;

  let hovering = false;
  let focused = false;
  let idleUntil = 0;
  const paused = () => hovering || focused || performance.now() < idleUntil;
  const nudge = () => { idleUntil = performance.now() + STRIP_RESUME_MS; };

  strip.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") hovering = true; });
  strip.addEventListener("pointerleave", () => { hovering = false; });
  // Only keyboard focus pauses the strip; a clicked card keeps focus and would freeze it otherwise.
  strip.addEventListener("focusin", (e) => { focused = e.target.matches(":focus-visible"); });
  strip.addEventListener("focusout", () => { focused = false; });
  ["wheel", "touchstart", "pointerdown"].forEach((t) => strip.addEventListener(t, nudge, { passive: true }));
  strip.addEventListener("scroll", () => {
    wrapScroll();
    if (paused()) pos = strip.scrollLeft;
  }, { passive: true });

  document.querySelectorAll("[data-step]").forEach((btn) => {
    btn.addEventListener("click", () => {
      nudge();
      const step = (track.querySelector("li")?.offsetWidth ?? 300) + 22;
      strip.scrollBy({ left: Number(btn.dataset.step) * step, behavior: reducedMotion ? "auto" : "smooth" });
    });
  });

  if (reducedMotion) return;
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(now - last, 100) / 1000;
    last = now;
    if (!paused() && !document.hidden) {
      const w = setWidth();
      pos -= STRIP_SPEED * dt;
      if (pos < 0.5 * w) pos += w;
      strip.scrollLeft = pos;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Viewer --------------------------------------------------------------------

const stage = $("stage");
const statusEl = $("status");

// OpenSeadragon 4 refuses WebP Deep Zoom tiles unless told the browser can decode them.
OpenSeadragon.setImageFormatsSupported({ webp: true });

const viewer = OpenSeadragon({
  element: $("viewer"),
  showNavigationControl: false,
  showNavigator: true,
  navigatorPosition: "TOP_RIGHT",
  navigatorSizeRatio: 0.16,
  maxZoomPixelRatio: 32,     // up to 32x32 screen pixels per image pixel
  imageSmoothingEnabled: true,
  visibilityRatio: 0.6,
  animationTime: 0.9,
  blendTime: 0.15,
  immediateRender: false,
  crossOriginPolicy: "Anonymous",
});

let loadingTimer;

function openImage(img) {
  clearTimeout(loadingTimer);
  statusEl.textContent = `Loading ${img.name}…`;
  $("readout").hidden = true;
  viewer.open(`${TILE_BASE}/${img.id}.dzi`);
}

viewer.addHandler("open", () => {
  const item = viewer.world.getItemAt(0);
  item.addOnceHandler("fully-loaded-change", () => { statusEl.textContent = ""; });
  loadingTimer = setTimeout(() => { statusEl.textContent = ""; }, 4000);
  updateReadout();
});

viewer.addHandler("open-failed", (e) => {
  clearTimeout(loadingTimer);
  statusEl.textContent = `The tiles for ${current.name} couldn't be loaded. Check your connection, then select the image again.`;
  console.warn("open-failed", e.source, e.message);
});

$("zoom-in").addEventListener("click", () => viewer.viewport.zoomBy(2).applyConstraints());
$("zoom-out").addEventListener("click", () => viewer.viewport.zoomBy(0.5).applyConstraints());
$("zoom-home").addEventListener("click", () => viewer.viewport.goHome());

const fsButton = $("fullscreen");
if (document.fullscreenEnabled) {
  fsButton.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen();
  });
  document.addEventListener("fullscreenchange", () => {
    fsButton.setAttribute("aria-label", document.fullscreenElement ? "Exit full screen" : "Full screen");
  });
} else {
  fsButton.hidden = true;
}

// A plain wheel scrolls the page; Ctrl/⌘ + wheel (or any wheel in full screen) zooms the image.
const wheelHint = $("wheel-hint");
wheelHint.textContent = `Hold ${isMac ? "⌘" : "Ctrl"} and scroll to zoom`;
let hintTimer;
stage.addEventListener("wheel", (e) => {
  if (e.ctrlKey || e.metaKey || document.fullscreenElement) return;
  e.stopPropagation();
  wheelHint.classList.add("show");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => wheelHint.classList.remove("show"), 1200);
}, { capture: true });

// Zoom level (100% = one image pixel per screen pixel) and how much of the image is on screen.
const readoutZoom = $("readout-zoom");
const readoutView = $("readout-view");

function formatPercent(x) {
  if (x >= 10) return `${Math.round(x)}%`;
  if (x >= 1) return `${x.toFixed(1)}%`;
  return `${x.toPrecision(2)}%`;
}

// Above 100% the image pixels are magnified: draw them as hard squares, never interpolated.
// Below 100% keep the browser's filtering, which only avoids shimmer while zoomed out.
let smoothing = true;

function updateSmoothing(zoom) {
  const smooth = zoom < 1;
  if (smooth !== smoothing) {
    smoothing = smooth;
    viewer.drawer.setImageSmoothingEnabled(smooth);
  }
}

function updateReadout() {
  const item = viewer.world.getItemAt(0);
  if (!item) return;
  const { x: W, y: H } = item.getContentSize();
  const zoom = item.viewportToImageZoom(viewer.viewport.getZoom(true));
  updateSmoothing(zoom);
  const b = item.viewportToImageRectangle(viewer.viewport.getBounds(true));
  const visW = Math.max(0, Math.min(W, b.x + b.width) - Math.max(0, b.x));
  const visH = Math.max(0, Math.min(H, b.y + b.height) - Math.max(0, b.y));
  $("readout").hidden = false;
  readoutZoom.textContent = `Zoom ${formatPercent(zoom * 100)}`;
  readoutView.textContent = `${formatPercent((100 * visW * visH) / (W * H))} of the image in view`;
}
viewer.addHandler("animation", updateReadout);
viewer.addHandler("resize", updateReadout);

// Facts ---------------------------------------------------------------------

const fmt = new Intl.NumberFormat("en-US");

function link(text, href) {
  if (!href) return document.createTextNode(text);
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  a.rel = "noopener";
  return a;
}

function showFacts(img) {
  $("image-name").textContent = img.name;
  $("fact-domain").textContent = img.domain;
  $("fact-resolution").textContent = `${fmt.format(img.width)} × ${fmt.format(img.height)} px`;
  $("fact-gpx").textContent = img.gpx.toFixed(2);
  $("fact-size").textContent = `${img.size_gb.toFixed(2)} GB`;
  $("fact-license").replaceChildren(link(img.license, img.license_url));
  $("fact-credit").replaceChildren(link(img.attribution, img.source_url));
}

// Selection -----------------------------------------------------------------

function select(id, { scroll = false } = {}) {
  const img = images.find((i) => i.id === id) ?? images.find((i) => i.id === DEFAULT_IMAGE);
  if (!img || img === current) return;
  current = img;
  track.querySelectorAll(".card").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.id === img.id)));
  showFacts(img);
  openImage(img);
  history.replaceState(null, "", `#${img.id}`);
  if (scroll) stage.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
}

window.addEventListener("hashchange", () => select(location.hash.slice(1)));

// Citation --------------------------------------------------------------------

// Each "Copy BibTeX" button copies the block named in its data-copy attribute.
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($(button.dataset.copy).textContent);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select the text to copy";
    }
    setTimeout(() => { button.textContent = "Copy BibTeX"; }, 2000);
  });
});

// Start -----------------------------------------------------------------------

fetch("assets/images.json")
  .then((r) => r.json())
  .then((data) => {
    images = data;
    buildStrip();
    select(location.hash.slice(1) || DEFAULT_IMAGE);
    startStrip();
  })
  .catch((err) => {
    statusEl.textContent = "The image list couldn't be loaded. Reload the page to try again.";
    console.error(err);
  });

// Felles Norgeskart med ruter, byer, zoom og panorering.
// Krever common.js (sb, pen, el) og norway-map.js.

const SVGNS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

// Byens plassering = snittet av stasjonene i byen. Hentes én gang per side.
let cityPositionsPromise = null;
function loadCityPositions() {
  if (!cityPositionsPromise) {
    cityPositionsPromise = (async () => {
      const { data, error } = await sb.from("stations").select("city, lat, lon");
      if (error) throw error;
      const acc = new Map();
      for (const s of data) {
        if (s.lat == null || s.lon == null) continue;
        if (s.lat < 57 || s.lat > 72 || s.lon < 3 || s.lon > 32) continue;
        const a = acc.get(s.city) ?? { lat: 0, lon: 0, n: 0 };
        a.lat += s.lat;
        a.lon += s.lon;
        a.n++;
        acc.set(s.city, a);
      }
      const pos = new Map();
      for (const [city, a] of acc) pos.set(city, NORWAY_MAP.project(a.lon / a.n, a.lat / a.n));
      return pos;
    })();
  }
  return cityPositionsPromise;
}

const ICON_PLUS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_MINUS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>';
const ICON_FIT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';

let mapCounter = 0;

/**
 * figure: elementet kartet skal ligge i (får svg og zoomknapper)
 * onCityClick(city): kalles når en by trykkes
 */
function createRouteMap(figure, { onCityClick } = {}) {
  const W = NORWAY_MAP.width;
  const H = NORWAY_MAP.height;
  const arrowId = `arrow-${++mapCounter}`;

  const marker = svgEl(
    "marker",
    { id: arrowId, viewBox: "0 0 10 10", refX: "8", refY: "5", markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" },
    svgEl("path", { d: "M0 0L10 5L0 10z", class: "map-arrow" }),
  );
  const overlay = svgEl("g");
  const svg = svgEl(
    "svg",
    { class: "map", role: "img", "aria-label": "Kart over ledige biler" },
    svgEl("defs", {}, marker),
    svgEl("path", { d: NORWAY_MAP.neighbours, class: "map-neighbour" }),
    svgEl("path", { d: NORWAY_MAP.land, class: "map-land" }),
    overlay,
  );

  const btn = (label, icon, onclick) => {
    const b = el("button", { type: "button", class: "map-btn", "aria-label": label, title: label, onclick });
    b.innerHTML = icon;
    return b;
  };
  const btnIn = btn("Zoom inn", ICON_PLUS, () => zoomCenter(1.6));
  const btnOut = btn("Zoom ut", ICON_MINUS, () => zoomCenter(1 / 1.6));
  const btnFit = btn("Vis hele området", ICON_FIT, () => {
    view = null;
    applyView();
    draw();
  });

  figure.classList.add("map-wrap");
  figure.prepend(svg);
  figure.append(el("div", { class: "map-controls" }, btnIn, btnOut, btnFit));

  let cityPos = new Map();
  let data = { trips: [], planned: [], selected: null };
  let fit = [0, 0, W, H];
  let view = null; // null = følg automatisk utsnitt
  let suppressClick = false;

  loadCityPositions()
    .then((p) => {
      cityPos = p;
      recomputeFit();
      applyView();
      draw();
    })
    .catch(console.error);

  // ---------------------------------------------------------- utsnitt

  const current = () => view ?? fit;
  const scale = () => current()[2] / W;

  function recomputeFit() {
    const cities = new Set();
    for (const t of data.trips) {
      cities.add(t.from_city);
      cities.add(t.to_city);
    }
    for (const p of data.planned) {
      if (p.from) cities.add(p.from);
      if (p.to) cities.add(p.to);
    }
    const pts = [...cities].filter((c) => cityPos.has(c)).map((c) => cityPos.get(c));
    if (!pts.length) {
      fit = [0, 0, W, H];
      return;
    }
    const pad = 50;
    let x0 = Math.min(...pts.map((p) => p[0])) - pad;
    let x1 = Math.max(...pts.map((p) => p[0])) + pad + 50; // plass til bynavn
    let y0 = Math.min(...pts.map((p) => p[1])) - pad;
    let y1 = Math.max(...pts.map((p) => p[1])) + pad;
    const minW = 220;
    const minH = 260;
    if (x1 - x0 < minW) { const m = (x0 + x1) / 2; x0 = m - minW / 2; x1 = m + minW / 2; }
    if (y1 - y0 < minH) { const m = (y0 + y1) / 2; y0 = m - minH / 2; y1 = m + minH / 2; }
    fit = [x0, y0, x1 - x0, y1 - y0];
  }

  function applyView() {
    const v = current();
    svg.setAttribute("viewBox", v.map((n) => n.toFixed(1)).join(" "));
    svg.classList.toggle("zoomed", !!view);
    btnFit.disabled = !view;
    btnOut.disabled = !view;
  }

  function clampView([x, y, w, h]) {
    const minX = Math.min(0, fit[0]);
    const maxX = Math.max(W, fit[0] + fit[2]);
    const minY = Math.min(0, fit[1]);
    const maxY = Math.max(H, fit[1] + fit[3]);
    x = Math.min(Math.max(x, minX - w * 0.3), maxX - w * 0.7);
    y = Math.min(Math.max(y, minY - h * 0.3), maxY - h * 0.7);
    return [x, y, w, h];
  }

  let drawQueued = false;
  function queueDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  function zoomAt(factor, px, py) {
    const v = current();
    const w = Math.max(v[2] / factor, 45);
    if (w >= fit[2] - 0.5) {
      if (view) {
        view = null;
        applyView();
        queueDraw();
      }
      return;
    }
    const h = w * (v[3] / v[2]);
    const x = px - (px - v[0]) * (w / v[2]);
    const y = py - (py - v[1]) * (h / v[3]);
    view = clampView([x, y, w, h]);
    applyView();
    queueDraw();
  }

  function zoomCenter(factor) {
    const v = current();
    zoomAt(factor, v[0] + v[2] / 2, v[1] + v[3] / 2);
  }

  function toSvg(clientX, clientY) {
    const m = svg.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  }

  // ---------------------------------------------------------- mus, fingre og styreflate

  const pointers = new Map();
  let lastPinch = null;
  let moved = 0;

  svg.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    moved = 0;
    lastPinch = null;
  });

  window.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = toSvg((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      if (lastPinch && mid) zoomAt(dist / lastPinch, mid[0], mid[1]);
      lastPinch = dist;
      moved += 10;
      return;
    }

    if (!view) return; // panorering bare når man har zoomet inn
    const m = svg.getScreenCTM();
    if (!m) return;
    const dx = (e.clientX - prev[0]) / m.a;
    const dy = (e.clientY - prev[1]) / m.d;
    moved += Math.abs(e.clientX - prev[0]) + Math.abs(e.clientY - prev[1]);
    view = clampView([view[0] - dx, view[1] - dy, view[2], view[3]]);
    applyView();
  });

  const release = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) lastPinch = null;
    if (moved > 6) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 50);
    }
  };
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);

  // Knip på styreflate (Chrome/Firefox) og ctrl + scroll
  svg.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const p = toSvg(e.clientX, e.clientY);
      if (p) zoomAt(Math.exp(-e.deltaY * 0.01), p[0], p[1]);
    },
    { passive: false },
  );

  // Knip på styreflate i Safari på Mac
  let gestureScale = 1;
  svg.addEventListener("gesturestart", (e) => {
    if (pointers.size >= 2) return;
    e.preventDefault();
    gestureScale = 1;
  });
  svg.addEventListener("gesturechange", (e) => {
    if (pointers.size >= 2) return;
    e.preventDefault();
    const p = toSvg(e.clientX, e.clientY) ?? [current()[0] + current()[2] / 2, current()[1] + current()[3] / 2];
    zoomAt(e.scale / gestureScale, p[0], p[1]);
    gestureScale = e.scale;
  });

  svg.addEventListener("dblclick", (e) => {
    const p = toSvg(e.clientX, e.clientY);
    if (p) zoomAt(2, p[0], p[1]);
  });

  // ---------------------------------------------------------- tegning

  function draw() {
    const k = scale();
    svg.style.setProperty("--map-scale", String(k));
    marker.setAttribute("markerWidth", String(8 * k));
    marker.setAttribute("markerHeight", String(8 * k));

    const sel = data.selected;
    const counts = new Map();
    const pairs = new Map();
    for (const t of data.trips) {
      if (!cityPos.has(t.from_city) || !cityPos.has(t.to_city) || t.from_city === t.to_city) continue;
      counts.set(t.from_city, (counts.get(t.from_city) ?? 0) + 1);
      counts.set(t.to_city, (counts.get(t.to_city) ?? 0) + 1);
      const [a, b] = [t.from_city, t.to_city].sort();
      const key = a + "|" + b;
      const pair = pairs.get(key) ?? { a, b, ab: 0, ba: 0 };
      t.from_city === a ? pair.ab++ : pair.ba++;
      pairs.set(key, pair);
    }

    const curve = (x1, y1, x2, y2) => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const cx = (x1 + x2) / 2 - dy * 0.18;
      const cy = (y1 + y2) / 2 + dx * 0.18;
      const pull = (x, y) => {
        const d = Math.hypot(cx - x, cy - y) || 1;
        return [x + ((cx - x) / d) * 7 * k, y + ((cy - y) / d) * 7 * k];
      };
      const [sx, sy] = pull(x1, y1);
      const [ex, ey] = pull(x2, y2);
      return `M${sx.toFixed(1)} ${sy.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
    };

    const routes = svgEl("g", {});

    // Ruter man følger, men som ikke har biler nå: stiplet
    const plannedCities = new Set();
    for (const p of data.planned) {
      if (p.from) plannedCities.add(p.from);
      if (p.to) plannedCities.add(p.to);
      if (!p.from || !p.to || !cityPos.has(p.from) || !cityPos.has(p.to)) continue;
      const [a, b] = [p.from, p.to].sort();
      if (pairs.has(a + "|" + b)) continue;
      const [x1, y1] = cityPos.get(p.from);
      const [x2, y2] = cityPos.get(p.to);
      routes.append(
        svgEl(
          "path",
          { d: curve(x1, y1, x2, y2), class: "map-route planned" },
          svgEl("title", {}, `${pen(p.from)} → ${pen(p.to)}: ingen ledige biler nå`),
        ),
      );
    }

    for (const p of pairs.values()) {
      const [x1, y1] = cityPos.get(p.a);
      const [x2, y2] = cityPos.get(p.b);
      const total = p.ab + p.ba;
      const touches = !sel || p.a === sel || p.b === sel;
      const plural = (n) => `${n} ${n === 1 ? "bil" : "biler"}`;
      const title = [
        p.ab ? `${pen(p.a)} → ${pen(p.b)}: ${plural(p.ab)}` : null,
        p.ba ? `${pen(p.b)} → ${pen(p.a)}: ${plural(p.ba)}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      routes.append(
        svgEl(
          "path",
          {
            d: curve(x1, y1, x2, y2),
            class: touches ? "map-route" : "map-route dim",
            "stroke-width": String(Math.min(1.4 + total * 0.35, 3.4)),
            "marker-end": p.ab ? `url(#${arrowId})` : null,
            "marker-start": p.ba ? `url(#${arrowId})` : null,
          },
          svgEl("title", {}, title),
        ),
      );
    }

    // Byer: de travleste først, og hopp over navn som ville kollidert
    const allCities = new Map(counts);
    for (const c of plannedCities) if (!allCities.has(c) && cityPos.has(c)) allCities.set(c, 0);

    const cities = svgEl("g", {});
    const labels = svgEl("g", {});
    const placed = [];
    const order = [...allCities.entries()].sort((a, b) => b[1] - a[1]);
    for (const [city, n] of order) {
      const [x, y] = cityPos.get(city);
      const active = city === sel;
      const text = n ? `${pen(city)}: ${n} ${n === 1 ? "bil" : "biler"}` : `${pen(city)}: ingen ledige biler nå`;
      cities.append(
        svgEl(
          "g",
          {
            class: ["map-city", active ? "active" : "", n ? "" : "empty"].join(" ").trim(),
            tabindex: "0",
            role: "button",
            "aria-label": text,
            onclick: () => {
              if (!suppressClick && onCityClick) onCityClick(city);
            },
            onkeydown: (e) => {
              if ((e.key === "Enter" || e.key === " ") && onCityClick) {
                e.preventDefault();
                onCityClick(city);
              }
            },
          },
          svgEl("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: String(12 * k), class: "map-hit" }),
          svgEl("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: String((active ? 5.5 : 4.5) * k), class: "map-dot" }),
          svgEl("title", {}, text),
        ),
      );

      const lx = x + 8 * k;
      const ly = y + 4 * k;
      const clash = placed.some(([px, py]) => Math.abs(py - ly) < 13 * k && Math.abs(px - lx) < 70 * k);
      if (!clash || active) {
        placed.push([lx, ly]);
        labels.append(svgEl("text", { x: lx.toFixed(1), y: ly.toFixed(1), class: active ? "map-label active" : "map-label" }, pen(city)));
      }
    }

    overlay.replaceChildren(routes, labels, cities);
  }

  return {
    // trips: turene som skal vises, planned: [{from, to}] ruter man følger, selected: valgt by
    setData(next) {
      data = { ...data, ...next };
      recomputeFit();
      if (view) view = clampView(view);
      applyView();
      draw();
    },
  };
}

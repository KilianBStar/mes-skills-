/* Cap Colis : logique de l'application (sans framework). */
(function () {
  'use strict';

  // ---------- État & persistance ----------
  const STORE_KEY = 'cap-colis-v1';
  const SETTINGS_VERSION = 2;
  const DEFAULT_SETTINGS = {
    v: SETTINGS_VERSION, startNow: true, startTime: '08:00', service: 1, endMode: 'start', navApp: 'waze',
    autoNav: true, region: 'fr', osrm: 'https://router.project-osrm.org', map3d: true,
  };
  const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
  const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  let state = load();
  let undoAction = null;

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && Array.isArray(s.stops)) {
        const old = s.settings || {};
        s.settings = Object.assign({}, DEFAULT_SETTINGS, old);
        if ((old.v || 1) < 2) { s.settings.service = 1; s.settings.navApp = 'waze'; s.settings.v = SETTINGS_VERSION; }
        s.found = Array.isArray(s.found) ? s.found : [];
        return s;
      }
    } catch (e) { /* stockage indisponible */ }
    return { settings: Object.assign({}, DEFAULT_SETTINGS), start: null, end: null, stops: [], route: null, found: [] };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* stockage plein ou bloqué */ }
  }

  // ---------- Utilitaires ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const toSec = (hhmm) => { if (!hhmm) return null; const [h, m] = hhmm.split(':').map(Number); return h * 3600 + m * 60; };
  const fmtClock = (sec) => { if (sec == null || !isFinite(sec)) return '–'; const m = Math.round(sec / 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const fmtDur = (sec) => { const m = Math.max(0, Math.round(sec / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
  const fmtKm = (m) => (m >= 10000 ? `${Math.round(m / 1000)} km` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
  const nowSec = () => { const d = new Date(); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); };
  const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
  const serviceMin = (s) => (s && s.service != null ? s.service : Number(state.settings.service) || 0);

  async function fetchJSON(url, timeout = 12000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Chargement impossible : ${src}`));
      document.head.appendChild(s);
    });
  }

  let toastTimer;
  function toast(text, undo) {
    $('toastText').textContent = text;
    $('toast').hidden = false;
    $('toastUndo').hidden = !undo;
    undoAction = undo || null;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; undoAction = null; }, undo ? 6000 : 3500);
  }
  $('toastUndo').addEventListener('click', () => { $('toast').hidden = true; if (undoAction) undoAction(); undoAction = null; });

  // ---------- Géocodage ----------
  function biasParams() {
    const p = state.start || state.stops[state.stops.length - 1];
    return p ? `&lat=${p.lat}&lon=${p.lon}` : '';
  }
  function photonLabel(p) {
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const first = p.name && p.name !== p.street ? p.name : street;
    const parts = [first, first === street ? '' : street, [p.postcode, p.city].filter(Boolean).join(' '), p.country && p.country !== 'France' ? p.country : ''];
    return parts.filter(Boolean).join(', ');
  }
  async function geoSearch(q, limit = 5) {
    if (state.settings.region === 'fr') {
      try {
        const r = await fetchJSON(`https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(q)}&limit=${limit}&autocomplete=1${biasParams()}`);
        const out = (r.features || []).map((f) => ({ label: f.properties.label, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], score: f.properties.score, type: f.properties.type }));
        if (out.length) return out;
      } catch (e) { /* on passe à Photon */ }
    }
    const r = await fetchJSON(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit}&lang=fr${biasParams()}`);
    return (r.features || []).map((f) => ({ label: photonLabel(f.properties), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], type: f.properties.housenumber ? 'housenumber' : 'street' }));
  }
  async function geoReverse(lat, lon) {
    try {
      const r = await fetchJSON(`https://data.geopf.fr/geocodage/reverse?lat=${lat}&lon=${lon}&limit=1`);
      if (r.features && r.features[0]) return r.features[0].properties.label;
    } catch (e) { /* on passe à Photon */ }
    try {
      const r = await fetchJSON(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=fr`);
      if (r.features && r.features[0]) return photonLabel(r.features[0].properties);
    } catch (e) { /* coordonnées brutes */ }
    return `Point ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  }

  /** Champ de recherche avec suggestions (clavier + tactile). */
  function attachSearch(input, list, onPick) {
    let timer, seq = 0, items = [], active = -1;
    const close = () => { list.hidden = true; active = -1; };
    const render = () => {
      list.innerHTML = items.length
        ? items.map((it, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}">${esc(it.label)}</li>`).join('')
        : '<li class="info">Aucune adresse trouvée</li>';
      list.hidden = false;
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) { close(); return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        list.innerHTML = '<li class="info">Recherche…</li>'; list.hidden = false;
        try { const res = await geoSearch(q); if (my !== seq) return; items = res; active = -1; render(); }
        catch (e) { if (my === seq) list.innerHTML = '<li class="info">Recherche impossible. Vérifiez la connexion.</li>'; }
      }, 300);
    });
    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { const it = items[active >= 0 ? active : 0]; if (it) { e.preventDefault(); pick(it); } }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('pointerdown', (e) => {
      const li = e.target.closest('li[data-i]');
      if (!li) return;
      e.preventDefault();
      pick(items[+li.dataset.i]);
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    function pick(it) { close(); seq++; input.blur(); onPick(it); }
  }

  // ---------- Carte 3D (MapLibre + OpenFreeMap) ----------
  let map = null;
  let styleReady = false;
  let buildingLayers = [];
  let markers = [];
  let lastBoundsKey = '';
  let lastFocusId = null;

  function initMap() {
    if (!window.maplibregl) { mapUnavailable('Carte indisponible : vérifiez la connexion.'); return; }
    try {
      map = new maplibregl.Map({
        container: 'map', style: MAP_STYLE, center: [2.4, 46.6], zoom: 5,
        pitch: 0, maxPitch: 70, attributionControl: { compact: true },
      });
    } catch (e) {
      mapUnavailable('Cet appareil ne peut pas afficher la carte 3D.');
      return;
    }
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
    map.on('load', () => {
      styleReady = true;
      setupBuildings();
      setupRouteLayers();
      apply3D(false);
      renderMap();
    });
    map.on('error', (e) => { if (!styleReady) console.warn('Carte :', e && e.error && e.error.message); });
    map.on('click', onMapClick);
  }
  function mapUnavailable(msg) {
    $('map').innerHTML = `<div class="map-fallback">${esc(msg)}</div>`;
  }
  function setupBuildings() {
    const layers = map.getStyle().layers || [];
    buildingLayers = layers.filter((l) => l.type === 'fill-extrusion').map((l) => l.id);
    if (!buildingLayers.length && map.getSource('openmaptiles')) {
      map.addLayer({
        id: 'cc-buildings-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
        paint: {
          'fill-extrusion-color': '#cfc6b8',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.85,
        },
      });
      buildingLayers = ['cc-buildings-3d'];
    }
  }
  function setupRouteLayers() {
    map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const layout = { 'line-join': 'round', 'line-cap': 'round' };
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout, filter: ['!=', ['get', 'dashed'], true], paint: { 'line-color': '#FFFFFF', 'line-width': 9, 'line-opacity': 0.9 } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout, filter: ['!=', ['get', 'dashed'], true], paint: { 'line-color': '#B85A12', 'line-width': 5 } });
    map.addLayer({ id: 'route-dashed', type: 'line', source: 'route', layout, filter: ['==', ['get', 'dashed'], true], paint: { 'line-color': '#B85A12', 'line-width': 4, 'line-dasharray': [1.5, 1.5] } });
  }
  function apply3D(animate = true) {
    const on = !!state.settings.map3d;
    $('btn3d').textContent = on ? '2D' : '3D';
    $('btn3d').setAttribute('aria-label', on ? 'Passer la carte en 2D' : 'Passer la carte en 3D');
    if (!map) return;
    if (styleReady) for (const id of buildingLayers) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    const opts = { pitch: on ? 60 : 0, bearing: on ? map.getBearing() : 0 };
    if (animate) map.easeTo({ ...opts, duration: 700 }); else map.jumpTo(opts);
  }

  async function onMapClick(e) {
    const { lat, lng } = e.lngLat;
    const pop = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' }).setLngLat(e.lngLat).setHTML('<em>Recherche de l\'adresse…</em>').addTo(map);
    const label = await geoReverse(lat, lng);
    const div = document.createElement('div');
    div.className = 'pop';
    div.innerHTML = `<strong>${esc(label)}</strong>`;
    const b = document.createElement('button');
    b.className = 'btn primary'; b.type = 'button'; b.textContent = 'Ajouter cet arrêt';
    b.onclick = () => { addStop({ label, lat, lon: lng }); pop.remove(); };
    const b2 = document.createElement('button');
    b2.className = 'btn ghost'; b2.type = 'button'; b2.textContent = 'Partir d\'ici';
    b2.onclick = () => { setStart({ label, lat, lon: lng }); pop.remove(); };
    div.append(b, b2);
    pop.setDOMContent(div);
  }

  function markerEl(text, cls, onClick) {
    const el = document.createElement('div');
    el.className = `mk ${cls}`;
    el.textContent = text;
    if (onClick) el.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
    return el;
  }

  function routeLineCoords() {
    const r = state.route;
    if (!r) return null;
    if (r.geometry && r.geometry.length > 1) return { coords: r.geometry.map(([la, lo]) => [lo, la]), dashed: false };
    const pts = [r.start, ...r.order.map(stopById).filter(Boolean), r.endPt].filter(Boolean);
    return { coords: pts.map((p) => [p.lon, p.lat]), dashed: true };
  }

  function renderMap() {
    if (!map) return;
    markers.forEach((m) => m.remove());
    markers = [];
    const pts = [];
    const add = (p, el, title) => {
      el.title = title;
      markers.push(new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map));
      pts.push([p.lon, p.lat]);
    };
    if (state.start) add(state.start, markerEl('D', 'depot'), `Départ : ${state.start.label}`);
    if (state.settings.endMode === 'address' && state.end) add(state.end, markerEl('A', 'depot'), `Arrivée : ${state.end.label}`);
    const cur = currentStop();
    for (const s of state.stops) {
      const n = orderNumber(s.id);
      const cls = s.status === 'done' ? 'done' : s.status === 'failed' ? 'failed' : cur && cur.id === s.id ? 'cur' : n ? '' : 'unordered';
      add(s, markerEl(n || '•', cls, () => openStopDialog(s.id)), s.label);
    }
    if (styleReady && map.getSource('route')) {
      const line = routeLineCoords();
      map.getSource('route').setData({
        type: 'FeatureCollection',
        features: line && line.coords.length > 1 ? [{ type: 'Feature', properties: { dashed: line.dashed }, geometry: { type: 'LineString', coordinates: line.coords } }] : [],
      });
    }
    const key = pts.map((p) => p.join(',')).join(';');
    if (pts.length && key !== lastBoundsKey) {
      lastBoundsKey = key;
      fitAll();
    }
  }
  function fitAll() {
    if (!map) return;
    const pts = [];
    if (state.start) pts.push([state.start.lon, state.start.lat]);
    for (const s of state.stops) pts.push([s.lon, s.lat]);
    if (!pts.length) return;
    if (pts.length === 1) { map.easeTo({ center: pts[0], zoom: 15, pitch: state.settings.map3d ? 55 : 0 }); return; }
    const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.fitBounds(b, { padding: 50, maxZoom: 16, pitch: state.settings.map3d ? 45 : 0, duration: 600 });
  }
  /** Mode tournée : la caméra se place sur l'arrêt en cours, orientée depuis l'arrêt précédent. */
  function focusCurrent(force) {
    if (!map) return;
    const cur = currentStop();
    if (!cur || (!force && cur.id === lastFocusId)) return;
    lastFocusId = cur.id;
    const prev = previousPoint(cur.id);
    let bearing = 0;
    if (prev && state.settings.map3d) {
      const y = Math.sin((cur.lon - prev.lon) * Math.PI / 180) * Math.cos(cur.lat * Math.PI / 180);
      const x = Math.cos(prev.lat * Math.PI / 180) * Math.sin(cur.lat * Math.PI / 180) - Math.sin(prev.lat * Math.PI / 180) * Math.cos(cur.lat * Math.PI / 180) * Math.cos((cur.lon - prev.lon) * Math.PI / 180);
      bearing = (Math.atan2(y, x) * 180) / Math.PI;
    }
    map.easeTo({ center: [cur.lon, cur.lat], zoom: 16.5, pitch: state.settings.map3d ? 60 : 0, bearing, duration: 900 });
  }
  function previousPoint(id) {
    const r = state.route;
    if (!r) return null;
    const i = r.order.indexOf(id);
    for (let k = i - 1; k >= 0; k--) { const s = stopById(r.order[k]); if (s) return s; }
    return r.start;
  }

  // ---------- Gestion des arrêts ----------
  function newStop(p, extra = {}) {
    return {
      id: uid(), label: p.label, lat: p.lat, lon: p.lon, note: extra.note || '', packages: extra.packages || 1, group: 1,
      after: '', before: '', service: null, status: 'pending', check: !!extra.check,
    };
  }
  function addStop(p, extra = {}) {
    const dup = state.stops.some((s) => Math.abs(s.lat - p.lat) < 1e-6 && Math.abs(s.lon - p.lon) < 1e-6);
    const s = newStop(p, extra);
    state.stops.push(s);
    if (!extra.silent) {
      renderAll();
      toast(dup ? 'Ajouté. Attention : cette adresse figure déjà dans la liste.' : `Arrêt ajouté (${state.stops.length})`);
    }
    return s;
  }
  function setStart(p) {
    state.start = { label: p.label, lat: p.lat, lon: p.lon };
    $('startInput').value = '';
    state.route = null;
    renderAll();
  }

  function orderNumber(id) {
    if (!state.route) return null;
    const i = state.route.order.indexOf(id);
    return i < 0 ? null : i + 1;
  }
  function stopById(id) { return state.stops.find((s) => s.id === id); }
  function currentStop() {
    if (!state.route) return null;
    for (const id of state.route.order) { const s = stopById(id); if (s && s.status === 'pending') return s; }
    return null;
  }
  function unorderedPending() {
    if (!state.route) return [];
    return state.stops.filter((s) => s.status === 'pending' && !state.route.order.includes(s.id));
  }

  // ---------- Optimisation ----------
  function endPoint() {
    if (state.settings.endMode === 'start') return state.start;
    if (state.settings.endMode === 'address') return state.end;
    return null;
  }
  function plannedStart() {
    if (state.settings.startNow) return Math.ceil(nowSec() / 300) * 300; // prochaine tranche de 5 min
    return toSec(state.settings.startTime) ?? 8 * 3600;
  }
  async function osrmTable(points) {
    const base = state.settings.osrm.replace(/\/+$/, '');
    const coords = points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const r = await fetchJSON(`${base}/table/v1/driving/${coords}?annotations=duration,distance`, 25000);
    if (r.code !== 'Ok') throw new Error(r.code);
    const est = Optimizer.estimateMatrix(points);
    const fix = (M, E) => M.map((row, i) => row.map((v, j) => (v == null ? E[i][j] * 3 : v)));
    return { durations: fix(r.durations, est.durations), distances: fix(r.distances || est.distances, est.distances) };
  }
  async function osrmGeometry(points) {
    const base = state.settings.osrm.replace(/\/+$/, '');
    const out = [];
    const CH = 50;
    for (let i = 0; i < points.length - 1; i += CH - 1) {
      const chunk = points.slice(i, i + CH);
      if (chunk.length < 2) break;
      const coords = chunk.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
      const r = await fetchJSON(`${base}/route/v1/driving/${coords}?overview=full&geometries=geojson`, 25000);
      if (r.code !== 'Ok') throw new Error(r.code);
      for (const c of r.routes[0].geometry.coordinates) out.push([c[1], c[0]]);
    }
    return out;
  }

  let optimizing = false;
  async function optimize(fromHere) {
    if (optimizing) return;
    const pending = state.stops.filter((s) => s.status === 'pending');
    const start = fromHere || state.start;
    if (!start) { switchView('plan'); toast('Indiquez d\'abord votre point de départ.'); $('startInput').focus(); return; }
    if (!pending.length) { toast('Ajoutez au moins un arrêt.'); return; }
    if (state.settings.endMode === 'address' && !state.end) { toast('Indiquez l\'adresse d\'arrivée dans Réglages.'); return; }

    optimizing = true;
    const btn = $('optimizeBtn');
    btn.disabled = true; btn.textContent = 'Calcul en cours…';
    try {
      const end = endPoint();
      const points = [start, ...pending];
      if (end) points.push(end);
      let mat = null, source = 'osrm';
      if (points.length <= 100) {
        try { mat = await osrmTable(points); } catch (e) { mat = null; }
      }
      if (!mat) { mat = Optimizer.estimateMatrix(points); source = 'estimate'; }

      const stops = pending.map((s) => ({ service: serviceMin(s) * 60, group: s.group, after: toSec(s.after), before: toSec(s.before) }));
      const startTime = fromHere ? nowSec() : plannedStart();
      const endIndex = end ? points.length - 1 : null;
      const res = Optimizer.optimize({
        durations: mat.durations, stops, startTime, endIndex,
        timeBudgetMs: Math.min(3000, 300 + pending.length * 25),
      });

      const done = state.route
        ? state.route.order.filter((id) => { const s = stopById(id); return s && s.status !== 'pending'; })
        : state.stops.filter((s) => s.status !== 'pending').map((s) => s.id);
      const orderedPending = res.order.map((i) => pending[i - 1].id);
      let dist = 0, prev = 0;
      for (const i of res.order) { dist += mat.distances[prev][i]; prev = i; }
      if (end) dist += mat.distances[prev][endIndex];

      const etas = {};
      res.order.forEach((i, k) => { etas[pending[i - 1].id] = res.etas[k]; });
      const oldEtas = state.route ? state.route.etas : {};
      for (const id of done) etas[id] = oldEtas[id] ?? null;

      const seq = [start, ...res.order.map((i) => pending[i - 1])];
      if (end) seq.push(end);
      let geometry = null;
      if (source === 'osrm') { try { geometry = await osrmGeometry(seq); } catch (e) { geometry = null; } }

      state.route = {
        order: [...done, ...orderedPending], etas, startTime, duration: res.duration, distance: dist,
        late: res.late, end: res.end, source, geometry,
        start: { lat: start.lat, lon: start.lon, label: start.label },
        endPt: end ? { lat: end.lat, lon: end.lon } : null,
        // matrice gardée pour recalculer les heures (déplacement manuel, heure de fin en direct)
        matrix: { ids: pending.map((s) => s.id), durations: mat.durations.map((row) => row.map((v) => Math.round(v))), endIndex, startTime },
      };
      lastBoundsKey = ''; lastFocusId = null;
      renderAll();
      toast(source === 'osrm'
        ? `Tournée optimisée. Fin prévue à ${fmtClock(res.end)}.`
        : `Tournée optimisée avec des temps estimés (serveur d'itinéraire injoignable). Fin vers ${fmtClock(res.end)}.`);
      switchView('run');
      setTimeout(() => focusCurrent(true), 700);
    } catch (e) {
      console.error(e);
      toast('L\'optimisation a échoué. Réessayez.');
    } finally {
      optimizing = false;
      btn.disabled = false;
      renderPlan();
    }
  }
  function reoptimizeRemaining() {
    const handled = state.stops.filter((s) => s.status !== 'pending' && s.doneAt).sort((a, b) => b.doneAt - a.doneAt);
    if (handled.length) optimize({ label: handled[0].label, lat: handled[0].lat, lon: handled[0].lon });
    else optimize();
  }

  /** Recalcule les heures prévues avec la matrice gardée (après un déplacement à la main). */
  function recomputeEtas() {
    const r = state.route;
    if (!r || !r.matrix) return;
    const mx = r.matrix;
    const idx = new Map(mx.ids.map((id, i) => [id, i + 1]));
    const seq = r.order.filter((id) => idx.has(id) && stopById(id));
    const stops = mx.ids.map((id) => { const s = stopById(id) || {}; return { service: serviceMin(s) * 60, group: s.group, after: toSec(s.after), before: toSec(s.before) }; });
    const sch = Optimizer.schedule(seq.map((id) => idx.get(id)), { M: mx.durations, stops, startTime: mx.startTime, endIndex: mx.endIndex });
    seq.forEach((id, k) => { r.etas[id] = sch.etas[k]; });
    r.duration = sch.duration; r.late = sch.late; r.end = sch.end;
  }

  /**
   * Heure de fin en direct : repart de maintenant et du dernier arrêt traité,
   * puis enchaîne les arrêts restants (trajet + temps d'arrêt).
   */
  function liveFinish() {
    const r = state.route;
    if (!r || !r.matrix) return r ? { end: r.end, remaining: r.duration } : null;
    const mx = r.matrix;
    const idx = new Map(mx.ids.map((id, i) => [id, i + 1]));
    const handled = state.stops.filter((s) => s.status !== 'pending' && s.doneAt && idx.has(s.id)).sort((a, b) => b.doneAt - a.doneAt);
    let node = 0;
    let t = Math.max(nowSec(), mx.startTime);
    if (handled.length) node = idx.get(handled[0].id);
    const t0 = t;
    let partial = unorderedPending().length > 0;
    for (const id of r.order) {
      const s = stopById(id);
      if (!s || s.status !== 'pending') continue;
      if (!idx.has(id)) { partial = true; continue; }
      const i = idx.get(id);
      t += mx.durations[node][i];
      const after = toSec(s.after);
      if (after != null && t < after) t = after;
      t += serviceMin(s) * 60;
      node = i;
    }
    if (mx.endIndex != null) t += mx.durations[node][mx.endIndex];
    return { end: t, remaining: t - t0, partial };
  }

  function moveInRoute(id, delta) {
    const r = state.route; if (!r) return;
    const i = r.order.indexOf(id), j = i + delta;
    if (i < 0 || j < 0 || j >= r.order.length) return;
    const other = stopById(r.order[j]);
    if (!other || other.status !== 'pending') return;
    [r.order[i], r.order[j]] = [r.order[j], r.order[i]];
    recomputeEtas();
    r.geometry = null;
    renderAll();
  }

  // ---------- Livraison ----------
  function navUrl(s) {
    const ll = `${s.lat},${s.lon}`;
    switch (state.settings.navApp) {
      case 'google': return IS_IOS ? `comgooglemaps://?daddr=${ll}&directionsmode=driving` : `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`;
      case 'apple': return `https://maps.apple.com/?daddr=${ll}&dirflg=d`;
      default: return IS_IOS ? `waze://?ll=${ll}&navigate=yes` : `https://waze.com/ul?ll=${ll}&navigate=yes`;
    }
  }
  function openNav(s) {
    const url = navUrl(s);
    if (/^https?:/.test(url)) {
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    } else {
      window.location.href = url; // ouvre l'application (Waze, Google Maps)
      // Si l'app n'est pas installée, l'iPhone reste sur Cap Colis : on passe par le lien web.
      const web = state.settings.navApp === 'google'
        ? `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving`
        : `https://waze.com/ul?ll=${s.lat},${s.lon}&navigate=yes`;
      setTimeout(() => { if (!document.hidden) window.location.href = web; }, 1800);
    }
  }
  /** Arrêt à livrer juste après celui-ci dans l'ordre de passage. */
  function nextAfter(id) {
    const r = state.route;
    if (!r) return null;
    for (const oid of r.order.slice(r.order.indexOf(id) + 1)) { const s = stopById(oid); if (s && s.status === 'pending') return s; }
    return null;
  }
  function navName() {
    return { waze: 'Waze', google: 'Google Maps', apple: 'Plans' }[state.settings.navApp] || 'le GPS';
  }

  function mark(id, status, reason) {
    const s = stopById(id); if (!s) return;
    const prev = { status: s.status, failReason: s.failReason, doneAt: s.doneAt };
    s.status = status; s.failReason = reason || ''; s.doneAt = Date.now();
    renderAll();
    const short = s.label.split(',')[0];
    toast(status === 'done' ? `Livré : ${short}` : `Échec (${reason}) : ${short}`, () => { Object.assign(s, prev); lastFocusId = null; renderAll(); focusCurrent(true); });
    focusCurrent();
    const next = currentStop();
    if (state.settings.autoNav && next) openNav(next);
    if (!next && !unorderedPending().length) setTimeout(() => toast('Tournée terminée. Exportez le bilan depuis l\'onglet Tournée.'), 1200);
  }
  function skip(id) {
    const r = state.route; if (!r) return;
    r.order.splice(r.order.indexOf(id), 1);
    r.order.push(id);
    recomputeEtas();
    r.geometry = null;
    renderAll();
    focusCurrent();
    toast('Arrêt reporté en fin de tournée.');
    const next = currentStop();
    if (state.settings.autoNav && next && next.id !== id) openNav(next);
  }

  // ---------- Rendu ----------
  function stopMetaHTML(s, withEta) {
    const bits = [];
    if (s.packages > 1) bits.push(`<span class="pill">${s.packages} colis</span>`);
    if (s.check) bits.push('<span class="pill window">Adresse à vérifier</span>');
    if (s.group === 0) bits.push('<span class="pill first">En premier</span>');
    if (s.group === 2) bits.push('<span class="pill last">En dernier</span>');
    if (s.after || s.before) bits.push(`<span class="pill window">${s.after ? 'après ' + s.after : ''}${s.after && s.before ? ' · ' : ''}${s.before ? 'avant ' + s.before : ''}</span>`);
    const eta = withEta && state.route ? state.route.etas[s.id] : null;
    if (eta != null && s.before && eta > toSec(s.before) && s.status === 'pending') bits.push('<span class="pill late">En retard</span>');
    if (s.status === 'failed') bits.push(`<span class="pill late">${esc(s.failReason || 'Échec')}</span>`);
    if (s.status === 'done') bits.push('<span class="pill ok">Livré</span>');
    if (s.note) bits.push(`<span class="meta-note">${esc(s.note)}</span>`);
    return bits.join('');
  }

  function renderPlan() {
    $('startChosen').innerHTML = state.start ? `<strong>${esc(state.start.label)}</strong>` : 'Aucun départ. Saisissez une adresse ou touchez ◎.';
    const ordered = state.route
      ? [...state.route.order.map(stopById).filter(Boolean), ...state.stops.filter((s) => !state.route.order.includes(s.id))]
      : state.stops;
    const totalPk = state.stops.reduce((a, s) => a + (Number(s.packages) || 1), 0);
    $('stopsTitle').textContent = state.stops.length ? `${plural(state.stops.length, 'arrêt')} · ${totalPk} colis` : 'Arrêts';
    $('stopsEmpty').hidden = state.stops.length > 0;
    $('clearAll').hidden = state.stops.length === 0;
    $('stopList').innerHTML = ordered.map((s) => {
      const n = orderNumber(s.id);
      const cls = s.status !== 'pending' ? s.status : n ? '' : 'pending-unordered';
      const eta = state.route && state.route.etas[s.id] != null ? `<div class="eta">${fmtClock(state.route.etas[s.id])}<small>prévu</small></div>` : '<div></div>';
      return `<li class="stop">
        <span class="num ${cls}">${n || '•'}</span>
        <button type="button" class="stop-main" data-edit="${s.id}"><span class="stop-addr">${esc(s.label)}</span><span class="stop-meta">${stopMetaHTML(s, true)}</span></button>
        ${eta}
      </li>`;
    }).join('');
    const sum = $('routeSummary');
    const btn = $('optimizeBtn');
    if (!optimizing) btn.textContent = state.route ? 'Réoptimiser la tournée' : 'Optimiser la tournée';
    if (state.route) {
      const r = state.route;
      const extra = unorderedPending().length;
      sum.innerHTML = `<b>${fmtDur(r.duration)}</b> · <b>${fmtKm(r.distance)}</b> · fin prévue <b>${fmtClock(r.end)}</b>`
        + (r.late > 0 ? ' · <span class="txt-bad">créneau dépassé</span>' : '')
        + (r.source === 'estimate' ? '<br>Temps estimés à vol d\'oiseau' : '')
        + (extra ? `<br><b>${plural(extra, 'nouvel arrêt')}</b> hors tournée : réoptimisez.` : '');
    } else {
      sum.textContent = state.stops.length ? `${state.settings.service} min par arrêt. Touchez Optimiser pour obtenir l'ordre et l'heure de fin.` : '';
    }
  }

  function renderRun() {
    const card = $('currentCard');
    const r = state.route;
    const total = state.stops.length;
    const done = state.stops.filter((s) => s.status === 'done').length;
    const failed = state.stops.filter((s) => s.status === 'failed').length;
    const left = total - done - failed;
    $('progressBar').style.width = total ? `${((done + failed) / total) * 100}%` : '0';
    $('progressText').textContent = total ? `${done} livré${done > 1 ? 's' : ''} · ${failed} échec${failed > 1 ? 's' : ''} · ${left} restant${left > 1 ? 's' : ''}` : '';

    if (!r) {
      card.innerHTML = `<div class="card"><div class="card-addr">Pas encore de tournée</div><div class="card-sub">Scannez votre manifeste ou ajoutez vos adresses dans Préparer, puis touchez Optimiser.</div><button class="btn primary" type="button" data-go="plan">Préparer la tournée</button></div>`;
      $('runList').innerHTML = '';
      $('finishBox').hidden = true;
      return;
    }
    const lf = liveFinish();
    $('finishBox').hidden = false;
    $('finishTime').textContent = fmtClock(lf.end);
    $('finishSub').textContent = left ? `encore ${fmtDur(lf.remaining)}${lf.partial ? ' (hors nouveaux arrêts)' : ''}` : 'tournée bouclée';

    const cur = currentStop();
    const extra = unorderedPending();
    const banner = extra.length
      ? `<div class="banner">${plural(extra.length, 'arrêt')} ajouté${extra.length > 1 ? 's' : ''} hors tournée.<button class="btn primary" type="button" data-act="reopt">Les intégrer</button></div>`
      : '';
    if (cur) {
      const n = orderNumber(cur.id);
      const eta = r.etas[cur.id];
      const nx = nextAfter(cur.id);
      const nextHint = state.settings.autoNav && nx ? `<small>puis ${esc(navName())} vers le n° ${orderNumber(nx.id)}</small>` : '';
      card.innerHTML = `<div class="card">
        <div class="card-top"><span class="num">${n}</span>
          <div class="card-text"><div class="card-addr">${esc(cur.label)}</div>
          <div class="card-sub">Arrivée prévue ${fmtClock(eta)} · ${cur.packages} colis${cur.before ? ' · avant ' + cur.before : ''}${cur.after ? ' · après ' + cur.after : ''}</div></div></div>
        ${cur.note ? `<div class="card-note">${esc(cur.note)}</div>` : ''}
        ${cur.check ? '<div class="card-note">Adresse lue sur photo : vérifiez-la sur place.</div>' : ''}
        <div class="card-actions">
          <button class="btn primary nav" type="button" data-act="nav" data-id="${cur.id}">Y aller avec ${navName()}</button>
          <button class="btn ok" type="button" data-act="done" data-id="${cur.id}">Livré${nextHint}</button>
          <button class="btn bad" type="button" data-act="fail" data-id="${cur.id}">Échec</button>
          <button class="btn ghost wide" type="button" data-act="skip" data-id="${cur.id}">Passer pour l'instant</button>
        </div></div>${banner}`;
    } else if (extra.length) {
      card.innerHTML = banner;
    } else {
      card.innerHTML = `<div class="card done-card"><div class="big-num">${done}/${total}</div><div class="card-addr">Tournée terminée</div><div class="card-sub">${failed ? `${plural(failed, 'colis')} à rapporter.` : 'Tous les colis sont livrés.'}</div></div>`;
    }
    $('runList').innerHTML = r.order.map((id, k) => {
      const s = stopById(id); if (!s) return '';
      const isCur = cur && cur.id === id;
      const cls = s.status !== 'pending' ? s.status : '';
      const canMove = s.status === 'pending' && !isCur;
      const side = canMove
        ? `<div class="move"><button type="button" aria-label="Monter" data-move="-1" data-id="${id}">▲</button><button type="button" aria-label="Descendre" data-move="1" data-id="${id}">▼</button></div>`
        : s.status !== 'pending' ? `<button class="btn link" type="button" data-act="reset" data-id="${id}">Rétablir</button>` : '<div></div>';
      return `<li class="stop ${isCur ? 'is-current' : ''} ${s.status !== 'pending' ? 'is-done' : ''}">
        <span class="num ${cls}">${k + 1}</span>
        <button type="button" class="stop-main" data-edit="${s.id}"><span class="stop-addr">${esc(s.label)}</span><span class="stop-meta">${s.status === 'pending' ? `<span>${fmtClock(r.etas[id])}</span>` : ''}${stopMetaHTML(s, true)}</span></button>
        ${side}
      </li>`;
    }).join('');
  }

  function renderTop() {
    const r = state.route;
    const remaining = state.stops.filter((s) => s.status === 'pending').length;
    if (r) {
      const lf = liveFinish();
      $('topStats').innerHTML = `<span><b>${remaining}</b>restants</span><span><b>${fmtKm(r.distance)}</b></span><span class="top-end"><b>${fmtClock(lf.end)}</b>fin</span>`;
    } else {
      $('topStats').innerHTML = `<span><b>${state.stops.length}</b>arrêts</span>`;
    }
  }

  function renderSettings() {
    const st = state.settings;
    $('setStartNow').checked = !!st.startNow;
    $('setStartTime').value = st.startTime;
    $('setStartTime').disabled = !!st.startNow;
    $('setService').value = st.service;
    $('setOsrm').value = st.osrm;
    $('setAutoNav').checked = !!st.autoNav;
    for (const name of ['endMode', 'navApp', 'region']) {
      document.querySelectorAll(`input[name="${name}"]`).forEach((i) => { i.checked = i.value === st[name]; });
    }
    $('endWrap').hidden = st.endMode !== 'address';
    $('endChosen').innerHTML = st.endMode === 'address' ? (state.end ? `<strong>${esc(state.end.label)}</strong>` : 'Aucune adresse d\'arrivée.') : '';
  }

  function renderAll() {
    renderPlan(); renderRun(); renderTop(); renderMap(); save();
  }

  let currentView = 'plan';
  function switchView(v) {
    currentView = v;
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === v)));
    for (const name of ['plan', 'run', 'settings']) $(`view-${name}`).hidden = name !== v;
    if (map) setTimeout(() => map.resize(), 50);
    if (v === 'run') focusCurrent(true);
  }

  // ---------- Fiche d'un arrêt ----------
  let editingId = null;
  function openStopDialog(id) {
    const s = stopById(id); if (!s) return;
    editingId = id;
    const n = orderNumber(id);
    $('stopDialogTitle').textContent = n ? `Arrêt n° ${n}` : 'Arrêt';
    $('stopDialogAddr').textContent = s.label;
    $('fNote').value = s.note || '';
    $('fPackages').value = s.packages || 1;
    $('fService').value = s.service ?? '';
    $('fAfter').value = s.after || '';
    $('fBefore').value = s.before || '';
    $('fNav').textContent = `Y aller avec ${navName()}`;
    $('fNav').onclick = () => openNav(s);
    document.querySelectorAll('input[name="fGroup"]').forEach((i) => { i.checked = Number(i.value) === s.group; });
    $('stopDialog').showModal();
  }
  $('stopDialog').addEventListener('close', () => {
    const s = stopById(editingId); const v = $('stopDialog').returnValue;
    editingId = null;
    if (!s) return;
    if (v === 'delete') {
      const idx = state.stops.indexOf(s);
      state.stops.splice(idx, 1);
      const r = state.route;
      const pos = r ? r.order.indexOf(s.id) : -1;
      if (r && pos >= 0) { r.order.splice(pos, 1); r.geometry = null; recomputeEtas(); }
      renderAll();
      toast('Arrêt supprimé.', () => {
        state.stops.splice(idx, 0, s);
        if (r && state.route === r && pos >= 0) { r.order.splice(pos, 0, s.id); recomputeEtas(); }
        renderAll();
      });
    } else if (v === 'save') {
      const g = Number(document.querySelector('input[name="fGroup"]:checked').value);
      const constraintsChanged = g !== s.group || $('fAfter').value !== s.after || $('fBefore').value !== s.before;
      s.note = $('fNote').value.trim();
      s.packages = Math.max(1, Number($('fPackages').value) || 1);
      s.service = $('fService').value === '' ? null : Math.max(0, Number($('fService').value));
      s.after = $('fAfter').value; s.before = $('fBefore').value; s.group = g;
      s.check = false;
      recomputeEtas();
      renderAll();
      if (constraintsChanged && state.route) toast('Contraintes modifiées. Réoptimisez pour en tenir compte.');
    }
  });

  let failId = null;
  $('failDialog').addEventListener('close', () => {
    const v = $('failDialog').returnValue;
    const id = failId; failId = null;
    if (id && v && v !== 'cancel') mark(id, 'failed', v);
  });

  // ---------- Scan des photos (manifeste, étiquettes) ----------
  const scanQueue = []; // { id, name, file, thumb, status, progress, count, error }
  let ocrWorker = null;
  let ocrBusy = false;
  let ocrCurrent = null;
  let geocodingFound = false;

  function openScan() {
    renderScan();
    $('scanDialog').showModal();
  }
  async function getOcrWorker() {
    if (ocrWorker) return ocrWorker;
    if (!window.Tesseract) await loadScript(TESSERACT_URL);
    ocrWorker = await Tesseract.createWorker('fra', 1, {
      logger: (m) => {
        if (!ocrCurrent || m.status !== 'recognizing text') return;
        ocrCurrent.progress = Math.round(m.progress * 100);
        renderQueue();
      },
    });
    // mode « texte épars » : lit les cellules d'un tableau sans les mélanger
    await ocrWorker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
    return ocrWorker;
  }

  /** Redimensionne la photo, la passe en niveaux de gris et renforce le contraste. */
  async function prepareImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const w0 = img.naturalWidth, h0 = img.naturalHeight;
      const longSide = Math.max(w0, h0);
      const scale = longSide > 2600 ? 2600 / longSide : longSide < 1400 ? 1400 / longSide : 1;
      const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      const px = data.data;
      const hist = new Uint32Array(256);
      for (let i = 0; i < px.length; i += 4) {
        const g = ((px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000) | 0;
        px[i] = g; hist[g]++;
      }
      // étirement du contraste entre les 2 % de pixels les plus sombres et les 2 % les plus clairs
      const total = w * h;
      let lo = 0, hi = 255, acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
      acc = 0;
      for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
      const range = Math.max(30, hi - lo);
      for (let i = 0; i < px.length; i += 4) {
        const g = Math.max(0, Math.min(255, ((px[i] - lo) * 255) / range));
        px[i] = px[i + 1] = px[i + 2] = g;
      }
      ctx.putImageData(data, 0, 0);
      const out = deskew(c);
      const t = document.createElement('canvas');
      const ts = 96 / Math.max(w, h);
      t.width = Math.round(w * ts); t.height = Math.round(h * ts);
      t.getContext('2d').drawImage(out, 0, 0, t.width, t.height);
      return { canvas: out, thumb: t.toDataURL('image/jpeg', 0.7) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Redresse une photo penchée : la lecture échoue souvent au-delà de 2 ou 3 degrés. */
  function deskew(c) {
    const s = Math.min(1, 700 / Math.max(c.width, c.height));
    const sw = Math.max(1, Math.round(c.width * s)), sh = Math.max(1, Math.round(c.height * s));
    const small = document.createElement('canvas');
    small.width = sw; small.height = sh;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(c, 0, 0, sw, sh);
    const px = sctx.getImageData(0, 0, sw, sh).data;
    const gray = new Uint8ClampedArray(sw * sh);
    for (let i = 0; i < gray.length; i++) gray[i] = px[i * 4];
    const deg = Scan.estimateSkew(gray, sw, sh);
    if (Math.abs(deg) < 0.5) return c;
    const a = (-deg * Math.PI) / 180;
    const cos = Math.abs(Math.cos(a)), sin = Math.abs(Math.sin(a));
    const r = document.createElement('canvas');
    r.width = Math.round(c.width * cos + c.height * sin);
    r.height = Math.round(c.width * sin + c.height * cos);
    const rctx = r.getContext('2d');
    rctx.fillStyle = '#fff';
    rctx.fillRect(0, 0, r.width, r.height);
    rctx.translate(r.width / 2, r.height / 2);
    rctx.rotate(a);
    rctx.drawImage(c, -c.width / 2, -c.height / 2);
    return r;
  }

  const addrKey = (a) => String(a).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function addFound(list, source) {
    const known = new Set(state.found.map((f) => addrKey(f.address)));
    const existing = new Set(state.stops.map((s) => addrKey(s.label)));
    let added = 0;
    for (const r of list) {
      const k = addrKey(r.address);
      if (!k || known.has(k)) continue;
      known.add(k);
      const dup = existing.has(k);
      state.found.push({ id: uid(), address: r.address, note: r.note || '', packages: r.packages || 1, sure: !!r.sure, checked: !dup, source, error: dup ? 'Déjà dans la tournée' : '' });
      added++;
    }
    save();
    return added;
  }

  async function processQueue() {
    if (ocrBusy) return;
    ocrBusy = true;
    try {
      let item;
      while ((item = scanQueue.find((q) => q.status === 'waiting'))) {
        ocrCurrent = item;
        item.status = 'prep';
        renderQueue();
        try {
          const { canvas, thumb } = await prepareImage(item.file);
          item.thumb = thumb;
          item.file = null; // libère la mémoire
          const worker = await getOcrWorker();
          item.status = 'reading'; item.progress = 0;
          renderQueue();
          const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
          const words = [], lines = [];
          for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) { lines.push(l); words.push(...(l.words || [])); }
          let found = Scan.extractAddresses(Scan.rowsFromWords(words, lines));
          if (!found.length) found = Scan.extractAddresses(data.text || '');
          item.count = addFound(found, item.name);
          item.status = 'done';
        } catch (e) {
          console.error(e);
          item.status = 'error';
          item.error = /Chargement impossible|fetch|network/i.test(String(e)) ? 'Lecture impossible : il faut une connexion la première fois.' : 'Photo illisible. Reprenez-la plus près et bien à plat.';
        }
        ocrCurrent = null;
        renderScan();
      }
    } finally {
      ocrBusy = false;
    }
  }

  function queueFiles(files) {
    const list = Array.from(files || []).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|heic|webp)$/i.test(f.name));
    if (!list.length) return;
    for (const f of list) scanQueue.push({ id: uid(), name: `Photo ${scanQueue.length + 1}`, file: f, status: 'waiting', progress: 0, count: 0 });
    $('scanResult').hidden = true;
    renderScan();
    processQueue();
  }

  function renderQueue() {
    $('scanQueue').innerHTML = scanQueue.map((q) => {
      let txt = { waiting: 'En attente', prep: 'Préparation…' }[q.status] || '';
      if (q.status === 'reading') txt = `Lecture ${q.progress || 0} %`;
      if (q.status === 'done') txt = q.count ? `${plural(q.count, 'adresse')} trouvée${q.count > 1 ? 's' : ''}` : 'Aucune nouvelle adresse';
      if (q.status === 'error') txt = q.error;
      return `<li class="q-item q-${q.status}">${q.thumb ? `<img src="${q.thumb}" alt="">` : '<span class="q-ph"></span>'}<span><b>${esc(q.name)}</b><br>${esc(txt)}</span></li>`;
    }).join('');
    const busy = scanQueue.filter((q) => ['waiting', 'prep', 'reading'].includes(q.status)).length;
    if (!geocodingFound) $('scanBusy').textContent = busy ? `${plural(busy, 'photo')} en lecture. Continuez à photographier si besoin.` : '';
  }
  function renderFound() {
    const f = state.found;
    const checked = f.filter((x) => x.checked).length;
    $('foundTitle').textContent = f.length ? `Adresses trouvées (${f.length})` : 'Adresses trouvées';
    $('foundEmpty').hidden = f.length > 0;
    $('foundList').innerHTML = f.map((x) => `
      <li class="found ${x.error ? 'has-error' : ''}" data-fid="${x.id}">
        <input type="checkbox" class="f-check" aria-label="Garder cette adresse" ${x.checked ? 'checked' : ''}>
        <div class="f-body">
          <input type="text" class="f-addr" value="${esc(x.address)}" aria-label="Adresse" autocomplete="off">
          <div class="f-meta">${x.packages > 1 ? `<span class="pill">${x.packages} colis</span>` : ''}${!x.sure ? '<span class="pill window">À vérifier</span>' : ''}${x.error ? `<span class="pill late">${esc(x.error)}</span>` : ''}${x.note ? `<span class="meta-note">${esc(x.note)}</span>` : ''}</div>
        </div>
        <button type="button" class="f-del" aria-label="Retirer cette adresse">✕</button>
      </li>`).join('');
    $('scanAdd').textContent = checked ? `Ajouter ${plural(checked, 'arrêt')}` : 'Ajouter';
    $('scanAdd').disabled = !checked || geocodingFound;
    $('scanClearFound').hidden = !f.length;
  }
  function renderScan() { renderQueue(); renderFound(); }

  $('foundList').addEventListener('change', (e) => {
    const li = e.target.closest('[data-fid]'); if (!li) return;
    const x = state.found.find((f) => f.id === li.dataset.fid); if (!x) return;
    if (e.target.classList.contains('f-check')) x.checked = e.target.checked;
    if (e.target.classList.contains('f-addr')) { x.address = e.target.value.trim(); x.error = ''; x.sure = true; x.checked = true; }
    save(); renderFound();
  });
  $('foundList').addEventListener('click', (e) => {
    if (!e.target.classList.contains('f-del')) return;
    const li = e.target.closest('[data-fid]');
    state.found = state.found.filter((f) => f.id !== li.dataset.fid);
    save(); renderFound();
  });

  async function addFoundToTour() {
    const todo = state.found.filter((f) => f.checked && f.address);
    if (!todo.length || geocodingFound) return;
    geocodingFound = true;
    renderFound();
    let ok = 0, k = 0;
    const worker = async () => {
      while (k < todo.length) {
        const f = todo[k++];
        $('scanBusy').textContent = `Localisation des adresses ${Math.min(k, todo.length)}/${todo.length}…`;
        try {
          const res = await geoSearch(f.address, 1);
          const g = res[0];
          if (!g) { f.error = 'Introuvable : corrigez l\'adresse'; continue; }
          const weak = (g.score != null && g.score < 0.5) || (g.type && g.type !== 'housenumber' && /^\s*\d/.test(f.address));
          addStop(g, { note: f.note, packages: f.packages, check: weak || !f.sure, silent: true });
          f.added = true; f.error = ''; ok++;
        } catch (e) {
          f.error = 'Recherche impossible : vérifiez la connexion';
        }
      }
    };
    try {
      await Promise.all([worker(), worker(), worker(), worker()]);
    } finally {
      state.found = state.found.filter((f) => !f.added);
      geocodingFound = false;
      renderAll();
      renderScan();
      $('scanBusy').textContent = '';
    }
    const left = state.found.filter((f) => f.checked).length;
    $('scanResult').hidden = !ok;
    $('scanResultText').textContent = `${plural(ok, 'arrêt')} ajouté${ok > 1 ? 's' : ''}${left ? `. Corrigez ${left === 1 ? 'l\'adresse restante' : `les ${left} adresses restantes`} ci-dessus.` : '.'}`;
  }

  $('scanOpen').addEventListener('click', openScan);
  $('camInput').addEventListener('change', (e) => { queueFiles(e.target.files); e.target.value = ''; });
  $('libInput').addEventListener('change', (e) => { queueFiles(e.target.files); e.target.value = ''; });
  $('pasteToggle').addEventListener('click', () => { $('pasteWrap').hidden = !$('pasteWrap').hidden; if (!$('pasteWrap').hidden) $('pasteText').focus(); });
  $('pasteGo').addEventListener('click', () => {
    const n = addFound(Scan.parsePasted($('pasteText').value), 'Texte collé');
    $('pasteText').value = '';
    $('pasteWrap').hidden = true;
    renderFound();
    toast(n ? `${plural(n, 'adresse')} trouvée${n > 1 ? 's' : ''}` : 'Aucune nouvelle adresse dans ce texte.');
  });
  $('scanAdd').addEventListener('click', addFoundToTour);
  $('scanClearFound').addEventListener('click', () => { state.found = []; save(); renderFound(); });
  $('scanOptimize').addEventListener('click', () => {
    $('scanDialog').close();
    $('scanResult').hidden = true;
    if (state.stops.some((s) => s.status !== 'pending')) reoptimizeRemaining(); else optimize();
  });
  $('scanClose').addEventListener('click', () => $('scanDialog').close());

  // ---------- Événements ----------
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  attachSearch($('startInput'), $('startSuggest'), setStart);
  attachSearch($('stopInput'), $('stopSuggest'), (it) => { addStop(it); $('stopInput').value = ''; });
  attachSearch($('endInput'), $('endSuggest'), (it) => { state.end = { label: it.label, lat: it.lat, lon: it.lon }; $('endInput').value = ''; state.route = null; renderSettings(); renderAll(); });

  function locate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Géolocalisation indisponible'));
      navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }), reject, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
    });
  }
  $('startGps').addEventListener('click', async () => {
    try {
      const p = await locate();
      setStart({ label: await geoReverse(p.lat, p.lon), lat: p.lat, lon: p.lon });
    } catch (e) { toast('Position introuvable. Autorisez la localisation ou saisissez l\'adresse.'); }
  });
  $('reoptHere').addEventListener('click', async () => {
    let p;
    try { p = await locate(); } catch (e) { toast('Position introuvable. Autorisez la localisation.'); return; }
    await optimize({ label: 'Ma position', lat: p.lat, lon: p.lon });
  });

  $('optimizeBtn').addEventListener('click', () => (state.stops.some((s) => s.status !== 'pending') ? reoptimizeRemaining() : optimize()));
  $('clearAll').addEventListener('click', () => {
    const backup = JSON.stringify(state);
    state.stops = []; state.route = null;
    renderAll();
    toast('Arrêts effacés.', () => { state = JSON.parse(backup); renderAll(); });
  });
  $('btn3d').addEventListener('click', () => { state.settings.map3d = !state.settings.map3d; save(); apply3D(true); });
  $('btnFit').addEventListener('click', () => { lastFocusId = null; fitAll(); });

  document.addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { openStopDialog(ed.dataset.edit); return; }
    const mv = e.target.closest('[data-move]');
    if (mv) { moveInRoute(mv.dataset.id, Number(mv.dataset.move)); return; }
    const go = e.target.closest('[data-go]');
    if (go) { switchView(go.dataset.go); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const id = a.dataset.id;
    const act = a.dataset.act;
    if (act === 'done') mark(id, 'done');
    else if (act === 'nav') { const s = stopById(id); if (s) openNav(s); }
    else if (act === 'fail') { failId = id; $('failDialog').showModal(); }
    else if (act === 'skip') skip(id);
    else if (act === 'reopt') reoptimizeRemaining();
    else if (act === 'reset') { const s = stopById(id); if (s) { s.status = 'pending'; s.failReason = ''; s.doneAt = null; lastFocusId = null; renderAll(); } }
  });

  // Réglages
  $('setStartNow').addEventListener('change', (e) => { state.settings.startNow = e.target.checked; renderSettings(); save(); });
  $('setStartTime').addEventListener('change', (e) => { state.settings.startTime = e.target.value || '08:00'; save(); });
  $('setService').addEventListener('change', (e) => { state.settings.service = Math.max(0, Number(e.target.value) || 0); recomputeEtas(); renderAll(); });
  $('setOsrm').addEventListener('change', (e) => { state.settings.osrm = e.target.value.trim() || DEFAULT_SETTINGS.osrm; save(); });
  $('setAutoNav').addEventListener('change', (e) => { state.settings.autoNav = e.target.checked; save(); });
  document.querySelectorAll('input[name="endMode"], input[name="navApp"], input[name="region"]').forEach((i) => i.addEventListener('change', () => {
    state.settings[i.name] = i.value;
    if (i.name === 'endMode') state.route = null;
    renderSettings(); renderAll();
  }));

  // Export CSV (partage natif sur iPhone : Fichiers, Mail, WhatsApp…)
  $('exportCsv').addEventListener('click', async () => {
    const r = state.route;
    const order = r ? [...r.order, ...state.stops.filter((s) => !r.order.includes(s.id)).map((s) => s.id)] : state.stops.map((s) => s.id);
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Ordre', 'Adresse', 'Statut', 'Motif', 'Heure prévue', 'Heure réelle', 'Colis', 'Note', 'Latitude', 'Longitude']];
    order.forEach((id, k) => {
      const s = stopById(id); if (!s) return;
      const real = s.doneAt ? new Date(s.doneAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
      const st = { pending: 'À livrer', done: 'Livré', failed: 'Échec' }[s.status];
      rows.push([k + 1, s.label, st, s.failReason, r ? fmtClock(r.etas[id]) : '', real, s.packages, s.note, s.lat, s.lon]);
    });
    const csv = '﻿' + rows.map((row) => row.map(q).join(';')).join('\r\n');
    const name = `tournee-${new Date().toISOString().slice(0, 10)}.csv`;
    const file = new File([csv], name, { type: 'text/csv' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Bilan de tournée' }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  });

  // Tournée d'exemple (lieux réels de Lyon, coordonnées approximatives)
  $('loadDemo').addEventListener('click', () => {
    const demo = [
      ['Place Bellecour, 69002 Lyon', 45.7578, 4.8320],
      ['12 Rue Mercière, 69002 Lyon', 45.7622, 4.8318],
      ['Place des Terreaux, 69001 Lyon', 45.7673, 4.8336],
      ['Gare de Lyon-Part-Dieu, 69003 Lyon', 45.7606, 4.8596],
      ['Parc de la Tête d\'Or, 69006 Lyon', 45.7772, 4.8556],
      ['Place Jean Macé, 69007 Lyon', 45.7457, 4.8424],
      ['Musée des Confluences, 69002 Lyon', 45.7326, 4.8180],
      ['Boulevard de la Croix-Rousse, 69004 Lyon', 45.7746, 4.8306],
      ['Avenue Jean Jaurès, 69007 Lyon', 45.7489, 4.8434],
      ['Cours Lafayette, 69003 Lyon', 45.7638, 4.8521],
      ['Place Guichard, 69003 Lyon', 45.7594, 4.8469],
      ['Rue de la République, 69002 Lyon', 45.7625, 4.8357],
    ];
    state.start = { label: 'Dépôt (exemple), Gerland, 69007 Lyon', lat: 45.7316, lon: 4.8320 };
    state.stops = demo.map(([label, lat, lon]) => newStop({ label, lat, lon }));
    state.stops[3].note = 'Exemple : point relais, demander l\'accueil';
    state.stops[3].packages = 4;
    state.stops[6].group = 2;
    state.route = null; lastBoundsKey = '';
    renderSettings(); renderAll();
    switchView('plan');
    toast('Tournée d\'exemple chargée. Touchez Optimiser.');
  });

  // Heure de fin rafraîchie toutes les 30 s et au retour dans l'app (après Waze)
  setInterval(() => { if (state.route) { renderTop(); if (currentView === 'run') renderRun(); } }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.route) { renderTop(); renderRun(); } });

  // ---------- Démarrage ----------
  initMap();
  renderSettings();
  renderAll();
  apply3D(false);
  if (state.route) switchView('run');
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.CapColis = { get state() { return state; }, optimize, queueFiles };
})();

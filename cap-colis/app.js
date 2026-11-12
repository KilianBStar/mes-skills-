/* Kilivre : logique de l'application (sans framework). */
(function () {
  'use strict';

  // ---------- État & persistance ----------
  const STORE_KEY = 'cap-colis-v1';
  const SETTINGS_VERSION = 4;
  const DEFAULT_SETTINGS = {
    v: SETTINGS_VERSION, startNow: true, startTime: '08:00', service: 1, endMode: 'start', navApp: 'cap',
    autoNav: true, radars: true, region: 'auto', osrm: 'https://router.project-osrm.org', map3d: true,
  };
  const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  const MAP_STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
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
        if ((old.v || 1) < 2) { s.settings.service = 1; s.settings.navApp = 'waze'; }
        if ((old.v || 1) < 3) s.settings.region = 'auto';
        if ((old.v || 1) < 4) s.settings.navApp = 'cap'; // GPS intégré demandé
        s.settings.v = SETTINGS_VERSION;
        s.found = Array.isArray(s.found) ? s.found : [];
        s.seq = s.seq || 0;
        s.history = Array.isArray(s.history) ? s.history : [];
        s.tourId = s.tourId || Math.random().toString(36).slice(2, 10);
        s.tourDate = s.tourDate || todayISO();
        for (const st of s.stops) if (!st.seq) st.seq = ++s.seq;
        return s;
      }
    } catch (e) { /* stockage indisponible */ }
    return { settings: Object.assign({}, DEFAULT_SETTINGS), start: null, end: null, stops: [], route: null, found: [], seq: 0, history: [], tourId: Math.random().toString(36).slice(2, 10), tourDate: todayISO() };
  }
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  /** Copie légère de la tournée courante pour l'historique (sans matrice ni tracé). */
  function tourSnapshot() {
    const r = state.route;
    return {
      id: state.tourId, date: state.tourDate, updatedAt: Date.now(), start: state.start, end: state.end, seq: state.seq,
      stops: state.stops,
      route: r ? { order: r.order, etas: r.etas, startTime: r.startTime, duration: r.duration, distance: r.distance, late: r.late, end: r.end, source: r.source, start: r.start, endPt: r.endPt } : null,
    };
  }
  function syncHistory() {
    const i = state.history.findIndex((h) => h.id === state.tourId);
    if (!state.stops.length) { if (i >= 0) state.history.splice(i, 1); return; }
    const snap = tourSnapshot();
    if (i >= 0) state.history[i] = snap; else state.history.unshift(snap);
    state.history.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.updatedAt - a.updatedAt));
    state.history = state.history.slice(0, 90); // environ 3 mois de tournées
  }
  function save() {
    try { syncHistory(); } catch (e) { /* historique ignoré */ }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) {
      // stockage plein : on allège l'historique et on réessaie
      try { state.history = state.history.slice(0, 20); localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e2) { /* tant pis */ }
    }
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

  // ---------- Animations (GSAP) : retours visuels aux gestes, rien de décoratif ----------
  const anim = {
    on: () => !!window.gsap && !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    /** Ouverture : la pastille arrive, la coche se dessine, l'écran s'efface (moins d'une seconde). */
    splash() {
      if (!anim.on()) return;
      const el = document.createElement('div');
      el.className = 'splash';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = `<div class="splash-in"><svg viewBox="0 0 256 256"><path class="pill" d="${'M68 44H188A28 28 0 0 1 216 72V156A28 28 0 0 1 188 184H148L128 214 108 184H68A28 28 0 0 1 40 156V72A28 28 0 0 1 68 44Z'}"/><path class="tick" d="M93 105 121 133 171 83"/></svg><div class="splash-name">Kilivre</div></div>`;
      document.body.appendChild(el);
      const tick = el.querySelector('.tick');
      const len = tick.getTotalLength();
      gsap.set(tick, { strokeDasharray: len, strokeDashoffset: len });
      gsap.timeline({ onComplete: () => el.remove() })
        .from(el.querySelector('svg'), { scale: 0.6, autoAlpha: 0, duration: 0.35, ease: 'back.out(2)', transformOrigin: '50% 50%' })
        .to(tick, { strokeDashoffset: 0, duration: 0.3, ease: 'power2.out' }, '-=0.05')
        .from(el.querySelector('.splash-name'), { y: 10, autoAlpha: 0, duration: 0.25 }, '<')
        .to(el, { autoAlpha: 0, duration: 0.3, ease: 'power1.in' }, '+=0.15');
      // filet de sécurité : l'écran d'ouverture ne bloque jamais l'app
      setTimeout(() => el.remove(), 2500);
    },
    /** Livré / Échec : grand tampon au centre, puis la fiche suivante glisse en place. */
    stamp(ok) {
      if (!anim.on()) return;
      const el = document.createElement('div');
      el.className = `stamp${ok ? '' : ' no'}`;
      el.innerHTML = ok ? '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>';
      document.body.appendChild(el);
      const path = el.querySelector('path');
      const len = path.getTotalLength();
      gsap.set(path, { strokeDasharray: len, strokeDashoffset: len });
      gsap.timeline({ onComplete: () => el.remove() })
        .from(el, { scale: 0.4, autoAlpha: 0, duration: 0.25, ease: 'back.out(2.2)' })
        .to(path, { strokeDashoffset: 0, duration: 0.25, ease: 'power2.out' }, '-=0.05')
        .to(el, { scale: 1.15, autoAlpha: 0, duration: 0.25, ease: 'power1.in' }, '+=0.25');
      if (navigator.vibrate) navigator.vibrate(ok ? 40 : [60, 40, 60]);
    },
    nextCard() {
      if (!anim.on()) return;
      const c = document.querySelector('#currentCard .card');
      if (c) gsap.from(c, { x: 48, autoAlpha: 0, duration: 0.35, delay: 0.2, ease: 'power2.out', clearProps: 'transform,visibility,opacity' });
    },
    /** Lignes de la tournée qui arrivent dans l'ordre de passage (après une optimisation). */
    rows() {
      if (!anim.on()) return;
      const rows = [...document.querySelectorAll('#runList .row')].slice(0, 14); // seules les lignes visibles
      if (rows.length) gsap.from(rows, { x: -18, autoAlpha: 0, duration: 0.3, stagger: 0.035, ease: 'power2.out', clearProps: 'transform,visibility,opacity' });
    },
    /** GPS : la nouvelle consigne glisse depuis le haut. */
    maneuver() {
      if (!anim.on()) return;
      gsap.fromTo(['#navArrow', '#navTop .nav-txt'], { y: -14, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.3, stagger: 0.05, ease: 'power2.out', overwrite: true });
    },
    radar(el) {
      if (!anim.on()) return;
      gsap.fromTo(el, { scale: 0.6, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.35, ease: 'back.out(2.2)', overwrite: true });
    },
  };

  // ---------- Géocodage ----------
  function biasParams() {
    const p = state.start || state.stops[state.stops.length - 1];
    return p ? `&lat=${p.lat}&lon=${p.lon}` : '';
  }
  function photonLabel(p) {
    // Belgique et Pays-Bas : le numéro suit la rue (« Rue de la Vallée 2 »)
    const after = ['BE', 'NL', 'DE', 'LU'].includes(p.countrycode);
    const street = (after ? [p.street, p.housenumber] : [p.housenumber, p.street]).filter(Boolean).join(' ');
    const first = p.name && p.name !== p.street ? p.name : street;
    const parts = [first, first === street ? '' : street, [p.postcode, p.city || p.district].filter(Boolean).join(' '), p.countrycode && !['FR', 'BE'].includes(p.countrycode) ? p.country : ''];
    return parts.filter(Boolean).join(', ');
  }
  // Belgique : emprise pour limiter la recherche OpenStreetMap
  const BE_BBOX = '2.38,49.45,6.45,51.56';
  function countryFor(q) {
    const r = state.settings.region;
    if (r === 'fr') return 'FR';
    if (r === 'be') return 'BE';
    if (r === 'world') return '';
    return Scan.guessCountry(q) || (state.start && inBelgium(state.start) ? 'BE' : '');
  }
  function inBelgium(p) {
    return p.lat > 49.45 && p.lat < 51.56 && p.lon > 2.38 && p.lon < 6.45 && !(p.lat < 50.1 && p.lon < 4.1) && !(p.lat < 51.1 && p.lon < 2.55);
  }
  async function photon(q, limit, bbox) {
    const r = await fetchJSON(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit}&lang=fr${biasParams()}${bbox ? `&bbox=${bbox}` : ''}`);
    return (r.features || []).map((f) => ({
      label: photonLabel(f.properties), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
      type: f.properties.housenumber ? 'housenumber' : 'street',
    }));
  }
  async function geoSearch(q, limit = 5) {
    const country = countryFor(q);
    if (country === 'FR' || (country === '' && state.settings.region === 'fr')) {
      try {
        const r = await fetchJSON(`https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(q)}&limit=${limit}&autocomplete=1${biasParams()}`);
        const out = (r.features || []).map((f) => ({ label: f.properties.label, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], score: f.properties.score, type: f.properties.type }));
        if (out.length) return out;
      } catch (e) { /* on passe à Photon */ }
    }
    if (country === 'BE') {
      let out = await photon(q, limit, BE_BBOX);
      // OCR approximatif : on réessaie sans le numéro de boîte ni la ponctuation
      if (!out.length) out = await photon(q.replace(/\/\S+/g, '').replace(/[,;]/g, ' '), limit, BE_BBOX);
      return out;
    }
    try {
      return await photon(q, limit, '');
    } catch (e) {
      if (country) throw e;
      // sans indice de pays : dernier recours, la base d'adresses française
      const r = await fetchJSON(`https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(q)}&limit=${limit}&autocomplete=1${biasParams()}`);
      return (r.features || []).map((f) => ({ label: f.properties.label, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], score: f.properties.score, type: f.properties.type }));
    }
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
    const wantDark = window.matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
    let styleUrl = wantDark ? MAP_STYLE_DARK : MAP_STYLE;
    try {
      map = new maplibregl.Map({
        container: 'map', style: styleUrl, center: [4.44, 50.41], zoom: 10,
        pitch: 0, maxPitch: 70, attributionControl: { compact: true },
      });
    } catch (e) {
      mapUnavailable('Cet appareil ne peut pas afficher la carte 3D.');
      return;
    }
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
    map.on('style.load', () => {
      if (styleReady) return;
      styleReady = true;
      setupBuildings();
      setupRouteLayers();
      apply3D(false);
      renderMap();
    });
    // carte sombre absente : carte claire, couleurs inversées
    map.on('error', () => {
      if (!styleReady && styleUrl === MAP_STYLE_DARK) {
        styleUrl = MAP_STYLE;
        $('app').classList.add('map-invert');
        map.setStyle(MAP_STYLE);
      }
    });
    map.on('error', (e) => { if (!styleReady) console.warn('Carte :', e && e.error && e.error.message); });
    map.on('click', (e) => { if (!nav.active) onMapClick(e); });
    map.on('dragstart', () => { if (nav.active) { nav.follow = false; $('navRecenter').hidden = false; } });
  }
  function mapUnavailable(msg) {
    $('map').innerHTML = `<div class="map-fallback">${esc(msg)}</div>`;
  }
  function setupBuildings() {
    const layers = map.getStyle().layers || [];
    buildingLayers = layers.filter((l) => l.type === 'fill-extrusion').map((l) => l.id);
    if (!buildingLayers.length && map.getSource('openmaptiles')) {
      map.addLayer({
        id: 'cc-buildings-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
        paint: {
          'fill-extrusion-color': window.matchMedia('(prefers-color-scheme: dark)').matches ? '#3a4150' : '#d9d2c6',
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
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout, filter: ['!=', ['get', 'dashed'], true], paint: { 'line-color': '#3B7BEA', 'line-width': 5 } });
    map.addLayer({ id: 'route-dashed', type: 'line', source: 'route', layout, filter: ['==', ['get', 'dashed'], true], paint: { 'line-color': '#3B7BEA', 'line-width': 4, 'line-dasharray': [1.5, 1.5] } });
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

  const FLAG_SVG = '<svg viewBox="0 0 24 24"><path d="M6 21V4m0 0h11l-2 4 2 4H6"/></svg>';
  const HOME_SVG = '<svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7M6 9.5V20h12V9.5"/></svg>';
  function markerEl(text, cls, onClick) {
    const el = document.createElement('div');
    el.className = `mk ${cls}`;
    if (cls === 'flag') el.innerHTML = FLAG_SVG;
    else if (cls === 'depot') el.innerHTML = HOME_SVG;
    else el.textContent = text;
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
      markers.push(new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -7] }).setLngLat([p.lon, p.lat]).addTo(map));
      pts.push([p.lon, p.lat]);
    };
    const endFlag = state.settings.endMode === 'address' ? state.end : state.settings.endMode === 'start' ? state.start : null;
    if (state.start && endFlag !== state.start) add(state.start, markerEl('', 'depot'), `Départ : ${state.start.label}`);
    if (endFlag) add(endFlag, markerEl('', 'flag'), endFlag === state.start ? `Départ et arrivée : ${state.start.label}` : `Arrivée : ${endFlag.label}`);
    const cur = currentStop();
    for (const s of state.stops) {
      const n = orderNumber(s.id);
      const cls = s.status === 'done' ? 'done' : s.status === 'failed' ? 'failed' : cur && cur.id === s.id ? 'cur' : n ? '' : 'unordered';
      add(s, markerEl(s.status === 'done' ? '✓' : n || '•', cls, () => openStopDialog(s.id)), s.label);
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
    if (pts.length === 1) { map.easeTo({ center: pts[0], zoom: 15, pitch: state.settings.map3d ? 55 : 0, padding: mapPadding() }); return; }
    const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.fitBounds(b, { padding: mapPadding(), maxZoom: 16, pitch: state.settings.map3d ? 45 : 0, duration: 600 });
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
    map.easeTo({ center: [cur.lon, cur.lat], zoom: 16.5, pitch: state.settings.map3d ? 60 : 0, bearing, duration: 900, padding: mapPadding() });
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
      id: uid(), seq: (state.seq = (state.seq || 0) + 1), label: p.label, lat: p.lat, lon: p.lon, note: extra.note || '', packages: extra.packages || 1, group: 1,
      after: '', before: '', service: null, status: 'pending', check: !!extra.check,
    };
  }
  function addStop(p, extra = {}) {
    const dup = state.stops.some((s) => Math.abs(s.lat - p.lat) < 1e-6 && Math.abs(s.lon - p.lon) < 1e-6);
    const s = newStop(p, extra);
    state.stops.push(s);
    const pos = state.route ? insertIntoRoute(s) : null;
    if (!extra.silent) {
      renderAll();
      toast(dup ? 'Ajouté. Attention : cette adresse figure déjà dans la liste.' : pos ? `Arrêt ajouté en n° ${pos} de la tournée` : `Arrêt ajouté (${state.stops.length})`);
      if (pos) rebuildMatrix();
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
      anim.rows();
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
    if (state.settings.navApp === 'cap') { startNav(s); return; }
    const url = navUrl(s);
    if (/^https?:/.test(url)) {
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    } else {
      window.location.href = url; // ouvre l'application (Waze, Google Maps)
      // Si l'app n'est pas installée, l'iPhone reste sur Kilivre : on passe par le lien web.
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
  function navLabel() { return state.settings.navApp === 'cap' ? 'Démarrer le guidage' : `Y aller avec ${navName()}`; }
  function navName() {
    return { cap: 'le GPS', waze: 'Waze', google: 'Google Maps', apple: 'Plans' }[state.settings.navApp] || 'le GPS';
  }

  function mark(id, status, reason) {
    const s = stopById(id); if (!s) return;
    const prev = { status: s.status, failReason: s.failReason, doneAt: s.doneAt };
    s.status = status; s.failReason = reason || ''; s.doneAt = Date.now();
    anim.stamp(status === 'done');
    renderAll();
    anim.nextCard();
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
  function stopMetaHTML(s, withEta, compact) {
    const bits = [];
    if (s.packages > 1) bits.push(`<span class="pill">${s.packages} colis</span>`);
    if (s.check) bits.push('<span class="pill window">Adresse à vérifier</span>');
    if (s.group === 0) bits.push('<span class="pill first">En premier</span>');
    if (s.group === 2) bits.push('<span class="pill last">En dernier</span>');
    if (s.after || s.before) bits.push(`<span class="pill window">${s.after ? 'après ' + s.after : ''}${s.after && s.before ? ' · ' : ''}${s.before ? 'avant ' + s.before : ''}</span>`);
    const eta = withEta && state.route ? state.route.etas[s.id] : null;
    if (eta != null && s.before && eta > toSec(s.before) && s.status === 'pending') bits.push('<span class="pill late">En retard</span>');
    if (s.status === 'failed') bits.push(`<span class="pill late">${esc(s.failReason || 'Échec')}</span>`);
    if (s.status === 'done' && !compact) bits.push('<span class="pill ok">Livré</span>');
    if (s.note) bits.push(`<span class="meta-note">${esc(s.note)}</span>`);
    return bits.join('');
  }

  /** « Rue du Moulin 100, 6061 Charleroi » → rue « Rue du Moulin 100 », ville « Charleroi, 6061 ». */
  function splitLabel(label) {
    const s = String(label || '');
    let street = s, rest = '';
    const comma = s.indexOf(',');
    if (comma > 0) { street = s.slice(0, comma); rest = s.slice(comma + 1).trim(); }
    else {
      const m = s.match(/^(.*?\D)\s+(\d{4,5}\s+[A-Za-zÀ-ÿ].*)$/);
      if (m) { street = m[1]; rest = m[2]; }
    }
    const cm = rest.match(/^(\d{4,5})\s+(.+)$/);
    const city = cm ? `${cm[2]}, ${cm[1]}` : rest;
    return { street: street.trim(), city };
  }
  let listQuery = '';
  function matchesQuery(s) {
    if (!listQuery) return true;
    const n = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return n(`${s.label} ${s.note} ${s.seq}`).includes(n(listQuery));
  }
  const TICK = '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const CROSS = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>';
  function rowHTML(s, num, opts = {}) {
    const r = state.route;
    const { street, city } = splitLabel(s.label);
    const eta = r && r.etas[s.id] != null ? fmtClock(r.etas[s.id]) : '';
    const meta = stopMetaHTML(s, true, true);
    const badge = `<span class="id-badge">ID <b>${s.seq || ''}</b>${s.status === 'done' ? `<span class="tick">${TICK}</span>` : s.status === 'failed' ? `<span class="tick no">${CROSS}</span>` : ''}</span>`;
    const right = opts.move
      ? `<div class="move"><button type="button" aria-label="Monter" data-move="-1" data-id="${s.id}">▲</button><button type="button" aria-label="Descendre" data-move="1" data-id="${s.id}">▼</button></div>`
      : opts.reset ? `<button class="btn link" type="button" data-act="reset" data-id="${s.id}">Rétablir</button>` : '';
    return `<li class="row ${opts.current ? 'is-current' : ''} ${s.status !== 'pending' ? 'is-done' : ''}">
      <div class="row-left"><span class="row-num">${num || '•'}</span>${eta ? `<span class="row-eta">${eta}</span>` : ''}</div>
      <button type="button" class="row-main" data-edit="${s.id}"><span class="row-street">${esc(street)}</span>${city ? `<span class="row-city">${esc(city)}</span>` : ''}<span class="row-meta">${meta}</span></button>
      <div class="row-right">${badge}${right}</div>
    </li>`;
  }

  function renderPlan() {
    $('startChosen').innerHTML = state.start ? `<strong>${esc(state.start.label)}</strong>` : 'Aucun départ. Saisissez une adresse ou touchez ◎.';
    const ordered = state.route
      ? [...state.route.order.map(stopById).filter(Boolean), ...state.stops.filter((s) => !state.route.order.includes(s.id))]
      : state.stops;
    const totalPk = state.stops.reduce((a, s) => a + (Number(s.packages) || 1), 0);
    $('stopsTitle').textContent = state.stops.length ? `${plural(state.stops.length, 'arrêt')} · ${totalPk} colis` : 'Arrêts';
    $('stopsEmpty').hidden = state.stops.length > 0;
    $('stopsHead').hidden = state.stops.length === 0;
    $('clearAll').hidden = state.stops.length === 0;
    $('stopList').innerHTML = ordered.filter(matchesQuery).map((s) => rowHTML(s, orderNumber(s.id))).join('');
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
      $('finishBar').hidden = true;
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
      const nextHint = state.settings.autoNav && nx ? `<small>puis ${state.settings.navApp === 'cap' ? 'guidage' : esc(navName())} vers le n° ${orderNumber(nx.id)}</small>` : '';
      card.innerHTML = `<div class="card">
        <div class="card-top"><span class="num">${n}</span>
          <div class="card-text"><div class="card-addr">${esc(splitLabel(cur.label).street)}</div><div class="card-sub">${esc(splitLabel(cur.label).city)}</div>
          <div class="card-sub">Arrivée prévue ${fmtClock(eta)} · ${cur.packages} colis${cur.before ? ' · avant ' + cur.before : ''}${cur.after ? ' · après ' + cur.after : ''}</div></div></div>
        ${cur.note ? `<div class="card-note">${esc(cur.note)}</div>` : ''}
        ${cur.check ? '<div class="card-note">Adresse lue sur photo : vérifiez-la sur place.</div>' : ''}
        <div class="card-actions">
          <button class="btn primary nav" type="button" data-act="nav" data-id="${cur.id}">${navLabel()}</button>
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
      const s = stopById(id);
      if (!s || !matchesQuery(s)) return '';
      const isCur = cur && cur.id === id;
      return rowHTML(s, k + 1, { current: isCur, move: s.status === 'pending' && !isCur, reset: s.status !== 'pending' });
    }).join('');
    $('finishBar').hidden = currentView !== 'run';
  }

  function renderTop() {
    const r = state.route;
    const remaining = state.stops.filter((s) => s.status === 'pending').length;
    if (r) {
      const lf = liveFinish();
      $('topStats').innerHTML = remaining
        ? `<b>${plural(remaining, 'arrêt')}</b> à faire · fin <b>${fmtClock(lf.end)}</b> · ${fmtKm(r.distance)}`
        : '<b>0 arrêt</b> à faire';
    } else {
      $('topStats').innerHTML = state.stops.length ? `<b>${plural(state.stops.length, 'arrêt')}</b> à optimiser` : '<b>0 arrêt</b>';
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
    $('setRadars').checked = st.radars !== false;
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
    for (const name of ['plan', 'run', 'settings']) $(`view-${name}`).hidden = name !== v;
    $('finishBar').hidden = !(v === 'run' && state.route);
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
    $('fNav').textContent = navLabel();
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
      const t = document.createElement('canvas');
      const ts = 96 / Math.max(w, h);
      t.width = Math.round(w * ts); t.height = Math.round(h * ts);
      t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
      return { canvas: c, thumb: t.toDataURL('image/jpeg', 0.7) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function grayOf(c, maxSide) {
    const s = Math.min(1, maxSide / Math.max(c.width, c.height));
    const sw = Math.max(1, Math.round(c.width * s)), sh = Math.max(1, Math.round(c.height * s));
    const small = document.createElement('canvas');
    small.width = sw; small.height = sh;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(c, 0, 0, sw, sh);
    const px = sctx.getImageData(0, 0, sw, sh).data;
    const gray = new Uint8ClampedArray(sw * sh);
    for (let i = 0; i < gray.length; i++) gray[i] = px[i * 4];
    return { gray, sw, sh, s };
  }
  /** Recadre sur l'étiquette blanche et l'agrandit (une étiquette sur un carton n'occupe qu'une partie de la photo). */
  function cropLabel(c) {
    const { gray, sw, sh, s } = grayOf(c, 400);
    const r = Scan.findBrightRegion(gray, sw, sh);
    if (!r) return null;
    const x = r.x / s, y = r.y / s, w = r.w / s, h = r.h / s;
    const k = Math.min(3, 2200 / Math.max(w, h));
    const out = document.createElement('canvas');
    out.width = Math.round(w * k); out.height = Math.round(h * k);
    const octx = out.getContext('2d');
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(c, x, y, w, h, 0, 0, out.width, out.height);
    return out;
  }
  /** Tourne d'un quart de tour (étiquette photographiée de côté). */
  function rotateCanvas(c, deg) {
    if (!deg) return c;
    const r = document.createElement('canvas');
    const side = deg % 180 !== 0;
    r.width = side ? c.height : c.width; r.height = side ? c.width : c.height;
    const rctx = r.getContext('2d');
    rctx.translate(r.width / 2, r.height / 2);
    rctx.rotate((deg * Math.PI) / 180);
    rctx.drawImage(c, -c.width / 2, -c.height / 2);
    return r;
  }
  async function readCanvas(worker, c) {
    const { data } = await worker.recognize(c, {}, { text: true, blocks: true });
    const words = [], lines = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) { lines.push(l); words.push(...(l.words || [])); }
    let found = Scan.extractAddresses(Scan.rowsFromWords(words, lines));
    if (!found.length) found = Scan.extractAddresses(data.text || '');
    return found;
  }

  /** Redresse une photo penchée : la lecture échoue souvent au-delà de 2 ou 3 degrés. */
  function deskew(c) {
    const { gray, sw, sh } = grayOf(c, 700);
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
      let k = addrKey(r.address);
      if (!k) continue;
      if (r.incomplete) k += `|${uid()}`; // « INCONNU » : chaque colis compte
      else if (known.has(k)) continue;
      known.add(k);
      const dup = existing.has(k);
      state.found.push({
        id: uid(), address: r.address, note: r.note || '', packages: r.packages || 1, sure: !!r.sure, incomplete: !!r.incomplete,
        checked: !dup && !r.incomplete, source, error: dup ? 'Déjà dans la tournée' : '',
      });
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
          // Essais successifs : étiquette recadrée, puis tournée d'un quart de tour, puis photo entière.
          const crop = cropLabel(canvas);
          const attempts = crop ? [[crop, 0], [crop, 90], [crop, 270], [canvas, 0]] : [[canvas, 0], [canvas, 90], [canvas, 270]];
          let found = [];
          for (let a = 0; a < attempts.length && !found.length; a++) {
            item.status = 'reading'; item.progress = 0; item.attempt = a + 1;
            renderQueue();
            found = await readCanvas(worker, deskew(rotateCanvas(attempts[a][0], attempts[a][1])));
          }
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
      if (q.status === 'reading') txt = `Lecture ${q.progress || 0} %${q.attempt > 1 ? ` (essai ${q.attempt})` : ''}`;
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
          <div class="f-meta">${x.packages > 1 ? `<span class="pill">${x.packages} colis</span>` : ''}${x.incomplete ? '<span class="pill late">Rue manquante : complétez</span>' : !x.sure ? '<span class="pill window">À vérifier</span>' : ''}${x.error ? `<span class="pill late">${esc(x.error)}</span>` : ''}${x.note ? `<span class="meta-note">${esc(x.note)}</span>` : ''}</div>
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
    if (e.target.classList.contains('f-addr')) { x.address = e.target.value.trim(); x.error = ''; x.sure = true; x.incomplete = false; x.checked = true; }
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
          const weak = (g.score != null && g.score < 0.5) || (g.type && g.type !== 'housenumber' && Scan.hasHouseNumber(f.address.split(',')[0]));
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
      if (state.route && ok) rebuildMatrix();
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

  // ---------- Panneau qu'on tire (3 hauteurs) ----------
  const SNAPS = [0.24, 0.52, 0.9];
  let sheetFrac = 0.52;
  const wideScreen = () => window.matchMedia('(min-width: 900px)').matches;
  function sheetHeight() { return wideScreen() ? 0 : Math.round(window.innerHeight * sheetFrac); }
  function mapPadding() {
    return wideScreen()
      ? { top: 70, bottom: 40, left: 450, right: 80 }
      : { top: 80, left: 30, right: 80, bottom: Math.min(sheetHeight(), window.innerHeight * 0.6) + 20 };
  }
  function setSheet(frac) {
    sheetFrac = frac;
    $('app').style.setProperty('--sheet-h', `${sheetHeight()}px`);
    $('app').classList.toggle('sheet-full', !wideScreen() && frac > 0.8);
  }
  (function sheetDrag() {
    let startY = 0, startH = 0, dragging = false, moved = false;
    const down = (e) => {
      if (wideScreen() || e.target.closest('button, input')) return;
      dragging = true; moved = false; startY = e.clientY; startH = sheetHeight();
      $('app').classList.add('dragging');
      e.currentTarget.setPointerCapture(e.pointerId);
    };
    const move = (e) => {
      if (!dragging) return;
      const h = Math.max(window.innerHeight * 0.15, Math.min(window.innerHeight * 0.94, startH - (e.clientY - startY)));
      if (Math.abs(e.clientY - startY) > 4) moved = true;
      $('app').style.setProperty('--sheet-h', `${h}px`);
    };
    const up = (e) => {
      if (!dragging) return;
      dragging = false;
      $('app').classList.remove('dragging');
      const h = parseFloat(getComputedStyle($('app')).getPropertyValue('--sheet-h')) / window.innerHeight;
      let next;
      if (!moved) next = SNAPS[(SNAPS.indexOf(sheetFrac) + 1) % SNAPS.length]; // simple appui : hauteur suivante
      else next = SNAPS.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a));
      setSheet(next);
      void e;
    };
    for (const el of [$('sheetGrip'), $('sheetHeader')]) {
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
    window.addEventListener('resize', () => setSheet(sheetFrac));
  })();

  // ---------- Menu ----------
  function toggleMenu(show) {
    const pop = $('menuPop');
    pop.hidden = show === undefined ? !pop.hidden : !show;
    if (!pop.hidden) pop.querySelector('button').focus();
  }
  $('menuBtn').addEventListener('click', (e) => { e.stopPropagation(); openDrawer(); });
  $('moreBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', (e) => { if (!$('menuPop').hidden && !e.target.closest('#menuPop')) toggleMenu(false); });
  $('menuPop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-menu]'); if (!b) return;
    toggleMenu(false);
    const m = b.dataset.menu;
    if (m === 'plan' || m === 'run' || m === 'settings') { switchView(m); if (sheetFrac < 0.5) setSheet(0.52); }
    else if (m === 'scan') openScan();
    else if (m === 'reopt') $('reoptHere').click();
    else if (m === 'export') $('exportCsv').click();
    else if (m === 'tours') openDrawer();
  });
  $('settingsDone').addEventListener('click', () => switchView(state.route ? 'run' : 'plan'));

  // ---------- Mes tournées (menu latéral) ----------
  const DAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  const MONTHS_LONG = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const parseISO = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  function groupLabel(iso) {
    const d = parseISO(iso), now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.round((today - d) / 86400000);
    if (diff <= 0) return "Aujourd'hui";
    const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    if (d >= monday) return 'Plus tôt cette semaine';
    if (d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear()) return 'Plus tôt ce mois';
    return `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
  }
  function renderDrawer() {
    syncHistory();
    const list = state.history;
    $('drawerStats').textContent = list.length ? `${plural(list.length, 'tournée')} enregistrée${list.length > 1 ? 's' : ''} sur ce téléphone` : 'Vos tournées restent sur ce téléphone';
    if (!list.length) { $('tourList').innerHTML = '<p class="drawer-empty">Aucune tournée enregistrée. Touchez « Créer un trajet » pour commencer.</p>'; return; }
    let html = '', last = '';
    for (const h of list) {
      const g = groupLabel(h.date);
      if (g !== last) { html += `<div class="tour-group">${esc(g)}</div>`; last = g; }
      const d = parseISO(h.date);
      const done = h.stops.filter((x) => x.status === 'done').length;
      html += `<div class="tour-item ${h.id === state.tourId ? 'current' : ''}">
        <button type="button" class="tour-open" data-tour="${h.id}"><span class="t-date">${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}</span><span class="t-day">${DAYS[d.getDay()]}</span><span class="t-sub">${plural(h.stops.length, 'arrêt')} · ${done} livré${done > 1 ? 's' : ''}</span></button>
        <button type="button" class="t-more" data-tmore="${h.id}" aria-label="Options de la tournée"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button>
      </div>`;
    }
    $('tourList').innerHTML = html;
  }
  function openDrawer() { toggleMenu(false); renderDrawer(); $('drawer').hidden = false; $('drawerBack').hidden = false; }
  function closeDrawer() { $('drawer').hidden = true; $('drawerBack').hidden = true; }
  function clearToast() { $('toast').hidden = true; undoAction = null; clearTimeout(toastTimer); }
  function loadTour(h) {
    clearToast();
    syncHistory();
    state.tourId = h.id; state.tourDate = h.date; state.start = h.start; state.end = h.end;
    state.stops = JSON.parse(JSON.stringify(h.stops)); state.seq = h.seq || state.stops.length;
    state.route = h.route ? JSON.parse(JSON.stringify(h.route)) : null;
    state.found = [];
    lastBoundsKey = ''; lastFocusId = null;
    renderAll();
    switchView(state.route ? 'run' : 'plan');
  }
  function newTour(fromStops) {
    clearToast();
    syncHistory();
    state.tourId = uid(); state.tourDate = todayISO();
    state.stops = []; state.route = null; state.found = []; state.seq = 0;
    if (fromStops) for (const st of fromStops) state.stops.push(newStop(st, { note: st.note, packages: st.packages }));
    lastBoundsKey = ''; lastFocusId = null;
    renderAll();
    switchView('plan');
  }
  let tourActionId = null;
  $('tourList').addEventListener('click', (e) => {
    const open = e.target.closest('[data-tour]');
    if (open) { const h = state.history.find((x) => x.id === open.dataset.tour); if (h && h.id !== state.tourId) loadTour(h); closeDrawer(); return; }
    const more = e.target.closest('[data-tmore]');
    if (more) {
      const h = state.history.find((x) => x.id === more.dataset.tmore); if (!h) return;
      tourActionId = h.id;
      const d = parseISO(h.date);
      $('tourDialogTitle').textContent = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS_LONG[d.getMonth()]}`;
      $('tourDialogSub').textContent = `${plural(h.stops.length, 'arrêt')}${h.route ? `, ${fmtKm(h.route.distance)}` : ''}`;
      $('tourDialog').showModal();
    }
  });
  $('tourDialog').addEventListener('close', () => {
    const v = $('tourDialog').returnValue;
    const h = state.history.find((x) => x.id === tourActionId);
    tourActionId = null;
    if (!h || v === 'cancel') return;
    if (v === 'open') { if (h.id !== state.tourId) loadTour(h); closeDrawer(); }
    else if (v === 'redo') { newTour(h.stops); if (h.start) state.start = h.start; renderAll(); closeDrawer(); toast(`${plural(h.stops.length, 'arrêt')} repris. Touchez Optimiser.`); }
    else if (v === 'delete') {
      state.history = state.history.filter((x) => x.id !== h.id);
      if (h.id === state.tourId) { state.stops = []; state.route = null; newTour(); }
      save(); renderDrawer(); toast('Tournée supprimée.');
    }
  });
  $('drawerClose').addEventListener('click', closeDrawer);
  $('drawerBack').addEventListener('click', closeDrawer);
  $('drawerSettings').addEventListener('click', () => { closeDrawer(); switchView('settings'); if (sheetFrac < 0.5) setSheet(0.9); });
  $('drawerHelp').addEventListener('click', () => $('helpDialog').showModal());
  $('newTour').addEventListener('click', () => { newTour(); closeDrawer(); setSheet(0.9); $('stopInput').focus(); });

  // ---------- Ajouter des arrêts : carte, scanner, voix ----------
  $('addScan').addEventListener('click', openScan);
  $('modeMap').addEventListener('click', () => { setSheet(SNAPS[0]); toast("Touchez la carte à l'endroit de l'arrêt."); });
  let recognition = null;
  function startVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { $('stopInput').focus(); toast("Touchez le micro du clavier pour dicter l'adresse."); return; }
    if (recognition) { recognition.stop(); return; }
    recognition = new SR();
    recognition.lang = /^fr/i.test(navigator.language) ? navigator.language : 'fr-BE';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    $('addVoice').classList.add('listening');
    recognition.onresult = (e) => {
      const t = e.results[0][0].transcript;
      $('stopInput').value = t;
      $('stopInput').dispatchEvent(new Event('input'));
      $('stopInput').focus();
    };
    recognition.onerror = () => toast('Dictée impossible. Autorisez le micro ou tapez l\'adresse.');
    recognition.onend = () => { recognition = null; $('addVoice').classList.remove('listening'); };
    try { recognition.start(); toast("Dites l'adresse, par exemple : rue de la Vallée 2 Châtelineau."); }
    catch (e) { recognition = null; $('addVoice').classList.remove('listening'); $('stopInput').focus(); }
  }
  $('addVoice').addEventListener('click', startVoice);
  $('modeVoice').addEventListener('click', startVoice);
  // « trouver des arrêts » : la saisie filtre aussi la liste
  $('stopInput').addEventListener('input', (e) => { listQuery = e.target.value.trim(); renderPlan(); });

  // ---------- Recherche dans la liste ----------
  $('searchToggle').addEventListener('click', () => {
    const w = $('listSearchWrap');
    w.hidden = !w.hidden;
    if (w.hidden) { listQuery = ''; $('listSearch').value = ''; renderPlan(); renderRun(); }
    else { if (sheetFrac < 0.5) setSheet(0.9); $('listSearch').focus(); }
  });
  $('listSearch').addEventListener('input', (e) => { listQuery = e.target.value.trim(); renderPlan(); renderRun(); });

  // ---------- Fin de tournée ----------
  $('finishRoute').addEventListener('click', () => {
    const done = state.stops.filter((s) => s.status === 'done').length;
    const failed = state.stops.filter((s) => s.status === 'failed').length;
    const left = state.stops.length - done - failed;
    $('endSummary').textContent = `${done} livré${done > 1 ? 's' : ''}, ${failed} échec${failed > 1 ? 's' : ''}${left ? `, ${left} arrêt${left > 1 ? 's' : ''} pas encore fait${left > 1 ? 's' : ''}` : ''}. Exportez le bilan avant d'effacer la tournée.`;
    $('endDialog').showModal();
  });
  $('endExport').addEventListener('click', () => $('exportCsv').click());
  $('endDialog').addEventListener('close', () => {
    if ($('endDialog').returnValue !== 'new') return;
    newTour();
    toast('Tournée enregistrée dans le menu ≡. Nouvelle tournée prête.');
  });

  // ---------- GPS intégré (guidage pas à pas) ----------
  const nav = { active: false, voice: true, follow: true };
  let wakeLock = null;
  let meMarker = null;

  const M_PER_DEG = 111320;
  function localXY(p, ref) {
    return { x: (p.lon - ref.lon) * M_PER_DEG * Math.cos((ref.lat * Math.PI) / 180), y: (p.lat - ref.lat) * M_PER_DEG };
  }
  function bearingDeg(a, b) {
    const y = Math.sin(((b.lon - a.lon) * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180);
    const x = Math.cos((a.lat * Math.PI) / 180) * Math.sin((b.lat * Math.PI) / 180) - Math.sin((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.cos(((b.lon - a.lon) * Math.PI) / 180);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }
  const dist = (a, b) => Optimizer.haversine(a, b);

  // --- consignes en français à partir des manœuvres OSRM
  const DIR = {
    uturn: 'faites demi-tour', 'sharp right': 'tournez franchement à droite', right: 'tournez à droite', 'slight right': 'serrez à droite',
    straight: 'continuez tout droit', 'slight left': 'serrez à gauche', left: 'tournez à gauche', 'sharp left': 'tournez franchement à gauche',
  };
  const ORD = ['', 'première', 'deuxième', 'troisième', 'quatrième', 'cinquième', 'sixième', 'septième', 'huitième'];
  function instruction(step) {
    const m = step.maneuver || {};
    const mod = m.modifier || 'straight';
    const on = step.name ? ` sur ${step.name}` : '';
    switch (m.type) {
      case 'depart': return `Partez${on}`;
      case 'arrive': return 'Vous arrivez à destination';
      case 'roundabout': case 'rotary': case 'roundabout turn':
        return m.exit ? `Au rond-point, prenez la ${ORD[m.exit] || `${m.exit}e`} sortie${on}` : `Prenez le rond-point${on}`;
      case 'exit roundabout': case 'exit rotary': return `Sortez du rond-point${on}`;
      case 'merge': return `Insérez-vous ${mod.includes('left') ? 'à gauche' : 'à droite'}${on}`;
      case 'on ramp': return `Prenez la bretelle${on}`;
      case 'off ramp': return `Prenez la sortie ${mod.includes('left') ? 'à gauche' : 'à droite'}${on}`;
      case 'fork': return `À l'embranchement, restez ${mod.includes('left') ? 'à gauche' : 'à droite'}${on}`;
      case 'new name': case 'continue': return mod === 'straight' ? `Continuez tout droit${on}` : `${cap1(DIR[mod] || 'continuez')}${on}`;
      default: return `${cap1(DIR[mod] || 'continuez')}${on}`;
    }
  }
  const cap1 = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  function arrowSVG(step) {
    const m = (step && step.maneuver) || {};
    if (/roundabout|rotary/.test(m.type || '')) {
      return `<svg viewBox="0 0 64 64"><circle cx="32" cy="34" r="11"/><path d="M32 60V45M32 23V6M24 14l8-8 8 8"/><text class="rb" x="32" y="39" text-anchor="middle">${m.exit || ''}</text></svg>`;
    }
    if (m.type === 'arrive') return '<svg viewBox="0 0 64 64"><path d="M20 58V8m0 0h26l-5 9 5 9H20"/></svg>';
    const mod = m.modifier || 'straight';
    if (mod === 'uturn') return '<svg viewBox="0 0 64 64"><path d="M40 58V26a12 12 0 0 0-24 0v8M8 26l8 9 8-9"/></svg>';
    const ang = { straight: 0, 'slight right': 40, right: 90, 'sharp right': 135, 'slight left': -40, left: -90, 'sharp left': -135 }[mod] || 0;
    const r = (ang * Math.PI) / 180;
    const ex = 32 + Math.sin(r) * 22, ey = 30 - Math.cos(r) * 22;
    const hx = (a) => 32 + Math.sin(r) * 22 - Math.sin(r + a) * 12, hy = (a) => 30 - Math.cos(r) * 22 + Math.cos(r + a) * 12;
    return `<svg viewBox="0 0 64 64"><path d="M32 60V30L${ex.toFixed(1)} ${ey.toFixed(1)}M${hx(0.6).toFixed(1)} ${hy(0.6).toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}L${hx(-0.6).toFixed(1)} ${hy(-0.6).toFixed(1)}"/></svg>`;
  }
  function fmtNavDist(m) {
    if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', ',')} km`;
    if (m >= 100) return `${Math.round(m / 50) * 50} m`;
    return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  }
  function spokenDist(m) {
    if (m >= 1000) { const k = (m / 1000).toFixed(1).replace('.', ','); return `${k} kilomètre${parseFloat(k.replace(',', '.')) >= 2 ? 's' : ''}`; }
    return `${m >= 100 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10} mètres`;
  }

  function speak(text) {
    if (!nav.voice || !('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'fr-FR';
      const v = speechSynthesis.getVoices().find((x) => /^fr(-|_)(BE|FR)/i.test(x.lang));
      if (v) u.voice = v;
      u.rate = 1.02;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (e) { /* voix indisponible */ }
  }
  async function keepScreenOn() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
  }

  function navLayer(coords) {
    if (!map || !styleReady) return;
    const data = { type: 'FeatureCollection', features: coords && coords.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] : [] };
    if (!map.getSource('nav')) {
      map.addSource('nav', { type: 'geojson', data });
      map.addLayer({ id: 'nav-casing', type: 'line', source: 'nav', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0B3E99', 'line-width': 12 } });
      map.addLayer({ id: 'nav-line', type: 'line', source: 'nav', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#3D8BFF', 'line-width': 8 } });
    } else map.getSource('nav').setData(data);
  }
  function showMe(pos, bearing) {
    if (!map) return;
    if (!meMarker) {
      const el = document.createElement('div');
      el.className = 'me';
      meMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([pos.lon, pos.lat]).addTo(map);
    }
    meMarker.setLngLat([pos.lon, pos.lat]);
    if (bearing != null) meMarker.setRotation(bearing);
  }

  async function fetchNavRoute(from, to) {
    const base = state.settings.osrm.replace(/\/+$/, '');
    const r = await fetchJSON(`${base}/route/v1/driving/${from.lon.toFixed(6)},${from.lat.toFixed(6)};${to.lon.toFixed(6)},${to.lat.toFixed(6)}?overview=full&geometries=geojson&steps=true`, 15000);
    if (r.code !== 'Ok' || !r.routes || !r.routes[0]) throw new Error(r.code || 'route');
    const route = r.routes[0];
    const coords = route.geometry.coordinates.map(([lon, lat]) => ({ lon, lat }));
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
    const steps = [];
    let from_i = 0;
    for (const st of route.legs[0].steps) {
      const [lon, lat] = st.maneuver.location;
      let best = from_i, bd = Infinity;
      for (let i = from_i; i < Math.min(coords.length, from_i + 400); i++) { const d = dist(coords[i], { lat, lon }); if (d < bd) { bd = d; best = i; } }
      from_i = best;
      steps.push({ ...st, idx: best });
    }
    return { coords, cum, steps, total: cum[cum.length - 1], duration: route.duration, straight: false };
  }
  function straightRoute(from, to) {
    const coords = [from, to];
    const d = dist(from, to);
    return { coords, cum: [0, d], total: d, duration: d / 8, straight: true, steps: [{ maneuver: { type: 'arrive' }, name: '', idx: 1 }] };
  }
  function snap(pos, rt) {
    let best = { dist: Infinity, along: 0, seg: 0 };
    const from = Math.max(0, (nav.seg || 0) - 10), to = Math.min(rt.coords.length - 1, (nav.seg || 0) + 400);
    for (let i = from; i < to; i++) {
      const a = rt.coords[i], b = rt.coords[i + 1];
      const A = localXY(a, pos), B = localXY(b, pos);
      const dx = B.x - A.x, dy = B.y - A.y;
      const len2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, -(A.x * dx + A.y * dy) / len2));
      const px = A.x + t * dx, py = A.y + t * dy;
      const d = Math.hypot(px, py);
      if (d < best.dist) best = { dist: d, along: rt.cum[i] + t * (rt.cum[i + 1] - rt.cum[i]), seg: i };
    }
    return best;
  }

  async function startNav(stop) {
    if (!navigator.geolocation) { toast('Ce téléphone ne donne pas sa position. Utilisez Waze.'); return; }
    stopNav(true);
    clearToast();
    Object.assign(nav, { active: true, stop, route: null, seg: 0, off: 0, said: {}, arrived: false, fetching: false, follow: true, pos: null, lastK: -1, session: (nav.session || 0) + 1 });
    $('app').classList.add('navigating');
    document.body.classList.add('navigating');
    $('navTop').hidden = false; $('navBottom').hidden = false;
    $('navDriving').hidden = false; $('navArrived').hidden = true;
    $('navArrow').innerHTML = '';
    $('navDist').textContent = '…';
    $('navInstr').textContent = 'Recherche de votre position';
    $('navStreet').textContent = '';
    const n = orderNumber(stop.id);
    $('navTarget').textContent = `${n ? `Arrêt ${n} · ` : ''}${splitLabel(stop.label).street}`;
    $('navVoice').setAttribute('aria-pressed', String(nav.voice));
    keepScreenOn();
    speak(`Guidage vers ${splitLabel(stop.label).street}`); // le premier son doit partir d'un geste (iPhone)
    nav.watch = navigator.geolocation.watchPosition(onNavPos, onNavErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }
  function stopNav(silent) {
    if (nav.watch != null) navigator.geolocation.clearWatch(nav.watch);
    nav.watch = null;
    nav.active = false;
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* déjà libéré */ }
    wakeLock = null;
    try { speechSynthesis.cancel(); } catch (e) { /* pas de voix */ }
    $('app').classList.remove('navigating');
    document.body.classList.remove('navigating');
    $('navTop').hidden = true; $('navBottom').hidden = true; $('navRecenter').hidden = true; $('navRadar').hidden = true;
    radarMarkers.forEach((m) => m.remove()); radarMarkers = [];
    navLayer(null);
    if (meMarker) { meMarker.remove(); meMarker = null; }
    if (!silent) { lastFocusId = null; focusCurrent(true); }
  }
  function onNavErr(err) {
    if (err && err.code === 1) { stopNav(); toast('Localisation refusée. Réglages > Confidentialité > Service de localisation > Safari : « Lorsque l\'app est active ».'); }
    else $('navInstr').textContent = 'Signal GPS faible, recherche…';
  }
  async function reroute(pos) {
    if (nav.fetching) return;
    const session = nav.session, target = nav.stop;
    nav.fetching = true;
    let rt;
    try { rt = await fetchNavRoute(pos, target); }
    catch (e) { rt = straightRoute(pos, target); }
    if (session !== nav.session || !nav.active) return; // guidage arrêté ou relancé entre-temps
    nav.route = rt;
    nav.fetching = false; nav.seg = 0; nav.off = 0; nav.said = {};
    navLayer(nav.route.coords.map((c) => [c.lon, c.lat]));
    if (state.settings.radars) {
      loadRadars(nav.route.coords).then((list) => {
        radars = list;
        if (!nav.active || !nav.route) return;
        nav.route.radars = radarsOnRoute(nav.route);
        showRadars(list);
      });
    }
  }
  async function onNavPos(p) {
    if (!nav.active) return;
    const session = nav.session;
    const pos = { lat: p.coords.latitude, lon: p.coords.longitude };
    const speed = p.coords.speed || 0;
    nav.pos = pos;
    if (!nav.route) { await reroute(pos); if (!nav.active || session !== nav.session) return; }
    const rt = nav.route;
    if (!rt) return;
    const toStop = dist(pos, nav.stop);
    if (toStop < 35) { navArrive(); return; }
    let along, seg;
    if (rt.straight) { rt.coords[0] = pos; rt.cum = [0, toStop]; rt.total = toStop; along = 0; seg = 0; }
    else {
      const sn = snap(pos, rt);
      along = sn.along; seg = sn.seg; nav.seg = seg;
      if (sn.dist > 45) { nav.off++; if (nav.off >= 2) { speak('Recalcul de l\'itinéraire'); await reroute(pos); if (!nav.active || session !== nav.session) return; return onNavPos(p); } }
      else nav.off = 0;
    }
    // prochaine manœuvre devant soi
    let k = rt.steps.findIndex((st) => rt.cum[st.idx] > along + 8 && st.maneuver.type !== 'depart');
    if (k < 0) k = rt.steps.length - 1;
    const st = rt.steps[k];
    const toMan = Math.max(0, (rt.cum[st.idx] ?? rt.total) - along);
    const text = rt.straight ? `Dirigez-vous vers l'arrêt (${fmtNavDist(toStop)} à vol d'oiseau)` : instruction(st);
    $('navArrow').innerHTML = rt.straight ? arrowSVG({ maneuver: { modifier: 'straight' } }) : arrowSVG(st);
    if (nav.lastK !== k) { nav.lastK = k; anim.maneuver(); }
    $('navDist').textContent = fmtNavDist(toMan);
    $('navInstr').textContent = text.replace(/ sur .*$/, '');
    $('navStreet').textContent = st.name || '';
    // voix : annonce à l'approche, puis au moment de tourner
    if (!rt.straight) {
      const key = `${k}`;
      if (toMan <= 400 && toMan > 120 && !nav.said[key + 'a']) { nav.said[key + 'a'] = 1; speak(`Dans ${spokenDist(toMan)}, ${text.charAt(0).toLowerCase()}${text.slice(1)}`); }
      else if (toMan <= 60 && !nav.said[key + 'b']) { nav.said[key + 'b'] = nav.said[key + 'a'] = 1; speak(text); }
    }
    if (toStop < 120 && !nav.said.near) { nav.said.near = 1; speak('Votre arrêt est à 100 mètres'); }
    const kmh = Math.round(speed * 3.6);
    $('navSpeed').textContent = p.coords.speed != null ? String(kmh) : '–';
    if (state.settings.radars) radarAlert(pos, along, kmh);
    // arrivée prévue
    const remain = Math.max(toStop, rt.total - along);
    const secs = rt.total > 0 ? rt.duration * (remain / rt.total) : remain / 8;
    $('navEta').textContent = fmtClock(nowSec() + secs);
    $('navRemain').textContent = `${fmtDur(secs)} · ${fmtKm(remain)}`;
    // caméra qui suit, orientée dans le sens de la marche
    const nextPt = rt.coords[Math.min(rt.coords.length - 1, seg + 1)];
    const brg = p.coords.heading != null && speed > 1.5 ? p.coords.heading : bearingDeg(pos, nextPt);
    showMe(pos, brg);
    if (nav.follow && map) {
      map.easeTo({
        center: [pos.lon, pos.lat], bearing: brg, pitch: state.settings.map3d ? 60 : 40, zoom: speed > 14 ? 16 : 17,
        duration: 900, padding: { top: 190, bottom: 160, left: 0, right: 0 },
      });
    }
  }
  function navArrive() {
    if (nav.arrived) return;
    nav.arrived = true;
    if (nav.watch != null) navigator.geolocation.clearWatch(nav.watch);
    nav.watch = null;
    speak('Vous êtes arrivé');
    if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
    $('navTop').hidden = true; $('navRadar').hidden = true;
    $('navDriving').hidden = true; $('navArrived').hidden = false;
    const s = nav.stop;
    $('navArrAddr').textContent = s.label;
    $('navArrNote').textContent = [s.packages > 1 ? `${s.packages} colis` : '', s.note].filter(Boolean).join(' · ');
    const nx = nextAfter(s.id);
    $('navDone').innerHTML = `Livré${state.settings.autoNav && nx ? `<small>puis guidage vers le n° ${orderNumber(nx.id)}</small>` : ''}`;
  }
  $('navQuit').addEventListener('click', () => stopNav());
  $('navWaze').addEventListener('click', () => {
    const s = nav.stop; stopNav(true);
    window.location.href = IS_IOS ? `waze://?ll=${s.lat},${s.lon}&navigate=yes` : `https://waze.com/ul?ll=${s.lat},${s.lon}&navigate=yes`;
  });
  $('navVoice').addEventListener('click', () => {
    nav.voice = !nav.voice;
    $('navVoice').setAttribute('aria-pressed', String(nav.voice));
    $('navVoice').setAttribute('aria-label', nav.voice ? 'Couper la voix' : 'Activer la voix');
    if (!nav.voice) try { speechSynthesis.cancel(); } catch (e) { /* pas de voix */ }
  });
  $('navRecenter').addEventListener('click', () => { nav.follow = true; $('navRecenter').hidden = true; });
  $('navDone').addEventListener('click', () => { const s = nav.stop; stopNav(true); mark(s.id, 'done'); });
  $('navFail').addEventListener('click', () => { const s = nav.stop; stopNav(true); failId = s.id; $('failDialog').showModal(); });
  $('navSkip').addEventListener('click', () => { const s = nav.stop; stopNav(true); skip(s.id); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && nav.active && !nav.arrived) keepScreenOn(); });

  // ---------- Tournée dans mon ordre (sans optimisation) ----------
  /** Recalcule la matrice de temps pour l'ordre actuel (serveur d'itinéraire, sinon estimation), puis les heures. */
  async function rebuildMatrix(tryServer = true) {
    const r = state.route;
    if (!r) return;
    const end = endPoint();
    const ids = r.order.filter((id) => stopById(id));
    const pts = [r.start, ...ids.map(stopById)];
    if (end) pts.push(end);
    let mat = null;
    if (tryServer && pts.length <= 100) { try { mat = await osrmTable(pts); } catch (e) { mat = null; } }
    if (!mat) mat = Optimizer.estimateMatrix(pts);
    if (state.route !== r) return; // tournée changée entre-temps
    const live = r.order.filter((id) => stopById(id));
    if (live.join() !== ids.join()) return rebuildMatrix(tryServer); // ordre modifié pendant le calcul
    r.matrix = { ids, durations: mat.durations.map((row) => row.map((v) => Math.round(v))), endIndex: end ? pts.length - 1 : null, startTime: r.startTime };
    let d = 0, prev = 0;
    ids.forEach((id, k) => { d += mat.distances[prev][k + 1]; prev = k + 1; });
    if (end) d += mat.distances[prev][pts.length - 1];
    r.distance = d;
    recomputeEtas();
    renderAll();
  }
  async function startInOrder() {
    const pending = state.stops.filter((s) => s.status === 'pending');
    if (!state.start) { toast('Indiquez d\'abord votre point de départ.'); $('startInput').focus(); return; }
    if (!pending.length) { toast('Ajoutez au moins un arrêt.'); return; }
    const done = state.route ? state.route.order.filter((id) => { const s = stopById(id); return s && s.status !== 'pending'; }) : state.stops.filter((s) => s.status !== 'pending').map((s) => s.id);
    const end = endPoint();
    state.route = {
      order: [...done, ...pending.map((s) => s.id)], etas: {}, startTime: plannedStart(), duration: 0, distance: 0, late: 0, end: 0,
      source: 'manual', geometry: null, start: { lat: state.start.lat, lon: state.start.lon, label: state.start.label },
      endPt: end ? { lat: end.lat, lon: end.lon } : null, matrix: null,
    };
    lastBoundsKey = ''; lastFocusId = null;
    renderAll();
    switchView('run');
    toast('Tournée lancée dans votre ordre. Calcul des heures…');
    await rebuildMatrix();
    toast(`Fin prévue à ${fmtClock(state.route ? state.route.end : 0)}.`);
  }
  /**
   * Nouvelle adresse pendant la tournée : on la place là où elle rallonge le moins le trajet,
   * parmi les arrêts qui restent (jamais avant l'arrêt vers lequel vous roulez).
   */
  function insertIntoRoute(s) {
    const r = state.route;
    if (!r || r.order.includes(s.id)) return null;
    const pend = r.order.filter((id) => { const x = stopById(id); return x && x.status === 'pending'; });
    const handled = state.stops.filter((x) => x.status !== 'pending' && x.doneAt).sort((a, b) => b.doneAt - a.doneAt)[0];
    let from = handled || r.start;
    let candidates = pend;
    if (nav.active && nav.stop && pend[0] === nav.stop.id) { from = nav.stop; candidates = pend.slice(1); }
    const end = r.endPt;
    const d = (a, b) => Optimizer.haversine(a, b);
    let bestPos = candidates.length, bestCost = Infinity;
    let prev = from;
    for (let i = 0; i <= candidates.length; i++) {
      const next = i < candidates.length ? stopById(candidates[i]) : end;
      const cost = next ? d(prev, s) + d(s, next) - d(prev, next) : d(prev, s);
      if (cost < bestCost) { bestCost = cost; bestPos = i; }
      if (next && i < candidates.length) prev = next;
    }
    const beforeId = candidates[bestPos];
    if (beforeId) r.order.splice(r.order.indexOf(beforeId), 0, s.id);
    else r.order.push(s.id);
    r.geometry = null;
    return orderNumber(s.id);
  }
  $('skipOptBtn').addEventListener('click', startInOrder);

  // ---------- Radars (OpenStreetMap) ----------
  const RADAR_CACHE = 'cap-colis-radars';
  let radars = [];
  let radarMarkers = [];
  const CAM_SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 10.5 21 8v8l-5-2.5"/></svg>';
  async function loadRadars(pts) {
    if (!state.settings.radars) return [];
    let s = 90, w = 180, n = -90, e = -180;
    for (const p of pts) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
    // zone arrondie, gardée 24 h sur le téléphone
    const r = (v, f) => (f(v * 10) / 10).toFixed(1);
    s = r(s - 0.05, Math.floor); w = r(w - 0.08, Math.floor); n = r(n + 0.05, Math.ceil); e = r(e + 0.08, Math.ceil);
    const key = `${s},${w},${n},${e}`;
    try {
      const c = JSON.parse(localStorage.getItem(RADAR_CACHE) || '{}');
      if (c.key === key && Date.now() - c.at < 86400000) return c.list;
    } catch (e2) { /* cache illisible */ }
    const q = `[out:json][timeout:20];(node["highway"="speed_camera"](${key});node["enforcement"="maxspeed"](${key}););out body;`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      const j = await res.json();
      const list = (j.elements || []).map((el) => ({ id: el.id, lat: el.lat, lon: el.lon, max: parseInt((el.tags && el.tags.maxspeed) || '', 10) || null }));
      try { localStorage.setItem(RADAR_CACHE, JSON.stringify({ key, at: Date.now(), list })); } catch (e3) { /* plein */ }
      return list;
    } catch (e4) { return []; } finally { clearTimeout(t); }
  }
  function showRadars(list) {
    radarMarkers.forEach((m) => m.remove());
    radarMarkers = [];
    if (!map) return;
    for (const r of list) {
      const el = document.createElement('div');
      el.className = 'radar-mk';
      el.innerHTML = r.max ? String(r.max) : CAM_SVG;
      el.title = r.max ? `Radar ${r.max} km/h` : 'Radar';
      radarMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([r.lon, r.lat]).addTo(map));
    }
  }
  /** Radars sur l'itinéraire : position le long du trajet. */
  function radarsOnRoute(rt) {
    if (rt.straight) return [];
    const out = [];
    for (const r of radars) {
      let best = { dist: Infinity, along: 0 };
      for (let i = 0; i < rt.coords.length - 1; i++) {
        const A = localXY(rt.coords[i], r), B = localXY(rt.coords[i + 1], r);
        const dx = B.x - A.x, dy = B.y - A.y, len2 = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, -(A.x * dx + A.y * dy) / len2));
        const dd = Math.hypot(A.x + t * dx, A.y + t * dy);
        if (dd < best.dist) best = { dist: dd, along: rt.cum[i] + t * (rt.cum[i + 1] - rt.cum[i]) };
      }
      if (best.dist < 40) out.push({ ...r, along: best.along });
    }
    return out;
  }
  function radarAlert(pos, along, speedKmh) {
    const rt = nav.route;
    let ahead = null;
    if (rt && rt.radars) {
      for (const r of rt.radars) { const dd = r.along - along; if (dd > -15 && dd < 700 && (!ahead || dd < ahead.d)) ahead = { ...r, d: Math.max(0, dd) }; }
    } else {
      for (const r of radars) { const dd = Optimizer.haversine(pos, r); if (dd < 300 && (!ahead || dd < ahead.d)) ahead = { ...r, d: dd }; }
    }
    const box = $('navRadar');
    const sp = $('navSpeed');
    sp.classList.toggle('over', !!(ahead && ahead.max && speedKmh > ahead.max + 2));
    if (!ahead) { box.hidden = true; return; }
    if (box.hidden) { box.hidden = false; anim.radar(box); }
    box.innerHTML = `${ahead.max ? `<span class="lim">${ahead.max}</span>` : CAM_SVG}<span>Radar à ${fmtNavDist(ahead.d)}</span>`;
    const k = `radar${ahead.id}`;
    if (ahead.d < 500 && !nav.said[k]) {
      nav.said[k] = 1;
      speak(`Attention, radar dans ${spokenDist(ahead.d)}${ahead.max ? `, limité à ${ahead.max}` : ''}`);
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }
  }

  // ---------- Événements ----------

  attachSearch($('startInput'), $('startSuggest'), setStart);
  attachSearch($('stopInput'), $('stopSuggest'), (it) => { addStop(it); $('stopInput').value = ''; listQuery = ''; renderPlan(); });
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
  $('setRadars').addEventListener('change', (e) => { state.settings.radars = e.target.checked; save(); });
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

  // Tournée d'exemple (lieux publics de la région de Charleroi, coordonnées approximatives)
  $('loadDemo').addEventListener('click', () => {
    const demo = [
      ['Place Charles II, 6000 Charleroi', 50.4114, 4.4446],
      ['Gare de Charleroi-Central, 6000 Charleroi', 50.4045, 4.4386],
      ['Place de la Digue, 6000 Charleroi', 50.4069, 4.4497],
      ['Grand-Place, 6200 Châtelet', 50.4040, 4.5250],
      ['Gare de Châtelineau, 6200 Châtelineau', 50.4140, 4.5170],
      ['Place de Montignies, 6061 Montignies-sur-Sambre', 50.4090, 4.4900],
      ['Place Albert Ier, 6001 Marcinelle', 50.3920, 4.4370],
      ['Place Communale, 6041 Gosselies', 50.4690, 4.4320],
      ['Place du Ballon, 6040 Jumet', 50.4420, 4.4280],
      ['Place Communale, 6010 Couillet', 50.3900, 4.4700],
      ['Place de Gilly, 6060 Gilly', 50.4210, 4.4800],
      ['Place de Leernes, 6142 Leernes', 50.3960, 4.3640],
    ];
    state.start = { label: 'Dépôt (exemple), 6220 Fleurus', lat: 50.4840, lon: 4.5500 };
    state.stops = demo.map(([label, lat, lon]) => newStop({ label, lat, lon }));
    state.stops[3].note = 'Exemple : boîte 6, sonner chez le voisin si absent';
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
  anim.splash();
  setSheet(sheetFrac);
  initMap();
  renderSettings();
  renderAll();
  apply3D(false);
  if (state.route) switchView('run');
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.CapColis = { get state() { return state; }, optimize, queueFiles, addStop, render: renderAll };
})();

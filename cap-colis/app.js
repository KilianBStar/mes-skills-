/* Cap Colis — logique de l'application (sans framework). */
(function () {
  'use strict';

  // ---------- État & persistance ----------
  const STORE_KEY = 'cap-colis-v1';
  const DEFAULT_SETTINGS = {
    startTime: '08:00', service: 2, endMode: 'start', navApp: 'google', region: 'fr',
    osrm: 'https://router.project-osrm.org',
  };
  let state = load();
  let undoStack = [];

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && Array.isArray(s.stops)) {
        s.settings = Object.assign({}, DEFAULT_SETTINGS, s.settings);
        return s;
      }
    } catch (e) { /* stockage indisponible */ }
    return { settings: Object.assign({}, DEFAULT_SETTINGS), start: null, end: null, stops: [], route: null };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignoré */ }
  }

  // ---------- Utilitaires ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const toSec = (hhmm) => { if (!hhmm) return null; const [h, m] = hhmm.split(':').map(Number); return h * 3600 + m * 60; };
  const fmtClock = (sec) => { if (sec == null) return '–'; const m = Math.round(sec / 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const fmtDur = (sec) => { const m = Math.round(sec / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
  const fmtKm = (m) => (m >= 10000 ? `${Math.round(m / 1000)} km` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
  const nowSec = () => { const d = new Date(); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); };

  async function fetchJSON(url, timeout = 12000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  let toastTimer;
  function toast(text, undo) {
    $('toastText').textContent = text;
    $('toast').hidden = false;
    $('toastUndo').hidden = !undo;
    $('toastUndo').onclick = () => { $('toast').hidden = true; undo && undo(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, undo ? 6000 : 3500);
  }

  // ---------- Géocodage ----------
  function biasParams() {
    const p = state.start || state.stops[state.stops.length - 1];
    return p ? `&lat=${p.lat}&lon=${p.lon}` : '';
  }
  function photonLabel(p) {
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const first = p.name && p.name !== p.street ? p.name : street;
    const parts = [first, first === street ? '' : street, [p.postcode, p.city].filter(Boolean).join(' '), p.country !== 'France' ? p.country : ''];
    return parts.filter(Boolean).join(', ');
  }
  async function geoSearch(q, limit = 5) {
    if (state.settings.region === 'fr') {
      try {
        const r = await fetchJSON(`https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(q)}&limit=${limit}&autocomplete=1${biasParams()}`);
        const out = (r.features || []).map((f) => ({ label: f.properties.label, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], score: f.properties.score }));
        if (out.length) return out;
      } catch (e) { /* bascule sur Photon */ }
    }
    const r = await fetchJSON(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit}&lang=fr${biasParams()}`);
    return (r.features || []).map((f) => ({ label: photonLabel(f.properties), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
  }
  async function geoReverse(lat, lon) {
    try {
      const r = await fetchJSON(`https://data.geopf.fr/geocodage/reverse?lat=${lat}&lon=${lon}&limit=1`);
      if (r.features && r.features[0]) return r.features[0].properties.label;
    } catch (e) { /* bascule */ }
    try {
      const r = await fetchJSON(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=fr`);
      if (r.features && r.features[0]) return photonLabel(r.features[0].properties);
    } catch (e) { /* bascule */ }
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
        catch (e) { if (my === seq) { list.innerHTML = '<li class="info">Recherche impossible : vérifiez la connexion.</li>'; } }
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
    function pick(it) { close(); seq++; onPick(it); }
  }

  // ---------- Carte ----------
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([46.6, 2.4], 6);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© contributeurs OpenStreetMap',
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  let lastBoundsKey = '';

  map.on('click', async (e) => {
    const { lat, lng } = e.latlng;
    const pop = L.popup().setLatLng(e.latlng).setContent('<em>Recherche de l\'adresse…</em>').openOn(map);
    const label = await geoReverse(lat, lng);
    const div = document.createElement('div');
    div.innerHTML = `<strong>${esc(label)}</strong><br>`;
    const b = document.createElement('button');
    b.className = 'btn primary'; b.textContent = 'Ajouter cet arrêt';
    b.onclick = () => { addStop({ label, lat, lon: lng }); map.closePopup(pop); };
    const b2 = document.createElement('button');
    b2.className = 'btn ghost'; b2.textContent = 'Définir comme départ'; b2.style.marginLeft = '6px';
    b2.onclick = () => { setStart({ label, lat, lon: lng }); map.closePopup(pop); };
    div.append(b, b2);
    pop.setContent(div);
  });

  function icon(text, cls) {
    return L.divIcon({ className: '', html: `<div class="mk ${cls}">${esc(text)}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] });
  }

  function renderMap() {
    layer.clearLayers();
    const pts = [];
    if (state.start) {
      L.marker([state.start.lat, state.start.lon], { icon: icon('D', 'depot'), title: 'Départ' }).addTo(layer).bindPopup(`<strong>Départ</strong><br>${esc(state.start.label)}`);
      pts.push([state.start.lat, state.start.lon]);
    }
    if (state.settings.endMode === 'address' && state.end) {
      L.marker([state.end.lat, state.end.lon], { icon: icon('A', 'depot'), title: 'Arrivée' }).addTo(layer).bindPopup(`<strong>Arrivée</strong><br>${esc(state.end.label)}`);
      pts.push([state.end.lat, state.end.lon]);
    }
    const r = state.route;
    if (r && r.geometry && r.geometry.length > 1) {
      L.polyline(r.geometry, { color: '#B85A12', weight: 5, opacity: 0.85 }).addTo(layer);
    } else if (r) {
      // ordre modifié à la main : tracé simplifié en pointillés jusqu'à la prochaine optimisation
      const line = [r.start, ...r.order.map(stopById).filter(Boolean), r.endPt].filter(Boolean).map((p) => [p.lat, p.lon]);
      L.polyline(line, { color: '#B85A12', weight: 3, opacity: 0.8, dashArray: '6 8' }).addTo(layer);
    }
    const cur = currentStop();
    for (const s of state.stops) {
      const n = orderNumber(s.id);
      const cls = s.status === 'done' ? 'done' : s.status === 'failed' ? 'failed' : cur && cur.id === s.id ? 'cur' : n ? '' : 'unordered';
      const m = L.marker([s.lat, s.lon], { icon: icon(n || '•', cls), zIndexOffset: cls === 'cur' ? 1000 : 0 }).addTo(layer);
      m.on('click', () => openStopDialog(s.id));
      pts.push([s.lat, s.lon]);
    }
    const key = pts.map((p) => p.join(',')).join(';');
    if (pts.length && key !== lastBoundsKey) {
      lastBoundsKey = key;
      if (pts.length === 1) map.setView(pts[0], 15);
      else map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
    }
  }

  // ---------- Gestion des arrêts ----------
  function invalidateRoute() {
    state.route = null;
  }
  function addStop(p, extra = {}) {
    if (state.stops.some((s) => Math.abs(s.lat - p.lat) < 1e-6 && Math.abs(s.lon - p.lon) < 1e-6 && !extra.force)) {
      toast('Cette adresse est déjà dans la liste.');
    }
    const s = { id: uid(), label: p.label, lat: p.lat, lon: p.lon, note: extra.note || '', packages: 1, group: 1, after: '', before: '', service: null, status: 'pending' };
    state.stops.push(s);
    renderAll();
    if (!extra.silent) toast(`Arrêt ajouté (${state.stops.length})`);
    return s;
  }
  function setStart(p) {
    state.start = { label: p.label, lat: p.lat, lon: p.lon };
    $('startInput').value = '';
    invalidateRoute();
    renderAll();
  }

  function orderNumber(id) {
    if (!state.route) return null;
    const i = state.route.order.indexOf(id);
    return i < 0 ? null : i + 1;
  }
  function stopById(id) { return state.stops.find((s) => s.id === id); }
  function unorderedPending() {
    if (!state.route) return [];
    return state.stops.filter((s) => s.status === 'pending' && !state.route.order.includes(s.id));
  }
  function currentStop() {
    if (!state.route) return null;
    for (const id of state.route.order) { const s = stopById(id); if (s && s.status === 'pending') return s; }
    return null;
  }

  // ---------- Optimisation ----------
  function endPoint() {
    if (state.settings.endMode === 'start') return state.start;
    if (state.settings.endMode === 'address') return state.end;
    return null;
  }
  async function osrmTable(points) {
    const base = state.settings.osrm.replace(/\/+$/, '');
    const coords = points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const r = await fetchJSON(`${base}/table/v1/driving/${coords}?annotations=duration,distance`, 20000);
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
      const r = await fetchJSON(`${base}/route/v1/driving/${coords}?overview=full&geometries=geojson`, 20000);
      if (r.code !== 'Ok') throw new Error(r.code);
      for (const c of r.routes[0].geometry.coordinates) out.push([c[1], c[0]]);
    }
    return out;
  }

  async function optimize(fromHere) {
    const pending = state.stops.filter((s) => s.status === 'pending');
    let start = fromHere || state.start;
    if (!start) { toast('Indiquez d\'abord un point de départ.'); $('startInput').focus(); return; }
    if (!pending.length) { toast('Ajoutez au moins un arrêt.'); return; }
    if (state.settings.endMode === 'address' && !state.end) { toast('Indiquez l\'adresse d\'arrivée dans Réglages.'); return; }

    const btn = $('optimizeBtn');
    btn.disabled = true; btn.textContent = 'Calcul en cours…';
    try {
      const end = endPoint();
      const points = [start, ...pending];
      if (end) points.push(end);
      let mat, source = 'osrm';
      if (points.length <= 100) {
        try { mat = await osrmTable(points); } catch (e) { mat = null; }
      }
      if (!mat) { mat = Optimizer.estimateMatrix(points); source = 'estimate'; }

      const def = Number(state.settings.service) || 0;
      const stops = pending.map((s) => ({
        service: (s.service != null ? s.service : def) * 60,
        group: s.group, after: toSec(s.after), before: toSec(s.before),
      }));
      const startTime = fromHere ? nowSec() : toSec(state.settings.startTime) || 8 * 3600;
      const res = Optimizer.optimize({
        durations: mat.durations, stops, startTime,
        endIndex: end ? points.length - 1 : null,
        timeBudgetMs: Math.min(3000, 300 + pending.length * 25),
      });

      const done = state.route ? state.route.order.filter((id) => { const s = stopById(id); return s && s.status !== 'pending'; }) : state.stops.filter((s) => s.status !== 'pending').map((s) => s.id);
      const orderedPending = res.order.map((i) => pending[i - 1].id);
      let dist = 0, prev = 0;
      for (const i of res.order) { dist += mat.distances[prev][i]; prev = i; }
      if (end) dist += mat.distances[prev][points.length - 1];

      const etas = {};
      res.order.forEach((i, k) => { etas[pending[i - 1].id] = res.etas[k]; });
      const oldEtas = state.route ? state.route.etas : {};
      for (const id of done) etas[id] = oldEtas[id] ?? null;

      const seq = [start, ...res.order.map((i) => pending[i - 1])];
      if (end) seq.push(end);
      let geometry = seq.map((p) => [p.lat, p.lon]);
      if (source === 'osrm') { try { geometry = await osrmGeometry(seq); } catch (e) { /* lignes droites */ } }

      state.route = {
        order: [...done, ...orderedPending], etas, startTime, duration: res.duration, distance: dist,
        late: res.late, end: res.end, source, geometry, fromHere: !!fromHere,
        start: { lat: start.lat, lon: start.lon, label: start.label }, endPt: end ? { lat: end.lat, lon: end.lon } : null,
        // matrice gardée pour recalculer les heures après un déplacement manuel
        matrix: { ids: pending.map((s) => s.id), durations: mat.durations.map((row) => row.map((v) => Math.round(v))), endIndex: end ? points.length - 1 : null, startTime },
      };
      lastBoundsKey = '';
      renderAll();
      toast(source === 'osrm' ? `Tournée optimisée : ${fmtDur(res.duration)}, ${fmtKm(dist)}` : 'Tournée optimisée (temps estimés à vol d\'oiseau : serveur d\'itinéraire injoignable).');
      if (!fromHere) switchView('run');
    } catch (e) {
      console.error(e);
      toast('L\'optimisation a échoué. Réessayez.');
    } finally {
      btn.disabled = false; btn.textContent = state.route ? 'Réoptimiser la tournée' : 'Optimiser la tournée';
    }
  }

  function reoptimizeRemaining() {
    const handled = state.stops.filter((s) => s.status !== 'pending' && s.doneAt).sort((a, b) => b.doneAt - a.doneAt);
    if (handled.length) optimize({ label: handled[0].label, lat: handled[0].lat, lon: handled[0].lon });
    else optimize();
  }

  /** Après un déplacement manuel : recalcul des heures avec la matrice en mémoire. */
  function recomputeEtas() {
    const r = state.route;
    if (!r || !r.matrix) return;
    const mx = r.matrix;
    const idx = new Map(mx.ids.map((id, i) => [id, i + 1]));
    const seq = r.order.filter((id) => idx.has(id) && stopById(id));
    const def = Number(state.settings.service) || 0;
    const stops = mx.ids.map((id) => { const s = stopById(id) || {}; return { service: (s.service != null ? s.service : def) * 60, group: s.group, after: toSec(s.after), before: toSec(s.before) }; });
    const sch = Optimizer.schedule(seq.map((id) => idx.get(id)), { M: mx.durations, stops, startTime: mx.startTime, endIndex: mx.endIndex });
    seq.forEach((id, k) => { r.etas[id] = sch.etas[k]; });
    r.duration = sch.duration; r.late = sch.late; r.end = sch.end;
  }

  function moveInRoute(id, delta) {
    const r = state.route; if (!r) return;
    const i = r.order.indexOf(id), j = i + delta;
    if (j < 0 || j >= r.order.length) return;
    const other = stopById(r.order[j]);
    if (!other || other.status !== 'pending') return;
    [r.order[i], r.order[j]] = [r.order[j], r.order[i]];
    recomputeEtas();
    if (r.geometry) r.geometry = null;
    renderAll();
  }

  // ---------- Livraison ----------
  function mark(id, status, reason) {
    const s = stopById(id); if (!s) return;
    const prev = { status: s.status, failReason: s.failReason, doneAt: s.doneAt };
    s.status = status; s.failReason = reason || ''; s.doneAt = status === 'pending' ? null : Date.now();
    renderAll();
    const label = status === 'done' ? 'Livré' : `Échec : ${reason}`;
    toast(`${label} — ${s.label.split(',')[0]}`, () => { Object.assign(s, prev); renderAll(); });
  }
  function skip(id) {
    const r = state.route; if (!r) return;
    r.order.splice(r.order.indexOf(id), 1);
    r.order.push(id);
    recomputeEtas();
    r.geometry = null;
    renderAll();
    toast('Arrêt reporté en fin de tournée.');
  }
  function navUrl(s) {
    const ll = `${s.lat},${s.lon}`;
    switch (state.settings.navApp) {
      case 'waze': return `https://waze.com/ul?ll=${ll}&navigate=yes`;
      case 'apple': return `https://maps.apple.com/?daddr=${ll}&dirflg=d`;
      default: return `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`;
    }
  }

  // ---------- Rendu ----------
  function stopMetaHTML(s, withEta) {
    const bits = [];
    if (s.packages > 1) bits.push(`<span class="pill">${s.packages} colis</span>`);
    if (s.group === 0) bits.push('<span class="pill first">En premier</span>');
    if (s.group === 2) bits.push('<span class="pill last">En dernier</span>');
    if (s.after || s.before) bits.push(`<span class="pill window">${s.after ? 'après ' + s.after : ''}${s.after && s.before ? ' · ' : ''}${s.before ? 'avant ' + s.before : ''}</span>`);
    const eta = withEta && state.route ? state.route.etas[s.id] : null;
    if (eta != null && s.before && eta > toSec(s.before) && s.status === 'pending') bits.push('<span class="pill late">En retard</span>');
    if (s.status === 'failed') bits.push(`<span class="pill late">${esc(s.failReason || 'Échec')}</span>`);
    if (s.status === 'done') bits.push('<span class="pill ok">Livré</span>');
    if (s.note) bits.push(`<span>${esc(s.note)}</span>`);
    return bits.join('');
  }

  function renderPlan() {
    const startEl = $('startChosen');
    startEl.innerHTML = state.start ? `<strong>${esc(state.start.label)}</strong>` : 'Aucun départ choisi : saisissez une adresse ou touchez ◎.';
    const list = $('stopList');
    const ordered = state.route
      ? [...state.route.order.map(stopById).filter(Boolean), ...state.stops.filter((s) => !state.route.order.includes(s.id))]
      : state.stops;
    const totalPk = state.stops.reduce((a, s) => a + (Number(s.packages) || 1), 0);
    $('stopsTitle').textContent = state.stops.length ? `${state.stops.length} arrêt${state.stops.length > 1 ? 's' : ''} · ${totalPk} colis` : 'Arrêts';
    $('stopsEmpty').hidden = state.stops.length > 0;
    $('clearAll').hidden = state.stops.length === 0;
    list.innerHTML = ordered.map((s) => {
      const n = orderNumber(s.id);
      const cls = s.status !== 'pending' ? s.status : n ? '' : 'pending-unordered';
      const eta = state.route && state.route.etas[s.id] != null ? `<div class="eta">${fmtClock(state.route.etas[s.id])}<small>prévu</small></div>` : '<div></div>';
      return `<li class="stop" data-id="${s.id}">
        <span class="num ${cls}">${n || '•'}</span>
        <div class="stop-main" data-edit="${s.id}"><div class="stop-addr">${esc(s.label)}</div><div class="stop-meta">${stopMetaHTML(s, true)}</div></div>
        ${eta}
      </li>`;
    }).join('');
    const sum = $('routeSummary');
    if (state.route) {
      const r = state.route;
      sum.innerHTML = `<b>${fmtDur(r.duration)}</b> · <b>${fmtKm(r.distance)}</b> · fin vers <b>${fmtClock(r.end)}</b>${r.late > 0 ? ' · <span style="color:var(--bad)">créneau(x) dépassé(s)</span>' : ''}${r.source === 'estimate' ? '<br>Temps estimés à vol d\'oiseau' : ''}`;
      const extra = unorderedPending().length;
      if (extra) sum.innerHTML += `<br><b>${extra}</b> nouvel${extra > 1 ? 's' : ''} arrêt${extra > 1 ? 's' : ''} hors tournée : réoptimisez.`;
      $('optimizeBtn').textContent = 'Réoptimiser la tournée';
    } else {
      sum.textContent = state.stops.length ? 'L\'ordre actuel est celui de la saisie.' : '';
      $('optimizeBtn').textContent = 'Optimiser la tournée';
    }
  }

  function renderRun() {
    const card = $('currentCard');
    const list = $('runList');
    const r = state.route;
    const total = state.stops.length;
    const done = state.stops.filter((s) => s.status === 'done').length;
    const failed = state.stops.filter((s) => s.status === 'failed').length;
    $('progressBar').style.width = total ? `${((done + failed) / total) * 100}%` : '0';
    $('progressText').textContent = total ? `${done} livré${done > 1 ? 's' : ''} · ${failed} échec${failed > 1 ? 's' : ''} · ${total - done - failed} restant${total - done - failed > 1 ? 's' : ''}` : '';

    if (!r) {
      card.innerHTML = `<div class="card"><div class="card-addr">Pas encore de tournée</div><div class="card-sub">Ajoutez vos arrêts dans « Préparer », puis touchez « Optimiser la tournée ».</div><button class="btn primary" type="button" data-go="plan">Préparer la tournée</button></div>`;
      list.innerHTML = '';
      return;
    }
    const cur = currentStop();
    const extra = unorderedPending();
    const banner = extra.length
      ? `<div class="card-note row-actions">${extra.length} arrêt${extra.length > 1 ? 's' : ''} ajouté${extra.length > 1 ? 's' : ''} hors tournée.<button class="btn primary" type="button" data-act="reopt">Les intégrer</button></div>`
      : '';
    if (cur) {
      const n = orderNumber(cur.id);
      const eta = r.etas[cur.id];
      card.innerHTML = `<div class="card">
        <div class="card-top"><span class="num">${n}</span>
          <div style="min-width:0"><div class="card-addr">${esc(cur.label)}</div>
          <div class="card-sub">Arrivée prévue ${fmtClock(eta)} · ${cur.packages} colis${cur.before ? ' · avant ' + cur.before : ''}${cur.after ? ' · après ' + cur.after : ''}</div></div></div>
        ${cur.note ? `<div class="card-note">${esc(cur.note)}</div>` : ''}
        <div class="card-actions">
          <a class="btn primary nav" href="${navUrl(cur)}" target="_blank" rel="noopener">Naviguer</a>
          <button class="btn ok" type="button" data-act="done" data-id="${cur.id}">Livré</button>
          <button class="btn bad" type="button" data-act="fail" data-id="${cur.id}">Échec</button>
          <button class="btn ghost wide" type="button" data-act="skip" data-id="${cur.id}">Passer pour l'instant</button>
        </div></div>${banner}`;
    } else if (extra.length) {
      card.innerHTML = banner;
    } else {
      card.innerHTML = `<div class="card done-card"><div class="big-num">${done}/${total}</div><div class="card-addr">Tournée terminée</div><div class="card-sub">${failed ? `${failed} colis à rapporter.` : 'Tous les colis ont été livrés.'}</div></div>`;
    }
    list.innerHTML = r.order.map((id, k) => {
      const s = stopById(id); if (!s) return '';
      const isCur = cur && cur.id === id;
      const cls = s.status !== 'pending' ? s.status : '';
      const canMove = s.status === 'pending' && !isCur;
      return `<li class="stop ${isCur ? 'is-current' : ''} ${s.status !== 'pending' ? 'is-done' : ''}">
        <span class="num ${cls}">${k + 1}</span>
        <div class="stop-main" data-edit="${s.id}"><div class="stop-addr">${esc(s.label)}</div><div class="stop-meta">${s.status === 'pending' ? `<span>${fmtClock(r.etas[id])}</span>` : ''}${stopMetaHTML(s, true)}</div></div>
        ${canMove ? `<div class="move"><button type="button" aria-label="Monter" data-move="-1" data-id="${id}">▲</button><button type="button" aria-label="Descendre" data-move="1" data-id="${id}">▼</button></div>` : s.status !== 'pending' ? `<button class="btn link" type="button" data-act="reset" data-id="${id}">Rétablir</button>` : '<div></div>'}
      </li>`;
    }).join('');
  }

  function renderTop() {
    const r = state.route;
    const remaining = state.stops.filter((s) => s.status === 'pending').length;
    $('topStats').innerHTML = r
      ? `<span><b>${remaining}</b>restants</span><span><b>${fmtKm(r.distance)}</b></span><span><b>${fmtClock(r.end)}</b>fin</span>`
      : `<span><b>${state.stops.length}</b>arrêts</span>`;
  }

  function renderSettings() {
    const st = state.settings;
    $('setStartTime').value = st.startTime;
    $('setService').value = st.service;
    $('setOsrm').value = st.osrm;
    for (const name of ['endMode', 'navApp', 'region']) {
      document.querySelectorAll(`input[name="${name}"]`).forEach((i) => { i.checked = i.value === st[name]; });
    }
    $('endWrap').hidden = st.endMode !== 'address';
    $('endChosen').innerHTML = st.endMode === 'address' ? (state.end ? `<strong>${esc(state.end.label)}</strong>` : 'Aucune adresse d\'arrivée.') : '';
  }

  function renderAll() {
    renderPlan(); renderRun(); renderTop(); renderMap(); save();
  }

  function switchView(v) {
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === v)));
    for (const name of ['plan', 'run', 'settings']) $(`view-${name}`).hidden = name !== v;
    setTimeout(() => map.invalidateSize(), 50);
  }

  // ---------- Modales ----------
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
    document.querySelectorAll('input[name="fGroup"]').forEach((i) => { i.checked = Number(i.value) === s.group; });
    $('stopDialog').showModal();
  }
  $('stopDialog').addEventListener('close', () => {
    const s = stopById(editingId); const v = $('stopDialog').returnValue;
    if (!s) return;
    if (v === 'delete') {
      const idx = state.stops.indexOf(s);
      state.stops.splice(idx, 1);
      const routeBackup = state.route;
      if (state.route) { state.route.order = state.route.order.filter((x) => x !== s.id); state.route.geometry = null; }
      renderAll();
      toast('Arrêt supprimé.', () => { state.stops.splice(idx, 0, s); state.route = routeBackup; if (routeBackup && !routeBackup.order.includes(s.id)) routeBackup.order.push(s.id); renderAll(); });
    } else if (v === 'save') {
      const g = Number(document.querySelector('input[name="fGroup"]:checked').value);
      const constraintsChanged = g !== s.group || $('fAfter').value !== s.after || $('fBefore').value !== s.before;
      s.note = $('fNote').value.trim();
      s.packages = Math.max(1, Number($('fPackages').value) || 1);
      s.service = $('fService').value === '' ? null : Number($('fService').value);
      s.after = $('fAfter').value; s.before = $('fBefore').value; s.group = g;
      recomputeEtas();
      renderAll();
      if (constraintsChanged && state.route) toast('Contraintes modifiées : réoptimisez pour en tenir compte.');
    }
    editingId = null;
  });

  let failId = null;
  $('failDialog').addEventListener('close', () => {
    const v = $('failDialog').returnValue;
    if (failId && v && v !== 'cancel') mark(failId, 'failed', v);
    failId = null;
  });

  $('bulkOpen').addEventListener('click', () => { $('bulkStatus').textContent = ''; $('bulkDialog').showModal(); $('bulkText').focus(); });
  $('bulkGo').addEventListener('click', async () => {
    const lines = $('bulkText').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const btn = $('bulkGo'); btn.disabled = true;
    const missed = [];
    let ok = 0;
    for (let i = 0; i < lines.length; i++) {
      const [addr, ...noteParts] = lines[i].split(';');
      $('bulkStatus').textContent = `Recherche ${i + 1}/${lines.length}…`;
      try {
        const res = await geoSearch(addr.trim(), 1);
        if (res[0]) { addStop(res[0], { note: noteParts.join(';').trim(), silent: true, force: true }); ok++; }
        else missed.push(lines[i]);
      } catch (e) { missed.push(lines[i]); }
      if (state.settings.region !== 'fr') await new Promise((r) => setTimeout(r, 250));
    }
    btn.disabled = false;
    $('bulkText').value = missed.join('\n');
    $('bulkStatus').innerHTML = `${ok} adresse${ok > 1 ? 's' : ''} ajoutée${ok > 1 ? 's' : ''}.` + (missed.length ? ` <span class="err">${missed.length} introuvable${missed.length > 1 ? 's' : ''} : corrigez-les ci-dessus puis réessayez.</span>` : '');
    if (!missed.length) setTimeout(() => $('bulkDialog').close(), 900);
  });

  // ---------- Événements ----------
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  attachSearch($('startInput'), $('startSuggest'), setStart);
  attachSearch($('stopInput'), $('stopSuggest'), (it) => { addStop(it); $('stopInput').value = ''; $('stopInput').focus(); });
  attachSearch($('endInput'), $('endSuggest'), (it) => { state.end = { label: it.label, lat: it.lat, lon: it.lon }; $('endInput').value = ''; invalidateRoute(); renderSettings(); renderAll(); });

  function locate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Géolocalisation indisponible'));
      navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }), reject, { enableHighAccuracy: true, timeout: 10000 });
    });
  }
  $('startGps').addEventListener('click', async () => {
    try {
      const p = await locate();
      setStart({ label: await geoReverse(p.lat, p.lon), lat: p.lat, lon: p.lon });
    } catch (e) { toast('Position introuvable : autorisez la localisation ou saisissez l\'adresse.'); }
  });
  $('reoptHere').addEventListener('click', async () => {
    try {
      const p = await locate();
      await optimize({ label: 'Ma position', lat: p.lat, lon: p.lon });
    } catch (e) { toast('Position introuvable : autorisez la localisation.'); }
  });

  $('optimizeBtn').addEventListener('click', () => (state.stops.some((s) => s.status !== 'pending') ? reoptimizeRemaining() : optimize()));
  $('clearAll').addEventListener('click', () => {
    const backup = JSON.parse(JSON.stringify(state));
    state.stops = []; state.route = null;
    renderAll();
    toast('Tous les arrêts ont été effacés.', () => { state = backup; renderAll(); });
  });

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
    if (a.dataset.act === 'done') mark(id, 'done');
    else if (a.dataset.act === 'fail') { failId = id; $('failDialog').showModal(); }
    else if (a.dataset.act === 'skip') skip(id);
    else if (a.dataset.act === 'reopt') reoptimizeRemaining();
    else if (a.dataset.act === 'reset') { const s = stopById(id); s.status = 'pending'; s.failReason = ''; s.doneAt = null; renderAll(); }
  });

  // Réglages
  $('setStartTime').addEventListener('change', (e) => { state.settings.startTime = e.target.value || '08:00'; save(); });
  $('setService').addEventListener('change', (e) => { state.settings.service = Math.max(0, Number(e.target.value) || 0); save(); });
  $('setOsrm').addEventListener('change', (e) => { state.settings.osrm = e.target.value.trim() || DEFAULT_SETTINGS.osrm; save(); });
  document.querySelectorAll('input[name="endMode"], input[name="navApp"], input[name="region"]').forEach((i) => i.addEventListener('change', () => {
    state.settings[i.name] = i.value;
    if (i.name === 'endMode') invalidateRoute();
    renderSettings(); renderAll();
  }));

  // Export CSV
  $('exportCsv').addEventListener('click', () => {
    const r = state.route;
    const order = r ? r.order : state.stops.map((s) => s.id);
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Ordre', 'Adresse', 'Statut', 'Motif', 'Heure prévue', 'Heure réelle', 'Colis', 'Note', 'Latitude', 'Longitude']];
    order.forEach((id, k) => {
      const s = stopById(id); if (!s) return;
      const real = s.doneAt ? new Date(s.doneAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
      const st = { pending: 'À livrer', done: 'Livré', failed: 'Échec' }[s.status];
      rows.push([k + 1, s.label, st, s.failReason, r ? fmtClock(r.etas[id]) : '', real, s.packages, s.note, s.lat, s.lon]);
    });
    const csv = '﻿' + rows.map((row) => row.map(q).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `tournee-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // Tournée d'exemple (adresses réelles de Lyon, coordonnées approximatives)
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
    state.stops = demo.map(([label, lat, lon]) => ({ id: uid(), label, lat, lon, note: '', packages: 1, group: 1, after: '', before: '', service: null, status: 'pending' }));
    state.stops[3].note = 'Exemple : point relais, demander l\'accueil';
    state.stops[3].packages = 4;
    state.stops[4].before = '09:30';
    state.stops[6].group = 2;
    state.route = null; lastBoundsKey = '';
    renderSettings(); renderAll();
    switchView('plan');
    toast('Tournée d\'exemple chargée : touchez « Optimiser la tournée ».');
  });

  // ---------- Démarrage ----------
  renderSettings();
  renderAll();
  if (state.route) switchView('run');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Exposé pour les tests
  window.CapColis = { get state() { return state; }, optimize };
})();

/*
 * Cap Colis : moteur d'optimisation de tournée.
 * Pur JavaScript, sans dépendance : fonctionne dans le navigateur (window.Optimizer)
 * et dans Node (module.exports) pour les tests.
 *
 * Modèle :
 *  - matrice de durées (secondes) asymétrique, index 0 = départ,
 *    1..n = arrêts, n+1 = arrivée (optionnelle).
 *  - chaque arrêt peut avoir : service (s), after / before (secondes depuis minuit),
 *    group : 0 = en premier, 1 = normal, 2 = en dernier.
 *  - coût = durée totale de tournée + pénalités (retard, ordre de priorité).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Optimizer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LATE_PENALTY = 20;        // 1 s de retard coûte 20 s
  const GROUP_PENALTY = 1e7;      // violer « en premier / en dernier » est quasi interdit

  const R = 6371000;
  function haversine(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /** Matrice estimée à vol d'oiseau quand le serveur de routage est indisponible. */
  function estimateMatrix(points, speedKmh = 30, detour = 1.35) {
    const n = points.length;
    const durations = [];
    const distances = [];
    for (let i = 0; i < n; i++) {
      durations.push(new Array(n).fill(0));
      distances.push(new Array(n).fill(0));
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const d = haversine(points[i], points[j]) * detour;
        distances[i][j] = d;
        durations[i][j] = d / (speedKmh / 3.6);
      }
    }
    return { durations, distances };
  }

  /**
   * Évalue un ordre de passage.
   * @param {number[]} order indices d'arrêts (1..n) dans l'ordre de visite
   * @param {object} ctx { M, stops, startTime, endIndex|null }
   */
  function evaluate(order, ctx) {
    const { M, stops, startTime, endIndex } = ctx;
    let t = startTime;
    let prev = 0;
    let penalty = 0;
    let lastGroup = 0;
    let late = 0;
    let wait = 0;
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const s = stops[i - 1];
      t += M[prev][i];
      if (s.after != null && t < s.after) { wait += s.after - t; t = s.after; }
      if (s.before != null && t > s.before) { late += t - s.before; }
      const g = s.group == null ? 1 : s.group;
      if (g < lastGroup) penalty += GROUP_PENALTY * (lastGroup - g);
      lastGroup = Math.max(lastGroup, g);
      t += s.service || 0;
      prev = i;
    }
    if (endIndex != null) t += M[prev][endIndex];
    const duration = t - startTime;
    return { cost: duration + late * LATE_PENALTY + penalty, duration, late, wait, end: t };
  }

  /** Construction gloutonne : plus proche voisin pondéré par priorité et urgence des créneaux. */
  function greedy(ctx) {
    const { M, stops, startTime } = ctx;
    const left = new Set(stops.map((_, i) => i + 1));
    const order = [];
    let prev = 0;
    let t = startTime;
    while (left.size) {
      let minGroup = 3;
      for (const i of left) minGroup = Math.min(minGroup, stops[i - 1].group ?? 1);
      let best = -1;
      let bestScore = Infinity;
      for (const i of left) {
        const s = stops[i - 1];
        if ((s.group ?? 1) !== minGroup) continue;
        let arr = t + M[prev][i];
        let score = M[prev][i];
        if (s.after != null && arr < s.after) score += (s.after - arr) * 0.7;
        if (s.before != null) {
          const slack = s.before - arr;
          if (slack < 0) score += -slack * LATE_PENALTY;
          else score -= Math.max(0, 3600 - slack) * 0.3; // créneau qui se ferme bientôt
        }
        if (score < bestScore) { bestScore = score; best = i; }
      }
      const s = stops[best - 1];
      t += M[prev][best];
      if (s.after != null && t < s.after) t = s.after;
      t += s.service || 0;
      order.push(best);
      left.delete(best);
      prev = best;
    }
    return order;
  }

  /** Recherche locale : 2-opt + déplacement de segments (Or-opt 1..3) jusqu'à stabilité. */
  function improve(order, ctx, deadline) {
    let best = order.slice();
    let bestCost = evaluate(best, ctx).cost;
    const n = best.length;
    let improved = true;
    while (improved && Date.now() < deadline) {
      improved = false;
      // 2-opt (inversion d'un sous-segment)
      for (let i = 0; i < n - 1 && Date.now() < deadline; i++) {
        for (let j = i + 1; j < n; j++) {
          const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
          const c = evaluate(cand, ctx).cost;
          if (c < bestCost - 1e-6) { best = cand; bestCost = c; improved = true; }
        }
      }
      // Or-opt : déplacer un segment de 1 à 3 arrêts ailleurs
      for (let len = 1; len <= 3; len++) {
        for (let i = 0; i + len <= n && Date.now() < deadline; i++) {
          const seg = best.slice(i, i + len);
          const rest = best.slice(0, i).concat(best.slice(i + len));
          for (let j = 0; j <= rest.length; j++) {
            if (j === i) continue;
            const cand = rest.slice(0, j).concat(seg, rest.slice(j));
            const c = evaluate(cand, ctx).cost;
            if (c < bestCost - 1e-6) { best = cand; bestCost = c; improved = true; break; }
          }
        }
      }
    }
    return best;
  }

  /** Perturbation légère (double-bridge) pour sortir d'un optimum local. */
  function perturb(order, rnd) {
    const n = order.length;
    if (n < 8) {
      const a = order.slice();
      const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n);
      [a[i], a[j]] = [a[j], a[i]];
      return a;
    }
    const p = [1 + Math.floor(rnd() * (n / 4)), 0, 0];
    p[1] = p[0] + 1 + Math.floor(rnd() * (n / 4));
    p[2] = p[1] + 1 + Math.floor(rnd() * (n / 4));
    return order.slice(0, p[0]).concat(order.slice(p[2]), order.slice(p[1], p[2]), order.slice(p[0], p[1]));
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Optimise la tournée.
   * @param {object} p { durations, stops, startTime, endIndex, timeBudgetMs }
   * @returns {{order:number[], etas:number[], duration:number, late:number, wait:number}}
   */
  function optimize(p) {
    const ctx = { M: p.durations, stops: p.stops, startTime: p.startTime || 0, endIndex: p.endIndex ?? null };
    if (!p.stops.length) return { order: [], etas: [], duration: 0, late: 0, wait: 0 };
    const budget = p.timeBudgetMs ?? 1500;
    const deadline = Date.now() + budget;
    let best = improve(greedy(ctx), ctx, deadline);
    let bestCost = evaluate(best, ctx).cost;
    const rnd = mulberry32(42);
    // Recherche locale itérée tant qu'il reste du temps
    while (Date.now() < deadline && best.length > 3) {
      const cand = improve(perturb(best, rnd), ctx, deadline);
      const c = evaluate(cand, ctx).cost;
      if (c < bestCost - 1e-6) { best = cand; bestCost = c; }
    }
    return schedule(best, ctx);
  }

  /** Calcule les heures d'arrivée prévues pour un ordre donné. */
  function schedule(order, ctx) {
    const { M, stops, startTime, endIndex } = ctx;
    const etas = [];
    let t = startTime;
    let prev = 0;
    for (const i of order) {
      const s = stops[i - 1];
      t += M[prev][i];
      if (s.after != null && t < s.after) t = s.after;
      etas.push(t);
      t += s.service || 0;
      prev = i;
    }
    const ev = evaluate(order, ctx);
    return { order, etas, duration: ev.duration, late: ev.late, wait: ev.wait, end: ev.end, endIndex };
  }

  return { optimize, evaluate, schedule, estimateMatrix, haversine, greedy };
});

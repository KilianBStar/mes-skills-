// Lancer : node --test cap-colis/tests
const test = require('node:test');
const assert = require('node:assert');
const O = require('../optimizer.js');

function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }
function scenario(n, seed = 7) {
  const r = rng(seed);
  const pts = [{ lat: 48.85, lon: 2.35 }];
  for (let i = 0; i < n; i++) pts.push({ lat: 48.80 + r() * 0.1, lon: 2.28 + r() * 0.14 });
  const { durations } = O.estimateMatrix(pts);
  const stops = pts.slice(1).map(() => ({ service: 120, group: 1 }));
  return { pts, durations, stops };
}

test('visite chaque arrêt exactement une fois', () => {
  const { durations, stops } = scenario(40);
  const res = O.optimize({ durations, stops, startTime: 8 * 3600, endIndex: 0, timeBudgetMs: 400 });
  assert.deepStrictEqual([...res.order].sort((a, b) => a - b), stops.map((_, i) => i + 1));
  assert.strictEqual(res.etas.length, 40);
});

test("bat nettement l'ordre de saisie", () => {
  const { durations, stops } = scenario(60);
  const ctx = { M: durations, stops, startTime: 0, endIndex: 0 };
  const naive = O.evaluate(stops.map((_, i) => i + 1), ctx).duration;
  const res = O.optimize({ durations, stops, startTime: 0, endIndex: 0, timeBudgetMs: 800 });
  assert.ok(res.duration < naive * 0.6, `optimisé ${res.duration} vs naïf ${naive}`);
});

test('respecte « en premier » et « en dernier »', () => {
  const { durations, stops } = scenario(20);
  stops[5].group = 2; stops[12].group = 0; stops[3].group = 0;
  const res = O.optimize({ durations, stops, startTime: 0, endIndex: null, timeBudgetMs: 300 });
  assert.deepStrictEqual(new Set(res.order.slice(0, 2)), new Set([13, 4]));
  assert.strictEqual(res.order[res.order.length - 1], 6);
});

test('respecte un créneau « avant 8h20 »', () => {
  const { durations, stops } = scenario(25);
  stops[17].before = 8 * 3600 + 20 * 60;
  const res = O.optimize({ durations, stops, startTime: 8 * 3600, endIndex: 0, timeBudgetMs: 300 });
  assert.strictEqual(res.late, 0);
  const pos = res.order.indexOf(18);
  assert.ok(res.etas[pos] <= stops[17].before);
});

test('attend l\'ouverture d\'un créneau « après »', () => {
  const { durations, stops } = scenario(3);
  stops[0].after = 10 * 3600;
  const res = O.optimize({ durations, stops, startTime: 8 * 3600, endIndex: null, timeBudgetMs: 100 });
  const pos = res.order.indexOf(1);
  assert.ok(res.etas[pos] >= 10 * 3600);
});

test('150 arrêts en moins de 3 s', () => {
  const { durations, stops } = scenario(150);
  const t0 = Date.now();
  const res = O.optimize({ durations, stops, startTime: 0, endIndex: 0, timeBudgetMs: 2000 });
  assert.ok(Date.now() - t0 < 3000);
  assert.strictEqual(new Set(res.order).size, 150);
});

// node --test cap-colis/tests/postcodes.test.js
const test = require('node:test');
const assert = require('node:assert');
const P = require('../postcodes-be.js');

test('ville manquante : la commune du code postal', () => {
  assert.strictEqual(P.cityFor('6200', ''), 'Châtelet');
  assert.strictEqual(P.cityFor('6220', ''), 'Fleurus');
});
test('ville mal lue : la localité la plus proche', () => {
  assert.strictEqual(P.cityFor('6200', 'CHATELE TE'), 'Châtelet');
  assert.strictEqual(P.cityFor('6200', 'CHATELINEAU'), 'Châtelineau');
  assert.strictEqual(P.cityFor('6224', 'wanfercee baulet'), 'Wanfercée-Baulet');
});
test('plusieurs localités pour un code postal', () => {
  assert.deepStrictEqual(P.localities('6200'), ['Châtelet', 'Bouffioulx', 'Châtelineau']);
  assert.deepStrictEqual(P.localities('9999'), []);
});

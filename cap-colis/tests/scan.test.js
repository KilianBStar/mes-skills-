// node --test cap-colis/tests/scan.test.js
const test = require('node:test');
const assert = require('node:assert');
const S = require('../scan.js');
const addrs = (t) => S.extractAddresses(t).map((r) => r.address);

test('étiquette colis sur plusieurs lignes', () => {
  const r = S.extractAddresses(`DESTINATAIRE :\nMme Claire MARTIN\n12 rue Mercière\nBât B, 3e étage\n69002 LYON\nFRANCE\nTél : 06 12 34 56 78\nPoids 1,2 kg`);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].address, '12 rue Mercière, 69002 LYON');
  assert.match(r[0].note, /Claire MARTIN/);
  assert.match(r[0].note, /Bât B/);
  assert.match(r[0].note, /06 12 34 56 78/);
  assert.ok(r[0].sure);
});

test('manifeste en tableau, une ligne par colis', () => {
  const t = `MANIFESTE TOURNEE 14/11\nN° Destinataire Adresse CP Ville Colis\n1 DUPONT Jean 12 rue Mercière 69002 LYON 2\n2 BERNARD Ali 45 avenue Jean Jaurès 69007 Lyon 1\n3 PETIT Léa 3 bis bd de la Croix-Rousse 69004 LYON 1\n4 ROUX Marc 8 place Guichard 69003 LYON 3`;
  assert.deepStrictEqual(addrs(t), [
    '12 rue Mercière, 69002 LYON', '45 avenue Jean Jaurès, 69007 Lyon',
    '3 bis bd de la Croix-Rousse, 69004 LYON', '8 place Guichard, 69003 LYON',
  ]);
  assert.match(S.extractAddresses(t)[0].note, /DUPONT Jean/);
});

test('erreurs OCR dans le code postal', () => {
  assert.deepStrictEqual(addrs('5 rue de la Paix 75OO2 PARIS'), ['5 rue de la Paix, 75002 PARIS']);
  assert.deepStrictEqual(addrs('7 allée des Pins 33l00 Bordeaux'), ['7 allée des Pins, 33100 Bordeaux']);
});

test('ville sur la ligne suivante', () => {
  assert.deepStrictEqual(addrs('22 chemin du Moulin 13100\nAix-en-Provence'), ['22 chemin du Moulin, 13100 Aix-en-Provence']);
});

test('pas de doublons, pas de faux positifs', () => {
  const t = 'Commande 123456789\nRéf 45000\n10 rue Victor Hugo 59000 Lille\n10 rue Victor Hugo 59000 Lille\nTotal 3 colis';
  assert.deepStrictEqual(addrs(t), ['10 rue Victor Hugo, 59000 Lille']);
});

test('rue sans code postal marquée à vérifier', () => {
  const r = S.extractAddresses('14 impasse des Lilas');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].sure, false);
});

test('texte collé simple : une adresse par ligne', () => {
  const r = S.parsePasted('Mairie de Villeurbanne ; accueil\nGare Part-Dieu');
  assert.deepStrictEqual(r.map((x) => x.address), ['Mairie de Villeurbanne', 'Gare Part-Dieu']);
  assert.strictEqual(r[0].note, 'accueil');
});

test('manifeste lu par OCR : le téléphone reste sur sa ligne', () => {
  const t = `1 DUPONT Jean 12 rue Mercière 69002 LYON 2 06 12 34 56 78\n2 BERNARD Ali 45 avenue Jean Jaurès 69007 LYON 1 107 81 22 10 45\nGARCIA Inès rue de Créqui 69006 LYON 1`;
  const r = S.extractAddresses(t);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[1].note, 'BERNARD Ali · Tél. 07 81 22 10 45');
  assert.strictEqual(r[2].sure, false, 'rue sans numéro à vérifier');
});

test('reconstruction des lignes d\'une photo inclinée', () => {
  const W = (text, x0, y0) => ({ text, confidence: 90, bbox: { x0, y0, x1: x0 + text.length * 10, y1: y0 + 20 } });
  // pente 0,05 : chaque mot descend de 5 px tous les 100 px
  const words = [W('12', 0, 100), W('rue', 30, 101), W('Mercière', 70, 104), W('69002', 300, 115), W('LYON', 360, 118),
    W('8', 0, 140), W('place', 20, 141), W('Guichard', 80, 144), W('69003', 300, 155), W('LYON', 360, 158), W('|', 200, 120)];
  const lines = [{ baseline: { x0: 0, y0: 120, x1: 400, y1: 140 } }];
  assert.strictEqual(S.rowsFromWords(words, lines), '12 rue Mercière 69002 LYON\n8 place Guichard 69003 LYON');
});

test("estime l'inclinaison d'une photo de document", () => {
  const w = 400, h = 300;
  for (const deg of [-7, -3, 0, 4]) {
    const g = new Uint8ClampedArray(w * h).fill(255);
    const t = Math.tan((deg * Math.PI) / 180);
    for (let line = 0; line < 8; line++) {
      for (let x = 20; x < 380; x++) {
        if (x % 13 > 9) continue; // espaces entre lettres
        const y0 = Math.round(40 + line * 30 + x * t);
        for (let dy = 0; dy < 6; dy++) if (y0 + dy >= 0 && y0 + dy < h) g[(y0 + dy) * w + x] = 0;
      }
    }
    const est = S.estimateSkew(g, w, h);
    assert.ok(Math.abs(est - deg) <= 0.6, `attendu ${deg}°, estimé ${est}°`);
  }
});

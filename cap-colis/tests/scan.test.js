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

// ---------- Belgique (noms inventés, formats copiés sur des étiquettes Colis Privé) ----------
test('liste de tournée du terminal (Belgique)', () => {
  const t = `TOTAL P1 RELAIS LOCKER COLLECTE\nCHARGÉS 156 156 19 0\nMARC DURAND\nRUE DES ÉRABLES 22\n6061 MONTIGNIES-SUR-SAMBRE\nNombre de colis : 1\nType : DOMICILE\nLINA PEETERS\nRUE DU MOULIN 52\n6061 CHARLEROI\nNombre de colis : 2\nType : DOMICILE\nINCONNU\n6061 MONTIGNIES-SUR-SAMBRE\nNombre de colis : 1\nType : DOMICILE`;
  const r = S.extractAddresses(t);
  assert.deepStrictEqual(r.map((x) => x.address), ['RUE DES ÉRABLES 22, 6061 MONTIGNIES-SUR-SAMBRE', 'RUE DU MOULIN 52, 6061 CHARLEROI', '6061 MONTIGNIES-SUR-SAMBRE']);
  assert.strictEqual(r[0].note, 'MARC DURAND');
  assert.strictEqual(r[1].packages, 2);
  assert.strictEqual(r[1].country, 'BE');
  assert.ok(r[0].sure);
  assert.ok(r[2].incomplete, 'INCONNU : rue manquante');
});

test('étiquette Amazon : ville avant le code postal, expéditeur ignoré', () => {
  const t = `colis privé SAME\n40 6060\nAmazon Returns\nSchoondonkweg 4\nWillebroek Belgium 2830\nBelgium\nSHIP TO:\nMARTIN\nRue de la Gare 2\nChâtelineau 6200\nBelgium\n04/11/2026\n780018700000B6200`;
  const r = S.extractAddresses(t);
  assert.deepStrictEqual(r.map((x) => x.address), ['Rue de la Gare 2, 6200 Châtelineau']);
  assert.strictEqual(r[0].note, 'MARTIN');
});

test('numéro avec boîte et virgule (25/1/1, 27/6)', () => {
  const a = S.extractAddresses('SHIP TO:\nlambert paul\nrue des Tilleuls, 25/1/1\nChâtelineau 6200\nBelgium');
  assert.strictEqual(a[0].address, 'rue des Tilleuls 25, 6200 Châtelineau');
  assert.match(a[0].note, /Boîte 1\/1/);
  const b = S.extractAddresses('ANNE DUBOIS\nRUE DE LA FONTAINE 27/6\n6200 CHATELET\nBELGIQUE\nTEL : 0470123456');
  assert.strictEqual(b[0].address, 'RUE DE LA FONTAINE 27, 6200 CHATELET');
  assert.match(b[0].note, /Boîte 6/);
  assert.match(b[0].note, /0470123456/);
});

test('étiquette 24H domicile : code de tri « 40 6040 NEXT » ignoré', () => {
  const t = `Expéditeur :\nATLAS (QM05)\n33 BD DE LA HAIE\n35136 ST JACQUES DE LA LANDE\nBE 40 6040 NEXT\nPAUL LEROY\n43 RUE DES ÉCOLES\n6142 LEERNES\nBELGIQUE\nTEL : 0485000000\nRéf : 7035407001\nPoids : 1044 grs\nEditée le : 27/10/2026`;
  const r = S.extractAddresses(t);
  assert.deepStrictEqual(r.map((x) => x.address), ['43 RUE DES ÉCOLES, 6142 LEERNES']);
  assert.match(r[0].note, /PAUL LEROY/);
});

test('code postal répété autour de la ville (6142 leernes 6142)', () => {
  const r = S.extractAddresses('SHIP TO:\nsimon julie\nrue des Prés 32\n6142 leernes 6142\nBelgium');
  assert.deepStrictEqual(r.map((x) => x.address), ['rue des Prés 32, 6142 leernes']);
});

test('pays deviné à partir du code postal', () => {
  assert.strictEqual(S.guessCountry('Rue de la Gare 2, 6200 Châtelineau'), 'BE');
  assert.strictEqual(S.guessCountry('12 rue Mercière, 69002 Lyon'), 'FR');
  assert.strictEqual(S.guessCountry('Gare Part-Dieu'), '');
});

test("repère l'étiquette blanche sur le carton", () => {
  const w = 300, h = 200;
  const g = new Uint8ClampedArray(w * h).fill(120); // carton
  for (let y = 60; y < 150; y++) for (let x = 100; x < 260; x++) g[y * w + x] = (x % 9 === 0 && y % 7 < 3) ? 20 : 240; // étiquette + texte
  const r = S.findBrightRegion(g, w, h);
  assert.ok(r && r.x <= 100 && r.x >= 90 && r.y <= 60 && r.x + r.w >= 259 && r.y + r.h >= 149, JSON.stringify(r));
  assert.strictEqual(S.findBrightRegion(new Uint8ClampedArray(w * h).fill(240), w, h), null, 'feuille plein cadre : pas de recadrage');
});

test('bruit OCR après le numéro (format belge) coupé', () => {
  const r = S.extractAddresses('SHIP TO:\nmartin\nRue de la Gare 2 Fee are mer re\nChâtelineau 6200');
  assert.strictEqual(r[0].address, 'Rue de la Gare 2, 6200 Châtelineau');
  const b = S.extractAddresses('ANNE DUBOIS\nRUE DE LA FONTAINE 27/5 (À\n6200 CHATELET');
  assert.strictEqual(b[0].address, 'RUE DE LA FONTAINE 27, 6200 CHATELET');
  assert.match(b[0].note, /Boîte 5/);
  const c = S.extractAddresses('12 rue Mercière 69002 LYON');
  assert.strictEqual(c[0].address, '12 rue Mercière, 69002 LYON', 'format français intact');
});

test('rue en un mot avec tiret (Grand-Rue)', () => {
  const r = S.extractAddresses('HUGO MAES\nGRAND-RUE 54\n6200 CHATELET\nNombre de colis : 1');
  assert.strictEqual(r[0].address, 'GRAND-RUE 54, 6200 CHATELET');
  assert.ok(r[0].sure && !r[0].incomplete);
});

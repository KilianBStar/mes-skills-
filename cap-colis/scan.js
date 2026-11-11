/*
 * Cap Colis : extraction d'adresses françaises dans du texte libre.
 * Sert au scan de photos (texte lu par OCR) et au texte collé (Texte en direct d'iOS, e-mail, PDF…).
 * Fonctionne dans le navigateur (window.Scan) et dans Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Scan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STREET_WORDS = [
    'rue', 'r', 'avenue', 'av', 'ave', 'boulevard', 'bd', 'bld', 'blvd', 'chemin', 'ch', 'che', 'chem',
    'impasse', 'imp', 'allee', 'allées', 'allees', 'all', 'place', 'pl', 'route', 'rte', 'quai', 'qu', 'cours', 'crs',
    'square', 'sq', 'passage', 'pass', 'voie', 'sentier', 'sente', 'lotissement', 'lot', 'residence', 'res', 'rés',
    'hameau', 'ham', 'lieu-dit', 'lieudit', 'ld', 'cite', 'cité', 'parvis', 'esplanade', 'promenade', 'prom', 'montee', 'montée',
    'rond-point', 'carrefour', 'faubourg', 'fg', 'fbg', 'za', 'zi', 'zac', 'zone', 'parc', 'domaine', 'chaussee', 'chaussée',
    'traverse', 'venelle', 'ruelle', 'clos', 'villa', 'mail', 'galerie', 'rocade', 'digue', 'port', 'quartier', 'chaussée',
  ];
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const STREET_SET = new Set(STREET_WORDS.map(norm));
  const NUM = /^\s*(\d{1,4})(?:\s?(bis|ter|quater|[a-d]))?\b[\s,.-]*/i;

  /** Le mot qui suit éventuellement le numéro est-il un type de voie ? */
  function hasStreetWord(line) {
    const words = norm(line).replace(/[^a-z0-9\- ]/g, ' ').split(/\s+/).filter(Boolean);
    return words.some((w, i) => STREET_SET.has(w) && (i < words.length - 1));
  }
  function isStreetLine(line) {
    if (!hasStreetWord(line)) return false;
    return NUM.test(line) || /\b\d{1,4}\s*(bis|ter)?\s*,?\s*$/.test(line) || line.length < 60;
  }

  // Corrige les confusions OCR courantes dans un code postal (O→0, I/l→1, S→5, B→8).
  function fixDigits(tok) {
    return tok.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
  }
  const CP_RE = /(^|[^0-9A-Za-z])([0-9OoIlSB|]{5})(?=[^0-9A-Za-z]|$)\s*,?\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’\- ]{1,40})?/g;
  function findPostcode(line) {
    CP_RE.lastIndex = 0;
    let m;
    while ((m = CP_RE.exec(line))) {
      const raw = m[2];
      if ((raw.match(/\d/g) || []).length < 3) continue;
      const cp = fixDigits(raw);
      if (!/^(0[1-9]|[1-8]\d|9[0-8])\d{3}$/.test(cp)) continue;
      let city = (m[3] || '').replace(/\b(france|cedex\s*\d*)\b.*$/i, '').replace(/[\s\-']+$/, '').trim();
      // une « ville » qui commence par un type de voie est en fait la rue suivante
      if (city && STREET_SET.has(norm(city.split(/\s+/)[0]))) city = '';
      return { cp, city, index: m.index + m[1].length, end: m.index + m[0].length };
    }
    return null;
  }

  const PHONE_RE = /(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/;
  const PKG_RE = /\b(\d{1,2})\s*(?:colis|pcs?|pi[eè]ces?|x\s*colis)\b/i;
  const HEADER_RE = /^(destinataire|exp[ée]diteur|adresse|livraison|tourn[ée]e|manifeste|date|page|n[°o]|ref|r[ée]f[ée]rence|code|poids|kg|signature|t[ée]l|client|total)\b/i;

  function cleanLine(l) {
    return l.replace(/[“”«»]/g, '"').replace(/\s+/g, ' ').replace(/^[\s|:;,.\-_*•]+|[\s|:;,_*•]+$/g, '').trim();
  }
  function cleanStreet(s) {
    return s.replace(HEADER_RE, '').replace(/^[\s:,-]+/, '').replace(/[\s,;-]+$/, '').trim();
  }
  /** « 3 DUPONT Jean 12 rue Mercière » → nom « DUPONT Jean », rue « 12 rue Mercière ». */
  function splitNameStreet(s) {
    const toks = s.split(/\s+/);
    const isStreetTok = (t) => STREET_SET.has(norm(t).replace(/[^a-z\-]/g, ''));
    for (let k = 0; k < toks.length; k++) {
      if (!isStreetTok(toks[k]) || k === toks.length - 1) continue;
      let from = k;
      // numéro (et bis/ter) juste avant le type de voie
      if (k >= 1 && /^(bis|ter|quater|[a-d])$/i.test(toks[k - 1]) && k >= 2 && /^\d{1,4},?$/.test(toks[k - 2])) from = k - 2;
      else if (k >= 1 && /^\d{1,4}(bis|ter|[a-d])?,?$/i.test(toks[k - 1])) from = k - 1;
      const name = toks.slice(0, from).join(' ').replace(/^\d{1,3}[.)]?\s+/, '').trim();
      return { name: /[A-Za-zÀ-ÿ]{2,}/.test(name) ? name : '', street: toks.slice(from).join(' ') };
    }
    return { name: '', street: s };
  }
  function looksLikeName(l) {
    return l.length >= 3 && l.length <= 40 && !/\d/.test(l) && !hasStreetWord(l) && !HEADER_RE.test(l) && /[A-Za-zÀ-ÿ]{2,}/.test(l);
  }

  /**
   * Extrait les adresses d'un texte.
   * @returns {{address:string, note:string, packages:number, sure:boolean}[]}
   */
  function extractAddresses(text) {
    const lines = String(text || '').split(/\r?\n/).map(cleanLine).filter(Boolean);
    const used = new Set();
    const out = [];
    const seen = new Set();

    const push = (street, cp, city, around, sure) => {
      const address = [street, [cp, city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      const key = norm(address).replace(/[^a-z0-9]/g, '');
      if (!address || seen.has(key)) return;
      seen.add(key);
      const notes = [];
      let packages = 1;
      for (const l of around) {
        const ph = l.match(PHONE_RE);
        if (ph && !notes.some((n) => n.includes(ph[0]))) notes.push(`Tél. ${ph[0].replace(/[\s.-]/g, ' ')}`);
        const pk = l.match(PKG_RE);
        if (pk) packages = Math.max(packages, Number(pk[1]));
      }
      out.push({ address, note: notes.join(' · '), packages, sure, _names: around.filter(looksLikeName) });
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const pc = findPostcode(line);
      if (!pc) continue;
      const split = splitNameStreet(cleanStreet(line.slice(0, pc.index)));
      let street = split.street;
      let inlineName = split.name;
      let city = pc.city;
      let firstLine = i;
      // ville sur la ligne suivante (« 69002 » seul en fin de ligne)
      if (!city && lines[i + 1] && /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’\- ]{1,40}$/.test(lines[i + 1]) && !hasStreetWord(lines[i + 1])) {
        city = lines[i + 1].replace(/\b(france|cedex\s*\d*)\b.*$/i, '').trim();
        used.add(i + 1);
      }
      if (!street || !(hasStreetWord(street) || NUM.test(street))) {
        // la rue est sur une des 3 lignes au-dessus
        street = ''; inlineName = '';
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
          if (used.has(j) || findPostcode(lines[j])) break;
          if (isStreetLine(lines[j])) {
            const sp = splitNameStreet(cleanStreet(lines[j]));
            street = sp.street; inlineName = sp.name;
            firstLine = j;
            // numéro seul sur la ligne d'avant (« 12 » puis « rue des Lilas »)
            if (!NUM.test(street) && j > 0 && /^\d{1,4}\s*(bis|ter)?$/i.test(lines[j - 1])) { street = `${lines[j - 1]} ${street}`; firstLine = j - 1; }
            break;
          }
        }
      }
      // complément (bâtiment, appartement) entre la rue et le code postal
      const extra = [];
      for (let j = firstLine + 1; j < i; j++) if (!used.has(j) && /(?:^|\s)(b[aâ]t\.?|b[aâ]timent|apt|appartement|[ée]tage|esc|escalier|porte|digicode|code)\b/i.test(lines[j])) extra.push(lines[j]);
      for (let j = firstLine; j <= i; j++) used.add(j);
      const around = lines.slice(firstLine > 0 && !used.has(firstLine - 1) && !findPostcode(lines[firstLine - 1]) ? firstLine - 1 : firstLine, i + 1);
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        if (findPostcode(lines[j]) || isStreetLine(lines[j]) || looksLikeName(lines[j]) && j > i + 1) break;
        around.push(lines[j]);
      }
      if (!street) continue; // code postal sans rue : référence, numéro de commande…
      push(street, pc.cp, city, around, !!city && NUM.test(street));
      const last = out[out.length - 1];
      if (last && last.address.includes(pc.cp)) {
        const nameLine = firstLine > 0 && !used.has(firstLine - 1) && looksLikeName(lines[firstLine - 1]) ? lines[firstLine - 1] : '';
        last.note = [inlineName || nameLine, ...extra, last.note].filter(Boolean).join(' · ');
      }
    }

    // Rues sans code postal (étiquettes mal lues, listes locales) : à vérifier.
    for (let i = 0; i < lines.length; i++) {
      if (used.has(i)) continue;
      if (NUM.test(lines[i]) && hasStreetWord(lines[i])) {
        const sp = splitNameStreet(cleanStreet(lines[i]));
        push(sp.street, '', '', lines.slice(i, i + 2), false);
        if (sp.name) out[out.length - 1].note = [sp.name, out[out.length - 1].note].filter(Boolean).join(' · ');
        used.add(i);
      }
    }
    return out.map(({ _names, ...r }) => r);
  }

  /** Texte collé : si rien n'est reconnu comme adresse, chaque ligne est traitée comme une adresse. */
  function parsePasted(text) {
    const found = extractAddresses(text);
    if (found.length) return found;
    return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [address, ...note] = l.split(';');
      return { address: address.trim(), note: note.join(';').trim(), packages: 1, sure: true };
    });
  }

  /**
   * Reconstruit les lignes d'un document photographié à partir des mots et de leur position
   * (sortie « blocks » de Tesseract). Corrige l'inclinaison de la photo et recolle les cellules
   * d'un même rang de tableau.
   * @param {{text:string, confidence:number, bbox:{x0:number,y0:number,x1:number,y1:number}}[]} words
   * @param {{baseline:{x0:number,y0:number,x1:number,y1:number}}[]} lines
   */
  function rowsFromWords(words, lines) {
    const ws = words.filter((w) => w.text && w.text.replace(/[|\[\]_—–\-=~.,:;'"`]/g, '').trim() && w.confidence > 20);
    if (!ws.length) return '';
    // pente médiane des lignes de base assez longues
    const slopes = (lines || []).map((l) => l.baseline).filter((b) => b && b.x1 - b.x0 > 80).map((b) => (b.y1 - b.y0) / (b.x1 - b.x0)).sort((a, b) => a - b);
    const slope = slopes.length ? slopes[Math.floor(slopes.length / 2)] : 0;
    const hs = ws.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
    const h = hs[Math.floor(hs.length / 2)] || 10;
    const items = ws.map((w) => {
      const xc = (w.bbox.x0 + w.bbox.x1) / 2;
      const yc = (w.bbox.y0 + w.bbox.y1) / 2;
      return { text: w.text.replace(/^[|\[\]]+|[|\[\]]+$/g, ''), x: w.bbox.x0, y: yc - slope * xc };
    }).filter((it) => it.text).sort((a, b) => a.y - b.y);
    const rows = [];
    for (const it of items) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(it.y - row.y) < h * 0.55) { row.items.push(it); row.y = (row.y * (row.items.length - 1) + it.y) / row.items.length; }
      else rows.push({ y: it.y, items: [it] });
    }
    return rows.map((r) => r.items.sort((a, b) => a.x - b.x).map((i) => i.text).join(' ')).join('\n');
  }

  /**
   * Estime l'inclinaison d'une photo de document (en degrés, de -15 à +15).
   * Méthode des profils de projection : à la bonne inclinaison, les lignes de texte
   * forment des bandes nettes, et la somme des carrés des lignes de pixels est maximale.
   * @param {Uint8ClampedArray|number[]} gray niveaux de gris (0 = noir), w × h
   */
  function estimateSkew(gray, w, h) {
    // seuil : moyenne - un peu, pour ne garder que l'encre
    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += gray[i];
    const thr = (sum / gray.length) * 0.6;
    const xs = [], ys = [];
    const step = Math.max(1, Math.round(Math.sqrt((w * h) / 60000)));
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (gray[y * w + x] < thr) { xs.push(x); ys.push(y); }
    if (xs.length < 50) return 0;
    const score = (deg) => {
      const a = (deg * Math.PI) / 180, sin = Math.sin(a), cos = Math.cos(a);
      const bins = new Map();
      for (let k = 0; k < xs.length; k++) {
        const r = Math.round((ys[k] * cos - xs[k] * sin) / step);
        bins.set(r, (bins.get(r) || 0) + 1);
      }
      let sq = 0;
      for (const v of bins.values()) sq += v * v;
      return sq;
    };
    let best = 0, bestScore = -1;
    for (let d = -15; d <= 15; d += 1) { const sc = score(d); if (sc > bestScore) { bestScore = sc; best = d; } }
    for (let d = best - 0.9; d <= best + 0.9; d += 0.3) { const sc = score(d); if (sc > bestScore) { bestScore = sc; best = d; } }
    return Math.round(best * 10) / 10;
  }

  return { extractAddresses, parsePasted, findPostcode, isStreetLine, rowsFromWords, estimateSkew };
});

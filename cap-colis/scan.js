/*
 * Cap Colis : extraction d'adresses (France et Belgique) dans du texte libre.
 * Sert au scan de photos (texte lu par OCR) et au texte collé (Texte en direct d'iOS, e-mail, PDF…).
 * Fonctionne dans le navigateur (window.Scan) et dans Node (tests).
 *
 * Formats reconnus :
 *   12 rue Mercière / 69002 LYON                       (France : numéro avant la rue, CP à 5 chiffres)
 *   RUE DE LA REMISE 22 / 6061 MONTIGNIES-SUR-SAMBRE   (Belgique : numéro après la rue, CP à 4 chiffres)
 *   Rue de la Vallée 2 / Châtelineau 6200              (ville avant le code postal)
 *   RUE DE LA VALLEE 27/6                              (27 boîte 6)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Scan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STREET_WORDS = [
    'rue', 'r', 'avenue', 'av', 'ave', 'boulevard', 'bd', 'bld', 'blvd', 'chemin', 'ch', 'che', 'chem',
    'impasse', 'imp', 'allee', 'allees', 'all', 'place', 'pl', 'route', 'rte', 'quai', 'cours', 'crs',
    'square', 'sq', 'passage', 'voie', 'sentier', 'sente', 'lotissement', 'lot', 'residence', 'res',
    'hameau', 'ham', 'lieu-dit', 'lieudit', 'ld', 'cite', 'parvis', 'esplanade', 'promenade', 'prom', 'montee',
    'rond-point', 'carrefour', 'faubourg', 'fg', 'fbg', 'za', 'zi', 'zac', 'zone', 'parc', 'domaine', 'chaussee',
    'traverse', 'venelle', 'ruelle', 'clos', 'villa', 'mail', 'galerie', 'rocade', 'digue', 'quartier', 'dreve',
    'thier', 'tienne', 'cour', 'enclos', 'pave',
    // néerlandais (Bruxelles, Flandre)
    'straat', 'steenweg', 'laan', 'plein', 'dreef', 'lei', 'kaai', 'baan', 'weg', 'singel', 'markt', 'hof',
  ];
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const STREET_SET = new Set(STREET_WORDS.map(norm));
  const NL_SUFFIX = /(straat|steenweg|laan|plein|dreef|kaai|baan|weg|singel|markt|dijk|gracht|vest)$/;
  const LEAD_NUM = /^\s*(\d{1,4})(?:\s?(bis|ter|quater|[a-d]))?\b[\s,.-]*/i;
  const TRAIL_NUM = /[\s,]\d{1,4}\s*(?:bis|ter|[a-z])?(?:\s*(?:\/|bte|bt|bus|boite|boîte)\s*[\w/.-]{1,8})?\s*$/i;

  const isStreetTok = (t) => {
    const w = norm(t).replace(/[^a-z\-]/g, '');
    // « Grand-Rue », « Petite-Rue » : le type de voie est collé par un tiret
    return STREET_SET.has(w) || (w.length > 5 && NL_SUFFIX.test(w)) || (/^(grand|grande|petite?|haute?|basse?|vieille)-(rue|route|place|chaussee)$/.test(w));
  };
  function hasStreetWord(line) {
    const words = norm(line).replace(/[^a-z0-9\- ]/g, ' ').split(/\s+/).filter(Boolean);
    return words.some((w, i) => (STREET_SET.has(w) && i < words.length - 1) || (w.length > 5 && NL_SUFFIX.test(w)) || isStreetTok(w));
  }
  function hasHouseNumber(s) {
    return LEAD_NUM.test(s) || TRAIL_NUM.test(s);
  }
  function isStreetLine(line) {
    if (!hasStreetWord(line)) return false;
    return hasHouseNumber(line) || line.length < 60;
  }

  // Corrige les confusions OCR courantes dans un code postal (O→0, I/l→1, S→5, B→8).
  function fixDigits(tok) {
    return tok.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
  }
  const validFR = (cp) => /^(0[1-9]|[1-8]\d|9[0-8])\d{3}$/.test(cp);
  const validBE = (cp) => /^[1-9]\d{3}$/.test(cp);
  // Mots qui suivent un code de tri ou de service, pas une ville
  const NOT_CITY = /^(next|same|domicile|relais|locker|collecte|express|easy|total|belgium|belgique|belgie|belgië|france|bis|kg|grs?|be|fr)$/i;
  const CITY_CHARS = "A-Za-zÀ-ÿ'’\\-";
  const PROVINCE = /^(hainaut|namur|liege|luxembourg|brabant( wallon| flamand)?|vlaams-brabant|anvers|antwerpen|limbourg|limburg|flandre( occidentale| orientale)?|west-vlaanderen|oost-vlaanderen|bruxelles-capitale|region de bruxelles-capitale|wallonie|belgique|belgium|belgie)$/;
  const cleanCity = (c) => String(c || '').replace(/\b(france|belgique|belgium|belgi[eë]|cedex\s*\d*)\b.*$/i, '').replace(/[\s\-',]+$/, '').trim();

  /** Cherche un code postal (FR 5 chiffres ou BE 4 chiffres) et la ville sur une ligne. */
  function findPostcode(line) {
    const re = new RegExp(`(^|[^0-9A-Za-z/:.])([0-9OoIlSB|]{4,5})(?=[^0-9A-Za-z/:]|$)\\s*,?\\s*([${CITY_CHARS}][${CITY_CHARS} ]{1,40})?`, 'g');
    let m;
    while ((m = re.exec(line))) {
      const raw = m[2];
      if ((raw.match(/\d/g) || []).length < 3) continue;
      const cp = fixDigits(raw);
      const country = cp.length === 5 ? (validFR(cp) ? 'FR' : null) : validBE(cp) ? 'BE' : null;
      if (!country) continue;
      const index = m.index + m[1].length;
      let city = cleanCity(m[3]);
      const firstWord = city.split(/\s+/)[0] || '';
      if (firstWord && NOT_CITY.test(firstWord)) continue; // « 6060 NEXT » : code de tri
      if (firstWord && STREET_SET.has(norm(firstWord))) city = '';
      // « Châtelineau 6200 » : ville avant le code postal (ligne sans type de voie ni chiffre)
      if (!city) {
        const before = line.slice(0, index).trim();
        if (!hasStreetWord(before) && !/\d/.test(before)) {
          // « Châtelet, Hainaut, 6200 » : on écarte la province et le pays, la ville est ce qui reste
          const parts = before.split(',').map((x) => x.trim()).filter(Boolean).filter((x) => !PROVINCE.test(norm(x)));
          const c = cleanCity(parts[parts.length - 1] || '');
          if (c && new RegExp(`^[${CITY_CHARS}][${CITY_CHARS} ]{1,40}$`).test(c) && !NOT_CITY.test(c)) return { cp, city: c, country, index: line.indexOf(parts[0] || c), cityBefore: true };
        }
      }
      return { cp, city, country, index, cityBefore: false };
    }
    return null;
  }

  const PHONE_RE = /(?:\+3[23]\s?|00\s?3[23]\s?|0)[1-9](?:[\s.-]?\d){7,8}(?![\dA-Za-z])|\b3[23][1-9]\d{7,8}\b/;
  const PKG_RE = /\b(\d{1,2})\s*(?:colis|pcs?|pi[eè]ces?)\b|colis\s*:?\s*(\d{1,3})\b/i;
  const HEADER_RE = /^(destinataire|exp[ée]diteur|ship\s*to|adresse|livraison|tourn[ée]e|manifeste|date|page|n[°o]\s|ref|r[ée]f[ée]rence|code\b|poids|kg|signature|t[ée]l|client|total|nombre|type|consignes|charg[ée]s|faits|[àa] faire)\b/i;
  const SENDER_RE = /exp[ée]diteur|amazon\s*returns|\breturns\b|schoondonk|willebroek/i;

  function cleanLine(l) {
    return l.replace(/[“”«»]/g, '"')
      .replace(/\bID\s*\d{1,4}\b/gi, ' ') // identifiant d'arrêt d'une autre app
      .replace(/\b\d{1,2}[:h]\d{2}\b/g, ' ') // heure prévue
      .replace(/\s+/g, ' ').replace(/^[\s|:;,.\-_*•]+|[\s|:;,_*•]+$/g, '').trim();
  }
  function cleanStreet(s) {
    return s.replace(/^ship\s*to\s*:?/i, '').replace(HEADER_RE, '').replace(/^[\s:,-]+/, '').replace(/[\s,;-]+$/, '').trim();
  }
  /**
   * Format belge (« Rue de la Vallée 2 Fee are mer ») : on coupe ce qui suit le numéro et la boîte.
   * Le bruit vient du carton ou des codes-barres lus par erreur.
   */
  function trimAfterNumber(street) {
    const toks = street.split(/\s+/);
    if (!toks.length || !isStreetTok(toks[0].replace(/,$/, ''))) return street;
    for (let k = 1; k < toks.length; k++) {
      if (!/^\d{1,4}[a-z]?(\/[\w/]{1,8})?,?$/i.test(toks[k])) continue;
      let end = k;
      if (toks[k + 1] && /^(bis|ter)$/i.test(toks[k + 1])) end = k + 1;
      if (toks[end + 1] && /^(bte\.?|bt\.?|bus|bo[iî]te)$/i.test(toks[end + 1]) && toks[end + 2] && /^[\w/]{1,6}$/.test(toks[end + 2])) end += 2;
      else if (toks[end + 1] && /^\/[\w/]{1,6}$/.test(toks[end + 1])) end += 1;
      return toks.slice(0, end + 1).join(' ');
    }
    return street;
  }
  /** « RUE DE LA VALLEE 27/6 » → rue « RUE DE LA VALLEE 27 », boîte « 6 ». */
  function splitBox(street) {
    const m = street.match(/^(.*?\D)[\s,]*(\d{1,4}[a-z]?)\s*(?:\/|\bbte\.?|\bbt\.?|\bbus\b|\bbo[iî]te\b)\s*([\w/.-]{1,8})\s*$/i);
    if (!m) return { street: street.replace(/,\s*(\d)/, ' $1'), box: '' };
    return { street: `${m[1].replace(/[\s,]+$/, '')} ${m[2]}`, box: m[3] };
  }
  /** « 3 DUPONT Jean 12 rue Mercière » → nom « DUPONT Jean », rue « 12 rue Mercière ». */
  function splitNameStreet(s) {
    const toks = s.split(/\s+/);
    for (let k = 0; k < toks.length; k++) {
      if (!isStreetTok(toks[k]) || (k === toks.length - 1 && !NL_SUFFIX.test(norm(toks[k])))) continue;
      let from = k;
      const trailingNum = toks.slice(k + 1).some((t) => /^\d{1,4}[a-z]?([/,].*)?$/i.test(t));
      if (!trailingNum && k >= 2 && /^(bis|ter|quater|[a-d])$/i.test(toks[k - 1]) && /^\d{1,4},?$/.test(toks[k - 2])) from = k - 2;
      else if (!trailingNum && k >= 1 && /^\d{1,4}(bis|ter|[a-d])?,?$/i.test(toks[k - 1])) from = k - 1;
      const name = toks.slice(0, from).join(' ').replace(/^\d{1,3}[.)]?(\s+|$)/, '').trim();
      return { name: /[A-Za-zÀ-ÿ]{2,}/.test(name) ? name : '', street: toks.slice(from).join(' ') };
    }
    return { name: '', street: s };
  }
  /** « DUPONT JEAN » → « Dupont Jean » (lisible), « INCONNU » ou mots parasites → vide. */
  function tidyName(n) {
    const t = String(n || '').replace(/^(m\.|mr|mme|mlle|madame|monsieur)\s+/i, (m) => m).replace(/\s+/g, ' ').trim();
    if (!t || /^inconnu$/i.test(t) || t.length < 2) return '';
    return t === t.toUpperCase() ? t.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) : t;
  }
  function looksLikeName(l) {
    return l.length >= 3 && l.length <= 40 && !/\d/.test(l) && !hasStreetWord(l) && !HEADER_RE.test(l) && !SENDER_RE.test(l) && /[A-Za-zÀ-ÿ]{2,}/.test(l);
  }

  /**
   * Extrait les adresses d'un texte.
   * @returns {{address:string, note:string, packages:number, sure:boolean, country:string, incomplete?:boolean}[]}
   */
  function extractAddresses(text) {
    const lines = String(text || '').split(/\r?\n/).map(cleanLine).filter(Boolean);
    const used = new Set();
    // Bloc expéditeur (Amazon Returns, dépôt de Willebroek…) : jamais une livraison
    const sender = new Set();
    lines.forEach((l, i) => {
      if (!SENDER_RE.test(l)) return;
      for (let j = i; j <= Math.min(lines.length - 1, i + 3); j++) {
        if (j > i && /ship\s*to|destinataire/i.test(lines[j])) break;
        sender.add(j);
      }
    });
    const out = [];
    const seen = new Set();

    const push = (street, pc, city, around, sure, extraNotes, name = '') => {
      const box = splitBox(trimAfterNumber(street));
      const cityPart = [pc.cp, city].filter(Boolean).join(' ');
      const address = [box.street, cityPart].filter(Boolean).join(', ');
      const key = norm(address).replace(/[^a-z0-9]/g, '');
      // deux colis « INCONNU » dans la même ville restent deux arrêts
      if (!address || (box.street && seen.has(key))) return null;
      seen.add(key);
      const notes = [...extraNotes];
      if (box.box) notes.push(`Boîte ${box.box}`);
      let packages = 1;
      for (const l of around) {
        const ph = l.match(PHONE_RE);
        if (ph && !notes.some((n) => n.includes(ph[0].trim()))) notes.push(`Tél. ${ph[0].trim()}`);
        const pk = l.match(PKG_RE);
        if (pk) packages = Math.max(packages, Number(pk[1] || pk[2]));
      }
      const r = { address, name: tidyName(name), note: notes.filter(Boolean).join(' · '), packages, sure: sure && hasHouseNumber(box.street), country: pc.country };
      out.push(r);
      return r;
    };

    for (let i = 0; i < lines.length; i++) {
      if (sender.has(i)) continue;
      const line = lines[i];
      const pc = findPostcode(line);
      if (!pc) continue;
      const split = splitNameStreet(cleanStreet(pc.cityBefore ? '' : line.slice(0, pc.index)));
      let street = split.street;
      let inlineName = split.name;
      let city = pc.city;
      let firstLine = i;
      // ville seule sur la ligne suivante (« 69002 » en fin de ligne)
      if (!city && lines[i + 1] && !sender.has(i + 1) && new RegExp(`^[${CITY_CHARS}][${CITY_CHARS} ]{1,40}$`).test(lines[i + 1]) && !hasStreetWord(lines[i + 1]) && !NOT_CITY.test(lines[i + 1]) && !HEADER_RE.test(lines[i + 1])) {
        city = cleanCity(lines[i + 1]);
        used.add(i + 1);
      }
      if (!street || !hasStreetWord(street)) {
        // la rue est sur une des 3 lignes au-dessus
        street = ''; inlineName = '';
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
          if (used.has(j) || sender.has(j) || findPostcode(lines[j])) break;
          if (isStreetLine(lines[j])) {
            const sp = splitNameStreet(cleanStreet(lines[j]));
            street = sp.street; inlineName = sp.name;
            firstLine = j;
            // numéro seul sur la ligne d'avant (« 12 » puis « rue des Lilas »)
            if (!hasHouseNumber(street) && j > 0 && /^\d{1,4}\s*(bis|ter)?$/i.test(lines[j - 1])) { street = `${lines[j - 1]} ${street}`; firstLine = j - 1; }
            break;
          }
        }
      }
      // lignes qui suivent la ville : nombre de colis, téléphone (on s'arrête à l'adresse suivante)
      const after = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        if (findPostcode(lines[j]) || isStreetLine(lines[j]) || (looksLikeName(lines[j]) && j > i + 1)) break;
        after.push(lines[j]);
      }
      if (!street) {
        // Liste de tournée (« INCONNU / 6061 MONTIGNIES / Nombre de colis : 1 ») : on garde l'arrêt, rue à compléter.
        if (!city || !after.some((l) => /colis/i.test(l))) continue;
        const name = i > 0 && !used.has(i - 1) && looksLikeName(lines[i - 1]) ? lines[i - 1] : '';
        used.add(i);
        const ctx = out.length ? out[out.length - 1].address : '';
        const r = push('', pc, city, after, false, [], name);
        if (r) { r.incomplete = true; r.ctx = ctx; }
        continue;
      }
      const extra = [];
      for (let j = firstLine + 1; j < i; j++) if (!used.has(j) && /(?:^|\s)(b[aâ]t\.?|b[aâ]timent|apt|appartement|[ée]tage|esc|escalier|porte|digicode|code|bo[iî]te|bte)\b/i.test(lines[j])) extra.push(lines[j]);
      const nameLine = firstLine > 0 && !used.has(firstLine - 1) && !sender.has(firstLine - 1) && looksLikeName(lines[firstLine - 1]) ? lines[firstLine - 1] : '';
      for (let j = firstLine; j <= i; j++) used.add(j);
      const around = lines.slice(firstLine, i + 1).concat(after);
      push(street, pc, city, around, !!city, extra, inlineName || nameLine);
    }

    // Rues avec numéro mais sans code postal lisible : à vérifier.
    for (let i = 0; i < lines.length; i++) {
      if (used.has(i) || sender.has(i)) continue;
      if (hasHouseNumber(lines[i]) && hasStreetWord(lines[i]) && !HEADER_RE.test(lines[i])) {
        const sp = splitNameStreet(cleanStreet(lines[i]));
        push(sp.street, { cp: '', country: '' }, '', lines.slice(i, i + 2), false, [], sp.name);
        used.add(i);
      }
    }
    return out;
  }

  /** Texte collé : si rien n'est reconnu comme adresse, chaque ligne est traitée comme une adresse. */
  function parsePasted(text) {
    const found = extractAddresses(text);
    if (found.length) return found;
    return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [address, ...note] = l.split(';');
      return { address: address.trim(), note: note.join(';').trim(), packages: 1, sure: true, country: '' };
    });
  }

  /** Pays probable d'une adresse : 'FR' (CP à 5 chiffres), 'BE' (CP à 4 chiffres) ou ''. */
  function guessCountry(q) {
    const s = String(q || '');
    for (const part of s.split(',')) {
      const pc = findPostcode(part.trim());
      if (pc && !(pc.country === 'BE' && !pc.city)) return pc.country;
    }
    if (/\b(belgique|belgium|belgi[eë])\b/i.test(s)) return 'BE';
    if (/\bfrance\b/i.test(s)) return 'FR';
    return '';
  }

  /**
   * Reconstruit les lignes d'un document photographié à partir des mots et de leur position
   * (sortie « blocks » de Tesseract). Corrige l'inclinaison et recolle les cellules d'un même rang.
   */
  function rowsFromWords(words, lines) {
    const ws = words.filter((w) => w.text && w.text.replace(/[|\[\]_—–\-=~.,:;'"`]/g, '').trim() && w.confidence > 20);
    if (!ws.length) return '';
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
   * Estime l'inclinaison d'une photo de document (degrés, de -15 à +15) par profils de projection :
   * à la bonne inclinaison, les lignes de texte forment des bandes nettes.
   * @param {Uint8ClampedArray|number[]} gray niveaux de gris (0 = noir), w × h
   */
  function estimateSkew(gray, w, h) {
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

  /**
   * Repère l'étiquette (grande zone claire) sur une photo de colis, pour la recadrer et l'agrandir.
   * Renvoie {x, y, w, h} dans les coordonnées de l'image réduite, ou null si rien de net.
   * @param {Uint8ClampedArray|number[]} gray niveaux de gris, w × h (image réduite, ~300-500 px)
   */
  function findBrightRegion(gray, w, h) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i] | 0]++;
    // seuil : 75e centile, au moins 170 (papier blanc)
    let acc = 0, p75 = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= gray.length * 0.75) { p75 = v; break; } }
    const thr = Math.max(170, p75 - 10);
    const lab = new Int32Array(w * h).fill(-1);
    let best = null;
    const stack = [];
    for (let start = 0; start < w * h; start++) {
      if (lab[start] !== -1 || gray[start] < thr) continue;
      let n = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      stack.push(start); lab[start] = start;
      while (stack.length) {
        const k = stack.pop();
        const x = k % w, y = (k / w) | 0;
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        // 4-voisins ; on tolère le texte sombre à l'intérieur via la boîte englobante
        if (x > 0 && lab[k - 1] === -1 && gray[k - 1] >= thr) { lab[k - 1] = start; stack.push(k - 1); }
        if (x < w - 1 && lab[k + 1] === -1 && gray[k + 1] >= thr) { lab[k + 1] = start; stack.push(k + 1); }
        if (y > 0 && lab[k - w] === -1 && gray[k - w] >= thr) { lab[k - w] = start; stack.push(k - w); }
        if (y < h - 1 && lab[k + w] === -1 && gray[k + w] >= thr) { lab[k + w] = start; stack.push(k + w); }
      }
      if (!best || n > best.n) best = { n, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }
    if (!best) return null;
    const boxArea = best.w * best.h;
    // trop petit (reflet) ou toute l'image (feuille déjà cadrée) : pas de recadrage
    if (boxArea < w * h * 0.06 || boxArea > w * h * 0.8 || best.n < boxArea * 0.35) return null;
    const m = Math.round(Math.max(w, h) * 0.02);
    const x = Math.max(0, best.x - m), y = Math.max(0, best.y - m);
    return { x, y, w: Math.min(w - x, best.w + 2 * m), h: Math.min(h - y, best.h + 2 * m) };
  }

  return { extractAddresses, parsePasted, findPostcode, isStreetLine, hasHouseNumber, guessCountry, rowsFromWords, estimateSkew, findBrightRegion };
});

/*
 * Kiliroute : codes postaux belges de la région de Charleroi et alentours → localités.
 * La première localité est la commune (choix par défaut quand la ville manque).
 * À compléter si vous livrez ailleurs.
 */
(function (root) {
  const PC = {
    // Charleroi
    '6000': ['Charleroi'], '6001': ['Marcinelle'], '6010': ['Couillet'], '6020': ['Dampremy'],
    '6030': ['Marchienne-au-Pont', 'Goutroux'], '6031': ['Monceau-sur-Sambre'], '6032': ['Mont-sur-Marchienne'],
    '6040': ['Jumet'], '6041': ['Gosselies'], '6042': ['Lodelinsart'], '6043': ['Ransart'], '6044': ['Roux'],
    '6060': ['Gilly'], '6061': ['Montignies-sur-Sambre'],
    // Montigny-le-Tilleul, Ham-sur-Heure-Nalinnes
    '6110': ['Montigny-le-Tilleul'], '6111': ['Landelies'],
    '6120': ['Ham-sur-Heure', 'Cour-sur-Heure', 'Jamioulx', 'Marbaix', 'Nalinnes'],
    // Fontaine-l'Évêque, Anderlues, Courcelles
    '6140': ["Fontaine-l'Évêque"], '6141': ['Forchies-la-Marche'], '6142': ['Leernes'],
    '6150': ['Anderlues'],
    '6180': ['Courcelles'], '6181': ['Gouy-lez-Piéton'], '6182': ['Souvret'], '6183': ['Trazegnies'],
    // Châtelet, Les Bons Villers, Fleurus, Pont-à-Celles, Farciennes, Aiseau-Presles, Gerpinnes
    '6200': ['Châtelet', 'Bouffioulx', 'Châtelineau'],
    '6210': ['Frasnes-lez-Gosselies', 'Les Bons Villers', 'Rèves', 'Villers-Perwin', 'Wayaux'], '6211': ['Mellet'],
    '6220': ['Fleurus', 'Heppignies', 'Lambusart', 'Wangenies'], '6221': ['Saint-Amand'], '6222': ['Brye'],
    '6223': ['Wagnelée'], '6224': ['Wanfercée-Baulet'],
    '6230': ['Pont-à-Celles', 'Buzet', 'Obaix', 'Thiméon', 'Viesville'], '6238': ['Luttre', 'Liberchies'],
    '6240': ['Farciennes', 'Pironchamps'],
    '6250': ['Aiseau', 'Pont-de-Loup', 'Presles', 'Roselies'],
    '6280': ['Gerpinnes', 'Acoz', 'Gougnies', 'Joncret', 'Loverval', 'Villers-Poterie'],
    // Thuin, Lobbes, Walcourt (proches)
    '6530': ['Thuin', 'Leers-et-Fosteau'], '6531': ['Biesme-sous-Thuin'], '6532': ['Ragnies'], '6533': ['Biercée'],
    '6534': ['Gozée'], '6536': ['Donstiennes', 'Thuillies'], '6540': ['Lobbes', 'Mont-Sainte-Geneviève'],
    '5650': ['Walcourt', 'Castillon', 'Chastrès', 'Clermont', 'Fontenelle', 'Fraire', 'Pry', 'Vogenée', 'Yves-Gomezée'],
    // Basse-Sambre (Sambreville), Fosses
    '5060': ['Sambreville', 'Arsimont', 'Auvelais', 'Falisolle', 'Keumiée', 'Moignelée', 'Tamines', 'Velaine-sur-Sambre'],
    '5070': ['Fosses-la-Ville', 'Aisemont', 'Le Roux', 'Sart-Eustache', 'Sart-Saint-Laurent', 'Vitrival'],
  };
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m || !n) return m || n;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  /** Localités d'un code postal (tableau vide si inconnu). */
  function localities(cp) { return PC[String(cp)] || []; }
  /**
   * Ville correcte pour un code postal : la commune si la ville manque,
   * la localité la plus proche si la ville est mal lue, sinon la ville telle quelle.
   */
  function cityFor(cp, city) {
    const list = localities(cp);
    if (!list.length) return city || '';
    if (!city) return list[0];
    const c = norm(city);
    let best = null, bd = Infinity;
    for (const l of list) {
      const n = norm(l);
      if (n === c || n.startsWith(c) || c.startsWith(n)) return l;
      const d = lev(c, n) / Math.max(n.length, 1);
      if (d < bd) { bd = d; best = l; }
    }
    return bd <= 0.34 ? best : city;
  }
  const api = { localities, cityFor };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Postcodes = api;
})(typeof self !== 'undefined' ? self : this);

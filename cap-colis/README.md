# Cap Colis

Application web (installable sur téléphone) pour **optimiser une tournée de livraison de colis**, dans l'esprit des planificateurs de tournée pour livreurs indépendants.

## Ce qu'elle fait

**Préparer**
- Point de départ par adresse ou par GPS, fin de tournée au choix : retour au départ, au dernier arrêt ou à une autre adresse.
- Ajout d'arrêts par recherche d'adresse avec suggestions, en touchant la carte, ou en **collant une liste** (une adresse par ligne, note après `;`).
- Par arrêt : note (code portail, étage…), nombre de colis, durée d'arrêt, priorité **en premier / en dernier**, créneau **pas avant / au plus tard**.

**Optimiser**
- Temps de trajet réels par la route (matrice OSRM, jusqu'à 100 points), sinon estimation à vol d'oiseau.
- Moteur local (`optimizer.js`) : construction gloutonne + 2-opt + Or-opt + recherche locale itérée. Il respecte les priorités, attend l'ouverture des créneaux et pénalise les retards.
- Heures d'arrivée prévues, durée, kilomètres, heure de fin. Ordre modifiable à la main (▲▼) avec recalcul des heures.

**Livrer**
- Mode tournée : carte de l'arrêt en cours, bouton **Naviguer** (Google Maps, Waze ou Plans), **Livré**, **Échec** avec motif, **Passer** (reporté en fin de tournée), annulation de la dernière action.
- Réoptimisation depuis la position actuelle en cours de route.
- Export du bilan en CSV (compatible Excel).

Les données restent dans le navigateur du téléphone (localStorage). Aucun compte, aucun serveur à soi.

## Services utilisés (gratuits, sans clé)
- Adresses France : Géoplateforme IGN (`data.geopf.fr/geocodage`, Base Adresse Nationale).
- Adresses hors France / secours : Photon (OpenStreetMap).
- Itinéraires : serveur OSRM public de démonstration, modifiable dans Réglages. **Pour un usage professionnel quotidien, hébergez votre propre OSRM** (le serveur de démo est limité et sans garantie).
- Fond de carte : OpenStreetMap.

## Lancer

```bash
cd cap-colis
python3 -m http.server 8080   # puis ouvrir http://localhost:8080
```

Pour l'utiliser sur téléphone : publiez le dossier en HTTPS (GitHub Pages, Netlify…), ouvrez-le dans le navigateur puis « Ajouter à l'écran d'accueil ».

## Tests

```bash
node --test cap-colis/tests/optimizer.test.js
```

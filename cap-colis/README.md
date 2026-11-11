# Cap Colis

Application de tournée pour livreur de colis, pensée pour l'iPhone (testée au format iPhone 17 Pro Max). Vous scannez le manifeste, elle calcule l'ordre de passage et l'heure de fin, puis Waze vous guide d'un arrêt à l'autre.

## Ce qu'elle fait

**Scanner la tournée**
- Photographiez chaque page du manifeste, ou chaque étiquette de colis : 1 photo ou 20, peu importe. Les photos se lisent l'une après l'autre pendant que vous continuez à photographier.
- L'app redresse les photos penchées, lit les tableaux ligne par ligne et récupère l'adresse, le nom du destinataire, le téléphone et le complément (bâtiment, étage).
- Vous relisez la liste, corrigez une adresse d'un doigt, puis touchez « Ajouter ». Les adresses douteuses portent la mention « À vérifier ».
- Autre méthode : dans l'appareil photo de l'iPhone, Texte en direct, Tout sélectionner, Copier, puis « Coller du texte » dans l'app.

**Optimiser**
- 1 minute par arrêt par défaut (modifiable, et réglable arrêt par arrêt).
- Temps de trajet réels par la route (OSRM), priorités « en premier » / « en dernier », créneaux horaires.
- Heure de fin affichée en grand et recalculée en direct pendant la tournée, à partir de l'heure qu'il est et des arrêts restants.

**Livrer**
- Bouton « Y aller avec Waze » : Waze s'ouvre sur l'arrêt, avec ses alertes radars et trafic.
- « Livré » ouvre directement Waze vers l'arrêt suivant (désactivable dans Réglages).
- Échec avec motif, report en fin de tournée, annulation, réoptimisation depuis votre position.
- Carte 3D (bâtiments en relief, caméra orientée vers l'arrêt suivant), bascule 2D en un geste.
- Bilan CSV partagé par la feuille de partage iOS (Fichiers, Mail, WhatsApp).

Les données restent sur le téléphone. Pas de compte.

## Installer sur l'iPhone

### Option 1 : l'app web (gratuite, immédiate)
1. Mettez le dossier `cap-colis/` en ligne en HTTPS. Le dépôt est privé : GitHub Pages ne marche qu'avec un dépôt public ou un compte GitHub Pro. Sinon, Netlify Drop ou Cloudflare Pages acceptent le dossier tel quel.
2. Ouvrez l'adresse dans **Safari** sur l'iPhone.
3. Bouton Partager, puis **Sur l'écran d'accueil**.

L'icône Cap Colis arrive sur l'écran d'accueil et s'ouvre en plein écran, sans barre Safari. L'app fonctionne ensuite hors ligne, sauf la recherche d'adresses, les itinéraires et le fond de carte.

### Option 2 : l'app native (fichier .ipa)
À chaque modification, GitHub Actions compile l'app iOS sur un Mac (workflow `Cap Colis iOS`) et publie `CapColis-non-signe.ipa` dans les artefacts du run.

Apple interdit d'installer une app non signée. Deux façons de la signer :
- **Gratuit** : Sideloadly ou AltStore sur un ordinateur, avec votre identifiant Apple. Apple limite cette signature à 7 jours ; il faut la renouveler ensuite.
- **99 €/an** : un compte Apple Developer, puis TestFlight. L'app s'installe et se met à jour comme une app de l'App Store.

## Services utilisés (gratuits, sans clé)
- Adresses : Géoplateforme IGN (Base Adresse Nationale), Photon (OpenStreetMap) en secours.
- Itinéraires : serveur OSRM public de démonstration. Pour un usage pro quotidien, hébergez votre propre OSRM et indiquez son adresse dans Réglages.
- Carte 3D : MapLibre et OpenFreeMap.
- Lecture des photos : Tesseract.js, directement sur le téléphone. Aucune photo ne quitte l'iPhone.

## Développer

```bash
cd cap-colis
npm test                      # optimiseur + lecture d'adresses
python3 -m http.server 8080   # puis http://localhost:8080
npm install && npm run ios:sync && npm run ios:open   # projet Xcode (Mac)
```

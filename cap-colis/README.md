# Kilivre

Nom : Kilivre, de « Kilian » et « livre ». Vidéo de présentation : `brand/kilivre-presentation.mp4`.

Application de tournée pour livreur de colis, pensée pour l'iPhone (testée au format iPhone 17 Pro Max). Vous scannez le manifeste, elle calcule l'ordre de passage et l'heure de fin, puis Waze vous guide d'un arrêt à l'autre.

## Ce qu'elle fait

**Scanner la tournée**
- Adresses belges et françaises : code postal à 4 ou 5 chiffres, numéro avant ou après la rue, boîte (« 27/6 »), ville avant ou après le code postal.
- Photographiez la liste de tournée de votre terminal (Honeywell, écran par écran) ou chaque étiquette de colis : 1 photo ou 20, peu importe. L'app lit les photos l'une après l'autre pendant que vous continuez à photographier.
- L'app recadre l'étiquette blanche, tourne la photo si vous l'avez prise de côté, redresse l'inclinaison et récupère l'adresse, le nom, le téléphone, le nombre de colis et la boîte.
- Elle ignore l'adresse de l'expéditeur (Amazon Returns, Willebroek) et les codes de tri (« 40 6060 NEXT »). Un colis « INCONNU » sans rue arrive non coché, avec la mention « Rue manquante ».
- Vous relisez la liste, corrigez une adresse d'un doigt, puis touchez « Ajouter ». L'app marque « À vérifier » les adresses dont elle doute.
- Étiquette froissée ou mal imprimée : Texte en direct de l'iPhone la lit mieux. Dans Appareil photo, Texte en direct, Tout sélectionner, Copier, puis « Coller du texte » dans l'app.

**Optimiser**
- 1 minute par arrêt par défaut (modifiable, et réglable arrêt par arrêt).
- Temps de trajet réels par la route (OSRM), priorités « en premier » / « en dernier », créneaux horaires.
- Heure de fin affichée en grand et recalculée en direct pendant la tournée, à partir de l'heure qu'il est et des arrêts restants.

**Livrer**
- « Passer l'optimisation » : la tournée démarre dans votre ordre de saisie, avec les heures calculées.
- Adresse ajoutée en cours de tournée (saisie, voix, carte, scan) : elle se place à l'endroit où elle rallonge le moins le trajet, après l'arrêt vers lequel vous roulez.
- Radars fixes (OpenStreetMap, mis à jour par la communauté, gardés 24 h sur le téléphone) : pastille rouge avec la limite, alerte vocale à 500 m, compteur de vitesse qui passe au rouge au-dessus de la limite. Les signalements en direct de Waze (police, radars mobiles) restent dans Waze : Waze ne les partage pas.
- Maisons et immeubles en 3D (données OpenStreetMap) visibles dès que vous zoomez sur une rue.
- GPS intégré (par défaut) : bannière flèche + distance + rue, voix en français, carte qui suit votre position en 3D, recalcul si vous quittez l'itinéraire, écran allumé. À l'arrivée : Livré, Échec ou Passer, puis guidage vers l'arrêt suivant. Le bouton Waze bascule sur Waze à tout moment.
- Écran de tournée : carte plein écran, liste des arrêts qu'on tire vers le haut (3 hauteurs). Chaque ligne affiche le numéro de passage, l'heure prévue, la rue, la ville et l'identifiant du colis, coché une fois livré.
- « Marquer le trajet comme terminé » : bilan, export, puis nouvelle tournée.
- Menu ≡ « Mes tournées » : vos tournées passées classées par jour (aujourd'hui, cette semaine, ce mois, mois précédents). Ouvrir, refaire un trajet, supprimer, « Créer un trajet ».
- Ajout d'arrêts : une barre « Ajouter ou trouver des arrêts » avec scan et dictée, et 3 boutons Carte, Scanner, Voix.
- Bouton « Y aller avec Waze » : Waze s'ouvre sur l'arrêt, avec ses alertes radars et trafic.
- Quand vous touchez « Livré », Waze s'ouvre sur l'arrêt suivant. Vous pouvez couper ce réglage.
- Échec avec motif, report en fin de tournée, annulation, réoptimisation depuis votre position.
- Carte 3D (bâtiments en relief, caméra orientée vers l'arrêt suivant), bascule 2D en un geste.
- Bilan CSV partagé par la feuille de partage iOS (Fichiers, Mail, WhatsApp).

Vos données restent sur le téléphone, sans compte à créer.

## Installer sur l'iPhone

### Option 1 : l'app web (gratuite, immédiate)
1. Mettez le dossier `cap-colis/` en ligne en HTTPS. Le dépôt est privé : GitHub Pages ne marche qu'avec un dépôt public ou un compte GitHub Pro. Sinon, Netlify Drop ou Cloudflare Pages acceptent le dossier tel quel.
2. Ouvrez l'adresse dans **Safari** sur l'iPhone.
3. Bouton Partager, puis **Sur l'écran d'accueil**.

L'icône Kilivre arrive sur l'écran d'accueil et s'ouvre en plein écran, sans barre Safari. L'app fonctionne ensuite hors ligne, sauf la recherche d'adresses, les itinéraires et le fond de carte.

### Option 2 : l'app native (fichier .ipa)
À chaque modification, GitHub Actions compile l'app iOS sur un Mac (workflow `Kilivre iOS`) et publie `CapColis-non-signe.ipa` dans les artefacts du run.

Apple interdit d'installer une app non signée. Deux façons de la signer :
- **Gratuit** : Sideloadly ou AltStore sur un ordinateur, avec votre identifiant Apple. Apple limite cette signature à 7 jours ; il faut la renouveler ensuite.
- **99 €/an** : un compte Apple Developer, puis TestFlight. L'app s'installe et se met à jour comme une app de l'App Store.

## Services utilisés (gratuits, sans clé)
- Adresses : Photon (OpenStreetMap) limité à la Belgique pour un code postal belge, Géoplateforme IGN pour un code postal français.
- Itinéraires : serveur OSRM public de démonstration. Pour un usage pro quotidien, hébergez votre propre OSRM et indiquez son adresse dans Réglages.
- Carte 3D : MapLibre et OpenFreeMap.
- Lecture des photos : Tesseract.js, sur le téléphone. Vos photos restent dans l'iPhone.

## Développer

```bash
cd cap-colis
npm test                      # optimiseur + lecture d'adresses
python3 -m http.server 8080   # puis http://localhost:8080
npm install && npm run ios:sync && npm run ios:open   # projet Xcode (Mac)
```

# 📺 SMV Player

Lecteur IPTV (portails **Stalker / MAG** et listes **M3U / Xtream**) sous forme d'application
**Electron** qui embarque **son propre serveur** : API, proxy des flux IPTV et transcodage HLS.
Ce serveur rend l'application utilisable depuis un **iPhone** (ou un iPad) du même réseau Wi-Fi,
installable sur l'écran d'accueil comme une vraie app.

---

## 🧱 Architecture

```
┌──────────────── PC (Windows / macOS / Linux) ────────────────┐
│  SMV Player (Electron)                                        │
│   ├─ fenêtre  ──────────────┐                                 │
│   └─ serveur intégré :9191 ◄┘◄──────── iPhone (Safari / app   │
│        ├─ /           interface (renderer/)      écran d'accueil)
│        ├─ /api/*      profils, portail Stalker, M3U (clé d'accès)
│        └─ /s/*        proxy des flux + transcodage HLS (ffmpeg)
└───────────────────────────────┬──────────────────────────────┘
                                ▼
                     Serveur IPTV (portail, flux)
```

- **Une seule interface** (`renderer/`) : la fenêtre Electron la charge depuis le serveur local,
  exactement comme Safari sur l'iPhone.
- **Proxy** (`server/playback.js`) : ajoute les en-têtes Stalker (MAC, jeton, User-Agent), suit les
  redirections, gère les requêtes `Range` (avance rapide VOD), réécrit les playlists HLS et coupe la
  connexion IPTV dès que le lecteur s'arrête.
- **Transcodage HLS pour iPhone** : Safari sur iPhone ne lit ni le MPEG-TS brut ni le MKV.
  Le serveur remuxe le flux en HLS avec ffmpeg (vidéo copiée sans perte, audio converti en AAC).
  HEVC → fMP4 compatible Apple, MPEG-2 / MPEG-4 → réencodage H.264 automatique.
- **ffmpeg est intégré** (`ffmpeg-static`), aucune installation nécessaire.

| Appareil | Flux TS live | HLS (.m3u8) | MP4 | MKV / AVI |
|----------|--------------|-------------|-----|-----------|
| PC (Electron) | mpegts.js | hls.js | natif | natif, sinon transcodage |
| iPhone / iPad | transcodage HLS → lecteur natif | lecteur natif | natif | transcodage HLS |

Sur iPhone, le lecteur natif apporte le plein écran, l'image dans l'image, AirPlay et la lecture en
arrière-plan. Le bouton 🎬 ouvre aussi le flux dans **VLC pour iOS**.

---

## 🚀 Démarrage

```bash
npm install
npm start            # application Electron
```

### 📱 Utiliser SMV Player sur iPhone

1. Lancez SMV Player sur le PC (le PC et l'iPhone doivent être sur le **même Wi-Fi**).
2. Ouvrez **⚙️ Paramètres → Accès iPhone / réseau local** : un QR code s'affiche.
3. Scannez-le avec l'appareil photo de l'iPhone → la page s'ouvre dans Safari.
4. Dans Safari : **Partager → Sur l'écran d'accueil**. SMV Player apparaît comme une app
   (plein écran, icône, connexion mémorisée).

Sans QR code : ouvrez l'adresse affichée (ex. `http://192.168.1.20:9191`) et saisissez le
**code d'accès** à 8 caractères.

Conseils :
- Windows demande au premier lancement d'autoriser SMV Player sur le pare-feu : acceptez pour les
  **réseaux privés**.
- Donnez une **IP fixe** au PC dans la box (bail DHCP statique) : l'app de l'écran d'accueil garde
  l'adresse du premier appairage.
- « **Garder le serveur actif quand la fenêtre est fermée** » laisse SMV Player dans la zone de
  notification pour regarder sur l'iPhone sans fenêtre ouverte sur le PC.
- Un flux ne passe pas sur iPhone ? Paramètres → Lecture → **Réencodage H.264**
  (compatibilité maximale, sollicite davantage le processeur du PC).

### 🖥️ Mode serveur seul (NAS, Raspberry Pi, PC toujours allumé)

```bash
npm run server                                   # port 9191, données dans ~/.smv-player
node server/cli.js --port 8080 --data-dir /srv/smv
```

Le terminal affiche l'adresse, le code d'accès et un QR code à scanner. Sur Linux, le ffmpeg
intégré est utilisé ; un `ffmpeg` du système peut être choisi via `ffmpegPath` dans `config.json`.

### 📦 Construire l'installateur

```bash
npm run build:win    # installateur NSIS Windows
npm run build:mac    # DMG macOS
npm run build:linux  # AppImage
```

Construisez sur le système cible : le binaire ffmpeg téléchargé par `npm install` dépend de la
plateforme.

---

## 🔐 Sécurité

- L'API exige le **code d'accès** (QR code / saisie). « Nouveau code » dans les paramètres
  déconnecte tous les appareils déjà appairés.
- Les liens de lecture (`/s/…`) sont des identifiants aléatoires à usage temporaire.
- Le PIN parental est vérifié par le serveur et n'est jamais renvoyé aux appareils.
- Le serveur est prévu pour le **réseau local** (HTTP, sans chiffrement) : ne l'exposez pas sur
  Internet. Pour regarder hors de chez vous, passez par un VPN (Tailscale, WireGuard…).
- L'accès réseau peut être coupé dans les paramètres : seul le PC garde alors l'accès.

---

## 🗂️ Structure

```
main.js            processus principal Electron (fenêtre, VLC, zone de notification)
preload.js         pont Electron minimal (fenêtre, VLC, sélection de fichiers)
server/
  index.js         serveur HTTP : interface, API, routage
  playback.js      proxy des flux + transcodage HLS ffmpeg
  stalker.js       client portail Stalker / MAG
  m3u.js           analyse des listes M3U / M3U Plus
  profiles.js      stockage des profils (profiles.json)
  config.js        configuration (config.json, code d'accès)
  cli.js           mode serveur sans interface
renderer/
  index.html, style.css, index.js   interface (PC + iPhone)
  api.js                            client de l'API
```

Les données (profils, configuration) sont dans le dossier utilisateur d'Electron
(`%APPDATA%/smv-player` sous Windows) : les profils existants sont conservés.

---

# 🚀 SMV Player — Git Workflow Multi-PC

## 📌 Objectif

Travailler sur plusieurs ordinateurs (maison, portable, boulot) **sans conflit Git** et avec un workflow simple.

---

## 🧠 Principe

👉 GitLab est ton point central
👉 Chaque ordinateur = une copie (clone) du projet

---

## ⚙️ 1. Installation (UNE FOIS par PC)

```bash
git clone https://gitlab.com/tangzer-group/smv-player.git
cd smv-player
npm install
```

---

## 🔄 2. Workflow quotidien

### ▶️ Avant de coder

```bash
git pull origin main
```

---

### 💻 Tu développes normalement

* Code
* Test
* Modifie tes fichiers

---

### 💾 Sauvegarder ton travail

```bash
git add .
git commit -m "description des changements"
git push origin main
```

---

## 🧩 3. Workflow simple résumé

```bash
git pull origin main
# coder
git add .
git commit -m "update"
git push origin main
```

---

## 🏢 4. Cas du PC du boulot (proxy / réseau bloqué)

### ❌ Si Git est bloqué :

* Utiliser une clé USB
* Ou Google Drive / Dropbox
* Ou zip du projet

👉 Puis commit depuis un autre PC

---

## ⚠️ 5. Règles IMPORTANTES

❌ Ne jamais faire :

* `git init` sur ce projet
* push sur `master` (utiliser `main`)
* commit `node_modules`

---

## ✅ Toujours faire :

* `git pull` avant de travailler
* `git push` après
* garder ton repo propre

---

## 📁 .gitignore recommandé

```bash
node_modules/
dist/
.env
```

---

## 🔥 Bonus (optionnel mais recommandé)

### Travailler avec des branches :

```bash
git checkout -b feature-nouvelle-fonction
git push origin feature-nouvelle-fonction
```

👉 Permet d’éviter de casser `main`

---

## 🧾 Conclusion

✔ Un seul repo central
✔ Plusieurs machines synchronisées
✔ Zéro conflit si tu respectes le workflow

---

## 💬 Besoin d’aide ?

Si tu bloques :

* erreur Git
* problème de merge
* config Electron

👉 Corrige direct plutôt que forcer (ex: `--force`)

---

# 📺 SMV Player 4

Lecteur IPTV auto-hébergé (portails **Stalker / MAG** et listes **M3U / Xtream**) : un serveur à
installer chez vous, sur un **Raspberry Pi** ou un **PC portable** avec **Docker**, et une
application web que vous ouvrez depuis **n'importe où sur Internet, en HTTPS** : iPhone, Android,
PC, tablette. Sur iPhone, elle s'installe sur l'écran d'accueil comme une vraie app.

- 🔐 Comptes protégés par mot de passe, connexions HTTPS avec certificat Let's Encrypt automatique
- 📡 Direct avec guide des programmes (en cours / à suivre), films, séries par saison, favoris, reprise
- 📱 Lecture adaptée à chaque appareil : TS direct sur PC, HLS natif sur iPhone (plein écran,
  image dans l'image, AirPlay), VLC en un clic
- 📶 Qualité réglable (Source, 1080p, 720p, 480p, 360p) pour regarder en 4G ou sur une connexion lente
- 🔒 PIN parental par source, vérifié par le serveur
- 🛡️ Les identifiants IPTV (MAC, mot de passe M3U, jetons) restent sur le serveur, jamais envoyés au navigateur

> Utilisez SMV Player uniquement avec des sources auxquelles vous avez légalement accès.

---

## 🧱 Architecture

```
 iPhone / Android / PC ──HTTPS──►  Caddy :443  ──►  SMV Player :9191  ──►  Fournisseur IPTV
   (navigateur / PWA)              certificat        ├─ /        application web (web/)
                                   Let's Encrypt     ├─ /api/*   comptes, sources, guide, lecture
                                                     └─ /s/*     proxy des flux + HLS (ffmpeg)
                         └──────────── Docker (Raspberry Pi, PC portable, serveur) ────────────┘
```

- **Le serveur fait tout le travail réseau** : il se connecte au portail (MAC, jeton, User-Agent),
  résout les liens de lecture et relaie les flux. Le navigateur n'envoie que « je veux la chaîne X ».
- **Transcodage HLS** (ffmpeg) : Safari sur iPhone ne lit ni le MPEG-TS brut ni le MKV ; le serveur
  remuxe le flux en HLS (vidéo copiée sans perte, audio en AAC). HEVC → fMP4 compatible Apple,
  MPEG-2 → H.264 automatique. Les qualités réduites réencodent la vidéo en H.264.
- **Caddy** obtient et renouvelle le certificat HTTPS tout seul et relaie la vidéo sans tampon.

| Appareil | Direct (TS) | Films MP4 | MKV / AVI / HEVC | Qualité réduite |
|----------|-------------|-----------|------------------|-----------------|
| PC, Android | mpegts.js | natif | natif, sinon HLS serveur | HLS serveur (hls.js) |
| iPhone / iPad | HLS serveur → lecteur natif | natif | HLS serveur | HLS serveur |

---

## 💻 Installation sur un PC portable (Docker Desktop)

Pour essayer SMV Player ou l'utiliser à la maison.

1. Installez **Docker Desktop** (Windows, macOS) ou Docker Engine (Linux).
   Sous Windows, gardez le moteur **WSL 2** proposé à l'installation.
2. Récupérez le projet : `git clone https://github.com/Tangzer5635/smv-player.git`,
   ou téléchargez le ZIP (bouton **Code → Download ZIP** sur GitHub) et décompressez-le.
   Dépôt privé : `git clone` demande votre identifiant GitHub et un jeton d'accès personnel en
   guise de mot de passe.
3. Créez la configuration :

   ```powershell
   cd smv-player
   Copy-Item .env.example .env      # macOS / Linux : cp .env.example .env
   notepad .env                     # macOS / Linux : nano .env
   ```

   Renseignez au minimum `SMV_ADMIN_PASSWORD` (8 caractères minimum). Gardez `DOMAIN=localhost`.
4. Démarrez :

   ```bash
   docker compose up -d --build
   ```

5. Ouvrez **https://localhost** et connectez-vous avec `admin` et votre mot de passe.

Avec `DOMAIN=localhost`, Caddy utilise sa propre autorité de certification : le navigateur affiche
un avertissement la première fois (« Paramètres avancés → Continuer »). C'est normal en local ; sur
Internet avec un vrai domaine (partie suivante), le certificat est reconnu partout.

- Accès sans HTTPS depuis le PC lui-même : http://localhost:9191
- Ports 80 / 443 déjà utilisés sur le PC ? Mettez par exemple `HTTP_PORT=8080` et
  `HTTPS_PORT=8443` dans `.env` puis ouvrez https://localhost:8443
- Depuis le téléphone, sur le même Wi-Fi : ajoutez l'IP du PC dans `.env`
  (`DOMAIN=localhost, 192.168.1.20`), relancez `docker compose up -d` et ouvrez
  `https://192.168.1.20` (avertissement de certificat à accepter, l'installation sur l'écran
  d'accueil d'un iPhone demande un vrai domaine).
- Réseau d'entreprise : si le fournisseur IPTV n'est joignable que par le proxy de l'entreprise,
  renseignez-le dans **Réglages → Réseau → Proxy HTTP** (`http://proxy:8080`). Pour que
  `docker compose --build` télécharge les images, configurez aussi le proxy dans Docker Desktop
  (Settings → Resources → Proxies).

---

## 🍓 Installation sur Raspberry Pi, accessible depuis Internet en HTTPS

### Ce qu'il faut

- Raspberry Pi 4 ou 5 (2 Go de RAM minimum), carte SD ou SSD, câble Ethernet conseillé
- **Raspberry Pi OS 64 bits** (Lite suffit), SSH activé
- Un **nom de domaine** pointant vers votre box : le vôtre, ou un sous-domaine gratuit
  [DuckDNS](https://www.duckdns.org) (`matv.duckdns.org`) mis à jour automatiquement si votre IP change
- L'accès à l'interface de votre box internet

### 1. Préparer la box

1. Donnez une **IP fixe** au Raspberry Pi (bail DHCP statique, ex. `192.168.1.50`).
2. Redirigez les ports vers cette IP (NAT / redirection de ports) :
   **TCP 80**, **TCP 443** et **UDP 443** (facultatif, HTTP/3).

Le port 80 sert à Let's Encrypt pour valider le domaine puis redirige vers HTTPS.

### 2. Créer le domaine DuckDNS (si vous n'avez pas de domaine)

Connectez-vous sur duckdns.org, créez un sous-domaine (ex. `matv`) et notez le **jeton** (token)
affiché en haut de la page. Avec votre propre domaine, créez plutôt un enregistrement DNS `A` vers
l'IP publique de votre box.

### 3. Installer SMV Player

```bash
ssh pi@192.168.1.50
sudo apt update && sudo apt install -y git
git clone https://github.com/Tangzer5635/smv-player.git
cd smv-player
./install.sh
```

Le script installe Docker si besoin, demande le domaine (`matv.duckdns.org`), l'identifiant et le
mot de passe administrateur, le sous-domaine et le jeton DuckDNS, puis construit et démarre tout.
La première construction prend quelques minutes sur un Pi.

> Docker vient d'être installé et la commande échoue avec « permission denied » ? Déconnectez-vous
> de la session SSH, reconnectez-vous et relancez `./install.sh`.

### 4. Vérifier

```bash
docker compose logs -f caddy     # « certificate obtained successfully » pour votre domaine
docker compose ps                # smv-player doit être « healthy »
```

Ouvrez **https://matv.duckdns.org** depuis votre téléphone en 4G : la page de connexion s'affiche
avec le cadenas HTTPS.

### Pas d'accès depuis Internet ?

- Testez depuis un réseau extérieur (4G) : beaucoup de box ne savent pas joindre leur propre IP
  publique depuis le Wi-Fi local.
- Vérifiez que le domaine pointe vers votre IP publique : `nslookup matv.duckdns.org`.
- Certains accès (4G/5G box, fibre avec IPv4 partagée, « CGNAT ») ne permettent pas d'ouvrir de
  ports. Demandez une IPv4 dédiée à votre opérateur (souvent gratuite), ou installez
  [Tailscale](https://tailscale.com) sur le Pi et vos appareils : vous accédez alors à SMV Player
  par un réseau privé chiffré, sans ouvrir de port.

---

## 🔑 Premier lancement

- Si `SMV_ADMIN_PASSWORD` est renseigné dans `.env`, le compte est créé au démarrage.
- Sinon, l'interface demande un **code d'installation** affiché dans les logs :
  `docker compose logs smv`. Il permet de créer le premier compte.

Ensuite : **Ajouter une source**.

| Type | À renseigner |
|------|--------------|
| Portail Stalker / MAG | adresse du portail (`http://exemple.com/c/`) et adresse MAC (`00:1A:79:…`) |
| Liste M3U / Xtream | adresse de la liste (`http://exemple.com/get.php?username=…&password=…&type=m3u_plus`) |
| Fichier M3U | fichier `.m3u` de votre ordinateur |

L'option « Uniquement les catégories françaises » filtre les catégories d'un portail Stalker. Un PIN
peut protéger chaque source ; il est demandé une fois par session de navigation.

### 📱 Installer l'app sur iPhone

Dans **Safari**, ouvrez votre adresse HTTPS → bouton **Partager** → **Sur l'écran d'accueil**.
SMV Player s'ouvre alors en plein écran, comme une app. Dans **Réglages**, un QR code de l'adresse
permet de l'ouvrir rapidement sur un autre appareil. Sur Android, Chrome propose « Installer
l'application ».

### Raccourcis clavier (PC)

`Espace` lecture/pause · `F` plein écran · `M` muet · `↑` / `↓` chaîne précédente / suivante ·
`←` / `→` reculer / avancer (films) · `/` recherche · `Échap` fermer

---

## 📶 Qualité et performances

Dans **Réglages → Lecture** (réglage propre à chaque appareil) :

- **Source** : le flux d'origine, sans réencodage. Le plus léger pour le serveur ; sur iPhone le
  serveur remuxe simplement en HLS.
- **1080p / 720p / 480p / 360p** : le serveur réencode la vidéo en H.264 à débit limité.
  Idéal en 4G ou sur une connexion lente, mais beaucoup plus gourmand pour le processeur.

Sur Raspberry Pi, le réencodage logiciel est lourd : gardez **Source** quand le débit le permet,
préférez **480p** pour un flux réduit, et limitez le nombre de réencodages simultanés avec
`SMV_MAX_TRANSCODES=1` ou `2` dans `.env`. Le **Raspberry Pi 4** possède un encodeur matériel
H.264 : mettez `SMV_H264_ENCODER=h264_v4l2m2m` dans `.env` et décommentez les lignes `devices`
du service `smv` dans `docker-compose.yml`. Le Raspberry Pi 5 n'en a pas, mais son processeur est
plus rapide.

Pensez aussi au débit montant de votre box : c'est lui qui limite la vidéo vue depuis l'extérieur.

---

## 🛠️ Administration

```bash
docker compose logs -f smv                    # journaux du serveur
docker compose restart smv                    # redémarrer
docker compose down                           # arrêter
git pull && docker compose up -d --build      # mettre à jour
```

**Mot de passe oublié** (crée le compte s'il n'existe pas) :

```bash
docker compose exec smv node server/admin.js reset-password admin 'nouveau mot de passe'
docker compose exec smv node server/admin.js list-users
```

**Sauvegarde** : tout est dans le dossier `data/` (comptes, sources, réglages, clé de session).
Copiez-le pour sauvegarder ; supprimez-le pour repartir de zéro.

Dans l'application, **Réglages** permet aussi de changer de mot de passe, de déconnecter tous les
appareils, de voir les flux en cours (et de les arrêter) et de régler le réseau sortant
(User-Agent, délai, proxy HTTP).

### Reprendre les profils de SMV Player 3 (version Electron)

Avant le premier démarrage, copiez `profiles.json` et `config.json` depuis
`%APPDATA%\smv-player` (Windows) ou `~/.smv-player` (mode serveur) dans le dossier `data/`.
Les profils deviennent des sources, PIN compris. Si SMV Player a déjà démarré, arrêtez-le,
supprimez `data/sources.json`, copiez les fichiers et relancez.

---

## 🔐 Sécurité

- **HTTPS** de bout en bout par Caddy, redirection automatique depuis HTTP.
- Mots de passe hachés (scrypt), session dans un cookie `HttpOnly`, `Secure`, `SameSite=Lax`,
  signé par une clé propre à votre serveur. « Déconnecter tous les appareils » invalide les sessions.
- Après 5 échecs de connexion, l'adresse IP et le compte visés sont bloqués pendant une durée
  croissante (de même pour les PIN).
- Protection CSRF (origine vérifiée, JSON obligatoire), en-têtes de sécurité stricts (CSP, etc.).
- Les liens de lecture `/s/…` sont des identifiants aléatoires valables le temps de la lecture
  (utilisables par VLC sans cookie), supprimés quand vous changez de chaîne ou arrêtez le flux.
- Les fichiers de `data/` ne sont lisibles que par le compte du serveur.
- Choisissez un mot de passe long : le serveur est exposé sur Internet. Une fois l'accès HTTPS
  validé, vous pouvez activer HSTS dans le `Caddyfile`. Mettez SMV Player à jour régulièrement.

---

## 🧑‍💻 Développement (sans Docker)

```bash
npm install          # Node.js 20 ou plus ; ffmpeg du système ou ffmpeg-static
npm run dev          # serveur relancé à chaque modification, http://localhost:9191
npm test             # tests (faux fournisseur IPTV, lecture, transcodage, API)
```

| Variable | Rôle | Défaut |
|----------|------|--------|
| `SMV_PORT`, `SMV_HOST` | port et interface d'écoute | `9191`, `0.0.0.0` |
| `SMV_DATA_DIR` | dossier des données | `./data` |
| `SMV_TRUST_PROXY` | `1` derrière Caddy (IP et HTTPS d'origine) | désactivé |
| `SMV_PUBLIC_URL` | adresse publique affichée | — |
| `SMV_ADMIN_USER`, `SMV_ADMIN_PASSWORD` | compte créé au premier démarrage | `admin`, — |
| `SMV_MAX_TRANSCODES` | flux HLS transcodés simultanés | `3` (`2` avec Docker) |
| `SMV_H264_ENCODER` | `libx264` ou encodeur matériel (`h264_v4l2m2m`) | `libx264` |
| `SMV_X264_PRESET` | préréglage libx264 | `ultrafast` (ARM), `veryfast` |
| `SMV_FFMPEG_PATH` | chemin de ffmpeg | `ffmpeg`, puis ffmpeg-static |

### Structure

```
server/
  index.js      démarrage, variables d'environnement
  app.js        routes HTTP : API, fichiers statiques, lecture
  auth.js       comptes, sessions signées, limitation des tentatives
  sources.js    sources (Stalker, M3U), bibliothèque, favoris, guide, résolution des flux
  stalker.js    client portail Stalker / MAG        m3u.js      analyse M3U / M3U Plus
  playback.js   proxy des flux + transcodage HLS    images.js   proxy des logos (cache)
  settings.js   réglages réseau                     net.js      accès sortant (proxy)
  http.js       utilitaires HTTP et en-têtes        admin.js    commandes d'administration
web/            application (HTML, CSS, modules JS sans compilation, service worker, icônes)
test/           tests automatiques et faux fournisseur IPTV
Dockerfile, docker-compose.yml, Caddyfile, install.sh, .env.example
```

---

## 🩺 Dépannage

| Symptôme | Piste |
|----------|-------|
| Pas de certificat HTTPS | ports 80/443 redirigés vers la bonne IP ? domaine qui pointe vers l'IP publique ? `docker compose logs caddy` |
| « Flux refusé : HTTP 4xx » | le fournisseur IPTV refuse la lecture (abonnement, nombre de connexions, adresse IP) : à voir avec lui |
| `connect ETIMEDOUT` dans les logs | le serveur ne joint pas le fournisseur : connexion Internet, pare-feu ou proxy (Réglages → Réseau) |
| Image saccadée à distance | baissez la qualité (720p ou 480p) ; vérifiez le débit montant de la box |
| Chaîne illisible sur iPhone | le badge « Compatibilité » indique la lecture HLS par le serveur ; essayez une qualité réduite |
| Raspberry Pi saturé | `SMV_MAX_TRANSCODES=1`, qualité Source, encodeur matériel sur Pi 4 |

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
* config Docker

👉 Corrige direct plutôt que forcer (ex: `--force`)

---

# 🎬 SMV Player

Lecteur IPTV moderne développé avec Electron permettant de charger des playlists M3U, parcourir les chaînes et intégrer progressivement un guide TV (EPG).

---

## ✨ Fonctionnalités

* 📺 Lecture de playlists M3U
* 🔍 Recherche de chaînes
* 📂 Organisation des groupes de chaînes
* ⚡ Interface Electron rapide et légère
* 🗓️ Support EPG (en cours de développement)
* 💾 Sauvegarde locale de la configuration

---

## 🛠️ Technologies utilisées

* Electron
* JavaScript
* HTML5
* CSS3

---

## 🚀 Installation

### Prérequis

* Node.js 20+
* npm

### Cloner le projet

```bash
git clone https://github.com/Tangzer5635/smv-player.git
cd smv-player
```

### Installer les dépendances

```bash
npm install
```

### Lancer l'application

```bash
npm start
```

---

## 📁 Structure du projet

```text
smv-player/
├── assets/
├── renderer/
│   ├── index.html
│   ├── renderer.js
│   └── style.css
├── main.js
├── preload.js
├── package.json
└── README.md
```

---

## 🔄 Workflow Git

Avant de commencer à développer :

```bash
git pull origin main
```

Après modification :

```bash
git add .
git commit -m "Description des changements"
git push origin main
```

Workflow rapide :

```bash
git pull origin main

# Développement

git add .
git commit -m "Update"
git push origin main
```

---

## 📋 Bonnes pratiques

Ne jamais versionner :

```text
node_modules/
dist/
.env
```

Toujours :

* Faire un `git pull` avant de commencer
* Faire des commits clairs
* Tester avant de pousser

---

## 🗺️ Roadmap

* [x] Chargement des playlists M3U
* [x] Interface Electron
* [ ] Gestion avancée des favoris
* [ ] EPG complet
* [ ] Enregistrement des chaînes
* [ ] Gestion multi-profils
* [ ] Packaging Windows

---

## 📄 Licence

Projet personnel développé par Tanguy Le Buhé.

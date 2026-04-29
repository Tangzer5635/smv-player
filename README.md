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

# 📺 SMV Player — Guide Git / GitLab

> Remote du projet :
> 👉 [https://gitlab.com/tangzer-group/smv-player.git](https://gitlab.com/tangzer-group/smv-player.git)

---

## ⚙️ 1. Configuration Git (à faire une seule fois)

```bash
git config --global user.name "Le-Buhe Tanguy"
git config --global user.email "tanguy.lebuhegaming@gmail.com"
git config --global push.autoSetupRemote true
```

👉 Permet de configurer ton identité et simplifier les `git push`

---

## 📥 2. Récupérer le code (PULL)

```bash
git pull
```

💡 Toujours faire ça avant de coder si le projet peut avoir changé

---

## 📤 3. Envoyer tes modifications (PUSH)

```bash
git add .
git commit -m "description claire"
git push
```

### ✍️ Exemples de commits

* `Ajout du menu settings`
* `Fix lecture plein écran`
* `Refonte UI accueil`

---

## 🏷️ 4. Créer une version (TAG)

```bash
git tag v1.0
git push origin v1.0
```

### 🔥 Exemples de versions

* `v1.0`
* `v1.1`
* `v2.0`
* `v2.1`

👉 Chaque tag = une version stable du projet

---

## 🔍 5. Voir les versions

```bash
git tag
```

---

## ⏪ 6. Revenir à une version

```bash
git checkout v1.0
```

⚠️ Mode lecture seule (tu es sur une version figée)

---

## 🔁 7. Repartir d’une ancienne version

```bash
git checkout v1.0
git checkout -b reprise-v1
```

👉 Tu peux recommencer à coder depuis cette version

---

## 🗑️ 8. Supprimer un tag

### Local

```bash
git tag -d v1.0
```

### GitLab

```bash
git push origin --delete v1.0
```

---

## 🔄 9. Workflow recommandé

```bash
git pull
# tu codes
git add .
git commit -m "modif"
git push
```

### Quand version terminée :

```bash
git tag vX.X
git push origin vX.X
```

---

## 🚫 10. Fichiers à ignorer (optionnel)

Si tu veux un repo propre :

```gitignore
node_modules/
dist/
*.log
.env
```

---
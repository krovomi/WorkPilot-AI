# ⚡ Quick Start: Smart Merge Manager

## 🎯 En 30 secondes

```bash
# 1. Installation (une seule fois)
bash scripts/install-merge-hooks.sh

# 2. Utilisation normale
git merge develop  # Vos .workpilot/ sont protégés automatiquement! ✅

# 3. Vérifier les backups
./scripts/smart-merge.sh list-backups
```

## ✅ C'est tout!

Désormais, chaque `git merge` ou `git rebase` :
- ✅ Sauvegarde `.workpilot/` automatiquement
- ✅ Fusionne les fichiers intelligemment
- ✅ Préserve 100% de vos données

## 🚀 Commandes utiles

```bash
# Merge avec feedback
./scripts/smart-merge.sh merge develop

# Rebase avec feedback
./scripts/smart-merge.sh rebase origin/develop

# Voir les backups
./scripts/smart-merge.sh list-backups

# Restaurer un backup
./scripts/smart-merge.sh restore backup_20240602_120000_develop

# Voir le statut
./scripts/smart-merge.sh status

# Désinstaller (si besoin)
bash scripts/uninstall-merge-hooks.sh
```

## 📖 Documentation

- **README complet** : [README_SMART_MERGE.md](README_SMART_MERGE.md)
- **Guide détaillé** : [docs/SMART_MERGE_GUIDE.md](docs/SMART_MERGE_GUIDE.md)
- **Vérifier les backups** : `bash scripts/verify-backup.sh`
- **Tester** : `bash scripts/test-smart-merge.sh`

## 🆘 En cas de problème

```bash
# Voir le statut du merge
./scripts/smart-merge.sh status

# Restaurer un backup spécifique
./scripts/smart-merge.sh list-backups
./scripts/smart-merge.sh restore <backup-name>

# Vérifier l'intégrité
bash scripts/verify-backup.sh
```

## 🎓 Cas réel

```bash
# Avant: Vos fichiers .workpilot/ se perdaient lors des merges
git merge develop  # ❌ Specs perdues!

# Après: Protection automatique
./scripts/install-merge-hooks.sh
git merge develop  # ✅ Specs préservées et fusionnées!
./scripts/smart-merge.sh status  # Voir le résultat
```

---

**Tout est automatique après l'installation.** N'hésitez pas à consulter la documentation complète si vous avez des questions.

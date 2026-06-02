# 🔄 Smart Merge/Rebase Manager

**Solution complète pour préserver vos modifications du worktree pendant les opérations git.**

## 🎯 Objectif

Vous aviez un worktree avec des modifications en attente de PR. Lors d'un merge/rebase automatique avec une autre branche, vos fichiers `.workpilot/` (specs, logs, conversation.jsonl) ont été perdus.

**Ce système évite ça définitivement** en :
✅ Sauvegardant vos fichiers `.workpilot/` **avant** toute opération  
✅ Fusionnant intelligemment les changements **après**  
✅ Préservant 100% de vos données (logs, specs, contexte)

## 🚀 Démarrage rapide

### Installation (une seule fois)

```bash
cd /c/Users/thomas.leberre/Repositories/Auto-Claude_EBP
bash scripts/install-merge-hooks.sh
```

C'est tout ! Les hooks s'activent automatiquement pour tous les futurs merge/rebase.

### Utilisation normale

```bash
# Merge/Rebase comme d'habitude, avec protection automatique
git merge develop
git rebase origin/develop
```

**Ou avec le wrapper pour plus de feedback** :

```bash
./scripts/smart-merge.sh merge develop
./scripts/smart-merge.sh rebase origin/develop
```

## 📦 Que se passe-t-il ?

### Avant le merge/rebase
```
[pre-merge-head hook]
↓
Sauvegarde .workpilot/ → .git/workpilot-backups/backup_20240602_120000_develop/
```

### Pendant
```
git merge/rebase s'exécute normalement
```

### Après le merge/rebase
```
[post-merge hook ou post-rebase hook]
↓
Restaure .workpilot/
↓
Fusionne intelligemment :
  - JSON → deep merge (locales clés preservées)
  - JSONL → déduplication (pas de doublon)
  - Autres → keep local (votre version gagne)
```

## 📊 Stratégies de fusion

| Type | Stratégie | Exemple |
|------|-----------|---------|
| `.json` | Deep merge | `implementation_plan.json`, `task_metadata.json` |
| `.jsonl` | Déduplication | `conversation.jsonl`, `task_logs.json` |
| Autres | Keep local | `dashboard_snapshot.json` |

## 💾 Backups automatiques

Chaque opération crée un backup :

```bash
# Lister les backups
./scripts/smart-merge.sh list-backups

# Restaurer un backup
./scripts/smart-merge.sh restore backup_20240602_120000_develop
```

Les backups sont dans `.git/workpilot-backups/` (conservés pendant 30 jours par défaut).

## ⚙️ Configuration avancée

### Modifier les fichiers "critiques" à fusionner

Éditer `scripts/smart-merge-manager.py` ligne ~30 :

```python
self.critical_patterns = [
    ".workpilot/specs/**/*.json",
    ".workpilot/**/*.jsonl",
    # Ajouter vos patterns ici
]
```

### Désinstaller les hooks

```bash
bash scripts/uninstall-merge-hooks.sh
```

## 🔍 Dépannage

### Vérifier que les hooks sont actifs

```bash
python3 scripts/smart-merge-manager.py list-backups
```

Si aucun backup n'existe, les hooks ne s'exécutent pas.

### Voir l'état du dernier merge

```bash
./scripts/smart-merge.sh status
cat .git/merge-state.json
```

### Restaurer manuellement

```bash
# Voir les backups
ls -la .git/workpilot-backups/

# Restaurer le plus récent
rm -rf .workpilot/
cp -r .git/workpilot-backups/backup_20240602_180000_*/ .workpilot/
```

## 📖 Documentation complète

Voir [docs/SMART_MERGE_GUIDE.md](docs/SMART_MERGE_GUIDE.md) pour :
- Architecture détaillée
- Gestion avancée des conflits
- Performance et limitations
- Support et améliorations

## ✨ Cas d'usage

### Worktree avec modifications en attente

Avant : Les specs et logs du worktree se perdaient lors d'un merge.

```bash
# Worktree 001 avec 3 commits
# Merge depuis worktree 002 → tous les fichiers .workpilot/ perdus ❌

# Maintenant :
git merge origin/002  # Automatiquement protégé ✅
# Vos specs, logs, conversation.jsonl restaurés et fusionnés
```

### Rebase pour rester à jour

```bash
git rebase origin/develop  # Vos fichiers .workpilot/ préservés ✅
```

### Récupération après erreur

```bash
# Quelque chose a mal tourné ?
./scripts/smart-merge.sh list-backups
./scripts/smart-merge.sh restore backup_20240602_120000_develop
```

## 🔐 Sécurité

- Les backups sont stockés localement (`.git/workpilot-backups/`)
- Aucun upload ni partage automatique
- Les permissions de fichier sont préservées
- Compatible avec les fichiers sensibles

## 📝 Notes

- Les hooks s'exécutent silencieusement après chaque merge/rebase
- Logs détaillés disponibles via `./scripts/smart-merge.sh status`
- Compatible avec tous les workflows git (merge, rebase, cherry-pick en git native)
- Pour les conflits : résolvez manuellement, la restoration est automatique

## 🎓 Exemple complet

```bash
# État initial
git status  # worktree/001 avec specs et logs

# Merge depuis une autre branche
./scripts/smart-merge.sh merge origin/develop
# [Smart Merge] Running pre-merge backup...
# ✓ Backed up .workpilot to .git/workpilot-backups/backup_...
# [Git] Merging origin/develop...
# [Smart Merge] Running post-merge restoration...
# ✓ Merged 18 files
# ✓ Smart merge completed successfully!

# Vérifier les résultats
./scripts/smart-merge.sh list-backups
git log --oneline  # Nouveaux commits de origin/develop
cat .workpilot/specs/001-*/conversation.jsonl | wc -l  # Vos logs préservés ✅
```

---

**Questions ?** Voir [docs/SMART_MERGE_GUIDE.md](docs/SMART_MERGE_GUIDE.md) ou tester avec `./scripts/smart-merge.sh help`

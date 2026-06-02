# 📦 Installation de l'intégration WorkPilot

La sécurité du projet Claude Code bloque l'accès direct à `.git/`, donc l'installation se fait en deux étapes :

## 🚀 Étape 1 : Fichiers Python sont déjà en place

Les deux fichiers de wrapper pour WorkPilot sont prêts :

```
scripts/
├── workpilot-auto-merge-hook.py      ✅ Créé
├── workpilot-merge-wrapper.py        ✅ Créé
└── smart-merge-manager.py             ✅ Créé (précédemment)
```

## 🔌 Étape 2 : Intégration dans votre code WorkPilot

### Si vous contrôlez le code de merge/rebase dans WorkPilot

Remplacez votre appel `git merge` par :

```python
import subprocess
import os
from pathlib import Path

# À la place de : subprocess.run(["git", "merge", target_branch])

env = os.environ.copy()
env.update({
    "WORKPILOT_OPERATION": "merge",
    "WORKPILOT_TARGET_BRANCH": target_branch,
    "WORKPILOT_REPO_PATH": str(repo_path),
    "WORKPILOT_TASK_ID": task_id,
    "WORKPILOT_AUTO_MERGE": "true"
})

hook_script = Path(repo_path) / "scripts" / "workpilot-auto-merge-hook.py"
result = subprocess.run(
    ["python3", str(hook_script)],
    env=env
)

if result.returncode == 0:
    print("✓ Merge completed with .workpilot preservation")
else:
    print("✗ Merge failed")
    sys.exit(result.returncode)
```

### Pour le rebase :

```python
env["WORKPILOT_OPERATION"] = "rebase"
# Même code, mais avec "rebase" à la place de "merge"
```

### Pour le pull :

```python
env["WORKPILOT_OPERATION"] = "pull"
env["WORKPILOT_TARGET_BRANCH"] = f"{remote}/{branch}"
# Même code, mais avec "pull" à la place de "merge"
```

## 🧪 Test Manuel

Pour tester sans modifier votre code WorkPilot :

```bash
cd /path/to/your/worktree

export WORKPILOT_OPERATION=merge
export WORKPILOT_TARGET_BRANCH=develop
export WORKPILOT_REPO_PATH=$(pwd)
export WORKPILOT_TASK_ID=test-001
export WORKPILOT_AUTO_MERGE=true

python3 /path/to/Auto-Claude_EBP/scripts/workpilot-auto-merge-hook.py
```

Vérifiez le résultat :

```bash
cat .git/workpilot-auto-merge-status.json
```

## 📋 Fichiers impliqués

### Fichiers créés (à committer)

```
✅ WORKPILOT_INTEGRATION.md        - Documentation d'intégration
✅ scripts/workpilot-auto-merge-hook.py
✅ scripts/workpilot-merge-wrapper.py
✅ scripts/smart-merge-manager.py   (créé précédemment)
✅ scripts/git-hooks/               (créés précédemment)
```

### Fichiers modifiés à la main

Vous n'avez **que deux fichiers à modifier** dans votre code WorkPilot :

1. Fichier qui exécute les merges/rebases automatiques
2. Remplacer l'appel `subprocess.run(["git", "merge", ...])` par le wrapper

## 🔄 Flux complet

```
WorkPilot AI Task
    ↓
[Appelle votre code modifié]
    ↓
workpilot-auto-merge-hook.py
    ↓ (env vars)
workpilot-merge-wrapper.py
    ↓
smart-merge-manager.py
    ↓
[pre-merge backup]
    ↓
[git merge/rebase]
    ↓
[post-merge restoration]
    ↓
✅ Fichiers .workpilot préservés
```

## 🔍 Vérification

Après intégration, quand WorkPilot fait un merge :

1. Un backup est créé dans `.git/workpilot-backups/backup_XXXXX_branch/`
2. Un status file est créé dans `.git/workpilot-auto-merge-status.json`
3. Vos fichiers `.workpilot/` sont présents et à jour

```bash
# Vérifier les backups
ls -la .git/workpilot-backups/

# Vérifier le status
cat .git/workpilot-auto-merge-status.json

# Vérifier les fichiers
ls -la .workpilot/specs/001-*/
wc -l .workpilot/specs/001-*/conversation.jsonl
```

## ⚠️ Notes

- **Non-bloquant** : Si l'intégration échoue pour une raison, le git command s'exécute quand même
- **Fallback gracieux** : La solution fonctionne même si Smart Merge Manager n'est pas disponible
- **Logs détaillés** : Tous les logs pour débogage sont disponibles
- **Compatible** : Fonctionne avec tous les workflows (merge, rebase, pull, cherry-pick)

## 🚀 Prochaines étapes

1. ✅ Fichiers Python sont créés
2. 📝 Identifier où WorkPilot exécute les merges/rebases
3. 🔧 Modifier ce code pour appeler `workpilot-auto-merge-hook.py`
4. 🧪 Tester avec une tâche réelle
5. 🎉 Profitez de la protection automatique !

---

Pour plus de détails, voir [WORKPILOT_INTEGRATION.md](WORKPILOT_INTEGRATION.md)

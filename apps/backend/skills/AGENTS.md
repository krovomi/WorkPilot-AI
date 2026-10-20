# AGENTS.md — skills Python exécutables

Deux skills vivent ici, `angular/` et `migration/`, chargés par `skill_manager.py`.

**Ce ne sont pas les skills servis aux agents.** Ceux-là vivent dans `skills/` à la racine et sont
servis aux harnesses en markdown ([`skills/README.md`](../../../skills/README.md)). La différence est
le consommateur : un skill d'ici embarque des scripts Python que le code de WorkPilot exécute ;
c'est une bibliothèque avec un manifeste, pas un prompt.

> Backend : [`../AGENTS.md`](../AGENTS.md) · Règles : [`docs/rules/backend.md`](../../../docs/rules/backend.md)

## Structure

```
<skill>/
  SKILL.md      frontmatter (name, description, triggers, category, version) + instructions
  scripts/      exécutables autonomes, appelés par skill.execute_script()
  data/         données de référence (ex. migration/data/breaking_changes.json)
  templates/    modèles de documents
```

## Chargement progressif

`SkillManager` charge en trois temps, pour qu'un skill inutilisé ne coûte presque rien :

1. **Métadonnées** — le frontmatter de chaque `SKILL.md`, à la construction.
2. **Instructions** — le corps, sur `load_skill(name)`.
3. **Ressources** — scripts et modèles, seulement à la demande.

```python
from skills.skill_manager import SkillManager

manager = SkillManager("apps/backend/skills")
skill = manager.load_skill("framework-migration")
result = skill.execute_script("analyze_stack.py", {"project-root": "/path/to/project"})
```

Le frontmatter passe par `skills_registry.frontmatter`, le parseur de tout le dépôt. Pas d'autre.

## Écrire un skill

1. `mkdir <nom>/{scripts,data,templates}`, puis `SKILL.md` avec `name`, `description`,
   `triggers`, `category`, `version`.
2. Chaque script prend des arguments `--option valeur`, s'exécute seul et imprime du JSON
   (succès ou échec structuré).
3. `description` sous ~512 caractères et une poignée de `triggers` : la couche métadonnées est
   toujours chargée, c'est elle qui coûte du contexte à chaque exécution.
4. Tester par `SkillManager`, pas en important le script : c'est ainsi qu'il sera appelé.
5. Un script reçoit des chemins et des options venus d'un projet : arguments en liste, sans shell,
   chemins résolus (règle S4 de [`docs/rules/security.md`](../../../docs/rules/security.md)).

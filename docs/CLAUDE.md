# Carte normative et justifications de conception

Les **règles critiques** sont dans [`../AGENTS.md`](../AGENTS.md), le seul fichier que tous les agents
lisent (Claude Code par l'import de `CLAUDE.md`). Les règles détaillées sont dans [`rules/`](rules/) ;
les deux sont **normatifs**. Les `AGENTS.md` locaux sont des index : ils disent où regarder, pas ce qui
est permis. En cas de désaccord, la règle gagne et l'index est à corriger.

Claude Code charge ce fichier quand il lit un fichier de `docs/` ; les autres agents y arrivent par lien.

## Où vit chaque chose

| Besoin | Fichier | Chargé |
|---|---|---|
| Règles qui valent partout | [`../AGENTS.md`](../AGENTS.md) | toujours, par tous les agents |
| Sécurité | [`rules/security.md`](rules/security.md) | en lisant `apps/backend/security/`, `apps/backend/server/`, `apps/frontend/src/main/`, `.github/workflows/` ; sinon à la demande |
| Python, agents, clients LLM, tests backend | [`rules/backend.md`](rules/backend.md) | en lisant `apps/backend/` |
| Electron, React, IPC, i18n | [`rules/frontend.md`](rules/frontend.md) | en lisant `apps/frontend/` |
| Commandes, hooks, branches, CI, release | [`rules/workflow.md`](rules/workflow.md) | en lisant `.github/workflows/` ; sinon à la demande |
| Pourquoi une feature est construite ainsi | [`architecture/<feature>.md`](architecture/), section ci-dessous | à la demande |
| Fichiers d'instructions par agent | [`architecture/agent-instructions.md`](architecture/agent-instructions.md) | à la demande |
| Toute la documentation | [`README.md`](README.md) | à la demande |

## Justifications de conception (`architecture/`)

Pourquoi chaque feature est construite ainsi : un fichier par feature dans [`architecture/`](architecture/).
Lire le fichier avant de modifier la feature ; ce fichier-ci reste l'autorité sur les règles. Point
d'entrée : [product-overview.md](architecture/product-overview.md) (une ligne par vue de l'app).

**Il n'y a plus de table à tenir ici.** Chaque fichier commence par un frontmatter qui dit ce qu'il
couvre, et l'index se lit dans les fichiers eux-mêmes :

```bash
python scripts/docs_index.py              # toute la table : feature, fichier, contenu
python scripts/docs_index.py sandbox mcp  # seulement les lignes qui contiennent ces mots
grep -l "mot" docs/architecture/*.md      # sans Python
```

Une nouvelle feature dont la conception mérite d'être expliquée : **un nouveau fichier**
`architecture/<feature>.md`, et rien d'autre (ni ce fichier, ni `AGENTS.md`, ni `README.md`) :

```markdown
---
feature: Nom court de la feature
summary: >-
  Une ou deux phrases (400 caractères au plus) : le choix de conception et ce qu'il garantit.
---

# Titre
```

`tests/test_docs_context.py` vérifie que chaque fichier a ce frontmatter et que ce fichier-ci ne
liste aucune feature : deux PR ouvertes en même temps ne touchent plus les mêmes lignes.

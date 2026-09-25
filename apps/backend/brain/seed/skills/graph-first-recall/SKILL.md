---
name: "graph-first-recall"
description: "Rappel économe en tokens : graphe (Graphify/Obsidian) d'abord, index ensuite, fichier brut en dernier. Pour décisions, emplacements, relations."
metadata:
  workpilot:
    provenance: "graph-first-recall — The Agentic Dev (https://mkc.sh/the-agentic-dev), adapté au cerveau WorkPilot"
---

# graph-first-recall

Pour répondre à une question de **rappel** — « qu'est-ce qu'on avait décidé pour X ? », « où se trouve Y ? », « qu'est-ce qui est relié à Z ? » — n'ouvre pas les fichiers en premier. Descends l'échelle ci-dessous et **arrête-toi dès que tu as la réponse**. Le but : répondre juste, avec le minimum de tokens.

## Quand l'utiliser

- Questions sur des décisions passées, l'emplacement d'un fichier/note, ou les relations entre concepts.
- Un knowledge graph existe (Graphify `graph.json`) **ou** un vault Obsidian avec des liens `[[...]]` et du frontmatter.
- Grosse base : relire les fichiers coûterait des milliers de tokens.

## Quand NE PAS l'utiliser

- Tu dois **modifier** un fichier précis déjà identifié → ouvre-le directement.
- Petite base (< ~10 fichiers) → lire directement est plus simple.
- Question qui ne porte pas sur le contenu du repo/vault.

## L'échelle de recall (s'arrêter dès qu'on a la réponse)

### 1. Le graphe d'abord — ~0 token
Interroge le graphe pour voir la **structure et les relations** sans ouvrir aucun fichier.

- **Graphify** (`graph.json`) : requête ciblée par label / voisins.
- **Obsidian** : suis les liens `[[...]]` et les backlinks autour du sujet.

Objectif : identifier les 1 à 3 nœuds pertinents et leurs connexions.

### 2. L'index ensuite — quelques centaines de tokens
Sur les nœuds repérés, lis **uniquement** les métadonnées : chemins, frontmatter (`status`, `tags`, `title`, dates). Ça te dit *quels fichiers* valent la peine d'être ouverts — sans les ouvrir.

### 3. Le fichier brut en dernier — ce qu'il faut, rien de plus
Ouvre le **contenu complet** seulement des notes/fonctions réellement nécessaires pour formuler la réponse. Jamais « tout le dossier par sécurité ».

## Dans le cerveau WorkPilot (serveur MCP `workpilot-brain`)

Si le serveur MCP `workpilot-brain` est branché, c'est lui l'échelle — un outil par niveau :

| Niveau | Outil MCP | Coût |
|---|---|---|
| 1. graphe | `brain_recall` (ou `query_graph`, `get_node`, `shortest_path`) | ~0 : labels, tags, voisins |
| 2. index | `brain_recall` renvoie aussi le frontmatter des nœuds trouvés | quelques centaines de tokens |
| 3. fichier brut | `brain_read_note` sur le `source_file` retenu | ce qu'il faut, rien de plus |

Le cerveau est synchronisé (git pull avant lecture, git push après écriture) : ce que tu y lis
est ce que les autres agents y ont écrit. Ce que tu apprends de durable, écris-le avec
`brain_write_note` ou `brain_remember` — pas seulement dans ta mémoire locale.

## Comment interroger le graphe Graphify

**Où est le graphe :** Graphify écrit `graph.json` à la racine de son dossier de sortie (par défaut `graphify-out/graph.json`), dans ton repo ou ton vault Obsidian.

Chemin générique : `<VAULT>/graphify-out/graph.json` — où `<VAULT>` est la racine de ton repo/vault.

> L'emplacement dépend de ta machine — **ne code pas de chemin en dur**. Définis la variable d'env `GRAPH_JSON` pour pointer sur le fichier, sinon remplace `<VAULT>` par ton chemin réel.

Structure : `nodes` (chaque nœud = `id`, `label`, `file_type`, `source_file`, `metadata`) et `links` (`source`, `target`).

Requête ciblée sans relire tout le fichier (quelques centaines de tokens) :

```bash
python3 - <<'PY'
import json, os
# Variable d'env GRAPH_JSON si définie, sinon remplace <VAULT> par ton chemin
GRAPH = os.environ.get('GRAPH_JSON', '<VAULT>/graphify-out/graph.json')
g = json.load(open(GRAPH))
nodes = {n['id']: n for n in g['nodes']}
q = 'auth'  # le sujet cherché, en minuscules
hits = [n for n in g['nodes'] if q in n.get('label','').lower()]
for h in hits[:8]:
    nid = h['id']
    voisins = []
    for l in g['links']:
        if l['source'] == nid: voisins.append(nodes.get(l['target'],{}).get('label', l['target']))
        elif l['target'] == nid: voisins.append(nodes.get(l['source'],{}).get('label', l['source']))
    print(f"- {h['label']}  ({h.get('source_file','?')})")
    if voisins: print(f"    reliés: {', '.join(voisins[:8])}")
PY
```

Le `source_file` de chaque nœud te donne directement le chemin à cibler aux étapes 2 et 3.

### Serveur MCP Graphify (si branché)
Graphify expose un serveur MCP officiel :
`python -m graphify.serve <VAULT>/graphify-out/graph.json`
avec les outils `query_graph`, `get_node`, `shortest_path`, `list_prs`. Si ce serveur est disponible, préfère-le au parsing manuel.

## Fallback : pas de graphe Graphify

1. **Graphe de liens Obsidian** : pars du fichier le plus proche du sujet, suis ses `[[liens]]` et ses backlinks pour cartographier le voisinage.
2. **Index frontmatter** : `grep` sur les champs frontmatter (`status:`, `tags:`, titres) pour cibler, sans lire les corps.
3. Si le sujet est du **code** et qu'aucun graphe n'existe, lance Graphify (`graphify <agent> install` puis génération) — la construction AST coûte 0 token.

## Règles

- **Toujours commencer par l'étape 1.** Ne saute au fichier brut que si le graphe/index ne suffisent pas.
- **Stop dès que tu as la réponse** — ne descends pas l'échelle « pour être complet ».
- Ne relis jamais le `graph.json` entier dans le contexte : requête ciblée uniquement.
- Le graphe peut être **périmé** (généré à un instant T) : si un résultat semble obsolète, vérifier le fichier source réel.
- Portable : ce `SKILL.md` doit se comporter pareil sur Claude Code, OpenClaw, Cursor, Codex, Gemini CLI — aucune dépendance à un outil unique.

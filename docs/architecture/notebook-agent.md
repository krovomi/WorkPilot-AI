# Agent notebooks : dépendances, exécution, fonctions

> Pourquoi la page Notebooks lit les dépendances entre cellules, exécute un notebook dans un noyau
> neuf et change les cellules longues en fonctions, et comment. Issue : #371. Règles :
> [`docs/CLAUDE.md`](../CLAUDE.md), [`security.md`](../rules/security.md) (S2, S4, S6).

## Le constat

La vérification lisait chaque cellule seule : ordre d'exécution, cellule vide ou longue, import
manquant, sortie sensible. Elle ne disait pas ce qui casse un notebook rouvert par quelqu'un
d'autre : une cellule qui lit une variable définie plus bas, un état laissé par une exécution
hors ordre, une sortie enregistrée que le code ne produit plus. Et une cellule de cent lignes
restait une cellule de cent lignes.

## Les dépendances (`notebook_agent/dataflow.py`)

Pour chaque cellule de code : les noms qu'elle définit, ceux qu'elle lit tout de suite et ceux
qu'elle ne lit que dans le corps d'une fonction (lus à l'appel, pas à la définition).

- **Python** est lu exactement, par `ast` et `symtable` : définitions, lectures immédiates ou
  différées, mutations (`df.x = …`, `lst.append`), imports, `global` dans une fonction.
- **Les autres langages** (R, Julia, C#, F#, PowerShell, Scala, Kotlin, JavaScript, TypeScript,
  Go, Rust) sont lus par leurs déclarations, après avoir blanchi commentaires et chaînes et
  masqué les corps de fonction. Le résultat est marqué `precise: false` et la page le dit.

Une arête va de la dernière cellule qui définit un nom à celle qui le lit. Le graphe donne un
ordre topologique, le plus proche possible de l'ordre du notebook, ou rien s'il y a un cycle.
Les constats : `used_before_defined`, `undefined_name` (Python seulement, et jamais en présence
d'un `import *`, d'un `%run`, d'un `exec` ou de `globals()`), `hidden_state` (compteurs
d'exécution), `implicit_global`, `shared_mutation`, `duplicate_code` (fenêtres de six lignes,
tout langage).

## Les fonctions (`notebook_agent/refactor.py`)

Une cellule Python de plus de 50 lignes devient une proposition : ses paramètres sont les noms
qu'elle lit dans les cellules d'avant, ses retours ceux que les cellules d'après lisent. La
fonction va dans `<notebook>_functions.py`, à côté du notebook, avec les imports dont elle a
besoin ; la cellule garde les imports que les suivantes lisent encore, puis importe la fonction
et l'appelle. Une cellule n'est pas proposée quand ce changement modifierait ce qu'elle fait :
magie (`%`, `!`), `import *`, `global` ou `nonlocal`, `await` au premier niveau, `return` ou
`yield`, `del` d'un nom d'une autre cellule, dernière expression affichée. La raison est montrée.

Le nettoyage, facultatif, retire sorties, compteurs d'exécution et métadonnées de run. Seuls les
`.ipynb` sont réécrits.

**Rien n'est écrit dans le dossier du projet.** Le main ouvre une carte de revue
(`openReviewRun(projectPath, "notebook-agent", …)`, voir
[generated-review.md](generated-review.md)) ; le runner réécrit le notebook dans son worktree ;
la carte est validée en commit, ou retirée si rien n'a changé.

## L'exécution (`notebook_agent/executor.py`, `outputs.py`)

`jupyter nbconvert --execute --allow-errors` exécute le notebook dans un dossier temporaire,
avec le noyau qu'il nomme, quel qu'il soit (`jupyter kernelspec list --json`) ; un noyau absent
renvoie `no_kernel` et la commande qui l'installe. Quarto et R Markdown passent par
`quarto render --to ipynb --execute`. Un `.dib` n'a pas de lanceur en ligne de commande : la
page ne propose pas de l'exécuter. Le notebook lui-même n'est jamais modifié.

Chaque sortie fraîche est comparée à celle enregistrée : erreur, assertion en échec, dépendance
absente (module, paquet R, type .NET, CUDA), figure vide, forme de tableau changée (pandas,
polars, tibble), texte changé (adresses mémoire et durées mises à part). Le score est la part
des cellules exécutées sans erreur ; la concordance, la part des sorties identiques.

## Les garde-fous

- **Le chemin** vient du renderer : relatif, sans `..`, hors `.workpilot/`, suffixe de notebook
  (`main/notebook-agent/notebook-runs.ts`), puis résolu dans le projet, sans lien symbolique, au
  plus 20 Mo, par le runner (S4, S6).
- **Le code du notebook est celui du dépôt** : il s'exécute sans shell (liste d'arguments), dans
  une copie temporaire, avec un environnement sans identifiants (`env_without_credentials`),
  une limite par cellule et par run, le groupe de processus tué au dépassement ; une cellule
  marquée `skip-execution` est sautée. La page le dit avant le clic.
- **Le contenu des cellules est une donnée** (S2) : aucun modèle n'est appelé, ni pour lire ni
  pour réécrire.

## L'historique (`notebook_agent/history.py`)

`.workpilot/notebooks/history.jsonl` garde une ligne par vérification, exécution et refactor :
des comptes seulement, jamais de code ni de sortie. La page en montre les douze derniers mois.

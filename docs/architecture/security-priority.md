---
feature: "Scan de sécurité : priorité par atteignabilité et production"
summary: >-
  Chaque faille du scan reçoit base CVSS × atteignabilité × usage en production et une section
  (exposée, dormante, moyenne, informative), d'après un graphe d'imports textuel tout langage et
  les incidents APM de .workpilot/incidents/ ; l'ordre change, jamais ce qui bloque.
---

# Scan de sécurité de la QA : quelles failles corriger d'abord

> Issue : #364. Règles : [`docs/rules/security.md`](../rules/security.md) (S2, S4),
> [`backend.md`](../rules/backend.md) (contrats d'imports).

Le scan de sécurité de la QA (`security/qa_scanner.py`) remontait tout ce que Bandit, Semgrep,
les audits de dépendances et ses motifs trouvaient, par gravité. Sur un gros dépôt, la plupart de
ces alertes tombent dans du code mort, des tests ou des chemins que rien n'appelle, et le rapport
finit ignoré. Le scan classe maintenant chaque trouvaille selon ce qui tourne vraiment.

```
apps/backend/security/finding_priority.py   score et section, sans E/S
apps/backend/security_reach/
  sources.py       fichiers du projet, bornés, sans suivre de lien
  graph.py         points d'entrée et atteignabilité, tout langage
  dependencies.py  dépendances déclarées, importées, transitives
  runtime.py       incidents de production des 30 derniers jours
  __init__.py      evidence_for(projet, trouvailles)
```

## Le score et les sections

`priorité = base × atteignabilité × production`. La base est le CVSS du scanner, sinon le milieu
de la bande de sa gravité (critique 9,5, haute 7,5, moyenne 5). L'atteignabilité vaut 1 pour un
code atteint, 0,8 si elle est incertaine ou inconnue, 0,3 pour un code qu'aucun point d'entrée
n'atteint, 0,2 pour du code de test. La production vaut 1,5 si la pile d'un incident récent passe
par le code, 0,8 s'il existe des incidents mais aucun par lui, 1 sans aucune donnée.

1. **Critique et exposée** : critique ou haute, et vue en production ; sans aucune donnée de
   production, atteinte depuis un point d'entrée.
2. **Critique mais dormante** : critique ou haute, pas vue tourner.
3. **Moyenne** : le reste de ce qui est atteint ou peut l'être.
4. **Informative** : code jamais atteint, et code de test.

**Le classement n'enlève rien et ne change pas le verdict.** `passed` et `blocking` suivent
toujours la gravité, et chaque trouvaille critique ou haute reste dans la liste du fixer, rangée
seulement : une analyse d'atteignabilité qui se trompe ne peut pas cacher une faille. Un secret
écrit dans le dépôt est exposé où qu'il soit : il n'est jamais rétrogradé.

## L'atteignabilité, pour tout langage

Un graphe au niveau des fichiers, lu dans le texte plutôt que dans l'AST d'un seul langage :

- **Points d'entrée** : un fichier nommé comme un point de départ (`main`, `app`, `server`,
  `index`, `handler`, `urls`…), un fichier qui en déclare un (route Flask, FastAPI, Express,
  Spring, ASP.NET Core, Rails, Laravel, `func main`, `fn main`, `static void Main`, commande
  click…), ou un fichier qu'un manifeste lance (`package.json`, `pyproject.toml`, `Procfile`,
  `Dockerfile`…).
- **Arêtes** : les lignes d'import (`import`, `from`, `require`, `use`, `using`, `include`…)
  nomment des fichiers par leur nom ou leur dossier. En Java, Kotlin, C#, Swift ou Scala, où un
  type s'utilise sans import, un fichier atteint aussi ceux qui portent le nom des types qu'il
  cite, et les fichiers de son dossier (le paquet de Go ou de Java, l'espace de noms de C#).
- Le graphe penche vers « atteint » : une arête de trop laisse une faille où elle était, une de
  moins la ferait descendre.
- Un projet qui charge du code par son nom (`importlib`, `eval`, `require(variable)`,
  `Class.forName`, `Activator.CreateInstance`…) rend incertain ce qui n'est pas atteint, avec
  « dynamic code detected, reachability uncertain ».
- Sans aucun point d'entrée, rien n'est rétrogradé et le rapport le dit.

Une dépendance vulnérable est atteinte quand un fichier atteint l'importe par son nom ; une
dépendance que les manifestes du projet ne déclarent pas est marquée **transitive** et reste
incertaine, puisqu'on peut l'exploiter par celle qui l'apporte. Un paquet importé sous un autre
nom (PyYAML s'importe `yaml`) reste incertain plutôt que dormant.

## La production

`runtime.py` lit la même boîte que Regression Guardian, `.workpilot/incidents/*.json`, où
n'importe quel outil de suivi (Sentry, Datadog, CloudWatch, New Relic, PagerDuty, Grafana,
OpsGenie, ou un simple `{"title", "stack"}`) dépose ses payloads, avec le parseur partagé
(`regression_guardian.incident_parser`). Un payload de moins de 30 jours dit que les fichiers de
sa pile ont tourné ; ses frames sous `node_modules/`, `site-packages/`, `vendor/`… nomment les
dépendances qui ont tourné ; le nombre d'utilisateurs touchés s'affiche quand l'outil le donne.
Sans incident récent, le rapport dit que la corrélation est coupée et comment la brancher, et
l'atteignabilité seule classe.

## Frontières

- Un payload est une donnée (S2) : ses chemins sont seulement comparés à la liste des fichiers
  du projet, jamais ouverts ; rien de ce qu'il dit ne choisit un outil, une commande ou un chemin.
- La boîte n'est lue que dans le projet, sans suivre de lien (S4), bornée en fichiers et en
  octets ; le parcours des sources ne suit aucun lien et s'arrête à 20 000 fichiers de 512 Ko.
- Aucun modèle, aucun réseau, aucune dépendance nouvelle : le même classement pour chaque
  provider et chaque pile.
- `security_reach` n'importe que `security` et `regression_guardian`
  (`tests/test_import_contracts.py`) ; `security` ne l'importe pas : la boucle de QA
  (`qa.loop._run_security_scan`) passe `evidence_for` au scanner.

## Ce qui n'est pas fait

La PR de correction automatique des failles exposées n'est pas ouverte par le scan : les failles
critiques et hautes vont déjà au fixer de la QA, maintenant les exposées en premier, dans le
worktree de la tâche.

# Veille des contrats d'API (#389)

Une tâche qui modifie un contrat d'API peut casser des clients que personne n'a prévenus. La
veille compare chaque contrat que la branche touche avec la base de fusion de la branche cible,
range chaque différence dans une des trois catégories (cassant, peut-être cassant, sans risque),
cherche qui consomme l'endpoint, et le dit à trois endroits : la porte QA, la section de la PR et
la page API Watcher. Aucun modèle n'est appelé : tout est déterministe et rejouable.

```
apps/backend/api_watcher/
  contract_parser.py          OpenAPI 2/3 (YAML ou JSON), GraphQL SDL, protobuf → un seul modèle
  breaking_change_detector.py les règles de comparaison, communes aux trois formats
  discover.py                 quels fichiers sont des contrats (nom, extension, première ligne)
  compare.py                  base de fusion, lecture `git show base:chemin`, rapport par contrat
  consumers.py                registre des consommateurs + code du dépôt qui cite l'endpoint
  guide.py                    guide de migration Markdown et section de PR
  ci.py                       workflow GitHub Actions épinglé (oasdiff, buf, graphql-inspector)
  __main__.py                 `python -m api_watcher check`
apps/backend/qa/api_contract_gate.py   la porte QA et sa demande de correction
apps/backend/runners/api_watcher_runner.py  le runner de la page (modes baseline et branche)
```

## Ce qui casse

Les trois formats deviennent le même `ApiContract` (endpoints, types, énumérations, champs) et
passent par les mêmes règles :

| Change | Catégorie |
|---|---|
| endpoint, champ, valeur d'énumération, statut de réponse supprimé | cassant |
| paramètre ou champ d'entrée devenu obligatoire, corps de requête rendu obligatoire | cassant |
| type incompatible (`integer` → `string`), numéro de champ protobuf changé | cassant |
| type élargi (`int32` → `int64`, `Int` → `Float`), valeur d'énumération ajoutée, endpoint déprécié, champ protobuf renommé | peut-être cassant |
| endpoint, champ facultatif, statut de réponse ajouté | sans risque |

Quelques règles par format :

- **OpenAPI** : un paramètre de chemin renommé (`/orders/{id}` → `/orders/{orderId}`) reste le
  même endpoint, les paramètres de chemin se comparent par position. Les `$ref` sont résolus,
  Swagger 2 (`in: body`) comme OpenAPI 3 (`requestBody`).
- **GraphQL** : les champs de `Query`, `Mutation` et `Subscription` sont des endpoints, comparés
  une seule fois ; leurs arguments sont des paramètres ; `@deprecated` est lu.
- **protobuf** : le numéro décide de l'identité d'un champ, pas le nom. Un champ supprimé dont le
  numéro est `reserved` n'est que peut-être cassant (aucun ancien client ne lira un nouveau sens).
  Messages imbriqués (`Order.Item`), `oneof` et `stream` sont compris.

## Une rupture voulue

Une rupture voulue reste signalée, marquée « reconnue ». La clé `x-breaking-acknowledged: true`
s'écrit dans le document (ou `info`), un chemin, une opération, un paramètre, un schéma ou une
propriété en OpenAPI. En GraphQL et protobuf, un commentaire `# x-breaking-acknowledged` ou
`// x-breaking-acknowledged` sur la ligne qui précède la déclaration ; en tête de fichier suivi
d'une ligne vide, il couvre tout le fichier. Seul le nouveau contrat compte : on reconnaît une
rupture dans le changement qui la fait.

## Les consommateurs

Deux sources, sans réseau :

1. le registre `.workpilot/api-consumers.yaml` (ou `.yml`, `.json`) du checkout principal, jamais
   celui du worktree de la tâche, que l'agent pourrait réécrire : nom, contact (`@équipe`),
   contrats concernés, chemins du code client ;
2. le code du dépôt qui cite l'endpoint (chemin statique, `operationId`, nom de RPC, champ
   racine GraphQL), dans toutes les piles (`.cs`, `.ts`, `.py`, `.go`, `.java`, `.kt`, `.swift`,
   `.dart`, `.php`, `.rb`, `.rs`, `.vue`, `.razor`…), au plus 5 000 fichiers de 512 Ko et 20
   références par changement.

## La porte QA

Après l'approbation du reviewer, à la suite des autres portes (`qa/loop.py`), réglée par
`WORKPILOT_QA_API_CONTRACT` :

- `warn` (défaut) : jamais bloquante ; les changements sont journalisés et listés dans la PR ;
- `strict` : une rupture non reconnue rejette la passe, le fixer reçoit un `QA_FIX_REQUEST.md` qui
  demande un changement rétrocompatible ; les chemins du contrat y sont cités comme données ;
- `off` : ne s'exécute pas, l'enregistrement le dit.

Une valeur inconnue vaut `warn` : une faute de frappe ne doit ni bloquer ni éteindre la veille.
Chaque passage écrit `<spec>/api_contract.json`, que la PR (`core/worktree_pr.py`, section
« 🔌 API contract changes » avec les consommateurs à prévenir) et la page lisent.

## La page et la CI

La page API Watcher garde le mode baseline et ajoute « Comparer avec une branche » : la cible est
revalidée dans le main (`api-watcher-args.ts`, pas de tiret initial, pas de `..`) et passée en
argument, jamais au shell. Le rapport montre chaque contrat, ses changements, leurs
consommateurs et un workflow GitHub Actions à copier, dont les images et actions sont épinglées
par digest ; un chemin de contrat au nom inattendu en est écarté.

En ligne de commande : `python -m api_watcher check --target develop --fail-on breaking` rend 1
quand la règle échoue, 2 quand la comparaison n'a pas pu se faire (référence invalide, pas de
base de fusion), 0 sinon ; `--json` et `--summary` pour la CI.

## Limites

RAML, WSDL et Thrift sont signalés « non vérifiés » avec un delta texte, sans règles. Le guide
de migration est un gabarit, pas un texte écrit par un modèle. Un contrat servi à une URL (pas
dans le dépôt) n'est pas lu. Au-delà de 60 contrats ou de 2 Mo par fichier, le reste est
« non vérifié ».

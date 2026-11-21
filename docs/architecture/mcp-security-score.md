---
feature: "Marketplace MCP : score, alertes et politique"
summary: >-
  Score 0-100 d'un serveur du catalogue sur six dimensions ; faits npm, PyPI et OSV lus par le
  main pour un id de catalogue seulement, cache d'un jour, jamais en hors-ligne strict ;
  revérification quotidienne des serveurs installés avec alertes à acquitter ; liste blanche
  (.workpilot/mcp-policy.json) appliquée par le main à l'écriture du .env.
---

# Score de sécurité du Marketplace MCP (issue #369, lots 1 et 2)

Chaque carte du Marketplace MCP montre un badge « Sécurité N/100 ». Le score vient d'abord du
catalogue seul, calculé dans le renderer, sans réseau ; ouvrir les détails de la carte demande au
main de lire le registre du paquet (npm ou PyPI) et la base de vulnérabilités OSV, puis remplace
le badge par le score complet.

## Les six dimensions (`shared/mcp-catalog/security-score.ts`)

| Dimension | Points | D'où | Ce qui coûte |
|---|---|---|---|
| Éditeur | 20 | catalogue (`official`) | serveur communautaire (8) |
| Permissions | 20 | noms des outils, arguments | outil qui lance des commandes (5, alerte), outils qui écrivent (12) ; un drapeau lecture seule (`--read-only`, `--access-mode=restricted`) remonte à 17 |
| Exécution | 15 | transport, arguments | tourne ici sans version épinglée (7, alerte) ; épinglée (11) ; distant (15) |
| Fraîcheur | 15 | registre | plus de 183 jours sans version (4, « peut-être abandonné »), paquet déprécié ou retiré (0) |
| Chaîne d'approvisionnement | 20 | OSV, pour la version lancée | une vulnérabilité connue (0, une alerte par avis) |
| Mainteneurs | 10 | registre, historique local | un mainteneur apparu depuis la première vérification sur cette machine (0, signe de prise de compte) ; pas de dépôt source (3) |

Le score est la part des points des dimensions qui s'appliquent, arrondie. Un serveur distant
(http, sse) n'a pas de paquet sur la machine : les trois dernières dimensions ne s'appliquent pas
et il est noté sur les trois autres. Sans faits du registre, chacune de ces trois dimensions
compte la moitié de ses points avec le statut « non vérifié » : on ne prétend ni sûr ni risqué
ce qu'on n'a pas lu. Niveaux : 75 et plus élevé, 50 à 74 moyen, moins de 50 faible (avertissement
dans les détails).

Le calcul est pur et identique pour tous les providers et tous les écosystèmes du catalogue : aucun
LLM, aucun réseau.

## La lecture du registre (`main/mcp-security/`)

- **Entrée** : le canal `mcpMarketplace:getSecurity` reçoit `{ serverId, projectId?, refresh? }`.
  `server-security.ts` revalide les types (S6) et cherche l'id dans le catalogue livré avec
  l'app : le renderer ne nomme jamais un paquet ni une URL.
- **Hôtes** : liste fermée, `registry.npmjs.org`, `pypi.org`, `api.osv.dev`. Le nom de paquet est
  revalidé (`NPM_NAME`, `PYPI_NAME`) avant de devenir une URL ; seuls les lanceurs `npx` et `uvx`
  mènent à un registre.
- **Bornes** : 8 s par requête, redirections refusées, corps de 15 Mo au plus, 20 avis gardés,
  textes tronqués à 200 caractères. Ce qui revient est une donnée affichée, jamais exécutée.
- **Cache** : `userData/mcp-marketplace/security-facts.json`, un jour (« Revérifier » force une
  lecture). Les mainteneurs vus la première fois sont gardés : c'est la référence de l'alerte
  « mainteneur changé ».
- **Hors-ligne strict (S7)** : si le projet sélectionné a `airgapStrict`
  (`.workpilot/offline-mode.json`), aucune requête ; le score se fait avec les derniers faits lus
  et le dit. Un registre injoignable donne le même repli (« registre injoignable »). OSV seul en
  échec laisse la chaîne d'approvisionnement « non vérifiée ».
- **Erreurs** : une requête invalide renvoie sa raison ; toute autre erreur un message fixe, le
  détail reste dans le log du main.

## Interface (`renderer/components/mcp-marketplace/McpSecurityScore.tsx`)

`useMcpServerSecurity(server, projectId)` donne le score local tout de suite et le remplace par
celui du main ; `McpSecurityBadge` sur la ligne du lanceur ; `McpSecurityDetails` dans les détails
de la carte (dimensions, raisons, alertes, date de vérification). Textes en `en` et `fr` sous
`common:mcpMarketplace.security`.

## Un serveur du catalogue, tel que le catalogue le définit (`shared/mcp-catalog/catalog-match.ts`)

Les alertes et la politique ne font confiance qu'à un serveur du catalogue. Un serveur installé
dans le `.workpilot/.env` n'en est un que s'il est exactement ce que la marketplace écrit
(`buildCatalogServer`) : même id, même lanceur, mêmes arguments dans l'ordre du catalogue (un
argument à variable facultative laissée vide peut manquer, un argument à variable obligatoire
non), même URL, aucun en-tête de plus, l'environnement fixe du catalogue gardé tel quel et seules
les variables à saisir ajoutées. Un id du catalogue avec une commande, un argument ou une
variable à lui (`NODE_OPTIONS`…) est un serveur hors catalogue. La comparaison découpe le gabarit
en morceaux littéraux cherchés de gauche à droite, sans expression régulière : une valeur longue
venue du renderer ne fait pas revenir en arrière le main.

## Alertes sur les serveurs installés (`main/mcp-security/installed-watch.ts`)

- **Quand** : une première fois deux minutes après le démarrage, puis toutes les heures ; chaque
  passage ne fait rien si le précédent a moins d'un jour (`lastRun`). Le minuteur ne retient pas
  l'app (`unref`).
- **Quoi** : pour chaque projet enregistré qui n'est pas en hors-ligne strict, le main lit
  lui-même son `.workpilot/.env` et garde les serveurs du catalogue à paquet (`npx`, `uvx`). Les
  faits viennent de `RegistryFactsStore.facts` : mêmes hôtes fermés, mêmes bornes, même cache
  d'un jour que le score. Le nom de paquet vient du catalogue livré, jamais du renderer ni d'un
  fichier du projet. Un serveur installé seulement dans des projets hors-ligne n'est pas lu.
- **Ce qui a empiré** depuis la dernière lecture gardée (`userData/mcp-marketplace/installed-watch.json`) :
  un avis OSV nouveau pour la version lancée, un mainteneur apparu, le paquet déprécié ou retiré,
  le score passé sous 50. La première lecture d'un serveur fixe la référence et ne lève rien ;
  OSV injoignable garde les avis connus. Chaque alerte a un id stable (`vuln:<id>`…) : elle n'est
  levée qu'une fois, et reste jusqu'à son acquittement. 50 alertes au plus par serveur.
- **Interface** : `mcpMarketplace:getInstalledWatch` reçoit `{ projectId }` (projet enregistré,
  sinon refus) et renvoie, pour chaque serveur du projet, son statut (`watched`, `pending`,
  `remote`, `offline`, `unverifiable`) et ses alertes ouvertes ; `mcpMarketplace:acknowledgeAlerts`
  reçoit `{ serverId }` (id revalidé) et acquitte toutes celles du serveur. Les alertes portent sur
  le paquet, donc sur l'id du catalogue : les acquitter vaut pour tous les projets. La liste des
  serveurs installés montre un badge par serveur concerné, le détail et le bouton « Acquitter » ;
  un serveur hors catalogue est marqué « Non vérifiable » (`McpInstalledAlerts.tsx`).

## Liste blanche d'entreprise (`.workpilot/mcp-policy.json`)

```json
{ "version": 1, "allowedServers": ["github", "sentry"], "minScore": 60, "blockCustomServers": true }
```

- **Schéma fermé** (`shared/mcp-catalog/install-policy.ts`) : tous les champs sont facultatifs,
  mais une clé inconnue, un type faux, un score hors 0-100 ou un id mal formé rend le fichier
  invalide. Un fichier invalide est la politique la plus stricte (rien ne s'installe), annoncée
  comme invalide avec sa raison : une faute de frappe n'élargit jamais la politique en silence.
- **Lecture** (`main/mcp-security/policy-file.ts`) : chemin résolu (liens compris) puis vérifié
  dans le dossier du projet ; un fichier ou un `.workpilot` qui pointe ailleurs, un dossier, un
  fichier de plus de 64 Ko ou illisible est invalide. Pas de fichier : pas de politique. Le
  fichier est ouvert une fois, contrôlé par `fstat` puis lu sur le même descripteur.
- **Application dans le main** (`main/mcp-security/install-guard.ts`, appelé par `env:update`) :
  chaque serveur personnalisé ajouté ou modifié par rapport au fichier est vérifié, qu'il vienne
  de la marketplace ou d'Agent Tools. Un serveur gardé tel quel passe, même sous une politique
  écrite après lui ; en retirer un passe toujours. Le score minimum se compare au score calculé
  par le main (faits du cache d'un jour, jamais lus en hors-ligne strict). Un refus n'écrit rien
  et renvoie `{ success: false, error, data: { mcpPolicyRefusal } }` : la raison
  (`policyInvalid`, `notAllowed`, `scoreTooLow`, `customBlocked`) est traduite en `en` et `fr`
  par le renderer, `error` en garde la phrase anglaise.
- **Renderer** : `mcpMarketplace:getPolicy` (`{ projectId }`) ne sert qu'à expliquer. Le bandeau
  dit ce que la politique permet, ou qu'elle est invalide ; une carte refusée garde son bouton
  « Installer » désactivé avec la raison. Le score minimum n'y compte qu'une fois le score lu par
  le main : le score local n'est qu'une estimation. `workpilot.policy.yaml` et la gouvernance
  n'en dépendent pas.

## Pas encore fait (suite de #369)

Exécution confinée proposée pour un score faible, avis communautaires, scan statique du code
source ; dans Agent Tools, un refus de la politique remet la liste d'avant sans encore en dire
la raison.

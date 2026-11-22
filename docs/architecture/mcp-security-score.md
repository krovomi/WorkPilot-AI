---
feature: "Marketplace MCP : score, alertes et politique"
summary: >-
  Score 0-100 d'un serveur du catalogue sur sept dimensions ; faits npm, PyPI et OSV lus par le
  main, jamais en hors-ligne strict ; analyse en mémoire de l'archive publiée, vérifiée par
  empreinte ; revérification quotidienne avec alertes à acquitter ; liste blanche
  (.workpilot/mcp-policy.json) appliquée par le main à l'écriture du .env.
---

# Score de sécurité du Marketplace MCP (issue #369, lots 1 à 3)

Chaque carte du Marketplace MCP montre un badge « Sécurité N/100 ». Le score vient d'abord du
catalogue seul, calculé dans le renderer, sans réseau ; ouvrir les détails de la carte demande au
main de lire le registre du paquet (npm ou PyPI) et la base de vulnérabilités OSV, puis remplace
le badge par le score complet.

## Les sept dimensions (`shared/mcp-catalog/security-score.ts`)

| Dimension | Points | D'où | Ce qui coûte |
|---|---|---|---|
| Éditeur | 20 | catalogue (`official`) | serveur communautaire (8) |
| Permissions | 20 | noms des outils, arguments | outil qui lance des commandes (5, alerte), outils qui écrivent (12) ; un drapeau lecture seule (`--read-only`, `--access-mode=restricted`) remonte à 17 |
| Exécution | 15 | transport, arguments | tourne ici sans version épinglée (7, alerte) ; épinglée (11) ; distant (15) |
| Fraîcheur | 15 | registre | plus de 183 jours sans version (4, « peut-être abandonné »), paquet déprécié ou retiré (0) |
| Chaîne d'approvisionnement | 20 | OSV, pour la version lancée | une vulnérabilité connue (0, une alerte par avis) |
| Mainteneurs | 10 | registre, historique local | un mainteneur apparu depuis la première vérification sur cette machine (0, signe de prise de compte) ; pas de dépôt source (3) |
| Code source | 20 | archive publiée, lue par le main (lot 3) | code illisible (0, alerte) ; lance des programmes sans outil qui le déclare (−12) ; code dynamique (−8) ; chaîne en forme d'identifiant (−8) ; écrit des fichiers alors que tous les outils lisent (−4) |

Le score est la part des points des dimensions qui s'appliquent, arrondie. Un serveur distant
(http, sse) n'a pas de paquet sur la machine : les quatre dernières dimensions ne s'appliquent pas
et il est noté sur les trois autres. Le code source ne compte que dans le score du main (le
renderer n'a pas lu le code) ; tenté sans réponse du réseau, il compte la moitié, « non lu ». Sans faits du registre, chacune de ces trois dimensions
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

## L'analyse statique du code (`main/mcp-security/source-scan.ts`, lot 3)

- **Ce qui est lu** : l'archive que le registre publie pour la version que donnent les faits
  (épinglée, sinon la dernière) : le tarball npm, le sdist PyPI (`.tar.gz`, sinon `.zip`), à
  défaut une wheel. C'est le code qui tournera, plus fidèle qu'un dépôt. Le nom vient du
  catalogue livré, la version du registre, revalidée (`NPM_VERSION`, `PYPI_VERSION`) avant
  d'entrer dans l'URL.
- **Hôtes** : l'URL de l'archive vient de la réponse du registre et doit être en https sur son
  hôte de fichiers, sans identifiants ni port (`registry.npmjs.org`, `files.pythonhosted.org`,
  seul hôte ajouté par ce lot) ; redirections refusées.
- **Intégrité** : les octets sont comparés à l'empreinte du registre (`sha512` d'`integrity`, à
  défaut `shasum` npm ; `sha256` PyPI) avant toute lecture ; un écart rend le code « non
  auditable ».
- **Lecture** (`archive-reader.ts`) : tar.gz (ustar, pax, noms longs GNU) ou zip (stocké,
  deflate ; pas de zip64), **en mémoire** : aucun nom d'entrée ne devient un chemin, rien n'est
  extrait ni exécuté. Bornes : 20 Mo téléchargés (lus par morceaux, quel que soit
  `content-length`), 64 Mo décompressés, 2 Mo et 3 000 fichiers source au plus (le reste est
  compté « non lu »). Seuls les `.js`, `.mjs`, `.cjs`, `.ts`, `.py`… hors `test/`, `examples/`,
  `docs/` et `.d.ts` sont lus.
- **Motifs** (`shared/mcp-catalog/code-scan.ts`) : liste fermée par langage, sur le texte, sans
  analyse syntaxique : `shellExec`, `dynamicCode` (eval, `new Function`, `exec`, import dont le
  nom n'est pas écrit), `hardcodedSecret` (formes de jetons connues ; seuls le fichier et la
  ligne sont gardés, jamais la valeur), `fileWrite`, `network` (montré, jamais compté). 60
  constats au plus, les règles les plus risquées d'abord. Les motifs penchent vers le trop :
  un faux positif s'accepte dans la politique.
- **Audit des permissions** : `code-score.ts` compare le code aux outils du catalogue ; lancer des
  programmes ne coûte que si aucun outil ne dit en lancer, écrire des fichiers que si tous lisent.
- **Résultat gardé** par version (`userData/mcp-marketplace/code-scans.json`, 100 au plus) : une
  version publiée ne change pas. Archive absente (404/410), introuvable, illisible, trop grande ou
  d'empreinte fausse : un résultat, « code non auditable », alerte. Panne réseau : rien de gardé.
- **Hors-ligne strict** et registre injoignable : seul le dernier résultat gardé compte, sans
  réseau (S7) ; c'est le « mode local » des entreprises isolées.

## Interface (`renderer/components/mcp-marketplace/McpSecurityScore.tsx`)

`useMcpServerSecurity(server, projectId)` donne le score local tout de suite et le remplace par
celui du main ; `McpSecurityBadge` sur la ligne du lanceur ; `McpSecurityDetails` dans les détails
de la carte (dimensions, raisons, alertes, date de vérification) ; `McpCodeScanDetails` y liste
les constats de l'analyse (règle, fichier et ligne, raison d'une acceptation). Textes en `en` et
`fr` sous `common:mcpMarketplace.security`.

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
  le score passé sous 50, et (lot 3) une règle risquée (`shellExec`, `dynamicCode`,
  `hardcodedSecret`) que la version précédente n'avait pas, ou un code devenu illisible. La
  veille analyse chaque nouvelle version, sans tenir compte des acceptations d'un projet (elle
  porte sur le paquet). La première lecture d'un serveur fixe la référence et ne lève rien ;
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
{ "version": 1, "allowedServers": ["github", "sentry"], "minScore": 60, "blockCustomServers": true,
  "acceptedFindings": [{ "server": "github", "rule": "dynamicCode", "reason": "charge ses greffons" }] }
```

- **Schéma fermé** (`shared/mcp-catalog/install-policy.ts`) : tous les champs sont facultatifs,
  mais une clé inconnue, un type faux, un score hors 0-100 ou un id mal formé rend le fichier
  invalide. Un fichier invalide est la politique la plus stricte (rien ne s'installe), annoncée
  comme invalide avec sa raison : une faute de frappe n'élargit jamais la politique en silence.
- **Constats acceptés** (lot 3) : `acceptedFindings`, 200 au plus, chacun un id, une règle de la
  liste fermée et une raison non vide de 300 caractères au plus. Un constat accepté ne coûte
  rien au score du projet et s'affiche avec sa raison ; une politique invalide n'en accepte aucun.
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
  n'en dépendent pas. Dans Agent Tools, un enregistrement refusé remet la liste d'avant et dit
  pourquoi (`McpPolicyRefusalNotice`), jusqu'au prochain enregistrement accepté.

## Avis de l'équipe (mode serveur, lot 5)

Le score dit ce qui se lit de l'extérieur (registre, OSV, code publié) ; un avis dit ce qu'une
équipe a vu en utilisant le serveur : « marche, mais appelle un hôte que la doc ne cite pas ». Dans
un projet du serveur, la carte d'un serveur du catalogue montre, sous son score, les avis des
membres du projet (`renderer/components/mcp-marketplace/McpServerReviews.tsx`) ; hors mode serveur
elle n'en montre aucun.

- **Ce qui est gardé** (`apps/backend/shared_features/mcp_reviews.py`, table `mcp_server_reviews`) :
  l'id du catalogue (vérifié sur le motif des ids, le catalogue étant livré avec l'app et non avec
  le serveur), un verdict d'une liste fermée (`safe`, `caution`, `unsafe`) et un commentaire de
  texte brut, caractères de contrôle retirés, espaces repliés, 1 000 caractères au plus. Il est
  affiché comme texte et n'est jamais donné à un modèle. Un membre a un avis par serveur : en
  écrire un second remplace le premier. 2 000 avis par projet au plus ; une liste en rend 500.
- **Qui y touche** : un avis ne quitte jamais son projet (`project_id` résolu par
  `resolve_project_scope`, un projet d'un autre tenant répond 404). Lire est `marketplace.read` ;
  écrire ou supprimer le sien est `marketplace.write`, accordé aux rôles contributeur et relecteur
  (et donc mainteneur et administrateur), pas aux rôles lecteur, analyste et opérateur. Supprimer
  l'avis d'un autre revient au propriétaire du projet ou à un administrateur de l'organisation.
- **Côté app** : le renderer ne donne qu'un id de projet, un id du catalogue, un verdict et un
  commentaire, ou un id d'avis ; `main/mcp-reviews.ts` les revérifie, ne parle qu'au serveur d'un
  projet qu'il a listé (`getServerProject`) et relit la réponse champ par champ. Un lecteur du
  projet lit les avis sans formulaire ; l'interface ne fait que masquer, le serveur refuse.

## Pas encore fait (suite de #369)

- **Exécution confinée d'un serveur à score faible** : chaque provider lance lui-même ses serveurs
  MCP (le SDK Claude démarre un serveur stdio sans passer par WorkPilot) et le bac à sable de
  l'OS (`os_sandbox/`) ne sait pas encore donner à un serveur ses propres hôtes réseau ; à faire
  dans le backend, provider par provider.
- **Avis au-delà du projet** : les avis de l'équipe restent dans leur projet. Les partager entre
  les projets d'une organisation, ou entre organisations (avis communautaires), est une décision à
  prendre (Leub) : rien ne quitte une organisation aujourd'hui, et un avis public demande un
  service hébergé que l'app n'a pas. Les avis ne changent pas non plus le score.
- **Signature cryptographique de l'éditeur** (provenance npm, sigstore) : vérifier une
  attestation demande une bibliothèque sigstore, nouvelle dépendance à justifier ; l'éditeur reste
  noté par `official`.
- **Communauté** (installations, étoiles, contributeurs) et **dépôt source supprimé** : nouveaux
  hôtes (`api.npmjs.org`, forges, dont l'API sans jeton est limitée) ; une archive disparue du
  registre est déjà signalée.
- **Semgrep, CodeQL** : l'analyse se fait par motifs livrés avec l'app, sans outil installé.
- **Métriques par organisation** (score moyen, alertes, désinstallations) : rien ne les remonte
  hors de la machine en dehors du mode serveur.

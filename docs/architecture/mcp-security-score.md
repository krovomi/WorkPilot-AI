---
feature: "Marketplace MCP : score de sécurité des serveurs"
summary: >-
  Score 0-100 d'un serveur du catalogue sur six dimensions (éditeur, permissions, exécution,
  fraîcheur, chaîne d'approvisionnement, mainteneurs) ; faits npm, PyPI et OSV lus par le main
  pour un id de catalogue seulement, mis en cache un jour, jamais en hors-ligne strict.
---

# Score de sécurité du Marketplace MCP (issue #369, lot 1)

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

## Pas encore fait (suite de #369)

Alertes proactives sur les serveurs installés, liste blanche d'entreprise, exécution confinée
proposée pour un score faible, avis communautaires, scan statique du code source.

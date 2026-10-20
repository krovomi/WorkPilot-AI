# JEV facultatif (TypeSafe)

JEV apporte une classification avant le planning et des indications de risque/couverture
avant les revues. Il ne remplace ni le LLM, ni les tests, ni la QA, ni la validation humaine.
Contrat : [API TypeSafe](https://docs.typesafe.ai/api).

## Application desktop

Dans **Paramètres → Intégrations → JEV (TypeSafe)** :

1. Enregistrer une clé API. Elle est chiffrée par le stockage sécurisé du système ;
   aucun secret ne figure dans les réglages, le stockage local du renderer ou les observations.
2. Activer le réglage global, ou sélectionner **Activer JEV** pour un workflow précis.
3. Choisir **Contourner JEV** pour désactiver un workflow indépendamment du réglage global.

Le réglage initial est désactivé. **Utiliser le réglage global** hérite de ce défaut.
Une activation spécifique prime sur un défaut global désactivé. Les workflows intégrés
sont `feature-build`, `github-review`, `gitlab-review` et `azure-devops-review`.
Un identifiant personnalisé doit correspondre au workflow réellement déclaré.

Remplacer ou supprimer la clé prend effet au prochain lancement du worker. Un worker déjà
démarré conserve son instantané privé. La présence d'une clé signifie « configuré », pas
« authentification vérifiée » ; consulter l'observation de la prochaine exécution.
Si le système ne propose pas de stockage sécurisé (notamment le backend Linux
`basic_text`), l'enregistrement est refusé et les workflows restent utilisables.

## CLI

Variables facultatives :

| Variable | Défaut |
|---|---|
| `WORKPILOT_JEV_ENABLED` | `0` |
| `WORKPILOT_JEV_WORKFLOW_MODES` | `{}` (JSON workflow → inherit/enabled/bypass) |
| `WORKPILOT_JEV_MODEL` | `jev-latest` |
| `WORKPILOT_JEV_MINIMUM_CONFIDENCE` | `0.8` |
| `WORKPILOT_JEV_TIMEOUT_SECONDS` | `5` |
| `TYPESAFE_API_KEY` | absent |

Injecter la clé dans l'environnement du worker depuis un gestionnaire de secrets.
Ne pas la committer ou l'ajouter aux arguments de commande. Le worker local la retire
de son environnement avant les agents/outils et la garde dans un runtime privé.
Lors de la création d'une spécification avec clé, la transition vers le build passe ce
même runtime en mémoire ; elle ne remet pas la clé dans l'environnement.

## Comportement et confidentialité

- Sans clé, en mode hors ligne strict, en contexte serveur non pris en charge, sur erreur
  réseau/API ou réponse insuffisamment fiable : le workflow habituel continue.
- Un échec d'authentification, une limite d'appels, un timeout ou une indisponibilité
  suspend les appels suivants du même runtime. Une nouvelle exécution peut réessayer.
- Aucun retry HTTP ou redirect ; endpoint fixe, délai total borné.
- Seuls les critères sélectionnés, noms de fichiers et diffs utiles sont transmis.
  Les fichiers sensibles et motifs usuels de secrets sont expurgés. Cette sélection
  n'est pas un export du dépôt, mais son contenu reste transmis à TypeSafe lorsque JEV
  est activé. Le filtre ne constitue pas une garantie universelle de détection de secrets.
- État limité à 64 Kio, réponse à 256 Kio. Un contexte trop grand ou sans diff
  exploitable provoque un bypass, sans échantillonnage implicite.
- Le choix explicite du fournisseur, du modèle et de l'effort reste prioritaire.
  Le hint de classification n'agit sur le routeur que lorsque son mode automatique le permet.
- La revue de suivi sans critères explicites ne demande que le risque, pas un score
  de couverture inventé.
- Roadmap et Ideation n'utilisent pas cette intégration.

## Observations

Les builds écrivent `jev-evaluations.json` dans le répertoire de spécification ; les
revues ajoutent une observation à leur résultat et à `.workpilot/jev/<workflow>/<run>/`.
Les observations sont bornées et ne contiennent ni clé ni contexte envoyé.
Le profil et les panneaux GitHub/GitLab montrent le statut et les valeurs précédentes
avec leur confiance. Ils les présentent comme historiques, jamais comme une approbation
de la révision actuelle. Azure DevOps conserve l'observation dans son résultat structuré.

La prévisualisation du profil est en lecture seule : elle n'appelle pas JEV, ne consomme
pas le marqueur de reprise et utilise le statut de clé actuel fourni par Electron.

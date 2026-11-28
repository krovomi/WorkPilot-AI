# Données d'usage du serveur : ce qui est enregistré et combien de temps

Cette page décrit, pour le registre des traitements de chaque équipe (RGPD, article 30), ce que
le serveur WorkPilot garde sur l'usage qu'en font ses membres. Elle suit le code : un ajout au
suivi d'usage la met à jour dans la même PR.

## Le traitement

| | |
|---|---|
| **Finalité** | piloter le serveur d'une équipe : consommation et coût des modèles, adoption, comptes inactifs, sécurité des connexions |
| **Responsable** | l'organisation qui héberge le serveur (WorkPilot n'en reçoit rien) |
| **Base légale** | intérêt légitime de l'employeur à piloter un outil qu'il fournit ; informer les membres avant la mise en service |
| **Personnes** | les comptes du serveur |
| **Destinataires** | les administrateurs de l'organisation, et ceux de la plateforme |
| **Sous-traitants** | aucun nouveau : les données restent dans la base du serveur, chez l'hébergeur que l'équipe a choisi |
| **Transferts hors UE** | aucun du fait de ce suivi |

## Ce qui est enregistré

| Donnée | Table | Contenu | Durée |
|---|---|---|---|
| Consommation par run et par job | `usage_records` | personne, projet, phase, type d'agent, provider, modèle, tokens en entrée et en sortie, coût estimé, date | celle de l'organisation, sinon `WORKPILOT_USAGE_RETENTION_DAYS` (365 jours par défaut) |
| Présence | `presence_days` | une ligne par personne, organisation et jour : le jour et l'heure de la dernière requête | même durée |
| Activité par page (**désactivée par défaut**) | `page_visits` | une ligne par personne, organisation, jour, app (`desktop` ou `mobile`) et page : combien de fois la page a été ouverte. La page est un nom d'une liste fermée (`kanban`, `roadmap`, `projects/cards/detail`…), jamais un projet, une carte ou un texte | celle de l'organisation, sinon `WORKPILOT_PAGE_ACTIVITY_RETENTION_DAYS` (183 jours par défaut) |
| Réglages du suivi | `audit_log`, action `org.usage_settings.updated` | qui a activé ou désactivé l'activité par page, changé une durée, avant et après | historique de l'audit |
| Connexions réussies | `audit_log`, action `auth.login.<méthode>` | personne, méthode (`local`, `entra`, `oidc`, `invite`), IP, navigateur, date | historique de l'audit |
| Connexions refusées | `audit_log`, action `auth.login_failed` | méthode, raison (`bad_password`, `disabled`, `unknown_account`, `provider_refused`), IP, navigateur, date ; la personne seulement si le compte existe | historique de l'audit |
| Jobs lancés | `audit_log`, action `project.job.started` | personne, projet, feature, identifiant du job | historique de l'audit |
| Exports de l'onglet Usage | `audit_log`, action `usage.exported` | qui a exporté quelle table, sur quelle période, combien de lignes | historique de l'audit |
| Message d'information lu | `audit_log`, action `usage.notice.seen` | qui l'a lu, quand, et si l'activité par page était mesurée | historique de l'audit |
| Compte effacé | `audit_log`, action `user.erased` | qui a effacé un compte, quand, combien de lignes ont été changées ; jamais quel compte | historique de l'audit |

### Ce que le tableau en montre

Une carte terminée affiche qui l'a créée, qui a lancé son dernier run (hors fusion) et ce que ses
sessions ont consommé (`shared_board/run_facts.py`). Rien de nouveau n'est enregistré pour cela :
le serveur calcule ces trois faits à chaque instantané du tableau, à partir de `specs_index`,
`agent_runs` et `usage_records`, et ne les écrit nulle part. Le nom est le nom d'affichage du
compte au moment de l'instantané ; un compte supprimé (`SET NULL`) laisse la carte sans nom. Les
voit quiconque lit le tableau du projet, qui montre déjà qui tient une carte, comme les vues
d'espace de travail montrent déjà le coût des sessions.

### Ce que les administrateurs en lisent

Les routes `/admin/usage/*` (permission `usage.read` : propriétaire et administrateur de
l'organisation, un autre rôle seulement si on la lui ajoute) calculent à chaque lecture, sur une
période de jours UTC et des filtres (personne, groupe, projet, provider, modèle), à partir des
tables ci-dessus, des runs, des jobs, des cartes et des invitations :

| Vue | Ce qu'elle montre |
|---|---|
| `summary` | tokens, coût estimé, part du budget mensuel, personnes actives sur 1, 7 et 30 jours, runs et jobs et leur taux de succès |
| `daily` | tokens et coût par jour et par provider |
| `people` | par personne (tous les membres, même sans activité) : runs, jobs, tokens, coût, providers et modèles, dernière activité ; l'activité d'un compte supprimé, sur une ligne sans nom |
| `people/{id}` | la fiche d'une personne : ses chiffres, sa chronologie (connexions, runs, jobs et **noms** des actions auditées, sans leur contenu) et ses pages |
| `models` | par provider et modèle, puis par phase : sessions, runs, réussis, échoués, coût moyen par run |
| `projects` | par projet et par phase |
| `pages` | les pages ouvertes, combien de fois et par combien de personnes |
| `delivery` | l'entonnoir d'adoption (invités, invitations acceptées, première connexion, première carte, premier merge), les tâches livrées, leur coût et le délai médian jusqu'au merge, les échecs **groupés par cause** |
| `presence` | qui est connecté maintenant (vu dans les 10 dernières minutes), ce qui tourne, les comptes dormants (aucune activité depuis 30 jours) |
| `export?view=…` | une de ces tables en CSV ; chaque export est audité |

La cause d'un échec se lit dans son message d'erreur contre une liste fermée (limite d'usage,
connexion au provider, délai dépassé, tests) : le message lui-même ne sort pas du serveur. Les
mêmes vues existent sous `/admin/platform/usage/*` pour les administrateurs de la plateforme,
toutes organisations confondues.

Dans l'app de bureau, **Administration → Usage → Chiffres** montre ces vues : une période (7 ou
30 derniers jours, ce mois-ci ou des jours choisis), les filtres, un bouton d'export CSV par
table, la fiche d'une personne en cliquant sur son nom, et la désactivation d'un compte dormant
pour qui gère les membres (`org.member.write`). Un administrateur de la plateforme y bascule sur
toute la plateforme et efface un compte depuis sa fiche. **Collecte et conservation**, à côté,
règle l'activité par page et les durées.

**Jamais enregistré** : le texte d'un prompt, du code, ce qu'une personne a tapé, un nom de
fichier, le chemin ou le corps d'une requête, un mot de passe, ni l'adresse tapée pour un compte
qui n'existe pas.

## L'activité par page

Elle est **désactivée** tant qu'un administrateur de l'organisation (permission `usage.write`) ne
l'active pas dans **Administration → Usage**, après avoir informé les membres de ce qui est mesuré
et pourquoi (et, en France, consulté le CSE quand il y en a un). Activée, l'app de bureau et
l'app mobile de chaque membre comptent les pages qu'il ouvre et envoient les comptes toutes les
5 minutes ; le serveur refuse tout nom hors des listes fermées
(`server/services/page_activity.py`). La désactiver efface aussitôt les comptes de
l'organisation. Chaque changement est inscrit au journal d'audit.

## Combien de temps

Chaque organisation règle sa durée dans **Administration → Usage** : une pour la consommation et
la présence, une pour l'activité par page, de 30 à 3650 jours. Laissée vide, elle suit le
serveur : `WORKPILOT_USAGE_RETENTION_DAYS` (365 jours par défaut) et
`WORKPILOT_PAGE_ACTIVITY_RETENTION_DAYS` (183 jours, soit 6 mois), ramenés entre 30 et 3650. Le
serveur efface chaque heure ce qui est plus vieux. La présence s'écrit au plus toutes les
5 minutes par personne : on sait qu'une personne a utilisé le serveur tel jour, et jusqu'à quelle
heure, pas ce qu'elle y a fait.

## L'information des membres

À sa première connexion dans une organisation, chaque membre voit un message qui dit ce qui est
mesuré (tokens, runs, jobs, connexions, présence, et l'activité par page si elle est activée),
combien de temps c'est gardé et quels rôles le lisent (`GET /users/me/usage-notice`). Le lire
inscrit `usage.notice.seen` au journal d'audit, avec ce qui était mesuré à ce moment : c'est la
preuve que la personne a été informée. Le message revient une fois quand l'organisation active
l'activité par page.

## Les droits des personnes

- **Accès** : chacun voit dans **Mon usage** (Paramètres de l'app de bureau, en mode serveur) exactement ce que les administrateurs voient de lui
  dans l'onglet Usage (`GET /users/me/usage`), et quels rôles de l'organisation le lisent.
- **Portabilité** : **Mon usage** exporte en un fichier JSON tout ce que le serveur garde de son
  usage, dans toutes ses organisations (`GET /users/me/usage/export`) : compte, consommation,
  présence, pages, entrées d'audit qui le concernent (avec IP et navigateur), runs et jobs.
- **Effacement** : un administrateur de la plateforme efface un compte
  (`POST /admin/users/{id}/erase`, en retapant son adresse). Partent avec lui ses sessions,
  appareils, secrets, préférences et appartenances ; ses lignes de consommation, de présence et
  de pages, ses runs, ses jobs et ses entrées d'audit restent **sans personne** (`SET NULL`), donc
  les totaux de l'organisation restent justes sans le nommer. Avant cela, le serveur efface l'IP
  et le navigateur de ses entrées d'audit, remplace son identifiant et son adresse par `erased`
  dans les entrées des autres qui le nommaient, et supprime les invitations à son adresse.
  L'audit garde qu'un compte a été effacé, par qui et quand, jamais lequel (`user.erased`). Les
  fichiers d'un projet (cartes, mémoires) sont le travail de l'équipe et restent tels quels.
- **Opposition** : l'activité par page reste désactivée, ou se désactive (ses comptes sont alors
  effacés) ; pour la consommation et la présence, qui servent aussi aux quotas et aux budgets,
  l'organisation abaisse la durée jusqu'à 30 jours.

Sur le téléphone, **Réglages → Mon usage** montre la même chose sur 30 jours, partage le fichier
JSON de tout ce qui est gardé et relit le message de ce qui est mesuré ; l'app mobile affiche ce
message une fois par organisation, comme l'app de bureau.

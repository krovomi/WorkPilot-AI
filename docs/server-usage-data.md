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
| Consommation par run et par job | `usage_records` | personne, projet, phase, type d'agent, provider, modèle, tokens en entrée et en sortie, coût estimé, date | `WORKPILOT_USAGE_RETENTION_DAYS` (365 jours par défaut) |
| Présence | `presence_days` | une ligne par personne, organisation et jour : le jour et l'heure de la dernière requête | même durée |
| Connexions réussies | `audit_logs`, action `auth.login.<méthode>` | personne, méthode (`local`, `entra`, `oidc`, `invite`), IP, navigateur, date | historique de l'audit |
| Connexions refusées | `audit_logs`, action `auth.login_failed` | méthode, raison (`bad_password`, `disabled`, `unknown_account`, `provider_refused`), IP, navigateur, date ; la personne seulement si le compte existe | historique de l'audit |
| Jobs lancés | `audit_logs`, action `project.job.started` | personne, projet, feature, identifiant du job | historique de l'audit |

### Ce que le tableau en montre

Une carte terminée affiche qui l'a créée, qui a lancé son dernier run (hors fusion) et ce que ses
sessions ont consommé (`shared_board/run_facts.py`). Rien de nouveau n'est enregistré pour cela :
le serveur calcule ces trois faits à chaque instantané du tableau, à partir de `specs_index`,
`agent_runs` et `usage_records`, et ne les écrit nulle part. Le nom est le nom d'affichage du
compte au moment de l'instantané ; un compte supprimé (`SET NULL`) laisse la carte sans nom. Les
voit quiconque lit le tableau du projet, qui montre déjà qui tient une carte, comme les vues
d'espace de travail montrent déjà le coût des sessions.

**Jamais enregistré** : le texte d'un prompt, du code, ce qu'une personne a tapé, un nom de
fichier, le chemin ou le corps d'une requête, un mot de passe, ni l'adresse tapée pour un compte
qui n'existe pas.

## Combien de temps

Le serveur efface chaque heure les lignes de `usage_records` et `presence_days` plus vieilles que
`WORKPILOT_USAGE_RETENTION_DAYS` (365 par défaut, ramené entre 30 et 3650 jours). La présence
s'écrit au plus toutes les 5 minutes par personne : on sait qu'une personne a utilisé le serveur
tel jour, et jusqu'à quelle heure, pas ce qu'elle y a fait.

## Les droits des personnes

- **Accès** : un administrateur de l'organisation lit l'historique d'audit d'une personne
  (**Administration → Audit**, filtre par personne).
- **Effacement** : un compte se désactive, il ne se supprime pas encore depuis l'app. Une ligne
  `users` supprimée laisse ses lignes de consommation et de présence sans personne (`SET NULL`) :
  les totaux de l'organisation restent justes sans la nommer. Une route d'effacement qui
  anonymise aussi l'audit arrive avec la vue Usage.
- **Opposition** : une organisation qui ne veut pas de ce suivi abaisse la durée au minimum ; la
  présence et la consommation servent aussi aux quotas et aux budgets.

---
feature: Approbation de spec et SSO (mode serveur)
summary: >-
  Connexion par tout fournisseur OpenID Connect, à côté d'Entra, sur le bureau et le téléphone ;
  une spec s'approuve avec `review.approve`, par autant de personnes que sa criticité en demande,
  l'auteur selon `WORKPILOT_SELF_APPROVAL` ; délégations, escalade d'un plan qui attend trop, et
  connexion nommée dans le journal et montrée sur le bureau, où Entra suit le flux générique.
---

# Approbation de spec et connexion SSO en mode serveur

Issue #363. Lot 1 : se connecter au serveur avec le fournisseur d'identité de l'entreprise, quel
qu'il soit, et rendre l'approbation d'une spec réelle côté serveur, y compris quand c'est l'auteur
de la carte qui voudrait l'approuver. Lot 3 : plusieurs approbateurs selon la criticité d'une
carte, et la délégation d'une approbation. Lot 4 : l'escalade d'un plan qui attend trop, les écrans
de l'app de bureau et de l'app mobile, la connexion SSO sur le téléphone, la connexion nommée dans
le journal, et les délégations d'une personne qui part. Lot 5 : le bouton Entra du bureau passe par
le flux du fournisseur générique, et le bureau montre comment la session ouverte l'a été.

## Un fournisseur OpenID Connect quelconque

Entra ID avait déjà son flux (`server/auth/oidc.py`) : l'app de bureau mène Authorization Code +
PKCE dans le navigateur du système, en client public, puis donne l'`id_token` au serveur, qui le
vérifie et répond par ses propres jetons. Le fournisseur générique reprend exactement ce flux ;
seule change la source des adresses.

| Pièce | Où | Rôle |
|---|---|---|
| Réglages | `server/config.py` | `WORKPILOT_OIDC_ISSUER`, `WORKPILOT_OIDC_CLIENT_ID` (les deux allument la connexion), `WORKPILOT_OIDC_NAME` (le nom du bouton), `WORKPILOT_OIDC_SCOPES` |
| Découverte et validation | `server/auth/oidc_generic.py` | lit `<issuer>/.well-known/openid-configuration`, vérifie l'`id_token`, trouve ou crée la personne |
| Routes | `server/routers/auth.py` | `/auth/config` décrit le fournisseur, `POST /auth/sso/exchange` échange l'`id_token` (publique, 10 par minute, auditée `auth.login.oidc`) |
| App de bureau | `src/main/oidc-pkce.ts`, `src/main/entra-sign-in.ts`, `src/main/ipc-handlers/server-sso-handlers.ts` | le flux du navigateur, dans le main, pour les deux fournisseurs ; les boutons « Se connecter avec {nom} » et Entra de `ServerLoginScreen` |

**Pourquoi la découverte et pas des adresses configurées.** Okta, Google, Keycloak et Auth0 publient
tous ce document ; un opérateur ne donne que l'émetteur et l'identifiant du client, comme pour
Entra. Le serveur ne fait confiance au document qu'après l'avoir vérifié :

- son `issuer` est exactement celui configuré (une barre finale près) ; le document est lu sans
  suivre de redirection, borné à 512 ko, gardé une heure ;
- chaque adresse est en https (http seulement sur la boucle locale, pour un Keycloak de
  développement), sans identifiants ni fragment ;
- l'`id_token` est signé par un algorithme asymétrique que le fournisseur annonce, jamais `none`
  ni un HMAC à secret partagé : un client public connaît l'identifiant du client, un HMAC signé avec
  lui serait forgeable. Il est émis par cet émetteur, pour ce client, non expiré ; avec plusieurs
  audiences, `azp` doit être ce client.

**Qui est la personne.** Une identité est retrouvée par son sujet, préfixé par l'émetteur
(`<issuer>|<sub>`) : deux fournisseurs ne partagent pas leurs sujets. Une adresse e-mail relie à un
compte existant, ou en nomme un nouveau, seulement si le fournisseur dit l'avoir vérifiée
(`email_verified`) : une adresse non vérifiée pourrait être celle de n'importe qui. Un compte
désactivé ne se connecte pas, par son identité comme par son adresse.

**Pourquoi le main refait les contrôles.** L'app lit le fournisseur dans `/auth/config`, une réponse
réseau : `providerFromConfig` revérifie chaque adresse (https, ou http sur la boucle locale),
l'identifiant du client et les scopes avant d'ouvrir quoi que ce soit, et l'URL du serveur reçue du
renderer est revalidée (`serverUrlFrom`). Le navigateur s'ouvre par `openExternalUrl`. Un `state`
et un `nonce` lient la réponse à cette tentative ; le main refuse un `id_token` qui ne porte pas ce
`nonce` avant de l'envoyer. Le serveur ne voit jamais de mot de passe et n'a aucun secret de client.

Un fournisseur injoignable ou un document refusé n'éteint que le bouton : `/auth/config` répond
`sso_enabled: false` et le journalise, les comptes locaux et Entra restent offerts.

## Entra, une configuration du flux générique sur le bureau (lot 5)

Le bureau ne mène plus qu'un flux de navigateur (`acquireIdToken` de `src/main/oidc-pkce.ts`) :
Authorization Code + PKCE `S256`, `state` et `nonce`, redirection sur la boucle locale qui ne
répond qu'à un `GET /callback` (404 à toute autre méthode ou chemin), navigateur ouvert par
`openExternalUrl`. Ce qui distingue les fournisseurs tient dans une table fermée de
`server-sso-handlers.ts`, choisie par le canal IPC et jamais par une donnée du renderer :

| Canal | Fournisseur lu dans `/auth/config` | `id_token` remis à |
|---|---|---|
| `SERVER_AUTH_LOGIN_SSO` | `providerFromConfig` : adresses de la découverte, revérifiées (https, http sur la boucle locale seulement, sans identifiants ni fragment), client et scopes bornés | `POST /auth/sso/exchange` |
| `SERVER_AUTH_LOGIN_ENTRA` | `entraProviderFromConfig` : tenant et client vérifiés dans leurs formes documentées (`checkEntraConfig`), puis les adresses fixes du tenant sur `login.microsoftonline.com` | `POST /auth/oidc/exchange` |

Les deux canaux revalident l'URL du serveur reçue du renderer (`serverUrlFrom`) et ne passent en
mode serveur qu'une fois le fournisseur accepté. Un fournisseur ajouté au serveur (Okta, Google
Workspace, Keycloak, Auth0…) marche donc du bureau sans code de plus ; Entra garde son échange côté
serveur (voir plus bas pourquoi). Le flux générique ne cite jamais le texte d'erreur du
fournisseur, seulement son code borné, et la requête de jeton n'envoie plus `scope`, facultatif
pour Entra comme pour OAuth 2.0.

## La connexion de la session ouverte (lot 5)

`GET /auth/me/session` (toute personne connectée, ses propres données) dit qui est connecté et
comment la session a été ouverte : la personne, l'identifiant de la connexion et sa méthode (lus
dans le jeton signé, `sid` et `amr`), le nom du fournisseur et l'hôte de son émetteur, et l'heure
de la connexion, lue sur la ligne `auth.login.*` du journal (`session_of` de
`server/auth/sign_in.py`). Cette ligne garde désormais le fournisseur tel qu'il était configuré à
la connexion (`payload` : nom et émetteur) : renommer le fournisseur ensuite ne renomme pas une
connexion passée. Une ligne d'avant, sans fournisseur, prend celui configuré aujourd'hui pour sa
méthode ; un jeton d'avant les identifiants de connexion ne nomme rien.

Sur le bureau, la page « Ma session sur le serveur » des réglages (mode serveur,
`components/settings/ServerSessionSettings.tsx`) l'affiche, avec un bouton de déconnexion. Le main
lit la route (`src/main/server-session-info.ts`) et ne garde pour le renderer que des champs bornés
de forme connue : méthode en liste fermée, hôte en caractères de nom d'hôte, date lisible ; aucun
jeton ne quitte le main.

Sur le téléphone, la section « Ma session » des Réglages (`apps/mobile/src/auth/SessionSection.tsx`)
montre la même chose sous le nom et l'adresse de la personne, au-dessus du bouton de déconnexion
qu'avaient déjà les Réglages. L'app lit la route avec son client et ne garde que les mêmes champs
bornés (`src/auth/my-session.ts`) ; l'identifiant de la connexion n'est jamais affiché.

## L'approbation d'une spec

`POST /api/board/cards/{id}/approve` et `request-changes` portent `review.approve`
(`ROUTE_OVERRIDES` de `server/authz/mounting.py`). Le reste tient à une question : **l'auteur d'une
carte peut-il approuver sa propre spec ?**

| `WORKPILOT_SELF_APPROVAL` | Réponse |
|---|---|
| `when-alone` (défaut) | oui seulement si personne d'autre sur le projet ne peut approuver |
| `deny` | jamais : un autre doit approuver |
| `allow` | toujours (le comportement d'avant) |

« Quelqu'un d'autre qui peut approuver » (`server/authz/self_approval.py`) : un membre actif de
l'organisation, sur le projet avec un rôle qui écrit (`member` ou `owner`), directement ou par un
groupe, et dont les permissions résolues contiennent `review.approve`. Un lecteur du projet ou une
personne de l'organisation qui n'est pas sur le projet ne compte pas : il ne pourrait pas approuver
cette carte. Le défaut ne bloque donc jamais une équipe d'une personne.

L'auteur est la colonne `created_by` de l'index des specs, écrite par le serveur à la création ;
il n'est jamais lu dans les métadonnées de la carte, qu'un run peut réécrire.

La même règle vaut partout où l'approbation se décide :

- **approuver** : l'auteur refusé reçoit 403, « Someone else approves the spec of a card you
  created » ;
- **demander des changements** : la demande est enregistrée, mais l'approbation du build suivant
  n'est donnée que si la personne pourrait approuver (`{"approved": false}` sinon) ;
- **créer une carte sans revue** et **lancer la phase `spec`** : partir sans revue revient à
  approuver d'avance, donc demande `review.approve` et la même règle ; sinon la carte attend une
  revue et la phase s'arrête à la spec (`may_skip_review` de `run_manager.build_command`).

## Plusieurs approbateurs selon la criticité (lot 3)

Une carte est `low`, `medium` ou `high`. Le déploiement dit combien d'approbations il faut à chaque
niveau et quels rôles doit tenir l'un des approbateurs :

| Variable | Exemple | Défaut |
|---|---|---|
| `WORKPILOT_APPROVAL_QUORUM` | `low=1,medium=2,high=3` | une approbation à chaque niveau, le comportement d'avant |
| `WORKPILOT_APPROVAL_ROLES` | `high=tech-lead+security` | aucun rôle demandé |

Un rôle se nomme par son slug (rôle système ou rôle personnalisé de l'organisation) ; une personne
le tient par son rôle d'organisation, celui d'un de ses groupes ou son rôle de projet
(`role_slugs` de `server/authz/approvals.py`).

**La criticité** (`server/authz/approval_policy.py`) est celle qu'un approbateur a donnée
(`PUT /api/board/cards/{id}/criticality`, `review.approve`, table `spec_criticality`). Sans elle,
l'évaluation de la spec (`complexity_assessment.json`) peut la porter à `high`, jamais la baisser :
ce fichier est écrit par l'agent de spec, d'après un texte qui peut venir de l'extérieur, et il ne
décide pas qu'il faut moins d'approbations. Sans l'un ni l'autre, une carte est `medium`. L'auteur
d'une carte ne baisse sa criticité que s'il pourrait l'approuver lui-même (403 « Someone else
lowers the criticality of a card you created ») ; la monter reste permis. Monter la criticité
annule une approbation du build qui ne suffit plus, la baisser peut en compléter une.

**Le registre des approbations** (`spec_approvals`). Chaque approbation est écrite dans la base du
serveur, que ni un run ni un client n'écrivent, avec le SHA-256 de `spec.md` et du plan tels
qu'ils étaient : modifier l'un ou l'autre annule les approbations données avant. Elle occupe une
place (`slot_id`) : celle de l'approbateur, ou celle de l'approbateur qu'un délégué remplace. Une
personne n'occupe qu'une place par version d'une carte, une place ne se remplit qu'une fois ; une
seconde approbation de la même personne ne compte pas. L'approbation que lit le build
(`review_state.json`) n'est écrite qu'une fois les approbations suffisantes : assez de places
remplies, et chaque rôle demandé tenu par l'une d'elles. La ligne reste quand son auteur quitte
l'organisation : c'est la trace de qui a approuvé quoi.

`POST .../approve` répond `approved` (le build peut-il partir) et `approval` : criticité et son
origine, `needed`, `count`, les approbations (qui, pour qui, quand, avec quels rôles), les rôles
qui manquent. `GET .../approvals` (`task.read`) donne la même chose. L'app de bureau ne lance le
build d'une carte du serveur qu'une fois `approved` vrai ; sinon elle dit, dans sa langue, combien
d'approbations la carte a (`src/main/server-approval.ts`).

**La règle d'auto-approbation avec un quorum.** Sous `when-alone`, l'auteur ajoute la sienne tant
que les autres qui peuvent approuver sont moins nombreux que le quorum : une équipe de deux atteint
encore un quorum de deux, une équipe de trois n'a pas besoin de l'auteur. Avec un quorum de un,
c'est la règle du lot 1. **Partir sans revue** (créer une carte sans revue, lancer la phase `spec`)
demande une approbation qui suffit seule : quorum de un, et les rôles demandés tenus par la
personne.

**Demander des changements** est l'une des approbations : elle est enregistrée pour le plan
rouvert, et le build suivant n'est approuvé que si elle complète le quorum.

## Prêter son approbation (lot 3)

Un approbateur d'un projet prête son approbation à un collègue pour une période
(`server/authz/delegation.py`, table `approval_delegations`) :

| Route | Permission | Rôle |
|---|---|---|
| `GET /api/board/delegations` | `task.read` | les délégations du projet, en cours ou à venir |
| `POST /api/board/delegations` | `review.approve` | prêter : `to_user_id`, `ends_at`, `starts_at` facultatif |
| `DELETE /api/board/delegations/{id}` | `review.approve` | finir : son approbateur, ou qui administre les membres (`project.member.write`) |

Le collègue est un membre actif de l'organisation qui écrit sur le projet (directement ou par un
groupe) ; une délégation dure 90 jours au plus, commence dans l'année, et un approbateur en a cinq
ouvertes au plus par projet.

**Ce qui est prêté est exactement ce que l'approbateur tient.** À chaque requête, le middleware lit
les délégations en cours d'une personne qui n'approuve pas d'elle-même, et ne garde que celles dont
l'approbateur est actif et peut encore approuver sur ce projet (`Principal.delegations`). Elles ne
servent que sur les deux réponses à une revue, `approve` et `request-changes`, pour le
`project_id` de la délégation (`DELEGATED_ROUTES` de `server/authz/mounting.py`), et partir sans
revue. Le délégué y remplit la place de l'approbateur, avec ses rôles ; il ne prête pas à son tour
et ne règle pas une criticité, routes dont le droit reste celui de l'approbateur. Remplacer l'auteur
d'une carte, ou l'être en remplaçant quelqu'un, c'est l'auteur qui approuve sa propre carte.

**L'audit.** Chaque approbation (`review.approved`, avec la criticité, la personne remplacée, le
compte et le quorum), chaque criticité (`review.criticality.set`) et chaque délégation
(`review.delegation.created`, `review.delegation.revoked`) entrent au journal de l'organisation,
lu et filtré par action par `GET /admin/audit` (`audit.read`).

## Escalader un plan qui attend trop (lot 4)

Un plan qui attend ses approbations plus longtemps que l'équipe ne le permet prévient un second
groupe d'approbateurs (`server/services/approval_escalation.py`) :

| Variable | Exemple | Défaut |
|---|---|---|
| `WORKPILOT_APPROVAL_ESCALATION_HOURS` | `24`, ou `low=72,medium=24,high=4` | jamais (un niveau absent ne s'escalade pas ; 720 heures au plus) |
| `WORKPILOT_APPROVAL_ESCALATION_ROLES` | `tech-lead+security` | `owner+admin` |

**Le second groupe** : les membres actifs de l'organisation qui tiennent l'un de ces rôles
(`role_slugs`) et pourraient approuver sur le projet (`holds_approval`), hors l'auteur de la carte et
ceux qui ont déjà approuvé cette version ; vingt au plus. Ils en sont prévenus sur leurs canaux
« Besoin de toi » (ntfy, Telegram, Teams) par l'événement `approval_escalated`, qu'une personne coupe
comme les autres dans ses préférences.

**D'où part l'attente.** De la fin du run de spec qui a laissé le plan à approuver : une heure que
le serveur a écrite (`agent_runs.finished_at`), qu'aucun client ni aucun run ne déplace. Une carte
s'escalade une fois par run de spec (table `approval_escalations`, migration `0018`) ; un nouveau run
de spec ouvre une nouvelle attente. Une carte qui a déjà ses approbations, ou dont le build n'attend
plus d'approbation (`push.awaits_approval`, installé par le tableau : le serveur n'importe aucune
unité de feature), ne s'escalade pas. Chaque escalade entre au journal (`review.escalated`, avec la
criticité, l'attente, le compte, le quorum et le nombre de personnes prévenues).

**Pourquoi une tâche périodique, et comment elle reste bornée.** Le serveur n'en avait aucune. Celle-ci
tourne dans la boucle d'événements du serveur tant que le mode serveur est monté et que l'escalade
est allumée (enveloppe du `lifespan` de l'app, `server/integration.py`), toutes les cinq minutes.
Chaque passe regarde au plus cent cartes, des soixante derniers jours ; une passe qui échoue est
journalisée par son type et reprise au tour suivant : une notification n'arrête jamais le serveur.

## Les écrans (lot 4)

| App | Où | Ce qu'on y fait |
|---|---|---|
| Bureau | `components/spec-approval/ServerApprovalPanel.tsx`, `ServerDelegationsPanel.tsx`, dans Spec Approval pour un projet du serveur | régler la criticité, voir les approbations et les rôles qui manquent ; lister, prêter (dates de début et de fin) et terminer les délégations |
| Mobile | `src/card/ApprovalSection.tsx` sur la carte, la page « Approbations prêtées » du tableau | les mêmes, la délégation pour un nombre de jours |

Les appels du bureau passent par le main (`src/main/server-card-approvals.ts`), qui revérifie chaque
argument du renderer (identifiants, dates ISO avec fuseau) avant la requête et ne garde des réponses
que des champs bornés. Le serveur décide de tout : qui peut régler une criticité, prêter ou terminer.

Le téléphone ne lance plus le build après une approbation partielle : quand `POST .../approve`
répond `approved: false`, ni le bouton Démarrer ni « Valider et construire » d'une notification ne
démarrent rien, et l'app dit combien d'approbations la carte a.

## La connexion SSO sur le téléphone (lot 4)

L'app mobile mène le flux du fournisseur générique comme celui d'Entra : PKCE dans le navigateur du
système, retour sur `workpilot://auth`, `id_token` remis à `POST /auth/sso/exchange`. Elle revérifie
le fournisseur décrit par `/auth/config` comme le main du bureau, et un `nonce` lie l'`id_token` à
la tentative, pour les deux fournisseurs (`src/auth/code-flow.ts`). Détails :
[mobile-app.md](mobile-app.md).

**Entra garde sa propre vérification côté serveur.** Une identité Entra est retrouvée par son `oid`,
stable dans le tenant ; le `sub` d'Entra est propre à chaque application : passer Entra par le
fournisseur générique (`<issuer>|<sub>`) délierait chaque compte déjà relié. Entra n'émet pas
`email_verified` : une adresse ne compte que si le tenant l'a vérifiée (son nom d'utilisateur
principal, ou `xms_edov`), règle de `verified_email` dans `server/auth/oidc.py`.

## La connexion nommée dans le journal (lot 4)

Chaque connexion (mot de passe, Entra, fournisseur OpenID Connect, invitation acceptée) reçoit un
identifiant (`server/auth/sign_in.py`). Le jeton d'accès le porte (`sid`) avec la méthode (`amr`) ;
la session de rafraîchissement les garde, si bien qu'un rafraîchissement ou un changement
d'organisation reste la même connexion. Le middleware les lit dans le jeton signé, et chaque entrée
du journal écrite avec la requête les nomme (colonnes `login_id` et `login_method`, migration `0019`).

La ligne de la connexion elle-même est écrite dans l'organisation où ses jetons agissent :
`GET /admin/audit` dit qui s'est connecté, comment et d'où ; `?login_id=` liste ce qui a été fait
sous une connexion, et `GET /admin/sessions` nomme la connexion de chaque session ouverte. L'onglet
Journal de l'Administration du bureau montre la méthode et le début de l'identifiant de chaque
entrée, et son filtre retrouve une connexion par le début de son identifiant. Les
entrées et sessions d'avant n'ont pas d'identifiant ; une session d'avant en reçoit un à son
prochain rafraîchissement. Un jeton personnel (`/mcp`) ne vient d'aucune connexion et n'en nomme pas.

## Une personne qui part (lot 4)

Désactiver un compte termine toutes les délégations ouvertes que la personne a prêtées ou reçues ;
la retirer de l'organisation, celles de l'organisation ; la retirer d'un projet, celles du projet
(`end_delegations_of` de `server/authz/delegation.py`), dans la même transaction, avec leur nombre
dans l'entrée du journal (`delegations_ended`). Rien d'autre ne l'attend : le quorum d'une carte
compte des places que n'importe quel approbateur remplit, jamais des personnes nommées, et les
approbations qu'elle a données restent la trace de qui a approuvé quoi.

## Pas encore fait

Reste de l'issue #363 :

- SAML 2.0 : il faut vérifier des signatures XML (XML-DSig, canonicalisation), donc une nouvelle
  dépendance native (`xmlsec`) à justifier et à construire sur les trois OS ; un lot à lui ;
- le SCIM 2.0 (comptes et groupes poussés par le fournisseur vers les rôles) : un protocole de
  provisionnement entier (ressources `Users` et `Groups`, filtres, `PATCH`), avec son propre jeton
  par fournisseur, une surface publique nouvelle à concevoir et sécuriser à part.

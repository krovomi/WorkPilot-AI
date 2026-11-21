---
feature: Approbation de spec et SSO (mode serveur)
summary: >-
  Connexion par n'importe quel fournisseur OpenID Connect lu dans son document de découverte, à
  côté d'Entra ; une spec s'approuve avec `review.approve`, par autant de personnes que sa
  criticité en demande, l'auteur d'une carte seulement si la règle du déploiement
  (`WORKPILOT_SELF_APPROVAL`) le permet, et un approbateur prête son approbation pour un temps.
---

# Approbation de spec et connexion SSO en mode serveur

Issue #363. Lot 1 : se connecter au serveur avec le fournisseur d'identité de l'entreprise, quel
qu'il soit, et rendre l'approbation d'une spec réelle côté serveur, y compris quand c'est l'auteur
de la carte qui voudrait l'approuver. Lot 3 : plusieurs approbateurs selon la criticité d'une
carte, et la délégation d'une approbation.

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
| App de bureau | `src/main/oidc-pkce.ts`, `src/main/ipc-handlers/server-sso-handlers.ts` | le flux du navigateur, dans le main ; le bouton « Se connecter avec {nom} » de `ServerLoginScreen` |

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

## Pas encore fait

Reste de l'issue #363 :

- SAML 2.0 : il faut vérifier des signatures XML (XML-DSig, canonicalisation), donc une nouvelle
  dépendance native (`xmlsec`) à justifier et à construire sur les trois OS ; un lot à lui ;
- l'escalade quand une spec attend trop : le serveur n'a pas de tâche périodique, et prévenir un
  second groupe d'approbateurs demande un événement de plus aux canaux « Besoin de toi » ;
- dans l'app de bureau et l'app mobile, l'écran qui règle la criticité et gère les délégations
  (l'API est là) ; l'app mobile lance encore le build après une approbation partielle (le build
  s'arrête alors sur « revue requise ») : ses dépendances ne sont pas installées ici, ses tests ne
  tournent pas ;
- la connexion SSO générique dans l'app mobile (elle ne connaît qu'Entra et les comptes locaux) ;
- faire passer Entra par le flux générique (découverte, `nonce`, `email_verified`) ;
- l'audit par session SSO : le jeton d'accès ne porte ni la session ni le fournisseur de connexion,
  il faut les ajouter à chaque chemin de connexion ;
- redistribuer les approbations en attente d'un approbateur qui quitte l'organisation, et le SCIM
  (groupes du fournisseur vers les rôles).

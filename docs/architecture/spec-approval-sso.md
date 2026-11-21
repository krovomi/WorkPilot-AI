---
feature: Approbation de spec et SSO (mode serveur)
summary: >-
  Connexion par n'importe quel fournisseur OpenID Connect lu dans son document de découverte, à
  côté d'Entra ; une spec s'approuve avec `review.approve` sur la route, et l'auteur d'une carte
  ne l'approuve lui-même que si la règle du déploiement (`WORKPILOT_SELF_APPROVAL`) le permet.
---

# Approbation de spec et connexion SSO en mode serveur

Lot 1 de l'issue #363. Deux choses : se connecter au serveur avec le fournisseur d'identité de
l'entreprise, quel qu'il soit, et rendre l'approbation d'une spec réelle côté serveur, y compris
quand c'est l'auteur de la carte qui voudrait l'approuver.

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

## Pas encore fait

Lot 2 de l'issue #363 :

- SAML 2.0 ;
- N approbateurs sur M selon la criticité d'une carte ;
- délégation d'une approbation (absence, astreinte) et escalade quand une spec attend trop ;
- la connexion SSO générique dans l'app mobile (elle ne connaît qu'Entra et les comptes locaux) ;
- faire passer Entra par le flux générique (découverte, `nonce`, `email_verified`) ;
- un export d'audit par session SSO.

---
feature: Plusieurs comptes par provider IA
summary: >-
  Plusieurs comptes par provider à clé API (OpenAI, Google, Mistral, DeepSeek, Grok, Meta,
  OpenRouter, Hugging Face), clés chiffrées dans le main, un compte par défaut par provider que le
  gestionnaire d'identifiants donne aux tâches, aux tests et aux vues ; les comptes Claude sont ses
  profils OAuth ; bascule en un clic depuis la popin d'utilisation.
---

# Plusieurs comptes par provider IA

Une personne a souvent plusieurs comptes chez un même provider : sa clé personnelle, celle de son
employeur, celle d'un client, un deuxième abonnement Claude. Jusqu'ici, un provider à clé API
n'avait qu'une clé (le champ `global<X>ApiKey` de sa page) et seul Claude savait garder plusieurs
comptes (ses profils OAuth).

## Où vit quoi

| Donnée | Où | Qui la lit |
|---|---|---|
| Les comptes (provider, nom, clé, dates) et le compte par défaut de chaque provider | `<userData>/config/ai-accounts.json`, écrit en entier (fichier temporaire puis renommage), `0600`, clé `enc:` via `secret-storage.ts` | le main seulement (`main/ai-accounts/ai-accounts.ts`) |
| La « clé principale » d'un provider | le champ de sa page dans `settings.json` (`globalMistralApiKey`…), inchangé | `settings-utils.ts` |
| Les comptes Claude | les profils OAuth de `ClaudeProfileManager` (un dossier de connexion chacun) | inchangé |
| Ce que voit le renderer | `AiAccountView` : id, provider, nom, `hasKey`, dates ; les ids par défaut ; les providers qui ont une clé principale | Réglages → Comptes IA, popin d'utilisation |

Un défaut ne nomme qu'un compte de son propre provider : un fichier modifié à la main qui en
nommerait un autre est ignoré à la lecture. Supprimer le compte par défaut rend le provider à sa
clé principale.

## Le compte que reçoit une tâche

`credential-manager.ts` construit l'environnement de chaque tâche, test et vue
(`getEnvironmentVariables`, `testProvider`). Pour un provider à clé API, l'ordre est :

1. le compte par défaut (`defaultAccountKey`, `main/ai-accounts/ai-account-key.ts`), sur
   l'adresse officielle du provider ;
2. un profil API de `profiles.json` qui correspond au provider (point d'accès personnalisé) ;
3. la clé principale de la page du provider (`settingsApiKey`).

La clé d'un compte ne va jamais à une adresse que le renderer ou un profil nomme (règle S6) : un
compte n'a pas d'URL, le test et l'environnement utilisent celle du provider. Le défaut est relu à
chaque appel : une bascule depuis la popin vaut pour la tâche suivante, sans redémarrage. Une tâche
déjà lancée garde le compte de son lancement.

Les alias (`gemini` → `google`) passent par `accountProviderOf` (`shared/types/ai-accounts.ts`).

## Un compte épinglé par projet ou par carte

Un projet (`ProjectSettings.aiAccounts`) et une carte Kanban (`TaskMetadata.aiAccounts`, dans
`task_metadata.json`) peuvent épingler un compte par provider : `{ provider: id }`, où le provider
est celui des comptes (`google` pour `gemini`) ou `claude`, dont l'id est un profil OAuth. La carte
prime, puis le projet, puis le compte par défaut (`shared/utils/ai-account-pins.ts`,
`mergeAccountPins`). L'épingle n'est qu'un id : elle est nettoyée à la lecture (providers connus,
id court et imprimable) et le main cherche le compte dans son propre magasin.

- Clé API : `taskAccountPins` (`main/agent/task-provider-env.ts`) remplit
  `TaskProviderPlan.accounts` ; `buildTaskProviderEnv` pose la clé du compte épinglé par-dessus ce
  que le gestionnaire d'identifiants a choisi (`applyPinnedAccount`,
  `main/ai-accounts/pinned-account-env.ts`), sur l'adresse officielle du provider (l'URL d'un profil
  est retirée), seulement si le compte est bien de ce provider. OpenAI passe alors en clé API.
- Claude : `pinnedClaudeProfileEnv` (`main/agent/pinned-claude-profile.ts`) remplace
  `getBestAvailableProfileEnv` pour la tâche ; le jeton rafraîchi avant le lancement et le profil
  marqué « en cours » sont ceux du profil épinglé. Le profil actif de l'app ne change pas.
- Un compte supprimé ou illisible rend la tâche au compte par défaut, avec un avertissement dans
  le journal.
- Bascule automatique : une limite ou un refus de connexion dans la sortie d'une tâche épinglée est
  compté à son profil ; quand l'auto-swap passe à un autre profil, le redémarrage suivant de la
  tâche prend celui-ci une fois (`main/agent/claude-swap-pins.ts`), sans réécrire le fichier.
- L'interface : `AiAccountPinsEditor` (`renderer/components/ai-account-pins/`), dans le groupe Agent
  des paramètres du projet et sous le moteur de la carte (création et modification). Une ligne par
  provider qui a un choix : un compte à clé, ou plus d'un profil Claude.


## L'interface

- **Carte du provider** : « Compte : X » quand un compte est nommé, bouton « Comptes · n ».
  Un provider sans clé principale mais avec un compte par défaut compte comme connecté.
- **Dialogue des comptes** (`settings/ai-accounts/`) : `ApiKeyAccounts` (ajout avec test
  immédiat, le seul compte d'un provider sans clé devient le défaut ; modification sans retaper la
  clé ; suppression confirmée) ou `ClaudeAccounts` (ajout puis connexion dans le terminal intégré,
  défaut = profil actif, renommage, suppression sauf le profil par défaut).
- **Popin d'utilisation** (`usage/ProviderAccountSwitcher.tsx`) : pour le provider affiché, les
  comptes qui ont une clé, l'actif marqué, un clic pour en faire le défaut. Claude garde sa liste
  de profils avec leur usage. Les pourcentages de Claude sont ceux du profil actif
  (`claude-profile/usage-profile.ts`), jamais du moins utilisé : un compte tout juste ajouté, sans
  usage, trierait devant. Une connexion expirée y donne « reconnecter », pas « non mesuré ».

## IPC

`aiAccounts:list`, `aiAccounts:save`, `aiAccounts:delete`, `aiAccounts:test`,
`aiAccounts:setDefault` (`main/ipc-handlers/ai-accounts-handlers.ts`). Le handler revalide l'id
(chaîne bornée), le provider (liste fermée `AI_ACCOUNT_PROVIDERS`) et le compte ; une clé arrive
une fois, masque compris (`unmaskSecret`), n'est jamais renvoyée ; le test répond `ok`, un nombre
de modèles ou une raison courte (200 caractères), jamais le corps de la réponse.

## Le plan de chaque compte

`accountsWithPlan(provider)` (`main/ai-accounts/account-plans.ts`) liste les comptes d'un
provider avec leur plan, jamais une clé ni un jeton : `team`, `enterprise`, `max`, `pro` pour un
profil Claude (le `subscriptionType` que `claude-account-plan.ts` demande à Anthropic puis garde
dans le profil), `api` pour un compte à clé, `unknown` sinon ; plus `isDefault` et `signedIn`.
`hasClaudeOrganizationPlan()` dit si un compte Claude connecté est sur une organisation Team ou
Enterprise : une feature réservée à ces plans s'allume d'elle-même dessus. Le renderer lit le même
`subscriptionType` dans `getClaudeProfiles`.

## Pas encore

Les providers qui se connectent par leur propre outil gardent un compte : Copilot (`gh`), Codex
(ChatGPT), Gemini CLI, Windsurf, Cursor, AWS (paire de clés et région), Ollama (local). Il leur faut
un dossier de connexion par compte, comme Claude (`CLAUDE_CONFIG_DIR`).

## Fichiers

- `apps/frontend/src/shared/types/ai-accounts.ts` : types et providers.
- `apps/frontend/src/main/ai-accounts/ai-accounts.ts` : le stockage.
- `apps/frontend/src/main/ai-accounts/ai-account-key.ts` : la clé que reçoit un provider.
- `apps/frontend/src/main/ipc-handlers/ai-accounts-handlers.ts` : l'IPC.
- `apps/frontend/src/renderer/stores/ai-accounts-store.ts` : le store du renderer.
- `apps/frontend/src/renderer/components/settings/ai-accounts/` : le dialogue des comptes.
- `apps/frontend/src/renderer/components/usage/ProviderAccountSwitcher.tsx` : la bascule de la popin.
- `apps/frontend/src/shared/utils/ai-account-pins.ts` : l'épingle d'un projet ou d'une carte.
- `apps/frontend/src/main/ai-accounts/pinned-account-env.ts`, `apps/frontend/src/main/agent/pinned-claude-profile.ts` : le compte épinglé dans l'environnement d'une tâche.

Voir aussi [forge-accounts.md](forge-accounts.md) (même modèle pour les forges) et
[provider-failover.md](provider-failover.md) (basculement auto entre comptes).

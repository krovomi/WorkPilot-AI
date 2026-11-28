---
feature: Plusieurs comptes par provider IA
summary: >-
  Plusieurs comptes par provider à clé API (OpenAI, Google, Mistral, DeepSeek, Grok, Meta,
  OpenRouter, Hugging Face), clés chiffrées dans le main, un compte par défaut par provider donné
  aux tâches ; les comptes Claude sont ses profils OAuth ; bascule depuis la popin d'utilisation ;
  dépense du mois et budget mensuel par compte, alerte à 80 % et 100 %.
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

## Dépense et budget de chaque compte

Chaque processus d'agent reçoit `WORKPILOT_AI_ACCOUNTS` (`main/ai-accounts/account-attribution.ts`,
posé par `agent-process.ts`) : un objet JSON provider → clé de compte, le compte par défaut de
chaque provider à clé API qui en a un, et `claude:<profil>` pour la connexion Claude du processus.
Des identifiants seulement, jamais une clé. `foundation/ai_account.py` relit la variable comme une
entrée (objet borné, ids `[A-Za-z0-9._:-]{1,100}`, alias `anthropic` → `claude`, `gemini` →
`google`) et `core/usage_tracker.py` écrit `account_id` à côté de la session dans
`.workpilot/cost_data.json`. Une session sur la clé principale ou un profil de `profiles.json` n'a
pas de compte : son coût n'est attribué à personne plutôt qu'au mauvais compte.

`main/ai-accounts/account-usage.ts` additionne le mois en cours (heure locale) de chaque compte sur
les relevés de tous les projets enregistrés (`workspace-ledgers.ts`, racine et worktrees) : coût,
tokens, sessions, et `complete: false` quand une session a des tokens sans prix connu (le coût est
alors un plancher). Seuls les comptes qui existent encore sont rendus.

Le budget mensuel optionnel vit dans `<userData>/config/ai-account-budgets.json` (`0600`, à part
de `ai-accounts.json` pour ne jamais réécrire le fichier des clés,
`main/ai-accounts/account-budgets.ts`) ; supprimer un compte supprime son budget et ses alertes.
Une minute après le démarrage puis toutes les cinq minutes, et seulement si un budget existe, le
main compare le mois au budget : une alerte à 80 %, puis une à 100 %, une seule fois chacune par
mois (un nouveau montant les remet à zéro). Elle part par `notificationService.announce` (bureau,
ntfy, Telegram), sous l'interrupteur « revue nécessaire » du projet qui a le plus dépensé, dans la
langue de l'app. C'est une alerte : rien n'est bloqué (la bascule entre comptes est un autre lot).

RGPD : tout reste sur l'ordinateur de la personne, rien n'est envoyé ; les chiffres sont des sommes
de relevés que les agents écrivaient déjà, sans prompt ni code ; un id de compte est une étiquette
opaque. En mode serveur, le serveur compte ses runs de son côté (`usage_records`, budgets de
l'organisation) : ce lot n'y ajoute rien.

IPC : `aiAccounts:usage` (l'instantané du mois) et `aiAccounts:setBudget` (clé d'un compte qui
existe, montant de 0 à 1 000 000 $, 0 retire le budget), `ipc-handlers/ai-account-usage-handlers.ts`.
Interface : `settings/ai-accounts/AccountSpend.tsx` sous chaque compte (API et Claude), la dépense
du mois à côté de chaque compte dans `usage/ProviderAccountSwitcher.tsx`.

Un lot qui change le compte d'une tâche (compte épinglé par projet ou par carte, bascule) met à jour
la même variable, sinon la dépense irait au compte par défaut.

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
- `apps/frontend/src/main/ai-accounts/account-attribution.ts`, `account-usage.ts`,
  `account-budgets.ts` et `apps/backend/foundation/ai_account.py` : la dépense et le budget par compte.

Voir aussi [forge-accounts.md](forge-accounts.md) (même modèle pour les forges) et
[provider-failover.md](provider-failover.md) (basculement auto entre comptes).

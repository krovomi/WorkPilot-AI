---
feature: Basculement auto entre comptes et providers
summary: >-
  Une tâche arrêtée par une limite, un quota épuisé ou une clé refusée reprend sur l'entrée
  suivante d'une chaîne ordonnée (compte Claude, profil API, compte IA, provider), d'abord sur les
  autres comptes de son provider, à la phase où elle s'est arrêtée ; seul son compte change.
---

# Basculement auto entre comptes et providers

Réglages → Comptes IA → Basculement auto. Avant, seul un compte Claude pouvait en relayer un
autre, et la page enregistrait des interrupteurs que rien ne lisait. Le basculement vaut
maintenant pour tous les providers, et les interrupteurs affichés sont ceux que le main lit
(`ClaudeAutoSwitchSettings` du `ClaudeProfileManager`).

## La chaîne

`shared/utils/failover-chain.ts` décrit une entrée par compte que la personne peut ordonner :

| Id | Quoi |
|---|---|
| `oauth-<id>` | un compte Claude connecté par OAuth (profil Claude) |
| `api-<id>` | un profil API (une clé et une URL, `profiles.json`) ; son provider vient de l'URL |
| `account-<id>` | un compte de Réglages → Comptes IA (`ai-accounts.json`) : une clé sur l'adresse de son provider, ou la connexion d'un outil CLI (Copilot, Codex CLI pour OpenAI, Gemini CLI) ; plusieurs par provider |
| `provider-<nom>` | un provider sans compte à lui ici : Copilot par `gh`, une clé dans les réglages, Ollama, un CLI d'agent |

Le renderer construit la chaîne affichée à partir de ce qui est connecté
(`renderer/components/settings/failover-accounts.ts`) et enregistre l'ordre ; un ordre sauvé
avant les types d'entrée (`copilot`) se lit comme `provider-copilot`. Un provider qui a des
comptes n'y montre que ses comptes (avec une clé, ou connectés pour un outil CLI), son entrée
générique ne ferait que répéter son compte par défaut. Un compte Codex CLI fait tourner OpenAI
(`engineProviderOfAccount`) : l'entrée `provider-openai` reste, c'est la clé OpenAI. Un compte que l'ordre sauvé ne nomme pas encore suit, à la fin, chez le
renderer comme dans le main (`buildFailoverChain`) : un compte ajouté sert sans qu'on réordonne. Une entrée retirée de la
chaîne garde sa place (`disabledAutoSwitchProviders`, par id d'entrée).

Le renderer n'est pas fiable (S6) : `ACCOUNT_PRIORITY_SET` passe par `normalizeFailoverOrder`
(liste de texte bornée à 64 entrées, ids reconnus seulement) et
`CLAUDE_PROFILE_UPDATE_AUTO_SWITCH` par `sanitizeAutoSwitchUpdate` (interrupteurs connus, seuils
entiers de 50 à 99).

## Le basculement

`main/provider-failover/provider-failover.ts`, enregistré une fois par
`agent-events-handlers.ts`, part de deux signaux :

- le backend met la tâche en pause (`rate_limit_paused`, `auth_failure_paused`) ;
- le processus sort sur une limite et `agent-process` le demande
  (`provider-failover-request`) : toujours quand la phase tourne hors de Claude, et pour Claude
  seulement quand aucun autre compte Claude ne reste et que la chaîne nomme un autre provider.
  Le relais d'un compte Claude à un autre reste celui d'avant.

`pickNextFailover` saute l'entrée en cours, celles déjà essayées pour cette tâche (oubliées
après 6 h, le temps qu'une limite se lève), les entrées retirées, celles qui ne peuvent pas
servir (compte non connecté ou limité, profil ou compte sans clé, entrée mise de côté) et
l'entrée générique du provider arrêté, qui buterait sur la même limite. Un autre compte du même
provider reste une issue, et la première essayée : avec « D'abord les autres comptes du même
provider » (`sameProviderFirst`, absent = oui), les comptes du provider arrêté passent devant les
autres entrées, chacun groupe dans l'ordre de la chaîne. Éteint, la chaîne se lit de haut en bas.

L'entrée en cours d'une tâche hors Claude est le compte épinglé sur la tâche (puis sur son
projet, champ `aiAccounts` de `task_metadata.json` et des réglages du projet), dans l'ordre où
l'environnement de la tâche les applique (clé API, puis connexion CLI : `openai`, puis `codex`),
sinon le compte par défaut de son provider (celui de Codex CLI pour OpenAI en mode Codex), sinon
l'entrée générique du provider (`offClaudeEntry`). Pour une
tâche Claude, c'est le profil API actif, sinon le profil Claude épinglé, sinon le profil actif.

L'entrée quittée est mise de côté pour **toutes** les tâches, pas seulement pour celle qui
s'arrête : une heure après une limite ou un quota épuisé, six heures après une clé refusée
(`isCoolingDown`). Une deuxième tâche qui bute ailleurs ne repart pas sur un compte qu'une autre
vient de vider. Les comptes Claude n'y sont pas comptés : leurs limites sont relevées avec l'heure
de remise à zéro que Claude donne (`isProfileRateLimited`).

La reprise passe par `resumeTaskWithProvider` (`ipc-handlers/task/resume-with-provider.ts`),
le chemin du « Reprendre avec… » de la tâche : le moteur est écrit dans `task_metadata.json` à
partir de la phase arrêtée, et le journal de conversation porte le contexte. Un changement de
compte Claude pose d'abord le profil actif ; la session Claude n'est pas reprise, puisqu'un autre
compte ne l'a pas. Un passage vers un compte (`account-<id>`) ou un profil Claude (`oauth-<id>`)
épingle aussi ce compte sur **la tâche seule** (`EngineChoice.accountPin`, écrit dans
`aiAccounts` de chaque copie de `task_metadata.json` avec le moteur), sous le provider du compte
(`codex` pour une connexion Codex CLI, dont l'épingle `openai` est retirée : une clé épinglée
l'emporterait) : le compte par défaut du
provider, donc celui des autres tâches, ne change pas. Le renderer ne peut pas demander cet
épinglage : le « Reprendre avec… » de la tâche ne transmet que provider, modèle, effort et
portée. Une ligne du journal de la tâche dit d'où vers où elle est passée, avec le nom du compte.

## Ce qui arrête un compte

Les mêmes signaux pour tous les providers, avec leurs propres mots :

| Cas | Backend (`agents/provider_errors.py`) | Sortie du processus (`main/rate-limit-detector.ts`) |
|---|---|---|
| Limite (429) | `429`, « rate limit », « too many requests »… | « Error code: 429 », `status 429`, « rate limit »… |
| Quota ou crédit épuisé | `insufficient_quota`, « exceeded your current quota », `RESOURCE_EXHAUSTED`, « Insufficient Balance », 402… (pas un quota « per minute », qui se lève seul) | `insufficient_quota`, `RESOURCE_EXHAUSTED` ; 402 et solde épuisé par `detectBillingFailure` |
| Clé refusée (401) | `401`, « invalid api key », « incorrect api key », « API key not valid »… | « Error code: 401 », « Incorrect API key provided », `invalid_api_key`… |

Un quota épuisé ne donne pas d'heure de remise à zéro, et réessayer sur le même compte ne
passera pas : le coder et la QA (`services/rate_limit_shield.py`) mettent alors la tâche en
pause une heure (`quota_pause`, `agents/rate_limit_time.py`). La pause du coder émet
`rate_limit_paused`, qui passe la tâche au compte suivant ; sans basculement, elle reprend
d'elle-même après l'heure. Une limite courte sans heure se réessaie comme avant. Hors Claude, un
processus qui sort sur un solde épuisé (402) demande le basculement comme sur une limite, quand
le basculement sur les limites est allumé.

Garde-fous : une seule reprise à la fois par tâche, 30 s de calme après un passage (les
derniers événements du processus arrêté ne sont pas une seconde panne), 6 passages au plus par
tâche.

Le passage anticipé (avant la limite, sur les seuils de session et de semaine) ne vaut que pour
les comptes Claude, les seuls dont l'usage est suivi en continu ; la page le dit.

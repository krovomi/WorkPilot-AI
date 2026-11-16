---
feature: Basculement auto entre comptes et providers
summary: >-
  Une tâche arrêtée par une limite ou une connexion perdue reprend sur l'entrée suivante d'une
  chaîne ordonnée (compte Claude, profil API ou provider), par le chemin de « Reprendre avec… »,
  à la phase où elle s'est arrêtée ; le main revalide la chaîne et les interrupteurs envoyés.
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
| `provider-<nom>` | un provider sans compte à lui ici : Copilot par `gh`, une clé dans les réglages, Ollama, un CLI d'agent |

Le renderer construit la chaîne affichée à partir de ce qui est connecté
(`renderer/components/settings/failover-accounts.ts`) et enregistre l'ordre ; un ordre sauvé
avant les types d'entrée (`copilot`) se lit comme `provider-copilot`. Une entrée retirée de la
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
servir (compte non connecté ou limité, profil sans clé) et l'entrée générique du provider
arrêté, qui buterait sur la même limite. Un autre compte du même provider reste une issue.

La reprise passe par `resumeTaskWithProvider` (`ipc-handlers/task/resume-with-provider.ts`),
le chemin du « Reprendre avec… » de la tâche : le moteur est écrit dans `task_metadata.json` à
partir de la phase arrêtée, et le journal de conversation porte le contexte. Un changement de
compte Claude pose d'abord le profil actif ; la session Claude n'est pas reprise, puisqu'un autre
compte ne l'a pas. Une ligne du journal de la tâche dit d'où vers où elle est passée.

Garde-fous : une seule reprise à la fois par tâche, 30 s de calme après un passage (les
derniers événements du processus arrêté ne sont pas une seconde panne), 6 passages au plus par
tâche.

Le passage anticipé (avant la limite, sur les seuils de session et de semaine) ne vaut que pour
les comptes Claude, les seuls dont l'usage est suivi en continu ; la page le dit.

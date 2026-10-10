# Mode Arena

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Qui combat dans le Mode Arena (`shared/utils/arena-contenders.ts`)

Le Mode Arena ne faisait tourner aucun modèle. `runBattle` renvoyait un
paragraphe écrit d'avance par type de tâche, facturait tout le monde à
3 $/million de tokens, et enregistrait chaque participant en
`modelName: "Model A", provider: "unknown"` — si bien que la révélation après
le vote ne révélait rien, que le classement classait des étiquettes, et que la
seule chose que la page existe pour mesurer n'était jamais mesurée. En façade,
la liste des concurrents était quatre noms écrits en dur (`DEMO_PROFILES`),
servis dès que la vraie liste revenait vide — ce qui arrivait toujours, parce
que la vraie liste était `profile:list`, le magasin d'identifiants Claude, qui
ne connaît ni Ollama, ni Copilot, ni Mistral, ni Google.

**Un concurrent est un couple (fournisseur, modèle).** Son `id` est
`fournisseur:modèle`, c'est la clé sous laquelle chaque statistique est classée,
et l'identité voyage avec le participant — masquée par l'UI jusqu'au vote, ce
qui est ce que « à l'aveugle » veut dire : cachée au *lecteur*, connue de
l'enregistrement. L'historique applique la même règle : un combat en attente de
vote n'y affiche pas les noms que l'onglet Combat cache.

**Rien ici ne détecte quoi que ce soit de nouveau.** Deux réponses que
l'application possédait déjà sont jointes : quels fournisseurs sont configurés
(`getStaticProviders`, la source du sélecteur de fournisseur) et quels
modèles chacun propose (`fetchProviderModelCatalog`, le catalogue interrogé
auprès du fournisseur lui-même, avec le registre généré en repli). Aucun nom de
fournisseur ni de modèle n'est écrit dans `arena-contenders.ts` ni dans
`useArenaContenders.ts` : un fournisseur ajouté à l'un ou l'autre arrive dans
l'Arena sans qu'on y touche.

| Couche | Répond |
|---|---|
| `shared/utils/arena-contenders.ts` | la liste, la recherche, le couple d'ouverture, l'identité d'un concurrent |
| `renderer/hooks/useArenaContenders.ts` | la jonction des deux sources, et ce qui est injoignable |
| `main/ipc-handlers/arena-handlers.ts` | l'exécution réelle, via `runOneShotLLM` — un contestant, son fournisseur, son modèle |

**Deux modèles locaux sont écartés, pour la même raison : ils ne peuvent pas
gagner un combat, seulement en perdre un sur une erreur.** Celui dont le backend
dit qu'il ne sait pas appeler d'outil, exactement comme le sélecteur de modèles
l'écarte ; et celui qui **n'est pas téléchargé**. Le sélecteur garde ces
derniers comme suggestions parce qu'il sait lancer le `pull` ; l'Arena ne le
sait pas, et y entrer dépense un combat en
`pull model manifest: file does not exist`. Cela règle au passage le cas du
serveur éteint : il répond par le catalogue hors ligne, où rien n'est installé,
donc il ne présente personne au lieu de trente-cinq modèles que la machine n'a
pas.

**Un fournisseur sans adaptateur propre n'entre pas.** meta, aws, cursor et
custom sont servis par le SDK Claude (`capabilities/providers.yaml`,
`degrades_to`) — mistral, deepseek et grok ont le leur
(`CompatibleProviderAgentClient`) et entrent. Servir par le SDK Claude est le bon compromis pour un
build — la tâche tourne — et le mauvais ici, puisqu'une victoire serait
enregistrée au nom d'un éditeur qui n'a jamais vu le prompt. Deux barrières, et
elles ne disent pas la même chose : `oneshot_completion(require_provider=True)`
**refuse** plutôt que de substituer, ce qui est la garantie ; et
`GET /providers/agentic-capabilities` sert cette même matrice au renderer, ce
qui permet de le *dire* dans le sélecteur au lieu de le faire découvrir un
combat plus tard. La matrice est servie et non recopiée en TypeScript : une
seconde copie dériverait le jour où un adaptateur est écrit. Un fetch en échec
laisse tout le monde entrer — vider la page parce que le backend démarre encore
serait pire, et c'est le refus côté backend qui tient la promesse.

**Le couple d'ouverture vient de deux fournisseurs différents** quand c'est
possible. Comparer deux modèles du même éditeur est un combat légitime, mais ce
n'est pas celui qu'on ouvre l'Arena pour lancer, et prendre les deux premiers
d'une liste triée par fournisseur ne donnerait jamais que celui-là.

**Ce qui est affiché est ce qui a été mesuré.** `oneshot_completion` rend
désormais le `last_usage` du fournisseur (`__ONESHOT_USAGE__`), et *seulement*
quand il y en a un : un fournisseur muet ne devient pas
`{"input_tokens": 0, "cost_usd": 0.0}`, parce que dans un classement un zéro
inventé ne se distingue plus d'une mesure. Les tokens tombent alors sur une
estimation, préfixée d'un `~` et dite telle quelle ; le coût, lui, s'affiche
`—`. Un `0` venu d'un modèle local, c'est une vraie réponse et elle s'affiche.
La moyenne du classement ne porte que sur les combats dont le coût a été
rapporté (`costSamples`).

**Les combats de l'ère simulée sont mis de côté, pas comptés.** Ils ne portent
aucune identité résoluble, donc ils ne peuvent pas répondre à la question que
l'onglet Analytics pose, et les compter mettrait un prix inventé à côté d'un
prix mesuré. `readBattles` les déplace une fois vers
`battles.pre-real-models.json` — un enregistrement que personne ne peut
exploiter reste celui de l'utilisateur.

**Une session d'Arena est un vrai appel par modèle.** Le prompt système est le
même pour tous (`TASK_SYSTEM_PROMPTS`, un par type de tâche) : l'Arena mesure le
modèle, donc tout ce qui diffère entre les concurrents est un facteur
confondant. Il est court volontairement — une longue charte maison mesurerait la
capacité à suivre une charte.

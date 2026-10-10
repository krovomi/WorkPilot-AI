# Le mode hors-ligne

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Le mode hors-ligne : une barrière, ou un défaut

`.workpilot/offline-mode.json` porte deux politiques sous un seul nom, et les
confondre est ce qui a fait mourir un Bounty Board configuré sur Anthropic
sur `ValueError: Local model llama3.3:latest is unavailable on ollama` — un
fournisseur que personne n'avait sélectionné, un modèle que personne n'avait
nommé, et pas un mot sur l'origine de l'un ni de l'autre.

| `airgapStrict` | Ce que la table de routage est |
|---|---|
| `true` | **une barrière.** Elle remplace ce que l'appelant voulait, et une route impossible à honorer est une erreur dure : il n'y a pas de repli légal, puisque tout l'objet est qu'aucun appel cloud ne quitte la machine |
| `false` | **un défaut.** La page le dit elle-même : « le mode strict est désactivé : les opérations sans route locale peuvent encore utiliser le cloud ». Un défaut répond pour l'appelant qui n'a rien nommé ; il ne tranche pas à la place de celui qui a nommé quelque chose |

`resolve_offline_route` reçoit donc un `chosen` — vrai quand le couple
(fournisseur, modèle) est une décision prise pour cette exécution, faux quand
c'est le défaut `core.client._DEFAULT_PROVIDER` que personne n'a demandé. Sans
lui, **tous** les appelants avaient l'air explicites : `create_agent_client`
résout le fournisseur *avant* d'appeler, si bien qu'une table hybride
redirigeait silencieusement les six phases nommées (`planner`, `coder`,
`qa_reviewer`, `commit_message`, `summary`, `triage`) de chaque build vers un
modèle local, et que le seul symptôme était un message nommant un fournisseur
jamais choisi.

C'est `_resolve_active_provider` qui répond aux deux moitiés — *quel
fournisseur*, et *quelqu'un l'a-t-il nommé* — et `_get_active_provider` n'est
plus qu'un appel dessus. Une seconde chaîne de résolution pour répondre à la
deuxième moitié aurait dérivé de la première au premier changement.

**Un couple local choisi reste validé, et une erreur reste une erreur.**
Exécuter Anthropic parce qu'Ollama n'est pas démarré est une substitution que
personne n'a demandée, et le silence ferait passer un modèle indisponible pour
un modèle qui répond mal. Seule une **route hybride** — un défaut que la
fonction a appliqué d'elle-même — s'efface au lieu d'échouer, en le disant dans
le journal : faire échouer un build sur un défaut est le seul résultat que
personne n'a demandé, et le mode hybride autorise le cloud par définition.

**Et le message nomme sa source.** « Local model X is unavailable on ollama »
décrivait parfaitement ce qui n'allait pas et rien de ce qu'il fallait savoir :
quelle tâche, quelle politique, et quoi faire. Il nomme désormais la route qui a
désigné ce modèle, le fournisseur qu'elle a *remplacé*, et la sortie —
`STRICT_EXIT_HINT`, écrite une fois. Un message qui décrit une barrière sans
dire où est l'interrupteur laisse son lecteur chercher dans les réglages d'un
produit qui en a quatre-vingts.

### Le défaut d'un fichier absent n'est pas une barrière

Tout ce qui précède décrit le mode strict comme une décision. Il ne l'était pas :
`_default_policy` — ce que la page propose à un projet qui n'a jamais rien
configuré — renvoyait **`airgapStrict: True`**, avec les six tâches routées vers
le premier modèle local par ordre alphabétique. Le store marque une politique
non persistée `dirty`, donc le bouton Enregistrer est actif dès le premier
rendu : ouvrir la page par curiosité et cliquer une fois coupait tout
fournisseur cloud du projet.

Le symptôme arrivait bien plus tard et ailleurs — un Bounty Board configuré sur
Anthropic, OpenAI et Google mourant trois fois sur
`llama3.3:latest is unavailable on ollama`, un modèle que personne n'avait
nommé — et la seule façon de faire le lien était de rouvrir cette page.

Le *fail-closed* est la bonne règle pour **honorer** un airgap que quelqu'un a
demandé. Appliqué à l'absence d'un fichier, il devient un fail-closed contre
l'intention de l'utilisateur, ce qui est autre chose portant le même nom. Le
défaut est `False` ; activer la barrière reste un geste, et la case cochée se
rend désormais comme une alerte plutôt qu'en texte gris — c'est la seule bascule
du produit qui désactive tous les fournisseurs cloud.

### Le mode strict est lisible ailleurs que sur sa propre case

`_status()` ne portait que les runtimes locaux, si bien que « ce projet est en
airgap » n'était lisible nulle part ailleurs que sur la page Mode hors-ligne.
Partout ailleurs — la liste « Fournisseur IA », le Bounty Board, l'Arena — le
fournisseur choisi s'affichait avec sa pastille verte et le backend refusait
l'appel une seconde plus tard.

| Qui répond | Où |
|---|---|
| le fait, et **quel fichier** le décide | `offline_policy.airgap_status` |
| « ce fournisseur tourne-t-il sur la machine ? », quelle que soit son orthographe | `offline_policy.is_local_provider` |
| le statut servi à l'UI (`airgapStrict`, `policyPath`, `policyPersisted`) | `offline_mode_runner._status` |
| le renderer | `useAirgapStatus` |

`_policy_files` est extrait de `project_policies` pour que « quel fichier le
dit » et « que dit-il » soient une seule recherche lue deux fois : une seconde
remontée d'ancêtres écrite ailleurs répondrait à côté le jour où un projet
hérite de la politique d'un répertoire parent — ce qui est précisément le cas
que `project_policies` existe pour couvrir.

**Le Bounty Board refuse un participant cloud avant de le lancer.** En mode
strict, chacun était réécrit vers le modèle local de la politique : un plateau
de trois fournisseurs cloud devenait trois fois le même modèle — ou, quand ce
modèle n'est pas installé, trois fois la même erreur. C'est la même règle que
pour un fournisseur sans adaptateur agentique, pour la même raison, et un
concours entre modèles **locaux** reste parfaitement légitime.

### L'interrupteur est là où la barrière se manifeste

Le message ci-dessus décrivait la barrière puis renvoyait ailleurs : « décochez
Mode strict dans Réglages → Mode hors-ligne ». C'est une instruction de
navigation, pas une réponse — et elle demande d'aller décocher, dans un autre
écran, une case que personne n'avait cochée. `AirgapBanner` porte donc le
bouton, et `useAirgapStatus.disableStrict` l'exécute.

Ce que le bouton ne fait pas, c'est décider : lever un airgap reste un geste
explicite, sur un clic, avec le fichier concerné écrit à l'écran. Une migration
qui aurait désactivé le mode strict des politiques existantes serait la faute
d'origine à l'envers — quelqu'un qui a vraiment voulu l'airgap le perdrait sans
qu'on le lui demande.

**La désactivation renvoie la politique persistée telle quelle**, `airgapStrict`
mis à `false` et pas un champ de plus. C'est la seule forme que `_save_policy`
accepte sans revalider le routage (`disabling_only`), et cela compte exactement
ici : la politique qui piège l'utilisateur route vers un modèle désinstallé,
souvent avec le serveur local éteint, donc toute écriture prétendant la
« corriger » au passage serait refusée et le bouton ne ferait rien.
`test_strict_can_be_lifted_with_a_missing_model_and_no_server` est ce qui garde
cette porte ouverte.

**Un airgap hérité d'un parent n'offre pas de bouton.** La recherche remonte les
répertoires ancêtres, alors que `set-policy` n'écrit que dans
`<projet>/.workpilot/` — et la résolution est stricte dès qu'une *seule* des
politiques trouvées l'est. Un bouton y créerait une seconde politique sans rien
débloquer, ce qui est pire que pas de bouton ; `_status` répond donc
`policyIsProjectOwn`, en comparant des chemins **résolus** plutôt que des
chaînes.

---
feature: Bac à sable de l'OS
summary: >-
  Processus d'agent sous bubblewrap (Linux) ou Seatbelt (macOS) : écritures dans le worktree,
  identifiants masqués, réseau par un proxy filtrant (provider + registres) ; sans bac à sable la
  carte le dit au lancement, `WORKPILOT_SANDBOX=required` refuse de démarrer ; en option (coupée
  par défaut), une microVM Docker Sandboxes (`sbx`) par tâche, seule isolation sous Windows.
---

# Bac à sable de l'OS autour des commandes d'agent

> [Annexe G8](../audit/annexes/G8.md) du cahier d'audit. Code :
> `apps/backend/os_sandbox/`. Règles : [`rules/security.md`](../rules/security.md) S3 et S4.

## Le problème

L'allowlist de commandes (`bash_security_hook`) et les écritures confinées (`path_guard`) jugent
une commande **avant** qu'elle tourne. Une fois lancée, un `npm install`, un script de test ou un
binaire téléchargé peut écrire n'importe où, lire `~/.ssh` ou joindre n'importe quel hôte : rien
ne le voit. Ce que le noyau refuse, en revanche, aucun processus ne le contourne. Ce lot ajoute
cette deuxième barrière : le processus de l'agent tourne dans un bac à sable de l'OS.

## Ce qui est enveloppé

| Provider | Qui lance les commandes | Bac à sable |
|---|---|---|
| OpenAI, Google, Copilot, Windsurf, compatibles, locaux | la boucle WorkPilot, `run_command` de `core/runtimes/tool_executor.py` | chaque commande, `/bin/sh -c` sous le bac à sable de WorkPilot |
| OpenCode, pi, agents ACP (Gemini CLI) | le CLI lui-même | tout le processus du CLI (`CliSubprocessAgentClient._launch`), avec le profil `sandbox:` de son entrée dans `capabilities/providers.yaml` |
| Antigravity | le CLI lui-même | aucun : pas de profil, la carte le dit |
| Claude (SDK) | Claude Code | le sien (`sandbox.enabled` dans les réglages posés par `create_client`), rapporté `delegated` ; sous Linux il lui faut bubblewrap **et** `socat`, sinon la carte dit « non isolé » |
| Codex CLI | Codex | le sien (sandbox Codex de [`agent-tool-rights.md`](agent-tool-rights.md)), rapporté `delegated` |

WorkPilot n'enveloppe pas deux fois un CLI qui s'isole déjà. Le choix est fait une fois par
session, au lancement, par `_sandbox_at_launch` dans `core/client.py`.

## La politique

`os_sandbox/policy.py` (`build_policy`) calcule, depuis le worktree et la spec :

- **Écriture** : les racines de `security/path_guard.resolve_write_roots` (projet, spec,
  `<tmp>/workpilot`), le répertoire git commun du worktree (un commit doit pouvoir écrire ses
  objets), les caches de paquets existants (`~/.npm`, `~/.cache/pip`, `~/.cargo/registry`…), et
  l'état propre du CLI déclaré dans son profil (`~/.config/opencode`, `~/.pi`…, créé en `0700`
  s'il manque).
- **Lecture seule** dans ces racines : la configuration de sécurité (`PROTECTED_CONFIG_NAMES` et
  `PROTECTED_CONFIG_DIRS` de `path_guard`), `.git/hooks`, `.git/config` (un hook ou un
  `core.fsmonitor` écrit par l'agent s'exécuterait chez la personne), et les fichiers que le
  profil déclare `read_only` (la liste de confiance de pi : `/trust` n'est jamais accordé à la
  place d'une personne).
- **Masqué** : `~/.ssh`, `~/.gnupg`, les identifiants cloud (`.aws`, `.azure`, gcloud, `.kube`,
  `.docker`), `gh`, `.netrc`, les identifiants de registres (`.npmrc`, `.pypirc`, `NuGet.Config`,
  `settings.xml`, `gradle.properties`, cargo), les jetons de Claude Code et Codex, la
  configuration de WorkPilot et de l'app, le trousseau macOS, le `.env` du backend,
  `.env-files/`, les `.workpilot/.env` du projet et du dépôt principal, et les sockets de moteur
  de conteneurs (docker, containerd, podman). Un chemin masqué qui contient une racine
  d'écriture n'est pas masqué : le projet passe avant.
- **Réseau** : rien, sauf un proxy filtrant local. L'allowlist (`os_sandbox/hosts.py`) réunit les
  registres de paquets (npm, PyPI, NuGet, crates, Go, Maven, Gradle, RubyGems), les hôtes que le
  profil du provider déclare, et `WORKPILOT_SANDBOX_HOSTS`. Une entrée distante n'ouvre que 443 et
  80 ; `*.exemple.com` ouvre les sous-domaines, jamais le domaine ni un suffixe ; une entrée
  locale nomme un port (`127.0.0.1:11434`), jamais tout `localhost`. `*.com`, un port sur un hôte
  distant ou un nom invalide sont ignorés.

Rien de tout cela ne vient du modèle ni du dépôt : les listes sont dans le code, dans
`providers.yaml` (validé par `skills_registry/providers.py`, qui refuse une entrée mal formée au
chargement) et dans l'environnement de la personne.

## Le proxy

`os_sandbox/proxy.py` (`FilteringProxy`) tourne dans le backend, sur son propre thread. Il accepte
`CONNECT` (HTTPS, tunnel opaque) et les requêtes HTTP en URI absolue, juge l'hôte et le port
contre l'allowlist, et répond 403 avec un corps lisible à tout le reste. Chaque refus est noté
(`Refusal(at, host, port)`) : `run_command` ajoute à la sortie de la commande
`[WorkPilot sandbox] network refused: host:port (…)`, pour que le modèle sache pourquoi son
`curl` a échoué au lieu de réessayer à l'aveugle. Si la machine passe par un proxy HTTP
d'entreprise (`HTTPS_PROXY` en `http://` sans identifiants), le proxy filtrant s'y chaîne ; un
proxy avec identifiants n'est pas chaîné (ils iraient dans la requête de tunnel).

Le processus enveloppé reçoit `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (et leurs minuscules),
`NO_PROXY=""` et `NODE_USE_ENV_PROXY=1`. Un programme qui ignore ces variables n'a simplement pas
de réseau : il échoue, il ne fuit pas.

## Par OS

### Linux : bubblewrap

`bwrap_argv` : `--unshare-net --unshare-pid --unshare-ipc --die-with-parent --new-session`,
`--ro-bind / /`, puis les racines d'écriture en `--bind` (de la moins profonde à la plus
profonde), puis, **après**, la lecture seule et les masques (`--tmpfs` sur un dossier, `/dev/null`
sur un fichier). L'ordre compte : un montage posé plus tard recouvre celui d'avant, donc un masque
gagne toujours sur un bind. `/tmp` et `/run/user/<uid>` sont des tmpfs privés ; `TMPDIR` pointe
vers `scratch/sandbox-tmp/<uuid>`, persistant pour la session.

Le réseau de l'espace de noms est vide : seul `127.0.0.1:18080` y répond, relayé par
`os_sandbox/bridge.py` (`python -I`, lancé dans le bac à sable) vers la socket Unix `0600` du
proxy, montée en lecture seule. Le pont transmet SIGTERM, SIGINT et SIGHUP, rend le code de
sortie de la commande et n'écrit jamais sur stdout ni stderr, qui appartiennent au CLI (pi parle
JSON-RPC dessus).

### macOS : Seatbelt

`seatbelt_profile` : `(allow default)`, `(deny file-write*)` puis les racines d'écriture
autorisées, refus d'écriture sur la lecture seule, refus de lecture et d'écriture sur les masques,
`(deny network-outbound)` puis `localhost:*` seulement, où écoute le proxy (TCP). Les variantes
`/private/…` des chemins sont ajoutées (`/tmp` et `/var` sont des liens).

### Windows : la microVM, sinon rien

AppContainer et job object ne sont pas livrés. Sans la microVM ci-dessous, le probe répond
`unavailable` avec la raison « AppContainer is planned », et la carte dit que les commandes ne sont
pas isolées. Ce n'est pas présenté comme un bac à sable qui marche.

## En option : une microVM Docker Sandboxes par tâche

`os_sandbox/microvm.py`. Coupée par défaut : Paramètres > Sandbox, « Lancer chaque tâche dans une
microVM Docker » (`agentSafety.sandbox.microvm`, porté par `WORKPILOT_AGENT_SAFETY` et relu, borné,
par `security/agent_safety_settings.py`). Coupée, rien de ce qui précède ne change.

**Ce qui y tourne (lot C1)** : les commandes de la boucle WorkPilot (`run_command`), par
`sbx exec`. Les appels au modèle restent dans le backend, sur l'hôte : aucun identifiant n'entre
dans la VM, et seules `LANG`, `LC_ALL`, `TZ`, `CI`, `NO_COLOR` et `FORCE_COLOR` y passent. Un CLI qui
lance ses propres commandes garde le bac à sable de l'OS (`session_sandbox(…, microvm=False)`),
sauf avec le second interrupteur ci-dessous.
Le modèle est prévenu dans la description de `run_command` que ses commandes tournent en
`/bin/sh` dans une VM Linux, quel que soit l'hôte.

**Une VM par worktree**, `workpilot-<hash du chemin>`, créée au lancement de la première session
(`ensure_vm`, appelée par `session_sandbox`) et reprise par les suivantes (planification,
code, QA) : ce qu'une session installe reste pour la suivante. Sa configuration est fixée à la
création ; une VM créée pour d'autres montages ou une autre allowlist est supprimée et recréée
(empreinte dans `<scratch>/sandbox-vm/<nom>/vm.json`). `remove_vm` la supprime avec le worktree.

| Ce que la VM voit | Comment |
|---|---|
| Le worktree, la spec, le dépôt git où il commite, `WORKPILOT_WRITE_ROOTS` | montés en lecture-écriture, le worktree en premier (dossier par défaut de `sbx exec`) ; au même chemin sous macOS et Linux, sous `/<lecteur>/…` sous Windows (`C:\Users\…` → `/c/Users/…`). Le worktree est donné sans cible (sbx 0.54 en refuse une pour le premier montage : « primary workspace is mounted at its host path ») ; les autres avec une cible explicite au même endroit. Un chemin réseau (UNC) n'est pas monté : la VM n'est pas créée et le bac à sable de l'OS prend le relais |
| `.git/hooks`, `.git/config`, la configuration de sécurité | remontés en lecture seule par-dessus |
| `.workpilot/.env` et les autres chemins masqués à l'intérieur des montages | couverts par un fichier ou un dossier vide, en lecture seule |
| Le dossier personnel, ses identifiants, les caches de paquets de l'hôte | jamais montés : la VM a les siens |
| Le pointeur `.git` d'un worktree, sous Windows | un fichier `gitdir:` réécrit pour la VM, monté par-dessus ; celui de l'hôte n'est pas touché |
| Git | `safe.directory '*'` et le `core.autocrlf` de l'hôte, dans la configuration globale de la VM, jamais dans celle du dépôt |

**Réseau** : sbx donne à chaque VM sa politique globale (une liste d'environ 200 hôtes permis,
`balanced`), et une règle de refus gagne toujours sur une règle d'autorisation. La VM est donc
créée fermée (`--deny-network "**"` : l'option prend les hôtes refusés), puis `_ensure_network`
refuse pour elle chaque hôte de la politique globale (`sbx policy ls --json --type network
--decision allow`) dont la tâche n'a pas besoin, autorise l'allowlist du bac à sable de l'OS en
règles propres à elle (`sbx policy allow network --sandbox <nom>`, ports 443 et 80) plus les
sources de son système et de son moteur Docker (`VM_HOSTS`), et retire enfin le refus de `**`.
Une règle globale qui couvre un hôte de la tâche (`**.docker.com` pour le registre Docker) reste
ouverte : son refus l'emporterait. Les refus sont recalculés à chaque session (un hôte ajouté à
la politique globale est refusé à son tour ; un refus que la tâche vient à contredire est levé).
Une politique globale qui permet tout (`**`) ne peut pas être tenue : la VM n'est pas utilisée et
la carte le dit. Une entrée locale (`127.0.0.1:11434`)
devient `localhost:11434`, joint depuis la VM par `host.docker.internal`. Les refus sont lus dans
`sbx policy log --json` et ajoutés à la sortie de la commande comme ceux du proxy.

**Taille** : la mémoire et les processeurs des réglages, sinon `vm_resources` : la mémoire libre
partagée entre cette tâche et les builds en cours (`test_placement.machine`), entre 2 et 16 Gio,
et la moitié des cœurs, au moins 2. Sans `--memory`, sbx donnerait la moitié de la RAM à chaque VM.

**Quand la VM n'est pas là** (sbx absent, pas connecté par `sbx login`, plateforme d'hyperviseur
Windows coupée, création refusée) : le bac à sable de l'OS prend le relais et la ligne du fil
dit « Docker Sandboxes microVM not used: … » avec les mots de sbx ; sans bac à sable de l'OS non
plus, la raison réunit les deux, et `WORKPILOT_SANDBOX=required` refuse de démarrer. Le probe
lance `sbx version` et `sbx ls --json` ; la vraie preuve est la création.

**RGPD** : chaque appel à `sbx` porte `SBX_NO_TELEMETRY=1` ; en local, aucun code ni prompt ne part
chez Docker. Un compte Docker reste exigé par `sbx login` : c'est pourquoi l'option est coupée par
défaut.

**sbx est lancé sans les identifiants de l'hôte** (`sbx_env`, même règle que
`security/child_env.py`) : il se connecte seul (`sbx login`, ses clés dans le trousseau), et ce que
son environnement porte peut être passé à la VM.

**Arrêt** : tuer `sbx exec` sur l'hôte laisse la commande tourner dans la VM. Chaque commande y
démarre dans sa propre session (`setsid -w sh -c 'echo $$ > <fichier>; exec "$@"'`, `RUN_SCRIPT`)
et note son groupe de processus dans `/tmp/workpilot-run-<id>.pid` ; au délai ou à l'annulation,
`SessionSandbox.stop(argv)` (`stop_run`) envoie TERM puis KILL à ce groupe par un second
`sbx exec`. `run_command` et les CLI d'agents l'appellent après avoir arrêté le processus hôte.

Une commande lancée dans la VM n'a pas de stdin (`DEVNULL`) : sbx attend sur un tube ouvert que la commande ne lit pas. Celle qui lit son stdin le demande (`wrap(…, stdin=True)`, qui ajoute `sbx exec -i`).

Vérifié sous Windows 11 avec sbx 0.54.1 : création (55 s la première fois, image comprise, puis 7 s), git dans le worktree par le pointeur réécrit, écriture du worktree vue par l'hôte, `.git` en lecture seule refusé à l'écriture, codes de sortie (3 donne 3, commande inconnue 127), `-e`, `-w`, `--memory` et `--cpus`. Puis : le réseau fermé puis ouvert hôte par hôte comme ci-dessus (pypi.org refusé, example.org permis), les champs de `policy log` (`host`, `count`, `rule`, `reason`), `host.docker.internal` vers `localhost:<port>` de l'hôte, l'arrêt par le fichier du groupe, Docker dans la VM (chaque VM a son moteur), et l'image `shell` (Debian 13 : curl, python3, git ; ni Node ni npm).

Limites connues : sous Windows, les dépendances installées dans la VM sont des binaires Linux (un
`node_modules` installé par l'hôte n'y tourne pas toujours, et inversement) ; sbx exige Windows 11 avec la plateforme d'hyperviseur, macOS 14 sur Apple silicon ou Ubuntu 24.04 avec
KVM. La purge avec le worktree et l'état de sbx sont dans Paramètres > Sandbox.

### Un CLI d'agent dans la VM (lot C2, expérimental)

Second interrupteur, coupé par défaut : « Lancer aussi les CLI d'agents dans la microVM »
(`agentSafety.sandbox.microvm.cliAgents`, lu seulement si la microVM est allumée). Il vaut pour un
CLI dont le bloc `sandbox:` de `capabilities/providers.yaml` a une entrée `microvm:` (OpenCode
aujourd'hui) : `command` (son nom dans la VM), `install` (une ligne, jouée une fois par VM) et
`secrets` (service sbx → variables du CLI). `core/agent_clients/cli_microvm.py` décide (`plan`) et
ouvre la session (`open_session`).

**Les clés restent dans sbx.** WorkPilot ne copie aucune clé : la personne la range elle-même
(`sbx secret set openai`…). `secret_services()` lit la liste des services rangés (`sbx secret ls`),
jamais leur valeur. Dans la VM, les variables du CLI valent `proxy-managed` et le proxy de sbx
ajoute la vraie clé aux requêtes qui en sortent ; aucune clé de l'hôte n'est passée
(`sbx exec -e` n'accepte qu'un nom de variable valide et une valeur sur une ligne). Le modèle choisi
doit être celui d'un service rangé (`anthropic/…` demande `anthropic`).

**Le CLI reste sur l'hôte**, dans le bac à sable de l'OS, et la carte dit pourquoi
(`fallback_reason`) : pas de profil microVM, pas de clé rangée dans sbx pour ce CLI ou ce modèle
(une connexion par abonnement, un modèle local), sbx pas prêt, ou installation ratée dans la VM.
Interrupteur coupé, rien ne change.

**Installation** : `ensure_tool` lance `command -v <cmd> || { <install>; }` dans la VM, sous le
verrou de la VM, et le note dans son état ; les sessions suivantes ne le refont pas. L'image n'a
pas Node : OpenCode s'installe en binaire autonome, l'archive `opencode-linux-<x64|arm64>` du
registre npm extraite dans `~/.local/opencode` et liée dans `~/.local/bin` (dans le `PATH` de la
VM), sans root. Les hôtes du CLI (`network`) s'ajoutent aux règles de la VM sans la recréer.

Limites : le CLI doit aussi être installé sur l'hôte (sa détection reste celle de l'hôte) ; ses
serveurs MCP ne sont pas lancés dans la VM (ils sont retirés de la session, avec un avertissement).
Vérifié sous Windows : `sbx secret ls --json` donne `{"secrets": [{"scope", "type", "name",
"secret": "(stored)"}], …}` (des noms, jamais une valeur), le proxy ajoute la clé rangée à
`api.anthropic.com`, OpenCode 1.19.6 s'installe et lance la requête ; il écrit sous
`~/.config`, `~/.local/share`, `~/.cache` et `~/.local/state` de la VM, et tente `models.dev` et
`models.opencode.ai` (refusés, il s'en passe).

## Le garde-fou : la carte le dit au lancement

`probe()` ne devine pas : il **lance** le bac à sable une fois (`bwrap … /bin/true`,
`sandbox-exec … /usr/bin/true`) et garde le résultat. Un binaire présent mais refusé par le noyau
est donc vu comme absent, avec sa raison.

`WORKPILOT_SANDBOX` :

| Valeur | Sans bac à sable possible |
|---|---|
| `auto` (défaut) | le build tourne ; la carte et le fil disent « commandes non isolées » et pourquoi |
| `required` | le build ne démarre pas (`SandboxRequiredError`, levée avant le premier tour) |
| `off` | jamais de bac à sable, et la carte le dit aussi |

`_report_sandbox` (`core/client.py`) écrit une ligne dans le fil de la tâche (avertissement si
non isolé) et émet l'événement `SANDBOX_STATUS`, une fois par spec, provider et état
(`os_sandbox.first_report` ; le paquet reste sous `core`, `tests/test_import_contracts.py`). Le main le valide (zod,
`main/task-sandbox.ts`), le garde par tâche et provider, et le pousse au renderer
(`task:sandboxStatus`, relu par `task:sandboxList` au démarrage du renderer). `TaskSandboxNotice`
l'affiche sur la carte, raisons en infobulle, et ne montre rien tant que les commandes sont
isolées ou déléguées. La raison vient du backend en anglais stable et s'affiche comme du texte.

## Limites connues

- **Ubuntu 24.04 et suivantes** restreignent les espaces de noms utilisateur non privilégiés par
  AppArmor : `bwrap` échoue, le probe le voit et la carte le dit. Pour l'activer :
  `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`, ou un profil AppArmor pour
  `bwrap`. La CI le fait sur ses runners Linux.
- **macOS** : le proxy écoute en TCP sur `localhost`, donc tout service local de la machine reste
  joignable directement. Sous Linux, un service local n'est joignable que déclaré
  (`127.0.0.1:port`) et par le proxy.
- **`/tmp` sous Linux** est propre à chaque processus enveloppé : deux commandes de la boucle
  WorkPilot ne le partagent pas. `TMPDIR`, lui, dure toute la session.
- **Un registre privé ou un miroir** s'ajoute par `WORKPILOT_SANDBOX_HOSTS` ; ses identifiants
  (`.npmrc`, `.pypirc`) sont masqués, donc un registre authentifié ne marche pas encore dans le
  bac à sable.
- **Antigravity** n'a pas de profil : ses hôtes et son état ne sont pas connus, il n'est pas
  enveloppé.

## Tests

- `tests/os_sandbox/test_hosts_and_policy.py` : règles d'hôtes, politique, ordre des montages
  bwrap, profil Seatbelt.
- `tests/os_sandbox/test_proxy.py` : tunnel et requête autorisés, refus notés, requête mal formée,
  chaînage d'un proxy amont.
- `tests/os_sandbox/test_session.py` : les trois modes, `required` qui refuse le lancement, le
  rapport émis une fois, le choix par type de client, le CLI lancé par son enveloppe.
- `tests/os_sandbox/test_microvm.py` : la microVM par un faux `sbx` : chemins et noms, montages
  (lecture seule, masques, pointeur git sous Windows), règles réseau, taille, création, reprise,
  recréation, refus, commande sans les secrets de l'hôte, repli sur le bac à sable de l'OS.
- `tests/os_sandbox/test_real_sandbox.py` : le vrai bac à sable, sur une machine qui en a un
  (écriture hors projet refusée, allowlist en lecture seule, `~/.ssh` illisible, réseau limité à
  l'allowlist, `run_command`). Sous `WORKPILOT_EXPECT_SANDBOX` (runners Linux et macOS de la CI),
  un bac à sable absent est un échec avec sa raison, jamais un saut silencieux.
- `tests/conftest.py` met `WORKPILOT_SANDBOX=off` par défaut : les autres tests lancent des
  sous-processus qui ne doivent pas dépendre de la machine.
- Frontend : `src/main/__tests__/task-sandbox.test.ts`,
  `components/task-sandbox/__tests__/TaskSandboxNotice.test.tsx`.

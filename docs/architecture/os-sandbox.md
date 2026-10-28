# Bac à sable de l'OS autour des commandes d'agent

> Annexe G8 de [`audit/AUDIT-NETTOYAGE.md`](../audit/AUDIT-NETTOYAGE.md). Code :
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

### Windows : pas encore

AppContainer et job object ne sont pas livrés. Le probe répond `unavailable` avec la raison
« AppContainer is planned », et la carte dit que les commandes ne sont pas isolées. Ce n'est pas
présenté comme un bac à sable qui marche.

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
- `tests/os_sandbox/test_real_sandbox.py` : le vrai bac à sable, sur une machine qui en a un
  (écriture hors projet refusée, allowlist en lecture seule, `~/.ssh` illisible, réseau limité à
  l'allowlist, `run_command`). Sous `WORKPILOT_EXPECT_SANDBOX` (runners Linux et macOS de la CI),
  un bac à sable absent est un échec avec sa raison, jamais un saut silencieux.
- `tests/conftest.py` met `WORKPILOT_SANDBOX=off` par défaut : les autres tests lancent des
  sous-processus qui ne doivent pas dépendre de la machine.
- Frontend : `src/main/__tests__/task-sandbox.test.ts`,
  `components/task-sandbox/__tests__/TaskSandboxNotice.test.tsx`.

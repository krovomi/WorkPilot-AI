# Garde-fous en code (Policy-as-Code)

Une politique écrite dans le dépôt dit ce que les agents ne peuvent pas faire : toucher
`**/migrations/**`, supprimer un test, ajouter une dépendance sans revue, écrire un fichier
généré de 800 lignes. Elle est appliquée avant l'appel d'outil, sur tous les providers : le hook
PreToolUse de `create_client()` pour le SDK Claude, `security.hooks.guardrail_refusal` /
`command_refusal` pour ceux qui passent par `ToolExecutor` (Copilot, OpenAI et apparentés,
Windsurf, LiteLLM, runtimes locaux). Issue #377.

## Où la politique est lue

Trois couches, de la plus large à la plus proche (`security/guardrail_policy.py`) :

| Couche | Fichier | Pour |
|---|---|---|
| globale | `$WORKPILOT_GUARDRAILS_GLOBAL`, sinon `~/.workpilot/guardrails.yaml` | les règles d'une personne ou d'un poste |
| dépôt | `workpilot.policy.yaml` (ou `.yml`) à la racine, versionné | les règles de l'équipe |
| projet | `.workpilot/guardrails.yaml`, `.yml` ou `.json` | ce que l'écran de réglages écrit |

**Tout est lu depuis le projet principal**, même quand l'agent tourne dans un worktree de tâche
(`main_project` remonte `.workpilot/worktrees/…`, `.workpilot/github/…`, `.worktrees/…`).
Avant, la politique était cherchée dans le worktree, où `.workpilot/` n'existe pas puisqu'il est
ignoré par git : aucun garde-fou ne s'appliquait aux tâches du Kanban.

**Une couche ne peut pas affaiblir la précédente.** Une règle de même `id` dans une couche plus
proche avec une action plus faible est ignorée, avec un avertissement ; plus forte, elle s'ajoute
sous l'id `<id>@<couche>` et la plus stricte gagne.

**Politique invalide = refus.** Clé ou condition inconnue, regex invalide, action inconnue, id
manquant ou en double, YAML illisible : toute écriture et toute commande sont refusées avec la
liste des erreurs, jusqu'à ce que le fichier soit corrigé. Une politique cassée qui laisserait tout
passer serait pire qu'une politique absente.

Le chargement est mis en cache par date de modification des fichiers : une modification
s'applique au prochain appel d'outil, sans relancer la tâche.

## Une règle

```yaml
version: 1
rules:
  - id: no-migration-direct
    description: Never modify migration files directly
    action: deny            # allow | warn | deny | require_approval
    message: Use the migration tool of the project instead
    when:
      path_glob: "**/migrations/**"
```

Toutes les conditions de `when` doivent tenir (ET). Les chemins sont **relatifs au dépôt** avant
d'être comparés : le SDK Claude envoie des chemins absolus, et une règle `path_prefix: src/`
ne correspondait jamais.

| Condition | Tient quand |
|---|---|
| `tool` | l'outil est l'un de ceux-là (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`) |
| `path_prefix`, `path_regex`, `path_glob` | le chemin relatif commence par / correspond à (`**` traverse les dossiers, `*` non) |
| `branch` | la branche courante correspond à ce glob (`main`, `release/*`) |
| `content_regex`, `forbidden_strings` | le contenu écrit correspond / contient l'une des chaînes |
| `content_max_lines`, `content_max_bytes` | le contenu écrit dépasse la limite |
| `new_file_max_lines` | un fichier **nouveau** dépasse la limite (un fichier existant n'est pas visé) |
| `adds_regex` | une ligne **ajoutée** par rapport au fichier actuel correspond (`cursor.execute`) |
| `deletes_tests: true` | l'écriture fait disparaître une fonction de test, ou une commande `rm` / `git rm` vise un fichier de test |
| `adds_dependency: true` | l'écriture ajoute une dépendance à un manifeste |
| `command_pattern` | la commande Bash correspond |

Une règle de contenu (`content_*`, `adds_regex`, `deletes_tests` sur le texte…) ne correspond
jamais à une commande Bash : elle ne voit pas ce que la commande écrira. Une règle sans aucune
condition s'applique à tout et donne un avertissement.

### Conditions sémantiques, toutes stacks

`security/guardrail_semantics.py` compare l'avant et l'après de l'écriture (`CallContext.contents`
reconstruit le fichier après `Edit` / `MultiEdit`).

- **Tests supprimés** : définitions de tests reconnues en Python (pytest, unittest), JS/TS
  (`it`/`test`/`describe`), C# (`[Fact]`, `[Theory]`, `[Test]`, `[TestMethod]`…), Java/Kotlin
  (`@Test`), Go (`func TestX`), Rust (`#[test]`), PHP (PHPUnit), Ruby (RSpec, minitest),
  Dart/Flutter, Swift (XCTest, Swift Testing), Elixir (ExUnit).
- **Dépendance ajoutée** : `package.json`, `composer.json`, `requirements*.txt`, `pyproject.toml`,
  `Cargo.toml`, `go.mod`, `*.csproj` / `Directory.Packages.props` / `packages.config`, `pom.xml`,
  `build.gradle(.kts)`, `Gemfile`, `pubspec.yaml`, `Package.swift`, `mix.exs`. Seuls les **noms**
  nouveaux comptent : changer une version n'est pas ajouter une dépendance.

## Les actions

| Action | Effet |
|---|---|
| `allow` | rien (sert à documenter une exception) |
| `warn` | l'appel passe ; l'événement est journalisé |
| `deny` | l'appel est refusé avec le message de la règle ; journalisé |
| `require_approval` | l'appel est refusé et une demande attend la personne dans Réglages → Garde-fous |

Une **approbation** (« Approuver une fois ») vaut pour **un seul** appel identique (même outil,
même cible) dans les 24 h. La cible d'une commande est son empreinte sha256 ; le journal n'en garde
qu'un résumé expurgé des secrets. L'agent, qui a reçu le refus, retente l'appel après l'accord.

Le journal (`guardrail-log.jsonl`, borné à 5 000 lignes) et les approbations
(`guardrail-approvals.json`) vivent dans le `.workpilot/` du projet principal. Comme les fichiers
de politique, ils font partie des fichiers qu'un agent ne peut pas modifier
(`security/path_guard.py`, `PROTECTED_CONFIG_NAMES`) : un agent ne s'approuve pas lui-même.

## L'écran

Réglages → Garde-fous édite la couche projet (champs et cases à cocher pour chaque condition,
message à l'agent) et montre :

- les couches lues, leurs erreurs et avertissements ;
- les demandes d'approbation en attente ;
- l'activité : règles qui ont agi, derniers événements, et un avertissement quand plus de 20
  appels sont bloqués en 10 minutes (une règle qui bloque autant arrête les agents au lieu de les
  guider) ;
- un **essai à blanc** : les changements du dépôt par rapport à une ref (`HEAD` par défaut,
  fichiers non suivis compris) passés à la politique, un fichier supprimé étant jugé comme un
  `rm`.

Le testeur, la validation, l'essai à blanc, l'activité et les réponses passent tous par un seul
exécutable Python (`runners/guardrails_runner.py validate | test | check-diff | activity |
answer`) : l'interface juge avec le moteur des agents, pas avec une copie TypeScript qui avait
divergé. Le main revalide `projectPath`, l'id de la demande et la ref avant de lancer le runner.

## Hors périmètre

Les vérifications sur l'AST complet (« toujours passer par l'ORM ») restent des `adds_regex` :
un motif sur les lignes ajoutées couvre le cas courant sans un analyseur par langage. Les
approbateurs nommés (`approvers: [tech-lead]`) attendent les rôles du mode serveur.

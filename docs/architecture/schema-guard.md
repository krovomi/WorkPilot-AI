# Garde des migrations (zéro interruption, #386)

Pendant un déploiement, l'ancien code tourne encore sur le nouveau schéma, et l'inverse pendant un
retour arrière. Une migration qui renomme une colonne, la supprime, ajoute une colonne NOT NULL
sans défaut ou construit un index en bloquant les écritures casse la production pendant ce temps.
Un agent l'écrit sans le voir : le test passe sur une base vide. La garde lit les migrations de la
tâche et dit ce qu'une base en service ne supporterait pas, avec la façon zéro-downtime de le
faire dans l'outil du projet.

Code : `apps/backend/schema_guard/` (feuille, n'importe que `foundation`), porte QA
`apps/backend/qa/schema_gate.py`, porte dure `migration-safe` dans `workflows/hard_gates.py`,
routes de la carte `apps/backend/qa/schema_guard_api.py`, carte
`components/task-detail/SchemaGuardCard.tsx` (onglet Qualité).

## Sans modèle, sans base

Tout est statique et déterministe : des règles sur le texte des migrations, aucun appel de modèle,
aucune connexion à une base. Le résultat est le même sur tous les providers, hors ligne compris, et
aucune chaîne de connexion n'est lue (S1) : le moteur vient des manifestes. Les estimations de
durée sur le volume réel (`pg_stat_user_tables`) et le dry-run `EXPLAIN` de l'issue demandent une
base ; ils ne sont pas faits.

## Ce qui est lu

Seuls les fichiers de la tâche (`ChangeScope.files`, depuis la merge base), reconnus comme
migrations par leur chemin, puis par un marqueur quand le chemin est partagé :

| Outil | Fichiers |
|---|---|
| EF Core | `Migrations/*.cs` qui héritent de `Migration` (ni `*.Designer.cs` ni `*ModelSnapshot.cs`) |
| Django | `*/migrations/NNNN_*.py` |
| Alembic | `versions/*.py` avec `def upgrade(` |
| Rails | `db/migrate/*.rb` |
| Laravel | `database/migrations/*.php` |
| Doctrine | `migrations/Version*.php` avec `addSql(` |
| Knex, Sequelize, TypeORM | `migrations/*.{js,ts,mjs,cjs}`, selon `knex`, `queryInterface` ou `queryRunner` |
| Ecto | `priv/repo/migrations/*.exs` |
| SQL | Prisma `migration.sql`, Drizzle, Flyway `V…__*.sql`, golang-migrate `*.up.sql`, Diesel `up.sql`, Supabase, tout `.sql` sous `migrations/` |

Les fichiers de retour arrière (`*.down.sql`, `down.sql`, Flyway `U…__`) ne sont pas lus. Dans un
fichier qui a les deux parties, seule la partie `up` (`Up`, `upgrade`, `up`, `change`) est lue :
le `DROP` d'un `down` est le retour d'un `CREATE`. Le SQL qu'une migration d'ORM exécute
(`migrationBuilder.Sql`, `RunSQL`, `op.execute`, `execute`, `DB::statement`, `knex.raw`,
`queryRunner.query`, `addSql`…) est lu avec les règles SQL.

Le fichier doit être dans le projet, pas un lien symbolique, et faire au plus 512 Ko ; 50
migrations au plus par passe.

**Moteur.** Lu dans les `*.csproj` (fournisseur EF), `schema.prisma`, `drizzle.config.*`,
`package.json`, `pyproject.toml`, `requirements*.txt`, `settings.py`, `config/database.yml`,
`composer.json`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle*`, `mix.exs`, Supabase. SQLite à
côté d'un autre moteur est la base locale ou de test et s'efface ; deux autres moteurs donnent
`unknown`. Jamais `.env` ni `appsettings*.json`, qui portent des secrets.

## Ce qui est signalé

| Genre | Sévérité | Quand |
|---|---|---|
| `data_loss` | erreur | table ou colonne supprimée, `TRUNCATE` |
| `rename` | erreur | table ou colonne renommée (`RENAME`, `sp_rename`, `CHANGE COLUMN`, `RenameColumn`, `rename_column`…) |
| `not_null` | erreur | colonne NOT NULL sans défaut ajoutée à une table existante |
| `edited` | erreur | migration qui existait à la base de la tâche modifiée ou supprimée : elle a peut-être déjà tourné |
| `type_change` | avertissement | type ou définition de colonne changé (`AlterField`, `change_column`, `->change()`…) |
| `not_null` | avertissement | `SET NOT NULL` sur une colonne existante (scan complet sous verrou sur PostgreSQL) |
| `lock` | avertissement | PostgreSQL seulement : index sans `CONCURRENTLY`, clé étrangère ou check validés d'un coup (sans `NOT VALID`) |
| `no_rollback` | avertissement | outil à `down` sans `down` ou avec un `down` vide ; `RunPython` / `RunSQL` sans inverse |

Une table créée par la même migration n'a ni `lock` ni `not_null` : elle est vide. `change` de
Rails et d'Ecto est réversible et n'a pas besoin de `down`.

Chaque constat porte le conseil de l'outil (`AddIndexConcurrently` avec `atomic = False` pour
Django, `algorithm: :concurrently` et `disable_ddl_transaction!` pour Rails,
`postgresql_concurrently=True` dans `autocommit_block()` pour Alembic,
`suppressTransaction: true` pour EF Core…) et, dès qu'une erreur l'exige, le plan
**expand → migrate → switch → contract** : ajouter la nouvelle structure à côté de l'ancienne,
remplir par lots, basculer le code, supprimer l'ancienne dans une migration suivante. Le planner a
la même consigne (`prompts/planner.md`, « For Database Schema Changes »).

## Quand il bloque

La porte tourne après l'approbation du reviewer, avec les autres portes, et écrit toujours
`schema_guard.json`. `WORKPILOT_QA_SCHEMA_GUARD` :

- `warn` (défaut) : jamais bloquant ; constats affichés, journalisés, montrés sur la carte. Une
  équipe qui migre en fenêtre de maintenance n'est pas renvoyée au fixer pour rien.
- `strict` : une erreur rejette la passe ; le fixer reçoit `QA_FIX_REQUEST.md` avec les constats,
  les instructions citées comme données (`quote_untrusted`, S2) et le plan.
- `off` : ne tourne pas ; le record le dit, la porte dure lit « inconnu ».

Un workflow qui déclare la porte dure `migration-safe` passe en `strict` (sauf `off`). Aucun
workflow par défaut ne la déclare. Une valeur inconnue vaut `warn` : une faute de frappe ne fait ni
bloquer ni éteindre.

**Porte dure `migration-safe`** : tenue quand aucun constat n'est une erreur (aucune migration
compris) ; échouée sur une erreur ; inconnue quand la garde n'a pas tourné, a été éteinte ou que
le change set est inconnu.

## La carte

Onglet Qualité de la tâche, affichée seulement quand la tâche a des migrations : statut, moteur,
constats (erreurs d'abord) avec l'instruction et le conseil traduit, plan si une erreur l'exige.
« Revérifier » relit les migrations de la tâche maintenant (`POST /api/schema-guard/check`, dans le
worktree de la tâche contre sa merge base). Fichiers et git seulement : pas d'agent. Fonction du
bureau (`LOCAL_ONLY_FEATURES`, domaine `qa`).

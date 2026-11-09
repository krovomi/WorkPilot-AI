---
section: ✨ Nouveautés
---

- **Garde des migrations : ce que les migrations d'une tâche font à une base en production** (F189). Après la QA, WorkPilot lit les migrations écrites par la tâche, sur toutes les stacks (EF Core, Django, Alembic, Rails, Laravel, Doctrine, Knex, Sequelize, TypeORM, Ecto, et le SQL de Prisma, Drizzle, Flyway, golang-migrate, Diesel, Supabase), sans modèle ni base. Perte de données, renommage, colonne NOT NULL sans défaut et migration déjà appliquée modifiée sont des erreurs ; index sans `CONCURRENTLY`, contrainte sans `NOT VALID` sur PostgreSQL, changement de type et `down` manquant sont des avertissements, chacun avec la recette de l'outil et le plan expand → migrate → switch → contract. Carte dans l'onglet Qualité de la tâche, avec « Revérifier ». Non bloquant par défaut ; `WORKPILOT_QA_SCHEMA_GUARD=strict` ou la porte dure `migration-safe` renvoient une erreur au fixer (#386).

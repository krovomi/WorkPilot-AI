# Essai à blanc : répétition du plan (`simulation`)

Avant qu'un build ne dépense le moindre token, la page « Essai à blanc » rejoue le plan d'une spec
(`implementation_plan.json`) sur les fichiers de la branche de base. Le parcours est algorithmique :
gratuit, hors ligne, identique quel que soit le provider du vrai build, et il ne dépend pas de la
stack (.NET, Java, Go, Rust, Python, Node, PHP, Ruby, Flutter, Swift…). Rien n'est écrit sur disque.

```
apps/backend/simulation/
  snapshot.py       fichiers suivis du ref (git ls-tree), chemins du plan normalisés ou refusés
  toolchains.py     fichier de projet requis par une commande de vérification (toutes stacks), scripts npm
  api_mocks.py      réponses mockées d'après le contrat OpenAPI du dépôt, déterministes
  plan_rehearsal.py le parcours sous-tâche par sous-tâche et ses constats (code + params)
  engine.py         le SimulationResult (mode "plan") de la page
apps/backend/runners/sandbox_runner.py   --spec-dir / --base-ref / --timeout ; sans spec : diff non commité
apps/frontend/src/main/ipc-handlers/sandbox-handlers.ts   arguments revalidés (buildSandboxArgs)
apps/frontend/src/renderer/components/sandbox/            onglets « Répétition du plan » / « Changements non commités »
```

## Pourquoi un instantané du ref, et pas un worktree

Le vrai build part d'un worktree créé depuis la branche de base : les changements non commités de
l'utilisateur n'en font pas partie. La répétition lit le même arbre avec `git ls-tree` (et
`git show ref:chemin` pour un `package.json` ou un contrat) au lieu d'extraire un second worktree :
rien à nettoyer quand l'utilisateur annule, et un dépôt de plusieurs gigaoctets est lu en une
seconde. Un fichier non commité que le plan modifie est donc signalé comme absent, ce qu'il sera
pour le build.

## Ce que le parcours vérifie

Les phases sont prises dans l'ordre de leurs dépendances (`depends_on`), les sous-tâches dans
l'ordre écrit. Chaque fichier créé est ajouté à l'instantané pour la suite.

| Niveau | Constats |
|---|---|
| Erreur | plan vide ou illisible, dépendance de phase inconnue, cycle, chemin hors du projet (`..`, absolu), fichier modifié qui n'existe pas, fichier modifié avant la sous-tâche qui le crée |
| Attention | fichier créé par une phase dont on ne dépend pas (casse en parallèle), fichier existant recréé, fichier créé deux fois, fichier modèle (`patterns_from`) absent, même fichier dans deux sous-tâches d'une phase `parallel_safe`, commande de vérification sans son fichier de projet (`dotnet` sans `.csproj`/`.sln`, `cargo` sans `Cargo.toml`, `npm run x` sans script `x`…), statut ou route d'API absent du contrat |
| Note | fichier binaire (pas d'aperçu), sous-tâche sans fichier ni vérification, projet sans contrat d'API |

Chaque constat porte un `code` et des `params` : l'app les traduit (`sandbox:findings.*`), le texte
anglais du backend sert de repli et aux journaux.

## Mocks d'API

Une vérification `type: api` (`GET /api/orders/42 → 200`) est confrontée aux contrats OpenAPI du
dépôt : la route doit exister (un préfixe `/api`, `/v1` laissé à `servers` est accepté), le statut
attendu doit être déclaré, et le corps mocké est construit depuis le schéma (`$ref` locaux,
`allOf`/`oneOf`, `example`, `enum`, formats). Le résultat est `schema_based`, toujours le même pour le
même contrat. Une route qu'aucun contrat ne décrit reçoit un mock vide (`static`) et un constat,
jamais un corps inventé ; si la sous-tâche modifie le contrat elle-même, le constat n'est qu'une note.

## Ce qui n'y est pas (encore)

L'issue #373 décrit aussi une exécution de l'agent lui-même dans un worktree jetable, avec un modèle
léger et des appels réseau répondus par un LLM. Cette répétition en est la première marche, sans
coût : elle attrape les plans incohérents avant même que l'agent ne démarre. L'exécution par l'agent
demandera une copie de la spec (le build met à jour `implementation_plan.json`) et l'isolation
réseau du bac à sable de l'OS, qui ne couvre pas encore Windows.

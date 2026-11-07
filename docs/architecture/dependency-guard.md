# Garde des dépendances (paquets inventés, *slopsquatting*)

Un agent qui écrit du code invente des noms de paquets. L'étude *We Have a Package for You!*
(Spracklen et al., USENIX Security 2025, arXiv 2406.10279) en mesure au moins 5,2 % pour les
modèles commerciaux et 21,7 % pour les modèles ouverts. Ces inventions se répètent d'une requête
à l'autre, et un attaquant qui publie un paquet sous l'un de ces noms fait installer son code par
l'agent suivant. La garde bloque avant le merge un paquet ajouté par la tâche que son registre
public ne connaît pas.

Code : `apps/backend/dependency_guard/` (feuille, n'importe que `foundation`), porte QA
`apps/backend/qa/dependency_gate.py`, porte dure `deps-exist` dans `workflows/hard_gates.py`.

## Ce qui est lu

Seuls les manifestes que la tâche a changés (`ChangeScope.files`, depuis la merge base) sont lus,
dans le worktree et à la base (`git show <base>:<chemin>`). Seuls les paquets **ajoutés** sont
contrôlés, pas tout l'arbre.

| Écosystème | Fichiers | Registre interrogé |
|---|---|---|
| npm | `package.json` | `registry.npmjs.org` |
| PyPI | `requirements*.txt`, `pyproject.toml` (PEP 621, groupes, Poetry) | `pypi.org/pypi/<nom>/json` |
| NuGet | `*.csproj`, `*.fsproj`, `*.vbproj`, `Directory.Packages.props`, `packages.config` | `api.nuget.org/v3-flatcontainer` |
| Maven | `pom.xml`, `build.gradle(.kts)` | `repo1.maven.org` (`maven-metadata.xml`) |
| Cargo | `Cargo.toml` | `crates.io` |
| Go | `go.mod` | `proxy.golang.org` (`/@v/list`) |
| Packagist | `composer.json` | `repo.packagist.org/p2` |
| pub | `pubspec.yaml` | `pub.dev` |
| RubyGems | `Gemfile` | `rubygems.org` |

Ce qu'un registre ne peut pas confirmer est ignoré, pas signalé : chemin local, URL git, lien de
workspace, alias `npm:` (suivi vers son vrai nom), `replace` de Go, `tool.uv.sources`, exigence de
plateforme (`php`, `ext-*`), SDK Flutter, dossiers `node_modules`, `vendor`, `bin`, `obj`. Le XML
passe par `defusedxml`.

## Les verdicts

| Cas | Verdict |
|---|---|
| le registre public répond 404 ou 410, aucune autre source, pas installé | **bloqué** |
| 404, mais le projet ou l'utilisateur déclare une autre source pour cet écosystème | inconnu |
| 404, mais le paquet est déjà sur le disque (`node_modules`, cache NuGet) | inconnu |
| le registre ne répond pas (délai, 5xx, 429, proxy), ou nom sans adresse | inconnu |
| mode hors-ligne strict (`airgapStrict`, règle S7) : aucun appel | inconnu |
| plus de 40 paquets ajoutés : le reste n'est pas interrogé | inconnu |
| trouvé, à une frappe d'un paquet populaire, document de registre court | avertissement |
| trouvé, publié il y a moins de 30 jours | avertissement |
| trouvé | ok |

**Une seule chose bloque**, parce qu'un faux positif bloquerait une build saine. Les sources
privées lues (noms d'hôtes seulement, jamais un identifiant) : `.npmrc`, `.yarnrc.yml`,
`pip.conf`/`pip.ini`, `uv.toml`, `[tool.uv.index]`, `[[tool.poetry.source]]`, `NuGet.Config`,
`settings.xml` et les `<repositories>` du `pom.xml`, `maven {}` de Gradle, `.cargo/config.toml`,
les `repositories` de `composer.json`, les `source` du `Gemfile`, et les variables `PIP_*`, `UV_*`,
`NPM_CONFIG_REGISTRY`, `GOPRIVATE`, `GONOPROXY`, `GOPROXY` (autre que le proxy public),
`PUB_HOSTED_URL`, `COMPOSER_REPOSITORIES`.

Le test de faute de frappe compare à une courte liste de paquets très installés par registre
(`typos.py`, distance d'une frappe). Il n'avertit pas quand le document du registre dépasse
512 Kio : c'est un long historique de versions (`preact` n'est pas une faute de `react`).

## Dans la boucle QA

La porte tourne après l'approbation du reviewer, avant l'architecture et la couverture
(`qa/loop.py`). À chaque passe elle écrit `<spec>/dependency_guard.json`. Un paquet bloqué :

- écrit `QA_FIX_REQUEST.md`, qui nomme le paquet (nom échappé s'il contient autre chose qu'un nom),
  propose le paquet populaire voisin s'il y en a un, et interdit de publier le paquet ou de pointer
  le projet vers un autre registre pour passer ;
- remet `qa_signoff.status` à `rejected`, pour qu'une reprise ne lise pas l'approbation périmée ;
- renvoie le fixer comme toute autre porte. Un rejet récurrent remonte à la personne.

Les inconnus et les avertissements sont écrits dans le journal de la tâche, jamais bloquants.
`WORKPILOT_DEPENDENCY_GUARD=0` coupe la porte ; le relevé le dit, et `deps-exist` lit « inconnu ».

## La porte dure `deps-exist`

Déclarée sur la phase `verify` de `feature-build`, `bug-fix`, `hotfix` et `refactoring`. Elle lit
le relevé : `blocked` ne tient pas, `pass` tient (« aucune nouvelle dépendance » ou « N paquets
trouvés »), tout le reste (pas de relevé, inconnus, manifeste illisible, garde coupée) est inconnu,
signalé sans bloquer et jamais compté comme une preuve.

## Plus tard

Contrôler `npm install <x>` ou `pip install <x>` au moment où l'agent les lance, par un validateur
de commande (`security/validator_registry.py`). C'est un appel réseau sur un chemin chaud : à
faire en deuxième étape.

# Installation et configuration

Installer l'application ou lancer WorkPilot AI depuis les sources, configurer les providers,
vérifier l'installation, et les pièges connus (Windows surtout). Le démarrage rapide est dans le
[README](../README.md#quick-start).

## Prérequis Système

### Configuration Matérielle Minimale
- **OS** : Windows 10+, macOS 10.15+, Ubuntu 20.04+
- **RAM** : 8GB minimum (16GB recommandé)
- **Stockage** : 2GB d'espace libre
- **Réseau** : Connexion internet stable

### Dépendances Logicielles
- **Node.js 22.12+** (`engines` dans `package.json` ; la CI construit sur Node 22, et Vitest 5 refuse les versions plus anciennes)
- **pnpm** (le dépôt est épinglé sur pnpm 12.16.1 via `packageManager` ; si Corepack échoue : `npm i -g pnpm@12.16.1`)
- **Python 3.12+** (Pour le backend)
- **Git** (Dépôt initialisé obligatoire)
- **Claude Code CLI**, pour le provider Claude : `curl -fsSL https://claude.ai/install.sh | bash` (macOS, Linux, WSL) ou `irm https://claude.ai/install.ps1 | iex` (PowerShell). La barre latérale **Outils CLI** de l'app l'installe aussi en un clic, comme Codex, Copilot, Gemini CLI, OpenCode ou pi

## Méthodes d'Installation

### Option 1 : Application Bureau (Recommandé)

1. **Téléchargement**
   - Prenez le fichier de votre plateforme dans le tableau [Download](../README.md#download) en haut de
     cette page (tenu à jour à chaque release), ou sur [GitHub Releases](https://github.com/krovomi/WorkPilot-AI/releases)

2. **Installation**
   - **Windows** : exécutez `WorkPilot-AI-<version>-win32-x64.exe`
   - **macOS** : ouvrez `WorkPilot-AI-<version>-darwin-arm64.dmg` (Apple Silicon) ou `-darwin-x64.dmg` (Intel)
   - **Linux** : lancez `WorkPilot-AI-<version>-linux-x86_64.AppImage` (ou le `.deb` / `.flatpak`)

3. **Premier Lancement**
   - Lancez l'application
   - Suivez l'assistant de configuration
   - Connectez votre provider AI

### Option 2 : Développement depuis Source

1. **Clonage du Dépôt**
   ```bash
   git clone https://github.com/krovomi/WorkPilot-AI.git
   cd WorkPilot-AI
   ```

2. **Installation Automatique**
   ```bash
   pnpm install
   pnpm run dev
   ```
   *Crée automatiquement l'environnement virtuel Python et installe toutes les dépendances*

   Ou, sans rien installer sur la machine : ouvrez le dépôt dans le conteneur de
   [`.devcontainer/`](../.devcontainer/) (VS Code « Reopen in Container », ou Codespaces). Il porte
   Python 3.13, uv, Node 22, pnpm et de quoi lancer Electron sous xvfb pour les tests E2E.

3. **Lancement Manuel — Guide Pas à Pas par OS**

   Si l'installation automatique échoue (dépendances Python manquantes, environnement corrompu, etc.), suivez ces étapes détaillées.

   **Prérequis communs**
   - Node.js 22.12+ et pnpm disponibles dans le PATH
   - Python 3.12+ installé depuis [python.org](https://www.python.org/downloads/) — sur Windows, évitez le Python du Microsoft Store, il cause fréquemment des soucis de PATH et de permissions
   - Git installé

   **Windows (PowerShell)**
   ```powershell
   cd WorkPilot-AI

   # Backend : créer et activer l'environnement virtuel
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt

   # Le backend a un SECOND venv indépendant sous apps/backend — voir
   # "Notes Spécifiques Windows" ci-dessous, il a besoin du même traitement pywin32
   cd apps\backend
   python -m venv .venv
   .venv\Scripts\python.exe -m pip install -r requirements.lock
   cd ..\..

   # Frontend
   cd apps\frontend
   pnpm install
   cd ..\..

   pnpm run dev
   ```
   > ⚠️ Sur Windows, plusieurs pièges classiques attendent ici (pywin32 sur les DEUX venvs, élévation UAC, Smart App Control qui bloque les binaires natifs npm). Lisez **[Notes Spécifiques Windows](#notes-spécifiques-windows)** juste après cette section avant de lancer `pnpm run dev` pour la première fois — ça évite la majorité des galères de premier lancement.

   **macOS / Linux (bash/zsh)**
   ```bash
   cd WorkPilot-AI

   # Backend : créer et activer l'environnement virtuel
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt

   # Le second venv, celui des agents (apps/backend/.venv), depuis le lock
   pnpm run install:backend

   # Frontend
   cd apps/frontend
   pnpm install
   cd ../..

   pnpm run dev
   ```

   > Versions Python : `requirements.txt` donne des plages ; `apps/backend/requirements.lock` fige
   > les versions exactes (avec empreintes, toutes plateformes) que la CI teste et que l'image
   > serveur embarque. `pnpm run install:backend` installe le lock ; à la main :
   > `pip install -r apps/backend/requirements.lock`. Après avoir modifié une plage :
   > `pnpm run lock:python`.

4. **Vérifier que le backend répond**
   ```bash
   curl http://127.0.0.1:9000/health
   ```
   *`pnpm run dev` sert l'API locale (`provider_api.py`) sur le port 9000 avec le venv racine (`.venv`) ; les
   agents lancés par l'app utilisent `apps/backend/.venv`.*

## Notes Spécifiques Windows

Le setup Windows a davantage de pièges que macOS/Linux, tous rencontrés et résolus en conditions réelles. Parcourez cette liste **avant** votre premier `pnpm run dev` si vous êtes sur Windows.

### 1. `pywin32` doit être installé sur **DEUX** environnements virtuels distincts

Le projet a deux venvs Python indépendants : celui à la **racine** du dépôt (`.venv`, utilisé par le serveur FastAPI principal) et celui sous **`apps/backend/.venv`** (utilisé par les commandes CLI/QA internes lancées par Electron). `pip install -r requirements.txt` n'installe pas automatiquement l'un depuis l'autre — répétez l'installation dans les deux :

```powershell
# Venv racine
.\.venv\Scripts\python.exe -m pip install --upgrade "pywin32>=312"
.\.venv\Scripts\python.exe .\.venv\Scripts\pywin32_postinstall.py -install
.\.venv\Scripts\python.exe -c "import pywintypes; print('OK')"

# Venv du backend
cd apps\backend
.venv\Scripts\python.exe -m pip install --upgrade "pywin32>=312"
.venv\Scripts\python.exe .venv\Scripts\pywin32_postinstall.py -install
.venv\Scripts\python.exe -c "import pywintypes; print('OK')"
cd ..\..
```

Les deux dernières commandes doivent chacune afficher `OK`. Si `import pywintypes` échoue encore après le postinstall (les DLL sont copiées mais le module reste introuvable — signe que le fichier `.pth` de pywin32 n'a pas été traité par l'interpréteur), n'insistez pas à patcher symptôme par symptôme : **supprimez et recréez ce venv à neuf**, c'est ce qui résout le problème de façon fiable :

```powershell
Remove-Item -Recurse -Force .venv
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m pip install --upgrade "pywin32>=312"
.venv\Scripts\python.exe .venv\Scripts\pywin32_postinstall.py -install
.venv\Scripts\python.exe -c "import pywintypes; print('OK')"
```

Si le problème persiste même après une recréation complète du venv, c'est le signe d'une installation Python **de base** corrompue (pas seulement le venv) — voir **Dépannage Courant → Problèmes Python / venv**.

### 2. `pnpm run dev` ouvre une seconde console élevée (UAC)

C'est voulu : voir `apps/frontend/scripts/dev-elevated.cjs`. WorkPilot AI relance tout le stack Electron en administrateur sur Windows, nécessaire pour une fonctionnalité de capture visuelle admin-only. Si vous n'avez pas besoin de cette fonctionnalité — ou si cette console élevée échoue à écrire `apps/frontend/.env-files/.env` (`PermissionError`) — désactivez l'élévation :

```powershell
$env:WORKPILOT_NO_ELEVATE = "1"
pnpm run dev
```

Si vous avez déjà lancé l'app une fois **avec** élévation avant de désactiver, le fichier `apps/frontend/.env-files/.env` peut rester marqué par le process administrateur qui l'a créé (visible via `Get-Acl` : propriétaire `BUILTIN\Administrateurs`) et bloquer toute écriture ultérieure par un process non-admin, même avec des permissions NTFS qui semblent correctes. Supprimez-le pour qu'il soit régénéré proprement :

```powershell
Remove-Item "apps\frontend\.env-files\.env" -Force
```

L'app **packagée** (installeur, portable) démarre sans élévation (`asInvoker`) : les agents, terminaux
et processus qu'elle lance n'ont que vos droits. Pour qu'une preuve visuelle pilote une application
desktop elle-même élevée, lancez WorkPilot AI par clic droit → **Exécuter en tant qu'administrateur** ;
sans cela, la capture d'écran reste possible et l'app indique que le pilotage demande cette élévation.
Une version précédente demandait l'élévation à chaque lancement : si des réglages ne s'enregistrent plus
après la mise à jour, un fichier créé par le processus administrateur est en cause, comme ci-dessus.

### 3. Smart App Control / Application Control bloque les binaires natifs npm

Si `pnpm run dev` plante sur `electron-vite dev` avec une erreur du type `Error: An Application Control policy has blocked this file` (souvent sur un fichier `.node` dans `node_modules`, par exemple un binding natif de `rolldown` ou un autre paquet compilé), c'est **Smart App Control** (Windows 11) ou une politique **WDAC** qui bloque le chargement d'un binaire natif fraîchement installé et non reconnu.

Vérifiez l'état :
```powershell
Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy" -Name "VerifiedAndReputablePolicyState" -ErrorAction SilentlyContinue
```
`1` = activé (bloque). Sur un **PC personnel**, désactivez-le via *Sécurité Windows → Contrôle des applications et du navigateur → Paramètres du Contrôle des applications intelligent → Désactivé*, puis **redémarrez** (le changement n'est pas pris en compte à chaud).

> ⚠️ Cette désactivation est définitive sans réinstallation complète de Windows — c'est une limitation volontaire de Microsoft.

Sur un **PC d'entreprise** (politique WDAC imposée), il faudra faire autoriser les binaires natifs Node par votre IT plutôt que de désactiver quoi que ce soit vous-même.

### 4. PowerShell ≠ cmd.exe

Les commandes `cmd.exe` classiques (`rmdir /s /q`, `rd`, …) n'existent pas nativement en PowerShell et provoquent des erreurs `ParameterBindingException` confuses. Utilisez les équivalents PowerShell :

| cmd.exe | PowerShell |
|---------|------------|
| `rmdir /s /q .venv` | `Remove-Item -Recurse -Force .venv` |
| `del fichier` | `Remove-Item fichier` |
| `copy a b` | `Copy-Item a b` |

### 5. Une installation Python de base corrompue casse tout silencieusement

Si vous rencontrez `ModuleNotFoundError: No module named 'pip'`, un avertissement `Ignoring invalid distribution ~ip`, ou si `import pywintypes` échoue systématiquement même après un postinstall qui semble réussi (DLL copiées, mais import introuvable), votre installation Python de base (pas le venv) est corrompue — généralement un reliquat de mise à jour `pip` interrompue. Les symptômes se propagent à **tous** les venvs créés à partir de cette installation. Solution : désinstallez complètement Python, réinstallez-le proprement depuis [python.org](https://www.python.org/downloads/) (cochez "Add python.exe to PATH", évitez la version Microsoft Store), puis recréez tous les venvs du projet (racine **et** `apps/backend`).

## Configuration des Providers AI

### Authentification Claude (Recommandé)
```bash
claude
# Tapez : /login
# Appuyez sur Entrée pour ouvrir le navigateur
```
*Le token est automatiquement sauvegardé dans le Keychain OS*

### Configuration Multi-Providers
L'app écrit ces variables depuis **Réglages → Comptes** dans l'environnement de chaque tâche ; les
poser à la main ne sert qu'à la CLI et aux exécutions sans interface.

| Provider | Méthode | Configuration |
|----------|---------|---------------|
| **Anthropic Claude** | OAuth (abonnement) ou profil d'API | `CLAUDE_CODE_OAUTH_TOKEN` (ou le trousseau) ; profil d'API : `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`. `ANTHROPIC_API_KEY` n'est volontairement **pas** lu par ce provider |
| **OpenAI** | Clé d'API ou CLI Codex | `OPENAI_API_KEY` ; `OPENAI_AUTH_MODE=codex-cli` pour passer par Codex |
| **Google Gemini** | Clé d'API | `GOOGLE_API_KEY` ; `GEMINI_API_KEY` pour Gemini CLI (ACP) |
| **Grok / xAI** | Clé d'API | `GROK_API_KEY` (`GROK_BASE_URL`) |
| **Mistral**, **DeepSeek** | Clé d'API | `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY` (`*_BASE_URL`) |
| **Ollama**, **LM Studio**, **llama.cpp** | Endpoint local | `OLLAMA_BASE_URL`, `LMSTUDIO_BASE_URL`, `LLAMA_CPP_BASE_URL` |
| **GitHub Copilot** | Connexion GitHub | Via l'interface |
| **Windsurf** | Clé d'API | `WINDSURF_API_KEY`, sinon la clé de l'IDE Windsurf installé |

Liste complète, valeurs par défaut et ordre de lecture : [docs/CONFIGURATION.md](CONFIGURATION.md).

### Variables d'Environnement Optionnelles
```bash
# .env-files/.env, à la racine du dépôt (lu par l'app au démarrage et par run.py)
AUTO_BUILD_MODEL=claude-opus-5   # CLI : modèle de toutes les phases, sauf réglage par phase de la tâche
DEBUG=true
LINEAR_API_KEY=votre_clé_linear
BRAIN_ENABLED=false              # coupe la mémoire partagée (active par défaut)
```

## Configuration du Projet

### Structure de Projet Requise
Seul un dépôt Git initialisé est obligatoire. La stack se lit dans les fichiers que le projet a déjà :
```
votre-projet/
├── .git/                          # Obligatoire : dépôt Git initialisé
├── *.sln, *.csproj, global.json   # .NET (ASP.NET Core, Blazor, MAUI, WPF…)
├── pom.xml, build.gradle(.kts)    # Java, Kotlin
├── go.mod · Cargo.toml            # Go · Rust
├── package.json                   # Node.js, TypeScript (Angular, React, Vue, Next.js, Nuxt…)
├── pyproject.toml, requirements.txt
├── composer.json · Gemfile        # PHP · Ruby
├── pubspec.yaml · Package.swift   # Flutter / Dart · Swift
└── ...                            # Vos fichiers de code
```

### Détection Automatique de Stack
WorkPilot AI détecte (`apps/backend/project/`) :
- **Langages** : C#, Java, Kotlin, Scala, Go, Rust, C, C++, Python, TypeScript, JavaScript, PHP, Ruby,
  Dart, Swift, Elixir
- **Frameworks** : Angular, React, Vue, Svelte, Next.js, Nuxt, Astro, NestJS, Express, Fastify,
  Electron, React Native, Expo ; Django, FastAPI, Flask ; Laravel, Symfony ; Rails ; Flutter ;
  pour .NET, la version cible et le framework de test (xUnit, NUnit, MSTest)
- **Gestionnaires de paquets** : npm, pnpm, yarn, bun, pip, uv, Poetry, PDM, Pipenv, Cargo, Go
  modules, Maven, Gradle, Composer, Bundler, pub
- **Tests** : `dotnet test`, pytest, Jest, Vitest, Mocha, Playwright, Cypress, PHPUnit, RSpec…

Les commandes que l'agent peut lancer suivent ce qui est détecté : l'allowlist s'agrandit avec la stack.

## Validation de l'Installation

### Tests de Connexion
```bash
# Tests du frontend (vitest)
pnpm test

# Tests du backend (pytest, venv apps/backend/.venv)
pnpm run test:backend

# Porte locale complète : lint, pytest ciblé sur le diff, typecheck, vitest
pnpm verify

# Parcours E2E dans l'app construite (Linux sans écran : xvfb-run -a)
cd apps/frontend && pnpm run build && pnpm run test:e2e
```

### Vérification de l'Environnement
```bash
# Version Node.js
node --version  # >= v22.12

# Version Python
python --version  # 3.12+

# Configuration Claude
claude --version
```

## Hooks Git

Les hooks sont volontairement **rapides**. La CI (`ci.yml`, `lint.yml`) rejoue la suite complète sur Linux, Windows et macOS à chaque pull request et à chaque push sur `main`/`develop` : la redoubler en local coûte plusieurs minutes à chaque commit sans rien garantir de plus.

| Étage | Ce qui tourne | Budget |
|-------|---------------|--------|
| `pre-commit` | ruff + biome **sur les fichiers stagés uniquement**, scan des secrets (bloquant), puis les tests liés à ces fichiers | quelques secondes |
| `pre-push` | ruff check, ruff format --check, skills générés (`skills_cli build --check`), cartes d'audit et fragments de changelog, plafonds des `except` aveugles, des `biome-ignore` et de taille de fichier, biome lint | < 30 s |
| CI | pytest (Python 3.12 en shards, 3.13 après merge), typecheck, vitest, build et démarrage de l'app — sur 3 OS ; parcours E2E Playwright, image serveur et mode serveur sous Linux | — |

Le typecheck est **incrémental** (`incremental` + `tsBuildInfoFile` dans `apps/frontend/tsconfig.json`) : la première passe reste longue, les suivantes tombent à quelques secondes.

### Jouer la suite complète en local

```bash
PRE_PUSH_FULL=1 git push        # ajoute pytest (ciblé sur le diff), typecheck et vitest au pre-push
pnpm verify                     # la même chose, sans pousser
pnpm run test:all               # le pre-push rapide seul (lint et contrôles rapides), sans pousser
pnpm run test:backend           # toute la suite pytest
```

### Contourner (dépannage)

| Besoin | Commande |
|--------|----------|
| Sauter tous les hooks d'un commit | `git commit --no-verify` |
| Sauter le pre-push | `git push --no-verify` |
| Garder le lint, sauter les tests au commit | `PRE_COMMIT_SKIP_TESTS=1 git commit …` |
| Laisser plus de temps à un check lent | `PRE_PUSH_TIMEOUT_MS=900000 git push` (15 min) |
| Refuser le push si un check expire | `PRE_PUSH_STRICT=1 git push` |

Chaque job du pre-push a un **timeout** (5 min par défaut) : un check qui part en vrille est tué au lieu de bloquer le push indéfiniment, et un point d'avancement s'affiche toutes les 20 s. Un timeout avertit sans bloquer — la CI reste le garde-fou.

> ⚠️ **Gardez ruff aligné sur la CI** (`ruff==0.15.7`, voir `.github/workflows/lint.yml`). Une version plus récente reformate le code Python contenu dans les blocs ```` ```python ```` des fichiers `.md`, ce qui produit des dizaines de fichiers modifiés sans rapport avec votre travail :
> ```bash
> pip install "ruff==0.15.7"
> ```

## Dépannage Courant

### Problèmes d'Installation
- **Node.js non trouvé** : Réinstallez depuis https://nodejs.org avec "Add to PATH"
- **Modules natifs** : `pnpm run rebuild` dans `apps/frontend`
- **Python manquant** : Installez Python 3.12+ et ajoutez au PATH

### Problèmes Python / venv (Backend)

> Sur Windows, la plupart des soucis Python (pywin32, venv, installation de base corrompue, syntaxe PowerShell) sont couverts en détail dans **[Notes Spécifiques Windows](#notes-spécifiques-windows)**. Résumé rapide :
> - `pywin32` "non installé" malgré une installation réussie → réinstallez-le en ciblant explicitement le python **du venv**, sur les **deux** venvs du projet (racine et `apps/backend`)
> - `import pywintypes` échoue encore après le postinstall → supprimez et recréez le venv à neuf plutôt que de patcher
> - `ModuleNotFoundError: No module named 'pip'` / `Ignoring invalid distribution ~ip` → installation Python de base corrompue, réinstallez Python entièrement
> - `Remove-Item : Impossible de trouver un paramètre positionnel...` → vous utilisez une syntaxe `cmd.exe` (`rmdir /s /q`) en PowerShell ; utilisez `Remove-Item -Recurse -Force .venv`

- **`PermissionError: [Errno 13]` en écriture sur `apps/frontend/.env-files/.env`, alors que la lecture fonctionne et que les permissions NTFS semblent correctes**
  Le fichier a probablement été créé par un run précédent avec élévation UAC (propriétaire `BUILTIN\Administrateurs` visible via `Get-Acl`) et porte une étiquette d'intégrité qui bloque l'écriture par un process non-admin, invisible dans l'ACL classique. Le plus simple est de le supprimer pour qu'il se régénère proprement :
  ```powershell
  Remove-Item "apps\frontend\.env-files\.env" -Force
  ```
  Voir aussi **Notes Spécifiques Windows → point 2** pour désactiver l'élévation UAC elle-même (`WORKPILOT_NO_ELEVATE=1`).

- **`Error: An Application Control policy has blocked this file` sur un `.node` dans `node_modules` pendant `electron-vite dev`**
  Smart App Control (Windows 11) ou une politique WDAC bloque le chargement d'un binaire natif npm non reconnu. Voir **Notes Spécifiques Windows → point 3** pour vérifier l'état et désactiver (PC personnel) ou faire autoriser le fichier par votre IT (PC d'entreprise).

### Problèmes d'Authentification
- **Token Claude expiré** : `claude` puis `/login`
- **API Key invalide** : Vérifiez les variables d'environnement
- **Problèmes OAuth** : Révoquez et réautorisez l'application

### Problèmes de Performance
- **Mémoire insuffisante** : Fermez les applications inutiles
- **Timeout réseau** : Vérifiez votre connexion internet
- **Lenteur UI** : Redémarrez l'application

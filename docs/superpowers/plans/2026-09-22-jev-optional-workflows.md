# Optional JEV Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter JEV au build et aux revues GitHub, GitLab et Azure DevOps, avec activation par workflow et fonctionnement complet sans compte, clé ou API disponible.

**Architecture:** Un service Python produit des décisions typées ou un bypass explicite. Un runtime par exécution isole réglages, credentials, budget et observations ; les orchestrateurs transmettent ses conseils aux agents existants. Electron conserve la clé chiffrée par l'OS et la transmet uniquement aux processus Python concernés.

**Tech Stack:** Python, asyncio, httpx déjà présent, pytest ; Electron, React, TypeScript, Zustand, react-i18next, Vitest.

**Spec:** [Spécification approuvée](../specs/2026-09-22-jev-optional-workflows-design.md).

## Global Constraints

- Valeurs initiales : `enabled: false`, `workflows: {}`, `model: "jev-latest"`, `minimumConfidence: 0.8`, `timeoutSeconds: 5` ; zéro relance automatique.
- Endpoint fixe `https://api.typesafe.ai/v1/systemone`, authentification Bearer, aucun suivi de redirection.
- Contexte UTF-8 limité à 64 Kio ; réponse limitée à 256 Kio ; aucune troncature silencieuse des preuves.
- Hors ligne prioritaire ; une clé seule n'active pas JEV.
- Les choix explicites de provider, modèle et effort restent prioritaires. Aucun changement des hard gates, tests obligatoires, gates humaines ou conditions de merge.
- La clé n'apparaît ni dans les settings JSON ordinaires, ni dans Zustand persisté, ni dans localStorage, ni dans les métadonnées d'une tâche.
- Aucun SDK TypeSafe obligatoire, téléchargement à l'exécution ou appel réel pendant les tests.
- Textes visibles via les locales EN/FR de `apps/frontend/src/shared/i18n/locales/`.
- Ruff 0.15.7 et Biome 2.4.10, conformément aux instructions utilisateur et à la spec.
- Arguments et champs nouveaux facultatifs. Les pauses, interruptions et annulations ne deviennent jamais un bypass autorisant la suite.
- En serveur, pas de clé desktop globale utilisée pour un tenant ; bypass `unsupported_context` dans cette livraison.
- Préserver les changements préexistants ; committer des chemins explicites, jamais `git add .`.

## Review Focus

1. Clé supprimée mais présente dans l'environnement hérité : prochain lancement réellement sans clé ; tâche 4.
2. Changement de projet/SHA pendant une requête de statut : résultat ancien ignoré ou identifié comme historique ; tâches 3 et 7.
3. Pause pendant un stream HTTP lent : appel annulé et étape suivante non démarrée ; tâche 2.
4. Plusieurs event loops successives dans le build CLI : runtime réutilisable sans client/lock lié à une ancienne boucle ; tâche 3.
5. Revues GitHub parallèles et de suivi : une évaluation du contenu courant, sans double facturation ni réemploi d'un ancien score ; tâche 6.

## État vérifié et organisation des fichiers

Branche : `codex/jev-optional-workflows`. Commit de spec : `2cd54704`. Le worktree comporte des changements préexistants sur hooks, scripts, vendors, images et `tests/test_recovery.py`, hors périmètre. Git pointe vers un worktree WSL : au besoin utiliser `git -c safe.directory=C:/Users/leber/.codex/worktrees/4afd/WorkPilot-AI`, sans modifier la configuration globale ou `.git`.

`apps/backend/requirements.txt` contient déjà httpx. `apps/frontend/package.json` déclare Biome 2.5.11 contrairement à l'instruction 2.4.10 : vérifier la version utilisée, employer la version imposée pour cette tâche et rapporter toute incompatibilité de configuration ; ne pas modifier le lockfile pour masquer le problème.

Les fichiers Python nouveaux vivent dans `apps/backend/integrations/jev/` : `models.py` (types), `settings.py` (résolution), `client.py` (HTTP), `context.py` (sélection), `rubrics.py` (questions), `service.py` (évaluation), `runtime.py` (exécution), `observations.py` (traces), `build.py` et `reviews.py` (adaptateurs). `__init__.py` expose leur API publique.

Electron ajoute `src/main/jev/{secret-store,service,environment}.ts`, `src/shared/types/jev.ts`, `src/shared/utils/jev-settings.ts`, des IPC dédiés et des composants settings/statut. Tous ces chemins sont sous `apps/frontend/`. La clé ne fait jamais partie d'AppSettings ; seul le réglage non sensible `jev?` y entre.

Ordre : tâches 1–3 pour le contrat backend, 4 pour le desktop, 5–6 pour les consommateurs, 7 pour l'interface, 8 pour la validation intégrée. Les modifications de gros fichiers restent des raccordements ciblés, sans restructuration générale.

---

### Task 1: Réglages et résolution sans réseau

**Files:** créer `apps/backend/integrations/jev/{__init__,models,settings}.py` ; créer `tests/test_jev_settings.py`.

**Interfaces:**
- Consomme `core.offline_policy.airgap_status(*paths)`.
- Produit les types ci-dessous, `JevSettingsError(ValueError)` et `BypassReason = Literal["disabled", "workflow_bypass", "offline", "missing_key", "invalid_config", "missing_context", "context_too_large", "unauthorized", "rate_limited", "timeout", "unavailable", "invalid_response", "low_confidence", "unsupported_context"]`.
- Produit `settings_from_env(env: Mapping[str, str]) -> JevSettings`, `bypass_reason(settings: JevSettings, context: JevContext, *, has_key: bool) -> BypassReason | None` et `consume_api_key(env: MutableMapping[str, str]) -> str | None` dans `settings.py`.

- [ ] **1. Écrire les tests de compatibilité et précédence.**

```python
from integrations.jev.models import JevContext, JevSettings
from integrations.jev.settings import bypass_reason, settings_from_env


def test_key_alone_does_not_enable(tmp_path):
    cfg = settings_from_env({"TYPESAFE_API_KEY": "test-key"})
    assert bypass_reason(cfg, JevContext("feature-build", tmp_path), has_key=True) == "disabled"


def test_only_selected_workflow_is_enabled(tmp_path):
    cfg = JevSettings(workflows={"github-review": "enabled"})
    assert bypass_reason(cfg, JevContext("github-review", tmp_path), has_key=True) is None
    assert bypass_reason(cfg, JevContext("gitlab-review", tmp_path), has_key=True) == "disabled"
```

Ajouter `inherit`, `bypass` sur défaut actif, clé vide/absente, configuration absente, JSON invalide, `"false"`, seuil NaN, booléen numérique, timeout négatif, mode inconnu, politique airgap et contexte serveur. Une configuration fournie mais invalide lève JevSettingsError, traduit en bypass par la tâche 3.

- [ ] **2. Exécuter `python -m pytest tests/test_jev_settings.py -q`.** Échec attendu sur les nouveaux comportements/imports, pas sur un environnement pytest cassé.
- [ ] **3. Implémenter les types et le résolveur.**

```python
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

JevMode = Literal["inherit", "enabled", "bypass"]
JevPoint = Literal["classification", "review"]

@dataclass(frozen=True)
class JevSettings:
    enabled: bool = False
    workflows: dict[str, JevMode] = field(default_factory=dict)
    model: str = "jev-latest"
    minimum_confidence: float = 0.8
    timeout_seconds: float = 5.0

@dataclass(frozen=True)
class JevContext:
    workflow: str
    project_dir: Path
    spec_dir: Path | None = None
    server_mode: bool = False

@dataclass(frozen=True)
class JevQuestion:
    type: Literal["choice", "score", "noul"]
    instructions: str
    criteria: dict[str, str] | tuple[str, ...] | None = None

@dataclass(frozen=True)
class JevAnswer:
    type: Literal["choice", "score", "noul"]
    value: str | float
    confidence: float | None = None
    probabilities: dict[str, float] = field(default_factory=dict)

@dataclass(frozen=True)
class JevOutcome:
    status: Literal["evaluated", "bypassed"]
    reason: BypassReason | None = None
    answers: dict[str, JevAnswer] = field(default_factory=dict)
    model: str | None = None
    usage: dict[str, int] = field(default_factory=dict)
```

Définir BypassReason dans le même module avant JevOutcome. Copier les mappings lors de la résolution. Variables CLI : `WORKPILOT_JEV_ENABLED`, `WORKPILOT_JEV_WORKFLOW_MODES`, `WORKPILOT_JEV_MODEL`, `WORKPILOT_JEV_MINIMUM_CONFIDENCE`, `WORKPILOT_JEV_TIMEOUT_SECONDS`. Accepter uniquement les booléens explicitement reconnus ; nombres finis dans les bornes. Ordre du bypass : airgap, serveur non supporté, mode effectif, clé. Un champ absent prend le défaut ; une valeur incorrecte ne devient pas une activation implicite. `consume_api_key` retire la variable avant tout spawn d'agent et retourne sa valeur non vide.

- [ ] **4. Relancer les tests ; tout doit passer sans réseau.**
- [ ] **5. Commit `feat(jev): add opt-in settings and bypass policy`**, uniquement les fichiers de cette tâche.

### Task 2: HTTP borné, contexte choisi et réponses validées

**Files:** créer `apps/backend/integrations/jev/{client,context,rubrics,service}.py` ; créer `tests/test_jev_client.py`, `tests/test_jev_context.py`, `tests/test_jev_service.py`.

**Interfaces:**
- `JevClient(transport: httpx.AsyncBaseTransport | None = None)` et `async post(*, key: str, payload: dict[str, Any], timeout_seconds: float) -> dict[str, Any]` ; `JevRequestError(reason: BypassReason)` dans `client.py`.
- `async evaluate(settings: JevSettings, context: JevContext, *, point: JevPoint, key: str | None, state: dict[str, Any], questions: dict[str, JevQuestion], client: JevClient) -> JevOutcome` dans `service.py`.
- `select_state(*, request: str, acceptance: str, files: list[str], diff: str = "", validations: str = "", sensitive_values: tuple[str, ...] = ()) -> dict[str, Any]` et `JevContextError(reason: BypassReason)` dans `context.py`.
- `classification_questions()`, `review_questions()` retournent `dict[str, JevQuestion]`. `advice_text(outcome: JevOutcome) -> str`, `classification_hint(outcome: JevOutcome) -> str | None` dans `rubrics.py`.

- [ ] **1. Tester le vrai transport avec httpx.MockTransport.**

```python
import httpx
import pytest
from integrations.jev.client import JevClient

@pytest.mark.asyncio
async def test_endpoint_and_auth():
    def respond(request):
        assert str(request.url) == "https://api.typesafe.ai/v1/systemone"
        assert request.headers["authorization"] == "Bearer test-key"
        return httpx.Response(200, json={"model": "jev-test", "answers": {}, "usage": {}})
    client = JevClient(transport=httpx.MockTransport(respond))
    result = await client.post(key="test-key", payload={"state": "x", "model": "jev-latest", "questions": {}}, timeout_seconds=5)
    assert result["model"] == "jev-test"
```

Paramétrer 401/403 → unauthorized, 429 → rate_limited, 3xx/5xx/réseau → unavailable, délai → timeout, JSON/corps trop gros → invalid_response. Un envoi seulement. Tester Choice/Score/Noul, champs manquants, booléens numériques, NaN/infini, option inconnue, distribution incohérente, confiance faible et réponse partielle. Noul n'exige pas de confiance.

Ajouter un stream factice lent, faire basculer `core.pause_state.is_paused`, vérifier BuildPaused et fermeture du stream. CancelledError doit remonter. Contexte : diff renommant un secret, texte multilingue, taille UTF-8, valeurs sensibles connues, absence de critères.

- [ ] **2. Exécuter `python -m pytest tests/test_jev_client.py tests/test_jev_context.py tests/test_jev_service.py -q` et vérifier les échecs attendus.**
- [ ] **3. Implémenter l'appel streaming et ses bornes.**

```python
async with httpx.AsyncClient(transport=self.transport, follow_redirects=False, trust_env=False) as http:
    async with http.stream("POST", ENDPOINT, headers={"Authorization": f"Bearer {key}"}, json=payload) as response:
        self.check_status(response.status_code)
        body = bytearray()
        async for chunk in response.aiter_bytes():
            body.extend(chunk)
            if len(body) > 256 * 1024:
                raise JevRequestError("invalid_response")
```

Définir ENDPOINT, self.transport et check_status selon la table d'erreurs ci-dessus dans client.py. Encadrer connexion, lecture et parsing par un seul `asyncio.timeout(timeout_seconds)` ; fermer les contextes sur toute sortie. `trust_env=False` s'applique uniquement à JEV. Aucune exception brute ou requête avec headers dans les logs. Valider les réponses contre les questions envoyées, bornes des scores et distributions comprises.

Le service refait la politique avant tout payload. Pendant l'appel, surveiller la pause par une coroutine dormant 0,1 s ; attendre avec FIRST_COMPLETED puis annuler et attendre le perdant dans finally. Lever BuildPaused pour planning ou QA selon le point, ne jamais capturer BaseException. Si la lecture de politique échoue, ne pas ouvrir l'accès distant.

Choice `task_class` reprend les huit valeurs de TaskClass. Scores `coverage` : critères non couverts/partiellement couverts/apparemment couverts ; `risk` : faible/modéré/élevé, avec instructions explicites versionnées. Sans critères, `missing_context`. Le conseil précise qu'un score ne prouve pas la réussite des tests.

select_state ne parcourt pas le disque : il nettoie les contenus fournis et retire les sections de diff .env, .env.*, secrets/credentials et clés privées, y compris renommées. Retirer valeurs sensibles connues et assignations usuelles de credentials. Diff impossible à segmenter sûrement → missing_context. Après sérialisation UTF-8, plus de 64 Kio → context_too_large, sans troncature. Ne pas promettre une détection universelle de secrets.

- [ ] **4. Relancer les tests, notamment chunking, pause et confidentialité.**
- [ ] **5. Commit `feat(jev): evaluate typed decisions with bounded fallback`.**

### Task 3: Runtime isolé et observations durables

**Files:** créer `apps/backend/integrations/jev/runtime.py`, `observations.py` ; modifier `apps/backend/workflows/api.py` ; créer `tests/test_jev_runtime.py`, `tests/test_jev_observations.py` ; compléter `tests/test_workflow_profile_api.py`.

**Interfaces:**
- Consomme les tâches 1–2.
- `JevRun(settings: JevSettings, context: JevContext, *, key: str | None, run_id: str, client: JevClient | None = None, invalid_config: bool = False)` ; clé privée exclue de repr.
- `JevRun.from_env(context: JevContext, *, env: MutableMapping[str, str] | None = None) -> JevRun` consomme la clé et crée un UUID.
- `async JevRun.evaluate(point: JevPoint, *, pass_id: str, revision: str, state: dict[str, Any], questions: dict[str, JevQuestion]) -> JevOutcome`.
- `write_observation(directory: Path, record: dict[str, Any]) -> None`, `read_observations(directory: Path) -> dict[str, Any] | None` dans observations.py.
- JSON local `jev-evaluations.json`, version 1 : `runId`, `workflow`, `evaluations` ; entrée avec `point`, `passId`, `revision`, `status`, `reason`, réponses validées, `model`, `usage`, `createdAt`. Aucun état brut ni secret. Dossier choisi par le code de confiance, jamais par l'API distante.

- [ ] **1. Tester suppression de la clé de l'environnement, suspension des appels et event loops successives.**

```python
import asyncio
from integrations.jev.models import JevContext
from integrations.jev.runtime import JevRun
from integrations.jev.rubrics import classification_questions


def test_two_event_loops_and_private_key(tmp_path):
    env = {"TYPESAFE_API_KEY": "test-key"}
    run = JevRun.from_env(JevContext("feature-build", tmp_path, tmp_path), env=env)
    assert "TYPESAFE_API_KEY" not in env
    for pass_id in ("first", "second"):
        result = asyncio.run(run.evaluate("classification", pass_id=pass_id, revision="r1", state={}, questions=classification_questions()))
        assert result.reason == "disabled"
    assert "test-key" not in repr(run)
```

Tester première 401/429/indisponibilité/timeout puis aucun nouvel appel sur ce run ; nouveau run autorisé à réessayer. Résultat en mémoire réutilisé seulement pour la même clé `(point, pass_id, revision)` ; nouvelle révision → nouvel appel. Un airgap activé entre deux points doit primer même sur le cache.

Tester observation r1 lue pour r2 : historique seulement. Fichier absent, corrompu, surdimensionné, écriture impossible et deux projets ayant le même identifiant de tâche. Le profil API doit rester sans appel JEV ni consommation d'un marqueur de reprise.

- [ ] **2. Exécuter `python -m pytest tests/test_jev_runtime.py tests/test_jev_observations.py tests/test_workflow_profile_api.py -q`.**
- [ ] **3. Implémenter le runtime et la persistance.**

```python
# Structure du choix dans JevRun.evaluate :
reason = bypass_reason(self.settings, self.context, has_key=bool(self._key))
if reason in ("offline", "unsupported_context"):
    outcome = JevOutcome("bypassed", reason)
elif self.invalid_config:
    outcome = JevOutcome("bypassed", "invalid_config")
elif reason:
    outcome = JevOutcome("bypassed", reason)
elif self._suspended_reason:
    outcome = JevOutcome("bypassed", self._suspended_reason)
else:
    cache_key = (point, pass_id, revision)
    outcome = self._cached.get(cache_key)
    if outcome is None:
        outcome = await evaluate(self.settings, self.context, point=point, key=self._key,
                                 state=state, questions=questions, client=self.client)
        self._cached[cache_key] = outcome
```

Initialiser `_suspended_reason`, `_cached` et client au constructeur. La propriété `observation: dict[str, Any]` expose uniquement le dernier enregistrement validé, sans secret. Écrire dans context.spec_dir pour le build ; pour une revue, dans project_dir/.workpilot/jev/workflow/run_id, avec workflow et UUID validés comme segments simples. Les résultats de revue incorporent ensuite cette observation dans leur propre persistance. Toutes les branches convergent ensuite vers un seul bloc d'enregistrement ; ne pas perdre la trace d'un bypass par retour prématuré. Suspendre sur unauthorized/rate_limited/unavailable/timeout. Ne conserver ni lock ni tâche ni connexion async entre appels : JevClient stocke son transport, ouvre et ferme son client par opération. Les orchestrateurs évaluent avant leur fan-out.

Le contexte possède un instantané copié de réglages ; la politique offline est relue à chaque point. Configuration illisible → invalid_config. Serveur → unsupported_context, sans capturer ni consommer la clé globale d'un autre tenant. Un run neuf repart sans résultat ancien.

Écriture UTF-8 atomique : fichier temporaire unique dans le même dossier puis os.replace. Historique borné à 50 entrées ; nouveau run remplace l'instantané précédent. Lecture bornée, validation de schéma, aucune exception brute exposée. Échec de trace non bloquant. Ajouter au profil API un champ `jev` facultatif contenant seulement l'observation et `airgapStrict` résolu ; disponibilité de clé et réglages actuels viendront du main Electron, pas du vieux process API.

- [ ] **4. Relancer les tests ; vérifier la non-régression des effets de bord de l'API.**
- [ ] **5. Commit `feat(jev): isolate runs and persist sanitized observations`.**

### Task 4: Stockage OS, IPC et environnement desktop

**Files, sous `apps/frontend/`:**
- Créer `src/shared/types/jev.ts`, `src/shared/utils/jev-settings.ts` ; modifier `src/shared/types/settings.ts` (`AppSettings.jev?`).
- Créer `src/main/jev/secret-store.ts`, `service.ts`, `environment.ts`.
- Créer `src/main/ipc-handlers/jev-handlers.ts`, `src/preload/api/jev-api.ts`.
- Modifier `src/shared/constants/ipc.ts`, `ipc-namespaces.ts`, `src/main/ipc-handlers/index.ts`, `src/preload/api/index.ts`.
- Modifier `src/main/ipc-handlers/settings-handlers.ts` : validation de `jev` avant sauvegarde.
- Modifier `src/main/agent/agent-process.ts`, `src/main/ipc-handlers/github/utils/runner-env.ts`, `github/pr-handlers.ts`, `gitlab/mr-review-handlers.ts`, `azure-devops-handlers.ts`.
- Créer `src/main/jev/secret-store.test.ts`, `environment.test.ts`, `src/main/ipc-handlers/__tests__/jev-handlers.test.ts`.
- Compléter `src/main/agent/agent-process.test.ts`, `src/main/ipc-handlers/github/utils/__tests__/runner-env.test.ts`, `src/main/ipc-handlers/gitlab/__tests__/mr-review-handlers.test.ts`.

**Interfaces:**

```ts
export type JevMode = "inherit" | "enabled" | "bypass";
export interface JevSettings {
  enabled: boolean;
  workflows: Record<string, JevMode>;
  model: string;
  minimumConfidence: number;
  timeoutSeconds: number;
}
export interface JevCredentialStatus {
  configured: boolean;
  secureStorageAvailable: boolean;
}
```

- `normalizeJevSettings(value: unknown): JevSettings` : absent → défaut, présent invalide → erreur. Une lecture ancienne invalide désactive cette intégration seulement.
- `JevSecretStore(filePath, crypto)` : `getStatus(): JevCredentialStatus`, `read(): string | undefined`, `save(key: string): void`, `clear(): void`. Adapter crypto : isEncryptionAvailable/encryptString/decryptString/getSelectedStorageBackend facultatif.
- `getJevService(): JevSecretStore` résout son propre fichier sous `app.getPath("userData")`.
- `buildJevEnvironment(base: NodeJS.ProcessEnv, workflow?: string): Record<string, string>` lit les réglages actuels, nettoie les anciennes variables JEV, déchiffre uniquement pour un workflow activé.
- Preload : `getJevCredentialStatus()`, `saveJevApiKey(key: string)`, `clearJevApiKey()`, chacun retourne `Promise<IPCResult<JevCredentialStatus>>`. Aucun IPC de lecture de clé.
- Étendre `getRunnerEnv(extraEnv?, options?: {page?: PageLlmPage; jevWorkflow?: string})`, sans casser les appelants existants.

- [ ] **1. Tester chiffrement, suppression et contrôle des environnements.**

```ts
it("removes an inherited key after deletion", () => {
  vi.spyOn(getJevService(), "read").mockReturnValue(undefined);
  const env = buildJevEnvironment({ TYPESAFE_API_KEY: "stale-key", PATH: "test-path" }, "feature-build");
  expect(env.TYPESAFE_API_KEY).toBeUndefined();
  expect(env.PATH).toBe("test-path");
});
```

Le test simule readSettingsFile avec enabled=true et les autres valeurs par défaut. Ajouter encryption indisponible/basic_text, ciphertext illisible, remplacement, suppression idempotente, valeur vide refusée et absence de clé dans les réponses IPC. Faux crypto déterministe uniquement en test. Vérifier que les erreurs ne contiennent jamais la valeur saisie.

- [ ] **2. Depuis apps/frontend, exécuter `pnpm exec vitest run src/main/jev/secret-store.test.ts src/main/jev/environment.test.ts src/main/ipc-handlers/__tests__/jev-handlers.test.ts --maxWorkers=2` ; constater l'échec initial.**
- [ ] **3. Implémenter le magasin, IPC et l'injection ciblée.**

```ts
// Après copie de base avec ses valeurs undefined retirées :
for (const name of Object.keys(result)) {
  if (name === "TYPESAFE_API_KEY" || name.startsWith("WORKPILOT_JEV_")) delete result[name];
}
result.WORKPILOT_JEV_ENABLED = settings.enabled ? "1" : "0";
result.WORKPILOT_JEV_WORKFLOW_MODES = JSON.stringify(settings.workflows);
result.WORKPILOT_JEV_MODEL = settings.model;
result.WORKPILOT_JEV_MINIMUM_CONFIDENCE = String(settings.minimumConfidence);
result.WORKPILOT_JEV_TIMEOUT_SECONDS = String(settings.timeoutSeconds);
const mode = workflow ? settings.workflows[workflow] ?? "inherit" : "bypass";
if (workflow && (mode === "enabled" || (mode === "inherit" && settings.enabled))) {
  const key = getJevService().read();
  if (key) result.TYPESAFE_API_KEY = key;
}
```

Le helper ne modifie jamais process.env. Le magasin refuse basic_text, écrit atomiquement et permet de supprimer le ciphertext même si le chiffrement n'est plus disponible. Les échecs de lecture retournent undefined ; les échecs de sauvegarde sont visibles via codes IPC stables traduits dans l'UI. Aucun secret en settings JSON.

Appliquer le helper **après** tous les spreads d'env au spawn build/planning/QA. Ne pas l'ajouter à getCombinedEnv, utilisé plus largement. Les autres opérations reçoivent un environnement nettoyé sans clé. GitHub/GitLab : passer jevWorkflow aussi sur les suivis ; Azure : appliquer le helper dans AZURE_DEVOPS_PR_REVIEW, dont l'env est aujourd'hui construit directement. Le serveur permanent de profil n'a pas besoin de clé.

Le runtime Python consomme la clé avant la création d'un agent, pour qu'elle ne soit pas héritée par les outils. Une reprise dans le même processus conserve son runtime ; un nouveau processus obtient la clé courante depuis le main. Ne pas la remettre dans os.environ.

- [ ] **4. Tester les options réellement passées à spawn : aucun secret dans argv ou les autres workflows, aucun changement des credentials habituels. Relancer les tests des handlers concernés.**
- [ ] **5. Commit `feat(jev): securely configure desktop workflow credentials`.**

### Task 5: Raccorder build, planning, routage et QA

**Files:**
- Créer `apps/backend/integrations/jev/build.py`.
- Modifier `apps/backend/cli/build_commands.py` : handle_build_command, _handle_build_interrupt et _phase_context.
- Modifier `apps/backend/agents/coder.py` : run_autonomous_agent et prompt planner ; `apps/backend/agents/planner.py` : planification de suivi ; `apps/backend/agents/feature_wiring.py` : apply_router_override.
- Modifier `apps/backend/qa/loop.py`, `apps/backend/qa/reviewer.py`, `apps/backend/workflows/runner.py`.
- Vérifier `apps/backend/agents/utils.py` : modifier uniquement si la synchronisation actuelle filtre le nouveau JSON.
- Créer `tests/test_jev_build.py`, `tests/test_jev_build_routing.py`.
- Régressions : `tests/test_workflow_runner.py`, `tests/test_workflow_engine.py`, `tests/test_workflow_hard_gates.py`, `tests/test_pause_state.py`, `apps/backend/agents/test_feature_wiring.py`.

**Interfaces:**
- Consomme JevRun, rubriques, contexte choisi, advice_text et classification_hint.
- `async classify_build(run: JevRun, *, spec_dir: Path, pass_id: str) -> JevOutcome` et `async assess_build_review(run: JevRun, *, spec_dir: Path, project_dir: Path, pass_id: str) -> JevOutcome` dans build.py.
- Argument facultatif `jev_run: JevRun | None = None` aux frontières run_autonomous_agent, planification de suivi et run_qa_validation_loop ; dernier champ facultatif identique dans PhaseContext.
- `jev_advice: str = ""` facultatif dans run_qa_agent_session.
- `task_hint: str | None = None` dans apply_router_override. L'appel interne à suggest_routed_model utilise `task_hint=task_hint or phase`. suggest_routed_model accepte déjà task_hint et ModelRouter.route accepte hint ; aucun réseau dans classify_task.

- [ ] **1. Écrire les tests aux frontières réelles.**

```python
from integrations.jev.models import JevAnswer, JevOutcome
from integrations.jev.rubrics import classification_hint


def test_only_valid_choice_becomes_router_hint():
    outcome = JevOutcome("evaluated", answers={"task_class": JevAnswer("choice", "architecture", 0.95)})
    assert classification_hint(outcome) == "architecture"
    assert classification_hint(JevOutcome("bypassed", "missing_key")) is None
```

Paramétrer moteur activé/désactivé, planning neuf/reprise, absence/validité/échec JEV et modèle explicite/automatique. Simuler HTTP et agents mais appeler les vraies frontières d'orchestration. Dans le test de routeur, définir un modèle explicite dans task_metadata.json et activer WORKPILOT_MODEL_ROUTER_ENABLED : le hint JEV ne doit pas remplacer le modèle.

Capturer le prompt : bypass = prompt habituel, succès = conseil supplémentaire. QA refusée doit rester refusée malgré score favorable. Aucun changement des tests-pass et gates humaines. Une pause pendant JEV interdit la suite du planner/coder.

- [ ] **2. Exécuter `python -m pytest tests/test_jev_build.py tests/test_jev_build_routing.py -q`, constater les raccordements absents.**
- [ ] **3. Transmettre le runtime et ajouter le conseil aux frontières prévues.**

```python
# Avant routage/création du client lors d'un planning effectif :
classification = await classify_build(jev_run, spec_dir=spec_dir, pass_id="planning")
hint = classification_hint(classification)
new_model, info = apply_router_override(
    model, spec_dir=spec_dir, phase="coding", task_hint=hint,
    prompt_hint=f"coder run on spec {spec_dir.name}",
)
```

Créer le runtime après résolution du projet/spec et avant le premier client agent, puis le transmettre aux fenêtres de build, QA et reprises. Entrée directe sans runtime : en créer un à cette frontière publique. Nom du workflow = profil.workflow si disponible, sinon feature-build. La clé est capturée une seule fois et n'est pas relue depuis os.environ après consommation.

La classification prend spec.md et les critères disponibles, sans rescanner le dépôt. Révision = hash SHA-256 du contexte sélectionné. Appeler au premier planning effectif, pas à chaque sous-tâche. Une reprise coding ne déclenche pas un planning supplémentaire. Pour le suivi, utiliser la nouvelle demande. Sur bypass conserver les anciens arguments du routeur, y compris prompt_hint/task_hint, pour préserver le comportement local. Le conseil est ajouté uniquement au prompt planner ; modèle/provider/effort explicites conservent leur priorité.

Avant revue/QA, construire le diff contre la base réellement utilisée par le build et joindre les critères et résultats de validation. Identifier le passage par phase + itération QA. Après correction, recalculer la révision et l'évaluation. Les phases de revue du moteur passent par le même helper ; le parcours historique reste raccordé quand WORKPILOT_WORKFLOW_ENGINE=0.

Ne pas lire les observations persistées comme autorité pour le prompt d'une nouvelle révision. Synchroniser le fichier de résultat vers le spec source via le mécanisme existant. Réémettre BuildPaused/BuildHalted avant toute capture best effort susceptible de les avaler ; ne pas entourer ces appels du large except du routeur actuel.

- [ ] **4. Relancer les tests de tâche et les cinq suites de régression listées.**
- [ ] **5. Commit `feat(jev): advise build planning and QA with safe fallback`.**

### Task 6: Revues externes et suivis

**Files:**
- Créer `apps/backend/integrations/jev/reviews.py`.
- Modifier `apps/backend/runners/github/orchestrator.py`, `models.py` ; sous `services/` : `pr_review_engine.py`, `parallel_orchestrator_reviewer.py`, `followup_reviewer.py`, `parallel_followup_reviewer.py`.
- Modifier `apps/backend/runners/gitlab/orchestrator.py`, `models.py`, `services/mr_review_engine.py`.
- Modifier `apps/backend/runners/azure_devops/orchestrator.py`, `models.py`, `services/pr_review_engine.py`.
- Créer `tests/test_jev_reviews.py` ; régression `tests/test_github_pr_review.py` et tests GitLab locaux concernés.

**Interfaces:**
- `ReviewInput` dans reviews.py : dataclass avec `request: str`, `acceptance: str`, `files: list[str]`, `diff: str`, `validations: str`, `revision: str`, `pass_id: str`.
- `async assess_review(run: JevRun, review: ReviewInput) -> JevOutcome`.
- Ajouter `jev_outcome: JevOutcome | None = None` à PRReviewEngine.run_multi_pass_review, run_review_pass, ParallelOrchestratorReviewer.review, FollowupReviewer.review_followup, ParallelFollowupReviewer.review, MRReviewEngine.run_review et azure_devops.PRReviewEngine.run_review. Calculer advice_text(jev_outcome) localement et transmettre le texte aux constructeurs privés de prompts concernés. None signifie non préparé ; un outcome bypassed signifie préparé sans conseil et interdit une réévaluation en aval.
- Ajouter `jev: dict[str, Any] | None = None` aux résultats persistés et à leur to_dict/from_dict, rétrocompatible. Ce champ est rempli depuis l'observation par l'orchestrateur, jamais depuis le JSON généré par le LLM.

- [ ] **1. Écrire les tests de chaque stratégie et des serializers.**

```python
import pytest
from integrations.jev.models import JevOutcome
from integrations.jev.rubrics import advice_text

@pytest.mark.parametrize("reason", ["missing_key", "timeout", "unauthorized", "offline"])
def test_bypass_has_no_fake_review_advice(reason):
    assert advice_text(JevOutcome("bypassed", reason)) == ""
```

Créer des fixtures d'orchestrateurs avec collecte de contexte et clients LLM simulés, garder leurs méthodes publiques réelles. Capturer les prompts pour GitHub multipass/parallèle/suivi/suivi parallèle, GitLab initial/suivi et Azure. Vérifier un appel par changement relu, conseil commun aux passes, verdict toujours contrôlé par les mécanismes existants. Les méthodes de publication sont des mocks qui lèvent si appelées.

Cas : ancienne revue r1 puis HEAD r2, aucun changement, absence de critères, même numéro de PR sur deux projets, suivi de commentaires sans diff neuf. Les courts-circuits sans nouveau contenu restent sans évaluation facturée ; l'ancien résultat est étiqueté historique.

- [ ] **2. Exécuter `python -m pytest tests/test_jev_reviews.py -q` et constater les chemins non raccordés.**
- [ ] **3. Évaluer après collecte du contexte et avant fan-out.**

```python
outcome = await assess_review(jev_run, review_input)
advice = advice_text(outcome)
findings, structural_issues, ai_triages, quick_scan_summary = (
    await self.pr_review_engine.run_multi_pass_review(pr_context, jev_outcome=outcome)
)
```

GitHub : appel avant le choix multipass/parallèle ; followup_review_pr est un autre chemin qui doit créer son run. Transmettre le conseil immuable aux reviewers, jamais `self.current_advice` partagé entre PR concurrentes. GitLab : head_sha puis current_commit_sha pour les suivis ; Azure : head_sha. Si SHA absent, hash du contexte sélectionné, pas un identifiant constant unknown.

Le propriétaire du processus de revue capture une fois la clé avec consume_api_key avant le premier client agent, dans un champ privé non sérialisable ; chaque nouvelle revue crée ensuite un JevRun neuf avec cette clé détenue explicitement. Ne pas appeler from_env à répétition après consommation dans un worker qui traite plusieurs revues. Aucun singleton global multi-tenant. Tester deux revues consécutives dans le même worker : deux runId, pas de disparition artificielle de clé et aucune suspension héritée du premier run. Le runtime est créé avant le premier client agent de la revue, pas après le fan-out. Un moteur appelé directement hors orchestrateur peut prendre un runtime facultatif à sa frontière publique, mais ne doit pas réévaluer si jev_outcome est fourni, y compris pour un bypass. Le même mode par workflow gouverne initial et suivi.

Les critères viennent de la demande ou description ; sans donnée suffisante, missing_context. Filtrer les contenus secrets avant TypeSafe même s'ils sont visibles au reviewer habituel. Les scores ne publient rien et ne définissent pas le verdict. Persister localement le résultat avec sa révision/runId ; ne pas ajouter ces métadonnées automatiquement aux commentaires distants.

- [ ] **4. Relancer les tests de tâche et régressions des prompts/serializers concernés.**
- [ ] **5. Commit `feat(jev): advise pull request reviews across integrations`.**

### Task 7: Réglages et statuts FR/EN

**Files, sous `apps/frontend/`:**
- Créer `src/renderer/components/settings/JevSettings.tsx`, `src/renderer/components/jev/JevStatus.tsx`, `src/renderer/stores/jev-store.ts`.
- Modifier `src/renderer/components/settings/AppSettings.tsx`, `settings-search.ts`, `settings-landing.ts` sous le même dossier.
- Modifier `src/renderer/components/task-detail/WorkflowProfileCard.tsx`, `src/renderer/lib/agent-tools-api.ts`, `src/renderer/stores/workflow-profile-store.ts`.
- Modifier `src/shared/types/jev.ts`, `src/shared/types/integrations.ts` ainsi que `src/preload/api/modules/github-api.ts` et `src/main/ipc-handlers/github/pr-handlers.ts`, qui déclarent tous deux PRReviewResult. Vérifier la réexportation via `src/renderer/components/github-prs/hooks/useGitHubPRs.ts`.
- Modifier `src/renderer/components/github-prs/components/PRDetail.tsx`, `src/renderer/components/gitlab-merge-requests/components/MRDetail.tsx`.
- Ajouter les clés dans `src/shared/i18n/locales/en/settings.json`, `fr/settings.json`, `en/workflowProfile.json`, `fr/workflowProfile.json`.
- Créer `src/renderer/components/settings/__tests__/JevSettings.test.tsx`, `src/renderer/components/jev/JevStatus.test.tsx`, `src/renderer/stores/__tests__/jev-store.test.ts`, `src/renderer/components/task-detail/WorkflowProfileCard.test.tsx`.
- Compléter `src/renderer/stores/__tests__/workflow-profile-store.test.ts`.

**Interfaces:**
- Consomme AppSettings.jev, les IPC de tâche 4, saveSettings du store existant et les observations backend.
- useJevStore non persisté : credentialStatus, loading, errorCode, generation ; `refresh(): Promise<void>`, `replaceKey(key: string): Promise<boolean>`, `clearKey(): Promise<boolean>`. Aucune propriété contenant la clé.
- `JevStatus({observed, currentRevision, configuredMode, eligibility})` : observed facultatif (observation version 1 de tâche 3), currentRevision facultatif (absent → historique non confirmé), configuredMode: JevMode, eligibility: `"ready" | "unknown" | BypassReason`. Définir BypassReason TypeScript dans shared/types/jev.ts et tester sa correspondance avec la liste backend.
- `WorkflowProfilePayload.jev?` contient observation et airgapStrict ; disponibilité courante = réglages main + statut IPC de clé + politique du projet, jamais environnement ancien du serveur de profil.
- `workflowProfileKey(args: LoadWorkflowProfileArgs): string` dans le store existant ; clé composite projet/spec + taskId. `clear(key: string)` et sélection byTask utilisent la même fonction.

- [ ] **1. Écrire les tests avec les vraies ressources i18next EN/FR.**

```tsx
it("keeps credentials out of settings", async () => {
  const user = userEvent.setup();
  render(<JevSettings />);
  await user.type(screen.getByLabelText("Clé API TypeSafe"), "test-key");
  await user.click(screen.getByRole("button", { name: "Enregistrer la clé" }));
  await waitFor(() => expect(window.electronAPI.saveJevApiKey).toHaveBeenCalledWith("test-key"));
  expect(JSON.stringify(useSettingsStore.getState().settings)).not.toContain("test-key");
  expect(screen.getByLabelText("Clé API TypeSafe")).toHaveValue("");
});
```

Fixture : langue française, IPC success=true et configured=true. Ajouter anglais et parité des clés imbriquées ; ne pas simuler t() par un renvoi de clé. Tester erreur de sauvegarde, chiffrement indisponible, trois modes, défaut inactif + workflow actif, valeurs invalides, rendu sans réseau TypeSafe et lancement sans clé.

Concurrence du store : même taskId sur deux projets, réponse tardive de A après navigation B, sauvegarde des réglages pendant chargement, nouvelle révision. Une réponse périmée ne remplace pas l'état courant. Attendre l'IPC réussi avant d'annoncer un réglage actif.

- [ ] **2. Depuis apps/frontend exécuter :**

```powershell
pnpm exec vitest run src/renderer/components/settings/__tests__/JevSettings.test.tsx src/renderer/components/jev/JevStatus.test.tsx src/renderer/stores/__tests__/jev-store.test.ts src/renderer/stores/__tests__/workflow-profile-store.test.ts src/renderer/components/task-detail/WorkflowProfileCard.test.tsx --maxWorkers=2
```

- [ ] **3. Implémenter UI et invalidation au bon scope.**

```tsx
const [apiKey, setApiKey] = useState("");
const replaceKey = useJevStore((state) => state.replaceKey);
const onSaveKey = async () => {
  if (await replaceKey(apiKey)) setApiKey("");
};
```

Champ password temporaire, effacé après succès et démontage. Réglages non sensibles lus du store existant, brouillon local, puis saveSettings({jev: next}). Clé avec actions séparées de remplacement/suppression ; champ vide ne supprime rien. Rafraîchir après chaque action ; une clé ne déclenche pas une activation automatique.

Présenter valeur globale par défaut, quatre workflows nommés, modes Hériter/Activer/Bypasser, modèle/seuil/délai validés. Les workflows déclaratifs additionnels utilisent leur identifiant validé ; ne pas proposer de faux raccordement Roadmap/Ideation. Expliquer l'envoi des extraits sélectionnés à TypeSafe.

Prêt = prérequis locaux, jamais clé vérifiée. Politique inconnue → unknown. Résultat r1 sur r2 = évaluation précédente, pas validation actuelle. Aucun changement des boutons de lancement ou approbation. Après sauvegarde, incrémenter generation, recharger le profil et ignorer ses requêtes anciennes. PRDetail/MRDetail utilisent JevStatus. Azure conserve ses métadonnées dans son résultat IPC/JSON et un statut local lisible, sans création de nouvelle page entière. Traduire toutes les raisons EN/FR.

- [ ] **4. Relancer les tests et `pnpm run typecheck`, contrôler les ressources réellement chargées.**
- [ ] **5. Commit `feat(jev): expose workflow controls and evaluation status`.**

### Task 8: Validation intégrée et documentation

**Files:** créer `tests/test_jev_workflow_integration.py`, `tests/fixtures/jev_workflow_harness.py`, `apps/frontend/src/__tests__/integration/jev-workflow.test.ts`, `docs/jev.md` ; compléter `shared_docs/CONFIGURATION.md` et le point d'entrée pertinent de `docs/CLAUDE.md`.

**Interfaces:** consomme les contrats précédents. Harness de test : vrais raccordements, transport httpx.MockTransport, agents factices. Aucun flag produit permettant une destination HTTP arbitraire.

- [ ] **1. Tester Electron → environnement Python → orchestration → résultat.**

Vitest appelle buildJevEnvironment avec clé factice, lance le harness Python avec cet environnement et vérifie son JSON d'observation. Le harness utilise les vraies classes JEV et frontières d'orchestration, capture les prompts des faux agents. Interdire réseau externe et publication. Secret en environnement de spawn uniquement, pas argv/fichier en clair.

Définir jev_build_harness comme fixture locale de test_jev_workflow_integration.py : spec/worktree temporaires, handle_build_command réel, dépendances Git/LLM simulées, compteurs observés jev_calls/eligible_points/planner_ran/coder_ran/qa_ran/hard_gates_unchanged. Ne pas coder les compteurs selon l'attendu.

```python
import pytest

@pytest.mark.parametrize("engine_enabled", ["0", "1"])
@pytest.mark.parametrize("mode", ["inherit", "enabled", "bypass"])
@pytest.mark.parametrize("key_present", [False, True])
def test_build_matrix(jev_build_harness, engine_enabled, mode, key_present):
    result = jev_build_harness(engine_enabled=engine_enabled, mode=mode,
                               key_present=key_present, global_enabled=False)
    expected = result.eligible_points if mode == "enabled" and key_present else 0
    assert result.jev_calls == expected
    assert result.planner_ran and result.coder_ran and result.qa_ran
    assert result.hard_gates_unchanged
```

Ajouter les trois orchestrateurs de revue et suivis pertinents. Vérifier absence de TYPESAFE_API_KEY dans les environnements des outils/clients agents. Runtime Python manquant = test non exécuté signalé, jamais réputé passé.

- [ ] **2. Exécuter les tests intégrés et corriger toute liaison manquante.**
- [ ] **3. Documenter précédence, activation, stockage, données transmises et dépannage.**

```text
Défaut inactif + github-review actif : JEV seulement pour les revues GitHub.
Défaut actif + feature-build bypassé : build habituel, JEV éligible ailleurs.
Sans clé ou hors ligne : aucun appel TypeSafe ; workflow disponible.
Erreur API : bypass avec motif local ; nouveau lancement après correction.
```

Documenter les six variables CLI, clé comprise, valeurs factices uniquement. Préciser application au prochain lancement, distinction prêt/évalué, scores consultatifs et surfaces non raccordées. docs/CLAUDE.md explique l'adaptateur TypeSafe autorisé et les fabriques de clients agents conservées ; aucune exception générale pour les autres providers.

- [ ] **4. Validation finale ciblée.** Depuis la racine :

```powershell
python -m pytest tests/test_jev_settings.py tests/test_jev_client.py tests/test_jev_context.py tests/test_jev_service.py tests/test_jev_runtime.py tests/test_jev_observations.py tests/test_jev_build.py tests/test_jev_build_routing.py tests/test_jev_reviews.py tests/test_jev_workflow_integration.py tests/test_workflow_engine.py tests/test_workflow_runner.py tests/test_workflow_hard_gates.py tests/test_workflow_profile_api.py tests/test_pause_state.py -q
python -m ruff --version
```

Depuis apps/frontend :

```powershell
pnpm exec vitest run src/main/jev src/main/ipc-handlers/__tests__/jev-handlers.test.ts src/main/agent/agent-process.test.ts src/main/ipc-handlers/github/utils/__tests__/runner-env.test.ts src/main/ipc-handlers/gitlab/__tests__/mr-review-handlers.test.ts src/renderer/components/settings/__tests__/JevSettings.test.tsx src/renderer/components/jev/JevStatus.test.tsx src/renderer/stores/__tests__/jev-store.test.ts src/renderer/stores/__tests__/workflow-profile-store.test.ts src/renderer/components/task-detail/WorkflowProfileCard.test.tsx src/__tests__/integration/jev-workflow.test.ts --maxWorkers=2
pnpm run typecheck
```

Ruff 0.15.7 check et format --check sur les Python modifiés ; Biome 2.4.10 check sur les TS/TSX/JSON modifiés, chemins explicites et version vérifiée. Aucun formatage global. Vérifier git diff --check, i18n et absence de secrets dans les nouveaux fichiers. Ne pas afficher l'environnement réel.

- [ ] **5. Vérifier manuellement les quatre parcours sans clé puis avec transport simulé ; consigner exactement les checks effectués.** Si Electron/Python manque, déclarer la limite. Sans clé fournie, pas de revendication de validation réelle TypeSafe ; cela ne bloque pas les tests de repli.
- [ ] **6. Commit `test(jev): verify optional workflows and document configuration`.** Revue finale selon méthode choisie et corrections avant de déclarer terminé. Une éventuelle PR cible develop ; la rédaction du plan ne crée aucune PR/publication.

## Couverture de la spécification

| Critères | Tâches |
| --- | --- |
| 1–4 : compatibilité, modes, absence de clé | 1, 3, 4, 7, 8 |
| 5–7 : réponses, validation, confiance, pannes | 2, 3, 5, 6 |
| 8–9 : offline, pause, annulation | 1, 2, 3, 5, 8 |
| 10 : aperçu sans effet de bord | 3, 7 |
| 11 : credentials et mises à jour | 4, 7, 8 |
| 12–13 : vrais appelants, moteur historique, revues, gates | 5, 6, 8 |
| 14 : FR/EN et isolation UI | 7, 8 |

## Choix d'exécution

Recommandation : exécution native dans cette tâche, huit cycles tests/commit puis revue indépendante finale. Contrats de types, runtime et credentials partagés justifient une implémentation séquentielle. Alternative : sous-agent d'implémentation et reviewer par tâche, au prix de davantage de contextes.

Relire le plan et choisir la méthode avant le premier changement de code produit. Aucune case cochée : ce document décrit des travaux à réaliser et ne revendique aucune validation applicative passée.

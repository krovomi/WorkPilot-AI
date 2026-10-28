# Traces OpenTelemetry GenAI pour tous les providers (`genai_trace`)

`AUTO_CLAUDE_OTEL_ENDPOINT` branchait seulement le SDK Claude
(`core.client._add_otel_env`) : le CLI de Claude exportait ses spans, et les
autres providers n'exportaient rien. Un tableau de bord comparait donc des
sessions mesurées à des sessions invisibles. Les cost data comparaient aussi des
sessions comptées à des sessions absentes : un provider qui ne remontait pas son
usage n'y laissait aucune ligne.

`genai_trace` émet les mêmes spans pour chaque client, aux attributs `gen_ai.*`
des conventions GenAI d'OpenTelemetry. Ces conventions ont encore le statut
« Development », mais c'est ce que lisent Langfuse, Phoenix et Jaeger.

```
apps/backend/genai_trace/
  attributes.py   les attributs : noms de provider, usage, jamais de contenu (pur)
  tracer.py       le tracer du processus : allumé par l'endpoint, éteint sinon
  session.py      les spans d'une réponse : agent, appels modèle, outils
apps/backend/core/agent_clients/base.py   __init_subclass__ enveloppe chaque client
apps/backend/harness/application/loop.py  chaque appel mesuré de la boucle WorkPilot
apps/backend/core/client.py               nom de l'agent et de la tâche sur le client
apps/backend/agents/session.py            record_client_usage : réel ou estimé
```

## Les spans

| Span | Quand | Attributs |
|---|---|---|
| `invoke_agent <agent>` | une réponse d'un client, du premier message au dernier | `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.agent.name` (planner, coder, qa_reviewer…), `workpilot.spec_id`, l'usage total |
| `chat <modèle>` | un appel modèle enregistré par le client | l'usage de l'appel, `workpilot.thread` pour un sous-agent |
| `execute_tool <outil>` | d'un bloc tool_use à son tool_result | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `error.type` si l'outil a échoué |

- **Un seul point d'accroche.** `AgentClient.__init_subclass__` enveloppe le
  `query` et le `receive_response` propres à chaque sous-classe. Un nouvel
  adaptateur est tracé sans écrire une ligne. Un adaptateur qui appelle
  `super().receive_response()` n'ouvre pas un deuxième span. Un test vérifie que
  chaque client réel est enveloppé.
- **Les appels modèle** sont ceux que le client mesure déjà pour le registre
  d'usage (`_record_call`, les événements `Measured` de la boucle). Un appel est
  connu quand il finit. Son span commence à l'activité précédente de la
  réponse : son début, l'appel d'avant, ou le dernier résultat d'outil. Dans une
  boucle d'agent, c'est le moment où la requête est partie.
- **Les sous-agents** (délégation) ouvrent leur `invoke_agent` sous celui du
  parent.
- **Une réponse interrompue** par une exception porte `error.type` (le nom de la
  classe, jamais le message). Un lecteur qui s'arrête parce qu'il a ce qu'il lui
  faut n'est pas un échec.

## Ce qui ne va jamais dans un span

Les prompts, les sorties, les arguments et résultats d'outils, et les messages
d'erreur n'y vont jamais : seulement des noms, des nombres et des identifiants.
Un collecteur est un tiers, et un prompt porte le code de la personne. Aucun
réglage ne les y met.

## L'usage : réel, non remonté, estimé

| `workpilot.usage.source` | Sens | Tokens dans le span |
|---|---|---|
| `reported` | le provider a donné des nombres | ceux-là, et seulement ceux-là |
| `unreported` | un appel sans usage | aucun : jamais 0 |
| `estimated` | une réponse dont aucun appel n'a été mesuré | caractères ÷ 4, arrondi au-dessus |

- **Les nombres.** `gen_ai.usage.input_tokens` est le prompt entier, cache
  compris, comme le disent les conventions. Le cache lu et le cache écrit ont
  leurs propres clés. Un nombre que le provider ne donne pas est absent, pas nul.
- **Les cost data.** L'estimation sert aussi hors des traces :
  `record_client_usage` écrit la session dans `.workpilot/cost_data.json` avec
  `"usage_source": "estimated"`, au lieu de ne rien écrire. Toute ligne porte
  maintenant `usage_source`.
- **Le coût d'une ligne estimée** reste 0 : aucun prix n'est inventé. Une
  somme qui contient de telles lignes est un plancher, pas un total.

## Activer

Les spans de WorkPilot sont allumés par la variable que lisait déjà le SDK
Claude, `AUTO_CLAUDE_OTEL_ENDPOINT` ([CONFIGURATION.md](../CONFIGURATION.md)).
Ils partent en OTLP `http/protobuf` vers `<endpoint>/v1/traces`, sous le service
`workpilot`.

- **Une clé.** Pour un collecteur qui en demande une (Langfuse : `Authorization`
  en Basic), elle passe par `OTEL_EXPORTER_OTLP_HEADERS`, lu par l'exporteur
  standard.
- **Un endpoint refusé.** Un endpoint qui n'est pas en http(s), ou qui porte un
  identifiant dans l'URL, éteint les spans avec un avertissement.
- **Éteint par défaut.** Rien n'est importé et rien ne tourne, mais l'estimation
  est quand même calculée pour les cost data.

## Limites connues

- **Claude en SDK brut.** Les sessions du pipeline de spec et des runners qui
  lisent le SDK Claude directement ne passent pas par un `AgentClient`. Elles
  gardent les spans natifs du CLI de Claude (`workpilot-<agent>`), pas ceux-ci.
  Une session Claude passée par `ClaudeAgentClient` a les deux, sous deux
  services.
- **Les CLI tiers** (OpenCode, Antigravity, pi) exécutent leurs outils
  eux-mêmes. La durée d'un `execute_tool` y est celle qui sépare les deux
  événements reçus, pas la durée exacte de la commande.
- **Les vues Analytics et Formula Lab** ne distinguent pas encore les lignes
  estimées à l'écran. Le champ `usage_source` est là pour qu'elles le fassent.

## Vérifier

```
pytest tests/genai_trace -q
```

Pour voir des traces en local, lance un Jaeger (`jaegertracing/all-in-one`,
port 4318), puis démarre une tâche avec
`AUTO_CLAUDE_OTEL_ENDPOINT=http://localhost:4318`.

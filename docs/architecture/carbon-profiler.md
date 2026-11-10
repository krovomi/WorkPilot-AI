# Carbon profiler: footprint, monthly budget, ESG export (#365)

The page **Carbon footprint** shows the estimated energy and CO₂ of the models
a project's agents call, keeps each month under a budget, and writes the
figures in the shape CSRD and GRI reporting asks for.

## Where the figures come from

`core/usage_tracker.record_session_usage` appends one line per agent session
to `.workpilot/carbon-ledger.json`, at the main project's root (a task
worktree feeds its project's ledger). A line holds the provider, the model,
the input tokens (cache reads included), the output tokens, the cache reads,
the task, the phase, the agent and the time. "Rebuild from costs"
(`--backfill`) rebuilds the ledger from every `cost_data.json` of the
project, for builds run before the ledger existed.

The ledger is read by `carbon_profiler/ledger.py`: no link followed, 50 MB
at most, values checked and clipped, lines that are not model calls left out.
Older lines without the new fields still count (no task, no phase).

## The estimate (`carbon_profiler/factors.py`)

No provider publishes the energy of a call, so every figure is an estimate,
and the page, the export and each record say so.

1. **Energy at the servers**: watt-hours per 1,000 output tokens by model size.
   `small` 0.15, `medium` 0.6, `large` 1.5. A fresh input token weighs 10 % of
   an output token, a cache read 2 %. The size comes from the model
   registry's tier (flagship → large, standard → medium, fast → small), then
   from a parameter count in the name (`70b`), then from the name (Haiku,
   mini, Flash… / Opus, GPT-5-class, reasoning models).
2. **Data centre overhead**: × the host's PUE, as its operator publishes it
   (Google Cloud 1.09, Azure 1.18, AWS 1.15…).
3. **Carbon**: × the grid intensity of the host's region (gCO₂e/kWh,
   location-based yearly averages, Ember and IEA). A provider whose host or
   region is not public is marked "guessed" (`hostKnown: false`).
4. **Local models** (Ollama, LM Studio, llama.cpp, vLLM): with a duration,
   power × time (150 W by default, 45 W with `cpu_only`); without one, the
   token rates × 3 for consumer hardware. The grid is the one set for the
   machine.

The rates agree in order of magnitude with the published per-request
figures: Google's 0.24 Wh for a median Gemini text prompt (August 2025) and
Epoch AI's ~0.3 Wh for a typical GPT-4o answer (February 2025). A long
context weighs more, as it does in those studies.

Every factor can be replaced per project in `factors` of
`.workpilot/carbon.json`: `grid.<region>`, `pue.<provider>`,
`region.<provider>` (where a provider's models run) and
`wh_per_1k_output.<size>`.

## Settings (`.workpilot/carbon.json`)

```json
{
  "region": "fr",
  "monthly_budget_kg": 5,
  "alert_percent": 80,
  "degrade": false,
  "local_power_w": 150,
  "cpu_only": false,
  "factors": {}
}
```

The file belongs to WorkPilot (`.workpilot/` is ignored by git). It is read
without following a link, 16 KB at most, and a value out of range falls back
to its default. The page saves it through main: main checks the shape
(`main/carbon/budget-alerts.ts`, `readCarbonConfig`), the runner checks it
again (`config.from_dict`) and writes it atomically.

## The monthly budget (`carbon_profiler/budget.py`)

The budget counts a calendar month in UTC. The month is `ok` under
`alert_percent`, then `warning`, then `exceeded` at 100 %.

**Alerts.** Main asks each project with a `carbon.json` which thresholds were
crossed and not announced yet (`--budget-check`), a few minutes after the app
starts and then every hour. A project without the file costs no process. The
runner remembers the thresholds it announced in
`.workpilot/carbon-budget-state.json`, so each one is announced once a month:
on the desktop and on the person's ntfy or Telegram channel
(`notificationService.announce`), in the app's language. When both cross at
once, only the higher is sent.

**Degraded mode.** With `degrade: true` and the month exceeded,
`phase_config.get_phase_model` steps a flagship model down to its provider's
standard model: the provider's own default when it is not a flagship (Opus
to the current Sonnet), otherwise the registry's first standard model. An id
the registry does not list is a flagship by its name, and its provider is the
one whose models share its first word. A standard, fast or local model stays
as chosen, the provider never changes, and the phase logs the switch. The
answer is cached by month and by the modification times of the settings and
the ledger, so a phase costs two `stat` calls when nothing changed.

## The report (`carbon_profiler/report.py`)

Totals, by provider, model, phase and task (the 20 heaviest), the last 12
months, and an equivalent in petrol-car kilometres (120 g/km, EEA). Advice is
computed from the ledger, without a model, and given only when the ledger
shows what it is about:

| Code | When |
|---|---|
| `review_on_fast` | large models write at least half of the QA and review footprint |
| `use_cache` | a provider with prompt caching reads under 30 % of 200k+ input tokens from cache |
| `cleaner_region` | a provider (Azure, Bedrock, Vertex…) runs on a grid at least twice as heavy as its cleanest region |
| `local_vs_cloud` | the project uses both: Wh per 1,000 tokens written, each side |

The page words each code in the app's language.

## The ESG export (`carbon_profiler/export.py`)

One month, as JSON, CSV (one line per scope, provider and model) or Markdown:

- **CSRD, ESRS E1-6** (gross GHG emissions): a cloud model is a purchased
  service, so it counts in **Scope 3, category 1**; a local model draws the
  company's electricity, so it counts in **Scope 2, location-based**.
- **GRI 305-3** (other indirect emissions) for the cloud part, **GRI 302-1**
  (energy within the organisation) for the local part.

The document carries `estimated: true`, the rates and weights, the local
region and power, the project's overrides and the providers whose host is
guessed. The runner builds the content; main asks where to save it.

## Boundaries

- Every channel takes a project the person added (`resolveKnownProject`),
  a month `YYYY-MM`, a format from a closed list, settings of a known shape
  (S6). The runner is started without a shell, with arguments built in main.
- Nothing is sent anywhere: the ledger, the settings and the export stay on
  the machine. No model is called.

## Not done

- CI runs: the old profiler counted them from a ledger nobody wrote. Lines
  with `source: ci_cd` are now ignored.
- Market-based Scope 2 (renewable contracts) and per-hour grid intensity: the
  figures are location-based yearly averages.
- Server mode: the budget and the page are desktop features.

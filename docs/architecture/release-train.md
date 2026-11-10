# Release Train

Issue #362. The "Release Coordinator" page (Planning). Code:

- backend: `apps/backend/release_coordinator/` (`train_file.py`, `graph.py`, `gates.py`, `flags.py`, `schedule.py`, `notes.py`, `runs.py`, `train.py`) and `runners/release_coordinator_runner.py`;
- main process: `apps/frontend/src/main/ipc-handlers/release-coordinator-handlers.ts` and `main/release-train/approvals.ts`;
- renderer: `renderer/components/release-coordinator/` (`ReleaseTrainPanel`, `TrainRunCard`) and `stores/release-train-store.ts`.

## What it answers

"Ship backend, then frontend, then mobile, without shipping half a release."
The page already planned each service's next version from its commits. It
now also ships them: WorkPilot runs the deployments the project declares, in
the order of their dependencies. Between two services it waits for the first
to be healthy. In production it waits for the person's click before each
service.

## The train file

`release-train.yaml` at the root of the project is versioned and shared by the
team; `.workpilot/release-train.yaml` is used when the root has none. The file
is data (S2), and its format is described at the top of `train_file.py`. It is
read with `yaml.safe_load`, 64 KB at most and never through a link, and every
field is checked:

- A step is a `command` (an argument list, never a shell line, starting with the program) and/or a `url`. `health` only takes a URL.
- Placeholders are `{environment}`, `{version}`, `{previous_version}` and `{service}` only. Their values must match `[\w.+-]{1,80}`, so nothing a shell or `cmd.exe` reads as syntax gets in.
- `path` stays inside the project. A service's default folder is the one where its manifest was found (any stack, `manifests.py`).
- `pass_env` names the project variables a service's commands receive.

A deployment run by CI is a command too: `gh workflow run`, `glab ci run` or
`az pipelines run`, followed by `gh run watch --exit-status` in `smoke`. Any
stack and any host can be driven this way: a script, `kubectl`, `helm`, `fly`
or `dotnet publish`.

## Approval

A train file runs commands on the person's machine, and anyone who can commit
to the repository can change it. So nothing runs until the person approved
this exact file:

1. Main reads the file itself (`O_NOFOLLOW`, no link on the path, 64 KB) and computes its SHA-256.
2. The page shows every command, URL and variable, then the person approves. Main stores `{project root: hash}` in the app's data folder (mode 0600), outside the project.
3. The renderer can only approve the hash main computes at that moment, so a file changed between reading and clicking is refused.
4. Starting a run or moving one on passes the approved hash to the runner. The runner recomputes the file's hash and refuses with `not_approved` when they differ.

A commit that changes the file changes its hash, and the page asks again.

## Order

`graph.plan_order` builds Kahn waves: a service goes in the first wave after
all its dependencies. The dependencies are `depends_on` plus the manifest's
own dependencies among the train's services. Inside a wave, the order is high
criticality first, then normal, then low, then by name.

A cycle stops the train before anything runs. The page names the services in
the cycle and the link to cut, which is the one leaving its least critical
service. A dependency the file does not list is reported and taken as already
in place.

## A run

`train.start` creates the run; `train.drive` moves it as far as it can go
without the person. Runs are saved in
`.workpilot/release-train/runs/<id>.json` after every step. A `<id>.lock`
holding the driving process's id stops two processes from driving one run. A
lock whose process is gone is taken over, and the step it was on becomes
"interrupted". Only one open run is allowed per environment.

For each service, in order:

1. **Confirmation.** A service waits for a click when its environment is marked `production: true`, when it is `external: true` (the person confirms it is ready, and no command runs), or when the run is an express deploy.
2. **Steps.** `deploy`, then `health`, then `smoke`. A step that fails stops the run.
3. **Flags.** A flag goes on once every service it names has shipped.

A command runs without a shell (S4), in the service's folder, in its own
process group: its timeout (`timeout`, 600 s by default) also stops what it
started. A program given by a path must be a file inside the project; a bare
name is looked up on `PATH`.

The command's environment is the app's environment without its credentials
(`security.child_env`, so no provider key reaches a deploy script), plus
`CI=1` and the `pass_env` variables. Main reads those variables from the
project's environment (`readMergedProjectEnv`) and hands over only the ones
the file names (S1).

What the step printed is kept (its last 4,000 characters) with secrets masked
(`redact_text`). A URL step is a GET that does not follow redirects. It is
retried (`retries`, 5 s apart) until `expect_status` answers.

## When a step fails

The run stops on the failure, and the person chooses:

- **retry**, once the cause is fixed. The service starts again from its deploy.
- **rollback.** `graph.cascade` takes the failed service and every shipped service that depends on it, directly or not, dependents first. Their flags go off before anything runs. Then each service's `rollback` command runs with `{version}` = `{previous_version}`, which is the version last shipped to that environment by a finished run, or else the manifest's version. An external service is listed for the person to roll back by hand.
- **abort.** What is left does not ship.

An **express deploy** is a hotfix outside the train. It ships one service
without waiting for its dependencies, always after a click, whatever the
environment.

## Feature flags

`flags.py` sends the REST calls:

| Provider | Call |
|---|---|
| Unleash | `POST {url}/api/admin/projects/{project}/features/{key}/environments/{env}/on\|off` |
| LaunchDarkly | `PATCH {url}/api/v2/flags/{project}/{key}`, a semantic patch with `turnFlagOn` / `turnFlagOff` |
| ConfigCat | `PUT {url}/v1/environments/{env}/settings/{key}/value` with `{"value": true\|false}` |
| manual | the run waits for the person to say it is on |

The tokens are `UNLEASH_API_TOKEN`, `LAUNCHDARKLY_API_TOKEN`, and
`CONFIGCAT_API_USER` + `CONFIGCAT_API_PASSWORD`. They come from the project's
environment variables, only for the flags the file declares, and never appear
in a run, a journal or an error.

## Calendar, notes, metrics

- `calendar` in the file lists planned slots. Two slots in the same environment whose windows overlap are marked as a conflict. A run started while another service's slot is open in that environment carries a warning.
- The release notes are written by rules from the version plan: one section per service that changes, with breaking changes, features, fixes and the rest. When asked, the configured model (`core.oneshot`, any provider, Ollama included) adds one paragraph on top. It reads only the commit subjects, quoted as data. A heading, a list or more than 1,200 characters leaves the notes as the rules wrote them.
- `history.jsonl` gets one line per finished run. The page shows, per month, the trains, the multi-service ones, the mean duration, the runs stopped by a check, and the rollbacks attempted and succeeded.

No model takes part in the order, the gates, the flags or the calendar.

## Trust boundaries

- The train file is untrusted repository content. It runs only once approved, by its hash, which is checked in main and again in the runner.
- The renderer sends a known project (`resolveKnownProject`) and checked values (`approvals.ts`): an environment, service names, a run id, an action, and a target (a service or `flag:<key>`).
- Commands get no app credential, and only the variables the file names.
- Nothing listens on the machine: there is no webhook, no port and no tunnel. Health checks and flags are outgoing calls.

## Not done

- Parallel deployment inside a wave: services of a wave ship one after another.
- A Stop button for a running step: a step ends at its timeout. Closing the app marks it interrupted at the next action.
- Server mode: train runs are a desktop feature (main approves the file and the runner runs on the person's machine).
- Slack or Teams messages written by a model; the run's journal stays on the page.
- A "flag maison" provider reading a file: use `manual`, or a command in a smoke step.

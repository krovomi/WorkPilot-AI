# Mobile applications (Android and Apple)

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Mobile applications (Android and Apple)

A phone application breaks the assumption every other part of this repository
makes about a project: that it can be *run*. There is no dev server and no
localhost URL. The artefact is compiled, installed onto an emulator or a
simulator, and looked at — and on the machine doing the building, one of the two
platforms may not be buildable at all, because Apple's toolchain does not exist
outside macOS.

```
apps/backend/mobile/
  stacks.py     which stack this is, and the commands it responds to
  devices.py    the emulators and simulators this machine actually has
  readiness.py  whether a platform can be built here, and what is missing
  prompt.py     the section every agent phase gets when the task is a phone app
  ../runners/mobile_runner.py   --detect | --devices | --doctor | --plan
```

**One detector, read by everyone.** `detect_stack` reads files on disk — no
model, no network — and returns the framework, the platforms, and the run,
build, test and lint command for each. The prompt layer, the subagent roster,
the workflow phases and the Electron preview all read that one answer. Writing
a second detector in TypeScript for the UI is exactly how the web side ended up
with two, and two detectors is two answers to "what kind of project is this".

**Cross-platform frameworks are detected first, deliberately.** A Flutter tree
contains a complete Gradle project and a complete Xcode project. Matching the
native detectors first would report the wrapper instead of the thing anyone is
writing, and hand the coder `./gradlew assembleDebug` for a Dart codebase.

**The doctor runs before the phase, not after the failure.** An iOS target on a
Linux runner is not a defect to retry — it is a property of the machine, and it
is answerable in milliseconds. So `mobile_section` states it up front, and tells
the agent to implement the change, verify what is verifiable, and *say* which
platform went unverified. The alternative is an hour of build attempts ending in
a red log that reads like a code error. That is also why the blocker for iOS off
macOS never says "install xcodebuild": there is no such package, and an agent
told there is will go looking for it.

**Per-task targets.** A card can say "Android only" about a repository that also
ships an Apple head. The choice reaches the backend as
`WORKPILOT_MOBILE_TARGETS` — the same lever `TDD_MODE` uses — and narrows the
platform rules the planner, every coding subtask and the QA reviewer are given.
Naming *no* platform means every platform the project has, not none: a card that
says nothing is not asking for nothing. Asking for a platform the project lacks
is ignored rather than obeyed.

**In the Kanban.** The task panel's *Mobile* tab detects the stack, lists the
real devices (`adb devices`, `emulator -list-avds`, `xcrun simctl list`), boots
the one you pick, builds, installs, launches, and shows a captured frame beside
the app's own log — never the whole device's, which is thousands of lines of
system noise around the one crash you are looking for. When a platform cannot be
built here, the panel says so instead of offering a Run button that can only
fail.

**How it is verified.** The layers split by what they need:

| Layer | Proven by | Where |
|---|---|---|
| stack detection, prompt, roster, workflow phases | fixtures and real repos | `test_mobile_stacks.py`, `test_mobile_chain.py` |
| devices and toolchain, against whatever is really installed | the machine's own `adb` / `xcrun` | `test_mobile_toolchain_contract.py`, in the existing 3-OS `test-python` matrix |
| boot → build → install → launch → capture | a real emulator and a real APK | `mobile-device-check.yml`, manual trigger |

The middle row exists because of a bug the other two could not catch: a cold
`adb devices -l` prints two lines of its own *before* the header, so a parser
that skipped a fixed first line read `* daemon started successfully` as a
device with the serial `*`. Sixty-four tests passed over it, because they all
fed the code a string somebody wrote — they tested our idea of adb. adb is cold
exactly once per machine boot, which is the first time anyone opens the Mobile
tab. Those contract tests assert what must hold *whatever* is installed, never
that a particular device exists: a runner image with one simulator fewer is not
a defect here, and a test that says otherwise gets disabled within a month.

`scripts/mobile_device_check.py` is the same code path as a command. Read-only
by default — stack, devices, toolchain verdict, no build and no device needed —
and `--launch` adds build, install, start and a captured frame:

```bash
python scripts/mobile_device_check.py --project-dir ../my-app
python scripts/mobile_device_check.py --project-dir ../my-app --launch
```

**The agent chain.** Three additions, each where it changes a decision:

| Where | What |
|---|---|
| `agents/subagents/mobile.py` | `device-runner` (installs and launches, reports; the only roster entry that touches a device) and `store-readiness-auditor` (read-only; the rules Apple and Google reject on). Both are protected from the roster cap — they are the only entries that know the project is a phone app — and added only to a phase that has a roster: coder, QA, verifier and the `pr_reviewer` the mobile workflow phases run under keep them, a `solo` call (a commit message) stays empty. |
| `workflows/feature-build/workflow.yaml` | `mobile-design` before coding, `store-readiness` after QA. Both conditional on mobile files being touched, both `fresh-context`, both read-only. |
| `skills/mobile/` | the procedures: `android-developer`, `ios-developer`, `cross-platform-mobile`, `mobile-design-review`, `mobile-device-testing`, `mobile-store-readiness`, plus four agent definitions. |

`mobile-design` sits *before* `coding` because the window a phase runs in is its
declared position: a badly cut screen costs a sentence there and a full fix
cycle after QA. `store-readiness` sits after QA because it audits a finished
build — and it exists at all because store rejections cost days and **no test in
the repository catches any of them**: they are rules about configuration files
and about behaviours the suite does not look at.

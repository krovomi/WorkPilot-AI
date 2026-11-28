# Release Process

This document describes how releases are created for Auto-Claude EBP (WorkPilot AI).

## Overview

WorkPilot AI uses an automated release pipeline that ensures releases are only published after all builds succeed. This prevents version mismatches between documentation and actual releases.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RELEASE FLOW                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   develop branch                    main branch                             │
│   ──────────────                    ───────────                             │
│        │                                 │                                  │
│        │  1. bump-version.js             │                                  │
│        │     (creates commit)            │                                  │
│        │                                 │                                  │
│        ▼                                 │                                  │
│   ┌─────────┐                            │                                  │
│   │ v1.0.0  │  2. Create PR              │                                  │
│   │ commit  │ ────────────────────►      │                                  │
│   └─────────┘                            │                                  │
│                                          │                                  │
│                           3. Merge PR    ▼                                  │
│                                    ┌──────────┐                             │
│                                    │  v1.0.0  │                             │
│                                    │  on main │                             │
│                                    └────┬─────┘                             │
│                                         │                                   │
│                     ┌───────────────────┴───────────────────┐               │
│                     │     GitHub Actions (automatic)        │               │
│                     ├───────────────────────────────────────┤               │
│                     │ 4. prepare-release.yml                │               │
│                     │    - Detects version > latest tag     │               │
│                     │    - Creates tag v1.0.0               │               │
│                     │                                       │               │
│                     │ 5. release.yml (triggered by tag)     │               │
│                     │    - Builds macOS (Intel + ARM)       │               │
│                     │    - Builds Windows                   │               │
│                     │    - Builds Linux                     │               │
│                     │    - Generates changelog              │               │
│                     │    - Creates GitHub release           │               │
│                     │    - Updates README                   │               │
│                     └───────────────────────────────────────┘               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Branch Model

- **`develop`** holds the most recent sources. Every pull request targets it; squash merges are
  fine there.
- **`main`** holds released code only. It receives `develop` through a pull request **merged with
  a merge commit**, and each such merge that bumps the version is tagged `vX.Y.Z`.

Why a merge commit and never a squash or a rebase: both write new commits on `main` that `develop`
never had. The two branches then stop sharing history, GitHub reports `main` hundreds of commits
"behind" `develop`, and the next `develop` → `main` pull request conflicts on files both sides
changed the same way (`package.json`, `CHANGELOG.md`). Releases 1.3.0 to 1.3.3 went to `main` as
squashes and each needed a reconciliation pull request (#529, #540, #548, #549). With merge commits
`develop` is always an ancestor of `main` after a release, so no reconciliation is ever needed.

### Repository settings (one-time)

The `main` ruleset enforces this. In **Settings → Rules → Rulesets → `main`**:

- **Require a pull request before merging** → **Allowed merge methods**: **Merge** only (untick
  Squash and Rebase).
- Keep **Block force pushes** and **Restrict deletions**.

Leave the repository-wide merge buttons as they are: squash stays available for pull requests into
`develop`. `main-history-guard.yml` turns a push to `main` red when its head commit has a single
parent, which is how a squash or a rebase that slipped through shows up.

## Automatic Releases (release autopilot)

Since 2026-11-14 nobody cuts a release by hand: `release-autopilot.yml` runs
`scripts/release_autopilot.py` every hour and at the end of every CI, Lint, CodeQL, Quality
Security and Mobile run. The steps below ("Creating a Release") are what it does, and stay the
fallback when it is switched off.

**When.** At most one version a day, never in the middle of a burst of merges: a version starts
once `develop` has had **no merge for 2 hours**, the previous version is **at least 24 hours old**
and every push workflow of `develop`'s head is green. Merges batch up in between. Pull requests
that only touch docs, CI, tests or style (`docs:`, `ci:`, `test:`, `style:`, other `chore:`) ride
along with the next version but never start one. This replaces the earlier rule of releasing only
when no feature was in flight.

**Which version.** The strongest change since the last tag wins (semantic versioning):

| Level | From the pull request | From `changelog.d/` |
|---|---|---|
| **major** | `type!:` (`feat!:`, `fix(api)!:`), a `BREAKING CHANGE:` footer, `**Breaking:** Yes` in the template, label `breaking` | `⚠️ Changement incompatible` |
| **minor** | `feat:` (label `feature` when the title is not conventional) | `✨ Nouveautés` |
| **patch** | `fix:`, `perf:`, `refactor:`, `revert:`, `build:`, `chore(deps):` (label `bug`) | any other section |
| none | `docs:`, `ci:` (including `ci(deps):`), `test:`, `style:`, other `chore:` | — |

A `semver:major`, `semver:minor`, `semver:patch` or `semver:none` label on a pull request overrides
its level. A manifest already bumped by hand past the computed version is kept.

**How.**

1. Branch `release/vX.Y.Z` = `develop` + one commit `chore(release): X.Y.Z`: the version in the
   five manifests (`package.json`, `apps/frontend/package.json`, `apps/mobile/package.json`,
   `apps/mobile/app.json`, `apps/backend/__init__.py`), the fragments folded into
   `## X.Y.Z - Title` of `CHANGELOG.md` (the merged pull requests when there is no fragment), and
   **the version's documentation**.
2. The documentation is written by Claude Code on that branch (`scripts/release_docs.py`): the
   changelog title and intro, what changed in `README.md` and its twin `README.fr.md` (features,
   tour, architecture), the `docs/` files a changed behaviour makes wrong, and a wiki patch
   (`scripts/wiki/patches/NNNN-release-X.Y.Z.patch`: Home "What's new", Roadmap "Recent
   releases"). It reads the notes as data and has file tools only; what it writes outside those
   files, a new file, an AUTOGEN block of the wiki, or a broken changelog section is put back, and
   a token in the text discards everything. Patches the wiki already has are deleted on the way.
   Without `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`), or when the run fails, the pull
   request carries `release-autopilot/documentation` and is not merged until a person writes the
   documentation on the branch and removes the label.
3. A pull request `Release vX.Y.Z` into `main`, label `release-autopilot`, with the list of changes
   and their levels. Once every check of its head is green and GitHub says it is mergeable, it is
   merged with a **merge commit**; `prepare-release.yml` tags, `release.yml` builds, publishes,
   moves the README version and refreshes the wiki (which applies the patch).
4. `main` is merged back into `develop` (`chore(release): merge vX.Y.Z back into develop`), so the
   version commit and the folded changelog reach `develop` and the next release has nothing to
   reconcile. The same merge runs before preparing a version if `main` has moved since (the README
   pull request).

**When it is stuck.** A red check labels the pull request `release-autopilot/rouge`, a merge GitHub
refuses (an unresolved review thread such as a CodeQL alert, an approval) `release-autopilot/bloquee`,
each with one comment. A fix merged into `develop` is enough: once `develop` is green and quiet
again, the stuck pull request is closed and the version prepared again from the new `develop`.

**Settings.** Secrets `PAT_TOKEN` (pushes, pull request, merge: a push with the default token
starts no CI) and `CLAUDE_CODE_OAUTH_TOKEN`. Repository variables: `RELEASE_AUTOPILOT=off` stops it,
`RELEASE_AUTOPILOT_QUIET_HOURS` (2) and `RELEASE_AUTOPILOT_MIN_INTERVAL_HOURS` (24) change the
cadence, `RELEASE_AUTOPILOT_MODEL` picks the documentation model. **Run workflow** with `dry_run`
says what it would do; with `now`, it skips the cadence once (never a red `develop`).

## For Maintainers: Creating a Release

When the release autopilot is off, or for a hotfix:

### Step 1: Bump the Version

On a branch cut from `develop` (for example `chore/release-1.1.0`), merged into `develop` by a
normal pull request:

```bash
# Navigate to project root
cd /path/to/auto-claude-ebp

# Bump version (choose one)
node scripts/bump-version.js patch   # 1.0.0 -> 1.0.1 (bug fixes)
node scripts/bump-version.js minor   # 1.0.0 -> 1.1.0 (new features)
node scripts/bump-version.js major   # 1.0.0 -> 2.0.0 (breaking changes)
node scripts/bump-version.js 1.1.0   # Set specific version
```

This will:
- Update `apps/frontend/package.json`
- Update `package.json` (root)
- Update `apps/backend/__init__.py`
- Check if `CHANGELOG.md` has an entry for the new version (warns if missing)
- Create a commit with message `chore: bump version to X.Y.Z`

### Step 2: Update CHANGELOG.md (REQUIRED)

**IMPORTANT: The release will fail if CHANGELOG.md doesn't have an entry for the new version.**

Unreleased changes live as fragments in `changelog.d/` (one file per PR, see
[`changelog.d/README.md`](../changelog.d/README.md)). Fold them into the version's section:

```bash
python scripts/changelog.py preview                      # what the notes will say
python scripts/changelog.py release 1.1.0 "Your Release Title"
```

This writes `## 1.1.0 - Your Release Title` at the top of `CHANGELOG.md`, with the fragments
grouped by section, and removes them. Replace the intro comment it leaves with one or two
sentences on what the version changes for the user.

Then amend the version bump commit:

```bash
git add CHANGELOG.md changelog.d
git commit --amend --no-edit
```

### Step 3: Push and Create PR

```bash
# Push your branch, open its PR into develop and merge it
git push origin chore/release-1.1.0
gh pr create --base develop --title "chore(release): prepare 1.1.0"

# Then open the release PR straight from develop: no release branch, no merge of main first
gh pr create --base main --head develop --title "Release v1.1.0"
```

### Step 4: Merge to Main (merge commit)

Merge the `develop` → `main` pull request with **Create a merge commit** (`gh pr merge --merge`).
The `main` ruleset refuses the other methods. Once merged, GitHub Actions will automatically:

1. **Detect the version bump** (`prepare-release.yml`)
2. **Validate CHANGELOG.md** has an entry for the new version (FAILS if missing)
3. **Extract release notes** from CHANGELOG.md
4. **Create a git tag** (e.g., `v1.1.0`)
5. **Trigger the release workflow** (`release.yml`)
6. **Build binaries** for all platforms:
   - macOS Intel (x64) - code signed & notarized
   - macOS Apple Silicon (arm64) - code signed & notarized
   - Windows (NSIS installer) - code signed
   - Linux (AppImage + .deb)
7. **Create GitHub release** with release notes from CHANGELOG.md
8. **Dispatch the follow-ups** by name, with the tag: `virustotal-scan.yml` (adds the scan
   results to the release notes when `VIRUSTOTAL_API_KEY` is set, and says it skipped otherwise),
   `discord-release.yml` (needs `DISCORD_WEBHOOK_URL`; without it the run ends green with a
   notice that the release was not announced), `wiki-narrative.yml`. A release published
   with `GITHUB_TOKEN` raises no event other workflows can listen to, so `release: published`
   alone would never start them.
9. **Update README** (`README.md` and its French twin `README.fr.md`) with new version badge and
   download links: one commit, built on `main`,
   merged into `develop` and carried to `main` by a pull request that auto-merges with a merge
   commit (`chore/readme-vX.Y.Z`). Both branches get the same commit, so neither drifts.

### Step 5: Verify

After merging, check:
- [GitHub Actions](https://github.com/krovomi/WorkPilot-AI/actions) - ensure all workflows pass
- [Releases](https://github.com/krovomi/WorkPilot-AI/releases) - verify release was created
- [README](https://github.com/krovomi/WorkPilot-AI#download) - confirm version updated

## Version Numbering

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (X.0.0): Breaking changes, incompatible API changes
- **MINOR** (0.X.0): New features, backwards compatible
- **PATCH** (0.0.X): Bug fixes, backwards compatible

## Changelog Management

Release notes are managed in `CHANGELOG.md` and used for GitHub releases. Between releases,
each PR adds a fragment to `changelog.d/` instead of editing `CHANGELOG.md`, so open PRs do
not conflict; `scripts/changelog.py release` folds them in (Step 2).

### Changelog Format

Each version entry in `CHANGELOG.md` should follow this format:

```markdown
## X.Y.Z - Release Title

### ✨ New Features
- Feature description with context

### 🛠️ Improvements
- Improvement description

### 🐛 Bug Fixes
- Fix description

---
```

### Changelog Validation

The release workflow **validates** that `CHANGELOG.md` has an entry for the version being released:

- If the entry is **missing**, the release is **blocked** with a clear error message
- If the entry **exists**, its content is used for the GitHub release notes

### Writing Good Release Notes

- **Be specific**: Instead of "Fixed bug", write "Fixed crash when opening large files"
- **Group by impact**: Features first, then improvements, then fixes
- **Credit contributors**: Mention contributors for significant changes
- **Link issues**: Reference GitHub issues where relevant (e.g., "Fixes #123")

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `prepare-release.yml` | Push to `main` | Detects version bump, **validates CHANGELOG.md**, creates tag |
| `release.yml` | Tag `v*` pushed | Builds binaries, extracts changelog, creates release |
| `update-readme` (in release.yml) | After release | Updates README with new version, on `develop` and `main` through one shared commit |
| `main-history-guard.yml` | Push to `main` | Fails when `main` moved by a commit with a single parent (squash or rebase) |
| `release-autopilot.yml` | Hourly, end of CI / Lint / CodeQL / Quality Security / Mobile, by hand | Prepares `release/vX.Y.Z` (version, changelog, documentation), merges it into `main` by merge commit when green, merges `main` back into `develop` |

## Troubleshooting

### Release didn't trigger after merge

1. Check if version in `package.json` is greater than latest tag:
   ```bash
   git tag -l 'v*' --sort=-version:refname | head -1
   cat apps/frontend/package.json | grep version
   ```

2. Ensure the merge commit touched `package.json`:
   ```bash
   git diff HEAD~1 --name-only | grep package.json
   ```

### Release blocked: Missing changelog entry

If you see "CHANGELOG VALIDATION FAILED" in the workflow:

1. The `prepare-release.yml` workflow validated that `CHANGELOG.md` doesn't have an entry for the new version
2. **Fix**: Add an entry to `CHANGELOG.md` with the format `## X.Y.Z - Title`, on a branch from
   `develop`, through a pull request into `develop` (`main` takes no direct push)
3. Open a new `develop` → `main` pull request and merge it with a merge commit
4. `prepare-release.yml` only starts on its own when `package.json` changes, so start it by hand:

```bash
gh workflow run prepare-release.yml --ref main
```

### main and develop have diverged

Symptoms: GitHub shows `main` many commits behind `develop` while their files are the same, the
`develop` → `main` pull request conflicts on `package.json` or `CHANGELOG.md`, or
`main-history-guard.yml` failed. Cause: something reached `main` by squash or rebase.

Repair once, with no file change, then merge the pull request **with a merge commit**:

```bash
git fetch origin main develop --depth=500   # shallow clones produce bogus conflicts
git checkout -b sync/main-history origin/develop
git merge -s ours origin/main -m "chore(release): record main's history in develop"
git diff origin/develop HEAD                  # must be empty
git push -u origin sync/main-history
gh pr create --base main --head sync/main-history --title "chore(release): realign main's history with develop"
gh pr merge --merge <number>
```

`-s ours` keeps `develop`'s files and only records `main`'s commits as merged. If `main` carries a
fix `develop` lacks (a hotfix), bring that fix into `develop` by a normal pull request first.

### Hotfix

Fix on `develop` and release `develop` → `main` as usual (1.3.2 did this). Only when `develop`
holds work that must not ship yet: branch `hotfix/x` from `main`, open its PR into `main`, merge
with a merge commit, then open a PR `hotfix/x` → `develop` and merge it **with a merge commit**
too, so `develop` gets the very same commit.

### Build failed after tag was created

- The release won't be published if builds fail
- Fix the issue and create a new patch version
- Don't reuse failed version numbers

### README shows wrong version

- README is only updated after successful release
- If release failed, README keeps the previous version (this is intentional)
- Once you successfully release, README will update automatically

## Manual Release (Emergency Only)

In rare cases where you need to bypass the automated flow:

```bash
# Create tag manually (NOT RECOMMENDED)
git tag -a v1.1.0 -m "Release v1.1.0"
git push origin v1.1.0

# This will trigger release.yml directly
```

**Warning:** Only do this if you're certain the version in package.json matches the tag.

## Security

- All macOS binaries are code signed with Apple Developer certificate
- All macOS binaries are notarized by Apple
- Windows binaries are code signed
- Binaries are scanned with VirusTotal after publication, when `VIRUSTOTAL_API_KEY` is configured
- SHA256 checksums are generated for all artifacts
- A CycloneDX SBOM (`workpilot-sbom.cdx.json`) lists the npm and Python packages of the release; it
  is read from the checkout by `anchore/sbom-action` before the binaries are downloaded
- Every published file (binaries, manifests, SBOM, checksums) has a build provenance attestation
  (`actions/attest-build-provenance`); verify one with
  `gh attestation verify <file> --repo krovomi/WorkPilot-AI`. Dry runs attest nothing.
  `tests/test_release_supply_chain.py` keeps both steps in place

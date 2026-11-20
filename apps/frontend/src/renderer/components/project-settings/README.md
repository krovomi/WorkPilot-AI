# project-settings

What is left of the old project settings dialog, now shown inside the unified settings
(`components/settings/`):

| File | Used by | Role |
|---|---|---|
| `hooks/useProjectSettings.ts` | `settings/ProjectSettingsContent.tsx`, `stores/project-env-store.ts` | the project's settings and `.workpilot/.env` while they are edited, saved together |
| `GeneralSettings.tsx` | `settings/sections/SectionRouter.tsx` | the project's general section: agent profile, repository, worktree recipe, cross-review, auto-split |
| `RepositorySection.tsx`, `WorktreeRecipeSection.tsx`, `CrossReviewSettings.tsx`, `AutoSplitSettings.tsx` | `GeneralSettings.tsx` | its parts |
| `ClaudeOAuthFlow.tsx` | `GitHubSetupModal.tsx` | Claude sign-in through a terminal running `/login` |
| `GitHubOAuthFlow.tsx` | `GitHubSetupModal.tsx`, `settings/integrations/GitHubIntegration.tsx` | GitHub sign-in through `gh` |
| `PasswordInput.tsx` | `settings/integrations/` | a secret field with a show/hide toggle |

The integration sections that used to live here (Claude, GitHub, Linear, agent, notifications)
were replaced by `settings/integrations/` and are gone.

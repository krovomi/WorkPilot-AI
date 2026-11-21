# Roadmap view

`../Roadmap.tsx` composes the view of a project's roadmap from the pieces in this folder.

| File | Role |
|---|---|
| `hooks.ts` | `useRoadmapData` (loads the roadmap and whether a generation runs), `useFeatureActions` (a feature becomes a task; a refusal is shown in a toast), `useRoadmapSave` and `useFeatureDelete` (write the roadmap the store holds now; a refused save reloads what is saved, a failed one is shown), `useRoadmapGeneration` (generate or refresh after the competitor analysis question) |
| `RoadmapHeader.tsx` | vision, actions, audience, counts per priority |
| `RoadmapEmptyState.tsx` | no roadmap yet: generate it |
| `RoadmapTabs.tsx` | kanban (`../RoadmapKanbanView.tsx`), phases, all features, by priority |
| `PhaseCard.tsx`, `FeatureCard.tsx` | a phase with its progress, milestones and first five features; a feature card |
| `FeatureDetailPanel.tsx` | the side panel of a feature: details, pain points it answers, task, deletion |
| `tones.ts`, `utils.ts`, `types.ts` | priority tones, competitor insight lookups, props |

Every value the roadmap stores as a code (priority, complexity, impact, phase and roadmap status,
severity) is shown through a `roadmap:` key, in English and French. Tests:
`__tests__/roadmap-parts.test.tsx` (each piece) and `__tests__/roadmap-view.test.tsx` (the view
on the real store).

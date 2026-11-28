/**
 * The variables a build reads to place its full suite
 * (`apps/backend/test_placement/settings.py`), from the project's settings and
 * what the app will follow afterwards. A card's own choice is not here: the
 * backend reads it from the card's `task_metadata.json`.
 */

import type { ProjectSettings } from "../../shared/types/project";
import { TEST_PLACEMENT_MODES } from "../../shared/types/suite-placement";

export function suitePlacementEnv(
	settings: Pick<ProjectSettings, "testPlacement" | "testPlacementBranchPush"> | undefined,
	ciFollowed: boolean,
): Record<string, string> {
	const env: Record<string, string> = {};
	const mode = settings?.testPlacement;
	if (mode && TEST_PLACEMENT_MODES.includes(mode)) env.TEST_PLACEMENT = mode;
	if (ciFollowed) {
		env.WORKPILOT_TEST_PLACEMENT_ROUTES = "ci";
		if (settings?.testPlacementBranchPush !== false) {
			env.TEST_PLACEMENT_ALLOW_BRANCH_PUSH = "true";
		}
	}
	return env;
}

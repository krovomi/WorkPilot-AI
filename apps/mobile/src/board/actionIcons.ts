/** The icon of each card action, the same on the card screen and in the quick actions. */

import type { IconName } from "../ui/Icon";
import type { CardAction } from "./actions";

export const ACTION_ICONS: Record<CardAction, IconName> = {
	start: "play",
	approve: "check",
	stop: "square",
	retry: "rotate-ccw",
	merge: "git-merge",
	createPr: "git-pull-request",
	requestChanges: "message-square",
	delete: "trash-2",
};

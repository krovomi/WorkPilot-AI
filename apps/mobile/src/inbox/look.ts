/** How each reason of the inbox is drawn: an icon and a colour of the theme, always with its word. */

import type { IconName } from "../ui/Icon";
import type { Theme } from "../ui/theme";
import type { InboxReason } from "./forMe";

export const REASON_LOOK: Record<InboxReason, { icon: IconName; color: keyof Pick<Theme, "accent" | "danger" | "success"> }> = {
	plan: { icon: "check-square", color: "accent" },
	attention: { icon: "alert-triangle", color: "danger" },
	review: { icon: "git-pull-request", color: "success" },
};

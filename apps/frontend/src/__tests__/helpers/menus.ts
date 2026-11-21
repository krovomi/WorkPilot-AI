import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/**
 * Picks an item of an open menu's submenu ("Move to ▸ Queue"). By keyboard:
 * jsdom has no layout, so a pointer leaving the submenu's trigger closes the
 * submenu before the click lands.
 */
export async function pickSubmenuItem(
	user: UserEvent,
	submenu: string,
	item: string,
): Promise<void> {
	const trigger = await screen.findByRole("menuitem", { name: submenu });
	trigger.focus();
	await user.keyboard("{ArrowRight}");
	const target = await screen.findByRole("menuitem", { name: item });
	target.focus();
	await user.keyboard("{Enter}");
}

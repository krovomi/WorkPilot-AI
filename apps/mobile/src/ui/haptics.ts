/**
 * A light touch under the finger when something happened (`expo-haptics`).
 * Nothing on a device without a motor or on the web: a missing touch never
 * fails what the person did.
 */

import * as Haptics from "expo-haptics";

function quietly(feel: () => Promise<void>): void {
	feel().catch(() => undefined);
}

/** A choice moved: a column, a filter. */
export function tick(): void {
	quietly(() => Haptics.selectionAsync());
}

/** A long press opened something. */
export function press(): void {
	quietly(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** What was asked is done on the server. */
export function done(): void {
	quietly(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/** The server refused or could not be reached. */
export function failed(): void {
	quietly(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
}

/**
 * The colour of a split group (`apps/backend/task_split/group.py`): the parts
 * of one task too big for one PR share it, on the desktop board, here and on
 * the forge label. The same tones, in the same order, and the same hash as
 * the desktop (`shared/utils/task-split.ts`), with the charter's values.
 */

import type { BoardCard } from "../api/types";

export const GROUP_TONES = ["blue", "violet", "green", "amber", "pink", "orange"] as const;
export type GroupTone = (typeof GROUP_TONES)[number];

/** The charter's tones (`components/charter/charter.css`), light and dark. */
const COLORS: Record<GroupTone, { light: string; dark: string }> = {
	blue: { light: "#2f6fd6", dark: "#7cb4ff" },
	violet: { light: "#7b55e0", dark: "#b8a1ff" },
	green: { light: "#0f8f6a", dark: "#6fdab4" },
	amber: { light: "#b07a00", dark: "#f2c46d" },
	pink: { light: "#c2416b", dark: "#ff8fb0" },
	orange: { light: "#d9581f", dark: "#ff9a5c" },
};

function utf8(text: string): number[] {
	const bytes: number[] = [];
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x80) bytes.push(code);
		else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
		else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
		else
			bytes.push(
				0xf0 | (code >> 18),
				0x80 | ((code >> 12) & 63),
				0x80 | ((code >> 6) & 63),
				0x80 | (code & 63),
			);
	}
	return bytes;
}

/** FNV-1a (32 bits) of the group id's UTF-8 bytes, modulo the six tones. */
export function groupTone(groupId: string): GroupTone {
	let value = 0x811c9dc5;
	for (const byte of utf8(groupId)) {
		value ^= byte;
		value = Math.imul(value, 0x01000193) >>> 0;
	}
	return GROUP_TONES[value % GROUP_TONES.length];
}

export function groupColor(groupId: string, dark: boolean): string {
	const color = COLORS[groupTone(groupId)];
	return dark ? color.dark : color.light;
}

/** The cards of one group, or every card when no group is chosen. */
export function inGroup(cards: readonly BoardCard[], group: string | null): BoardCard[] {
	return group ? cards.filter((card) => card.group?.id === group) : [...cards];
}

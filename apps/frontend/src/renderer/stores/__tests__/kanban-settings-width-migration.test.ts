/**
 * Column width migration: the cards were redesigned to fit a narrower column,
 * so a column still at the former default (never resized) moves to the new
 * default, while a width the user dragged by hand is kept.
 */
import { describe, expect, it } from "vitest";
import { TASK_STATUS_COLUMNS } from "../../../shared/constants";
import type { KanbanColumnPreferences } from "../kanban-settings-store";
import {
	DEFAULT_COLUMN_WIDTH,
	LEGACY_DEFAULT_COLUMN_WIDTH,
	migrateLegacyColumnWidths,
} from "../kanban-settings-store";

function prefsWith(width: number): KanbanColumnPreferences {
	const prefs: Partial<KanbanColumnPreferences> = {};
	for (const column of TASK_STATUS_COLUMNS) {
		prefs[column] = { width, isCollapsed: false, isLocked: false };
	}
	return prefs as KanbanColumnPreferences;
}

describe("migrateLegacyColumnWidths", () => {
	it("the new default is narrower than the former one", () => {
		expect(DEFAULT_COLUMN_WIDTH).toBeLessThan(LEGACY_DEFAULT_COLUMN_WIDTH);
	});

	it("moves columns still at the former default to the new default", () => {
		const migrated = migrateLegacyColumnWidths(
			prefsWith(LEGACY_DEFAULT_COLUMN_WIDTH),
		);
		for (const column of TASK_STATUS_COLUMNS) {
			expect(migrated[column].width).toBe(DEFAULT_COLUMN_WIDTH);
		}
	});

	it("keeps a width the user resized by hand, and returns the same object", () => {
		const prefs = prefsWith(412);
		const migrated = migrateLegacyColumnWidths(prefs);
		expect(migrated).toBe(prefs);
		expect(migrated[TASK_STATUS_COLUMNS[0]].width).toBe(412);
	});

	it("keeps the other column settings when migrating", () => {
		const prefs = prefsWith(LEGACY_DEFAULT_COLUMN_WIDTH);
		const first = TASK_STATUS_COLUMNS[0];
		prefs[first] = { ...prefs[first], isLocked: true, wipLimit: 3 };
		const migrated = migrateLegacyColumnWidths(prefs);
		expect(migrated[first]).toEqual({
			width: DEFAULT_COLUMN_WIDTH,
			isCollapsed: false,
			isLocked: true,
			wipLimit: 3,
		});
	});
});

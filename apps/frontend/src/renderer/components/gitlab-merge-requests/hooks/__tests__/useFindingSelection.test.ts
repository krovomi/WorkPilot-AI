/**
 * Choosing which review findings to post on a GitLab MR: one by one, all,
 * none, the important ones, or a whole severity group.
 *
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useFindingSelection } from "../useFindingSelection";

const f = (id: string) => ({ id }) as never;
const groupedFindings = { critical: [f("c1")], high: [f("h1"), f("h2")], medium: [f("m1")], low: [] };
const findings = Object.values(groupedFindings).flat();
const onSelectionChange = vi.fn();

beforeEach(() => onSelectionChange.mockReset());

const selection = (ids: string[]) =>
	renderHook(() => useFindingSelection({ findings, selectedIds: new Set(ids), onSelectionChange, groupedFindings })).result
		.current;
const chosen = () => [...(onSelectionChange.mock.lastCall?.[0] as Set<string> | undefined ?? [])].sort();

it("toggles one finding", () => {
	selection(["c1"]).toggleFinding("h1");
	expect(chosen()).toEqual(["c1", "h1"]);
	selection(["c1", "h1"]).toggleFinding("c1");
	expect(chosen()).toEqual(["h1"]);
});

it("selects all, none, or the critical and high ones", () => {
	const s = selection(["m1"]);
	s.selectAll();
	expect(chosen()).toEqual(["c1", "h1", "h2", "m1"]);
	s.selectNone();
	expect(chosen()).toEqual([]);
	s.selectImportant();
	expect(chosen()).toEqual(["c1", "h1", "h2"]);
});

it("selects a group, then deselects it once it is fully selected", () => {
	selection(["h1", "m1"]).toggleSeverityGroup("high");
	expect(chosen()).toEqual(["h1", "h2", "m1"]);
	selection(["h1", "h2", "m1"]).toggleSeverityGroup("high");
	expect(chosen()).toEqual(["m1"]);
});

it("tells a full group from a partial one, and an empty group is neither", () => {
	const s = selection(["h1", "c1"]);
	expect([s.isGroupFullySelected("critical"), s.isGroupPartiallySelected("critical")]).toEqual([true, false]);
	expect([s.isGroupFullySelected("high"), s.isGroupPartiallySelected("high")]).toEqual([false, true]);
	expect([s.isGroupFullySelected("medium"), s.isGroupPartiallySelected("medium")]).toEqual([false, false]);
	expect([s.isGroupFullySelected("low"), s.isGroupPartiallySelected("low")]).toEqual([false, false]);
});

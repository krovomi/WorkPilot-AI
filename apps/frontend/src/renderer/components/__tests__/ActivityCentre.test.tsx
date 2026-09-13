/**
 * The floating summary of work happening away from the current page.
 *
 * @vitest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
	}),
}));

vi.mock("../Sidebar", () => ({
	navItemLabelKey: (view: string) => `navigation:items.${view}`,
}));

import { ActivityCentre } from "../ActivityCentre";
import {
	finishActivity,
	startActivity,
	useActivityStore,
} from "../../stores/activity-store";

function begin(id: string, view: "ideation" | "doc-drift") {
	act(() =>
		startActivity({
			id,
			view,
			projectId: "p1",
			labelKey: "navigation:activity.kinds.scanning",
		}),
	);
}

describe("ActivityCentre", () => {
	beforeEach(() => {
		act(() => {
			useActivityStore.setState({
				activities: [],
				activeView: null,
				attention: null,
			});
		});
	});

	it("says nothing when nothing is happening", () => {
		const { container } = render(
			<ActivityCentre activeView="kanban" onOpen={vi.fn()} />,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("counts the work running on other pages", () => {
		begin("a", "doc-drift");
		begin("b", "ideation");

		render(<ActivityCentre activeView="kanban" onOpen={vi.fn()} />);

		expect(
			screen.getByText(/activityCentre\.running.*"count":2/),
		).toBeTruthy();
	});

	it("ignores the page the user is already looking at", () => {
		begin("a", "doc-drift");

		const { container } = render(
			<ActivityCentre activeView="doc-drift" onOpen={vi.fn()} />,
		);

		// Its own page shows that work in full; a floating pill repeating it is
		// noise.
		expect(container).toBeEmptyDOMElement();
	});

	it("leads with the failure when one is in the set", () => {
		begin("a", "doc-drift");
		begin("b", "ideation");
		act(() => {
			finishActivity("a", "success");
			finishActivity("b", "error", "boom");
		});

		render(<ActivityCentre activeView="kanban" onOpen={vi.fn()} />);

		expect(screen.getByText(/activityCentre\.failed.*"count":1/)).toBeTruthy();
	});

	it("keeps a finished job listed until its page has been visited", () => {
		begin("a", "doc-drift");
		act(() => finishActivity("a", "success"));

		render(<ActivityCentre activeView="kanban" onOpen={vi.fn()} />);
		expect(
			screen.getByText(/activityCentre\.finished.*"count":1/),
		).toBeTruthy();

		act(() => useActivityStore.getState().setActiveView("doc-drift"));

		expect(screen.queryByText(/activityCentre\.finished/)).toBeNull();
	});
});

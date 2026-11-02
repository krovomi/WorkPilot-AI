/**
 * The experimental marker must never take the label's room: it is a glyph on
 * the icon corner, not a word, and its meaning lives in the tooltip and the
 * accessible name.
 *
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

import { Activity } from "lucide-react";
import { ExperimentalMarker, NavIcon } from "../ExperimentalMarker";

describe("ExperimentalMarker", () => {
	it("renders an icon with no visible text, named for screen readers", () => {
		render(<ExperimentalMarker />);
		const marker = screen.getByRole("img", {
			name: "navigation:experimental.badge: navigation:experimental.tooltip",
		});
		expect(marker.textContent).toBe("");
		expect(marker.getAttribute("title")).toContain("navigation:experimental.tooltip");
		// Overlaid on the entry icon: it takes no room from the label.
		expect(marker.className).toContain("absolute");
	});

	it("marks an experimental entry's icon and leaves the others bare", () => {
		const { rerender } = render(<NavIcon icon={Activity} experimental />);
		expect(screen.getAllByTestId("experimental-marker")).toHaveLength(1);
		rerender(<NavIcon icon={Activity} experimental={false} />);
		expect(screen.queryByTestId("experimental-marker")).toBeNull();
	});
});

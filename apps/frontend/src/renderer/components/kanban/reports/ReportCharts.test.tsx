/**
 * The report charts on the edges: a chart of one point, and a day still to
 * come left out of a line.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LineChart } from "./ReportCharts";

describe("LineChart", () => {
	it("draws a single point in the middle, and skips the days still to come", () => {
		const { container } = render(
			<LineChart
				title="One day"
				labels={["Nov 3", "Nov 4"]}
				series={[
					{ key: "single", label: "Single", tone: "primary", values: [4, null] },
				]}
			/>,
		);
		expect(screen.getByRole("img", { name: "One day" })).toBeInTheDocument();
		expect(container.querySelector("polyline")?.getAttribute("points")?.split(" ")).toHaveLength(1);
	});

	it("centres the only label of a chart of one day", () => {
		const { container } = render(
			<LineChart title="Today" labels={["Nov 3"]} series={[{ key: "x", label: "X", tone: "info", values: [1] }]} />,
		);
		expect(container.querySelector("polyline")?.getAttribute("points")).toBe("290,10");
	});
});

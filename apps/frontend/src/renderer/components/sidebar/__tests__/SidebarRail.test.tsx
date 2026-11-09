/**
 * @vitest-environment jsdom
 *
 * The rail of spaces: one button per space, the one shown pressed, a choice
 * reported to the sidebar.
 */
import { DndContext } from "@dnd-kit/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { Code, FlaskConical, Star, Target } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../ui/tooltip";
import { type RailSpace, SidebarRail } from "../SidebarRail";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const space = (id: string, icon: RailSpace["icon"], extra: Partial<RailSpace> = {}): RailSpace => ({
	id,
	labelKey: `navigation:groups.${id}`,
	icon,
	badge: null,
	attention: false,
	...extra,
});

function renderRail(onSelect = vi.fn(), activeSpace = "workspace") {
	render(
		<DndContext>
			<TooltipProvider>
				<SidebarRail
					mine={space("__mine__", Star)}
					groups={[space("workspace", Target), space("development", Code)]}
					extras={[space("labo", FlaskConical, { count: 14 })]}
					activeSpace={activeSpace}
					isCollapsed={false}
					onSelect={onSelect}
					footer={<span>footer</span>}
				/>
			</TooltipProvider>
		</DndContext>,
	);
	return onSelect;
}

describe("SidebarRail", () => {
	it("shows « Mon menu », the groups and the extras, the space shown pressed", () => {
		renderRail();
		const buttons = screen.getAllByRole("button");
		expect(buttons.map((b) => b.dataset.space)).toEqual(["__mine__", "workspace", "development", "labo"]);
		expect(screen.getByRole("button", { name: "navigation:groups.workspace" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: "navigation:groups.development" })).toHaveAttribute("aria-pressed", "false");
		expect(screen.getByText("14")).toBeInTheDocument();
		expect(screen.getByText("footer")).toBeInTheDocument();
	});

	it("reports the space chosen", () => {
		const onSelect = renderRail();
		fireEvent.click(screen.getByRole("button", { name: "navigation:groups.development" }));
		expect(onSelect).toHaveBeenLastCalledWith("development");
		fireEvent.click(screen.getByRole("button", { name: "navigation:groups.__mine__" }));
		expect(onSelect).toHaveBeenLastCalledWith("__mine__");
	});

	it("is a labelled navigation landmark", () => {
		renderRail();
		expect(screen.getByRole("navigation", { name: "rail.label" })).toBeInTheDocument();
	});
});

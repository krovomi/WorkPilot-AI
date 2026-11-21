import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import i18n from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../../shared/types/task";
import type { NarrativeEvent } from "../../../lib/pixel-office-narratives";
import { seasonOf, seasonProgress } from "../../../lib/pixel-office-seasons";
import type { PixelAgent } from "../../../stores/pixel-office-store";
import { NarrativeFeed, sceneText } from "../NarrativeFeed";
import { OfficeScenesMenu } from "../OfficeScenesMenu";
import { ProviderLegend } from "../ProviderLegend";
import { SeasonPanel } from "../SeasonPanel";
import { useOfficeSeason } from "../use-office-season";

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

const HANDED: NarrativeEvent = {
	kind: "handed-to-qa",
	taskId: "t",
	title: "Dark mode",
	spec: "042",
	from: "coder",
	to: "reviewer",
	fromFamily: "openai",
};

describe("sceneText", () => {
	it("writes the scene with the roles, their provider and the spec", () => {
		expect(sceneText(i18n.t, HANDED)).toBe(
			"Coder (OpenAI) hands in their copy for spec #042 to QA Reviewer.",
		);
	});

	it("tells a delivery without naming anyone", () => {
		expect(
			sceneText(i18n.t, { kind: "shipped", taskId: "t", title: "Dark mode", spec: "7" }),
		).toBe("Delivered: spec #7. The whole office applauds.");
	});

	it("names the task when there is no spec number, in French too", async () => {
		await i18n.changeLanguage("fr");
		expect(sceneText(i18n.t, { ...HANDED, kind: "shipped", spec: "" })).toBe(
			"Livraison : « Dark mode ». Tout le bureau applaudit.",
		);
		expect(sceneText(i18n.t, { ...HANDED, kind: "qa-approved", from: "reviewer", to: "you", fromFamily: undefined })).toBe(
			"Reviewer QA valide la spec n°042 : à vous de jouer.",
		);
	});
});

describe("NarrativeFeed", () => {
	it("shows the model's sentence over the template, politely", () => {
		render(
			<NarrativeFeed
				calm={false}
				scenes={[
					{ id: 1, event: HANDED, at: 0 },
					{ id: 2, event: { ...HANDED, kind: "shipped" }, text: "It ships!", at: 0 },
				]}
			/>,
		);
		const list = screen.getByRole("list", { name: "Office scenes" });
		expect(list.getAttribute("aria-live")).toBe("polite");
		const [first, second] = screen.getAllByTestId("office-scene");
		expect(first.textContent).toContain("hands in their copy");
		expect(first.dataset.ai).toBe("false");
		expect(first.className).toContain("animate-in");
		expect(second.textContent).toBe("It ships!");
		expect(second.dataset.ai).toBe("true");
	});

	it("does not animate in calm mode", () => {
		render(<NarrativeFeed calm scenes={[{ id: 1, event: HANDED, at: 0 }]} />);
		expect(screen.getByTestId("office-scene").className).not.toContain("animate-in");
	});
});

describe("OfficeScenesMenu", () => {
	it("turns the scenes and the model on and off, the model only with scenes", () => {
		const onChange = vi.fn();
		const { rerender } = render(<OfficeScenesMenu enabled ai={false} onChange={onChange} />);
		fireEvent.click(screen.getByRole("button", { name: "Scene settings" }));
		expect(screen.getByText(/never the task's title or content/)).toBeTruthy();
		fireEvent.click(screen.getByRole("switch", { name: "Have the page's model write them" }));
		expect(onChange).toHaveBeenLastCalledWith({ narrativesAi: true });
		fireEvent.click(screen.getByRole("switch", { name: "Show scenes when a task changes hands" }));
		expect(onChange).toHaveBeenLastCalledWith({ narratives: false });

		rerender(<OfficeScenesMenu enabled={false} ai={false} onChange={onChange} />);
		expect(
			(screen.getByRole("switch", { name: "Have the page's model write them" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});
});

describe("ProviderLegend", () => {
	const agent = (providerFamily?: PixelAgent["providerFamily"]) =>
		({ id: String(providerFamily), providerFamily }) as PixelAgent;

	it("lists each family at work once, in a fixed order", () => {
		render(
			<ProviderLegend agents={[agent("ollama"), agent("anthropic"), agent("ollama"), agent()]} />,
		);
		expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
			"Anthropic",
			"Ollama",
		]);
	});

	it("shows nothing when no agent names a provider", () => {
		const { container } = render(<ProviderLegend agents={[agent()]} />);
		expect(container.innerHTML).toBe("");
	});
});

describe("SeasonPanel", () => {
	it("names the season, its end, each goal with its reward, and the decor earned", () => {
		const season = seasonOf(new Date(2026, 10, 21));
		const at = new Date(2026, 10, 2).getTime();
		const progress = seasonProgress(
			{
				ship: Array(31).fill(at),
				"qa-first-try": [at],
				debt: [],
				incidents: [],
				"second-opinion": [],
			},
			season,
		);
		render(
			<SeasonPanel season={season} progress={progress} decor={{ "trophy-shelf": "2026-Q4", plants: "2026-Q3" }} />,
		);
		const trigger = screen.getByRole("button", { name: "Show the goals of Season Q4 2026" });
		expect(trigger.textContent).toContain("1/5");
		fireEvent.click(trigger);
		expect(screen.getByText("Season Q4 2026")).toBeTruthy();
		expect(screen.getByText(/^Ends on /)).toBeTruthy();
		const ship = screen.getByTestId("season-goal-ship");
		expect(ship.dataset.done).toBe("true");
		expect(ship.textContent).toContain("Deliver 30 tasks");
		expect(ship.textContent).toContain("30/30");
		expect(ship.textContent).toContain("Reward: a trophy shelf");
		expect(screen.getByTestId("season-goal-qa-first-try").dataset.done).toBe("false");
		expect(screen.getByTestId("season-decor").textContent).toBe(
			"In the office: a trophy shelf, potted plants.",
		);
	});

	it("says how to decorate an office that has nothing yet", () => {
		const season = seasonOf(new Date(2026, 1, 1));
		render(<SeasonPanel season={season} progress={[]} decor={{}} />);
		fireEvent.click(screen.getByRole("button", { name: "Show the goals of Season Q1 2026" }));
		expect(screen.getByTestId("season-decor").textContent).toBe(
			"Meet a goal to decorate the office.",
		);
	});
});

describe("useOfficeSeason", () => {
	it("reads the season at now, counting no incident while they load", () => {
		const now = new Date(2026, 10, 21).getTime();
		const done = (id: string): Task =>
			({
				id,
				status: "done",
				updatedAt: new Date(2026, 10, 2),
				metadata: { kind: "refactoring" },
			}) as Task;
		const tasks = ["a", "b", "c", "d", "e"].map(done);
		const { result, rerender } = renderHook(
			({ incidents }) => useOfficeSeason(tasks, incidents, now),
			{ initialProps: { incidents: null as null | { status: string; resolvedAt?: number }[] } },
		);
		expect(result.current.season.id).toBe("2026-Q4");
		expect(result.current.decorIds).toEqual(["whiteboard"]);
		const at = new Date(2026, 10, 3).getTime();
		rerender({ incidents: [1, 2, 3].map(() => ({ status: "resolved", resolvedAt: at })) });
		expect(result.current.decorIds).toEqual(["whiteboard", "neon-sign"]);
		expect(result.current.progress.find((p) => p.goal.id === "incidents")?.done).toBe(true);
	});
});

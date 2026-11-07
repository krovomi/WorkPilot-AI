/**
 * @vitest-environment jsdom
 */
/**
 * La spec d'un round se choisit parmi celles du projet, jamais au clavier.
 *
 * Le champ « Identifiant de spec » retombait sur une saisie libre dès que la
 * liste était vide : on pouvait lancer un round sur « 001-my-feature », une
 * spec que personne n'avait écrite. Ces tests gardent la liste fermée.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../../stores/project-store";
import { useTaskStore } from "../../../stores/task-store";
import { BountyBoardView } from "../BountyBoardView";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
		i18n: { language: "en" },
	}),
}));

vi.mock("../../../hooks/useAgenticCapabilities", () => ({
	useAgenticCapabilities: () => ({ degradesTo: () => null }),
}));

vi.mock("../../../hooks/useAirgapStatus", () => ({
	useAirgapStatus: () => ({ airgapStrict: false, loaded: true }),
}));

vi.mock("../../offline-mode/AirgapBanner", () => ({
	AirgapBanner: () => null,
}));

vi.mock("../../../hooks/useProviderModelCatalog", () => ({
	useProviderModelCatalog: () => ({ models: [] }),
}));

const startBounty = vi.fn();
const loadArchives = vi.fn();
vi.mock("../../../stores/bounty-board-store", () => ({
	useBountyBoardStore: () => ({
		contestants: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
		current: null,
		archives: [],
		loading: false,
		error: null,
		addContestant: vi.fn(),
		updateContestant: vi.fn(),
		removeContestant: vi.fn(),
		startBounty,
		loadArchives,
	}),
}));

function task(projectId: string, specId: string, title: string) {
	return { id: `${projectId}:${specId}`, projectId, specId, title };
}

beforeEach(() => {
	startBounty.mockReset();
	loadArchives.mockReset();
	useProjectStore.setState({ selectedProjectId: "p-1", activeProjectId: null });
	useTaskStore.setState({ tasks: [], selectedTaskId: null });
});

describe("BountyBoardView spec field", () => {
	it("has no free-text input and is disabled when the project has no spec", () => {
		render(<BountyBoardView projectPath="/repo" />);

		expect(screen.queryByPlaceholderText("001-my-feature")).toBeNull();
		const select = screen.getByTestId("bounty-spec-select");
		expect(select).toBeDisabled();
		expect(select).toHaveTextContent("bountyBoard:noSpecs");
		expect(screen.getByText("bountyBoard:hint.noSpecs")).toBeInTheDocument();
		expect(loadArchives).not.toHaveBeenCalled();
	});

	it("preselects one of the current project's specs, never another project's", () => {
		useTaskStore.setState({
			tasks: [
				task("p-2", "009-elsewhere", "Elsewhere"),
				task("p-1", "002-login", "Login page"),
				task("p-1", "001-setup", "Setup"),
			] as never,
		});
		render(<BountyBoardView projectPath="/repo" />);

		const select = screen.getByTestId("bounty-spec-select");
		expect(select).not.toBeDisabled();
		expect(select).toHaveTextContent("Setup (001-setup)");
		expect(loadArchives).toHaveBeenCalledWith("/repo", "001-setup");
		expect(loadArchives).not.toHaveBeenCalledWith("/repo", "009-elsewhere");
	});

	it("ignores a requested spec id the project does not have", () => {
		useTaskStore.setState({
			tasks: [task("p-1", "001-setup", "Setup")] as never,
		});
		render(<BountyBoardView projectPath="/repo" specId="001-my-feature" />);

		expect(screen.getByTestId("bounty-spec-select")).toHaveTextContent(
			"Setup (001-setup)",
		);
		expect(loadArchives).not.toHaveBeenCalledWith("/repo", "001-my-feature");
	});
});

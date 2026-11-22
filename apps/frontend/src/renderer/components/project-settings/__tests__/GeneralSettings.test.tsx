/**
 * The project's general settings: WorkPilot AI's state in the project, the
 * repair offered for the blockers one click can clear (identity asked first
 * when git has none), the agent summary, each switch named and saved, the
 * automatic split's ceilings, and the secret field's show/hide toggle.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AutoBuildVersionInfo,
	InitializationBlocker,
	Project,
	ProjectSettings,
} from "../../../../shared/types";
import { useSettingsStore } from "../../../stores/settings-store";
import { GeneralSettings } from "../GeneralSettings";
import { PasswordInput } from "../PasswordInput";

const catalog = vi.hoisted(() => ({ models: [] as Array<{ label: string; tier?: string }> }));
const provider = vi.hoisted(() => ({ selectedProvider: "anthropic" as string | null }));

vi.mock("../../ProviderContext", () => ({ useProviderContext: () => provider }));
vi.mock("../../../hooks/useProviderModelCatalog", () => ({
	useProviderModelCatalog: (name: string) => {
		catalogFor(name);
		return catalog;
	},
}));
const catalogFor = vi.hoisted(() => vi.fn());
// Each has its own tests; here they only need to be placed.
vi.mock("../RepositorySection", () => ({ RepositorySection: () => <div data-testid="repository" /> }));
vi.mock("../WorktreeRecipeSection", () => ({
	WorktreeRecipeSection: ({ projectPath }: { projectPath: string }) => (
		<div data-testid="recipe">{projectPath}</div>
	),
}));
vi.mock("../CrossReviewSettings", () => ({ CrossReviewSettings: () => <div data-testid="cross-review" /> }));

const initialSettings = useSettingsStore.getState();

const BASE: ProjectSettings = {
	model: "opus",
	linearSync: false,
	notifications: { onTaskComplete: true, onTaskFailed: true, onReviewNeeded: false, sound: false },
};

const PROJECT = { id: "p1", name: "shop", path: "/work/shop", autoBuildPath: ".workpilot" } as Project;

interface Props {
	project?: Project;
	settings?: ProjectSettings;
	versionInfo?: AutoBuildVersionInfo | null;
	isCheckingVersion?: boolean;
	isUpdating?: boolean;
	initBlocker?: InitializationBlocker | null;
	isRepairingGit?: boolean;
}

const handleInitialize = vi.fn();
const handleRepairGit = vi.fn();
let latest: ProjectSettings;

function Host({ settings: initial = BASE, ...props }: Props) {
	const [settings, setSettings] = useState(initial);
	latest = settings;
	return (
		<GeneralSettings
			project={props.project ?? PROJECT}
			settings={settings}
			setSettings={setSettings}
			versionInfo={props.versionInfo ?? null}
			isCheckingVersion={props.isCheckingVersion ?? false}
			isUpdating={props.isUpdating ?? false}
			handleInitialize={handleInitialize}
			initBlocker={props.initBlocker ?? null}
			isRepairingGit={props.isRepairingGit ?? false}
			handleRepairGit={handleRepairGit}
		/>
	);
}

const NOT_INITIALIZED = { ...PROJECT, autoBuildPath: "" } as Project;

beforeEach(async () => {
	vi.resetAllMocks();
	await i18n.changeLanguage("en");
	catalog.models = [];
	provider.selectedProvider = "anthropic";
});

afterEach(() => {
	useSettingsStore.setState(initialSettings, true);
});

describe("GeneralSettings, WorkPilot AI in the project", () => {
	it("shows where it is initialized, and its checked state", () => {
		const view = render(<Host isCheckingVersion />);
		expect(screen.getByTestId("repository")).toBeTruthy();
		expect(screen.getByText(".workpilot")).toBeTruthy();
		expect(screen.getByText("Checking status...")).toBeTruthy();
		view.unmount();

		const answered = render(<Host versionInfo={{ isInitialized: false } as AutoBuildVersionInfo} />);
		expect(screen.getAllByText("Not Initialized")).toHaveLength(1);
		answered.unmount();

		render(<Host versionInfo={{ isInitialized: true } as AutoBuildVersionInfo} />);
		expect(screen.getAllByText("Initialized")).toHaveLength(2);
		expect(screen.getByTestId("recipe").textContent).toBe("/work/shop");
	});

	it("offers to initialize, and says it is on its way", async () => {
		const user = userEvent.setup();
		const view = render(<Host project={NOT_INITIALIZED} />);
		await user.click(screen.getByRole("button", { name: "Initialize WorkPilot AI" }));
		expect(handleInitialize).toHaveBeenCalledOnce();
		expect(screen.queryByRole("switch")).toBeNull();
		view.unmount();

		render(<Host project={NOT_INITIALIZED} isUpdating />);
		expect(screen.getByRole("button", { name: "Initializing..." })).toHaveProperty("disabled", true);
	});

	it("prepares a folder that is not a repository, with every step said", async () => {
		const user = userEvent.setup();
		render(<Host project={NOT_INITIALIZED} initBlocker="not-a-git-repo" />);
		expect(screen.getByText("This folder is not a Git repository yet")).toBeTruthy();
		expect(screen.getByText("Create the git repository (git init)")).toBeTruthy();
		expect(screen.getByText("git init")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Prepare the repository and initialize" }));
		expect(handleRepairGit).toHaveBeenCalledWith(undefined);
	});

	it("prepares a repository without a commit, without git init", () => {
		render(<Host project={NOT_INITIALIZED} initBlocker="no-commits" isRepairingGit />);
		expect(screen.getByText("This repository has no commit yet")).toBeTruthy();
		expect(screen.queryByText("Create the git repository (git init)")).toBeNull();
		expect(screen.queryByText("git init")).toBeNull();
		expect(screen.getByRole("button", { name: "Preparing the repository..." })).toHaveProperty("disabled", true);
		expect(screen.getByRole("button", { name: "Initialize WorkPilot AI" })).toHaveProperty("disabled", true);
	});

	it("asks for the git identity before the first commit, and sends it", async () => {
		const user = userEvent.setup();
		render(<Host project={NOT_INITIALIZED} initBlocker="git-identity-missing" />);
		const repair = screen.getByRole("button", { name: "Prepare the repository and initialize" });
		expect(repair).toHaveProperty("disabled", true);
		await user.type(screen.getByLabelText("Name"), "Jane Doe");
		await user.type(screen.getByLabelText("Email"), "not an email");
		expect(repair).toHaveProperty("disabled", true);
		await user.clear(screen.getByLabelText("Email"));
		await user.type(screen.getByLabelText("Email"), "jane@example.com");
		await user.click(repair);
		expect(handleRepairGit).toHaveBeenCalledWith({ name: "Jane Doe", email: "jane@example.com" });
	});

	it("reports what a click cannot clear", () => {
		const view = render(<Host project={NOT_INITIALIZED} initBlocker="path-missing" />);
		expect(screen.getByText(/The folder \/work\/shop no longer exists/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Prepare the repository/ })).toBeNull();
		view.unmount();

		render(<Host project={NOT_INITIALIZED} initBlocker="already-initialized" />);
		expect(screen.getByText(/already has a .workpilot folder/)).toBeTruthy();
	});
});

describe("GeneralSettings, agent and switches", () => {
	it("sums up the agent profile and the flagship model, and opens the agent settings", async () => {
		const user = userEvent.setup();
		catalog.models = [{ label: "Fast" }, { label: "Deep", tier: "flagship" }];
		useSettingsStore.setState({
			settings: { ...useSettingsStore.getState().settings, selectedAgentProfile: "balanced" },
		});
		const navigate = vi.fn();
		globalThis.addEventListener("app-settings:navigate", navigate);
		render(<Host />);
		expect(catalogFor).toHaveBeenCalledWith("anthropic");
		const summary = screen.getByRole("button", { name: /Profile: .* · Flagship model: Deep/ });
		await user.click(summary);
		globalThis.removeEventListener("app-settings:navigate", navigate);
		expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: "agent" });
	});

	it("falls back to the first model, then to a dash, and to the default profile and provider", () => {
		provider.selectedProvider = null;
		catalog.models = [{ label: "Only" }];
		useSettingsStore.setState({
			settings: { ...useSettingsStore.getState().settings, selectedAgentProfile: "gone" },
		});
		const view = render(<Host />);
		expect(catalogFor).toHaveBeenCalledWith("anthropic");
		expect(screen.getByText(/Profile: Auto \(Optimized\) · Flagship model: Only/)).toBeTruthy();
		view.unmount();

		catalog.models = [];
		useSettingsStore.setState({
			settings: { ...useSettingsStore.getState().settings, selectedAgentProfile: undefined },
		});
		render(<Host />);
		expect(screen.getByText(/Profile: Auto \(Optimized\) · Flagship model: —/)).toBeTruthy();
	});

	it("names every switch and saves it, with its default", async () => {
		const user = userEvent.setup();
		render(<Host />);
		const toggle = (name: string) => screen.getByRole("switch", { name });
		expect(toggle("Use CLAUDE.md").getAttribute("aria-checked")).toBe("true");
		expect(toggle("TDD Mode").getAttribute("aria-checked")).toBe("false");
		expect(toggle("Verification loop").getAttribute("aria-checked")).toBe("true");
		expect(toggle("Integration tests first (ASP.NET Core)").getAttribute("aria-checked")).toBe("false");

		for (const name of [
			"Use CLAUDE.md",
			"TDD Mode",
			"Verification loop",
			"Integration tests first (ASP.NET Core)",
			"On Task Complete",
			"On Task Failed",
			"On Review Needed",
			"Sound",
		]) {
			await user.click(toggle(name));
		}
		expect(latest).toMatchObject({
			useClaudeMd: false,
			tddMode: true,
			verifyLoop: false,
			specByExample: true,
			notifications: { onTaskComplete: false, onTaskFailed: false, onReviewNeeded: true, sound: true },
		});
		expect(screen.getByTestId("cross-review")).toBeTruthy();
	});
});

describe("General settings layout", () => {
	it("groups the task settings in the order a task is built", () => {
		render(<Host />);
		const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
		const order = ["Agent Configuration", "Before coding", "While coding", "Before review", "Notifications"];
		const at = order.map((title) => headings.indexOf(title));
		expect(at.every((i) => i >= 0)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
	});

	it("puts each setting in its group", () => {
		render(<Host />);
		const groupOf = (name: string) =>
			screen.getByRole("switch", { name }).closest("section")?.querySelector("h3")?.textContent;
		expect(groupOf("Split big tasks automatically")).toBe("Before coding");
		expect(groupOf("Integration tests first (ASP.NET Core)")).toBe("Before coding");
		expect(groupOf("TDD Mode")).toBe("While coding");
		expect(groupOf("Verification loop")).toBe("Before review");
		expect(screen.getByTestId("cross-review").closest("section")?.querySelector("h3")?.textContent).toBe(
			"Before review",
		);
	});
});

describe("AutoSplitSettings", () => {
	const split = () => screen.getByRole("switch", { name: "Split big tasks automatically" });

	it("is on by default, with each kind's default shown, and can be turned off", async () => {
		const user = userEvent.setup();
		render(<Host />);
		expect(split().getAttribute("aria-checked")).toBe("true");
		const feature = screen.getByLabelText("Feature") as HTMLInputElement;
		expect(feature.value).toBe("");
		expect(feature.placeholder).toMatch(/^\d+$/);
		expect((screen.getByLabelText("Max files per pull request") as HTMLInputElement).placeholder).toBe("25");
		await user.click(split());
		expect(latest.autoSplit).toEqual({ enabled: false });
		expect(screen.queryByLabelText("Feature")).toBeNull();
	});

	it("keeps a ceiling per kind and for files, back to the default when emptied", () => {
		render(<Host settings={{ ...BASE, autoSplit: { enabled: true, maxLinesByKind: { docs: 900 } } }} />);
		fireEvent.change(screen.getByLabelText("Feature"), { target: { value: "300" } });
		fireEvent.change(screen.getByLabelText("Max files per pull request"), { target: { value: "12" } });
		expect(latest.autoSplit).toEqual({ enabled: true, maxLinesByKind: { docs: 900, feature: 300 }, maxFiles: 12 });

		fireEvent.change(screen.getByLabelText("Documentation"), { target: { value: "  " } });
		fireEvent.change(screen.getByLabelText("Max files per pull request"), { target: { value: "" } });
		expect(latest.autoSplit).toEqual({ enabled: true, maxLinesByKind: { feature: 300 }, maxFiles: undefined });
	});

	it("starts the per-kind ceilings from nothing", () => {
		render(<Host settings={{ ...BASE, autoSplit: { enabled: true } }} />);
		fireEvent.change(screen.getByLabelText("Feature"), { target: { value: "400" } });
		expect(latest.autoSplit).toEqual({ enabled: true, maxLinesByKind: { feature: 400 } });
	});

	it("says when a ceiling is out of range, and that the default applies meanwhile", () => {
		render(<Host settings={{ ...BASE, autoSplit: { maxLinesByKind: { feature: 10 }, maxFiles: 2.5 } }} />);
		expect(screen.getByLabelText("Feature").getAttribute("aria-invalid")).toBe("true");
		expect(screen.getByLabelText("Max files per pull request").getAttribute("aria-invalid")).toBe("true");
		expect(screen.getAllByText(/Enter a whole number between/)).toHaveLength(2);
		expect(screen.getByText(/between 2 and 1000/)).toBeTruthy();
	});
});

describe("PasswordInput", () => {
	function Secret() {
		const [value, setValue] = useState("");
		return <PasswordInput value={value} onChange={setValue} placeholder="Token" data-guide="token" />;
	}

	it("hides the value until asked, and says what the toggle does", async () => {
		const user = userEvent.setup();
		render(<Secret />);
		const field = screen.getByPlaceholderText("Token") as HTMLInputElement;
		expect(field.type).toBe("password");
		expect(field.dataset.guide).toBe("token");
		expect(field.className).toContain("pr-10");
		await user.type(field, "ghp_example");
		expect(field.value).toBe("ghp_example");

		await user.click(screen.getByRole("button", { name: "Show the value" }));
		expect(field.type).toBe("text");
		const hide = screen.getByRole("button", { name: "Hide the value" });
		expect(hide.getAttribute("aria-pressed")).toBe("true");
		await user.click(hide);
		expect(field.type).toBe("password");
	});

	it("speaks the app's language and keeps a class it is given", async () => {
		await i18n.changeLanguage("fr");
		render(<PasswordInput value="" onChange={vi.fn()} className="w-full" />);
		expect(screen.getByRole("button", { name: "Afficher la valeur" })).toBeTruthy();
		expect(document.querySelector("input")?.className).toContain("w-full");
	});
});

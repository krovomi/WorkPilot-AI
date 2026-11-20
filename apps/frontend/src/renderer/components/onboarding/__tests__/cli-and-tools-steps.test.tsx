/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { ClaudeCodeStep } from "../ClaudeCodeStep";
import { DevToolsStep } from "../DevToolsStep";

// One t for every render, as react-i18next gives: the version check depends on it.
vi.mock("react-i18next", () => {
	const t = (key: string) => key;
	return { useTranslation: () => ({ t }) };
});

// Radix Select needs pointer capture jsdom lacks: a list of options stands in.
const SelectContext = createContext<(value: string) => void>(() => undefined);
vi.mock("../../ui/select", () => ({
	Select: ({
		value,
		onValueChange,
		disabled,
		children,
	}: {
		value: string;
		onValueChange: (value: string) => void;
		disabled?: boolean;
		children: ReactNode;
	}) => (
		<SelectContext.Provider value={onValueChange}>
			<fieldset data-value={value} disabled={disabled}>
				{children}
			</fieldset>
		</SelectContext.Provider>
	),
	SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
	SelectValue: () => null,
	SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
	SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
		const choose = useContext(SelectContext);
		return (
			<button type="button" data-option={value} onClick={() => choose(value)}>
				{children}
			</button>
		);
	},
}));

const storeState: {
	settings: Record<string, string | undefined>;
	updateSettings: ReturnType<typeof vi.fn>;
} = { settings: {}, updateSettings: vi.fn() };
vi.mock("../../../stores/settings-store", () => ({
	useSettingsStore: (selector: (s: typeof storeState) => unknown) =>
		selector(storeState),
}));

const api = {
	checkClaudeCodeVersion: vi.fn(),
	installClaudeCode: vi.fn(),
	openExternal: vi.fn(),
	worktreeDetectTools: vi.fn(),
	saveSettings: vi.fn(),
};

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	storeState.settings = {};
	storeState.updateSettings = vi.fn();
	Object.assign(window, { electronAPI: api });
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const version = (installed: string | null, isOutdated = false, extra = {}) => ({
	success: true,
	data: { installed, latest: "2.0.0", isOutdated, ...extra },
});

function renderCli() {
	const props = { onNext: vi.fn(), onBack: vi.fn(), onSkip: vi.fn() };
	render(<ClaudeCodeStep {...props} />);
	return props;
}

describe("ClaudeCodeStep", () => {
	it("shows an up-to-date install with its version, path and a plain Continue", async () => {
		api.checkClaudeCodeVersion.mockResolvedValue(
			version("2.0.0", false, { path: "/usr/local/bin/claude" }),
		);
		const props = renderCli();

		expect(screen.getByText("cli.detecting")).toBeInTheDocument();
		expect(await screen.findByText("cli.status.installed")).toBeInTheDocument();
		expect(screen.getAllByText("2.0.0")).toHaveLength(2);
		expect(screen.getByText("/usr/local/bin/claude")).toBeInTheDocument();
		expect(screen.queryByText("cli.install.button")).not.toBeInTheDocument();

		fireEvent.click(screen.getByText("common:buttons.continue"));
		fireEvent.click(screen.getByText("common:buttons.skip"));
		fireEvent.click(screen.getByText("common:buttons.back"));
		expect(props.onNext).toHaveBeenCalledOnce();
		expect(props.onSkip).toHaveBeenCalledOnce();
		expect(props.onBack).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByText("cli.learnMore"));
		expect(api.openExternal).toHaveBeenCalledWith("https://claude.ai/code");
	});

	it("hides an unknown latest version", async () => {
		api.checkClaudeCodeVersion.mockResolvedValue({
			success: true,
			data: { installed: "1.0.0", latest: "unknown", isOutdated: false },
		});
		renderCli();
		await screen.findByText("1.0.0");
		expect(screen.queryByText("cli.version.latest")).not.toBeInTheDocument();
	});

	it("offers an update when the install is outdated", async () => {
		api.checkClaudeCodeVersion.mockResolvedValue(version("1.0.0", true));
		renderCli();
		expect(await screen.findByText("cli.status.outdated")).toBeInTheDocument();
		expect(screen.getByText("cli.install.updating")).toBeInTheDocument();
		expect(screen.getByText("common:buttons.continueAnyway")).toBeInTheDocument();
	});

	it("installs, says so, then checks again after a pause", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		api.checkClaudeCodeVersion.mockResolvedValue(version(null));
		let finish: (value: { success: boolean }) => void = () => undefined;
		api.installClaudeCode.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		renderCli();
		await act(() => vi.advanceTimersByTimeAsync(0));
		expect(screen.getByText("cli.status.notFound")).toBeInTheDocument();
		// Nothing installed: no version lines at all.
		expect(screen.queryByText("cli.version.current")).not.toBeInTheDocument();

		fireEvent.click(screen.getByText("cli.install.button"));
		expect(screen.getByText("cli.install.inProgress")).toBeInTheDocument();
		await act(async () => finish({ success: true }));
		expect(screen.getByText("cli.install.success")).toBeInTheDocument();
		expect(api.checkClaudeCodeVersion).toHaveBeenCalledTimes(1);

		api.checkClaudeCodeVersion.mockResolvedValue(version("2.0.0"));
		await act(() => vi.advanceTimersByTimeAsync(5000));
		expect(api.checkClaudeCodeVersion).toHaveBeenCalledTimes(2);
		expect(screen.getByText("cli.status.installed")).toBeInTheDocument();
	});

	it("drops the pending check when the step closes", async () => {
		// The timer used to fire after the wizard moved on and set state on an unmounted step.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		api.checkClaudeCodeVersion.mockResolvedValue(version(null));
		api.installClaudeCode.mockResolvedValue({ success: true });
		const { unmount } = render(
			<ClaudeCodeStep onNext={vi.fn()} onBack={vi.fn()} onSkip={vi.fn()} />,
		);
		await act(() => vi.advanceTimersByTimeAsync(0));
		fireEvent.click(screen.getByText("cli.install.button"));
		await act(() => vi.advanceTimersByTimeAsync(0));
		unmount();
		await vi.advanceTimersByTimeAsync(5000);
		expect(api.checkClaudeCodeVersion).toHaveBeenCalledTimes(1);
	});

	it("unmounts cleanly when no install was started", async () => {
		api.checkClaudeCodeVersion.mockResolvedValue(version("2.0.0"));
		const { unmount } = render(
			<ClaudeCodeStep onNext={vi.fn()} onBack={vi.fn()} onSkip={vi.fn()} />,
		);
		await screen.findByText("cli.status.installed");
		expect(() => unmount()).not.toThrow();
	});

	it.each([
		[{ success: false, error: "npm missing" }, "npm missing"],
		[{ success: false }, "cli.errors.installFailed"],
	])("shows a refused install (%o) under the status", async (answer, shown) => {
		api.checkClaudeCodeVersion.mockResolvedValue(version(null));
		api.installClaudeCode.mockResolvedValue(answer);
		renderCli();
		fireEvent.click(await screen.findByText("cli.install.button"));
		expect(await screen.findByText(shown)).toBeInTheDocument();
		expect(screen.getByText("cli.status.notFound")).toBeInTheDocument();
	});

	it.each([
		[new Error("spawn failed"), "spawn failed"],
		["boom", "cli.errors.installFailed"],
	])("shows a thrown install error (%s)", async (thrown, shown) => {
		api.checkClaudeCodeVersion.mockResolvedValue(version(null));
		api.installClaudeCode.mockRejectedValue(thrown);
		renderCli();
		fireEvent.click(await screen.findByText("cli.install.button"));
		expect(await screen.findByText(shown)).toBeInTheDocument();
	});

	it.each([
		["a refusal with a reason", () => ({ success: false, error: "no PATH" }), "no PATH"],
		["a refusal without one", () => ({ success: false }), "cli.errors.checkFailed"],
		["a thrown error", () => Promise.reject(new Error("ipc down")), "ipc down"],
		["a thrown value", () => Promise.reject("x"), "cli.errors.checkFailed"],
	])("shows a failed check once, as the status: %s", async (_label, answer, shown) => {
		api.checkClaudeCodeVersion.mockImplementation(answer);
		renderCli();
		// Only the status line carries it, not a second error card.
		expect(await screen.findAllByText(shown)).toHaveLength(1);
		expect(screen.queryByText("cli.install.button")).not.toBeInTheDocument();
	});

	it("checks again from the refresh button", async () => {
		api.checkClaudeCodeVersion.mockResolvedValueOnce({ success: false });
		api.checkClaudeCodeVersion.mockResolvedValueOnce(version("2.0.0"));
		renderCli();
		await screen.findByText("cli.errors.checkFailed");
		fireEvent.click(screen.getByRole("button", { name: "cli.refresh" }));
		expect(await screen.findByText("cli.status.installed")).toBeInTheDocument();
	});
});

const detected = {
	success: true,
	data: {
		ides: [{ id: "cursor", name: "Cursor", path: "/c", installed: true }],
		terminals: [
			{ id: "system", name: "System", path: "", installed: true },
			{ id: "kitty", name: "Kitty", path: "/k", installed: true },
		],
	},
};

function renderTools() {
	const props = { onNext: vi.fn(), onBack: vi.fn() };
	render(<DevToolsStep {...props} />);
	return props;
}

const options = (field: number) =>
	Array.from(
		screen.getAllByRole("group")[field].querySelectorAll("button[data-option]"),
		(b) => b.getAttribute("data-option"),
	);

describe("DevToolsStep", () => {
	it("lists detected tools first, then the rest, then a custom entry", async () => {
		api.worktreeDetectTools.mockResolvedValue(detected);
		renderTools();
		expect(screen.getByText("onboarding:devtools.detecting")).toBeInTheDocument();
		await screen.findByText("onboarding:devtools.title");
		await waitFor(() => expect(options(0)[0]).toBe("cursor"));

		const ides = options(0);
		expect(ides.filter((id) => id === "cursor")).toHaveLength(1);
		expect(ides.at(-1)).toBe("custom");
		const terminals = options(1);
		expect(terminals.slice(0, 2)).toEqual(["system", "kitty"]);
		expect(terminals.filter((id) => id === "kitty")).toHaveLength(1);
		expect(terminals.at(-1)).toBe("custom");
		expect(screen.getByText("onboarding:devtools.systemTerminal")).toBeInTheDocument();
		expect(screen.queryByText("onboarding:devtools.noToolsDetected")).not.toBeInTheDocument();
		// The first detected IDE is picked when none was configured.
		expect(screen.getAllByRole("group")[0]).toHaveAttribute("data-value", "cursor");
	});

	it("keeps a configured IDE and saves the choice", async () => {
		storeState.settings = { preferredIDE: "zed", preferredTerminal: "kitty" };
		api.worktreeDetectTools.mockResolvedValue(detected);
		api.saveSettings.mockResolvedValue({ success: true });
		const props = renderTools();
		await screen.findByText("onboarding:devtools.title");
		expect(screen.getAllByRole("group")[0]).toHaveAttribute("data-value", "zed");

		fireEvent.click(screen.getByText("onboarding:devtools.saveAndContinue"));
		await waitFor(() => expect(props.onNext).toHaveBeenCalledOnce());
		const saved = {
			preferredIDE: "zed",
			preferredTerminal: "kitty",
			customIDEPath: undefined,
			customTerminalPath: undefined,
		};
		expect(api.saveSettings).toHaveBeenCalledWith(saved);
		expect(storeState.updateSettings).toHaveBeenCalledWith(saved);
	});

	it("saves custom paths only for custom tools", async () => {
		storeState.settings = { customIDEPath: "/old/ide" };
		api.worktreeDetectTools.mockResolvedValue({
			success: true,
			data: { ides: [], terminals: [] },
		});
		api.saveSettings.mockResolvedValue({ success: true });
		renderTools();
		await screen.findByText("onboarding:devtools.title");
		expect(screen.getByText("onboarding:devtools.noToolsDetected")).toBeInTheDocument();
		// Nothing detected and nothing configured: the defaults stay.
		expect(screen.getAllByRole("group")[0]).toHaveAttribute("data-value", "vscode");

		const [ideCustom, terminalCustom] = screen
			.getAllByRole("group")
			.map((g) => g.querySelector('button[data-option="custom"]') as HTMLElement);
		fireEvent.click(ideCustom);
		fireEvent.click(terminalCustom);
		expect(screen.getByLabelText("onboarding:devtools.ide.customPath")).toHaveValue(
			"/old/ide",
		);
		fireEvent.change(screen.getByLabelText("onboarding:devtools.terminal.customPath"), {
			target: { value: "/opt/term" },
		});
		fireEvent.change(screen.getByLabelText("onboarding:devtools.ide.customPath"), {
			target: { value: "/opt/ide" },
		});
		fireEvent.click(screen.getByText("onboarding:devtools.saveAndContinue"));
		await waitFor(() =>
			expect(api.saveSettings).toHaveBeenCalledWith({
				preferredIDE: "custom",
				preferredTerminal: "custom",
				customIDEPath: "/opt/ide",
				customTerminalPath: "/opt/term",
			}),
		);
	});

	it.each([
		["a refusal with a reason", () => Promise.resolve({ success: false, error: "disk full" }), "disk full"],
		["a refusal without one", () => Promise.resolve(undefined), "onboarding:devtools.saveFailed"],
		["a thrown error", () => Promise.reject(new Error("ipc down")), "ipc down"],
		["a thrown value", () => Promise.reject("x"), "onboarding:devtools.saveFailed"],
	])("stays on the step after %s", async (_label, answer, shown) => {
		api.worktreeDetectTools.mockResolvedValue(detected);
		api.saveSettings.mockImplementation(answer);
		const props = renderTools();
		await screen.findByText("onboarding:devtools.title");
		fireEvent.click(screen.getByText("onboarding:devtools.saveAndContinue"));
		expect(await screen.findByText(shown)).toBeInTheDocument();
		expect(props.onNext).not.toHaveBeenCalled();
		expect(storeState.updateSettings).not.toHaveBeenCalled();
	});

	it("lists every known tool when detection fails or is refused", async () => {
		api.worktreeDetectTools.mockRejectedValueOnce(new Error("no which"));
		api.worktreeDetectTools.mockResolvedValueOnce({ success: false });
		renderTools();
		await screen.findByText("onboarding:devtools.title");
		expect(options(0)).toContain("vscode");
		expect(options(1)[0]).toBe("system");

		fireEvent.click(screen.getByText("onboarding:devtools.detectAgain"));
		await screen.findByText("onboarding:devtools.title");
		expect(api.worktreeDetectTools).toHaveBeenCalledTimes(2);
		expect(options(0)[0]).toBe("androidstudio");
	});

	it("goes back without saving", async () => {
		api.worktreeDetectTools.mockResolvedValue(detected);
		const props = renderTools();
		await screen.findByText("onboarding:devtools.title");
		fireEvent.click(screen.getByText("common:buttons.back"));
		expect(props.onBack).toHaveBeenCalledOnce();
		expect(api.saveSettings).not.toHaveBeenCalled();
	});
});

/**
 * The plugin creator: a type, then the plugin's details (the id follows the
 * name and must be a folder name the main process accepts), then a preview
 * that is the `plugin.config.json` the main process writes. Creating it, a
 * failure at any step, copying the preview and opening the created folder
 * show what happened.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { PluginCreatorWizard } from "../PluginCreatorWizard";

const invoke = vi.fn();
const writeText = vi.fn();
const onClose = vi.fn();

beforeEach(async () => {
	await i18n.changeLanguage("en");
	invoke.mockReset();
	writeText.mockReset().mockResolvedValue(undefined);
	onClose.mockReset();
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = { invoke };
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
});

afterEach(() => {
	vi.useRealTimers();
});

const next = () => screen.getByRole("button", { name: /^Next/ });
const preview = () => JSON.parse(screen.getByText(/"id":/).textContent ?? "");

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Picks `type`, names the plugin and moves to the details step. */
function startWith(typeLabel: RegExp, name = "My Reviewer") {
	const view = render(<PluginCreatorWizard onClose={onClose} />);
	fireEvent.click(screen.getByRole("button", { name: typeLabel }));
	fireEvent.click(next());
	fireEvent.change(screen.getByLabelText("Plugin name"), {
		target: { value: name },
	});
	return view;
}

describe("PluginCreatorWizard", () => {
	it("asks for a type before the details, named in words", () => {
		render(<PluginCreatorWizard onClose={onClose} />);
		expect(screen.getByText("Choose the type of plugin you want to create.")).toBeInTheDocument();
		expect(next()).toBeDisabled();
		for (const label of ["Agent", "Integration", "Spec Template", "Theme", "Custom Prompt"]) {
			expect(screen.getByRole("button", { name: new RegExp(`^${label}`) })).toHaveAttribute(
				"aria-pressed",
				"false",
			);
		}
		expect(screen.queryByText("spec-template")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /^Agent/ }));
		expect(screen.getByRole("button", { name: /^Agent/ })).toHaveAttribute("aria-pressed", "true");
		expect(next()).toBeEnabled();
		expect(screen.getByRole("button", { name: /1\s*Type/ })).toHaveAttribute("aria-current", "step");
	});

	it("derives the id from the name and refuses one the main process cannot use", () => {
		startWith(/^Agent/);
		expect(screen.getByLabelText("Plugin ID")).toHaveValue("my-reviewer");
		expect(screen.getByText("Unique identifier (auto-generated from name)")).toBeInTheDocument();
		expect(next()).toBeEnabled();

		fireEvent.change(screen.getByLabelText("Plugin ID"), {
			target: { value: "../Reviewer" },
		});
		expect(screen.getByLabelText("Plugin ID")).toHaveAttribute("aria-invalid", "true");
		expect(
			screen.getByText("Use lowercase letters, digits and single hyphens (my-plugin)"),
		).toBeInTheDocument();
		expect(next()).toBeDisabled();

		// A name with no letter or digit gives no id at all.
		fireEvent.change(screen.getByLabelText("Plugin name"), { target: { value: "!!!" } });
		expect(screen.getByLabelText("Plugin ID")).toHaveValue("");
		expect(next()).toBeDisabled();

		fireEvent.change(screen.getByLabelText("Plugin name"), { target: { value: "   " } });
		fireEvent.change(screen.getByLabelText("Plugin ID"), { target: { value: "ok" } });
		expect(next()).toBeDisabled();
	});

	it("previews the agent config it writes, then creates it and opens its folder", async () => {
		startWith(/^Agent/);
		fireEvent.change(screen.getByLabelText("Description"), {
			target: { value: "Reviews code" },
		});
		fireEvent.change(screen.getByLabelText("Version"), { target: { value: "2.0.0" } });
		fireEvent.change(screen.getByLabelText("System prompt"), {
			target: { value: "You review." },
		});
		expect(screen.getByLabelText("Trigger keywords")).toHaveAttribute(
			"placeholder",
			"audit code, check quality",
		);
		fireEvent.change(screen.getByLabelText("Trigger keywords"), {
			target: { value: "review, , audit " },
		});
		fireEvent.click(next());

		expect(screen.getByText("Review the generated configuration for your plugin.")).toBeInTheDocument();
		expect(screen.getByText("Written to plugin.config.json in the plugin folder")).toBeInTheDocument();
		expect(screen.getByText("My Reviewer")).toBeInTheDocument();
		expect(screen.getByText("v2.0.0")).toBeInTheDocument();
		expect(screen.getByText("Agent")).toBeInTheDocument();
		expect(screen.getByText("Reviews code")).toBeInTheDocument();
		expect(preview()).toEqual({
			id: "my-reviewer",
			name: "My Reviewer",
			type: "agent",
			version: "2.0.0",
			description: "Reviews code",
			systemPrompt: "You review.",
			triggers: ["review", "audit"],
		});

		invoke.mockResolvedValueOnce({
			success: true,
			data: { path: "/data/plugin-marketplace/local/my-reviewer" },
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Create a Plugin" }));
		});
		expect(invoke).toHaveBeenCalledWith("pluginMarketplace:create", {
			type: "agent",
			id: "my-reviewer",
			name: "My Reviewer",
			description: "Reviews code",
			version: "2.0.0",
			systemPrompt: "You review.",
			triggerKeywords: "review, , audit ",
			authType: "none",
			apiEndpoint: "",
			primaryColor: "#8b5cf6",
			backgroundColor: "#0a0a1a",
			templateContent: "",
		});
		expect(screen.getByText("Plugin created!")).toBeInTheDocument();
		expect(
			screen.getByText('Your plugin "My Reviewer" has been scaffolded successfully.'),
		).toBeInTheDocument();
		expect(screen.getByText("/data/plugin-marketplace/local/my-reviewer")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Next/ })).not.toBeInTheDocument();

		invoke.mockResolvedValueOnce({ success: true });
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
		});
		expect(invoke).toHaveBeenLastCalledWith(
			"pluginMarketplace:openLocalFolder",
			"/data/plugin-marketplace/local/my-reviewer",
		);

		invoke.mockResolvedValueOnce({ success: false, error: "No application" });
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
		});
		expect(screen.getByText("No application")).toBeInTheDocument();

		invoke.mockResolvedValueOnce(undefined);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
		});
		expect(screen.getByText("Could not open the plugin folder")).toBeInTheDocument();

		invoke.mockRejectedValueOnce(new Error("IPC closed"));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
		});
		expect(screen.getByText("IPC closed")).toBeInTheDocument();

		invoke.mockRejectedValueOnce("gone");
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
		});
		expect(screen.getByText("Could not open the plugin folder")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("leaves out the triggers when none are typed, and shows a dash for no description", () => {
		startWith(/^Agent/);
		fireEvent.change(screen.getByLabelText("Trigger keywords"), { target: { value: "  " } });
		fireEvent.click(next());
		expect(screen.getByText("—")).toBeInTheDocument();
		expect(preview()).toEqual({
			id: "my-reviewer",
			name: "My Reviewer",
			type: "agent",
			version: "1.0.0",
			description: "",
			systemPrompt: "",
		});
	});

	it("previews an integration with its authentication and endpoint", () => {
		startWith(/^Integration/, "Billing API");
		expect(screen.getByRole("option", { name: "OAuth" })).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Authentication type"), {
			target: { value: "apikey" },
		});
		fireEvent.click(next());
		expect(preview()).toMatchObject({ type: "integration", authType: "apikey" });
		expect(preview()).not.toHaveProperty("apiEndpoint");

		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		fireEvent.change(screen.getByLabelText("API endpoint"), {
			target: { value: "https://billing.example.com" },
		});
		fireEvent.click(next());
		expect(preview()).toMatchObject({
			authType: "apikey",
			apiEndpoint: "https://billing.example.com",
		});
	});

	it("previews a theme's colors, with the default one for a cleared color", () => {
		startWith(/^Theme/, "Night");
		fireEvent.change(screen.getByLabelText("Primary color", { selector: "input[type=color]" }), {
			target: { value: "#112233" },
		});
		expect(screen.getByLabelText("Primary color", { selector: "input[type=text]" })).toHaveValue(
			"#112233",
		);
		fireEvent.change(screen.getByLabelText("Background color", { selector: "input[type=text]" }), {
			target: { value: "" },
		});
		fireEvent.change(screen.getByLabelText("Background color", { selector: "input[type=color]" }), {
			target: { value: "#000000" },
		});
		fireEvent.change(screen.getByLabelText("Background color", { selector: "input[type=text]" }), {
			target: { value: "" },
		});
		fireEvent.click(next());
		expect(preview().themeData).toEqual({
			"--color-primary": "#112233",
			"--color-background": "#0a0a1a",
		});

		fireEvent.click(screen.getByRole("button", { name: "Details" }));
		fireEvent.change(screen.getByLabelText("Primary color", { selector: "input[type=text]" }), {
			target: { value: "" },
		});
		fireEvent.change(screen.getByLabelText("Background color", { selector: "input[type=text]" }), {
			target: { value: "#ffffff" },
		});
		fireEvent.click(next());
		expect(preview().themeData).toEqual({
			"--color-primary": "#8b5cf6",
			"--color-background": "#ffffff",
		});
	});

	it("asks a spec template for its content and a custom prompt for its prompt", () => {
		startWith(/^Spec Template/, "API spec");
		const content = screen.getByLabelText("Template content");
		expect(content).toHaveAttribute("placeholder", "# Spec template\n\n## Requirements\n...");
		fireEvent.change(content, { target: { value: "# API" } });
		fireEvent.click(next());
		expect(preview()).toMatchObject({ type: "spec-template", content: "# API" });

		fireEvent.click(screen.getByRole("button", { name: "Type" }));
		fireEvent.click(screen.getByRole("button", { name: /^Custom Prompt/ }));
		fireEvent.click(next());
		expect(screen.getByLabelText("Prompt content")).toHaveAttribute(
			"placeholder",
			"You are an expert at...",
		);
		fireEvent.click(next());
		expect(preview()).toMatchObject({ type: "custom-prompt", content: "# API" });
	});

	it("shows why the plugin could not be created, and forgets it on the next step", async () => {
		startWith(/^Agent/);
		fireEvent.click(next());
		const create = () => screen.getByRole("button", { name: "Create a Plugin" });

		invoke.mockResolvedValueOnce({ success: false, error: 'A plugin with ID "my-reviewer" already exists' });
		await act(async () => {
			fireEvent.click(create());
		});
		expect(screen.getByText('A plugin with ID "my-reviewer" already exists')).toBeInTheDocument();

		invoke.mockResolvedValueOnce(undefined);
		await act(async () => {
			fireEvent.click(create());
		});
		expect(screen.getByText("Could not create the plugin")).toBeInTheDocument();

		invoke.mockRejectedValueOnce(new Error("disk full"));
		await act(async () => {
			fireEvent.click(create());
		});
		expect(screen.getByText("disk full")).toBeInTheDocument();

		invoke.mockRejectedValueOnce("x");
		await act(async () => {
			fireEvent.click(create());
		});
		expect(screen.getByText("Could not create the plugin")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(screen.queryByText("Could not create the plugin")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Plugin name")).toHaveValue("My Reviewer");
	});

	it("blocks a second create while the first runs", async () => {
		startWith(/^Agent/);
		fireEvent.click(next());
		const pending = deferred<unknown>();
		invoke.mockReturnValueOnce(pending.promise);
		fireEvent.click(screen.getByRole("button", { name: "Create a Plugin" }));
		expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
		await act(async () => {
			pending.resolve({ success: true });
		});
		// No folder came back: nothing to show or open.
		expect(screen.getByText("Plugin created!")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Open folder" })).not.toBeInTheDocument();
	});

	it("copies the preview, says so for two seconds, and shows a refused copy", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		startWith(/^Agent/);
		fireEvent.click(next());

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Copy" }));
		});
		expect(writeText).toHaveBeenCalledWith(screen.getByText(/"id":/).textContent);
		expect(screen.getByRole("button", { name: "Copied!" })).toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime(1500);
			fireEvent.click(screen.getByRole("button", { name: "Copied!" }));
		});
		// A second copy restarts the two seconds.
		act(() => vi.advanceTimersByTime(1500));
		expect(screen.getByRole("button", { name: "Copied!" })).toBeInTheDocument();
		act(() => vi.advanceTimersByTime(500));
		expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();

		writeText.mockRejectedValueOnce(new Error("denied"));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Copy" }));
		});
		expect(screen.getByText("Could not copy the configuration")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
	});

	it("stops the copied timer when it closes", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { unmount } = startWith(/^Agent/);
		fireEvent.click(next());
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Copy" }));
		});
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("goes back to the SDK page from the first step or the header, and to an earlier step", () => {
		render(<PluginCreatorWizard onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(2);

		// The current step is not a link to itself, and a later one is not offered.
		fireEvent.click(screen.getByRole("button", { name: /^Agent/ }));
		fireEvent.click(next());
		fireEvent.click(screen.getByRole("button", { name: /2\s*Details/ }));
		expect(screen.getByLabelText("Plugin name")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /3\s*Preview/ })).toBeDisabled();
	});
});

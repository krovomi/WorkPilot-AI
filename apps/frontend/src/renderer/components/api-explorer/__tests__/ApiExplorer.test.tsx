/**
 * The API Explorer page: loading a contract, the endpoint list and its
 * search, the environment and its token, the emulator button, and the
 * dialogs. The request builder is a stand-in that shows what the page hands
 * it; it has its own tests.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import {
	type OpenApiSpec,
	useApiExplorerStore,
} from "../../../stores/api-explorer-store";
import { useAppEmulatorStore } from "../../../stores/app-emulator-store";
import { useProjectStore } from "../../../stores/project-store";
import { ApiExplorer } from "../ApiExplorer";

const rescan = vi.hoisted(() => vi.fn());
vi.mock("../../../hooks/useProjectRouteScan", () => ({
	useProjectRouteScan: () => ({ rescan }),
}));
vi.mock("../RequestPanel", () => ({
	RequestPanel: (p: { method: string; path: string; spec: OpenApiSpec; onOpenEnvManager: () => void }) => (
		<>
			<output data-testid="request">{`${p.method} ${p.path} in ${p.spec.info.title}`}</output>
			<button type="button" onClick={p.onOpenEnvManager}>
				request-environments
			</button>
		</>
	),
	CustomSelect: (p: {
		value: string;
		onChange: (value: string) => void;
		options: Array<{ value: string; label: string }>;
	}) => (
		<select
			aria-label="environment"
			value={p.value}
			onChange={(e) => p.onChange(e.target.value)}
		>
			{p.options.map((o) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</select>
	),
}));

const t = (key: string, options?: Record<string, unknown>) =>
	i18n.t(`apiExplorer:${key}`, options ?? {});

const SPEC: OpenApiSpec = {
	openapi: "3.0.0",
	info: { title: "Shop API", version: "1.2.0" },
	tags: [{ name: "orders" }, { name: "users", description: "People" }],
	paths: {
		"/users/{id}": {
			parameters: [] as never,
			get: { summary: "Read a user", tags: ["users"] },
			delete: { tags: ["users"], deprecated: true },
		},
		"/orders": { post: { operationId: "createOrder", tags: ["orders"] } },
		"/health": { get: {} },
	},
};

const api = {
	proxyHttpRequest: vi.fn(),
	loadApiExplorerSecrets: vi.fn(),
	saveApiExplorerSecrets: vi.fn(),
	readFile: vi.fn(),
};

const initial = useApiExplorerStore.getState();

beforeEach(() => {
	vi.resetAllMocks();
	api.loadApiExplorerSecrets.mockResolvedValue({ success: true, data: {} });
	api.saveApiExplorerSecrets.mockResolvedValue({ success: true });
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = api;
	useApiExplorerStore.setState(initial, true);
	useAppEmulatorStore.setState({ phase: "idle", url: null, status: "", isOpen: false });
	useProjectStore.setState({
		projects: [{ id: "p1", name: "Shop", path: "/work/shop" } as never],
		activeProjectId: "p1",
		selectedProjectId: null,
	});
});

const settle = () => act(() => Promise.resolve());
const setup = async () => {
	const view = render(<ApiExplorer />);
	await settle();
	return { ...view, user: userEvent.setup() };
};
const endpoint = (path: RegExp | string) =>
	screen.getAllByRole("button").find((b) => b.textContent?.match(path)) as HTMLElement;
const groupButton = (tag: string) =>
	screen.getByRole("button", { name: new RegExp(`^${tag}\\s*\\d+$`) });
const withSpec = (over: Partial<ReturnType<typeof useApiExplorerStore.getState>> = {}) =>
	useApiExplorerStore.setState({ spec: SPEC, specSource: "url", ...over });

describe("ApiExplorer without a contract", () => {
	it("asks for one and offers no export", async () => {
		await setup();
		expect(screen.getByText(t("empty.noSpec"))).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: t("actions.export") })).not.toBeInTheDocument();
	});

	it("loads a contract from its address", async () => {
		api.proxyHttpRequest.mockResolvedValue({
			success: true,
			status: 200,
			body: JSON.stringify(SPEC),
		});
		const { user } = await setup();

		await user.type(screen.getByPlaceholderText("http://127.0.0.1:9000/openapi.json"), "http://localhost:3000/openapi.json{Enter}");

		expect(api.proxyHttpRequest).toHaveBeenCalledWith({
			url: "http://localhost:3000/openapi.json",
			method: "GET",
			headers: { Accept: "application/json" },
		});
		expect(await screen.findByText("Shop API")).toBeInTheDocument();
		const state = useApiExplorerStore.getState();
		expect(state).toMatchObject({ specUrl: "http://localhost:3000/openapi.json", specSource: "url", scannedProjectId: "p1" });
		expect(screen.getByText(t("scan.urlBadge"))).toBeInTheDocument();
	});

	it("reloads the same address from the button", async () => {
		api.proxyHttpRequest.mockResolvedValue({ success: true, status: 200, body: JSON.stringify(SPEC) });
		useApiExplorerStore.setState({ specUrl: "http://localhost:3000/openapi.json" });
		const { user } = await setup();

		await user.click(screen.getByRole("button", { name: t("aria.loadSpec") }));
		expect(api.proxyHttpRequest).toHaveBeenCalledTimes(1);
		expect(useApiExplorerStore.getState().specUrl).toBe("http://localhost:3000/openapi.json");
	});

	it.each([
		["an error status", { success: true, status: 500, statusText: "Server Error" }, "HTTP 500: Server Error"],
		["a failed request", { success: false }, "HTTP 0: Error"],
		["a body that is not JSON", { success: true, status: 200, body: "<html>" }, "valid JSON"],
		["an empty answer", { success: true, status: 200 }, "JSON"],
	])("says what went wrong on %s", async (_label, answer, message) => {
		api.proxyHttpRequest.mockResolvedValue(answer);
		const { user } = await setup();
		await user.click(screen.getByRole("button", { name: t("aria.loadSpec") }));

		expect(await screen.findByText(t("sidebar.loadError"))).toBeInTheDocument();
		expect(screen.getByText(new RegExp(message))).toBeInTheDocument();
		expect(useApiExplorerStore.getState().spec).toBeNull();
	});

	it("shows the error itself, without its type, and a bare refusal as it came", async () => {
		api.proxyHttpRequest.mockRejectedValue("offline");
		const { user } = await setup();
		await user.click(screen.getByRole("button", { name: t("aria.loadSpec") }));
		expect(await screen.findByText("offline", { exact: true })).toBeInTheDocument();
	});

	it("lists nothing for a loaded contract without tags or paths", async () => {
		useProjectStore.setState({ activeProjectId: null, selectedProjectId: "p1" });
		api.proxyHttpRequest.mockResolvedValue({
			success: true,
			status: 200,
			body: JSON.stringify({ openapi: "3.0.0", info: { title: "Bare", version: "0" } }),
		});
		const { user } = await setup();
		await user.click(screen.getByRole("button", { name: t("aria.loadSpec") }));

		await waitFor(() => expect(useApiExplorerStore.getState().spec?.info.title).toBe("Bare"));
		expect(useApiExplorerStore.getState().scannedProjectId).toBe("p1");
		expect(screen.queryByRole("button", { expanded: true })).not.toBeInTheDocument();
	});

	it("keeps the scanned contract when an address fails", async () => {
		withSpec({ specSource: "scan" });
		api.proxyHttpRequest.mockResolvedValue({ success: true, status: 404, statusText: "Not Found" });
		const { user } = await setup();
		await user.click(screen.getByRole("button", { name: t("aria.loadSpec") }));

		expect(await screen.findByText("HTTP 404: Not Found", { exact: true })).toBeInTheDocument();
		expect(useApiExplorerStore.getState().spec).toBe(SPEC);
	});

	it("shows a spinner while the contract loads", async () => {
		useApiExplorerStore.setState({ isLoadingSpec: true });
		await setup();
		expect(screen.getByText(t("sidebar.loading"))).toBeInTheDocument();
		expect(screen.getByRole("button", { name: t("aria.loadSpec") })).toBeDisabled();
		expect(screen.queryByText(t("empty.noSpec"))).not.toBeInTheDocument();
	});
});

describe("ApiExplorer endpoint list", () => {
	it("groups the operations by tag, in the contract's tag order", async () => {
		withSpec();
		await setup();

		const groups = screen.getAllByRole("button", { expanded: true }).map((b) => b.textContent);
		expect(groups).toEqual(["orders1", "users2", "default1"]);
		expect(screen.getByText(`v1.2.0 · 4 ${t("sidebar.endpoints")}`, { exact: false })).toBeInTheDocument();
		// A path's own `parameters` is not an endpoint.
		expect(screen.queryByText("PARAMETERS")).not.toBeInTheDocument();
	});

	it("folds a group", async () => {
		withSpec();
		const { user } = await setup();
		await user.click(groupButton("users"));

		expect(groupButton("users")).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("/users/{id}")).not.toBeInTheDocument();
	});

	it("searches paths, summaries and operation ids, and clears the search", async () => {
		withSpec();
		const { user } = await setup();
		const search = screen.getByPlaceholderText(t("sidebar.search"));

		await user.type(search, "READ A");
		expect(screen.getAllByText("/users/{id}")).toHaveLength(1);
		await user.clear(search);
		await user.type(search, "createorder");
		expect(screen.getByText("/orders")).toBeInTheDocument();
		expect(screen.queryByText("/health")).not.toBeInTheDocument();
		await user.clear(search);
		await user.type(search, "nothing");
		expect(screen.getByText(t("sidebar.noResults"))).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: t("aria.clearSearch") }));
		expect(search).toHaveValue("");
		expect(screen.getByText("/health")).toBeInTheDocument();
	});

	it("opens the endpoint picked, with its summary and deprecation", async () => {
		withSpec();
		const { user } = await setup();
		expect(screen.getByText(t("empty.selectEndpoint"))).toBeInTheDocument();

		await user.click(endpoint(/^GET\/users/));
		expect(screen.getByTestId("request")).toHaveTextContent("GET /users/{id} in Shop API");
		expect(screen.getByText("Read a user")).toBeInTheDocument();
		expect(endpoint(/^GET\/users/)).toHaveAttribute("aria-current", "true");

		await user.click(endpoint(/^DELETE/));
		expect(screen.getByText("deprecated")).toBeInTheDocument();
	});

	it("shows nothing for a remembered endpoint the contract no longer has", async () => {
		withSpec({ selectedEndpointKey: "PUT:/gone" });
		await setup();
		expect(screen.queryByTestId("request")).not.toBeInTheDocument();
		expect(screen.getByText(t("empty.selectEndpoint"))).toBeInTheDocument();
	});
});

describe("ApiExplorer sources", () => {
	it("names the scanned projects and when they were scanned", async () => {
		withSpec({
			specSource: "scan",
			scannedApiProjects: ["api", "worker"],
			lastProjectScanAt: new Date("2026-11-16T09:30:00Z").getTime(),
		});
		await setup();
		expect(screen.getByText(t("scan.sourceBadge"))).toBeInTheDocument();
		expect(screen.getByText("· api, worker")).toBeInTheDocument();
		expect(screen.getByText(new RegExp(t("scan.scannedAt", { time: "" }).trim()))).toBeInTheDocument();
	});

	it("names a file source without a path", async () => {
		withSpec({ specSource: "file", specFilePath: null });
		await setup();
		expect(screen.getByText(t("scan.fileBadge"))).not.toHaveAttribute("title");
	});

	it("names the spec file a contract came from", async () => {
		withSpec({ specSource: "file", specFilePath: "docs/openapi.yaml" });
		await setup();
		expect(screen.getByText(t("scan.fileBadge"))).toBeInTheDocument();
		expect(screen.getByText("· docs/openapi.yaml")).toBeInTheDocument();
	});

	it("rescans the project, and shows the scan running or failing", async () => {
		const { user, rerender } = await setup();
		await user.click(screen.getByRole("button", { name: t("scan.resync") }));
		expect(rescan).toHaveBeenCalledTimes(1);

		act(() => useApiExplorerStore.setState({ isProjectScanning: true }));
		rerender(<ApiExplorer />);
		expect(screen.getAllByText(t("scan.scanning"))).toHaveLength(2);

		act(() =>
			useApiExplorerStore.setState({ isProjectScanning: false, projectScanError: "apiExplorer:scan.failed" }),
		);
		expect(screen.getByText(t("scan.failed"))).toBeInTheDocument();
		act(() => useApiExplorerStore.setState({ projectScanError: "ENOENT: no such file" }));
		expect(screen.getByText("ENOENT: no such file")).toBeInTheDocument();
	});
});

describe("ApiExplorer environment", () => {
	it("loads the active environment's token, then saves its changes", async () => {
		api.loadApiExplorerSecrets.mockResolvedValue({ success: true, data: { environmentToken: "test-env-0000" } });
		await setup();

		expect(api.loadApiExplorerSecrets).toHaveBeenCalledWith("environment:p1:local");
		await waitFor(() =>
			expect(useApiExplorerStore.getState().environments[0].token).toBe("test-env-0000"),
		);
		api.saveApiExplorerSecrets.mockClear();

		act(() => useApiExplorerStore.getState().updateEnvironment("local", { token: "test-env-1111" }));
		expect(api.saveApiExplorerSecrets).toHaveBeenCalledWith("environment:p1:local", { environmentToken: "test-env-1111" });
	});

	it("erases the stored token once it is cleared", async () => {
		await setup();
		act(() => useApiExplorerStore.getState().updateEnvironment("local", { token: undefined }));
		expect(api.saveApiExplorerSecrets).toHaveBeenCalledWith("environment:p1:local", { environmentToken: "" });
	});

	it("uses the first environment when the active one is gone", async () => {
		useApiExplorerStore.setState({ activeEnvironmentId: "gone" });
		await setup();
		expect(api.loadApiExplorerSecrets).toHaveBeenCalledWith(`environment:p1:${useApiExplorerStore.getState().environments[0].id}`);
	});

	it("opens the environments dialog from the request", async () => {
		withSpec();
		const { user } = await setup();
		await user.click(endpoint(/^GET\/users/));
		await user.click(screen.getByRole("button", { name: "request-environments" }));
		expect(screen.getByRole("dialog", { name: t("environments.title") })).toBeInTheDocument();
	});

	it("saves nothing before the token was read", async () => {
		api.loadApiExplorerSecrets.mockReturnValue(new Promise(() => undefined));
		await setup();
		act(() => useApiExplorerStore.getState().updateEnvironment("local", { token: "typed" }));
		expect(api.saveApiExplorerSecrets).not.toHaveBeenCalled();
	});

	it("keeps no token when its store could not be read", async () => {
		useApiExplorerStore.getState().updateEnvironment("local", { token: "stale" });
		api.loadApiExplorerSecrets.mockResolvedValue({ success: false, error: "locked" });
		await setup();
		expect(useApiExplorerStore.getState().environments[0].token).toBe("");
	});

	it("ignores the answer for an environment it already left", async () => {
		let answer: (value: unknown) => void = () => undefined;
		api.loadApiExplorerSecrets.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
		useApiExplorerStore.getState().addEnvironment({ name: "Prod", baseUrl: "https://api.shop.com", headers: {} });
		const prod = useApiExplorerStore.getState().environments[1].id;
		const { user } = await setup();

		await user.selectOptions(screen.getByRole("combobox", { name: "environment" }), prod);
		await act(async () => answer({ success: true, data: { environmentToken: "for-local" } }));

		expect(useApiExplorerStore.getState().environments[0].token).toBe("");
		expect(screen.getByText("https://api.shop.com")).toBeInTheDocument();
	});

	it("reads no token outside a project", async () => {
		useProjectStore.setState({ activeProjectId: null, selectedProjectId: null });
		await setup();
		expect(api.loadApiExplorerSecrets).not.toHaveBeenCalled();
	});

	it("opens and closes the environments dialog", async () => {
		const { user } = await setup();
		await user.click(screen.getByRole("button", { name: t("environments.manage") }));
		const dialog = screen.getByRole("dialog", { name: t("environments.title") });
		await user.click(within(dialog).getByRole("button", { name: t("aria.close") }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("opens and closes the export dialog", async () => {
		withSpec();
		const { user } = await setup();
		await user.click(screen.getByRole("button", { name: t("actions.export") }));
		const dialog = screen.getByRole("dialog", { name: t("export.title") });
		await user.click(within(dialog).getByRole("button", { name: t("aria.close") }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});

describe("ApiExplorer emulator button", () => {
	const button = () =>
		screen.getAllByRole("button").find((b) => b.textContent?.match(/^(Run|Detecting|Starting|Running|Lancer|Détection|Démarrage|En cours)/)) as HTMLElement;

	it("opens the emulator and follows its phases", async () => {
		const { user } = await setup();
		expect(button()).toHaveTextContent(t("emulator.run"));
		await user.click(button());
		expect(useAppEmulatorStore.getState().isOpen).toBe(true);

		act(() => useAppEmulatorStore.setState({ phase: "detecting" }));
		expect(button()).toHaveTextContent(t("emulator.detecting"));
		expect(button()).toBeDisabled();
		act(() => useAppEmulatorStore.setState({ phase: "starting" }));
		expect(button()).toHaveTextContent(t("emulator.starting"));
	});

	it("points the active environment at the app once it runs", async () => {
		await setup();
		act(() => useAppEmulatorStore.setState({ phase: "running", url: "http://localhost:5173", status: "Vite ready" }));

		expect(useApiExplorerStore.getState().environments[0].baseUrl).toBe("http://localhost:5173");
		expect(button()).toHaveTextContent(t("emulator.running"));
		expect(button()).toHaveAttribute("title", "Vite ready");

		// Editing the address afterwards is not undone while it keeps running.
		act(() => useApiExplorerStore.getState().updateEnvironment("local", { baseUrl: "http://elsewhere" }));
		expect(useApiExplorerStore.getState().environments[0].baseUrl).toBe("http://elsewhere");
	});

	it("has no address to point without an environment", async () => {
		useApiExplorerStore.setState({ environments: [] });
		await setup();
		act(() => useAppEmulatorStore.setState({ phase: "running", url: "http://localhost:5173" }));
		expect(useApiExplorerStore.getState().environments).toEqual([]);
		expect(api.loadApiExplorerSecrets).not.toHaveBeenCalled();
	});

	it("leaves the address alone when the running app has none", async () => {
		await setup();
		act(() => useAppEmulatorStore.setState({ phase: "running", url: null }));
		expect(useApiExplorerStore.getState().environments[0].baseUrl).toBe("http://localhost:9000");
		expect(button()).toHaveAttribute("title", "");
	});
});

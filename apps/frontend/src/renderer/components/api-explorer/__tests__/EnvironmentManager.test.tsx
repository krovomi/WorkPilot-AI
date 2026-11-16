/**
 * The API Explorer's environments: finding base addresses in the project's
 * .env files, and the dialog that adds, edits, imports and removes them.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { useApiExplorerStore } from "../../../stores/api-explorer-store";
import { useProjectStore } from "../../../stores/project-store";
import {
	detectEnvironmentsFromProject,
	EnvironmentManager,
	envNameFromFile,
	isUrl,
	parseEnvFile,
	parseHeaderLines,
	pickBestUrl,
} from "../EnvironmentManager";

const t = (key: string, options?: Record<string, unknown>) =>
	i18n.t(`apiExplorer:${key}`, options ?? {});

const readFile = vi.fn();

beforeEach(() => {
	readFile.mockReset();
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = { readFile };
	useApiExplorerStore.setState({
		environments: [
			{ id: "local", name: "Local", baseUrl: "http://localhost:9000", headers: {}, isDefault: true },
			{
				id: "staging",
				name: "Staging",
				baseUrl: "https://staging.example.com",
				headers: { "X-Tenant": "acme" },
				token: "test-token-0000",
			},
		],
		activeEnvironmentId: "local",
	});
	useProjectStore.setState({
		projects: [{ id: "p1", name: "Shop", path: "/work/shop" } as never],
		activeProjectId: "p1",
		selectedProjectId: null,
	});
});

afterEach(() => {
	delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("reading .env files", () => {
	it("takes KEY=value lines, without comments or quotes", () => {
		expect(
			parseEnvFile(
				'# comment\n\nAPI_URL="http://a"\r\nNAME=\'shop\'\n=nothing\nNOEQUALS\nEMPTY=\n',
			),
		).toEqual({ API_URL: "http://a", NAME: "shop", EMPTY: "" });
	});

	it("knows a web address", () => {
		expect(isUrl("https://api.example.com")).toBe(true);
		expect(isUrl("ftp://example.com")).toBe(false);
		expect(isUrl("localhost:3000")).toBe(false);
	});

	it("prefers the known keys, then any *_URL key, then nothing", () => {
		expect(
			pickBestUrl({ OTHER_URL: "http://other", API_URL: "http://api" }),
		).toBe("http://api");
		expect(pickBestUrl({ API_URL: "not a url", SEARCH_HOST: "http://search" })).toBe(
			"http://search",
		);
		expect(pickBestUrl({ PORT: "3000", DB_URL: "postgres://db" })).toBeNull();
	});

	it("names an environment after its file", () => {
		expect(envNameFromFile(".env.staging", "Default")).toBe("Staging");
		expect(envNameFromFile(".env", "Par défaut")).toBe("Par défaut");
		expect(envNameFromFile(".local", "Default")).toBe("Local");
	});

	it("reads header lines and skips a line without a name", () => {
		expect(parseHeaderLines("X-A: 1\n: nameless\nnot a header\nX-B:  two:parts ")).toEqual({
			"X-A": "1",
			"X-B": "two:parts",
		});
	});

	it("finds one environment per address across the project's files", async () => {
		readFile.mockImplementation(async (file: string) => {
			if (file.endsWith("/.env")) return { success: true, data: "API_URL=http://localhost:3000" };
			if (file.endsWith("/.env.local")) return { success: true, data: "API_URL=http://localhost:3000" };
			if (file.endsWith("/.env.production")) return { success: true, data: "API_URL=https://api.shop.com" };
			if (file.endsWith("/.env.test")) return { success: true, data: "PORT=1" };
			if (file.endsWith("apps/frontend/.env")) throw new Error("ENOENT");
			return { success: false };
		});

		const found = await detectEnvironmentsFromProject("C:\\work\\shop", "Default");

		expect(readFile).toHaveBeenCalledWith("C:/work/shop/.env.staging");
		expect(found).toEqual([
			{ name: "Default", baseUrl: "http://localhost:3000", headers: {}, source: ".env" },
			{ name: "Production", baseUrl: "https://api.shop.com", headers: {}, source: ".env.production" },
		]);
	});
});

describe("EnvironmentManager", () => {
	const setup = () => {
		const onClose = vi.fn();
		render(<EnvironmentManager onClose={onClose} />);
		return { onClose, user: userEvent.setup() };
	};
	const envs = () => useApiExplorerStore.getState().environments;

	it("lists the environments in a named dialog, with a mark for a token", () => {
		setup();
		const dialog = screen.getByRole("dialog", { name: t("environments.title") });
		expect(within(dialog).getByText("https://staging.example.com")).toBeInTheDocument();
		expect(within(dialog).getAllByText("Bearer ••••")).toHaveLength(1);
		expect(
			screen.queryByRole("button", { name: t("aria.removeEnvironment", { name: "Local" }) }),
		).not.toBeInTheDocument();
	});

	it("edits an environment's name, address, token and headers", async () => {
		const { user } = setup();
		await user.click(screen.getByRole("button", { name: t("aria.editEnvironment", { name: "Staging" }) }));

		const name = screen.getByDisplayValue("Staging");
		await user.clear(name);
		await user.type(name, "Preprod");
		const address = screen.getByDisplayValue("https://staging.example.com");
		await user.clear(address);
		await user.type(address, "https://preprod.example.com");
		const token = screen.getByDisplayValue("test-token-0000");
		expect(token).toHaveAttribute("type", "password");
		await user.click(screen.getByRole("button", { name: t("aria.showToken") }));
		expect(token).toHaveAttribute("type", "text");
		expect(screen.getByRole("button", { name: t("aria.showToken") })).toHaveAttribute("aria-pressed", "true");
		await user.clear(token);
		const headers = screen.getByDisplayValue("X-Tenant: acme");
		await user.clear(headers);
		await user.type(headers, "X-Tenant: beta");
		await user.click(screen.getByRole("button", { name: t("actions.save") }));

		expect(envs()[1]).toMatchObject({
			name: "Preprod",
			baseUrl: "https://preprod.example.com",
			headers: { "X-Tenant": "beta" },
			token: undefined,
		});
	});

	it("drops an edit on cancel", async () => {
		const { user } = setup();
		await user.click(screen.getByRole("button", { name: t("aria.editEnvironment", { name: "Local" }) }));
		await user.clear(screen.getByDisplayValue("Local"));
		await user.click(screen.getByRole("button", { name: t("actions.cancel") }));

		expect(envs()[0].name).toBe("Local");
		expect(screen.getByText("Local")).toBeInTheDocument();
	});

	it("adds an environment once it has a name and an address", async () => {
		const { user } = setup();
		await user.click(screen.getByRole("button", { name: t("environments.addNew") }));
		const add = screen.getByRole("button", { name: t("actions.add") });
		expect(add).toBeDisabled();

		const [name, url] = screen.getAllByRole("textbox");
		await user.type(name, "Prod");
		await user.type(url, "https://api.shop.com");
		await user.type(screen.getByPlaceholderText(t("environments.tokenPlaceholder")), "tok");
		await user.click(screen.getByRole("button", { name: t("aria.showToken") }));
		expect(screen.getByDisplayValue("tok")).toHaveAttribute("type", "text");
		await user.type(screen.getByPlaceholderText("X-API-Key: key"), "X-Key: 1");
		await user.click(add);

		expect(envs()[2]).toMatchObject({
			name: "Prod",
			baseUrl: "https://api.shop.com",
			headers: { "X-Key": "1" },
			token: "tok",
		});
		expect(screen.getByRole("button", { name: t("environments.addNew") })).toBeInTheDocument();
	});

	it("adds one without a token, and cancels an addition", async () => {
		const { user } = setup();
		await user.click(screen.getByRole("button", { name: t("environments.addNew") }));
		await user.click(screen.getByRole("button", { name: t("actions.cancel") }));
		expect(envs()).toHaveLength(2);

		await user.click(screen.getByRole("button", { name: t("environments.addNew") }));
		const [name, url] = screen.getAllByRole("textbox");
		await user.type(name, "Dev");
		await user.type(url, "http://dev");
		await user.click(screen.getByRole("button", { name: t("actions.add") }));
		expect(envs()[2].token).toBeUndefined();
	});

	it("removes an environment", async () => {
		const { user } = setup();
		await user.click(screen.getByRole("button", { name: t("aria.removeEnvironment", { name: "Staging" }) }));
		expect(envs().map((e) => e.id)).toEqual(["local"]);
	});

	it("imports the detected environments it does not have yet, each with its own id", async () => {
		readFile.mockImplementation(async (file: string) => {
			if (file.endsWith("/.env")) return { success: true, data: "API_URL=http://localhost:9000" };
			if (file.endsWith("/.env.staging")) return { success: true, data: "API_URL=https://qa.shop.com" };
			if (file.endsWith("/.env.production")) return { success: true, data: "BASE_URL=https://api.shop.com" };
			return { success: false };
		});
		const { user } = setup();

		await user.click(screen.getByRole("button", { name: t("environments.detect") }));
		const boxes = await screen.findAllByRole("checkbox");
		expect(boxes).toHaveLength(2);
		expect(screen.getByText(".env.production")).toBeInTheDocument();

		await user.click(boxes[0]);
		await user.click(boxes[0]);
		await user.click(screen.getByRole("button", { name: new RegExp(t("environments.importSelected")) }));

		const added = envs().slice(2);
		expect(added.map((e) => e.baseUrl)).toEqual(["https://qa.shop.com", "https://api.shop.com"]);
		expect(new Set(envs().map((e) => e.id)).size).toBe(4);
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
	});

	it("drops the detected list on cancel, and imports only what stays ticked", async () => {
		readFile.mockImplementation(async (file: string) =>
			file.endsWith("/.env.staging") || file.endsWith("/.env.prod")
				? { success: true, data: `API_URL=https://${file.endsWith("prod") ? "p" : "s"}.shop.com` }
				: { success: false },
		);
		const { user } = setup();

		await user.click(screen.getByRole("button", { name: t("environments.detect") }));
		await screen.findAllByRole("checkbox");
		await user.click(screen.getByRole("button", { name: t("actions.cancel") }));
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: t("environments.detect") }));
		const boxes = await screen.findAllByRole("checkbox");
		await user.click(boxes[1]);
		await user.click(screen.getByRole("button", { name: new RegExp(t("environments.importSelected")) }));
		expect(envs().slice(2).map((e) => e.baseUrl)).toEqual(["https://s.shop.com"]);
	});

	it("offers no detection without an open project", () => {
		useProjectStore.setState({ activeProjectId: null, selectedProjectId: null });
		setup();
		expect(screen.queryByRole("button", { name: t("environments.detect") })).not.toBeInTheDocument();
	});

	it("closes", async () => {
		const { onClose, user } = setup();
		await user.click(screen.getByRole("button", { name: t("aria.close") }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

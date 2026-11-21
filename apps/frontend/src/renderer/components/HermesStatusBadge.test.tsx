/** @vitest-environment jsdom */
/**
 * Hermes in the « Outils CLI » panel: the doctor's answer and what to type,
 * never a button that installs or trusts on the person's behalf, and nothing
 * at all in server mode. The backend is faked where the renderer reaches it,
 * `electronAPI.localBackendRequest`; the store and i18n are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "../../shared/i18n";
import type { HermesStatus } from "../lib/agent-tools-api";
import { useHermesStore } from "../stores/hermes-store";
import { HermesStatusBadge } from "./HermesStatusBadge";
import { TooltipProvider } from "./ui/tooltip";

const INSTALL = "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash";
const DOCS_URL = "https://github.com/NousResearch/hermes-agent";

function status(overrides: Partial<HermesStatus> = {}): HermesStatus {
	return {
		readiness: {
			state: "ready",
			installed: true,
			ready: true,
			degraded: false,
			home: "/home/me/.hermes",
			checks: [{ name: "install", ok: true, detail: "on PATH", remedy: "", required: true }],
		},
		soul: {
			state: "installed",
			offered: true,
			installed: true,
			matches: true,
			installedPath: "",
			repoPath: "",
		},
		pending: [],
		candidates: [],
		stale: 0,
		adopted: [],
		adoptedPack: "hermes-learned",
		surfaces: [],
		...overrides,
	} as HermesStatus;
}

const ABSENT = {
	state: "absent",
	installed: false,
	ready: false,
	degraded: false,
	home: "/home/me/.hermes",
	checks: [
		{
			name: "install",
			ok: false,
			detail: "no hermes binary and no hermes home",
			remedy: INSTALL,
			required: true,
		},
	],
} as const;

type Answer = Record<string, unknown> | "unreachable" | Promise<Record<string, unknown>>;
let statusAnswer: Answer;
let soulAnswer: Record<string, unknown>;
const requests: { method: string; url: string; body?: string }[] = [];

const json = (body: Record<string, unknown>) => ({
	status: 200,
	contentType: "application/json",
	text: JSON.stringify(body),
});

const localBackendRequest = vi.fn(
	async (request: { method: string; url: string; body?: string }) => {
		requests.push(request);
		if (request.url.startsWith("/api/hermes/status")) {
			const answer = await statusAnswer;
			return answer === "unreachable" ? { unreachable: true as const } : json(answer);
		}
		if (request.url === "/api/hermes/soul/install") return json(soulAnswer);
		return { status: 404, contentType: "application/json", text: "{}" };
	},
);

let api: Record<string, unknown>;

function setApi(extra: Record<string, unknown> = {}) {
	api = { localBackendRequest, ...extra };
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
}

function renderBadge(props: Parameters<typeof HermesStatusBadge>[0] = {}) {
	return render(
		<TooltipProvider>
			<HermesStatusBadge {...props} />
		</TooltipProvider>,
	);
}

async function openPopover() {
	fireEvent.click(await screen.findByRole("button", { name: /Hermes/ }));
}

const statusRequests = () => requests.filter((r) => r.url.startsWith("/api/hermes/status"));

describe("HermesStatusBadge", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
		requests.length = 0;
		localBackendRequest.mockClear();
		statusAnswer = { success: true, status: status() };
		useHermesStore.getState().reset();
		setApi();
	});
	afterEach(() => {
		cleanup();
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
	});

	it("renders nothing in server mode", async () => {
		statusAnswer = { success: false, error: "the hermes learning loop is a desktop feature" };
		const { container } = renderBadge();
		await waitFor(() => expect(useHermesStore.getState().unavailable).toBe(true));
		expect(container).toBeEmptyDOMElement();
	});

	it("shows a missing hermes with the command that installs it", async () => {
		statusAnswer = { success: true, status: status({ readiness: ABSENT }) };
		const onPresenceChange = vi.fn();
		renderBadge({ onPresenceChange });
		await waitFor(() => expect(onPresenceChange).toHaveBeenLastCalledWith("missing"));
		await openPopover();
		expect(await screen.findByText("not installed")).toBeInTheDocument();
		expect(screen.getByText(INSTALL)).toBeInTheDocument();
		// Nothing installs on the person's behalf.
		expect(screen.queryByRole("button", { name: /install/i })).not.toBeInTheDocument();
	});

	it("names a backend that did not answer instead of « Failed to fetch »", async () => {
		statusAnswer = "unreachable";
		const onPresenceChange = vi.fn();
		renderBadge({ onPresenceChange });
		await waitFor(() => expect(useHermesStore.getState().error).not.toBeNull());
		await waitFor(() => expect(onPresenceChange).toHaveBeenLastCalledWith("missing"));
		await openPopover();
		expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent(
			"The local WorkPilot backend did not answer. Start it (or restart the app), then refresh.",
		);
		expect(screen.getByText("Error")).toBeInTheDocument();
	});

	it("says it is checking until the doctor answers", async () => {
		let answer!: (value: Record<string, unknown>) => void;
		statusAnswer = new Promise((resolve) => {
			answer = resolve;
		});
		const onPresenceChange = vi.fn();
		renderBadge({ onPresenceChange });
		await openPopover();
		expect(await screen.findByText("checking…")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
		expect(onPresenceChange).not.toHaveBeenCalled();
		answer({ success: true, status: status() });
		expect(await screen.findByText("ready")).toBeInTheDocument();
		await waitFor(() => expect(onPresenceChange).toHaveBeenLastCalledWith("installed"));
	});

	it("says when hermes is only partly configured", async () => {
		statusAnswer = {
			success: true,
			status: status({
				readiness: { ...status().readiness, state: "degraded", degraded: true, ready: false },
			}),
		};
		renderBadge();
		await openPopover();
		expect(await screen.findByText("partly configured")).toBeInTheDocument();
	});

	it("counts what waits for review and offers the persona", async () => {
		statusAnswer = {
			success: true,
			status: status({
				pending: ["hermes--a.md", "hermes--b.md"],
				soul: {
					state: "not-installed",
					offered: true,
					installed: false,
					matches: false,
					installedPath: "",
					repoPath: "",
				},
			}),
		};
		soulAnswer = { success: true, changed: true, message: "", soul: status().soul };
		renderBadge();
		expect(await screen.findByText("2")).toBeInTheDocument();
		await openPopover();
		expect(
			await screen.findByText("2 skills waiting for your review in a task panel."),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Install SOUL.md" }));
		await waitFor(() =>
			expect(requests.find((r) => r.url === "/api/hermes/soul/install")?.body).toBe(
				JSON.stringify({ overwrite: false }),
			),
		);
	});

	it("never offers to overwrite a persona of the person's own", async () => {
		statusAnswer = {
			success: true,
			status: status({
				soul: {
					state: "diverged",
					offered: true,
					installed: true,
					matches: false,
					installedPath: "",
					repoPath: "",
				},
			}),
		};
		renderBadge();
		await openPopover();
		await screen.findByText("ready");
		expect(screen.queryByRole("button", { name: /SOUL\.md|persona/ })).not.toBeInTheDocument();
	});

	it("reads the doctor again, fresh, on refresh", async () => {
		const checkCliUpdate = vi.fn().mockResolvedValue({
			tool: "hermes",
			installed: true,
			version: "0.23.0",
			latest: "0.23.0",
			isOutdated: false,
		});
		setApi({ checkCliUpdate });
		renderBadge();
		expect(await screen.findByText("Hermes (0.23.0)")).toBeInTheDocument();
		await openPopover();
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(statusRequests()).toHaveLength(2));
		expect(statusRequests()[1].url).toContain("fresh=1");
		await waitFor(() => expect(checkCliUpdate).toHaveBeenCalledTimes(2));
	});

	it("opens the documentation, and says so when the link does not open", async () => {
		const openExternal = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("No handler for https"))
			.mockRejectedValueOnce("denied");
		setApi({ openExternal });
		renderBadge();
		await openPopover();
		const link = await screen.findByRole("button", { name: /Hermes Agent documentation/ });
		fireEvent.click(link);
		await waitFor(() => expect(openExternal).toHaveBeenCalledWith(DOCS_URL));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		fireEvent.click(link);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The link did not open: No handler for https",
		);
		fireEvent.click(link);
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("The link did not open: denied"),
		);
	});

	it("shows the icon alone, named, in a collapsed sidebar", async () => {
		statusAnswer = { success: true, status: status({ pending: ["hermes--a.md"] }) };
		renderBadge({ isCollapsed: true });
		const button = await screen.findByRole("button", { name: "Hermes Agent" });
		await waitFor(() => expect(useHermesStore.getState().status).not.toBeNull());
		expect(button).not.toHaveTextContent("Hermes");
		expect(button).not.toHaveTextContent("1");
	});

	describe("update", () => {
		const checkCliUpdate = vi.fn();
		const updateCli = vi.fn();
		const outdated = {
			tool: "hermes",
			installed: true,
			version: "0.21.1",
			latest: "0.23.0",
			isOutdated: true,
		};

		beforeEach(() => {
			checkCliUpdate.mockReset();
			updateCli.mockReset();
			setApi({ checkCliUpdate, updateCli });
		});

		it("flags an outdated hermes, updates it and reads the doctor again", async () => {
			statusAnswer = { success: true, status: status({ pending: ["hermes--a.md"] }) };
			checkCliUpdate.mockResolvedValue(outdated);
			updateCli.mockResolvedValue({
				tool: "hermes",
				success: true,
				method: "self",
				status: { ...outdated, version: "0.23.0", isOutdated: false },
			});
			renderBadge();
			expect(await screen.findByText("Hermes (0.21.1)")).toBeInTheDocument();
			// The update chip takes the place of the review count
			expect(screen.getByText("Update", { selector: "span" })).toBeInTheDocument();
			expect(screen.queryByText("1")).not.toBeInTheDocument();
			await openPopover();
			expect(await screen.findByText("Hermes Agent update available")).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Update" }));
			await waitFor(() => expect(updateCli).toHaveBeenCalledWith("hermes"));
			// The doctor caches the version per binary: it is asked to read it again.
			await waitFor(() => expect(statusRequests().at(-1)?.url).toContain("fresh=1"));
			expect(
				await screen.findByText("Hermes Agent is up to date (0.23.0)."),
			).toBeInTheDocument();
		});

		it("checks no release for a hermes that is not installed", async () => {
			statusAnswer = {
				success: true,
				status: status({ readiness: { ...ABSENT, home: "", checks: [] } }),
			};
			renderBadge();
			await waitFor(() => expect(statusRequests()).toHaveLength(1));
			await openPopover();
			await screen.findByText("not installed");
			expect(checkCliUpdate).not.toHaveBeenCalled();
		});
	});
});

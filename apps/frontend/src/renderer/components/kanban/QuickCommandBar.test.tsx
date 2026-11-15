/**
 * La barre de commandes rapides du Kanban : la liste vient du backend local,
 * une commande part au main (`runQuickCommand`), « Lancer comme tâche » crée
 * une carte avec le corps de la commande. Le résultat s'affiche dans un toast.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../__tests__/helpers/renderer-api";
import { localBackendFetch } from "../../lib/local-backend";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";
import { Toaster } from "../ui/toaster";
import { formatOutput, QuickCommandBar } from "./QuickCommandBar";

vi.mock("../../lib/local-backend", () => ({ localBackendFetch: vi.fn() }));

const fetchMock = vi.mocked(localBackendFetch);

const COMMANDS = [
	{ name: "review", description: "Review the diff", source: "project", path: "a" },
	{ name: "deploy", description: "", source: "user", path: "b" },
	{ name: "help", description: "List commands", source: "built-in", path: "c" },
];

function jsonResponse(body: unknown, ok = true): Response {
	return { ok, json: async () => body } as Response;
}

function routeBackend(
	body: (url: string) => { body: unknown; ok?: boolean } | Error = () => ({
		body: { success: true, body: "Do the thing" },
	}),
) {
	fetchMock.mockImplementation(async (url: string) => {
		if (url.startsWith("/api/slash-commands?")) {
			return jsonResponse({ success: true, commands: COMMANDS });
		}
		const answer = body(url);
		if (answer instanceof Error) throw answer;
		return jsonResponse(answer.body, answer.ok ?? true);
	});
}

function renderBar(props: Partial<Parameters<typeof QuickCommandBar>[0]> = {}) {
	return render(
		<>
			<QuickCommandBar projectPath="/repo" {...props} />
			<Toaster />
		</>,
	);
}

const input = () => screen.getByRole("textbox", { name: /Quick command/ });

let api: RendererApi;

beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.releasePointerCapture ??= () => undefined;
});

beforeEach(() => {
	fetchMock.mockReset();
	routeBackend();
	api = installRendererApi({
		runQuickCommand: vi.fn().mockResolvedValue({
			success: true,
			data: { ok: true, output: "All good" },
		}),
		createTask: vi.fn().mockResolvedValue({
			success: true,
			data: { id: "t9", title: "/review", status: "backlog" },
		}),
		getTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
	});
	useProjectStore.setState({ activeProjectId: "p1" });
	useTaskStore.setState({ tasks: [] });
});

afterEach(() => {
	api.restore();
});

describe("formatOutput", () => {
	it("ne montre rien pour un résultat absent ou vide", () => {
		expect(formatOutput(undefined)).toBe("");
		expect(formatOutput(null)).toBe("");
		expect(formatOutput("   ")).toBe("");
	});

	it("garde un texte court tel quel et sérialise un objet", () => {
		expect(formatOutput("ok\n")).toBe("ok");
		expect(formatOutput({ a: 1 })).toBe('{\n  "a": 1\n}');
	});

	it("coupe un résultat trop long", () => {
		const out = formatOutput("x".repeat(5000));
		expect(out.length).toBe(2001);
		expect(out.endsWith("…")).toBe(true);
	});
});

describe("liste des commandes", () => {
	it("demande la liste du projet et filtre ce que l'on tape", async () => {
		renderBar();
		await waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/slash-commands?project_dir=%2Frepo",
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			),
		);
		await userEvent.click(input());
		const menu = await screen.findByRole("menu", { name: "Available slash commands" });
		expect(menu).toHaveTextContent("Project");
		expect(menu).toHaveTextContent("User");
		expect(menu).toHaveTextContent("Built-in");

		await userEvent.type(input(), "/diff");
		expect(screen.getAllByRole("menuitem")).toHaveLength(1);
		expect(screen.getByRole("menuitem")).toHaveTextContent("/review");

		await userEvent.clear(input());
		await userEvent.type(input(), "zzz");
		expect(screen.getByText("No matching command")).toBeInTheDocument();
	});

	it("Tab complète avec la première suggestion, Échap ferme la liste", async () => {
		renderBar();
		await userEvent.click(input());
		await screen.findByRole("menu");
		await userEvent.type(input(), "dep");
		await userEvent.keyboard("{Tab}");
		expect(input()).toHaveValue("/deploy ");
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("la liste se ferme quand le champ perd le focus", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			renderBar();
			await waitFor(() => expect(fetchMock).toHaveBeenCalled());
			fireEvent.focus(input());
			await screen.findByRole("menu");
			fireEvent.blur(input());
			act(() => {
				vi.advanceTimersByTime(200);
			});
			expect(screen.queryByRole("menu")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("sans projet, le champ est désactivé et rien n'est demandé", () => {
		renderBar({ projectPath: undefined });
		expect(input()).toBeDisabled();
		expect(input()).toHaveAttribute("title", "Select a project first");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("une liste illisible laisse le menu vide, sans toast", async () => {
		fetchMock.mockRejectedValue(new Error("offline"));
		renderBar();
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		await userEvent.click(input());
		expect(screen.queryByRole("menu")).toBeNull();
		expect(screen.queryByText("Slash command failed")).toBeNull();
	});

	it("une réponse en échec ne remplit pas la liste", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: false }, false));
		renderBar();
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		await userEvent.click(input());
		expect(screen.queryByRole("menu")).toBeNull();
	});
});

describe("lancer une commande", () => {
	it("envoie la commande et ses arguments au main et montre la sortie", async () => {
		renderBar();
		await userEvent.type(input(), "/review   src/app.ts --fast{Enter}");
		expect(api.fn("runQuickCommand")).toHaveBeenCalledWith({
			projectId: "p1",
			command: "review",
			args: "src/app.ts --fast",
		});
		expect(
			await screen.findByText("/review · Slash command completed"),
		).toBeInTheDocument();
		expect(screen.getByText("All good")).toBeInTheDocument();
		expect(input()).toHaveValue("");
	});

	it("un clic sur une suggestion la lance", async () => {
		renderBar();
		await userEvent.click(input());
		const item = (await screen.findAllByRole("menuitem"))[1];
		fireEvent.mouseDown(item);
		await waitFor(() =>
			expect(api.fn("runQuickCommand")).toHaveBeenCalledWith({
				projectId: "p1",
				command: "deploy",
				args: "",
			}),
		);
	});

	it("le bouton lance aussi la commande, sans slash", async () => {
		renderBar();
		await userEvent.type(input(), "review");
		await userEvent.click(screen.getByRole("button", { name: "Run command" }));
		expect(api.fn("runQuickCommand")).toHaveBeenCalledWith(
			expect.objectContaining({ command: "review" }),
		);
	});

	it("une carte de revue recharge le tableau et dit où sont les fichiers", async () => {
		api.fn("runQuickCommand").mockResolvedValue({
			success: true,
			data: {
				ok: true,
				output: "",
				review: { files: ["a", "b"], branch: "workpilot/qc", title: "QC" },
			},
		});
		renderBar();
		await userEvent.type(input(), "/review{Enter}");
		expect(
			await screen.findByText(/2 files committed on workpilot\/qc/),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(api.fn("getTasks")).toHaveBeenCalledWith(
				"p1",
				expect.anything(),
			),
		);
	});

	it("dit où sont restés les fichiers non commités", async () => {
		api.fn("runQuickCommand").mockResolvedValue({
			success: true,
			data: { ok: false, output: { error: "x" }, uncommittedIn: "/tmp/wt" },
		});
		renderBar();
		await userEvent.type(input(), "/review{Enter}");
		expect(
			await screen.findByText("/review · Slash command failed"),
		).toBeInTheDocument();
		expect(screen.getByText(/still in \/tmp\/wt/)).toBeInTheDocument();
	});

	it("une commande sans sortie ni note n'a pas de description", async () => {
		api.fn("runQuickCommand").mockResolvedValue({
			success: true,
			data: { ok: true, output: null },
		});
		renderBar();
		await userEvent.type(input(), "/deploy{Enter}");
		expect(
			await screen.findByText("/deploy · Slash command completed"),
		).toBeInTheDocument();
	});

	it("un refus du main montre son erreur", async () => {
		api.fn("runQuickCommand").mockResolvedValue({
			success: false,
			error: "Provider not configured",
		});
		renderBar();
		await userEvent.type(input(), "/review{Enter}");
		expect(await screen.findByText("Slash command failed")).toBeInTheDocument();
		expect(screen.getByText("Provider not configured")).toBeInTheDocument();
	});

	it("un refus sans message n'affiche pas de texte anglais en dur", async () => {
		api.fn("runQuickCommand").mockResolvedValue({ success: false });
		renderBar();
		await userEvent.type(input(), "/review{Enter}");
		expect(await screen.findByText("Slash command failed")).toBeInTheDocument();
		expect(screen.queryByText("unknown")).toBeNull();
	});

	it("une exception du pont montre son message", async () => {
		api.fn("runQuickCommand").mockRejectedValue(new Error("IPC down"));
		renderBar();
		await userEvent.type(input(), "/review{Enter}");
		expect(await screen.findByText("IPC down")).toBeInTheDocument();
	});

	it("/help répond depuis la liste, sans agent", async () => {
		renderBar();
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		await userEvent.type(input(), "/help{Enter}");
		expect(await screen.findByText("Available commands")).toBeInTheDocument();
		expect(screen.getByText(/\/review — Review the diff/)).toBeInTheDocument();
		expect(api.fn("runQuickCommand")).not.toHaveBeenCalled();
	});

	it("sans onglet de projet actif, refuse de lancer", async () => {
		useProjectStore.setState({ activeProjectId: null });
		renderBar();
		await userEvent.type(input(), "/review{Enter}");
		expect(await screen.findByText("Select a project first")).toBeInTheDocument();
		expect(api.fn("runQuickCommand")).not.toHaveBeenCalled();
	});

	it("un champ blanc ne lance rien", async () => {
		renderBar();
		await userEvent.type(input(), "   {Enter}");
		await userEvent.type(input(), "/ {Enter}");
		expect(api.fn("runQuickCommand")).not.toHaveBeenCalled();
	});
});

describe("lancer comme tâche", () => {
	it("Maj+Entrée crée une carte avec le corps de la commande et ses arguments", async () => {
		renderBar();
		await userEvent.type(input(), "/review src{Shift>}{Enter}{/Shift}");
		await waitFor(() =>
			expect(api.fn("createTask")).toHaveBeenCalledWith(
				"p1",
				"/review",
				"Do the thing\n\nArguments: src",
				undefined,
			),
		);
		expect(
			fetchMock.mock.calls.some(
				([url]) =>
					url ===
					"/api/slash-commands/body?project_dir=%2Frepo&command=review",
			),
		).toBe(true);
		expect(await screen.findByText("Task created: /review")).toBeInTheDocument();
	});

	it("le bouton crée la carte sans arguments", async () => {
		renderBar();
		await userEvent.type(input(), "/review");
		await userEvent.click(screen.getByRole("button", { name: "Run as task" }));
		await waitFor(() =>
			expect(api.fn("createTask")).toHaveBeenCalledWith(
				"p1",
				"/review",
				"Do the thing",
				undefined,
			),
		);
	});

	it("un corps introuvable montre le détail du backend", async () => {
		routeBackend(() => ({ body: { detail: "No such command" }, ok: false }));
		renderBar();
		await userEvent.type(input(), "/nope{Control>}{Enter}{/Control}");
		expect(await screen.findByText("No such command")).toBeInTheDocument();
		expect(api.fn("createTask")).not.toHaveBeenCalled();
	});

	it("une commande inconnue montre l'erreur du backend", async () => {
		routeBackend(() => ({ body: { success: false, error: "Unknown command" } }));
		renderBar();
		await userEvent.type(input(), "/nope{Shift>}{Enter}{/Shift}");
		expect(await screen.findByText("Unknown command")).toBeInTheDocument();
	});

	it("une réponse vide montre l'échec sans détail", async () => {
		routeBackend(() => ({ body: null }));
		renderBar();
		await userEvent.type(input(), "/nope{Shift>}{Enter}{/Shift}");
		expect(await screen.findByText("Slash command failed")).toBeInTheDocument();
		expect(api.fn("createTask")).not.toHaveBeenCalled();
	});

	it("une carte refusée montre l'échec", async () => {
		api.fn("createTask").mockResolvedValue({ success: false, error: "disk" });
		renderBar();
		await userEvent.type(input(), "/review{Shift>}{Enter}{/Shift}");
		expect(await screen.findByText("Slash command failed")).toBeInTheDocument();
	});

	it("une panne du backend montre son message", async () => {
		routeBackend(() => new Error("backend down"));
		renderBar();
		await userEvent.type(input(), "/review{Shift>}{Enter}{/Shift}");
		expect(await screen.findByText("backend down")).toBeInTheDocument();
	});

	it("sans onglet de projet actif, refuse", async () => {
		useProjectStore.setState({ activeProjectId: null });
		renderBar();
		await userEvent.type(input(), "/review{Shift>}{Enter}{/Shift}");
		expect(await screen.findByText("Select a project first")).toBeInTheDocument();
	});

	it("un champ vide ne crée rien", async () => {
		renderBar();
		fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
		await act(() => Promise.resolve());
		expect(api.fn("createTask")).not.toHaveBeenCalled();
	});
});

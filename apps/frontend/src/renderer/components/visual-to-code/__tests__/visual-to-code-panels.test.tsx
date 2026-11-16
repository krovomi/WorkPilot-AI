/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { ArchitectureVersionMeta } from "../../../../shared/types/visual-to-code-history";

// The French fallbacks are the copy these components are written in; the mock
// answers them, with the interpolation and the plural the real `t` applies.
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
			const vars = (typeof fallback === "object" ? fallback : opts) ?? {};
			let raw = typeof fallback === "string" ? fallback : key;
			if (typeof fallback === "object") {
				const plural = vars.count !== undefined && vars.count !== 1 ? vars.defaultValue_other : undefined;
				raw = String(plural ?? vars.defaultValue ?? key);
			}
			return raw.replace(/\{\{(\w+)\}\}/g, (_m, n: string) => String(vars[n] ?? ""));
		},
		i18n: { language: "en" },
	}),
}));

vi.mock("file-saver", () => ({ saveAs: vi.fn() }));

// CodeMirror does not start under jsdom; the dock is asked which file it shows.
vi.mock("../../ui/code-editor", () => ({
	CodeEditor: ({ value, filename }: { value: string; filename?: string }) => (
		<pre data-testid="code-editor" data-filename={filename}>
			{value}
		</pre>
	),
}));

import { saveAs } from "file-saver";
import type { CustomBrick } from "../../../lib/custom-bricks";
import { useCustomBricksStore } from "../../../stores/custom-bricks-store";
import { type Architecture, useVisualToCodeStore } from "../../../stores/visual-to-code-store";
import { ArchitectureHistoryDock } from "../ArchitectureHistoryDock";
import { ArchitectureTabs } from "../ArchitectureTabs";
import { BrickEditorDialog } from "../BrickEditorDialog";
import { CanvasInspector } from "../CanvasInspector";
import { CanvasThemePicker } from "../CanvasThemePicker";
import { ColorSwatches } from "../ColorSwatches";
import { FlowCard } from "../FlowCard";
import { GeneratedCodeDock } from "../GeneratedCodeDock";
import { RelationField } from "../RelationField";

const initialStore = useVisualToCodeStore.getState();

beforeEach(() => {
	vi.resetAllMocks();
	useVisualToCodeStore.setState(initialStore, true);
});

function version(overrides: Partial<ArchitectureVersionMeta>): ArchitectureVersionMeta {
	return {
		id: "v1",
		createdAt: new Date().toISOString(),
		label: null,
		pinned: false,
		nodeCount: 2,
		edgeCount: 1,
		summary: null,
		restoredFrom: null,
		...overrides,
	};
}

function renderDock(props: Partial<Parameters<typeof ArchitectureHistoryDock>[0]> = {}) {
	const handlers = {
		onClose: vi.fn(),
		onRestore: vi.fn(),
		onLabel: vi.fn(),
		onDelete: vi.fn(),
	};
	render(
		<ArchitectureHistoryDock
			open
			architectureName="Shop"
			versions={[]}
			loading={false}
			error={null}
			{...handlers}
			{...props}
		/>,
	);
	return handlers;
}

describe("ArchitectureHistoryDock", () => {
	afterEach(() => vi.useRealTimers());

	it("renders nothing while closed", () => {
		renderDock({ open: false });
		expect(screen.queryByRole("complementary")).toBeNull();
	});

	it("says it is reading before the first rows, and what to do when there are none", () => {
		renderDock({ loading: true });
		expect(screen.getByText("Lecture de l'historique…")).toBeInTheDocument();
		expect(screen.queryByText(/Aucune étape enregistrée/)).toBeNull();
	});

	it("explains an empty timeline, shows the error and closes", () => {
		const { onClose } = renderDock({ error: "disk full" });
		expect(screen.getByText(/Aucune étape enregistrée/)).toBeInTheDocument();
		expect(screen.getByText("disk full")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
		expect(onClose).toHaveBeenCalled();
	});

	it("lists the newest step first and says what each one changed", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
		renderDock({
			versions: [
				version({ id: "first", createdAt: "2024-01-01T00:00:00Z" }),
				version({
					id: "second",
					createdAt: "2026-11-16T11:59:30Z",
					summary: {
						addedNodes: 2,
						removedNodes: 1,
						changedNodes: 3,
						addedEdges: 1,
						removedEdges: 1,
						sample: [],
					},
					restoredFrom: "first",
				}),
				version({
					id: "third",
					createdAt: "2026-11-16T11:55:00Z",
					summary: {
						addedNodes: 0,
						removedNodes: 0,
						changedNodes: 1,
						addedEdges: 1,
						removedEdges: 0,
						sample: [],
					},
				}),
				version({
					id: "fourth",
					createdAt: "not a date",
					label: "Avant la migration",
					pinned: true,
					summary: {
						addedNodes: 1,
						removedNodes: 0,
						changedNodes: 0,
						addedEdges: 0,
						removedEdges: 0,
						sample: [],
					},
				}),
				version({
					id: "fifth",
					createdAt: "2026-11-15T12:00:00Z",
					summary: {
						addedNodes: 0,
						removedNodes: 0,
						changedNodes: 0,
						addedEdges: 0,
						removedEdges: 0,
						sample: [],
					},
				}),
				version({ id: "sixth", createdAt: "2026-11-02T12:00:00Z" }),
				version({ id: "seventh", createdAt: "2026-09-16T12:00:00Z" }),
				version({ id: "eighth", createdAt: "2026-11-16T09:00:00Z" }),
			],
		});
		const rows = screen.getAllByRole("button", { name: "Supprimer cette étape" });
		expect(rows).toHaveLength(8);
		// Newest first: the last captured is the first row.
		expect(screen.getAllByText(/blocs, 1 connexions/)[0]).toHaveTextContent("3 hours ago");
		expect(screen.getByText("+2 blocs · −1 bloc · 3 modifiés · 2 connexions")).toBeInTheDocument();
		expect(screen.getByText("1 modifié · 1 connexion")).toBeInTheDocument();
		expect(screen.getByText("Aucun changement")).toBeInTheDocument();
		expect(screen.getByText("Retour à une étape antérieure")).toBeInTheDocument();
		// A named step keeps saying what it was.
		expect(screen.getByText("Avant la migration")).toBeInTheDocument();
		expect(screen.getByText("+1 bloc")).toBeInTheDocument();
		expect(screen.getAllByText("État initial")).toHaveLength(4);
		for (const when of ["30 seconds ago", "5 minutes ago", "yesterday", "2 weeks ago", "2 months ago", "3 years ago"]) {
			expect(screen.getByText(new RegExp(when))).toBeInTheDocument();
		}
	});

	it("restores and deletes the step of the row", () => {
		const { onRestore, onDelete } = renderDock({ versions: [version({ id: "v9" })] });
		fireEvent.click(screen.getByRole("button", { name: /Restaurer/ }));
		expect(onRestore).toHaveBeenCalledWith("v9");
		fireEvent.click(screen.getByRole("button", { name: "Supprimer cette étape" }));
		expect(onDelete).toHaveBeenCalledWith("v9");
	});

	it("names a step on Enter, and clears an empty name", () => {
		const { onLabel } = renderDock({ versions: [version({ id: "v1" })] });
		fireEvent.click(screen.getByRole("button", { name: "Nommer cette étape pour la conserver" }));
		const field = screen.getByLabelText("Nommer cette étape");
		fireEvent.change(field, { target: { value: "  Version livrée  " } });
		fireEvent.keyDown(field, { key: "Enter" });
		expect(onLabel).toHaveBeenCalledWith("v1", "Version livrée");
		expect(screen.queryByLabelText("Nommer cette étape")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Nommer cette étape pour la conserver" }));
		const again = screen.getByLabelText("Nommer cette étape");
		fireEvent.change(again, { target: { value: "   " } });
		fireEvent.blur(again);
		expect(onLabel).toHaveBeenLastCalledWith("v1", null);
	});

	it("leaves the name alone on Escape, and unpins a named step", () => {
		const { onLabel } = renderDock({
			versions: [version({ id: "a" }), version({ id: "b", label: "Livrée", pinned: true })],
		});
		fireEvent.click(screen.getByRole("button", { name: "Nommer cette étape pour la conserver" }));
		const field = screen.getByLabelText("Nommer cette étape");
		fireEvent.keyDown(field, { key: "x" });
		fireEvent.keyDown(field, { key: "Escape" });
		expect(screen.queryByLabelText("Nommer cette étape")).toBeNull();
		expect(onLabel).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: /Retirer le nom/ }));
		expect(onLabel).toHaveBeenCalledWith("b", null);
	});
});

function architecture(id: string, name: string, withWork = false): Architecture {
	return {
		id,
		name,
		diagramType: "architecture",
		nodes: withWork ? [{ id: "n", position: { x: 0, y: 0 }, data: {} }] : [],
		edges: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	} as Architecture;
}

describe("ArchitectureTabs", () => {
	function renderTabs() {
		const handlers = {
			onSelect: vi.fn(),
			onCreate: vi.fn(),
			onRename: vi.fn(),
			onDelete: vi.fn(),
		};
		render(
			<ArchitectureTabs
				architectures={[architecture("a", "Shop", true), architecture("b", "Blog")]}
				activeId="a"
				{...handlers}
			/>,
		);
		return handlers;
	}

	it("selects, creates and renames on Enter", () => {
		const { onSelect, onCreate, onRename } = renderTabs();
		expect(screen.getByRole("tab", { name: "Shop" })).toHaveAttribute("aria-selected", "true");
		fireEvent.click(screen.getByRole("tab", { name: "Blog" }));
		expect(onSelect).toHaveBeenCalledWith("b");
		fireEvent.click(screen.getByRole("button", { name: "Nouvelle architecture" }));
		expect(onCreate).toHaveBeenCalled();

		fireEvent.doubleClick(screen.getByRole("tab", { name: "Blog" }));
		const field = screen.getByLabelText("Renommer l'architecture");
		expect(field).toHaveValue("Blog");
		fireEvent.change(field, { target: { value: "Journal" } });
		fireEvent.keyDown(field, { key: "Enter" });
		expect(onRename).toHaveBeenCalledWith("b", "Journal");
	});

	it("drops a rename on Escape and commits one on blur", () => {
		const { onRename } = renderTabs();
		fireEvent.doubleClick(screen.getByRole("tab", { name: "Shop" }));
		const field = screen.getByLabelText("Renommer l'architecture");
		fireEvent.keyDown(field, { key: "a" });
		fireEvent.keyDown(field, { key: "Escape" });
		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByRole("tab", { name: "Shop" })).toBeInTheDocument();

		fireEvent.doubleClick(screen.getByRole("tab", { name: "Shop" }));
		fireEvent.blur(screen.getByLabelText("Renommer l'architecture"));
		expect(onRename).toHaveBeenCalledWith("a", "Shop");
	});

	it("closes an empty document outright and asks before one with work in it", async () => {
		const { onDelete } = renderTabs();
		fireEvent.click(screen.getByRole("button", { name: "Fermer l'architecture — Blog" }));
		expect(onDelete).toHaveBeenCalledWith("b");

		fireEvent.click(screen.getByRole("button", { name: "Fermer l'architecture — Shop" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText(/« Shop » et tout son historique/)).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole("button", { name: "Annuler" }));
		expect(onDelete).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: "Fermer l'architecture — Shop" }));
		const confirm = within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Supprimer" });
		fireEvent.click(confirm);
		expect(onDelete).toHaveBeenLastCalledWith("a");
		// A second press while the dialog closes deletes nothing more.
		fireEvent.click(confirm);
		expect(onDelete).toHaveBeenCalledTimes(2);
	});
});

describe("CanvasThemePicker", () => {
	it("is disabled with no architecture open", () => {
		useVisualToCodeStore.setState({ architectures: [], activeArchitectureId: null });
		render(<CanvasThemePicker />);
		expect(screen.getByRole("button", { name: /Couleurs/ })).toBeDisabled();
	});

	it("saves a preset, a colour of one's own, the way back to automatic, and the reset", async () => {
		const id = useVisualToCodeStore.getState().createArchitecture("Shop");
		const theme = () => useVisualToCodeStore.getState().architectures.find((a) => a.id === id)?.theme;
		render(<CanvasThemePicker />);
		fireEvent.click(screen.getByRole("button", { name: /Couleurs/ }));
		const app = await screen.findByRole("button", { name: "canvasThemeApp" });
		expect(app).toHaveAttribute("aria-pressed", "true");

		fireEvent.click(screen.getByRole("button", { name: "canvasThemeOcean" }));
		expect(theme()).toEqual({ preset: "ocean" });

		const background = screen.getByRole("group", { name: "canvasColorBackground" });
		fireEvent.click(within(background).getByRole("button", { name: "#ffffff" }));
		expect(theme()).toEqual({ preset: "ocean", colors: { background: "#ffffff" } });

		fireEvent.click(within(background).getByRole("button", { name: "Automatique" }));
		expect(theme()).toEqual({ preset: "ocean" });

		fireEvent.click(screen.getByRole("button", { name: "Revenir aux couleurs par défaut" }));
		expect(theme()).toBeUndefined();
	});

	it("writes nothing when the architecture closes while the colours are open", async () => {
		useVisualToCodeStore.getState().createArchitecture("Shop");
		render(<CanvasThemePicker />);
		fireEvent.click(screen.getByRole("button", { name: /Couleurs/ }));
		const ocean = await screen.findByRole("button", { name: "canvasThemeOcean" });
		act(() => useVisualToCodeStore.setState({ architectures: [], activeArchitectureId: null }));
		fireEvent.click(ocean);
		expect(useVisualToCodeStore.getState().architectures).toEqual([]);
	});
});

describe("FlowCard", () => {
	it("marks whether the card is selected", () => {
		const look = { accent: "#3b82f6", icon: () => null, kicker: "API" } as unknown as Parameters<typeof FlowCard>[0]["look"];
		const { container, rerender } = render(<FlowCard look={look} kicker="API">Orders</FlowCard>);
		expect(container.firstElementChild).toHaveAttribute("data-selected", "false");
		rerender(<FlowCard look={look} kicker="API" selected>Orders</FlowCard>);
		expect(container.firstElementChild).toHaveAttribute("data-selected", "true");
	});
});

describe("ColorSwatches", () => {
	it("marks the current colour and takes a free one from the picker", () => {
		const onChange = vi.fn();
		render(<ColorSwatches value="#3B82F6" onChange={onChange} label="Couleur" />);
		expect(screen.getByRole("button", { name: "#3b82f6" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.queryByRole("button", { name: "Automatique" })).toBeNull();
		const picker = screen.getByLabelText("Autre couleur");
		expect(picker).toHaveValue("#3b82f6");
		fireEvent.change(picker, { target: { value: "#123456" } });
		expect(onChange).toHaveBeenCalledWith("#123456");
	});

	it("opens the picker on the fallback when the colour is automatic", () => {
		render(<ColorSwatches value={undefined} onChange={vi.fn()} label="Couleur" fallback="#00ff00" allowAuto />);
		expect(screen.getByLabelText("Autre couleur")).toHaveValue("#00ff00");
		expect(screen.getByRole("button", { name: "Automatique" })).toHaveAttribute("aria-pressed", "true");
	});
});

describe("GeneratedCodeDock", () => {
	const files = [
		{ filename: "src/api/orders.ts", language: "ts", content: "export const orders = 1;" },
		{ filename: "src\\db\\schema.sql", language: "sql", content: "create table t();" },
	];

	it("renders nothing while shut", () => {
		render(<GeneratedCodeDock />);
		expect(screen.queryByRole("complementary")).toBeNull();
	});

	it("says it is generating in the app's language, then names the file being written", () => {
		useVisualToCodeStore.setState({
			dockOpen: true,
			phase: "generating",
			status: "Analyzing diagram...",
		});
		render(<GeneratedCodeDock />);
		// The backend's English progress line never reaches a French screen.
		expect(screen.queryByText("Analyzing diagram...")).toBeNull();
		expect(screen.getByText("Génération…")).toBeInTheDocument();
		expect(screen.getByText("En attente des premiers fichiers…")).toBeInTheDocument();
		expect(screen.getByText(/Les fichiers s'affichent ici/)).toBeInTheDocument();

		act(() => useVisualToCodeStore.setState({ writingFile: "src/app/main.ts" }));
		expect(screen.getByText("Écriture de main.ts…")).toBeInTheDocument();
		expect(screen.queryByText("En attente des premiers fichiers…")).toBeNull();
	});

	it("shows the files, switches between them and downloads one or all", () => {
		useVisualToCodeStore.setState({
			dockOpen: true,
			phase: "complete",
			streamedFiles: files,
			codeResult: { files, summary: "Deux fichiers", instructions: "", truncated: true },
		});
		render(<GeneratedCodeDock />);
		expect(screen.getByText("2 fichier(s)")).toBeInTheDocument();
		expect(screen.getByText(/s'est interrompue avant la fin/)).toBeInTheDocument();
		expect(screen.getByText("Deux fichiers")).toBeInTheDocument();
		expect(screen.getByTestId("code-editor")).toHaveAttribute("data-filename", "src/api/orders.ts");

		fireEvent.click(screen.getByRole("button", { name: /schema\.sql/ }));
		expect(screen.getByTestId("code-editor")).toHaveAttribute("data-filename", "src\\db\\schema.sql");

		fireEvent.click(screen.getByRole("button", { name: "Télécharger ce fichier" }));
		expect(vi.mocked(saveAs)).toHaveBeenLastCalledWith(expect.any(Blob), "schema.sql");
		fireEvent.click(screen.getByRole("button", { name: "Tout télécharger" }));
		expect(vi.mocked(saveAs)).toHaveBeenCalledTimes(3);
		expect(vi.mocked(saveAs).mock.calls[1][1]).toBe("orders.ts");

		fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
		expect(useVisualToCodeStore.getState().dockOpen).toBe(false);
	});

	it("keeps a name that is only a directory whole", () => {
		useVisualToCodeStore.setState({
			dockOpen: true,
			phase: "complete",
			streamedFiles: [{ filename: "assets/", language: "", content: "" }],
		});
		render(<GeneratedCodeDock />);
		expect(screen.getAllByText("assets/").length).toBeGreaterThanOrEqual(2);
	});

	it("disables the single download when the selected file is gone", () => {
		useVisualToCodeStore.setState({ dockOpen: true, phase: "complete", streamedFiles: files, selectedFile: 5 });
		render(<GeneratedCodeDock />);
		expect(screen.getByRole("button", { name: "Télécharger ce fichier" })).toBeDisabled();
		expect(screen.queryByTestId("code-editor")).toBeNull();
	});

	it("reports a failed run and an empty one", () => {
		useVisualToCodeStore.setState({ dockOpen: true, phase: "error", error: "quota" });
		const { unmount } = render(<GeneratedCodeDock />);
		expect(screen.getByText("quota")).toBeInTheDocument();
		expect(screen.getByText("Aucun fichier n'a été produit.")).toBeInTheDocument();
		unmount();

		useVisualToCodeStore.setState({ phase: "idle", error: null });
		render(<GeneratedCodeDock />);
		expect(screen.getByText("Lancez « Aperçu du code » pour générer.")).toBeInTheDocument();
	});
});

describe("RelationField", () => {
	it("is a plain field when no relation is usual for the pair", () => {
		const onChange = vi.fn();
		render(<RelationField id="r" value="" options={[]} onChange={onChange} />);
		fireEvent.change(screen.getByPlaceholderText("ex. HTTP / REST"), { target: { value: "SQL" } });
		expect(onChange).toHaveBeenCalledWith("SQL");
	});

	it("asks for a choice first, and keeps a typed relation when switching to free text", () => {
		const rafs: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => rafs.push(cb));
		const onChange = vi.fn();
		const { rerender } = render(<RelationField id="r" value="" options={["gRPC"]} onChange={onChange} />);
		const select = screen.getByRole("combobox") as HTMLSelectElement;
		expect(select.options[0]).toHaveTextContent("Choisir une relation…");

		// From an empty relation, the free-text entry opens without a write.
		fireEvent.change(select, { target: { value: select.options[2].value } });
		expect(onChange).not.toHaveBeenCalled();
		rerender(<RelationField id="r" value="" options={["gRPC"]} onChange={onChange} />);
		const own = screen.getByLabelText("Relation personnalisée");
		for (const cb of rafs) cb(0);
		expect(own).toHaveFocus();
		vi.unstubAllGlobals();
	});
});

describe("CanvasInspector", () => {
	const noop = vi.fn();

	it("renders nothing with nothing selected", () => {
		const { container } = render(
			<CanvasInspector
				node={null}
				edge={null}
				edgeEnds={null}
				defaultExplanation=""
				onNodeChange={noop}
				onDeleteNode={noop}
				onEdgeChange={noop}
				onDeleteEdge={noop}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("edits every field of a block and deletes it", () => {
		const onNodeChange = vi.fn();
		const onDeleteNode = vi.fn();
		render(
			<CanvasInspector
				node={{ id: "n1", position: { x: 0, y: 0 }, data: { label: "API", type: "backend", kicker: "Cœur", description: "Déjà" } }}
				edge={null}
				edgeEnds={null}
				defaultExplanation=""
				onNodeChange={onNodeChange}
				onDeleteNode={onDeleteNode}
				onEdgeChange={noop}
				onDeleteEdge={noop}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Orders API" } });
		expect(onNodeChange).toHaveBeenLastCalledWith("n1", { label: "Orders API" });
		fireEvent.change(screen.getByLabelText("Rôle affiché"), { target: { value: "" } });
		expect(onNodeChange).toHaveBeenLastCalledWith("n1", { kicker: undefined });
		fireEvent.click(screen.getByRole("button", { name: "#10b981" }));
		expect(onNodeChange).toHaveBeenLastCalledWith("n1", { accent: "#10b981" });

		const stack = screen.getByLabelText("Technologie") as HTMLSelectElement;
		expect(stack.tagName).toBe("SELECT");
		fireEvent.change(stack, { target: { value: stack.options[1].value } });
		expect(onNodeChange).toHaveBeenLastCalledWith("n1", { framework: stack.options[1].value });

		fireEvent.change(screen.getByLabelText("Ce que fait ce bloc"), { target: { value: "Prend les commandes" } });
		expect(onNodeChange).toHaveBeenLastCalledWith("n1", { description: "Prend les commandes" });
		fireEvent.change(screen.getByLabelText("Ce que fait ce bloc"), { target: { value: "" } });
		expect(onNodeChange).toHaveBeenLastCalledWith("n1", { description: undefined });

		fireEvent.click(screen.getByRole("button", { name: "Supprimer le bloc" }));
		expect(onDeleteNode).toHaveBeenCalledWith("n1");
	});

	it("names a block of a type it does not know by that type, and one without data as free", () => {
		const { unmount } = render(
			<CanvasInspector
				node={{ id: "n3", position: { x: 0, y: 0 }, data: { label: "Q", type: "quantum" } }}
				edge={null}
				edgeEnds={null}
				defaultExplanation=""
				onNodeChange={noop}
				onDeleteNode={noop}
				onEdgeChange={noop}
				onDeleteEdge={noop}
			/>,
		);
		expect(screen.getByText("quantum")).toBeInTheDocument();
		unmount();
		// A node read from an imported file may come without its data.
		render(
			<CanvasInspector
				node={{ id: "n4", position: { x: 0, y: 0 } } as Parameters<typeof CanvasInspector>[0]["node"]}
				edge={null}
				edgeEnds={null}
				defaultExplanation=""
				onNodeChange={noop}
				onDeleteNode={noop}
				onEdgeChange={noop}
				onDeleteEdge={noop}
			/>,
		);
		expect(screen.getByLabelText("Nom")).toHaveValue("");
	});

	it("takes a free-text stack for an untyped block", () => {
		const onNodeChange = vi.fn();
		render(
			<CanvasInspector
				node={{ id: "n2", position: { x: 0, y: 0 }, data: {} }}
				edge={null}
				edgeEnds={null}
				defaultExplanation=""
				onNodeChange={onNodeChange}
				onDeleteNode={noop}
				onEdgeChange={noop}
				onDeleteEdge={noop}
			/>,
		);
		expect(screen.getAllByText("Bloc libre").length).toBeGreaterThan(0);
		fireEvent.change(screen.getByLabelText("Technologie"), { target: { value: "Quarkus" } });
		expect(onNodeChange).toHaveBeenLastCalledWith("n2", { framework: "Quarkus" });
		fireEvent.change(screen.getByLabelText("Rôle affiché"), { target: { value: "Edge" } });
		expect(onNodeChange).toHaveBeenLastCalledWith("n2", { kicker: "Edge" });
	});

	it("writes a connection's own sentence, its colour back to automatic, its warnings, and deletes it", () => {
		const onEdgeChange = vi.fn();
		const onDeleteEdge = vi.fn();
		render(
			<CanvasInspector
				node={null}
				edge={{ id: "e1", source: "a", target: "b", data: { label: "SQL", color: "#10b981", description: "Lit" } }}
				edgeEnds={null}
				defaultExplanation="API lit la base"
				edgeWarnings={["Pilote absent"]}
				onNodeChange={noop}
				onDeleteNode={noop}
				onEdgeChange={onEdgeChange}
				onDeleteEdge={onDeleteEdge}
			/>,
		);
		expect(screen.getByRole("alert")).toHaveTextContent("Pilote absent");
		expect(screen.getByText("Votre texte, gardé tel quel.")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Explication"), { target: { value: "Lit les commandes" } });
		expect(onEdgeChange).toHaveBeenLastCalledWith("e1", { description: "Lit les commandes" });
		fireEvent.change(screen.getByLabelText("Explication"), { target: { value: "" } });
		expect(onEdgeChange).toHaveBeenLastCalledWith("e1", { description: null });
		fireEvent.click(screen.getByRole("button", { name: "Automatique" }));
		expect(onEdgeChange).toHaveBeenLastCalledWith("e1", { color: null });
		fireEvent.change(screen.getByLabelText("Relation"), { target: { value: "JDBC" } });
		expect(onEdgeChange).toHaveBeenLastCalledWith("e1", { label: "JDBC" });
		fireEvent.click(screen.getByRole("button", { name: "Supprimer la connexion" }));
		expect(onDeleteEdge).toHaveBeenCalledWith("e1");
	});

	it("says when a connection's sentence is the automatic one", () => {
		render(
			<CanvasInspector
				node={null}
				edge={{ id: "e1", source: "a", target: "b" }}
				edgeEnds={null}
				defaultExplanation=""
				onNodeChange={noop}
				onDeleteNode={noop}
				onEdgeChange={noop}
				onDeleteEdge={noop}
			/>,
		);
		expect(screen.getByLabelText("Relation")).toHaveValue("");
		expect(screen.getByText(/Texte automatique, réécrit/)).toBeInTheDocument();
	});
});

describe("BrickEditorDialog", () => {
	const brick: CustomBrick = {
		id: "b1",
		name: "Hermes",
		kicker: "Agent",
		accent: "#3b82f6",
		icon: "bot",
		description: "",
		stack: "",
	};

	beforeEach(() => useCustomBricksStore.setState({ bricks: [brick] }));

	it("edits a brick, previews its stack, and saves it", () => {
		const onOpenChange = vi.fn();
		render(<BrickEditorDialog open brick={brick} onOpenChange={onOpenChange} />);
		expect(screen.getByText("Modifier la brique")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Technologie par défaut (facultatif)"), {
			target: { value: "Python" },
		});
		fireEvent.change(screen.getByLabelText("Ce qu'elle fait"), { target: { value: "Orchestre" } });
		expect(screen.getByText("Python")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
		expect(useCustomBricksStore.getState().bricks[0]).toMatchObject({ stack: "Python", description: "Orchestre" });
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("deletes the brick, and cancels without a write", () => {
		const onOpenChange = vi.fn();
		const { unmount } = render(<BrickEditorDialog open brick={brick} onOpenChange={onOpenChange} />);
		fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(useCustomBricksStore.getState().bricks).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Supprimer la brique" }));
		expect(useCustomBricksStore.getState().bricks).toEqual([]);
		unmount();
	});

	it("says so when the brick was deleted before the save, and stays open", () => {
		const onOpenChange = vi.fn();
		useCustomBricksStore.setState({ bricks: [] });
		render(<BrickEditorDialog open brick={brick} onOpenChange={onOpenChange} />);
		fireEvent.click(screen.getByRole("button", { name: "#10b981" }));
		fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
		expect(screen.getByRole("alert")).toHaveTextContent(/n'a pas pu être enregistrée/);
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("previews an unnamed brick with its placeholder", () => {
		render(<BrickEditorDialog open brick={null} onOpenChange={vi.fn()} />);
		expect(screen.getByText("Nom de la brique")).toBeInTheDocument();
		expect(screen.getByText("Bloc personnalisé")).toBeInTheDocument();
	});
});

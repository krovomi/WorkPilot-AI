/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task } from "../../../shared/types";
import { TaskChangeGraph } from "./TaskChangeGraph";

// Le canvas n'est pas ce qui est testé ici — ReactFlow mesure le DOM, que jsdom
// n'a pas. Les nœuds et les arêtes deviennent des boutons, ce qui garde le
// branchement des clics vérifiable.
vi.mock("reactflow", () => ({
	__esModule: true,
	default: ({
		nodes,
		edges,
		onNodeClick,
		onEdgeClick,
		children,
	}: {
		nodes: Array<{ id: string; type: string }>;
		edges: Array<{ id: string; label: string }>;
		onNodeClick: (event: unknown, node: unknown) => void;
		onEdgeClick: (event: unknown, edge: unknown) => void;
		children: ReactNode;
	}) => (
		<div>
			{nodes
				.filter((n) => n.type === "change")
				.map((n) => (
					<button key={n.id} type="button" onClick={() => onNodeClick({}, n)}>
						node:{n.id}
					</button>
				))}
			{edges.map((e) => (
				<button key={e.id} type="button" onClick={() => onEdgeClick({}, e)}>
					edge:{e.id}
				</button>
			))}
			{children}
		</div>
	),
	Background: () => null,
	BackgroundVariant: { Dots: "dots" },
	Controls: () => null,
	Handle: () => null,
	MarkerType: { ArrowClosed: "arrowclosed" },
	Position: { Left: "left", Right: "right" },
}));
vi.mock("reactflow/dist/style.css", () => ({}));

const mockGetWorktreeDiff = vi.fn();
Object.defineProperty(window, "electronAPI", {
	value: { getWorktreeDiff: mockGetWorktreeDiff },
	writable: true,
});

const task = {
	id: "task-1",
	specId: "001-birth-date",
	title: "Date de naissance",
	description: "Ajouter la date de naissance au profil",
	status: "human_review",
	subtasks: [
		{
			id: "subtask-1-1",
			title: "Ajouter BirthDate à l'entité",
			description: "L'entité UserProfile porte la date de naissance",
			status: "completed",
			files: ["src/App.Domain/UserProfile.cs"],
		},
	],
} as unknown as Task;

const diff = {
	success: true,
	data: {
		summary: "",
		files: [
			{
				path: "src/App.Domain/UserProfile.cs",
				status: "modified",
				additions: 1,
				deletions: 0,
				patch: [
					"@@ -3,4 +3,5 @@ public class UserProfile",
					" {",
					"     public string Name { get; set; }",
					"+    public DateOnly BirthDate { get; set; }",
					" }",
				].join("\n"),
			},
			{
				path: "src/App.Application/UserProfileDto.cs",
				status: "added",
				additions: 1,
				deletions: 0,
				patch: [
					"@@ -0,0 +1 @@",
					"+public record UserProfileDto(string Name, DateOnly BirthDate) { public static UserProfileDto From(UserProfile p) => new(p.Name, p.BirthDate); }",
				].join("\n"),
			},
		],
	},
};

describe("TaskChangeGraph", () => {
	beforeEach(async () => {
		mockGetWorktreeDiff.mockReset();
		await i18n.changeLanguage("fr");
	});

	it("raconte la tâche, couche par couche", async () => {
		mockGetWorktreeDiff.mockResolvedValue(diff);
		render(<TaskChangeGraph task={task} />);
		expect(
			await screen.findByText(
				"J'ai modifié la classe UserProfile dans la couche Domain et j'y ai ajouté la propriété BirthDate.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(/J'ai créé le DTO UserProfileDto dans la couche Application/),
		).toBeInTheDocument();
	});

	it("un clic sur un nœud dit ce qu'il fait, et pour quelle sous-tâche", async () => {
		mockGetWorktreeDiff.mockResolvedValue(diff);
		render(<TaskChangeGraph task={task} />);
		fireEvent.click(await screen.findByText("node:src/App.Domain/UserProfile.cs#UserProfile"));
		const details = await screen.findByTestId("change-graph-node-details");
		expect(details).toHaveTextContent("src/App.Domain/UserProfile.cs");
		expect(details).toHaveTextContent("Ajouter BirthDate à l'entité");
		expect(details).toHaveTextContent("BirthDate");
	});

	it("un clic sur une arête l'explique et montre la ligne qui la porte", async () => {
		mockGetWorktreeDiff.mockResolvedValue(diff);
		render(<TaskChangeGraph task={task} />);
		fireEvent.click(await screen.findByText(/^edge:/));
		const details = await screen.findByTestId("change-graph-edge-details");
		expect(details).toHaveTextContent(
			"pour les faire passer à la couche Application",
		);
		expect(details).toHaveTextContent("UserProfileDto From(UserProfile p)");
	});

	it("dit quand il n'y a pas de diff", async () => {
		mockGetWorktreeDiff.mockResolvedValue({ success: false });
		render(<TaskChangeGraph task={task} />);
		await waitFor(() =>
			expect(screen.getByText(/diff de cette tâche n'est pas disponible/)).toBeInTheDocument(),
		);
	});
});

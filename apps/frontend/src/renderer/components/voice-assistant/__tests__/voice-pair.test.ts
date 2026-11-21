import { describe, expect, it } from "vitest";
import type { Task } from "@shared/types";
import { followableTasks, readGuidance } from "../voice-pair";

const task = (id: string, status: Task["status"], abandoned = false) =>
	({ id, status, title: id, metadata: abandoned ? { abandoned: true } : undefined }) as Task;

describe("the tasks pair mode can follow", () => {
	it("are those an agent works on now, not abandoned ones", () => {
		const tasks = [
			task("a", "in_progress"),
			task("b", "ai_review"),
			task("c", "backlog"),
			task("d", "in_progress", true),
			task("e", "human_review"),
		];
		expect(followableTasks(tasks).map((t) => t.id)).toEqual(["a", "b"]);
	});
});

describe("a message for the agent", () => {
	it("is what follows « dis-lui » or « tell it », without the joining word", () => {
		expect(readGuidance("Dis-lui d'ajouter des tests")).toBe("ajouter des tests");
		expect(readGuidance("dis à l'agent que la route doit rester en v1")).toBe("la route doit rester en v1");
		expect(readGuidance("Demande-lui de garder zod")).toBe("garder zod");
		expect(readGuidance("Tell it to open the settings file first")).toBe("open the settings file first");
		expect(readGuidance("tell the agent, use pnpm")).toBe("use pnpm");
		expect(readGuidance("Ask the agent to stop renaming things")).toBe("stop renaming things");
	});

	it("is nothing without the formula, or with nothing after it", () => {
		expect(readGuidance("ouvre le kanban")).toBeNull();
		expect(readGuidance("Dis-lui")).toBeNull();
		expect(readGuidance("dismiss it")).toBeNull();
		expect(readGuidance("tell")).toBeNull();
	});
});

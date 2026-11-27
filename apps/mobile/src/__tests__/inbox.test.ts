import type { BoardCard, ServerProject } from "../api/types";
import i18n from "../i18n";
import { inboxReason, inboxSummary, loadInbox, MAX_INBOX_PROJECTS } from "../inbox/forMe";

const card = (over: Partial<BoardCard> = {}): BoardCard => ({
	id: "001-login",
	title: "Login",
	column: "human_review",
	kind: null,
	updatedAt: "2026-11-22T10:00:00Z",
	subtasks: { completed: 0, total: 0 },
	specId: "s1",
	claimedBy: null,
	claimedByName: null,
	...over,
});
const project = (id: string, name = id): ServerProject => ({ id, name, repo_url: "", default_branch: "main" });
const all = () => true;
const only =
	(...granted: string[]) =>
	(permission: string) =>
		granted.includes(permission);

describe("inboxReason", () => {
	it("keeps only Human Review, and leaves a card claimed by someone else to them", () => {
		expect(inboxReason(card({ column: "in_progress" }), "u1", all)).toBeNull();
		expect(inboxReason(card({ claimedBy: "u2" }), "u1", all)).toBeNull();
		expect(inboxReason(card({ claimedBy: "u1" }), "u1", all)).toBe("review");
	});

	it("sorts by what to do, as the person's permissions allow it", () => {
		const plan = card({ reviewReason: "plan_review" });
		expect(inboxReason(plan, "u1", only("review.approve"))).toBe("plan");
		expect(inboxReason(plan, "u1", only("agent.execute"))).toBeNull();
		for (const reason of ["errors", "qa_rejected", "stopped", "prompt_too_long"]) {
			expect(inboxReason(card({ reviewReason: reason }), "u1", only("agent.execute"))).toBe("attention");
		}
		expect(inboxReason(card({ reviewReason: "errors" }), "u1", only("review.approve"))).toBeNull();
		expect(inboxReason(card({ reviewReason: "completed" }), "u1", only("agent.execute", "task.merge"))).toBe("review");
		expect(inboxReason(card({ reviewReason: "qa_unverified" }), "u1", only("agent.execute", "vcs.pr.create"))).toBe(
			"review",
		);
		expect(inboxReason(card(), "u1", only("agent.execute"))).toBeNull();
	});
});

describe("loadInbox", () => {
	it("reads each project's board, orders plans, then stops, then reviews, newest first", async () => {
		const boards: Record<string, BoardCard[]> = {
			shop: [
				card({ id: "003-done", updatedAt: "2026-11-22T09:00:00Z" }),
				card({ id: "004-plan", reviewReason: "plan_review" }),
				card({ id: "005-coding", column: "in_progress" }),
			],
			blog: [
				card({ id: "007-broke", reviewReason: "errors" }),
				card({ id: "008-new", updatedAt: null }),
				card({ id: "011-old", updatedAt: null }),
			],
		};
		const inbox = await loadInbox(
			[project("shop"), project("blog"), project("down", "Down")],
			async (id) => {
				if (!boards[id]) throw new Error("unreachable");
				return boards[id];
			},
			"u1",
			all,
		);
		expect(inbox.items.map((item) => `${item.project.id}/${item.card.id}`)).toEqual([
			"shop/004-plan",
			"blog/007-broke",
			"shop/003-done",
			"blog/008-new",
			"blog/011-old",
		]);
		expect(inbox.unreachable).toEqual(["Down"]);
	});

	it("reads at most a bounded number of projects", async () => {
		const cardsOf = jest.fn(async () => []);
		const many = Array.from({ length: MAX_INBOX_PROJECTS + 5 }, (_, i) => project(`p${i}`));
		await loadInbox(many, cardsOf, null, all);
		expect(cardsOf).toHaveBeenCalledTimes(MAX_INBOX_PROJECTS);
	});
});

describe("inboxSummary", () => {
	it("counts each reason, leaving out the empty ones", async () => {
		const items = (await loadInbox(
			[project("shop")],
			async () => [card({ id: "1", reviewReason: "plan_review" }), card({ id: "2", reviewReason: "plan_review" }), card({ id: "3" })],
			"u1",
			all,
		)).items;
		expect(inboxSummary(items, i18n.getFixedT("en"))).toBe("2 plans to approve · 1 to review");
		expect(inboxSummary(items.slice(2), i18n.getFixedT("fr"))).toBe("1 à relire");
	});
});

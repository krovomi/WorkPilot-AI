/**
 * "Needs you": the moments a task stops and waits for a person, named once.
 *
 * Read from the task's state machine when it settles, not from the agent
 * process's exit code. The exit code said "failed" for a plan waiting for
 * approval (the process exits 1 after PLANNING_COMPLETE when a review is
 * required), and said nothing at all for a QA that gave up without crashing.
 */
import type { ReviewReason } from "../../shared/types";

export type NeedsYouKind =
	| "plan_review"
	| "completed"
	| "qa_rejected"
	| "qa_unverified"
	| "failed"
	| "permission";

export interface NeedsYouEvent {
	kind: NeedsYouKind;
	taskId: string;
	projectId: string;
	taskTitle: string;
	/** The machine's error message, for `failed`. */
	detail?: string;
}

/** The settled state as a reason to call someone, or null when it is not one. */
export function needsYouKind(
	state: string,
	reviewReason: ReviewReason | undefined,
): NeedsYouKind | null {
	if (state === "plan_review") return "plan_review";
	if (state === "error") return "failed";
	if (state !== "human_review") return null;
	switch (reviewReason) {
		case "plan_review":
			return "plan_review";
		case "completed":
			return "completed";
		case "qa_rejected":
			return "qa_rejected";
		case "qa_unverified":
			return "qa_unverified";
		case "errors":
		case "prompt_too_long":
			return "failed";
		default:
			// "stopped": the person did it, and is looking.
			return null;
	}
}

/** Only a plan waiting for approval may be answered from afar: approving it
 * starts coding in the task's worktree, which a reset undoes. A finished
 * task's review leads to a merge, which nothing undoes. */
export function remotelyApprovable(kind: NeedsYouKind): boolean {
	return kind === "plan_review";
}

const STRINGS = {
	en: {
		plan_review: ["Plan waiting for you", '"{title}": the plan is ready. Coding starts once you approve it.'],
		completed: ["Ready for review", '"{title}" is done and waiting for your review.'],
		qa_rejected: ["QA needs you", '"{title}": QA could not get the build to pass and handed it over.'],
		qa_unverified: ["QA could not conclude", '"{title}": the work is complete but QA reached no verdict.'],
		failed: ["Task stopped on an error", '"{title}" stopped on an error.'],
		permission: ["The agent asks before acting", '"{title}": the agent is waiting for your answer on the card.'],
		approve: "Approve the plan",
		approved: "Approved: coding has started.",
		expired: "This approval has expired or was already used. Open WorkPilot.",
		notPending: "The plan is no longer waiting for approval.",
		appClosed: "WorkPilot's window is closed. Open the app to approve.",
		test: ["WorkPilot test", "Notifications reach you here."],
	},
	fr: {
		plan_review: ["Un plan t'attend", "« {title} » : le plan est prêt. Le code démarre dès que tu l'approuves."],
		completed: ["Prête pour ta revue", "« {title} » est terminée et attend ta revue."],
		qa_rejected: ["La QA a besoin de toi", "« {title} » : la QA n'a pas réussi à faire passer le build et passe la main."],
		qa_unverified: ["La QA n'a pas conclu", "« {title} » : le travail est fini mais la QA n'a rendu aucun verdict."],
		failed: ["Tâche arrêtée sur une erreur", "« {title} » s'est arrêtée sur une erreur."],
		permission: ["L'agent demande avant d'agir", "« {title} » : l'agent attend ta réponse sur la carte."],
		approve: "Approuver le plan",
		approved: "Approuvé : le code a démarré.",
		expired: "Cette approbation a expiré ou a déjà servi. Ouvre WorkPilot.",
		notPending: "Le plan n'attend plus d'approbation.",
		appClosed: "La fenêtre de WorkPilot est fermée. Ouvre l'app pour approuver.",
		test: ["Test WorkPilot", "Les notifications t'arrivent bien ici."],
	},
} as const;

type Lang = keyof typeof STRINGS;
export type ReplyKey = "approve" | "approved" | "expired" | "notPending" | "appClosed";

function lang(language: string): Lang {
	return language.startsWith("fr") ? "fr" : "en";
}

/**
 * The notification's title and body, in the app's language. The error
 * detail is for the desktop only (`withDetail`): a remote channel is a third
 * party, and an error message can carry paths and fragments of output.
 */
export function message(
	event: NeedsYouEvent,
	language: string,
	withDetail = false,
): { title: string; body: string } {
	const [title, body] = STRINGS[lang(language)][event.kind];
	const text = body.replace("{title}", event.taskTitle);
	const detail = withDetail && event.kind === "failed" && event.detail ? `\n${event.detail.slice(0, 300)}` : "";
	return { title, body: text + detail };
}

export function testMessage(language: string): { title: string; body: string } {
	const [title, body] = STRINGS[lang(language)].test;
	return { title, body };
}

export function reply(key: ReplyKey, language: string): string {
	return STRINGS[lang(language)][key];
}

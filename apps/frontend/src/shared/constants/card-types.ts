/**
 * The visual type of a Kanban card: one colour family per kind of work,
 * resolved from data the card already carries (the work kind decided by
 * `apps/backend/tasks/classify.py`, the category, the security severity,
 * the imported item type, the origin). Nothing new is asked of the user.
 *
 * The colour lives on the card's background (corner glow + top edge); the
 * left rail stays the column's accent. Design: docs/architecture/kanban-card-colors.md.
 */
import type { TaskCategory, TaskKind, TaskMetadata } from "../types/task";

export type CardType =
	| "feature"
	| "ux"
	| "bug"
	| "hotfix"
	| "security"
	| "perf"
	| "refactor"
	| "test"
	| "investigation"
	| "spike"
	| "docs"
	| "run"
	| "upgrade"
	| "infra";

export type CardTypeFamily = "build" | "fix" | "quality" | "know" | "ops";

export interface CardTypeDefinition {
	id: CardType;
	family: CardTypeFamily;
	/** Base hue, mixed with the active theme's surfaces at render time. */
	color: string;
}

/** Ordered by family; the order is the one of the legend and the settings. */
export const CARD_TYPES: readonly CardTypeDefinition[] = [
	{ id: "feature", family: "build", color: "#3B82F6" },
	{ id: "ux", family: "build", color: "#EC4899" },
	{ id: "bug", family: "fix", color: "#F43F5E" },
	{ id: "hotfix", family: "fix", color: "#DC2626" },
	{ id: "security", family: "quality", color: "#F97316" },
	{ id: "perf", family: "quality", color: "#8B5CF6" },
	{ id: "refactor", family: "quality", color: "#14B8A6" },
	{ id: "test", family: "quality", color: "#22C55E" },
	{ id: "investigation", family: "know", color: "#6366F1" },
	{ id: "spike", family: "know", color: "#84CC16" },
	{ id: "docs", family: "know", color: "#B08D57" },
	{ id: "run", family: "ops", color: "#F59E0B" },
	{ id: "upgrade", family: "ops", color: "#0EA5E9" },
	{ id: "infra", family: "ops", color: "#64748B" },
];

export const CARD_TYPE_IDS: readonly CardType[] = CARD_TYPES.map((t) => t.id);

const KIND_TO_TYPE: Record<TaskKind, CardType> = {
	feature: "feature",
	bug_fix: "bug",
	hotfix: "hotfix",
	investigation: "investigation",
	run: "run",
	refactoring: "refactor",
	test: "test",
	docs: "docs",
	spike: "spike",
	upgrade: "upgrade",
};

const CATEGORY_TO_TYPE: Record<TaskCategory, CardType> = {
	feature: "feature",
	bug_fix: "bug",
	refactoring: "refactor",
	documentation: "docs",
	security: "security",
	performance: "perf",
	ui_ux: "ux",
	infrastructure: "infra",
	testing: "test",
};

const SOURCE_TO_TYPE: Partial<Record<string, CardType>> = {
	"tech-debt": "refactor",
	"flaky-tests": "test",
};

/** Below this the backend's kind is a proposal (same threshold as TaskKindBadge). */
export const CARD_TYPE_PROPOSED_BELOW = 0.6;

export interface ResolvedCardType {
	type: CardType;
	/** The automatic classification hesitated: shown dashed and paler. */
	proposed: boolean;
	/** Other types the card also carries, shown as dots after the chip. */
	secondary: CardType[];
	/** What decided it, shown in the card's hover preview. */
	basis: CardTypeBasis;
}

export type CardTypeBasis =
	| "user"
	| "category"
	| "import"
	| "keywords"
	| "severity"
	| "origin";

function typeOfKind(kind: unknown): CardType | undefined {
	return typeof kind === "string"
		? KIND_TO_TYPE[kind as TaskKind]
		: undefined;
}

function typeOfCategory(category: unknown): CardType | undefined {
	return typeof category === "string"
		? CATEGORY_TO_TYPE[category as TaskCategory]
		: undefined;
}

function importedType(metadata: TaskMetadata): CardType | undefined {
	const raw = metadata.jiraType ?? metadata.azureDevOpsType;
	if (typeof raw !== "string") return undefined;
	return /\b(bug|defect|anomalie)\b/i.test(raw) ? "bug" : undefined;
}

/**
 * The card's visual type. Order: the user's own choice of kind, then a hotfix,
 * then security (category or severity), then a bug, then the work kind, then
 * the category, then the imported item type and the origin. A kind the
 * backend only defaulted (`kindSource: "default"`) says nothing, so a card
 * with no other information stays neutral (`null`).
 */
export function resolveCardType(
	metadata: TaskMetadata | undefined,
): ResolvedCardType | null {
	if (!metadata) return null;
	const kindSource = metadata.kindSource;
	const kindType =
		kindSource === "default" ? undefined : typeOfKind(metadata.kind);
	const categoryType = typeOfCategory(metadata.category);
	const securityType: CardType | undefined =
		categoryType === "security" || metadata.securitySeverity
			? "security"
			: undefined;
	const bugType: CardType | undefined =
		kindType === "bug" || categoryType === "bug" ? "bug" : undefined;
	const imported = importedType(metadata);
	const fallback =
		imported ??
		(typeof metadata.sourceType === "string"
			? SOURCE_TO_TYPE[metadata.sourceType]
			: undefined);
	const kindBasis: CardTypeBasis =
		kindSource === "category" || kindSource === "import"
			? kindSource
			: "keywords";

	let primary: CardType | undefined;
	let fromKind = false;
	let basis: CardTypeBasis = "category";
	if (kindSource === "user" && kindType) {
		primary = kindType;
		basis = "user";
	} else if (kindType === "hotfix") {
		primary = "hotfix";
		fromKind = true;
	} else if (securityType) {
		primary = securityType;
		basis = categoryType === "security" ? "category" : "severity";
	} else if (bugType) {
		primary = bugType;
		fromKind = kindType === "bug" && categoryType !== "bug";
	} else if (kindType && kindType !== "feature") {
		primary = kindType;
		fromKind = true;
	} else if (categoryType) {
		primary = categoryType;
	} else if (kindType) {
		primary = kindType;
		fromKind = true;
	} else {
		primary = fallback;
		basis = imported ? "import" : "origin";
	}
	if (!primary) return null;
	if (fromKind) basis = kindBasis;

	const confidence = metadata.kindConfidence;
	const proposed =
		fromKind &&
		kindSource !== "user" &&
		typeof confidence === "number" &&
		confidence < CARD_TYPE_PROPOSED_BELOW;

	const secondary: CardType[] = [];
	for (const other of [kindType, categoryType, securityType]) {
		if (
			other &&
			other !== primary &&
			other !== "feature" &&
			!secondary.includes(other)
		) {
			secondary.push(other);
		}
	}
	return { type: primary, proposed, secondary, basis };
}

const TYPE_TO_KIND: Partial<Record<CardType, TaskKind>> = Object.fromEntries(
	Object.entries(KIND_TO_TYPE).map(([kind, type]) => [type, kind]),
) as Partial<Record<CardType, TaskKind>>;

const TYPE_TO_CATEGORY: Partial<Record<CardType, TaskCategory>> = {
	ux: "ui_ux",
	security: "security",
	perf: "performance",
	infra: "infrastructure",
};

/**
 * The metadata that makes a card show `type` when a person picks it (quick
 * add, context menu, bulk bar). A type that is a work kind is recorded as the
 * person's own kind (`kindSource: "user"`, which the backend never
 * overwrites). The four types that only exist as a category (UI / UX,
 * security, performance, infra) set that category and a plain feature kind
 * decided by it, so `resolveCardType` reaches the category.
 */
export function cardTypeChoiceMetadata(
	type: CardType,
): Pick<TaskMetadata, "kind" | "kindSource" | "category"> {
	const kind = TYPE_TO_KIND[type];
	if (kind) return { kind, kindSource: "user" };
	return {
		category: TYPE_TO_CATEGORY[type],
		kind: "feature",
		kindSource: "category",
	};
}

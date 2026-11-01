/**
 * The roadmap and ideation files, as the runners write them (snake_case
 * JSON: `prompts/roadmap_features.md`, `ideation/formatter.py`), read
 * defensively: a file written by an agent can miss any field, and a field
 * of the wrong type is dropped rather than drawn.
 */

export interface RoadmapFeature {
	id: string;
	title: string;
	description: string;
	priority: string | null;
	complexity: string | null;
	impact: string | null;
	phaseId: string | null;
	status: string;
	linkedCardId: string | null;
}

export interface RoadmapPhase {
	id: string;
	name: string;
	description: string;
	order: number;
}

export interface RoadmapView {
	vision: string;
	phases: RoadmapPhase[];
	features: RoadmapFeature[];
}

export const IDEA_TYPES = [
	"code_improvements",
	"ui_ux_improvements",
	"documentation_gaps",
	"security_hardening",
	"performance_optimizations",
	"code_quality",
] as const;
export type IdeaType = (typeof IDEA_TYPES)[number];

export interface Idea {
	id: string;
	type: IdeaType;
	title: string;
	description: string;
	rationale: string;
	status: string;
	/** Severity, effort or impact, whichever the idea's type carries. */
	level: string | null;
	linkedCardId: string | null;
}

type Json = Record<string, unknown>;

function parse(content: string | undefined): Json | null {
	if (!content) return null;
	try {
		const value: unknown = JSON.parse(content);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
	} catch {
		return null;
	}
}

function text(value: unknown, max = 5_000): string {
	return typeof value === "string" ? value.slice(0, max) : "";
}

function optional(value: unknown): string | null {
	return typeof value === "string" && value ? value.slice(0, 80) : null;
}

function objects(value: unknown): Json[] {
	return Array.isArray(value) ? value.filter((v): v is Json => !!v && typeof v === "object" && !Array.isArray(v)) : [];
}

export function readRoadmap(content: string | undefined): RoadmapView | null {
	const roadmap = parse(content);
	if (!roadmap) return null;
	const phases = objects(roadmap.phases)
		.map((p, index) => ({
			id: text(p.id, 200),
			name: text(p.name, 200),
			description: text(p.description),
			order: typeof p.order === "number" ? p.order : index + 1,
		}))
		.filter((p) => p.id)
		.sort((a, b) => a.order - b.order);
	const features = objects(roadmap.features)
		.map((f) => ({
			id: text(f.id, 200),
			title: text(f.title, 300),
			description: text(f.description),
			priority: optional(f.priority),
			complexity: optional(f.complexity),
			impact: optional(f.impact),
			phaseId: optional(f.phase_id),
			status: optional(f.status) ?? "idea",
			linkedCardId: optional(f.linked_spec_id),
		}))
		.filter((f) => f.id && f.title);
	return { vision: text(roadmap.vision, 2_000), phases, features };
}

export function readIdeas(content: string | undefined): Idea[] {
	const session = parse(content);
	if (!session) return [];
	return objects(session.ideas)
		.map((i) => ({
			id: text(i.id, 200),
			type: i.type as IdeaType,
			title: text(i.title, 300),
			description: text(i.description),
			rationale: text(i.rationale),
			status: optional(i.status) ?? "draft",
			level: optional(i.severity) ?? optional(i.estimated_effort) ?? optional(i.impact),
			linkedCardId: optional(i.linked_task_id),
		}))
		.filter((i) => i.id && i.title && (IDEA_TYPES as readonly string[]).includes(i.type));
}

/** The features of each phase, in phase order; features of no known phase last. */
export function featuresByPhase(view: RoadmapView): { phase: RoadmapPhase | null; features: RoadmapFeature[] }[] {
	const known = new Set(view.phases.map((p) => p.id));
	const groups = view.phases.map((phase) => ({
		phase: phase as RoadmapPhase | null,
		features: view.features.filter((f) => f.phaseId === phase.id),
	}));
	const rest = view.features.filter((f) => !f.phaseId || !known.has(f.phaseId));
	if (rest.length) groups.push({ phase: null, features: rest });
	return groups.filter((g) => g.features.length > 0);
}

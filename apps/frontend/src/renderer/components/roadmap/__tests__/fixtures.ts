import type {
	CompetitorAnalysis,
	Roadmap,
	RoadmapFeature,
	RoadmapPhase,
} from "../../../../shared/types";

export const feature = (id: string, over: Partial<RoadmapFeature> = {}): RoadmapFeature => ({
	id,
	title: `Feature ${id}`,
	description: `What ${id} does`,
	rationale: `Why ${id}`,
	priority: "must",
	complexity: "medium",
	impact: "high",
	phaseId: "p1",
	dependencies: [],
	status: "planned",
	acceptanceCriteria: [],
	userStories: [],
	source: { provider: "internal" },
	...over,
});

export const phase = (id: string, over: Partial<RoadmapPhase> = {}): RoadmapPhase => ({
	id,
	name: `Phase ${id}`,
	description: `About ${id}`,
	order: 1,
	status: "planned",
	features: [],
	milestones: [],
	...over,
});

export const roadmap = (over: Partial<Roadmap> = {}): Roadmap => ({
	id: "rm",
	projectId: "proj",
	projectName: "Acme",
	version: "1",
	vision: "Ship the best widgets",
	targetAudience: { primary: "Developers", secondary: [] },
	phases: [phase("p1")],
	features: [feature("f1")],
	status: "active",
	createdAt: new Date(0),
	updatedAt: new Date(1),
	...over,
});

export const analysis = (over: Partial<CompetitorAnalysis> = {}): CompetitorAnalysis => ({
	projectContext: { projectName: "Acme", projectType: "app", targetAudience: "devs" },
	competitors: [
		{
			id: "c1",
			name: "Rival",
			url: "https://rival.example",
			description: "A rival",
			relevance: "high",
			painPoints: [
				{ id: "pp1", description: "Slow sync", source: "forum", severity: "high", frequency: "often", opportunity: "Be fast" },
				{ id: "pp2", description: "No export", source: "store", severity: "medium", frequency: "some", opportunity: "Export" },
				{ id: "pp3", description: "Ugly icons", source: "blog", severity: "low", frequency: "rare", opportunity: "Icons" },
			],
			strengths: [],
			marketPosition: "leader",
		},
	],
	marketGaps: [],
	insightsSummary: { topPainPoints: [], differentiatorOpportunities: [], marketTrends: [] },
	researchMetadata: { searchQueriesUsed: [], sourcesConsulted: [], limitations: [] },
	createdAt: new Date("2026-11-01T10:00:00Z"),
	...over,
});

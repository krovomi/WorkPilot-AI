/**
 * Carbon profiler (#365): the estimated footprint of the models a project uses.
 * Every figure is an estimate; `carbon_profiler/factors.py` gives the method.
 */

export type ComputeSource = "llm_cloud" | "llm_local";
export type ModelTier = "small" | "medium" | "large";

export interface EnergyRecord {
	timestamp: string;
	source: ComputeSource;
	provider: string;
	model: string;
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	durationS: number;
	task: string;
	phase: string;
	agent: string;
	kwh: number;
	co2G: number;
	tier: ModelTier;
	region: string;
	method: "tokens" | "local-tokens" | "local-power";
	estimated: true;
	hostKnown: boolean;
}

export interface CarbonBreakdown {
	co2G: number;
	kwh: number;
	calls: number;
}

export type CarbonAdvice =
	| { code: "review_on_fast"; share: number; saving: number }
	| { code: "use_cache"; provider: string; share: number }
	| { code: "cleaner_region"; provider: string; from: string; to: string; saving: number }
	| { code: "local_vs_cloud"; localWh: number; cloudWh: number };

export type BudgetState = "none" | "ok" | "warning" | "exceeded";

export interface CarbonBudget {
	month: string;
	usedG: number;
	budgetG: number;
	percent: number | null;
	alertPercent: number;
	state: BudgetState;
	degrade: boolean;
	degraded: boolean;
}

export interface CarbonConfig {
	region: string;
	monthlyBudgetKg: number;
	alertPercent: number;
	degrade: boolean;
	localPowerW: number;
	cpuOnly: boolean;
	factors: Record<string, number | string>;
	/** The grid regions the estimate knows. */
	regions: string[];
}

export type CarbonConfigInput = Omit<CarbonConfig, "regions">;

export interface CarbonReport {
	month: string;
	records: EnergyRecord[];
	recordCount: number;
	totalKwh: number;
	totalCo2G: number;
	periodStart: string;
	periodEnd: string;
	byProvider: Record<string, number>;
	byModel: Record<string, number>;
	byPhase: Record<string, CarbonBreakdown>;
	byTask: Record<string, CarbonBreakdown>;
	months: { month: string; co2G: number; kwh: number }[];
	carKm: number;
	advice: CarbonAdvice[];
	unknownHosts: string[];
	generatedAt: string;
	summary: string;
	hasLedger: boolean;
	budget: CarbonBudget;
	config: CarbonConfig;
}

export type CarbonExportFormat = "json" | "csv" | "md";

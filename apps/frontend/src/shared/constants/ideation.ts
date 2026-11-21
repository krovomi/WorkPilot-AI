/**
 * Ideation-related constants
 * Types, categories, and configuration for AI-generated project improvements
 */

// ============================================
// Ideation Types
// ============================================

// Ideation type labels and descriptions
// Note: high_value_features removed - strategic features belong to Roadmap
// low_hanging_fruit renamed to code_improvements to cover all code-revealed opportunities
export const IDEATION_TYPE_LABELS: Record<string, string> = {
	code_improvements: "Code Improvements",
	ui_ux_improvements: "UI/UX Improvements",
	documentation_gaps: "Documentation",
	security_hardening: "Security",
	performance_optimizations: "Performance",
	code_quality: "Code Quality",
};

// Ideation type colors
export const IDEATION_TYPE_COLORS: Record<string, string> = {
	code_improvements: "bg-success/10 text-success border-success/30",
	ui_ux_improvements: "bg-info/10 text-info border-info/30",
	documentation_gaps: "bg-amber-500/10 text-amber-500 border-amber-500/30",
	security_hardening:
		"bg-destructive/10 text-destructive border-destructive/30",
	performance_optimizations:
		"bg-purple-500/10 text-purple-400 border-purple-500/30",
	code_quality: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
};

// Ideation type icons (Lucide icon names)
export const IDEATION_TYPE_ICONS: Record<string, string> = {
	code_improvements: "Zap",
	ui_ux_improvements: "Palette",
	documentation_gaps: "BookOpen",
	security_hardening: "Shield",
	performance_optimizations: "Gauge",
	code_quality: "Code2",
};

// ============================================
// Ideation Status
// ============================================

export const IDEATION_STATUS_COLORS: Record<string, string> = {
	draft: "bg-muted text-muted-foreground",
	selected: "bg-primary/10 text-primary",
	converted: "bg-success/10 text-success",
	dismissed: "bg-destructive/10 text-destructive line-through",
	archived: "bg-violet-500/10 text-violet-400",
};

// ============================================
// Ideation Effort/Complexity
// ============================================

// Ideation effort colors (full spectrum for code_improvements)
export const IDEATION_EFFORT_COLORS: Record<string, string> = {
	trivial: "bg-success/10 text-success",
	small: "bg-info/10 text-info",
	medium: "bg-warning/10 text-warning",
	large: "bg-orange-500/10 text-orange-400",
	complex: "bg-destructive/10 text-destructive",
};

// ============================================
// Ideation Impact
// ============================================

export const IDEATION_IMPACT_COLORS: Record<string, string> = {
	low: "bg-muted text-muted-foreground",
	medium: "bg-info/10 text-info",
	high: "bg-warning/10 text-warning",
	critical: "bg-destructive/10 text-destructive",
};

// ============================================
// Severity Colors
// ============================================

// Security severity colors
export const SECURITY_SEVERITY_COLORS: Record<string, string> = {
	low: "bg-info/10 text-info",
	medium: "bg-warning/10 text-warning",
	high: "bg-orange-500/10 text-orange-500",
	critical: "bg-destructive/10 text-destructive",
};

// Code quality severity colors
export const CODE_QUALITY_SEVERITY_COLORS: Record<string, string> = {
	suggestion: "bg-info/10 text-info",
	minor: "bg-warning/10 text-warning",
	major: "bg-orange-500/10 text-orange-500",
	critical: "bg-destructive/10 text-destructive",
};

// ============================================
// Default Configuration
// ============================================

// Default ideation config
// Note: high_value_features removed, low_hanging_fruit renamed to code_improvements
export const DEFAULT_IDEATION_CONFIG = {
	enabledTypes: [
		"code_improvements",
		"ui_ux_improvements",
		"security_hardening",
	] as const,
	includeRoadmapContext: true,
	includeKanbanContext: true,
	maxIdeasPerType: 5,
};

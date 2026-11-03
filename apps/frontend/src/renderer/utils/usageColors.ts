import {
	THRESHOLD_CRITICAL,
	THRESHOLD_ELEVATED,
	THRESHOLD_WARNING,
} from "../components/usage/usageConstants";

/**
 * Utility functions for determining usage colors and gradients
 */

/**
 * Returns the appropriate color class based on usage percentage
 */
export function getColorClass(percent: number): string {
	if (percent >= THRESHOLD_CRITICAL) {
		return "text-destructive";
	}
	if (percent >= THRESHOLD_WARNING) {
		return "text-orange-500";
	}
	if (percent >= THRESHOLD_ELEVATED) {
		return "text-warning";
	}
	return "text-success";
}

/**
 * Returns the appropriate gradient class based on usage percentage
 */
export function getGradientClass(percent: number): string {
	if (percent >= THRESHOLD_CRITICAL) {
		return "bg-linear-to-r from-red-500 to-red-600";
	}
	if (percent >= THRESHOLD_WARNING) {
		return "bg-linear-to-r from-orange-500 to-orange-600";
	}
	if (percent >= THRESHOLD_ELEVATED) {
		return "bg-linear-to-r from-yellow-500 to-yellow-600";
	}
	return "bg-linear-to-r from-green-500 to-green-600";
}

/**
 * Returns the appropriate background color class for usage indicators
 */
export function getUsageBgColorClass(percent: number): string {
	if (percent >= THRESHOLD_CRITICAL) {
		return "bg-destructive/10";
	}
	if (percent >= THRESHOLD_WARNING) {
		return "bg-orange-500/10";
	}
	if (percent >= THRESHOLD_ELEVATED) {
		return "bg-warning/10";
	}
	return "bg-success/10";
}

/**
 * Returns the appropriate border color class for usage indicators
 */
export function getUsageBorderColorClass(percent: number): string {
	if (percent >= THRESHOLD_CRITICAL) {
		return "border-destructive/20";
	}
	if (percent >= THRESHOLD_WARNING) {
		return "border-orange-500/20";
	}
	if (percent >= THRESHOLD_ELEVATED) {
		return "border-warning/20";
	}
	return "border-success/20";
}

/**
 * Returns the appropriate text color class for usage indicators
 * Alias for getColorClass for semantic clarity
 */
export function getUsageTextColorClass(percent: number): string {
	return getColorClass(percent);
}

/**
 * Get background/border color classes for badges based on usage percentage
 */
export function getBadgeColorClasses(percent: number): string {
	if (percent >= THRESHOLD_CRITICAL)
		return "text-destructive bg-destructive/10 border-destructive/20";
	if (percent >= THRESHOLD_WARNING)
		return "text-orange-500 bg-orange-500/10 border-orange-500/20";
	if (percent >= THRESHOLD_ELEVATED)
		return "text-warning bg-warning/10 border-warning/20";
	return "text-success bg-success/10 border-success/20";
}

/**
 * Get background class for small usage bars based on usage percentage
 */
export function getBarColorClass(percent: number): string {
	if (percent >= THRESHOLD_CRITICAL) return "bg-destructive";
	if (percent >= THRESHOLD_WARNING) return "bg-orange-500";
	if (percent >= THRESHOLD_ELEVATED) return "bg-warning";
	return "bg-success";
}

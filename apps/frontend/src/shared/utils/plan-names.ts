/**
 * Readable plan names, built from what each provider reports.
 *
 * Every function takes the provider's own identifiers ("max" and
 * "default_claude_max_20x", "plus", "individual"…) and returns a product
 * name ("Claude Max 20x", "ChatGPT Plus", "Copilot Pro"), or `undefined`
 * when the provider said nothing. An identifier this file does not know is
 * shown as reported, made readable ("some_new_tier" → "Some New Tier"),
 * never replaced by a guess. Product names are not translated.
 */

/** "some_new-tier" → "Some New Tier" */
export function readableIdentifier(value: string): string {
	return value
		.trim()
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(" ");
}

function clean(value: string | null | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	// A plan identifier is a short word; anything longer is not one.
	if (!trimmed || trimmed.length > 64) return undefined;
	return trimmed;
}

/**
 * Claude subscription, from the `subscriptionType` and `rateLimitTier` that
 * Claude Code stores with its OAuth credentials.
 */
export function claudePlanName(
	subscriptionType: string | null | undefined,
	rateLimitTier?: string | null,
): string | undefined {
	// Anthropic's organization types spell it "claude_max", Claude Code "max".
	const type = clean(subscriptionType)
		?.toLowerCase()
		.replace(/^claude[_-]/, "");
	if (!type) return undefined;
	if (type === "max") {
		// "default_claude_max_20x" → 20x; Max comes in 5x and 20x.
		const multiplier = clean(rateLimitTier)?.match(/max_(\d+)x/i)?.[1];
		return multiplier ? `Claude Max ${multiplier}x` : "Claude Max";
	}
	const known: Record<string, string> = {
		pro: "Claude Pro",
		team: "Claude Team",
		enterprise: "Claude Enterprise",
		free: "Claude Free",
	};
	return known[type] ?? `Claude ${readableIdentifier(type)}`;
}

/** ChatGPT plan, from the `plan_type` Codex CLI and ChatGPT report. */
export function chatgptPlanName(
	planType: string | null | undefined,
): string | undefined {
	const type = clean(planType)?.toLowerCase();
	if (!type) return undefined;
	const known: Record<string, string> = {
		free: "ChatGPT Free",
		go: "ChatGPT Go",
		plus: "ChatGPT Plus",
		pro: "ChatGPT Pro",
		team: "ChatGPT Team",
		business: "ChatGPT Business",
		enterprise: "ChatGPT Enterprise",
		edu: "ChatGPT Edu",
	};
	return known[type] ?? `ChatGPT ${readableIdentifier(type)}`;
}

/**
 * GitHub Copilot plan, from `/copilot_internal/user`: `copilot_plan`
 * ("free", "individual", "business", "enterprise") and `access_type_sku`,
 * which tells Pro+ apart from Pro inside the "individual" plan.
 */
export function copilotPlanName(
	plan: string | null | undefined,
	sku?: string | null,
): string | undefined {
	const type = clean(plan)?.toLowerCase();
	const skuId = clean(sku)?.toLowerCase() ?? "";
	if (skuId.includes("free_limited")) return "Copilot Free";
	if (!type) return undefined;
	if (type === "individual") {
		return skuId.includes("plus") ? "Copilot Pro+" : "Copilot Pro";
	}
	const known: Record<string, string> = {
		free: "Copilot Free",
		individual_pro: "Copilot Pro+",
		business: "Copilot Business",
		enterprise: "Copilot Enterprise",
	};
	return known[type] ?? `Copilot ${readableIdentifier(type)}`;
}

/** Windsurf plan, from the `planName` its IDE caches ("Pro", "Teams"…). */
export function windsurfPlanName(
	planName: string | null | undefined,
): string | undefined {
	const name = clean(planName);
	if (!name) return undefined;
	return /^windsurf\b/i.test(name) ? name : `Windsurf ${name}`;
}

/** Cursor plan, from the `cursorAuth/stripeMembershipType` its IDE stores. */
export function cursorPlanName(
	membershipType: string | null | undefined,
): string | undefined {
	const type = clean(membershipType)?.toLowerCase();
	if (!type) return undefined;
	const known: Record<string, string> = {
		free: "Cursor Hobby",
		free_trial: "Cursor Pro Trial",
		pro: "Cursor Pro",
		pro_plus: "Cursor Pro+",
		ultra: "Cursor Ultra",
		business: "Cursor Teams",
		team: "Cursor Teams",
		enterprise: "Cursor Enterprise",
	};
	return known[type] ?? `Cursor ${readableIdentifier(type)}`;
}

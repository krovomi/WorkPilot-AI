import type { UsagePlan } from "@shared/types";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface UsagePlanBadgeProps {
	readonly plan?: UsagePlan;
	readonly className?: string;
}

/**
 * The plan of the account shown: its name when the provider reports one
 * ("Claude Max 20x", "ChatGPT Plus"), otherwise the billing mode only
 * (subscription, or an API key billed per use). Nothing when unknown.
 */
export function UsagePlanBadge({ plan, className }: UsagePlanBadgeProps) {
	const { t } = useTranslation(["common"]);
	if (!plan) return null;

	const isApi = plan.billing === "api";
	let label: string;
	if (plan.name) {
		label = plan.name;
	} else if (isApi) {
		label = t("common:usage.planApiKey");
	} else {
		label = t("common:usage.planSubscription");
	}
	const title = isApi
		? t("common:usage.planApiKeyHint")
		: t("common:usage.planSubscriptionHint");

	return (
		<span
			data-testid="usage-plan-badge"
			title={title}
			className={cn(
				"inline-flex items-center max-w-full truncate text-3xs px-1.5 py-0.5 rounded font-semibold border",
				isApi
					? "bg-muted text-muted-foreground border-border"
					: "bg-primary/10 text-primary border-primary/20",
				className,
			)}
		>
			{label}
		</span>
	);
}

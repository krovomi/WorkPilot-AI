import { FlaskConical } from "lucide-react";
import type { ElementType } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * Flags a view as experimental without taking any of the label's room.
 *
 * A word-sized "Experimental" badge after the label truncated short labels
 * such as "Garde de régression" to "Gar…" in the default sidebar width. This
 * marker is a small flask overlaid on the corner of the entry's own icon, so
 * the label keeps its full width, and the collapsed rail (which keeps only
 * icons) shows the same mark. The tooltip and the accessible name carry the
 * full sentence.
 */
export function ExperimentalMarker({ size = "md" }: { size?: "md" | "sm" }) {
	const { t } = useTranslation(["navigation"]);
	const label = `${t("navigation:experimental.badge")}: ${t("navigation:experimental.tooltip")}`;

	return (
		<span
			role="img"
			aria-label={label}
			title={label}
			data-testid="experimental-marker"
			className={cn(
				"absolute flex items-center justify-center rounded-full p-px text-amber-500",
				// The ring matches what sits behind: the sidebar, or the rail's popover.
				size === "md" ? "-bottom-1.5 -right-1.5 bg-sidebar" : "-bottom-1 -right-1 bg-popover",
			)}
		>
			<FlaskConical
				aria-hidden="true"
				className={size === "md" ? "h-2.5 w-2.5" : "h-2 w-2"}
				strokeWidth={2.75}
			/>
		</span>
	);
}

interface NavIconProps {
	icon: ElementType;
	experimental: boolean;
	/** `md` for menu rows (16px icon), `sm` for the collapsed rail's lists (12px). */
	size?: "md" | "sm";
}

/** A menu entry's icon, with the experimental marker on its corner when it applies. */
export function NavIcon({ icon: Icon, experimental, size = "md" }: NavIconProps) {
	return (
		<span className="relative shrink-0">
			<Icon className={size === "md" ? "h-4 w-4" : "h-3 w-3"} />
			{experimental && <ExperimentalMarker size={size} />}
		</span>
	);
}

/**
 * The hover text of a menu label: its full name (a long one is truncated in
 * the row), plus that the view is in beta when it is experimental.
 */
export function navLabelTitle(
	t: (key: string, options?: Record<string, unknown>) => string,
	labelKey: string, experimental: boolean): string {
	const label = t(labelKey);
	return experimental ? t("navigation:experimental.labelTooltip", { label }) : label;
}

/**
 * The strip above an experimental view's page: the same flask as its menu
 * entry, and in words that the view is in beta and may change or go away.
 */
export function BetaBanner() {
	const { t } = useTranslation(["navigation"]);
	return (
		<div
			role="note"
			data-testid="beta-banner"
			className="flex shrink-0 items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs"
		>
			<FlaskConical aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
			<p>
				<span className="font-semibold text-amber-500">{t("navigation:experimental.bannerTitle")}</span>
				<span className="text-muted-foreground"> · {t("navigation:experimental.bannerBody")}</span>
			</p>
		</div>
	);
}

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

export type MenuMode = "essential" | "full";

interface MenuModeCardProps {
	/** How many pages « Essentiel » pins. */
	readonly essentialCount: number;
	readonly onChoose: (mode: MenuMode) => void;
}

/**
 * Asked once in « Mon menu », while nothing is pinned: « Essentiel » pins the
 * pages of every day and hides the beta views, « Complet » keeps everything.
 * Resetting the layout asks again.
 */
export function MenuModeCard({ essentialCount, onChoose }: MenuModeCardProps) {
	const { t } = useTranslation("navigation");
	const titleId = useId();
	return (
		<section
			aria-labelledby={titleId}
			data-testid="menu-mode-card"
			className="mx-1 rounded-lg border border-border bg-card/60 p-3 text-sm"
		>
			<h3 id={titleId} className="font-medium text-foreground">
				{t("menuMode.title")}
			</h3>
			<p className="mt-1 text-xs text-muted-foreground">{t("menuMode.body")}</p>
			<div className="mt-3 space-y-2">
				<Button size="sm" className="w-full" onClick={() => onChoose("essential")}>
					{t("menuMode.essential")}
				</Button>
				<p className="text-xs text-muted-foreground">
					{t("menuMode.essentialHint", { count: essentialCount })}
				</p>
				<Button size="sm" variant="outline" className="w-full" onClick={() => onChoose("full")}>
					{t("menuMode.full")}
				</Button>
				<p className="text-xs text-muted-foreground">{t("menuMode.fullHint")}</p>
			</div>
		</section>
	);
}

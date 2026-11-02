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

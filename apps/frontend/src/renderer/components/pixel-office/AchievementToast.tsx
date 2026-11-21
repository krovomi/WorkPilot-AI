import { Trophy, X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { AchievementId } from "../../lib/pixel-office-achievements";
import { ACHIEVEMENT_ICONS } from "./achievement-icons";

/** How long an achievement stays on screen before the next one, in ms. */
export const ACHIEVEMENT_TOAST_MS = 6000;

interface AchievementToastProps {
	readonly achievement: AchievementId | undefined;
	readonly onDismiss: () => void;
	/** Calm: no entrance animation. */
	readonly calm: boolean;
}

/**
 * The office's own announcement of an achievement just earned. It lives in
 * the office, not in the app's toaster, so it shows in TV mode as well, and a
 * screen reader hears it through a polite live region.
 */
export function AchievementToast({
	achievement,
	onDismiss,
	calm,
}: AchievementToastProps) {
	useEffect(() => {
		if (!achievement) return;
		const timer = setTimeout(onDismiss, ACHIEVEMENT_TOAST_MS);
		return () => clearTimeout(timer);
	}, [achievement, onDismiss]);

	return (
		<div
			role="status"
			aria-live="polite"
			className="absolute top-3 right-3 pointer-events-none"
			style={{ zIndex: 30 }}
		>
			{achievement && (
				<ToastCard id={achievement} onDismiss={onDismiss} calm={calm} />
			)}
		</div>
	);
}

function ToastCard({
	id,
	onDismiss,
	calm,
}: {
	readonly id: AchievementId;
	readonly onDismiss: () => void;
	readonly calm: boolean;
}) {
	const { t } = useTranslation(["pixelOffice"]);
	const Icon = ACHIEVEMENT_ICONS[id];
	return (
		<div
			data-testid="achievement-toast"
			className={`pointer-events-auto flex items-start gap-3 rounded-xl px-4 py-3 max-w-xs ${calm ? "" : "animate-in fade-in slide-in-from-top-2"}`}
			style={{
				background: "rgba(20,14,50,0.95)",
				border: "1px solid rgba(250,204,21,0.45)",
			}}
		>
			<span className="mt-0.5 shrink-0" style={{ color: "#FACC15" }} aria-hidden>
				<Icon className="h-5 w-5" />
			</span>
			<span className="flex min-w-0 flex-col">
				<span className="flex items-center gap-1 text-3xs font-mono uppercase" style={{ color: "#FDE68A" }}>
					<Trophy className="h-3 w-3" aria-hidden />
					{t("pixelOffice:achievements.unlocked")}
				</span>
				<span className="text-sm font-bold text-white">
					{t(`pixelOffice:achievements.items.${id}.name`)}
				</span>
				<span className="text-xs text-white/70">
					{t(`pixelOffice:achievements.items.${id}.description`)}
				</span>
			</span>
			<button
				type="button"
				onClick={onDismiss}
				className="shrink-0 text-white/50 hover:text-white"
				aria-label={t("pixelOffice:achievements.dismiss")}
			>
				<X className="h-4 w-4" />
			</button>
		</div>
	);
}

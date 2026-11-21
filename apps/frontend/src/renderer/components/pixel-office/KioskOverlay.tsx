import { Minimize2, Pause, Play, Trophy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatAppTime } from "../../lib/date-format";
import { Button } from "../ui/button";

/** How often the clock is redrawn, in ms. Minutes are all it shows. */
const CLOCK_TICK_MS = 15_000;

export interface KioskStats {
	readonly active: number;
	readonly waiting: number;
	readonly shippedToday: number;
	readonly achievements: number;
}

interface KioskOverlayProps {
	readonly stats: KioskStats;
	readonly calm: boolean;
	/** Calm forced by the system's reduced-motion setting: the switch cannot undo it. */
	readonly calmLocked: boolean;
	readonly onToggleCalm: () => void;
	readonly onExit: () => void;
}

/**
 * TV mode's header: big numbers readable from across the room, a clock, and
 * the two controls a wall screen needs (calm mode, leave).
 */
export function KioskOverlay({
	stats,
	calm,
	calmLocked,
	onToggleCalm,
	onExit,
}: KioskOverlayProps) {
	const { t } = useTranslation(["pixelOffice"]);
	const [now, setNow] = useState(() => new Date());

	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
		return () => clearInterval(timer);
	}, []);

	const tiles: { key: keyof KioskStats; label: string }[] = [
		{ key: "active", label: t("pixelOffice:kiosk.active") },
		{ key: "waiting", label: t("pixelOffice:kiosk.waiting") },
		{ key: "shippedToday", label: t("pixelOffice:kiosk.shippedToday") },
		{ key: "achievements", label: t("pixelOffice:kiosk.achievements") },
	];

	return (
		<div
			data-testid="kiosk-overlay"
			className="flex items-center justify-between gap-6 px-8 py-4 shrink-0 border-b border-white/10"
			style={{ background: "#12122A" }}
		>
			<div className="flex items-baseline gap-4">
				<span className="text-3xl font-bold font-mono text-white">
					{t("pixelOffice:title")}
				</span>
				<span className="text-2xl font-mono text-white/60" data-testid="kiosk-clock">
					{formatAppTime(now, { hour: "2-digit", minute: "2-digit" })}
				</span>
			</div>

			<dl className="flex items-center gap-8">
				{tiles.map((tile) => (
					<div key={tile.key} className="flex flex-col items-center">
						<dt className="text-sm uppercase tracking-wide text-white/50">
							{tile.key === "achievements" && (
								<Trophy className="mr-1 inline h-4 w-4" aria-hidden />
							)}
							{tile.label}
						</dt>
						<dd
							className="text-4xl font-bold font-mono text-white"
							data-testid={`kiosk-${tile.key}`}
						>
							{stats[tile.key]}
						</dd>
					</div>
				))}
			</dl>

			<div className="flex items-center gap-2">
				<Button
					variant="secondary"
					size="lg"
					onClick={onToggleCalm}
					disabled={calmLocked}
					aria-pressed={calm}
					title={calmLocked ? t("pixelOffice:kiosk.calmLocked") : undefined}
				>
					{calm ? <Play className="h-5 w-5" aria-hidden /> : <Pause className="h-5 w-5" aria-hidden />}
					{t(calm ? "pixelOffice:kiosk.calmOff" : "pixelOffice:kiosk.calmOn")}
				</Button>
				<Button variant="secondary" size="lg" onClick={onExit}>
					<Minimize2 className="h-5 w-5" aria-hidden />
					{t("pixelOffice:kiosk.exit")}
				</Button>
			</div>
		</div>
	);
}

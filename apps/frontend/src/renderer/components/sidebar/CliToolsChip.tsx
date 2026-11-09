import { Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { CLI_TOOLS, CliToolBadges } from "../CliToolBadges";
import type { CliPresence, CliToolId } from "../cli-tool-order";
import { Button } from "../ui/button";

interface CliToolsChipProps {
	readonly isCollapsed: boolean;
	readonly onNavigateToTerminals: () => void;
}

type PresenceMap = Readonly<Partial<Record<CliToolId, CliPresence>>>;

/** How many CLIs are installed, and whether every check has answered. */
export function summarizeCliPresence(presence: PresenceMap, total = CLI_TOOLS.length) {
	const answers = Object.values(presence);
	return {
		installed: answers.filter((p) => p === "installed").length,
		total,
		checked: answers.length >= total,
	};
}

/**
 * The menu's « Outils CLI », folded into one chip at its foot: « CLI 1/8 » and
 * a dot (green when an agent CLI is ready, amber when none is). The chip opens
 * the same badges as before, above it. The badges stay mounted while closed,
 * so their checks run and the count is right before anyone opens it; a
 * badge's own popover (install, update) is not an outside click.
 */
export function CliToolsChip({ isCollapsed, onNavigateToTerminals }: CliToolsChipProps) {
	const { t } = useTranslation("navigation");
	const [open, setOpen] = useState(false);
	const [presence, setPresence] = useState<PresenceMap>({});
	const rootRef = useRef<HTMLDivElement>(null);
	const { installed, total, checked } = summarizeCliPresence(presence);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element | null;
			if (!target || rootRef.current?.contains(target)) return;
			// A badge's popover or dialog renders in a portal, outside the chip.
			if (target.closest("[data-radix-popper-content-wrapper], [role='dialog'], [role='alertdialog']")) return;
			setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const label = checked
		? t("cliTools.chipTooltip", { installed, total })
		: t("cliTools.checking");

	return (
		<div ref={rootRef} className={cn("relative", isCollapsed && "flex justify-center")}>
			<section
				hidden={!open}
				aria-label={t("cliTools.title")}
				className="absolute bottom-full left-0 z-50 mb-2 w-64 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
			>
				<CliToolBadges
					isCollapsed={false}
					onNavigateToTerminals={onNavigateToTerminals}
					onPresenceMapChange={setPresence}
				/>
			</section>
			<Button
				type="button"
				variant="ghost"
				size={isCollapsed ? "icon" : "sm"}
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				aria-label={label}
				title={label}
				data-testid="cli-tools-chip"
				className={cn(
					"relative gap-2 text-xs font-medium",
					!isCollapsed && "h-8 rounded-full border border-border px-3",
				)}
			>
				<Wrench className="h-3.5 w-3.5" />
				{!isCollapsed && (
					<span className="tabular-nums">{t("cliTools.chip", { installed, total })}</span>
				)}
				<span
					aria-hidden="true"
					className={cn(
						"h-2 w-2 rounded-full",
						isCollapsed && "absolute right-1.5 bottom-1.5",
						!checked && "bg-muted-foreground/50",
						checked && installed > 0 && "bg-success",
						checked && installed === 0 && "bg-warning",
					)}
				/>
			</Button>
		</div>
	);
}

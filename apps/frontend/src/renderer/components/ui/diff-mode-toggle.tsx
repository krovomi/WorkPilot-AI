import { AlignJustify, Columns2, Sparkles } from "lucide-react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import type { DiffViewMode } from "./diff-model";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "./tooltip";

const MODES: ReadonlyArray<{
	mode: DiffViewMode;
	icon: ComponentType<{ className?: string }>;
}> = [
	{ mode: "auto", icon: Sparkles },
	{ mode: "unified", icon: AlignJustify },
	{ mode: "split", icon: Columns2 },
];

interface DiffModeToggleProps {
	readonly value: DiffViewMode;
	readonly onChange: (mode: DiffViewMode) => void;
	readonly className?: string;
}

/**
 * Auto / unified / side-by-side switch shared by every diff view. "Auto" puts
 * a file side by side only when it has both removals and additions and the
 * view is wide enough.
 */
export function DiffModeToggle({
	value,
	onChange,
	className,
}: DiffModeToggleProps) {
	const { t } = useTranslation(["common"]);
	// Own provider: the toggle also sits in views mounted outside the app shell.
	return (
		<TooltipProvider delayDuration={300}>
			<fieldset
				aria-label={t("common:diffViewer.mode.label")}
				className={cn(
					"m-0 flex min-w-0 items-center gap-0.5 rounded-md border border-border bg-secondary/30 p-0.5",
					className,
				)}
			>
				{MODES.map(({ mode, icon: Icon }) => (
					<Tooltip key={mode}>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={() => onChange(mode)}
								aria-pressed={value === mode}
								aria-label={t(`common:diffViewer.mode.${mode}`)}
								className={cn(
									"flex h-7 w-7 items-center justify-center rounded transition-colors",
									value === mode
										? "bg-primary/15 text-primary"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								<Icon className="h-3.5 w-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom" className="max-w-xs">
							{t(`common:diffViewer.mode.${mode}Hint`)}
						</TooltipContent>
					</Tooltip>
				))}
			</fieldset>
		</TooltipProvider>
	);
}

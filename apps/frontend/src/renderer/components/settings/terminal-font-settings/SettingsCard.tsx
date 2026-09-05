import type { LucideIcon } from "lucide-react";
import { cn } from "../../../lib/utils";

interface SettingsCardProps {
	readonly icon: LucideIcon;
	readonly title: string;
	readonly description: string;
	readonly children: React.ReactNode;
	readonly className?: string;
}

/**
 * Card shell used by every terminal font settings panel.
 *
 * The settings pane is narrow and holds five panels in a row, so each one needs
 * its own visible boundary: without it the headings, the descriptions and the
 * controls of three panels read as one long column of grey text.
 */
export function SettingsCard({
	icon: Icon,
	title,
	description,
	children,
	className,
}: SettingsCardProps) {
	return (
		<section
			className={cn(
				"rounded-xl border border-border bg-card overflow-hidden",
				className,
			)}
		>
			<header className="flex items-start gap-3 border-b border-border/60 bg-muted/30 px-5 py-4">
				<span className="shrink-0 rounded-lg bg-primary/10 p-2 text-primary">
					<Icon className="h-4 w-4" aria-hidden="true" />
				</span>
				<div className="min-w-0 space-y-1">
					<h3 className="text-sm font-semibold text-foreground">{title}</h3>
					<p className="text-xs leading-relaxed text-muted-foreground">
						{description}
					</p>
				</div>
			</header>
			<div className="p-5">{children}</div>
		</section>
	);
}

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
				"wp-card overflow-hidden",
				className,
			)}
		>
			<header className="flex items-start gap-3 border-b border-dashed border-border px-5 py-4">
				<span className="wp-empty-glyph h-8 w-8 shrink-0" aria-hidden="true">
					<Icon className="h-4 w-4" />
				</span>
				<div className="min-w-0 space-y-1">
					<h3 className="wp-title text-sm">{title}</h3>
					<p className="wp-muted text-xs leading-relaxed">
						{description}
					</p>
				</div>
			</header>
			<div className="p-5">{children}</div>
		</section>
	);
}

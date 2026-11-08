/**
 * The header every view opens with: icon, title, one-line description and
 * the view's own actions on the right. Views used to style this themselves
 * (eleven different title sizes and weights), so moving from one view to the
 * next changed the type scale. Use this instead of a hand-written `<h1>`.
 *
 * `variant="bar"` (default) is the full-width band with a bottom border, for
 * views that fill the height and scroll inside. `variant="inline"` is the same
 * header without the band, for views that are one padded scrolling page.
 *
 * Inside a charter `ModuleStage` (components/charter) the header takes the
 * charter look: transparent band with a dashed rule, glowing icon tile, and
 * the optional `kicker` (mono uppercase, in the accent) above the title.
 */
import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils";

export interface PageHeaderProps {
	/** A short mono uppercase label above the title (the charter's kicker). */
	readonly kicker?: React.ReactNode;
	readonly title: React.ReactNode;
	readonly description?: React.ReactNode;
	readonly icon?: LucideIcon;
	/** Buttons, badges or selects shown on the right of the title. */
	readonly actions?: React.ReactNode;
	/** A row under the title, such as tabs or summary figures. */
	readonly children?: React.ReactNode;
	readonly variant?: "bar" | "inline";
	readonly className?: string;
}

export function PageHeader({
	kicker,
	title,
	description,
	icon: Icon,
	actions,
	children,
	variant = "bar",
	className,
}: PageHeaderProps): React.ReactElement {
	return (
		<header
			data-slot="page-header"
			data-variant={variant}
			className={cn(
				variant === "bar" && "shrink-0 border-b border-border bg-background px-6 py-4",
				className,
			)}
		>
			<div className="flex items-start justify-between gap-4">
				<div className="flex min-w-0 items-center gap-3">
					{Icon && (
						<div
							data-slot="page-header-icon"
							className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10"
						>
							<Icon className="h-5 w-5 text-primary" aria-hidden="true" />
						</div>
					)}
					<div className="min-w-0">
						{kicker && (
							<div className="mb-0.5 font-mono text-3xs font-semibold uppercase tracking-[0.09em] text-primary">
								{kicker}
							</div>
						)}
						<h1 className="text-xl font-semibold leading-tight text-foreground">
							{title}
						</h1>
						{description && (
							<div className="mt-0.5 text-sm text-muted-foreground">{description}</div>
						)}
					</div>
				</div>
				{actions && (
					<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
						{actions}
					</div>
				)}
			</div>
			{children && <div className="mt-3">{children}</div>}
		</header>
	);
}

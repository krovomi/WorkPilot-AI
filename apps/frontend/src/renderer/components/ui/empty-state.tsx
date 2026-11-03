/**
 * What a view or a panel shows when it has nothing to list yet: an icon, a
 * short title, one sentence on why and, when there is one, the action that
 * fills it. Six views had their own copy with different sizes and spacing.
 */
import type * as React from "react";
import { cn } from "../../lib/utils";

export interface EmptyStateProps {
	/** A Lucide icon, or any icon component that takes a `className`. */
	readonly icon?: React.ComponentType<{ className?: string }>;
	readonly title?: React.ReactNode;
	readonly description?: React.ReactNode;
	/** A button or link that gets the person out of the empty state. */
	readonly action?: React.ReactNode;
	readonly className?: string;
}

export function EmptyState({
	icon: Icon,
	title,
	description,
	action,
	className,
}: EmptyStateProps): React.ReactElement {
	return (
		<div
			className={cn(
				"flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center",
				className,
			)}
		>
			{Icon && (
				<div
					className="flex h-12 w-12 items-center justify-center rounded-full bg-muted"
					aria-hidden="true"
				>
					<Icon className="h-6 w-6 text-muted-foreground" />
				</div>
			)}
			{title && <h3 className="text-base font-semibold text-foreground">{title}</h3>}
			{description && (
				<p className="max-w-md text-sm text-muted-foreground">{description}</p>
			)}
			{action}
		</div>
	);
}

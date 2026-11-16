import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "../../../lib/utils";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "../../ui/collapsible";

export interface CollapsibleCardProps {
	title: string;
	icon?: React.ReactNode;
	badge?: React.ReactNode;
	headerAction?: React.ReactNode;
	children: React.ReactNode;
	defaultOpen?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	className?: string;
}

/**
 * Reusable Collapsible Card Component
 * Consistent styling for collapsible sections throughout the PR review UI
 */
export function CollapsibleCard({
	title,
	icon,
	badge,
	headerAction,
	children,
	defaultOpen = true,
	open: controlledOpen,
	onOpenChange,
	className,
}: CollapsibleCardProps) {
	const [internalOpen, setInternalOpen] = useState(defaultOpen);
	const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;
	const setIsOpen = onOpenChange || setInternalOpen;

	return (
		<Collapsible
			open={isOpen}
			onOpenChange={setIsOpen}
			className={cn(
				"border rounded-lg bg-card shadow-sm overflow-hidden",
				className,
			)}
		>
			{/* The header is a real button, so the keyboard opens the card; an
			    action of the header sits beside it, never inside. */}
			<div className="flex items-center gap-2 pr-4 bg-muted/30 hover:bg-muted/40 transition-colors">
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className="flex-1 min-w-0 p-4 pr-0 flex items-center justify-between gap-3 text-left cursor-pointer"
					>
						<div className="flex items-center gap-3 min-w-0">
							<div className="shrink-0">
								{isOpen ? (
									<ChevronDown className="h-4 w-4 text-muted-foreground" />
								) : (
									<ChevronRight className="h-4 w-4 text-muted-foreground" />
								)}
							</div>
							{icon && <div className="shrink-0">{icon}</div>}
							<span className="font-medium truncate">{title}</span>
						</div>
						{badge && <div className="flex items-center shrink-0">{badge}</div>}
					</button>
				</CollapsibleTrigger>
				{headerAction}
			</div>
			<CollapsibleContent>{children}</CollapsibleContent>
		</Collapsible>
	);
}

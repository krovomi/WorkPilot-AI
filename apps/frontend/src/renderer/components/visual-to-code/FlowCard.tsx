import type React from "react";
import type { ResolvedLook } from "../../lib/custom-bricks";

interface FlowCardProps {
	look: ResolvedLook;
	/** The role above the name, already translated. */
	kicker: string;
	/** The name, or the field that edits it. */
	children: React.ReactNode;
	stack?: string;
	selected?: boolean;
	/** Shown on hover: what the block does, for a brick that says so. */
	hint?: string;
	className?: string;
}

/**
 * The card a block is drawn as: a small uppercase role in the block's colour
 * above its name, the chosen stack beside the role. Shared by the canvas node
 * and the brick editor's preview, so what is designed is what gets placed.
 */
export function FlowCard({
	look,
	kicker,
	children,
	stack,
	selected = false,
	hint,
	className = "",
}: FlowCardProps) {
	const Icon = look.icon;
	return (
		<div
			className={`vtc-card ${className}`}
			data-selected={selected ? "true" : "false"}
			title={hint}
			style={{ "--vtc-accent": look.accent } as React.CSSProperties}
		>
			<div className="flex items-center justify-between gap-3">
				<span className="vtc-kicker flex min-w-0 items-center gap-1.5">
					<Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
					<span className="truncate">{kicker}</span>
				</span>
				{stack ? (
					<span className="vtc-stack shrink-0 text-3xs">{stack}</span>
				) : null}
			</div>
			<div className="vtc-title mt-1.5 text-base">{children}</div>
		</div>
	);
}

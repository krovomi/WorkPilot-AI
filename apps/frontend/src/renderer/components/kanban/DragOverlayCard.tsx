import type { Task } from "../../../shared/types";
import { TaskCard } from "../TaskCard";

/** Depths of the cards drawn behind the dragged one. */
const LAYERS = [1, 2] as const;

const noop = () => {
	/* the card under the pointer opens nothing */
};

/**
 * The card under the pointer during a drag. A selection dragged as one shows
 * as a stack, up to two cards behind, with the number of cards it carries.
 */
export function DragOverlayCard({ task, count }: { task: Task; count: number }) {
	const behind = Math.min(count - 1, LAYERS.length);
	return (
		<div className="drag-overlay-card relative" data-drag-count={count > 1 ? count : undefined}>
			{LAYERS.slice(0, behind).map((depth) => (
				<div
					key={depth}
					aria-hidden="true"
					data-drag-layer=""
					className="absolute inset-0 rounded-xl border border-border bg-card shadow-md"
					style={{ transform: `translate(${depth * 6}px, ${depth * 6}px)`, zIndex: -depth }}
				/>
			))}
			<TaskCard task={task} onClick={noop} />
			{count > 1 && (
				<div className="absolute -top-2 -right-2 flex items-center justify-center h-6 min-w-6 px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-bold shadow-lg border-2 border-background">
					{count}
				</div>
			)}
		</div>
	);
}

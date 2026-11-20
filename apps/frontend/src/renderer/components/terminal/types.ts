import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import {
	AlertCircle,
	CheckCircle2,
	Circle,
	Code2,
	KeyRound,
	PauseCircle,
	Search,
	Wrench,
} from "lucide-react";
import type { ExecutionPhase, Task } from "../../../shared/types";
import type { TerminalStatus } from "../../stores/terminal-store";

export interface TerminalProps {
	id: string;
	cwd?: string;
	projectPath?: string;
	isActive: boolean;
	onClose: () => void;
	onActivate: () => void;
	tasks?: Task[];
	onNewTaskClick?: () => void;
	terminalCount?: number;
	/** Drag handle listeners from useSortable for terminal reordering */
	dragHandleListeners?: SyntheticListenerMap;
	/** Whether this terminal is currently being dragged */
	isDragging?: boolean;
	/** Whether the terminal is expanded to full view */
	isExpanded?: boolean;
	/** Callback to toggle expanded state */
	onToggleExpand?: () => void;
}

/**
 * Get the responsive max-width class for terminal title based on terminal count.
 * More terminals = narrower title to fit all elements.
 */
export function getTitleMaxWidthClass(terminalCount: number): string {
	if (terminalCount <= 2) return "max-w-72"; // 288px - large
	if (terminalCount <= 4) return "max-w-56"; // 224px - medium
	if (terminalCount <= 6) return "max-w-48"; // 192px - default
	if (terminalCount <= 9) return "max-w-40"; // 160px - compact
	return "max-w-36"; // 144px - compact for 10-12 terminals
}

export const STATUS_COLORS: Record<TerminalStatus, string> = {
	idle: "bg-warning",
	running: "bg-success",
	"claude-active": "bg-primary",
	exited: "bg-destructive",
};

export const PHASE_CONFIG: Record<
	ExecutionPhase,
	{ color: string; icon: React.ElementType }
> = {
	idle: {
		color: "bg-muted text-muted-foreground",
		icon: Circle,
	},
	planning: { color: "bg-info/20 text-info", icon: Search },
	coding: { color: "bg-primary/20 text-primary", icon: Code2 },
	rate_limit_paused: {
		color: "bg-orange-500/20 text-orange-400",
		icon: PauseCircle,
	},
	auth_failure_paused: {
		color: "bg-destructive/20 text-destructive",
		icon: KeyRound,
	},
	qa_review: {
		color: "bg-warning/20 text-warning",
		icon: Search,
	},
	qa_fixing: {
		color: "bg-warning/20 text-warning",
		icon: Wrench,
	},
	complete: {
		color: "bg-success/20 text-success",
		icon: CheckCircle2,
	},
	failed: {
		color: "bg-destructive/20 text-destructive",
		icon: AlertCircle,
	},
};

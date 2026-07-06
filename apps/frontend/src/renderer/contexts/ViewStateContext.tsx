import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";

interface ViewState {
	showArchived: boolean;
	/** Hide abandoned tasks from the board (they are shown greyed by default). */
	hideAbandoned: boolean;
}

interface ViewStateContextValue extends ViewState {
	setShowArchived: (show: boolean) => void;
	toggleShowArchived: () => void;
	setHideAbandoned: (hide: boolean) => void;
	toggleHideAbandoned: () => void;
}

const ViewStateContext = createContext<ViewStateContextValue | null>(null);

interface ViewStateProviderProps {
	children: ReactNode;
}

/**
 * ViewStateProvider manages view state that needs to be shared across
 * different project pages (kanban, ideation, etc.).
 *
 * Currently manages:
 * - showArchived: Whether to show archived items in views
 */
export function ViewStateProvider({ children }: ViewStateProviderProps) {
	const [showArchived, setShowArchivedState] = useState(false);
	const [hideAbandoned, setHideAbandonedState] = useState(false);

	const setShowArchived = useCallback((show: boolean) => {
		setShowArchivedState(show);
	}, []);

	const toggleShowArchived = useCallback(() => {
		setShowArchivedState((prev) => !prev);
	}, []);

	const setHideAbandoned = useCallback((hide: boolean) => {
		setHideAbandonedState(hide);
	}, []);

	const toggleHideAbandoned = useCallback(() => {
		setHideAbandonedState((prev) => !prev);
	}, []);

	const value = useMemo<ViewStateContextValue>(
		() => ({
			showArchived,
			setShowArchived,
			toggleShowArchived,
			hideAbandoned,
			setHideAbandoned,
			toggleHideAbandoned,
		}),
		[
			showArchived,
			setShowArchived,
			toggleShowArchived,
			hideAbandoned,
			setHideAbandoned,
			toggleHideAbandoned,
		],
	);

	return (
		<ViewStateContext.Provider value={value}>
			{children}
		</ViewStateContext.Provider>
	);
}

/**
 * Hook to access view state from within the ViewStateProvider tree.
 *
 * @throws Error if used outside of ViewStateProvider
 *
 * @example
 * ```tsx
 * function KanbanBoard() {
 *   const { showArchived, toggleShowArchived } = useViewState();
 *
 *   return (
 *     <button onClick={toggleShowArchived}>
 *       {showArchived ? 'Hide archived' : 'Show archived'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useViewState(): ViewStateContextValue {
	const context = useContext(ViewStateContext);

	if (!context) {
		throw new Error("useViewState must be used within a ViewStateProvider");
	}

	return context;
}

/**
 * Optional hook that returns null if used outside provider.
 * Useful for components that may or may not be within the provider tree.
 */
export function useViewStateOptional(): ViewStateContextValue | null {
	return useContext(ViewStateContext);
}

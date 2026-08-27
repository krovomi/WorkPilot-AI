import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { isSubtaskDone } from "../../shared/progress";

/**
 * Utility function to merge Tailwind CSS classes
 */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Calculate progress percentage from subtasks. A subtask counts as done when
 * completed OR blocked (see {@link isSubtaskDone}), matching the backend so a
 * finished build with a blocked subtask shows 100%, not e.g. 67%.
 * @param subtasks Array of subtasks with status
 * @returns Progress percentage (0-100)
 */
export function calculateProgress(subtasks: { status: string }[]): number {
	if (subtasks.length === 0) return 0;
	const done = subtasks.filter((s) => isSubtaskDone(s.status)).length;
	return Math.round((done / subtasks.length) * 100);
}

/**
 * Détermine le pourcentage d'avancement à afficher dans l'en-tête d'une tâche.
 *
 * Pendant une exécution active, l'avancement par sous-tâches terminées ne bouge
 * qu'au passage d'une sous-tâche à « completed », ce qui fige visuellement la
 * barre. On privilégie alors la progression temps réel pondérée par phase
 * (overallProgress) émise par le backend, avec repli sur l'avancement par
 * sous-tâches. Le max évite toute régression visuelle si overallProgress n'a pas
 * encore été reçu.
 *
 * Le pourcentage doit refléter le **travail réellement fait**. Dès qu'une tâche
 * possède des sous-tâches de code, leur part terminée EST cet avancement réel :
 * on ne laisse pas la progression pondérée par phase (`overallProgress`, qui
 * crédite toute la phase de codage à l'instant où la QA démarre) le gonfler
 * au-delà du travail effectif (p.ex. 94% affiché alors que 2/3 sous-tâches sont
 * faites). Tant qu'aucune sous-tâche n'existe (création de spec / planning), on
 * retombe sur la progression de phase pour que la barre bouge quand même.
 *
 * @param subtaskProgress Pourcentage calculé depuis les sous-tâches (0-100)
 * @param overallProgress Progression temps réel du backend (0-100), optionnelle
 * @param hasActiveExecution Indique si une phase d'exécution est en cours
 * @param hasSubtasks `true` si la tâche a des sous-tâches (leur avancement fait
 *   alors foi) ; `false`/`undefined` → repli sur la progression de phase
 * @param isComplete `true` si la tâche a terminé tout son pipeline (état terminal
 *   fiable) → force 100%, même si le comptage des sous-tâches est en retard (ex.
 *   après un changement de LLM en cours de route). Voir isTaskEffectivelyComplete.
 * @returns Pourcentage à afficher (0-100)
 */
export function getDisplayProgress(
	subtaskProgress: number,
	overallProgress: number | undefined,
	hasActiveExecution: boolean,
	hasSubtasks?: boolean,
	isComplete?: boolean,
): number {
	// A finished task is 100% by definition — the terminal state is authoritative
	// over the (possibly stale) subtask ratio.
	if (isComplete) return 100;
	if (!hasActiveExecution) return subtaskProgress;
	// Real work = completed subtasks. Don't let phase weighting overstate it.
	if (hasSubtasks) return subtaskProgress;
	// No subtasks yet (spec/planning): use the phase-weighted progress.
	return Math.max(overallProgress ?? 0, subtaskProgress);
}

/**
 * Format a date as a relative time string
 * @param date Date to format
 * @returns Relative time string (e.g., "2 hours ago")
 */
export function formatRelativeTime(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - new Date(date).getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return new Date(date).toLocaleDateString();
}

/**
 * Extract plain text from HTML content.
 * Removes all HTML tags and entities, keeping only the text content.
 * @param html The HTML content
 * @returns Plain text extracted from HTML
 */
/**
 * Memo for extractTextFromHtml. The Kanban search filter calls it once per task
 * on every keystroke, and task descriptions do not change while the user types.
 * Bounded so a long session cannot grow it without limit.
 */
const HTML_TEXT_CACHE_LIMIT = 500;
const htmlTextCache = new Map<string, string>();

export function extractTextFromHtml(html: string): string {
	if (!html) return "";

	const cached = htmlTextCache.get(html);
	if (cached !== undefined) return cached;

	// DOMParser, NOT `div.innerHTML = html`. Assigning innerHTML builds nodes in
	// the live document: `<img src=x onerror=...>` starts a real network fetch
	// even on a detached element. Task titles and descriptions come from Jira,
	// Linear and GitHub, so they are third-party content. A DOMParser document
	// is inert — no resource loading, no handlers — and we only read text.
	const text = new DOMParser()
		.parseFromString(html, "text/html")
		.body // textContent strips tags and decodes entities
		.textContent // Collapse runs of whitespace, then trim
		?.replace(/\s+/g, " ")
		.trim();

	const result = text || "";
	if (htmlTextCache.size >= HTML_TEXT_CACHE_LIMIT) {
		// Cheap FIFO eviction — drop the oldest entry.
		const oldest = htmlTextCache.keys().next().value;
		if (oldest !== undefined) htmlTextCache.delete(oldest);
	}
	htmlTextCache.set(html, result);
	return result;
}

/**
 * Sanitize and extract plain text from markdown or HTML content.
 * Strips markdown/HTML formatting and collapses whitespace for clean display in UI.
 * @param text The text that might contain markdown or HTML
 * @param maxLength Maximum length before truncation (default: 200)
 * @returns Plain text suitable for display
 */
export function sanitizeMarkdownForDisplay(
	text: string,
	maxLength: number = 200,
): string {
	if (!text) return "";

	// Check if content is HTML (starts with < tag)
	const isHtml = text.trim().startsWith("<");

	let sanitized: string;

	if (isHtml) {
		// Extract text from HTML
		sanitized = extractTextFromHtml(text);
	} else {
		// Process as markdown
		sanitized = text
			// Remove markdown headers (# ## ### etc)
			.replace(/^#{1,6}\s+/gm, "")
			// Remove bold/italic markers
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/\*([^*]+)\*/g, "$1")
			.replace(/__([^_]+)__/g, "$1")
			.replace(/_([^_]+)_/g, "$1")
			// Remove inline code
			.replace(/`([^`]+)`/g, "$1")
			// Remove code blocks
			.replace(/```[\s\S]*?```/g, "")
			// Remove links but keep text
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			// Remove images
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
			// Remove horizontal rules
			.replace(/^[-*_]{3,}$/gm, "")
			// Remove blockquotes
			.replace(/^>\s*/gm, "")
			// Remove list markers
			.replace(/^[\s]*[-*+]\s+/gm, "")
			.replace(/^[\s]*\d+\.\s+/gm, "")
			// Remove checkbox markers
			.replace(/\[[ x]\]\s*/gi, "")
			// Collapse multiple newlines to single space
			.replace(/\n+/g, " ")
			// Collapse multiple spaces to single space
			.replace(/\s+/g, " ")
			.trim();
	}

	// Truncate if needed (0 means no truncation)
	if (maxLength > 0 && sanitized.length > maxLength) {
		sanitized = `${sanitized.substring(0, maxLength).trim()}...`;
	}

	return sanitized;
}

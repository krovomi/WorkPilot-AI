import type { SidebarView } from "../Sidebar";

/**
 * The views that have neither a design file in `docs/architecture/` nor a
 * test that names them (lot M8 of the audit of 17 October). The sidebar marks
 * them "Experimental" and lets the user hide them; none is removed until usage
 * data says which to keep. `docs/architecture/product-overview.md` marks the
 * same rows, and `tests/test_product_overview_views.py` keeps both in step.
 *
 * A view leaves this list when it gets a design file or a test.
 */
export const EXPERIMENTAL_VIEWS: ReadonlySet<SidebarView> = new Set<SidebarView>([
	"agent-debugger",
	"agent-replay",
	"api-watcher",
	"blast-radius",
	"carbon-profiler",
	"changelog",
	"compliance",
	"cross-language-translation",
	"doc-drift",
	"env-snapshot",
	"mcp-marketplace",
	"notebook-agent",
	"performance-profiler",
	"pipeline-generator",
	"plugin-marketplace",
	"regression-guardian",
	"release-coordinator",
	"spec-approval",
	"spec-refinement",
	"team-bot",
]);

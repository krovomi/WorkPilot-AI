/** Badge colors of the work item types (and Jira priorities) each tracker names. */

const OTHER_COLOR = "bg-gray-500/10 text-gray-500 border-gray-500/20";

const JIRA_TYPE_COLORS: Record<string, string> = {
	bug: "bg-destructive/10 text-destructive border-destructive/20",
	task: "bg-blue-500/10 text-blue-500 border-blue-500/20",
	story: "bg-success/10 text-success border-success/20",
	epic: "bg-orange-500/10 text-orange-500 border-orange-500/20",
	"sub-task": "bg-cyan-500/10 text-cyan-500 border-cyan-500/20",
};

const PRIORITY_COLORS: Record<string, string> = {
	highest: "bg-destructive/10 text-destructive border-destructive/20",
	critical: "bg-destructive/10 text-destructive border-destructive/20",
	high: "bg-orange-500/10 text-orange-500 border-orange-500/20",
	medium: "bg-warning/10 text-warning border-warning/20",
	low: "bg-blue-500/10 text-blue-500 border-blue-500/20",
};

export const jiraTypeColor = (type: string) => JIRA_TYPE_COLORS[type.toLowerCase()] ?? OTHER_COLOR;
export const jiraPriorityColor = (priority: string) => PRIORITY_COLORS[priority.toLowerCase()] ?? OTHER_COLOR;

const AZURE_TYPE_COLORS: Record<string, string> = {
	bug: "bg-destructive/10 text-destructive border-destructive/20",
	task: "bg-blue-500/10 text-blue-500 border-blue-500/20",
	"user story": "bg-success/10 text-success border-success/20",
	feature: "bg-purple-500/10 text-purple-500 border-purple-500/20",
	epic: "bg-orange-500/10 text-orange-500 border-orange-500/20",
};

export const azureTypeColor = (type: string) =>
	AZURE_TYPE_COLORS[type.toLowerCase()] ?? OTHER_COLOR;


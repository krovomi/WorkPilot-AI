/**
 * What each view is for, so a sentence that does not say a view's name can
 * still find it (« ouvre la feature qui me permet de dessiner une
 * architecture » → Visual to Code).
 *
 * `hint` is English prose for the model (`main/voice-assistant/interpret.ts`);
 * `words` are stems the local parser matches, written without accents and in
 * lower case, French and English. Neither is shown in the UI. A view absent
 * here is still reachable by its label.
 */

export interface ViewHint {
	hint: string;
	words: readonly string[];
}

export const VIEW_HINTS: Readonly<Record<string, ViewHint>> = {
	kanban: {
		hint: "the task board: backlog, running and finished tasks",
		words: ["kanban", "tableau des taches", "board", "les taches", "tasks", "tickets"],
	},
	dashboard: {
		hint: "overview of the project's activity",
		words: ["dashboard", "tableau de bord", "accueil", "vue d'ensemble", "overview", "home"],
	},
	"mission-control": {
		hint: "watch every running agent at once",
		words: ["mission control", "controle de mission", "agents en cours"],
	},
	terminals: {
		hint: "agent terminals, shells",
		words: ["terminal", "terminaux", "console", "shell", "ligne de commande"],
	},
	"visual-to-code": {
		hint: "draw an architecture, a diagram or a UI sketch on a canvas and turn it into code",
		words: [
			"dessin",
			"dessiner",
			"draw",
			"diagramme",
			"diagram",
			"schema",
			"croquis",
			"sketch",
			"canvas",
			"tableau blanc",
			"whiteboard",
			"maquette",
			"visuel",
			"visual",
		],
	},
	"architecture-visualizer": {
		hint: "see the existing code's architecture as a generated map (read-only)",
		words: ["visualiser l'architecture", "carte du code", "architecture du code", "code map"],
	},
	"code-review": {
		hint: "AI review of code changes",
		words: ["revue de code", "code review", "relecture", "relire le code"],
	},
	"test-generation": {
		hint: "generate unit and end-to-end tests",
		words: ["generer des tests", "generation de tests", "test generation", "ecrire des tests"],
	},
	"pair-programming": {
		hint: "code together with an AI pair",
		words: ["pair programming", "binome", "programmer a deux"],
	},
	"code-playground": {
		hint: "run code snippets in a sandbox",
		words: ["bac a sable", "playground", "essayer du code"],
	},
	"flaky-tests": {
		hint: "find unstable tests that fail at random",
		words: ["tests instables", "flaky", "tests aleatoires"],
	},
	"cross-language-translation": {
		hint: "translate code from one programming language to another",
		words: ["traduire du code", "traduction de code", "translate code", "convertir en"],
	},
	insights: {
		hint: "chat with an AI about the codebase",
		words: ["insights", "analyses", "discuter", "poser une question", "chat", "question sur le code"],
	},
	ideation: {
		hint: "generate improvement ideas for the project",
		words: ["ideation", "idee", "idea", "brainstorm"],
	},
	roadmap: {
		hint: "the product roadmap and its features",
		words: ["roadmap", "feuille de route", "planning produit"],
	},
	"learning-loop": {
		hint: "what agents learned from past builds",
		words: ["boucle d'apprentissage", "learning loop", "apprentissage"],
	},
	worktrees: {
		hint: "git worktrees of the tasks",
		words: ["worktree", "arbres de travail", "arbre de travail"],
	},
	"cicd-triggers": {
		hint: "start tasks from CI/CD events",
		words: ["ci/cd", "declencheur", "pipeline ci", "trigger"],
	},
	analytics: {
		hint: "statistics on tasks, builds and agents",
		words: ["analytique", "analytics", "statistique", "stats", "metriques"],
	},
	"spec-approval": {
		hint: "approve the specs waiting for a human",
		words: ["approuver les specs", "approbation", "spec approval", "valider les specs"],
	},
	changelog: {
		hint: "write release notes from finished tasks",
		words: ["changelog", "notes de version", "journal des modifications", "release notes"],
	},
	"release-coordinator": {
		hint: "plan a release train",
		words: ["train de release", "coordonner la release", "release train"],
	},
	"dependency-sentinel": {
		hint: "check dependencies for vulnerabilities and updates",
		words: ["dependances", "dependencies", "vulnerabilite", "sentinelle"],
	},
	"accessibility-agent": {
		hint: "scan the UI for accessibility problems",
		words: ["accessibilite", "accessibility", "a11y", "wcag"],
	},
	"i18n-agent": {
		hint: "scan for untranslated text",
		words: ["i18n", "traductions manquantes", "internationalisation", "textes non traduits"],
	},
	"api-explorer": {
		hint: "call and test the project's HTTP APIs",
		words: ["api studio", "explorer l'api", "tester l'api", "requete http", "endpoint"],
	},
	"app-emulator": {
		hint: "run and preview the app (web or mobile)",
		words: ["emulateur", "emulator", "lancer l'app", "apercu de l'app", "preview"],
	},
	"browser-agent": {
		hint: "an agent that drives a web browser",
		words: ["agent navigateur", "browser agent", "navigateur"],
	},
	migration: {
		hint: "migrate code to a new framework or version",
		words: ["migration", "migrer", "migrate", "monter de version", "upgrade"],
	},
	"prompt-optimizer": {
		hint: "improve a prompt",
		words: ["optimiser un prompt", "prompt optimizer", "ameliorer le prompt"],
	},
	"offline-mode": {
		hint: "work offline with local models",
		words: ["hors ligne", "offline", "modele local"],
	},
	"github-issues": {
		hint: "the repository's GitHub issues",
		words: ["issues github", "github issues", "les issues"],
	},
	"github-prs": {
		hint: "the repository's GitHub pull requests",
		words: ["pull request", "prs github", "github prs", "les pr"],
	},
	"gitlab-issues": { hint: "the repository's GitLab issues", words: ["issues gitlab"] },
	"gitlab-merge-requests": {
		hint: "the repository's GitLab merge requests",
		words: ["merge request", "mrs gitlab"],
	},
	context: {
		hint: "the project's memory and context for agents",
		words: ["contexte", "context", "memoire du projet", "memory"],
	},
	documentation: {
		hint: "generate and browse documentation",
		words: ["documentation", "doc du projet"],
	},
	"tech-debt": {
		hint: "technical debt dashboard",
		words: ["dette technique", "tech debt"],
	},
	refactoring: { hint: "refactor code", words: ["refactoring", "refactorer", "refactor"] },
	"cost-estimator": {
		hint: "costs and token spending",
		words: ["cout", "couts", "cost", "depenses", "tokens consommes", "facturation"],
	},
	"session-history": {
		hint: "history of agent sessions",
		words: ["historique des sessions", "session history", "historique"],
	},
	"arena-mode": {
		hint: "compare models on the same task",
		words: ["arena", "comparer les modeles", "duel de modeles"],
	},
	"self-healing": {
		hint: "agents that repair failing builds by themselves",
		words: ["auto-guerison", "self-healing", "auto reparation"],
	},
	"pixel-office": {
		hint: "pixel-art office where agents are shown working",
		words: ["bureau pixel", "pixel office"],
	},
	"natural-language-git": {
		hint: "run git operations described in plain words",
		words: ["git en langage naturel", "commande git", "natural language git"],
	},
	administration: {
		hint: "server administration: members, roles, groups",
		words: ["administration", "membres", "roles", "admin"],
	},
	"mcp-marketplace": { hint: "install MCP servers", words: ["marketplace mcp", "serveurs mcp"] },
	"plugin-marketplace": { hint: "install plugins", words: ["plugins", "marketplace de plugins"] },
	"agent-tools": { hint: "MCP tools the agents can use", words: ["outils mcp", "mcp tools", "apercu mcp"] },
	"live-companion": {
		hint: "an assistant that follows what you code live",
		words: ["compagnon", "live companion"],
	},
	"bounty-board": { hint: "several agents compete on one task", words: ["bounty"] },
	"repo-bench": {
		hint: "replay finished tasks to compare engines",
		words: ["banc de rejeu", "repo bench", "benchmark"],
	},
	guardrails: { hint: "rules agents must follow", words: ["guardrails", "garde-fous", "regles des agents"] },
	sandbox: { hint: "preview changes before applying them", words: ["apercu des changements", "change preview"] },
};

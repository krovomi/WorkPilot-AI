#!/usr/bin/env node
/**
 * Renders the README's illustrations into .github/assets/showcase/:
 *
 * - `how-it-works-{dark,light}.png` and `architecture-{dark,light}.png`: the two
 *   diagrams, drawn in HTML and photographed, in English and French
 *   (`*.fr-*.png`), one file per GitHub colour scheme;
 * - `<shot>.png`: each screenshot of .github/assets/screenshots/ in a window
 *   frame on a soft backdrop.
 *
 *   node scripts/readme-screenshots/render-showcase.cjs              # everything
 *   node scripts/readme-screenshots/render-showcase.cjs diagrams     # diagrams only
 *   node scripts/readme-screenshots/render-showcase.cjs frames       # frames only
 *
 * Run capture-desktop.cjs (and capture-mobile.cjs) first: the frames are made
 * from their output. Fonts: Inter and JetBrains Mono, from Google Fonts or the
 * machine. Icons: the app's own Lucide set.
 */
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const FRONTEND = path.join(REPO, "apps", "frontend");
const { chromium } = require(
	require.resolve("@playwright/test", { paths: [FRONTEND] }),
);
const SHOTS = path.join(REPO, ".github", "assets", "screenshots");
const OUT = process.env.OUT || path.join(REPO, ".github", "assets", "showcase");

// ---------------------------------------------------------------- icons
const LUCIDE = path.join(
	path.dirname(
		require.resolve("lucide-react/package.json", { paths: [FRONTEND] }),
	),
	"dist",
	"esm",
	"icons",
);
function icon(name, size = 22) {
	const src = fs.readFileSync(path.join(LUCIDE, `${name}.mjs`), "utf-8");
	// `node: [ … ]` closes on its own line, two spaces in (aliases may follow).
	const literal = src.match(/node:\s*(\[[\s\S]*?\n {2}\])/)[1];
	// A plain data literal: quote its keys and read it as JSON, never evaluate it.
	const nodes = JSON.parse(
		literal.replace(/([{,]\s*)([A-Za-z][\w-]*)\s*:/g, '$1"$2":'),
	);
	const inner = nodes
		.map(([tag, attrs]) => {
			const a = Object.entries(attrs)
				.filter(([k]) => k !== "key")
				.map(([k, v]) => `${k}="${v}"`)
				.join(" ");
			return `<${tag} ${a}/>`;
		})
		.join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

// ---------------------------------------------------------------- themes
const THEMES = {
	dark: {
		bg: "#0b0d12",
		glowA: "rgba(99,102,241,0.22)",
		glowB: "rgba(16,185,129,0.14)",
		panel: "rgba(255,255,255,0.035)",
		panelBorder: "rgba(255,255,255,0.09)",
		card: "#141824",
		cardBorder: "rgba(255,255,255,0.08)",
		text: "#f3f4f6",
		muted: "#9ca3af",
		faint: "#6b7280",
		line: "rgba(255,255,255,0.18)",
	},
	light: {
		bg: "#ffffff",
		glowA: "rgba(99,102,241,0.12)",
		glowB: "rgba(16,185,129,0.10)",
		panel: "rgba(15,23,42,0.025)",
		panelBorder: "rgba(15,23,42,0.08)",
		card: "#ffffff",
		cardBorder: "rgba(15,23,42,0.10)",
		text: "#0f172a",
		muted: "#475569",
		faint: "#94a3b8",
		line: "rgba(15,23,42,0.22)",
	},
};
const TONES = {
	you: { c: "#f59e0b", soft: "rgba(245,158,11,0.14)" },
	agent: { c: "#818cf8", soft: "rgba(129,140,248,0.14)" },
	proof: { c: "#10b981", soft: "rgba(16,185,129,0.14)" },
	ext: { c: "#38bdf8", soft: "rgba(56,189,248,0.14)" },
	data: { c: "#f59e0b", soft: "rgba(245,158,11,0.14)" },
};

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">`;

function baseCss(t) {
	return `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:${t.bg}}
body{font-family:Inter,system-ui,sans-serif;color:${t.text};-webkit-font-smoothing:antialiased}
.stage{position:relative;padding:44px 48px 48px;overflow:hidden;
  background:radial-gradient(900px 420px at 12% -10%,${t.glowA},transparent 70%),
             radial-gradient(800px 420px at 100% 110%,${t.glowB},transparent 70%),${t.bg}}
.stage::before{content:"";position:absolute;inset:0;pointer-events:none;
  background-image:radial-gradient(${t.panelBorder} 1px,transparent 1px);background-size:22px 22px;
  mask-image:linear-gradient(180deg,rgba(0,0,0,.7),transparent 85%)}
.kicker{font-family:"JetBrains Mono",monospace;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:${t.muted};position:relative}
h1{font-size:28px;font-weight:700;letter-spacing:-.02em;margin:6px 0 26px;position:relative}
h1 em{font-style:normal;background:linear-gradient(90deg,#818cf8,#10b981);-webkit-background-clip:text;color:transparent}
.panel{position:relative;background:${t.panel};border:1px solid ${t.panelBorder};border-radius:18px;padding:18px}
.panel .rail{position:absolute;left:18px;right:18px;top:-1px;height:2px;border-radius:2px}
.ptitle{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:600;color:${t.muted};margin-bottom:14px}
.num{width:24px;height:24px;border-radius:8px;display:grid;place-items:center;font-family:"JetBrains Mono",monospace;font-size:12px;font-weight:600;color:#0b0d12}
.node{display:flex;align-items:center;gap:12px;background:${t.card};border:1px solid ${t.cardBorder};border-radius:14px;padding:12px 14px;box-shadow:0 1px 0 rgba(255,255,255,.04) inset,0 10px 24px -14px rgba(0,0,0,.45)}
.chip{flex:none;width:38px;height:38px;border-radius:11px;display:grid;place-items:center}
.ntitle{font-size:14.5px;font-weight:600;line-height:1.25}
.nsub{font-size:12.5px;color:${t.muted};line-height:1.35;margin-top:2px}
.tag{font-family:"JetBrains Mono",monospace;font-size:10px;font-weight:600;letter-spacing:.08em;padding:2px 7px;border-radius:999px;margin-left:8px;vertical-align:2px}
.down{display:flex;justify-content:center;color:${t.faint};height:18px;align-items:center}
.legend{display:flex;gap:22px;margin-top:22px;font-size:12.5px;color:${t.muted};position:relative}
.legend span{display:flex;align-items:center;gap:8px}
.legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
`;
}

function node(tone, ic, title, sub, tag) {
	const k = TONES[tone];
	const tg = tag
		? `<span class="tag" style="background:${k.soft};color:${k.c}">${tag}</span>`
		: "";
	return `<div class="node" style="border-left:3px solid ${k.c}"><div class="chip" style="background:${k.soft};color:${k.c}">${icon(ic)}</div><div><div class="ntitle">${title}${tg}</div>${sub ? `<div class="nsub">${sub}</div>` : ""}</div></div>`;
}
const down = (t, label) =>
	`<div class="down">${icon("arrow-down", 16)}${label ? `<span style="font-size:11px;margin-left:6px;color:${t.faint}">${label}</span>` : ""}</div>`;

// ---------------------------------------------------------------- copy
const COPY = {
	en: {
		howKicker: "How it works",
		howTitle: "From one sentence to a <em>reviewed pull request</em>",
		p1: "Plan",
		p2: "Build and check",
		p3: "Prove and ship",
		you: "YOU",
		task: ["You describe a task", "a sentence, an issue, a ticket"],
		spec: ["Spec", "goal, scope, acceptance criteria"],
		plan: ["Planner", "subtasks and the files each touches"],
		approve: ["You approve the plan", "if you want to"],
		code: ["Coder", "writes the code, can start subagents"],
		qa: ["QA reviewer", "checks every acceptance criterion"],
		fix: ["QA fixer", "fixes what QA found, then QA again"],
		loop: "until QA approves",
		verify: ["Verify", "runs the app, keeps a proof"],
		review: ["You review the diff", "guided, line comments to the fixer"],
		merge: ["Merge or pull request", "worktree removed once merged"],
		legend: ["You decide", "AI agents", "Proof and delivery"],
		worktree:
			"Each task in its own git worktree · any provider, model and effort",
		archKicker: "Architecture",
		archTitle: "Runs on <em>your machine</em>, talks to your tools",
		local: "Your machine",
		desktop: ["Desktop app", "Electron + React"],
		engine: ["Python engine", "agents, specs, QA, local API"],
		repo: ["Your git repository", "one worktree per task"],
		ext: "What the engine talks to",
		providers: [
			"AI providers",
			"Claude, OpenAI, Gemini, Copilot, Mistral, Grok, DeepSeek, local models, agent CLIs",
		],
		forges: [
			"Forges and trackers",
			"GitHub, GitLab, Azure DevOps, Jira, Linear",
		],
		clients: [
			"Other AI clients",
			"Claude Code, Codex, Cursor… via the workpilot-board MCP server",
		],
		team: "Team mode",
		optional: "OPTIONAL",
		server: ["Team server", "shared board, roles, organisations"],
		mobile: ["Mobile app", "iOS and Android"],
	},
	fr: {
		howKicker: "Fonctionnement",
		howTitle: "D'une phrase à une <em>pull request relue</em>",
		p1: "Planifier",
		p2: "Construire et contrôler",
		p3: "Prouver et livrer",
		you: "VOUS",
		task: ["Vous décrivez une tâche", "une phrase, une issue, un ticket"],
		spec: ["Spec", "objectif, périmètre, critères d'acceptation"],
		plan: ["Planificateur", "sous-tâches et fichiers touchés"],
		approve: ["Vous validez le plan", "si vous le souhaitez"],
		code: ["Codeur", "écrit le code, peut lancer des sous-agents"],
		qa: ["Relecteur QA", "vérifie chaque critère d'acceptation"],
		fix: ["Correcteur QA", "corrige ce que la QA a trouvé"],
		loop: "jusqu'à l'accord de la QA",
		verify: ["Vérification", "lance l'app, garde une preuve"],
		review: [
			"Vous relisez le diff",
			"guidé, commentaires de ligne au correcteur",
		],
		merge: ["Fusion ou pull request", "worktree supprimé après la fusion"],
		legend: ["Vous décidez", "Agents IA", "Preuve et livraison"],
		worktree:
			"Chaque tâche dans son worktree git · provider, modèle et effort au choix",
		archKicker: "Architecture",
		archTitle: "Tourne sur <em>votre machine</em>, parle à vos outils",
		local: "Votre machine",
		desktop: ["Application de bureau", "Electron + React"],
		engine: ["Moteur Python", "agents, specs, QA, API locale"],
		repo: ["Votre dépôt git", "un worktree par tâche"],
		ext: "Ce à quoi parle le moteur",
		providers: [
			"Fournisseurs d'IA",
			"Claude, OpenAI, Gemini, Copilot, Mistral, Grok, DeepSeek, modèles locaux, CLI d'agents",
		],
		forges: ["Forges et suivi", "GitHub, GitLab, Azure DevOps, Jira, Linear"],
		clients: [
			"Autres clients IA",
			"Claude Code, Codex, Cursor… via le serveur MCP workpilot-board",
		],
		team: "Mode équipe",
		optional: "OPTIONNEL",
		server: ["Serveur d'équipe", "tableau partagé, rôles, organisations"],
		mobile: ["Application mobile", "iOS et Android"],
	},
};

function howItWorks(t, c) {
	const col = (n, tone, title, body) =>
		`<div class="panel"><div class="rail" style="background:linear-gradient(90deg,${TONES[tone].c},transparent)"></div><div class="ptitle"><span class="num" style="background:${TONES[tone].c}">${n}</span>${title}</div>${body}</div>`;
	const between = `<div style="display:grid;place-items:center;color:${t.faint}">${icon("chevrons-right", 26)}</div>`;
	const loop = `<div style="display:flex;align-items:center;justify-content:center;gap:8px;height:30px;color:${TONES.agent.c};font-size:11.5px;font-weight:500">${icon("repeat-2", 15)}<span>${c.loop}</span></div>`;
	return `<div class="stage" style="width:1500px">
<div class="kicker">${c.howKicker}</div><h1>${c.howTitle}</h1>
<div style="display:grid;grid-template-columns:1fr 40px 1fr 40px 1fr;align-items:stretch;position:relative">
${col(1, "agent", c.p1, node("you", "message-square-text", ...c.task, c.you) + down(t) + node("agent", "file-text", ...c.spec) + down(t) + node("agent", "list-tree", ...c.plan) + down(t) + node("you", "circle-check", ...c.approve, c.you))}
${between}
${col(2, "agent", c.p2, node("agent", "code-xml", ...c.code) + down(t) + node("agent", "scan-search", ...c.qa) + loop + node("agent", "wrench", ...c.fix))}
${between}
${col(3, "proof", c.p3, node("proof", "monitor-play", ...c.verify) + down(t) + node("you", "eye", ...c.review, c.you) + down(t) + node("proof", "git-merge", ...c.merge))}
</div>
<div class="legend"><span><i style="background:${TONES.you.c}"></i>${c.legend[0]}</span><span><i style="background:${TONES.agent.c}"></i>${c.legend[1]}</span><span><i style="background:${TONES.proof.c}"></i>${c.legend[2]}</span><span style="margin-left:auto;color:${t.faint}">${icon("git-branch", 14)}${c.worktree}</span></div>
</div>`;
}

function architecture(t, c) {
	const zone = (tone, ic, title, body, extra = "") =>
		`<div class="panel" style="border-style:dashed;border-color:${TONES[tone].c}55"><div class="ptitle" style="color:${TONES[tone].c}">${icon(ic, 16)}<span>${title}</span>${extra}</div>${body}</div>`;
	const h = (ic) =>
		`<div style="display:grid;place-items:center;color:${t.faint}">${icon(ic, 20)}</div>`;
	const local = zone(
		"agent",
		"laptop",
		c.local,
		`<div style="display:grid;grid-template-columns:1fr 34px 1fr 34px 1fr;align-items:center">${node("agent", "app-window", ...c.desktop)}${h("arrow-left-right")}${node("agent", "cpu", ...c.engine)}${h("arrow-right")}${node("data", "folder-git-2", ...c.repo)}</div>`,
	);
	const ext = zone(
		"ext",
		"globe",
		c.ext,
		`<div style="display:grid;gap:10px">${node("ext", "bot", ...c.providers)}${node("ext", "git-pull-request", ...c.forges)}${node("ext", "puzzle", ...c.clients)}</div>`,
	);
	const team = zone(
		"proof",
		"users",
		c.team,
		`<div style="display:grid;gap:10px">${node("proof", "server", ...c.server)}<div class="down">${icon("arrow-up-down", 16)}</div>${node("proof", "smartphone", ...c.mobile)}</div>`,
		`<span class="tag" style="background:${TONES.proof.soft};color:${TONES.proof.c}">${c.optional}</span>`,
	);
	const vlink = (tone, dashed) =>
		`<div style="display:flex;justify-content:center;height:34px"><div style="width:0;border-left:2px ${dashed ? "dashed" : "solid"} ${TONES[tone].c}88"></div></div>`;
	return `<div class="stage" style="width:1500px">
<div class="kicker">${c.archKicker}</div><h1>${c.archTitle}</h1>
${local}
<div style="display:grid;grid-template-columns:1.35fr 1fr;gap:22px"><div>${vlink("ext", false)}${ext}</div><div>${vlink("proof", true)}${team}</div></div>
</div>`;
}

function page(t, body) {
	return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${baseCss(t)}</style></head><body>${body}</body></html>`;
}

// ---------------------------------------------------------------- frames
function framePage(png, title) {
	const data = fs.readFileSync(png).toString("base64");
	return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:transparent}
.stage{display:inline-block;padding:56px;border-radius:28px;
  background:radial-gradient(1200px 600px at 0% 0%,#4338ca 0%,transparent 60%),
             radial-gradient(1000px 600px at 100% 100%,#047857 0%,transparent 60%),#0b0d12}
.win{border-radius:14px;overflow:hidden;background:#0b0d12;border:1px solid rgba(255,255,255,.12);
  box-shadow:0 40px 80px -24px rgba(0,0,0,.65),0 0 0 1px rgba(0,0,0,.4)}
.bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 16px;background:#11141b;border-bottom:1px solid rgba(255,255,255,.07)}
.dot{width:12px;height:12px;border-radius:50%}
.ttl{flex:1;text-align:center;font:500 13px Inter,system-ui,sans-serif;color:#9ca3af;margin-right:52px}
img{display:block}
</style></head><body><div class="stage"><div class="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><div class="ttl">${title}</div></div><img src="data:image/png;base64,${data}"></div></div></body></html>`;
}
const FRAME_TITLES = {
	kanban: "WorkPilot AI — Kanban",
	"task-detail": "WorkPilot AI — Task",
	terminals: "WorkPilot AI — Agent terminals",
	insights: "WorkPilot AI — Insights",
	roadmap: "WorkPilot AI — Roadmap",
	ideation: "WorkPilot AI — Ideation",
	dashboard: "WorkPilot AI — Dashboard",
	"visual-to-code": "WorkPilot AI — Visual to Code",
	"import-design": "WorkPilot AI — Import Design",
	"test-generation": "WorkPilot AI — Test generation",
	settings: "WorkPilot AI — Settings",
};

async function shoot(browser, html, file, scale) {
	const p = await browser.newPage({
		deviceScaleFactor: scale,
		viewport: { width: 800, height: 600 },
	});
	await p
		.setContent(html, { waitUntil: "networkidle" })
		.catch(() => p.setContent(html));
	await p.evaluate(() => document.fonts.ready);
	await p.waitForTimeout(300);
	const el = await p.$(".stage");
	await el.screenshot({ path: file, omitBackground: true });
	await p.close();
	console.log(`saved ${path.relative(REPO, file)}`);
}

(async () => {
	const what = process.argv[2] || "all";
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await chromium.launch(
		process.env.WORKPILOT_E2E_CHROMIUM
			? { executablePath: process.env.WORKPILOT_E2E_CHROMIUM }
			: {},
	);
	try {
		if (what === "all" || what === "diagrams") {
			for (const [lang, c] of Object.entries(COPY)) {
				const suffix = lang === "en" ? "" : `.${lang}`;
				for (const [mode, t] of Object.entries(THEMES)) {
					await shoot(
						browser,
						page(t, howItWorks(t, c)),
						path.join(OUT, `how-it-works${suffix}-${mode}.png`),
						2,
					);
					await shoot(
						browser,
						page(t, architecture(t, c)),
						path.join(OUT, `architecture${suffix}-${mode}.png`),
						2,
					);
				}
			}
		}
		if (what === "all" || what === "frames") {
			for (const [name, title] of Object.entries(FRAME_TITLES)) {
				const png = path.join(SHOTS, `${name}.png`);
				if (!fs.existsSync(png)) continue;
				await shoot(
					browser,
					framePage(png, title),
					path.join(OUT, `${name}.png`),
					1,
				);
			}
		}
	} finally {
		await browser.close();
	}
})().catch((e) => {
	console.error(e);
	process.exit(1);
});

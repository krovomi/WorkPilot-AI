/**
 * #3.6 Domain-Specific Agent Factory panel.
 *
 * Pick a domain + an agent role, see the generated bundle (guardrails,
 * skills, prompt addendum, libraries for the project's stacks). "Apply to
 * this project" saves the domain in `.workpilot/domain.json`: every Kanban
 * task of the project then receives the addendum (planner, coder, QA).
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useDomainAgentsStore } from "../../stores/phase35-stores";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { PanelShell } from "./_panel-shell";

const ROLES = [
	{ value: "coder", labelKey: "domainAgents.roleCoder" },
	{ value: "planner", labelKey: "domainAgents.rolePlanner" },
	{ value: "reviewer", labelKey: "domainAgents.roleReviewer" },
	{ value: "documenter", labelKey: "domainAgents.roleDocumenter" },
] as const;

type Role = (typeof ROLES)[number]["value"];

/** One empty list, so the shallow selector sees the same value from render to render. */
const NO_LANGUAGES: string[] = [];

interface DomainAgentsPanelProps {
	projectPath?: string;
}

export function DomainAgentsPanel({ projectPath = "" }: DomainAgentsPanelProps) {
	const { t } = useTranslation("phase35");
	const {
		phase,
		error,
		domains,
		bundle,
		projectDomain,
		projectLanguages,
		loadDomains,
		loadProjectDomain,
		applyProjectDomain,
		build,
	} = useDomainAgentsStore(
		useShallow((s) => ({
			phase: s.phase,
			error: s.error,
			domains: s.domains,
			bundle: s.bundle,
			projectDomain: s.projectPath === projectPath ? s.projectDomain : null,
			projectLanguages: s.projectPath === projectPath ? s.projectLanguages : NO_LANGUAGES,
			loadDomains: s.loadDomains,
			loadProjectDomain: s.loadProjectDomain,
			applyProjectDomain: s.applyProjectDomain,
			build: s.build,
		})),
	);
	const [selected, setSelected] = useState<string>("");
	const [role, setRole] = useState<Role>("coder");

	useEffect(() => {
		loadDomains();
	}, [loadDomains]);

	useEffect(() => {
		if (projectPath) loadProjectDomain(projectPath);
	}, [projectPath, loadProjectDomain]);

	// The project's saved domain preselects once it is read; the user may then pick another.
	useEffect(() => {
		if (projectDomain) setSelected(projectDomain);
	}, [projectDomain]);

	// Functional update: when the domains and the project's domain land in the same render,
	// the preselection above must not be overwritten by the first domain of the list.
	useEffect(() => {
		if (domains.length > 0) setSelected((current) => current || domains[0].tag);
	}, [domains]);

	const domainLabel = (tag: string) => {
		const known = domains.find((d) => d.tag === tag);
		return t(`domainAgents.domains.${tag}.label` as never, { defaultValue: known?.label ?? tag });
	};

	const isRunning = phase === "running";

	const domainError = useMemo(() => {
		if (domains.length === 0) return null;
		if (!selected) return t("domainAgents.validation.domainRequired");
		return null;
	}, [domains, selected, t]);

	const noDomains = !isRunning && domains.length === 0;
	const selectedDomain = domains.find((d) => d.tag === selected);

	return (
		<PanelShell
			title={t("domainAgents.title")}
			subtitle={t("domainAgents.subtitle")}
			error={error}
			actions={
				<Button
					size="sm"
					onClick={() => build(selected, role, projectPath || undefined)}
					disabled={isRunning || Boolean(domainError) || noDomains}
				>
					{isRunning ? t("common.running") : t("domainAgents.build")}
				</Button>
			}
		>
			<div className="space-y-3">
				{projectPath ? (
					<div className="rounded border bg-muted/20 p-3 text-sm space-y-2">
						<p>
							{projectDomain
								? t("domainAgents.project.current", { domain: domainLabel(projectDomain) })
								: t("domainAgents.project.none")}
						</p>
						<p className="text-xs text-muted-foreground">
							{projectLanguages.length > 0
								? t("domainAgents.project.languages", { languages: projectLanguages.join(", ") })
								: t("domainAgents.project.noLanguages")}
						</p>
						<p className="text-xs text-muted-foreground">{t("domainAgents.project.effect")}</p>
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="outline"
								onClick={() => applyProjectDomain(projectPath, selected)}
								disabled={
									isRunning || !selected || selected === "generic" || selected === projectDomain
								}
							>
								{t("domainAgents.project.apply")}
							</Button>
							{projectDomain && (
								<Button
									size="sm"
									variant="ghost"
									onClick={() => applyProjectDomain(projectPath, null)}
									disabled={isRunning}
								>
									{t("domainAgents.project.clear")}
								</Button>
							)}
						</div>
					</div>
				) : (
					<p className="text-sm text-muted-foreground">{t("domainAgents.project.noProject")}</p>
				)}
				{noDomains && (
					<p className="text-sm text-muted-foreground">
						{t("domainAgents.validation.noDomainsLoaded")}
					</p>
				)}
				<div className="grid grid-cols-2 gap-3">
					<div>
						<label htmlFor="domain-select" className="block text-sm font-medium mb-1">
							{t("domainAgents.domain")}
						</label>
						<NativeSelect
							id="domain-select"
							value={selected}
							onChange={(e) => setSelected(e.target.value)}
							disabled={domains.length === 0}
							aria-invalid={Boolean(domainError) || undefined}
							aria-describedby={domainError ? "domain-error" : undefined}
							className="w-full p-2 text-sm disabled:opacity-50 h-auto"
						>
							{domains.length === 0 && <option value="">—</option>}
							{domains.map((d) => (
								<option key={d.tag} value={d.tag}>
									{t(`domainAgents.domains.${d.tag}.label` as never, { defaultValue: d.label })}
								</option>
							))}
						</NativeSelect>
						{domainError && (
							<p id="domain-error" className="mt-1 text-xs text-destructive">
								{domainError}
							</p>
						)}
						{selectedDomain && (
							<p className="mt-1 text-xs text-muted-foreground">
								{t(`domainAgents.domains.${selectedDomain.tag}.description` as never, {
									defaultValue: selectedDomain.description,
								})}
							</p>
						)}
					</div>
					<div>
						<label htmlFor="role-select" className="block text-sm font-medium mb-1">
							{t("domainAgents.role")}
						</label>
						<NativeSelect
							id="role-select"
							value={role}
							onChange={(e) => setRole(e.target.value as Role)}
							className="w-full p-2 text-sm h-auto"
						>
							{ROLES.map((r) => (
								<option key={r.value} value={r.value}>
									{t(r.labelKey as never)}
								</option>
							))}
						</NativeSelect>
					</div>
				</div>

				{bundle && (
					<div className="space-y-3 text-sm">
						<p className="text-xs text-muted-foreground">{t("domainAgents.promptNote")}</p>
						{bundle.guardrails.length > 0 && (
							<details open>
								<summary className="font-medium cursor-pointer">
									{t("domainAgents.guardrails")} ({bundle.guardrails.length})
								</summary>
								<ul className="ml-4 mt-1 list-disc space-y-1 text-muted-foreground">
									{bundle.guardrails.map((g) => (
										<li key={g}>{g}</li>
									))}
								</ul>
							</details>
						)}
						{bundle.required_skills.length > 0 && (
							<details>
								<summary className="font-medium cursor-pointer">
									{t("domainAgents.requiredSkills")} ({bundle.required_skills.length})
								</summary>
								<ul className="ml-4 mt-1 list-disc text-muted-foreground">
									{bundle.required_skills.map((s) => (
										<li key={s} className="font-mono">
											{s}
										</li>
									))}
								</ul>
							</details>
						)}
						{bundle.forbidden_patterns.length > 0 && (
							<details>
								<summary className="font-medium cursor-pointer">
									{t("domainAgents.forbidden")} ({bundle.forbidden_patterns.length})
								</summary>
								<ul className="ml-4 mt-1 list-disc text-muted-foreground">
									{bundle.forbidden_patterns.map((p) => (
										<li key={p} className="font-mono text-xs">
											{p}
										</li>
									))}
								</ul>
							</details>
						)}
						{Object.keys(bundle.suggested_libraries ?? {}).length > 0 && (
							<details open>
								<summary className="font-medium cursor-pointer">
									{t("domainAgents.libraries")}
								</summary>
								<ul className="ml-4 mt-1 list-disc space-y-1 text-muted-foreground">
									{Object.entries(bundle.suggested_libraries).map(([lang, libs]) => (
										<li key={lang}>
											{t("domainAgents.librariesFor", { language: lang, libraries: libs.join(", ") })}
										</li>
									))}
								</ul>
							</details>
						)}
						{bundle.validation_rules.length > 0 && (
							<details>
								<summary className="font-medium cursor-pointer">
									{t("domainAgents.validationRules")} ({bundle.validation_rules.length})
								</summary>
								<ul className="ml-4 mt-1 list-disc text-muted-foreground">
									{bundle.validation_rules.map((r) => (
										<li key={r}>{r}</li>
									))}
								</ul>
							</details>
						)}
						<details>
							<summary className="font-medium cursor-pointer">
								{t("domainAgents.prompt")}
							</summary>
							<pre className="mt-1 max-h-64 overflow-auto rounded border bg-muted/30 p-2 text-xs font-mono whitespace-pre-wrap">
								{bundle.prompt_addendum}
							</pre>
						</details>
					</div>
				)}
			</div>
		</PanelShell>
	);
}

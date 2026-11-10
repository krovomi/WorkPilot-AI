import { AlertTriangle, GitBranch, RefreshCw, Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGitRewriteStore } from "../../stores/git-rewrite-store";
import { CharterButton, Chip, Chips, Notice, Panel, Section } from "../charter";

/** Local branches to tidy, and what the surgeon did month by month (#360). */
export function GitBranchesPanel({ projectPath }: { readonly projectPath: string }): React.ReactElement {
	const { t } = useTranslation("gitSurgeon");
	const branches = useGitRewriteStore((s) => s.branches);
	const busy = useGitRewriteStore((s) => s.branchesBusy);
	const deletion = useGitRewriteStore((s) => s.deletion);
	const months = useGitRewriteStore((s) => s.months);
	const { loadBranches, deleteBranches, loadHistory } = useGitRewriteStore.getState();
	const [chosen, setChosen] = useState<string[]>([]);

	useEffect(() => {
		void loadBranches(projectPath);
		void loadHistory(projectPath);
		setChosen([]);
	}, [projectPath, loadBranches, loadHistory]);

	const rows = branches?.branches ?? [];
	const deletable = rows.filter((b) => b.merged && !b.current && !b.protected && !b.checkedOut);
	const toggle = (name: string) =>
		setChosen((list) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name]));

	return (
		<Section
			kicker={t("branches.kicker")}
			title={t("branches.title")}
			meta={branches?.defaultBranch ? t("branches.default", { branch: branches.defaultBranch }) : undefined}
		>
			<div className="mb-2 flex flex-wrap items-center gap-2">
				<CharterButton size="sm" variant="ghost" icon={RefreshCw} onClick={() => loadBranches(projectPath)} disabled={busy}>
					{t("branches.refresh")}
				</CharterButton>
				<CharterButton
					size="sm"
					variant="danger"
					icon={Trash2}
					onClick={() => {
						void deleteBranches(projectPath, chosen);
						setChosen([]);
					}}
					disabled={busy || chosen.length === 0}
				>
					{t("branches.delete", { count: chosen.length })}
				</CharterButton>
				<span className="wp-meta">{t("branches.deleteHint", { count: deletable.length })}</span>
			</div>
			{deletion && (
				<Notice tone={Object.keys(deletion.refused).length ? "amber" : "green"} icon={AlertTriangle} role="status">
					{t("branches.deleted", { count: deletion.deleted.length })}
					{Object.entries(deletion.refused).map(([name, why]) => ` · ${name}: ${t(`branches.refused.${why}`)}`)}
				</Notice>
			)}
			<div className="flex flex-col gap-1.5">
				{rows.map((b) => {
					const canDelete = deletable.includes(b);
					const id = `branch-${b.name}`;
					return (
						<Panel key={b.name} className="flex items-center justify-between gap-2 py-2">
							<span className="flex min-w-0 items-center gap-2 text-sm">
								{canDelete ? (
									<input
										id={id}
										type="checkbox"
										checked={chosen.includes(b.name)}
										onChange={() => toggle(b.name)}
										aria-label={t("branches.choose", { name: b.name })}
									/>
								) : (
									<GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
								)}
								<span className="wp-mono truncate">{b.name}</span>
								{b.suggestedName !== b.name && (
									<span className="wp-meta truncate">{t("branches.suggest", { name: b.suggestedName })}</span>
								)}
							</span>
							<Chips>
								{b.current && <Chip tone="blue">{t("branches.current")}</Chip>}
								{b.merged && <Chip tone="green">{t("branches.merged")}</Chip>}
								{b.gone && <Chip tone="amber">{t("branches.gone")}</Chip>}
								{b.stale && <Chip tone="muted">{t("branches.stale", { days: b.ageDays })}</Chip>}
							</Chips>
						</Panel>
					);
				})}
			</div>
			{months.length > 0 && (
				<div className="mt-3">
					<p className="wp-kicker mb-1">{t("history.title")}</p>
					<table className="w-full text-left text-xs">
						<thead>
							<tr>
								<th className="py-1">{t("history.month")}</th>
								<th>{t("history.runs")}</th>
								<th>{t("kinds.squash")}</th>
								<th>{t("kinds.reword")}</th>
								<th>{t("kinds.split")}</th>
								<th>{t("history.readability")}</th>
							</tr>
						</thead>
						<tbody>
							{months.map((m) => (
								<tr key={m.month}>
									<td className="wp-mono py-0.5">{m.month}</td>
									<td>{m.runs}</td>
									<td>{m.squash}</td>
									<td>{m.reword}</td>
									<td>{m.split}</td>
									<td>{m.readability === undefined ? "—" : `${m.readability} %`}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</Section>
	);
}

/**
 * Says, on a forge's settings, whether the repository saved for this project
 * is one of its own remotes, and offers the project's remote when it is not
 * (or when nothing is saved). The check runs in the main process
 * (`git:forgeBindings`) on the values the page shows, saved or not; a fix is
 * applied through the page's own `updateEnvConfig`, like a value typed by hand.
 */

import { AlertTriangle, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	ForgeBinding,
	ProjectEnvConfig,
	ProjectForgeBindings,
} from "../../../../shared/types";
import { Button } from "../../ui/button";

export type BindingForge = keyof ProjectForgeBindings;

interface ForgeBindingNoticeProps {
	readonly projectId: string | undefined;
	readonly forge: BindingForge;
	/** The repository fields the page shows, saved or not; a change asks again. */
	readonly current: Partial<ProjectEnvConfig>;
	readonly onApply: (fix: Partial<ProjectEnvConfig>) => void;
}

export function ForgeBindingNotice({
	projectId,
	forge,
	current,
	onApply,
}: ForgeBindingNoticeProps) {
	const { t } = useTranslation("settings");
	const [loaded, setLoaded] = useState<{ projectId: string; binding: ForgeBinding } | null>(
		null,
	);

	// A string, so that a new object with the same values asks nothing.
	const currentKey = JSON.stringify(current);

	useEffect(() => {
		if (!projectId) {
			setLoaded(null);
			return;
		}
		// An answer for a project the page no longer shows is dropped.
		let live = true;
		globalThis.electronAPI
			.getForgeBindings(projectId, JSON.parse(currentKey) as Partial<ProjectEnvConfig>)
			.then((result) => {
				if (!live) return;
				setLoaded(
					result.success && result.data
						? { projectId, binding: result.data[forge] }
						: null,
				);
			})
			.catch(() => {
				if (live) setLoaded(null);
			});
		return () => {
			live = false;
		};
	}, [projectId, forge, currentKey]);

	const binding = loaded && loaded.projectId === projectId ? loaded.binding : null;
	if (!binding) return null;

	if (binding.status === "mismatch") {
		return (
			<div
				className="rounded-lg border border-warning/40 bg-warning/10 p-3"
				data-testid={`forge-binding-mismatch-${forge}`}
			>
				<div className="flex items-start gap-3">
					<AlertTriangle className="h-5 w-5 text-warning mt-0.5 shrink-0" />
					<div className="flex-1 space-y-2">
						<p className="text-sm font-medium text-foreground">
							{t("forgeBinding.mismatchTitle", { saved: binding.saved })}
						</p>
						<p className="text-xs text-muted-foreground">
							{binding.candidates.length > 0
								? t("forgeBinding.mismatchDescription")
								: t("forgeBinding.mismatchNoRemote")}
						</p>
						{binding.candidates.length > 0 && (
							<div className="flex flex-wrap gap-2">
								{binding.candidates.map((candidate) => (
									<Button
										key={candidate.label}
										size="sm"
										variant="outline"
										onClick={() => onApply(candidate.fix)}
									>
										{t("forgeBinding.useRemote", { repo: candidate.label })}
									</Button>
								))}
							</div>
						)}
					</div>
				</div>
			</div>
		);
	}

	if (binding.status === "detected" && binding.candidates[0]) {
		const candidate = binding.candidates[0];
		return (
			<div
				className="rounded-lg border border-info/30 bg-info/5 p-3"
				data-testid={`forge-binding-detected-${forge}`}
			>
				<div className="flex items-start gap-3">
					<GitBranch className="h-5 w-5 text-info mt-0.5 shrink-0" />
					<div className="flex-1 space-y-2">
						<p className="text-sm text-foreground">
							{t("forgeBinding.detected", { repo: candidate.label })}
						</p>
						<Button size="sm" variant="outline" onClick={() => onApply(candidate.fix)}>
							{t("forgeBinding.saveDetected")}
						</Button>
					</div>
				</div>
			</div>
		);
	}

	return null;
}

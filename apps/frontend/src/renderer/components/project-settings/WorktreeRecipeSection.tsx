import type {
	WorktreeRecipe,
	WorktreeRecipeState,
} from "@shared/types/worktree-recipe";
import { AlertTriangle, Boxes, CheckCircle2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

/**
 * La recette de worktree du projet (`apps/backend/core/workspace/recipe.py`).
 *
 * Ce que WorkPilot lance dans chaque nouveau worktree de tâche avant la
 * première session : la restauration des dépendances de la stack (npm,
 * dotnet, uv, go, cargo, composer, flutter…), les fichiers ignorés à copier,
 * un bloc de ports propre à la tâche. Une recette écrite dans
 * `.workpilot/worktree.toml` ne tourne qu'une fois approuvée telle quelle :
 * c'est ici que la personne la lit, commande par commande, et l'approuve.
 */
export function WorktreeRecipeSection({
	projectPath,
}: {
	readonly projectPath?: string;
}) {
	const { t } = useTranslation(["settings"]);
	const [state, setState] = useState<WorktreeRecipeState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const apply = useCallback(
		(result: { success: boolean; data?: WorktreeRecipeState; error?: string }) => {
			if (result.success && result.data) {
				setState(result.data);
				setError(null);
			} else {
				setError(result.error ?? null);
			}
		},
		[],
	);

	const load = useCallback(async () => {
		if (!projectPath) return;
		apply(await globalThis.electronAPI.getWorktreeRecipe(projectPath));
	}, [projectPath, apply]);

	useEffect(() => {
		void load();
	}, [load]);

	const run = async (
		action: (projectDir: string) => Promise<{
			success: boolean;
			data?: WorktreeRecipeState;
			error?: string;
		}>,
	) => {
		if (!projectPath) return;
		setBusy(true);
		apply(await action(projectPath));
		setBusy(false);
	};

	if (!projectPath) return null;
	const recipe: WorktreeRecipe | undefined = state?.recipe;

	return (
		<section
			className="space-y-3"
			aria-label={t("settings:worktreeRecipe.title")}
		>
			<div className="flex items-center gap-2">
				<Boxes className="h-4 w-4 text-muted-foreground" aria-hidden />
				<h3 className="text-sm font-semibold text-foreground">
					{t("settings:worktreeRecipe.title")}
				</h3>
			</div>
			<p className="text-xs text-muted-foreground">
				{t("settings:worktreeRecipe.description")}
			</p>

			{recipe && (
				<div className="space-y-2 rounded-md border border-border p-3">
					<p className="text-xs text-muted-foreground">
						{t(
							state?.hasFile
								? "settings:worktreeRecipe.sourceFile"
								: "settings:worktreeRecipe.sourceDetected",
						)}
					</p>
					{recipe.setup.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							{t("settings:worktreeRecipe.noCommands")}
						</p>
					) : (
						<ol className="space-y-1">
							{recipe.setup.map((command) => (
								<li key={command.join("\u0000")}>
									<code className="text-xs font-mono">{command.join(" ")}</code>
								</li>
							))}
						</ol>
					)}
					{recipe.copy.length > 0 && (
						<p className="text-xs text-muted-foreground">
							{t("settings:worktreeRecipe.copies", {
								files: recipe.copy.join(", "),
							})}
						</p>
					)}
					{recipe.ports > 0 && (
						<p className="text-xs text-muted-foreground">
							{t("settings:worktreeRecipe.ports", { count: recipe.ports })}
						</p>
					)}
					{recipe.teardown.length > 0 && (
						<p className="text-xs text-muted-foreground">
							{t("settings:worktreeRecipe.teardown", {
								commands: recipe.teardown.map((c) => c.join(" ")).join(" ; "),
							})}
						</p>
					)}
					{recipe.errors.length > 0 && (
						<div className="flex items-start gap-2 text-xs text-destructive" role="alert">
							<AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden />
							<span>
								{t("settings:worktreeRecipe.invalid", {
									errors: recipe.errors.join(" ; "),
								})}
							</span>
						</div>
					)}
				</div>
			)}

			{state?.hasFile && recipe && recipe.errors.length === 0 && (
				state.approved ? (
					<p className="flex items-center gap-2 text-xs text-muted-foreground">
						<CheckCircle2 className="h-3 w-3 text-success" aria-hidden />
						{t("settings:worktreeRecipe.approved")}
					</p>
				) : (
					<div className="flex items-center justify-between gap-3">
						<p className="text-xs text-warning">
							{t("settings:worktreeRecipe.awaiting")}
						</p>
						<Button
							size="sm"
							disabled={busy}
							onClick={() => void run(globalThis.electronAPI.approveWorktreeRecipe)}
						>
							{t("settings:worktreeRecipe.approve")}
						</Button>
					</div>
				)
			)}

			{state && !state.hasFile && state.detected.setup.length > 0 && (
				<div className="flex items-center justify-between gap-3">
					<p className="text-xs text-muted-foreground">
						{t("settings:worktreeRecipe.saveHint")}
					</p>
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() =>
							void run(globalThis.electronAPI.saveDetectedWorktreeRecipe)
						}
					>
						{t("settings:worktreeRecipe.saveDetected")}
					</Button>
				</div>
			)}

			{error && (
				<p className="text-xs text-destructive" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}

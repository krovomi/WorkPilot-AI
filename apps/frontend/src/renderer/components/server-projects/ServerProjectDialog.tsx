import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "@/stores/project-store";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/** The last path segment of a repository URL, without `.git`. */
export function repoNameFromUrl(url: string): string {
	const last = url.trim().replace(/[/\\]+$/, "").split(/[/:\\]/).pop() ?? "";
	return last.replace(/\.git$/i, "");
}

interface ServerProjectDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	/** Add a folder of this computer instead, as in local mode. */
	readonly onChooseLocal: () => void;
}

/**
 * Server mode: add a project for the whole team. The server clones the
 * repository and every member works on that clone; the app sends the URL,
 * never a path, and the server decides who may (`server-mode.md`).
 */
export function ServerProjectDialog({
	open,
	onOpenChange,
	onChooseLocal,
}: ServerProjectDialogProps) {
	const { t } = useTranslation("dialogs");
	const [repoUrl, setRepoUrl] = useState("");
	const [name, setName] = useState("");
	const [branch, setBranch] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const effectiveName = name.trim() || repoNameFromUrl(repoUrl);

	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			const result = await window.electronAPI.createServerProject({
				name: effectiveName,
				repoUrl: repoUrl.trim(),
				defaultBranch: branch.trim() || undefined,
			});
			if (!result.success || !result.data) {
				setError(result.error ?? t("serverProject.failed"));
				return;
			}
			const store = useProjectStore.getState();
			store.addProject(result.data);
			store.selectProject(result.data.id);
			store.openProjectTab(result.data.id);
			onOpenChange(false);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>{t("serverProject.title")}</DialogTitle>
					<DialogDescription>{t("serverProject.description")}</DialogDescription>
				</DialogHeader>
				<div className="space-y-4 py-2">
					<div className="space-y-2">
						<Label htmlFor="server-project-repo">{t("serverProject.repoUrl")}</Label>
						<Input
							id="server-project-repo"
							placeholder="https://github.com/acme/app.git"
							value={repoUrl}
							onChange={(e) => setRepoUrl(e.target.value)}
							autoFocus
						/>
						<p className="text-xs text-muted-foreground">
							{t("serverProject.repoUrlHelp")}
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="server-project-name">{t("serverProject.name")}</Label>
						<Input
							id="server-project-name"
							placeholder={repoNameFromUrl(repoUrl) || t("serverProject.namePlaceholder")}
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="server-project-branch">{t("serverProject.branch")}</Label>
						<Input
							id="server-project-branch"
							placeholder="main"
							value={branch}
							onChange={(e) => setBranch(e.target.value)}
						/>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
				</div>
				<DialogFooter className="sm:justify-between">
					<Button variant="ghost" onClick={onChooseLocal} disabled={busy}>
						{t("serverProject.useLocalFolder")}
					</Button>
					<Button onClick={submit} disabled={busy || !repoUrl.trim() || !effectiveName}>
						{busy ? t("serverProject.creating") : t("serverProject.create")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

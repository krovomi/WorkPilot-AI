import { GitPullRequest, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Textarea } from "../../ui/textarea";
import { useTranslation } from "react-i18next";

interface CreateMergeRequestDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	defaultSourceBranch?: string;
	defaultTargetBranch?: string;
	onSuccess?: (mrIid: number) => void;
}

export function CreateMergeRequestDialog({
	open,
	onOpenChange,
	projectId,
	defaultSourceBranch = "",
	defaultTargetBranch = "main",
	onSuccess,
}: CreateMergeRequestDialogProps) {
	const { t } = useTranslation();
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [sourceBranch, setSourceBranch] = useState(defaultSourceBranch);
	const [targetBranch, setTargetBranch] = useState(defaultTargetBranch);
	const [isCreating, setIsCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Ids of its own: "title" and "description" are taken by other views.
	const ids = `create-mr-${useId()}`;

	const handleCreate = async () => {
		if (!title.trim() || !sourceBranch.trim() || !targetBranch.trim()) {
			setError(t("gitlab:mergeRequests.create.required"));
			return;
		}

		setIsCreating(true);
		setError(null);

		try {
			const result = await window.electronAPI.createGitLabMergeRequest(
				projectId,
				{
					sourceBranch: sourceBranch.trim(),
					targetBranch: targetBranch.trim(),
					title: title.trim(),
					description: description.trim() || undefined,
				},
			);

			if (result.success && result.data) {
				onSuccess?.(result.data.iid);
				onOpenChange(false);
				// Reset form
				setTitle("");
				setDescription("");
				setSourceBranch(defaultSourceBranch);
				setTargetBranch(defaultTargetBranch);
			} else {
				setError(result.error || t("gitlab:mergeRequests.create.failed"));
			}
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: t("gitlab:mergeRequests.create.failed"),
			);
		} finally {
			setIsCreating(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[500px]">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<GitPullRequest className="h-5 w-5" />
						{t("gitlab:mergeRequests.create.title")}
					</DialogTitle>
					<DialogDescription>
						{t("gitlab:mergeRequests.create.description")}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-4">
					<div className="space-y-2">
						<Label htmlFor={`${ids}-title`}>{t("gitlab:mergeRequests.create.titleLabel")}</Label>
						<Input
							id={`${ids}-title`}
							placeholder={t("gitlab:mergeRequests.create.titlePlaceholder")}
							value={title}
							onChange={(e) => setTitle(e.target.value)}
						/>
					</div>

					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-2">
							<Label htmlFor={`${ids}-source`}>{t("gitlab:mergeRequests.create.sourceBranch")}</Label>
							<Input
								id={`${ids}-source`}
								placeholder="feature/my-feature"
								value={sourceBranch}
								onChange={(e) => setSourceBranch(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor={`${ids}-target`}>{t("gitlab:mergeRequests.create.targetBranch")}</Label>
							<Input
								id={`${ids}-target`}
								placeholder="main"
								value={targetBranch}
								onChange={(e) => setTargetBranch(e.target.value)}
							/>
						</div>
					</div>

					<div className="space-y-2">
						<Label htmlFor={`${ids}-description`}>{t("gitlab:mergeRequests.create.descriptionLabel")}</Label>
						<Textarea
							id={`${ids}-description`}
							placeholder={t("gitlab:mergeRequests.create.descriptionPlaceholder")}
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={4}
						/>
					</div>

					{error && (
						<div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
							{error}
						</div>
					)}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{t("common:buttons.cancel")}
					</Button>
					<Button onClick={handleCreate} disabled={isCreating}>
						{isCreating ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								{t("common:buttons.creating")}
							</>
						) : (
							t("gitlab:mergeRequests.create.title")
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

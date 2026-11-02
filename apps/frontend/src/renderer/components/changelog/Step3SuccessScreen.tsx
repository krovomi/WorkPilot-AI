import { Check, PartyPopper } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChangelogTask } from "../../../shared/types";
import { Button } from "../ui/button";
import { ArchiveTasksCard } from "./ArchiveTasksCard";
import { GitHubReleaseCard } from "./GitHubReleaseCard";
import { formatVersionTag } from "./utils";

interface Step3SuccessScreenProps {
	projectId: string;
	version: string;
	selectedTaskIds: string[];
	doneTasks: ChangelogTask[];
	generatedChangelog: string;
	/** A server project: its changelog is shared on the server, with no file or release here. */
	serverProject?: boolean;
	onDone: () => void;
}

export function Step3SuccessScreen({
	projectId,
	version,
	selectedTaskIds,
	doneTasks,
	generatedChangelog,
	serverProject = false,
	onDone,
}: Step3SuccessScreenProps) {
	const { t } = useTranslation("changelog");
	const selectedTasks = doneTasks.filter((task) =>
		selectedTaskIds.includes(task.id),
	);
	const tag = formatVersionTag(version);

	return (
		<div className="flex flex-1 flex-col items-center justify-center p-8">
			<div className="max-w-lg w-full space-y-8">
				{/* Success Message */}
				<div className="text-center">
					<div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-success/10 mb-4">
						<PartyPopper className="h-8 w-8 text-success" />
					</div>
					<h2 className="text-2xl font-semibold">
						{serverProject ? t("server.savedTitle") : "Changelog Saved!"}
					</h2>
					<p className="text-muted-foreground mt-2">
						{serverProject
							? t("server.savedDescription", { tag })
							: `Version ${tag} has been added to CHANGELOG.md`}
					</p>
				</div>

				{/* Action Cards: a release and an archive act on this computer's project. */}
				{!serverProject && (
					<div className="space-y-4">
						<GitHubReleaseCard
							projectId={projectId}
							version={version}
							generatedChangelog={generatedChangelog}
						/>

						<ArchiveTasksCard
							projectId={projectId}
							version={version}
							selectedTaskIds={selectedTaskIds}
							selectedTasks={selectedTasks}
						/>
					</div>
				)}

				{/* Done Button */}
				<div className="pt-4">
					<Button className="w-full" size="lg" onClick={onDone}>
						<Check className="mr-2 h-4 w-4" />
						Done
					</Button>
				</div>
			</div>
		</div>
	);
}

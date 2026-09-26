import type { Task } from "../../../shared/types";
import {
	useWorkflowProfileStore,
	workflowProfileKey,
} from "../../stores/workflow-profile-store";
import { JevStatus } from "../jev/JevStatus";

export interface TaskJevCardProps {
	readonly task: Task;
	readonly projectPath?: string;
}

/**
 * JEV pour cette tâche, dans sa propre carte.
 *
 * Il était rendu *à l'intérieur* de la carte du profil d'exécution, au-dessus
 * de son titre, comme une ligne d'en-tête sans cadre : on le lisait comme une
 * partie du profil. C'est un service distinct — un second avis externe, avec
 * son propre interrupteur — et il a maintenant sa carte à côté.
 *
 * Il lit le profil que `WorkflowProfileCard` a déjà chargé (même clé de
 * store) : le workflow résolu, la barrière hors-ligne et l'historique des
 * évaluations viennent de la même réponse, sans second aller-retour.
 */
export function TaskJevCard({ task, projectPath }: TaskJevCardProps) {
	const profileKey = workflowProfileKey({
		taskId: task.id,
		projectDir: projectPath,
		specDir: task.specsPath,
		specId: task.specId,
	});
	const profile = useWorkflowProfileStore((s) => s.byTask[profileKey]?.profile);
	if (!projectPath || !profile) return null;
	return (
		<JevStatus
			workflow={profile.workflow}
			projectId={task.projectId}
			offline={profile.jev?.airgapStrict}
			observation={profile.jev?.observation}
		/>
	);
}

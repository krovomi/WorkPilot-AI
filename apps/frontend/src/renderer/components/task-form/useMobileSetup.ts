/**
 * The state of the task form's "Mobile platforms" box: the project's mobile
 * profile, the framework the setup would install, and the setup steps the
 * checked platforms need (`lib/mobile-setup.ts`).
 *
 * The profile is read once per project and kept for the session: it reads
 * files, and the dialog opens often. A project gaining its app later (the
 * setup tasks merged) is read again on the next session or after `reload`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MobilePlatform, MobileProfile } from "../../../shared/types/mobile";
import {
	frameworksFor,
	type MobileSetupPlan,
	needsMobileSetup,
	planMobileSetup,
	resolveFramework,
} from "../../lib/mobile-setup";
import { useTaskStore } from "../../stores/task-store";

export interface MobileSetupState {
	/** `undefined` while it loads; `null` when it could not be read. */
	profile: MobileProfile | null | undefined;
	/** The setup the checked platforms need, or null when none is needed. */
	plan: MobileSetupPlan | null;
	/** Frameworks the person may pick for the checked platforms. */
	choices: ReturnType<typeof frameworksFor>;
	/** True when an open setup task already fixes the framework. */
	locked: boolean;
	setFramework: (id: string) => void;
}

const cache = new Map<string, MobileProfile>();

/** Forget the profiles read so far (tests; a project that gained its app). */
export function clearMobileProfileCache(): void {
	cache.clear();
}

export function useMobileSetup(
	projectId: string | undefined,
	targets: readonly MobilePlatform[],
): MobileSetupState {
	const { t } = useTranslation(["mobile"]);
	const [profile, setProfile] = useState<MobileProfile | null | undefined>(
		projectId ? cache.get(projectId) : null,
	);
	const [chosen, setChosen] = useState<string | null>(null);
	const allTasks = useTaskStore((state) => state.tasks);
	const tasks = useMemo(
		() => allTasks.filter((task) => task.projectId === projectId),
		[allTasks, projectId],
	);

	useEffect(() => {
		if (!projectId) {
			setProfile(null);
			return;
		}
		const known = cache.get(projectId);
		if (known) {
			setProfile(known);
			return;
		}
		// The browser preview and older test doubles have no such call: the
		// box then shows its plain description, as before.
		const read = globalThis.electronAPI?.getMobileProfile;
		if (typeof read !== "function") {
			setProfile(null);
			return;
		}
		let alive = true;
		setProfile(undefined);
		read(projectId)
			.then((result) => {
				if (!alive) return;
				const data = result.success && result.data?.success ? result.data : null;
				if (data) cache.set(projectId, data);
				setProfile(data);
			})
			.catch(() => {
				if (alive) setProfile(null);
			});
		return () => {
			alive = false;
		};
	}, [projectId]);

	const choices = useMemo(() => frameworksFor(profile, targets), [profile, targets]);
	const { framework, locked } = useMemo(
		() => resolveFramework(profile, targets, chosen, tasks),
		[profile, targets, chosen, tasks],
	);
	const plan = useMemo(
		() =>
			framework && needsMobileSetup(profile, targets)
				? planMobileSetup(framework, targets, tasks, t)
				: null,
		[framework, profile, targets, tasks, t],
	);
	const setFramework = useCallback((id: string) => setChosen(id), []);

	return { profile, plan, choices, locked, setFramework };
}

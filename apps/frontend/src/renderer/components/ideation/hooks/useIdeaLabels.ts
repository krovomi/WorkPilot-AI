import { useTranslation } from "react-i18next";
import type { IdeationStatus, IdeationType } from "../../../../shared/types";

/**
 * The words shown for an idea's codes. The generator writes effort, severity,
 * category and audience codes; a code it invents that the locale does not know
 * is shown as written rather than as a translation key.
 */
export function useIdeaLabels() {
	const { t } = useTranslation("ideation");
	return {
		status: (status: IdeationStatus) => t(`status.${status}`),
		level: (level: string) => t(`levels.${level}`, { defaultValue: level }),
		category: (type: IdeationType, category: string) =>
			t(`categories.${type}.${category}`, { defaultValue: category }),
		audience: (audience: string) =>
			t(`audiences.${audience}`, { defaultValue: audience }),
	};
}

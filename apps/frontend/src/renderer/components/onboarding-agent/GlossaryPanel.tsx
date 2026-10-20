import { Search } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOnboardingAgentStore } from "../../stores/onboarding-agent-store";
import { CategoryBadge, EmptyState, useGeneratedText } from "./shared";

export function GlossaryPanel(): React.ReactElement | null {
	const { t } = useTranslation("onboardingAgent");
	const pkg = useOnboardingAgentStore((s) => s.pkg);
	const [query, setQuery] = useState("");
	const generated = useGeneratedText();

	if (!pkg) return null;
	if (pkg.glossary.length === 0) {
		return <EmptyState message={t("emptyGlossary")} />;
	}

	const needle = query.trim().toLowerCase();
	// Search the definition the reader can see, not the English one underneath.
	const visible = pkg.glossary
		.map((term) => ({
			term,
			definition: generated(term.definition_i18n, term.definition),
		}))
		.filter(
			({ term, definition }) =>
				!needle ||
				term.term.toLowerCase().includes(needle) ||
				definition.toLowerCase().includes(needle),
		);

	return (
		<div className="space-y-3">
			<label className="flex items-center gap-2 border rounded-md px-2 py-1.5 bg-card">
				<Search className="w-4 h-4 text-muted-foreground" />
				<input
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t("glossarySearch")}
					className="flex-1 bg-transparent text-sm outline-none"
				/>
			</label>

			{visible.length === 0 ? (
				<EmptyState message={t("glossaryNoMatch", { query })} />
			) : (
				<div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
					{visible.map(({ term, definition }) => (
						<div key={term.term} className="border rounded-md p-3 bg-card">
							<div className="flex items-center justify-between gap-2">
								<p className="font-mono text-sm truncate">{term.term}</p>
								<div className="flex items-center gap-1 shrink-0">
									<CategoryBadge
										category={term.kind}
										label={t(`glossaryKinds.${term.kind}`)}
									/>
									<span className="text-xs text-muted-foreground">
										×{term.occurrences}
									</span>
								</div>
							</div>
							{definition && (
								<p className="text-xs text-muted-foreground mt-1">
									{definition}
								</p>
							)}
							{term.sources.length > 0 && (
								<p className="text-xs font-mono text-muted-foreground mt-1 truncate">
									{term.sources.join(" · ")}
								</p>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

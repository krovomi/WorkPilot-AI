import type { RecorderExportOutcome } from "@shared/types/browser-recorder";
import { Database } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Chip, Notice } from "../charter";

interface RecorderTestDataProps {
	readonly outcome: RecorderExportOutcome;
}

/**
 * The values typed while recording, as the exported test reads them (#387):
 * each key with what it holds, and the data file written beside the test
 * (or, in Java and C#, the block of constants at the top of the test).
 * Values are shown only inside the data file's text, never as markup.
 */
export function RecorderTestData({ outcome }: RecorderTestDataProps) {
	const { t } = useTranslation(["browserAgent"]);
	const values = outcome.dataValues ?? [];
	if (!values.length) return null;
	const fixture = outcome.fixture;
	return (
		<div className="space-y-2" data-testid="recorder-test-data">
			<Notice icon={Database}>
				<p>
					{fixture
						? t("browserAgent:recorder.data.file", { path: fixture.path, count: values.length })
						: t("browserAgent:recorder.data.block", { count: values.length })}
				</p>
				<ul className="mt-2 flex flex-wrap gap-2" aria-label={t("browserAgent:recorder.data.keys")}>
					{values.map((value) => (
						<li key={value.name} className="inline-flex items-center gap-1">
							<code className="font-mono text-xs">{value.name}</code>
							<Chip tone="blue" dot={false}>
								{t(`browserAgent:recorder.data.kinds.${value.kind}`)}
							</Chip>
						</li>
					))}
				</ul>
			</Notice>
			{fixture && (
				<pre
					className="max-h-64 overflow-auto rounded-md bg-[var(--wp-code-bg)] p-3 font-mono text-xs"
					data-testid="recorder-fixture"
				>
					{fixture.code}
				</pre>
			)}
		</div>
	);
}

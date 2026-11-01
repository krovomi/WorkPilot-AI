/**
 * The files the build changed; tapping one opens its diff, coloured, so a
 * reviewer can read the work before approving the merge from the phone.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { CardChanges, ChangedFile } from "../api/types";
import { Section } from "../ui/components";
import { RADIUS, SPACE, type Theme, useTheme } from "../ui/theme";
import { mono } from "./LongText";
import { type PatchLineKind, patchLines } from "./patch";

const MAX_FILES = 50;

export function ChangesSection({ changes }: { changes: CardChanges | null }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const [open, setOpen] = useState<string | null>(null);
	if (!changes) return null;
	return (
		<Section title={t("card.changes")}>
			{!changes.exists ? (
				<Text style={{ color: theme.textMuted }}>{t("card.noChanges")}</Text>
			) : (
				<>
					<Text style={{ color: theme.textMuted }}>
						{t("card.changesSummary", {
							files: changes.filesChanged ?? changes.files.length,
							additions: changes.additions ?? 0,
							deletions: changes.deletions ?? 0,
							commits: changes.commitCount ?? 0,
						})}
					</Text>
					{changes.files.slice(0, MAX_FILES).map((file) => (
						<FileRow
							key={file.path}
							file={file}
							open={open === file.path}
							onToggle={() => setOpen((current) => (current === file.path ? null : file.path))}
						/>
					))}
				</>
			)}
		</Section>
	);
}

function FileRow({ file, open, onToggle }: { file: ChangedFile; open: boolean; onToggle: () => void }) {
	const { t } = useTranslation();
	const theme = useTheme();
	return (
		<View>
			<Pressable
				accessibilityRole="button"
				accessibilityState={{ expanded: open }}
				accessibilityLabel={t("card.fileToggle", { path: file.path })}
				onPress={onToggle}
				style={styles.file}
			>
				<Text style={[mono.text, { color: theme.text, flex: 1 }]} numberOfLines={1} ellipsizeMode="head">
					{file.path}
				</Text>
				<Text style={{ color: theme.success }}>+{file.additions}</Text>
				<Text style={{ color: theme.danger }}>−{file.deletions}</Text>
			</Pressable>
			{open ? <Patch patch={file.patch} /> : null}
		</View>
	);
}

function Patch({ patch }: { patch: string | null }) {
	const { t } = useTranslation();
	const theme = useTheme();
	if (!patch) return <Text style={{ color: theme.textMuted }}>{t("card.noPatch")}</Text>;
	const { lines, truncated } = patchLines(patch);
	return (
		<View style={[styles.patch, { borderColor: theme.border, backgroundColor: theme.surface }]}>
			<ScrollView horizontal>
				<View>
					{lines.map((line) => (
						<Text
							key={line.n}
							style={[mono.text, lineStyle(theme, line.kind)]}
							selectable
						>
							{line.text || " "}
						</Text>
					))}
				</View>
			</ScrollView>
			{truncated ? <Text style={{ color: theme.textMuted, padding: SPACE.sm }}>{t("card.patchTruncated")}</Text> : null}
		</View>
	);
}

function lineStyle(theme: Theme, kind: PatchLineKind) {
	switch (kind) {
		case "added":
			return { color: theme.success };
		case "removed":
			return { color: theme.danger };
		case "hunk":
			return { color: theme.accent };
		case "meta":
			return { color: theme.textFaint };
		default:
			return { color: theme.text };
	}
}

const styles = StyleSheet.create({
	file: { flexDirection: "row", gap: SPACE.sm, alignItems: "center", paddingVertical: SPACE.xs, minHeight: 32 },
	patch: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.sm, padding: SPACE.sm, marginBottom: SPACE.sm },
});

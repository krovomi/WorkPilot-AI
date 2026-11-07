/** A long monospace text (a spec, a QA report), shown in part until opened. */

import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text } from "react-native";
import { useTheme } from "../ui/theme";

export const PREVIEW = 1_200;

export function LongText({ text, showLabel, hideLabel }: { text: string; showLabel: string; hideLabel: string }) {
	const theme = useTheme();
	const [open, setOpen] = useState(false);
	const long = text.length > PREVIEW;
	return (
		<>
			<Text style={[mono.text, { color: theme.text }]} selectable>
				{open || !long ? text : `${text.slice(0, PREVIEW)}…`}
			</Text>
			{long ? (
				<Pressable accessibilityRole="button" onPress={() => setOpen((value) => !value)}>
					<Text style={{ color: theme.accent }}>{open ? hideLabel : showLabel}</Text>
				</Pressable>
			) : null}
		</>
	);
}

export const mono = StyleSheet.create({
	text: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 13, lineHeight: 19 },
});

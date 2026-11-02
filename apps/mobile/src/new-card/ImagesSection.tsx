/**
 * Images for a new card, from the photo library or the camera. Each is read
 * as base64 and checked against the server's rules (`images.ts`); a refused
 * one is named with its reason, never dropped silently.
 */

import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Button } from "../ui/components";
import { RADIUS, SPACE, useTheme } from "../ui/theme";
import { addImages, MAX_IMAGE_BYTES, MAX_IMAGES, type PendingImage, type Refusal } from "./images";

const PICK_OPTIONS: ImagePicker.ImagePickerOptions = {
	mediaTypes: "images",
	base64: true,
	exif: false,
	quality: 0.8,
};

export function ImagesSection({
	images,
	onChange,
}: {
	images: readonly PendingImage[];
	onChange: (images: PendingImage[]) => void;
}) {
	const { t } = useTranslation();
	const theme = useTheme();
	const [refused, setRefused] = useState<Refusal[]>([]);
	const [denied, setDenied] = useState(false);
	const full = images.length >= MAX_IMAGES;

	const take = (result: ImagePicker.ImagePickerResult) => {
		if (result.canceled) return;
		const next = addImages(images, result.assets);
		setRefused(next.refused);
		onChange(next.images);
	};

	const fromLibrary = async () => {
		setDenied(false);
		take(
			await ImagePicker.launchImageLibraryAsync({
				...PICK_OPTIONS,
				allowsMultipleSelection: true,
				selectionLimit: MAX_IMAGES - images.length,
			}),
		);
	};

	const fromCamera = async () => {
		setDenied(false);
		const permission = await ImagePicker.requestCameraPermissionsAsync();
		if (!permission.granted) {
			setDenied(true);
			return;
		}
		take(await ImagePicker.launchCameraAsync(PICK_OPTIONS));
	};

	const remove = (id: string) => {
		setRefused([]);
		onChange(images.filter((image) => image.id !== id));
	};

	return (
		<View style={{ gap: SPACE.sm }}>
			<Text style={{ color: theme.textMuted, fontSize: 13, fontWeight: "500" }}>
				{t("newCard.images", { count: images.length, max: MAX_IMAGES })}
			</Text>
			{images.length ? (
				<View style={styles.thumbs}>
					{images.map((image) => (
						<View key={image.id} style={[styles.thumb, { borderColor: theme.border }]}>
							<Image source={{ uri: image.uri }} style={styles.picture} accessibilityLabel={image.filename} />
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={t("newCard.removeImage", { name: image.filename })}
								hitSlop={8}
								onPress={() => remove(image.id)}
								style={[styles.remove, { backgroundColor: theme.surface, borderColor: theme.border }]}
							>
								<Text style={{ color: theme.text, fontWeight: "700" }}>×</Text>
							</Pressable>
						</View>
					))}
				</View>
			) : null}
			<View style={styles.buttons}>
				<Button
					label={t("newCard.fromLibrary")}
					variant="secondary"
					disabled={full}
					onPress={() => void fromLibrary()}
					style={{ flex: 1 }}
				/>
				{Platform.OS === "web" ? null : (
					<Button
						label={t("newCard.fromCamera")}
						variant="secondary"
						disabled={full}
						onPress={() => void fromCamera()}
						style={{ flex: 1 }}
					/>
				)}
			</View>
			{denied ? <Text style={{ color: theme.danger }}>{t("newCard.cameraDenied")}</Text> : null}
			{refused.map((r) => (
				<Text key={`${r.name}-${r.reason}`} accessibilityRole="alert" style={{ color: theme.danger }}>
					{t(`newCard.imageRefused_${r.reason}`, { name: r.name, max: MAX_IMAGES, mb: MAX_IMAGE_BYTES / 1_000_000 })}
				</Text>
			))}
		</View>
	);
}

const styles = StyleSheet.create({
	thumbs: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm },
	thumb: { width: 76, height: 76, borderWidth: 1, borderRadius: RADIUS.md, overflow: "hidden" },
	picture: { width: "100%", height: "100%" },
	remove: {
		position: "absolute",
		top: 2,
		right: 2,
		width: 24,
		height: 24,
		borderRadius: 12,
		borderWidth: 1,
		alignItems: "center",
		justifyContent: "center",
	},
	buttons: { flexDirection: "row", gap: SPACE.sm },
});

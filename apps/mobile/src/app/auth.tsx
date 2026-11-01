import { Redirect } from "expo-router";

/**
 * Where Microsoft sends the person back after an Entra sign-in
 * (`workpilot://auth`). The sign-in screen reads the answer itself
 * (`auth/entra.ts`); if the system opens the app on this link instead, it
 * goes on to the projects, or back to the sign-in screen.
 */
export default function AuthReturn() {
	return <Redirect href="/" />;
}

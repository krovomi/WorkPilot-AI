/**
 * Lets the Android app reach a team server in plain HTTP on the local network.
 *
 * A release build refuses cleartext by default, and Android's network
 * security configuration cannot name "the local network" (private address
 * ranges, a machine's bare name). So cleartext is allowed for the app, and
 * the app decides which addresses may use it: `src/api/server-url.ts` accepts
 * http only for this machine or the local network and refuses it for any
 * other host. iOS gets the same set from `NSAllowsLocalNetworking` (app.json).
 */
const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

module.exports = function withLocalNetworkHttp(config) {
	return withAndroidManifest(config, (mod) => {
		const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
		application.$["android:usesCleartextTraffic"] = "true";
		return mod;
	});
};

/**
 * Token Encryption Module
 * Handles OAuth token encryption/decryption using OS keychain.
 * The policy (prefix, fallback, user warning) lives in ../secret-storage.
 */

import {
	decryptSecret,
	encryptSecret,
	isEncryptedSecret,
} from "../secret-storage";

/**
 * Encrypt a token using the OS keychain (safeStorage API).
 * Returns `enc:`-prefixed ciphertext. Without OS encryption the raw token is
 * returned and the UI warns the user — never a silent plaintext fallback.
 */
export function encryptToken(token: string): string {
	return encryptSecret(token);
}

/**
 * Decrypt a token. Handles both encrypted (enc:...) and legacy plain tokens.
 * Returns an empty string when the token cannot be decrypted.
 */
export function decryptToken(storedToken: string): string {
	return decryptSecret(storedToken) ?? "";
}

/**
 * Check if a token is encrypted
 */
export function isTokenEncrypted(storedToken: string): boolean {
	return isEncryptedSecret(storedToken);
}

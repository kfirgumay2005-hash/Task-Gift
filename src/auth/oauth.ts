import { Platform, requestUrl } from "obsidian";
import type { Server, IncomingMessage, ServerResponse } from "http";
import type { AuthData } from "../types";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/tasks"];
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	id_token?: string;
	error?: string;
	error_description?: string;
}

export class AuthError extends Error {
	constructor(message: string, readonly revoked = false) {
		super(message);
	}
}

function base64Url(bytes: Uint8Array): string {
	let bin = "";
	bytes.forEach((b) => (bin += String.fromCharCode(b)));
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return base64Url(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64Url(new Uint8Array(digest));
}

function emailFromIdToken(idToken: string | undefined): string {
	if (!idToken) return "";
	try {
		const payload = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
		const json = JSON.parse(decodeURIComponent(escape(atob(payload)))) as { email?: string };
		return json.email ?? "";
	} catch {
		return "";
	}
}

async function postForm(url: string, params: Record<string, string>): Promise<TokenResponse> {
	const res = await requestUrl({
		url,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams(params).toString(),
		throw: false,
	});
	let data: TokenResponse = {};
	try {
		data = res.json as TokenResponse;
	} catch {
		/* non-JSON body */
	}
	if (res.status >= 400) {
		const revoked = data.error === "invalid_grant";
		throw new AuthError(data.error_description || data.error || `HTTP ${res.status}`, revoked);
	}
	return data;
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Task Gift</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1e1e2e;color:#eee}
div{text-align:center}h1{font-size:2.5rem;margin:0 0 .5rem}</style></head>
<body><div><h1>🎁</h1><p><b>Task Gift is connected.</b></p><p>You can close this tab and return to Obsidian.</p></div></body></html>`;

const ERROR_HTML = (msg: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Task Gift</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem"><h2>Task Gift could not connect</h2><p>${msg
	.replace(/</g, "&lt;")
	.replace(/>/g, "&gt;")}</p><p>Return to Obsidian and try again.</p></body></html>`;

/** Fixed loopback address used by the copy-paste flow; nothing needs to listen there. */
export const MANUAL_REDIRECT_URI = "http://127.0.0.1:53682";

export interface AuthSession {
	url: string;
	verifier: string;
	state: string;
	redirectUri: string;
}

export function checkCredentials(clientId: string, clientSecret: string): void {
	if (!clientId || !clientSecret) throw new AuthError("Enter your Client ID and Client Secret first.");
}

/** Builds the Google consent URL with PKCE for the given redirect URI. */
export async function createAuthSession(clientId: string, redirectUri: string): Promise<AuthSession> {
	const verifier = randomString(48);
	const challenge = await pkceChallenge(verifier);
	const state = randomString(16);
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		access_type: "offline",
		prompt: "consent",
		state,
	});
	return { url: `${AUTH_ENDPOINT}?${params.toString()}`, verifier, state, redirectUri };
}

/** Exchanges an authorization code for tokens. */
export async function exchangeCode(session: AuthSession, code: string, clientId: string, clientSecret: string): Promise<AuthData> {
	const tokens = await postForm(TOKEN_ENDPOINT, {
		code,
		client_id: clientId,
		client_secret: clientSecret,
		redirect_uri: session.redirectUri,
		grant_type: "authorization_code",
		code_verifier: session.verifier,
	});
	if (!tokens.access_token || !tokens.refresh_token) {
		throw new AuthError("Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.");
	}
	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
		email: emailFromIdToken(tokens.id_token),
	};
}

/**
 * Extracts the code from what the user pasted: the full redirected address
 * (http://127.0.0.1:53682/?state=…&code=…) or just the code itself.
 */
export function parsePastedCode(input: string, session: AuthSession): string {
	const text = input.trim();
	if (!text) throw new AuthError("Paste the address from your browser first.");
	if (/[?&](code|error)=/.test(text)) {
		const query = text.slice(text.indexOf("?") + 1).split("#")[0];
		const params = new URLSearchParams(query);
		const error = params.get("error");
		if (error) throw new AuthError(`Google returned: ${error}`);
		const state = params.get("state");
		if (state && state !== session.state) throw new AuthError("This address belongs to an older sign-in attempt. Start again.");
		const code = params.get("code");
		if (!code) throw new AuthError("No code found in the pasted address.");
		return code;
	}
	return decodeURIComponent(text);
}

/** Opens the consent page in the system browser. */
export function openInBrowser(url: string): void {
	window.open(url);
}

/**
 * Desktop helper for the manual flow: listens on the fixed loopback port so the redirect
 * is caught automatically (no copy-paste needed). Rejects if the port is busy or on abort;
 * the user can then still paste the address.
 */
export function catchRedirect(port: number, expectedState: string, signal: AbortSignal): Promise<string> {
	if (!Platform.isDesktopApp) return Promise.reject(new AuthError("Not available on mobile."));
	const http = require("http") as typeof import("http");
	return new Promise<string>((resolve, reject) => {
		const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			if (!code && !error) {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			if (error) {
				res.end(ERROR_HTML(error));
				reject(new AuthError(`Google returned: ${error}`));
			} else if (url.searchParams.get("state") !== expectedState) {
				res.end(ERROR_HTML("This page belongs to an older sign-in attempt. Start again in Obsidian."));
				return;
			} else {
				res.end(SUCCESS_HTML);
				resolve(code as string);
			}
			server.close();
		});
		server.on("error", (err: Error) => reject(new AuthError(`Local server error: ${err.message}`)));
		signal.addEventListener("abort", () => {
			server.close();
			reject(new AuthError("Sign-in cancelled."));
		});
		server.listen(port, "127.0.0.1");
	});
}

/**
 * Automatic desktop flow: starts a local server on 127.0.0.1, opens the consent page,
 * waits for the redirect and exchanges the code. Desktop only.
 */
export interface LoginOptions {
	/** Abort to cancel waiting for the browser. */
	signal?: AbortSignal;
	/** Receives the consent URL (e.g. to offer "open again"). */
	onUrl?: (url: string) => void;
}

export async function login(clientId: string, clientSecret: string, opts: LoginOptions = {}): Promise<AuthData> {
	if (!Platform.isDesktopApp) throw new AuthError("Automatic sign-in needs the desktop app. Use the manual sign-in instead.");
	checkCredentials(clientId, clientSecret);
	const http = require("http") as typeof import("http");

	let server: Server | null = null;
	let session: AuthSession | null = null;
	const codePromise = new Promise<string>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new AuthError("Sign-in timed out. Please try again.")), LOGIN_TIMEOUT_MS);
		opts.signal?.addEventListener("abort", () => {
			window.clearTimeout(timer);
			reject(new AuthError("Sign-in cancelled."));
		});

		server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			if (!code && !error) {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			window.clearTimeout(timer);
			if (error) {
				res.end(ERROR_HTML(error));
				reject(new AuthError(`Google returned: ${error}`));
				return;
			}
			if (url.searchParams.get("state") !== session?.state) {
				res.end(ERROR_HTML("State mismatch."));
				reject(new AuthError("OAuth state mismatch."));
				return;
			}
			res.end(SUCCESS_HTML);
			resolve(code as string);
		});
		server.on("error", (err: Error) => {
			window.clearTimeout(timer);
			reject(new AuthError(`Local server error: ${err.message}`));
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server?.address();
			if (!addr || typeof addr === "string") {
				reject(new AuthError("Could not start the local sign-in server."));
				return;
			}
			createAuthSession(clientId, `http://127.0.0.1:${addr.port}`)
				.then((s) => {
					session = s;
					opts.onUrl?.(s.url);
					openInBrowser(s.url);
				})
				.catch(reject);
		});
	});

	try {
		const code = await codePromise;
		return await exchangeCode(session as unknown as AuthSession, code, clientId, clientSecret);
	} finally {
		(server as Server | null)?.close();
	}
}

export async function refresh(auth: AuthData, clientId: string, clientSecret: string): Promise<AuthData> {
	const tokens = await postForm(TOKEN_ENDPOINT, {
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: auth.refreshToken,
		grant_type: "refresh_token",
	});
	if (!tokens.access_token) throw new AuthError("Token refresh failed.");
	return {
		...auth,
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token ?? auth.refreshToken,
		expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
		email: emailFromIdToken(tokens.id_token) || auth.email,
	};
}

export async function revoke(auth: AuthData): Promise<void> {
	try {
		await requestUrl({
			url: `${REVOKE_ENDPOINT}?token=${encodeURIComponent(auth.refreshToken)}`,
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			throw: false,
		});
	} catch {
		/* best effort */
	}
}

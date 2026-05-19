import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

function csrfSecret(c: Context): string {
	return (
		(c.env.COOKIE_SECRET as string | undefined) ||
		(c.env.DIVMEMORY_WEB_PASSWORD as string | undefined) ||
		""
	);
}

async function hmacSign(message: string, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
	return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function verifyCsrfToken(
	token: string,
	secret: string,
): Promise<{ valid: boolean; value: string | null }> {
	const [value, sig] = token.split(":");
	if (!value || !sig) return { valid: false, value: null };
	const expected = await hmacSign(value, secret);
	const encoder = new TextEncoder();
	const a = encoder.encode(sig);
	const b = encoder.encode(expected);
	if (a.length !== b.length) return { valid: false, value: null };
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	if (diff !== 0) return { valid: false, value: null };
	return { valid: true, value };
}

export async function generateCsrfToken(secret: string): Promise<string> {
	const value = crypto.getRandomValues(new Uint8Array(16));
	const valueHex = Array.from(value)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const sig = await hmacSign(valueHex, secret);
	return `${valueHex}:${sig}`;
}

/** Middleware: validates CSRF token from header (X-CSRF-Token) against cookie */
export const csrfValidate =
	(cookieName: string): MiddlewareHandler =>
	async (c, next) => {
		const secret = csrfSecret(c);
		// API calls with Bearer token are exempt from CSRF
		if (c.req.header("Authorization")?.startsWith("Bearer ")) {
			return next();
		}
		// GET methods are exempt
		if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
			return next();
		}
		const raw = getCookie(c, cookieName);
		const headerToken = c.req.header("X-CSRF-Token") || "";
		if (!raw || !headerToken) {
			return c.json({ error: "Forbidden — CSRF token missing" }, 403);
		}
		const { valid, value } = await verifyCsrfToken(raw, secret);
		if (!valid || value !== headerToken) {
			return c.json({ error: "Forbidden — invalid CSRF token" }, 403);
		}
		return next();
	};

/** If you just need a generator endpoint, mount this as handler */
export const csrfToken =
	(cookieName: string): MiddlewareHandler =>
	async (c) => {
		const secret = csrfSecret(c);
		const token = await generateCsrfToken(secret);
		c.header("Set-Cookie", `${cookieName}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`);
		return c.json({ csrf_token: token.split(":")[0] });
	};

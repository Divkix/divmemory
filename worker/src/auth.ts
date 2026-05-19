import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

// In-memory rate-limit store (per-isolate, resets on cold start)
class AttemptRecord {
	count = 0;
	resetAt = Date.now() + 60000;
}

export const rateLimitStore = new Map<string, AttemptRecord>();

function now() {
	return Date.now();
}

function cleanStore() {
	const t = now();
	for (const [k, v] of rateLimitStore) {
		if (v.resetAt < t) rateLimitStore.delete(k);
	}
}

function checkRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
	// clean periodically
	if (Math.random() < 0.05) cleanStore();
	const rec = rateLimitStore.get(ip);
	if (!rec) return { allowed: true, retryAfter: 0 };
	if (now() > rec.resetAt) {
		rateLimitStore.delete(ip);
		return { allowed: true, retryAfter: 0 };
	}
	if (rec.count >= 10) {
		return { allowed: false, retryAfter: Math.ceil((rec.resetAt - now()) / 1000) };
	}
	return { allowed: true, retryAfter: 0 };
}

export function recordFailedAttempt(ip: string) {
	const rec = rateLimitStore.get(ip);
	if (!rec || now() > rec.resetAt) {
		rateLimitStore.set(ip, { count: 1, resetAt: now() + 60000 });
	} else {
		rec.count++;
	}
}

export function recordSuccessfulAttempt(ip: string) {
	rateLimitStore.delete(ip);
}

function getClientIP(c: Context): string {
	return (
		c.req.header("CF-Connecting-IP") ||
		c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
		"127.0.0.1"
	);
}

// Timing-safe string comparison using Node crypto (available via nodejs_compat)
// We implement a manual constant-time compare using Uint8Array since
// crypto.timingSafeEqual expects same-length buffers.
function timingSafeEqualStr(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const bufA = encoder.encode(a);
	const bufB = encoder.encode(b);
	if (bufA.length !== bufB.length) return false;
	let diff = 0;
	for (let i = 0; i < bufA.length; i++) {
		diff |= bufA[i] ^ bufB[i];
	}
	return diff === 0;
}

export { timingSafeEqualStr };

function bearerKey(c: Context): string {
	return (c.env.DIVMEMORY_API_KEY as string | undefined) || "";
}

function webPassword(c: Context): string {
	return (c.env.DIVMEMORY_WEB_PASSWORD as string | undefined) || "";
}

function cookieSecret(c: Context): string {
	return (
		(c.env.COOKIE_SECRET as string | undefined) ||
		(c.env.DIVMEMORY_WEB_PASSWORD as string | undefined) ||
		""
	);
}

/* ───────────── Cookie signing helpers ───────────── */

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

async function signCookie(payload: string, secret: string): Promise<string> {
	const sig = await hmacSign(payload, secret);
	return `${btoa(payload)}.${sig}`;
}

async function verifyCookie(signed: string, secret: string): Promise<string | null> {
	const [payloadB64, sigB64] = signed.split(".");
	if (!payloadB64 || !sigB64) return null;
	let payload = "";
	try {
		payload = atob(payloadB64);
	} catch {
		return null;
	}
	const expectedSig = await hmacSign(payload, secret);
	const encoder = new TextEncoder();
	const a = encoder.encode(sigB64);
	const b = encoder.encode(expectedSig);
	if (a.length !== b.length) return null;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	if (diff !== 0) return null;
	return payload;
}

export { hmacSign, signCookie, verifyCookie };

/* ───────────── Middleware ───────────── */

export const bearerAuth =
	(_sessionCookieName: string): MiddlewareHandler =>
	async (c, next) => {
		const auth = c.req.header("Authorization") || "";
		const expected = bearerKey(c);
		if (!auth.startsWith("Bearer ")) {
			return c.json({ error: "Unauthorized — Bearer token required" }, 401);
		}
		const token = auth.slice(7).trim();
		if (!expected || !timingSafeEqualStr(token, expected)) {
			return c.json({ error: "Unauthorized — invalid token" }, 401);
		}
		return next();
	};

export const cookieAuth =
	(sessionCookieName: string): MiddlewareHandler =>
	async (c, next) => {
		const secret = cookieSecret(c);
		const raw = getCookie(c, sessionCookieName);
		if (!raw) {
			return c.json({ error: "Unauthorized — session cookie required" }, 401);
		}
		const payload = await verifyCookie(raw, secret);
		if (!payload) {
			return c.json({ error: "Unauthorized — invalid session" }, 401);
		}
		let data: { exp?: number } = {};
		try {
			data = JSON.parse(payload);
		} catch {
			return c.json({ error: "Unauthorized — malformed session" }, 401);
		}
		if (data.exp && Date.now() > data.exp * 1000) {
			return c.json({ error: "Unauthorized — session expired" }, 401);
		}
		c.set("session", data);
		return next();
	};

export const hybridAuth =
	(sessionCookieName: string): MiddlewareHandler =>
	async (c, next) => {
		const auth = c.req.header("Authorization") || "";
		const expected = bearerKey(c);
		if (auth.startsWith("Bearer ")) {
			const token = auth.slice(7).trim();
			if (expected && timingSafeEqualStr(token, expected)) {
				return next();
			}
			return c.json({ error: "Unauthorized — invalid token" }, 401);
		}
		// Fall back to cookie
		const secret = cookieSecret(c);
		const raw = getCookie(c, sessionCookieName);
		if (!raw) {
			return c.json({ error: "Unauthorized — Bearer or session cookie required" }, 401);
		}
		const payload = await verifyCookie(raw, secret);
		if (!payload) {
			return c.json({ error: "Unauthorized — invalid session" }, 401);
		}
		let data: { exp?: number } = {};
		try {
			data = JSON.parse(payload);
		} catch {
			return c.json({ error: "Unauthorized — malformed session" }, 401);
		}
		if (data.exp && Date.now() > data.exp * 1000) {
			return c.json({ error: "Unauthorized — session expired" }, 401);
		}
		c.set("session", data);
		return next();
	};

// Passthrough for open routes (used internally to declaratively skip auth)
export const open = (): MiddlewareHandler => async (_c, next) => next();

// Re-export password / key getters for login.ts
export { checkRateLimit, getClientIP, webPassword };

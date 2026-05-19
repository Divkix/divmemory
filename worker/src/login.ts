import { setCookie } from "hono/cookie";
import {
	checkRateLimit,
	getClientIP,
	recordFailedAttempt,
	recordSuccessfulAttempt,
	signCookie,
	timingSafeEqualStr,
} from "./auth";

function envVar(c: { env: unknown }, key: string): string | undefined {
	return ((c.env as Record<string, unknown> | undefined)?.[key] as string | undefined) || undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: accepts any Hono app to avoid type coupling across typed/untyped contexts
export function createLoginRoute(app: any, sessionCookieName: string) {
	// biome-ignore lint/suspicious/noExplicitAny: generic handler accepting any Hono context shape
	app.post("/login", async (c: any) => {
		const expected = envVar(c, "DIVMEMORY_WEB_PASSWORD") || "";
		if (!expected) {
			return c.json({ error: "Login not configured" }, 500);
		}

		const ip = getClientIP(c);
		const rl = checkRateLimit(ip);
		if (!rl.allowed) {
			c.header("Retry-After", String(rl.retryAfter));
			return c.json({ error: "Too many failed attempts" }, 429);
		}

		const ct = c.req.header("Content-Type") || "";
		const isForm =
			ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data");
		let body: { password?: string; redirect?: string } = {};
		if (isForm) {
			try {
				const form = await c.req.parseBody();
				body = {
					password: String(form.password ?? ""),
					redirect: String(form.redirect ?? ""),
				};
			} catch {
				try {
					body = (await c.req.json()) as { password?: string };
				} catch {
					return c.json({ error: "Invalid request body" }, 400);
				}
			}
		} else {
			try {
				body = (await c.req.json()) as { password?: string };
			} catch {
				return c.json({ error: "Invalid request body" }, 400);
			}
		}

		const password = body.password;
		if (typeof password !== "string") {
			return c.json({ error: "Password required" }, 400);
		}

		// Timing-safe comparison
		if (!(await timingSafeEqualStr(password, expected))) {
			recordFailedAttempt(ip);
			return c.json({ error: "Invalid credentials" }, 401);
		}

		recordSuccessfulAttempt(ip);

		const secret = envVar(c, "COOKIE_SECRET") || expected;

		const maxAgeSec = 86400 * 7; // 7 days
		const payload = JSON.stringify({
			ip,
			exp: Math.floor(Date.now() / 1000) + maxAgeSec,
		});
		const signed = await signCookie(payload, secret);

		setCookie(c, sessionCookieName, signed, {
			httpOnly: true,
			secure: true,
			sameSite: "Strict",
			maxAge: maxAgeSec,
			path: "/",
		});

		if (isForm) {
			return c.redirect(body.redirect || "/", 302);
		}
		return c.json({ ok: true });
	});
}

import { recoverJSON } from "./utils";

/* ───────── types ───────── */

interface Fact {
	topic: string;
	content: string;
	confidence: number;
}

interface Extracted {
	facts: Fact[];
}

export interface FirepassResult {
	extracted: Extracted | null;
	rawResponse: string | null;
	error?: string;
}

/* ───────── constants ───────── */

export const DEFAULT_FIREWORKS_MODEL = "accounts/fireworks/routers/kimi-k2p6-turbo";
const FIREPASS_ENDPOINT = "https://api.fireworks.ai/inference/v1/chat/completions";
const FIREPASS_TIMEOUT = 30000; // 30s

/**
 * Call the Fireworks Firepass API.
 *
 * @param prompt  — the full prompt text
 * @param apiKey  — Fireworks API key
 * @param model   — model string (default: accounts/fireworks/routers/kimi-k2p6-turbo)
 * @param timeout — millisecond timeout (default: 30_000)
 * @returns  the extracted facts with raw response and optional error
 */
export async function callFirepass(
	prompt: string,
	apiKey: string,
	model = "accounts/fireworks/routers/kimi-k2p6-turbo",
	timeout = FIREPASS_TIMEOUT,
): Promise<FirepassResult> {
	if (!apiKey) {
		return { extracted: { facts: [] }, rawResponse: null };
	}
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		const res = await fetch(FIREPASS_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				temperature: 0.1,
				max_tokens: 4096,
			}),
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) {
			const bodyText = await res.text();
			return {
				extracted: null,
				rawResponse: bodyText,
				error: `HTTP ${res.status}: ${res.statusText}`,
			};
		}
		const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		const raw = data.choices?.[0]?.message?.content ?? "";
		const extracted = recoverJSON(raw);
		return { extracted, rawResponse: raw };
	} catch (err) {
		return {
			extracted: null,
			rawResponse: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

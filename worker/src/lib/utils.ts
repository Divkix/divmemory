/* ───────── helpers: JSON recovery from LLM responses ───────── */

interface Fact {
	topic: string;
	content: string;
	confidence: number;
}

interface Extracted {
	facts: Fact[];
}

export function recoverJSON(raw: string): Extracted | null {
	if (!raw) return null;

	// Stage 1: strip markdown fences and try clean JSON.parse
	const trimmed = raw.replace(/^```json\s*/im, "").replace(/\s*```$/im, "");
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (isExtracted(parsed)) return parsed;
	} catch {
		/* continue */
	}

	// Stage 2: extract valid `{ ... }` objects from the raw text
	const objects: unknown[] = [];
	const re = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: safe loop
	while ((m = re.exec(raw)) !== null) {
		try {
			const v = JSON.parse(m[0]) as unknown;
			objects.push(v);
		} catch {
			/* skip malformed */
		}
	}

	// Try wrapping objects into a facts array
	if (objects.length > 0) {
		return { facts: objects.filter(isFact) };
	}

	return null;
}

function isFact(v: unknown): v is Fact {
	if (!v || typeof v !== "object") return false;
	const f = v as Record<string, unknown>;
	return (
		typeof f.topic === "string" && typeof f.content === "string" && typeof f.confidence === "number"
	);
}

function isExtracted(v: unknown): v is Extracted {
	if (!v || typeof v !== "object") return false;
	const e = v as Record<string, unknown>;
	return Array.isArray(e.facts) && e.facts.every(isFact);
}

/* ───────── helpers: Jaccard similarity (token overlap) ───────── */

function tokenize(text: string): Set<string> {
	const words = text
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ") // keep CJK chars
		.split(/\s+/)
		.filter((w) => w.length > 0);
	return new Set(words);
}

export function jaccardSimilarity(a: string, b: string): number {
	if (!a.trim() || !b.trim()) return 0;
	const sa = tokenize(a);
	const sb = tokenize(b);
	if (sa.size === 0 || sb.size === 0) return 0;
	let intersection = 0;
	for (const w of sa) {
		if (sb.has(w)) intersection++;
	}
	const union = sa.size + sb.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

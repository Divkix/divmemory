export type { DbLike } from "../lib/db";

export interface MemoryRow {
	id: string;
	projectId: string;
	sourceSession: string;
	topic: string | null;
	content: string | null;
	confidence: number | null;
	curated: number | null;
	consolidated: number | null;
	status: string | null;
	createdAt: string | null;
	updatedAt: string | null;
}

export interface SessionRow {
	id: string;
	projectId: string;
	source: string | null;
	rawText: string | null;
	consolidated: number | null;
	extractionError: string | null;
	tokenCount: number | null;
	metadata: string | null;
	createdAt: string | null;
}

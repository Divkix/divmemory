export interface TopicDef {
	id: string;
	label: string;
	order: number;
}

export const TOPICS: readonly TopicDef[] = [
	{ id: "project_context", label: "Project Context", order: 0 },
	{ id: "decisions", label: "Recent Decisions", order: 1 },
	{ id: "issues", label: "Known Issues / Watch Out", order: 2 },
	{ id: "preferences", label: "Your Preferences", order: 3 },
	{ id: "general", label: "General", order: 4 },
] as const;

export const VALID_TOPICS = TOPICS.map((t) => t.id);

export const TOPIC_ORDER = TOPICS.map((t) => t.id);

export const TOPIC_LABELS: Record<string, string> = Object.fromEntries(
	TOPICS.map((t) => [t.id, t.label]),
);

export function isValidTopic(topic: string): topic is TopicDef["id"] {
	return VALID_TOPICS.includes(topic as TopicDef["id"]);
}

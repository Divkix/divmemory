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

export type TopicId = (typeof TOPICS)[number]["id"];

export const VALID_TOPICS: readonly TopicId[] = TOPICS.map((t) => t.id);

export const TOPIC_ORDER: readonly TopicId[] = TOPICS.map((t) => t.id);

export const TOPIC_LABELS: Record<TopicId, string> = Object.fromEntries(
	TOPICS.map((t) => [t.id, t.label]),
) as Record<TopicId, string>;

export function isValidTopic(topic: string): topic is TopicId {
	return VALID_TOPICS.includes(topic as TopicId);
}

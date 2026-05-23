export interface TopicDef {
	id: string;
	label: string;
	order: number;
}

export const TOPICS = [
	{ id: "project_context", label: "Project Context", order: 0 },
	{ id: "decisions", label: "Recent Decisions", order: 1 },
	{ id: "issues", label: "Known Issues / Watch Out", order: 2 },
	{ id: "preferences", label: "Your Preferences", order: 3 },
	{ id: "general", label: "General", order: 4 },
] as const satisfies readonly TopicDef[];

export type TopicId = (typeof TOPICS)[number]["id"];

export const VALID_TOPICS = TOPICS.map((t) => t.id) as unknown as readonly TopicId[];

export const TOPIC_ORDER = TOPICS.map((t) => t.id) as unknown as readonly TopicId[];

export const TOPIC_LABELS = Object.fromEntries(TOPICS.map((t) => [t.id, t.label])) as Record<
	TopicId,
	string
>;

/** Topic for cross-project developer preferences stored under {@link GLOBAL_PROJECT_ID}. */
export const PREFERENCES_TOPIC = "preferences" as const satisfies TopicId;

export function isValidTopic(topic: string): topic is TopicId {
	return VALID_TOPICS.includes(topic as TopicId);
}

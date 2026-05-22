export function getProjectId(cwd: string): Promise<string>;
export function extractConversation(jsonlContent: string): string;
export function processSessionStart(
	stdinData: string,
	deps?: {
		stderr?: (s: string) => void;
		stdout?: (s: string) => void;
		fetch?: (url: string, init: RequestInit) => Promise<Response>;
	},
): Promise<{ exitCode: number }>;
export function processSessionEnd(
	stdinData: string,
	deps?: {
		stderr?: (s: string) => void;
		fetch?: (url: string, init: RequestInit) => Promise<Response>;
	},
): Promise<{ exitCode: number }>;

export {
	divmemoryHome,
	getProjectId,
	lookupProjectMapping,
	mappingsPath,
	resolveProjectId,
	writeProjectMapping,
} from "./project-mappings.mjs";
export function extractConversation(jsonlContent: string): string;
export function processSessionEnd(
	stdinData: string,
	deps?: {
		stderr?: (s: string) => void;
		stdout?: (s: string) => void;
		fetch?: (url: string, init: RequestInit) => Promise<Response>;
	},
): Promise<{ exitCode: number }>;

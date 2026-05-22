export function divmemoryHome(home?: string): string;
export function mappingsPath(home?: string): string;
export function lookupProjectMapping(
	absolutePath: string,
	options?: { home?: string },
): string | null;
export function normalizeGitRemote(url: string): string;
export function localProjectId(absolutePath: string): string;
export function resolveProjectId(cwd: string, options?: { home?: string }): Promise<string>;
export const getProjectId: typeof resolveProjectId;
export function writeProjectMapping(
	absolutePath: string,
	projectId: string,
	options?: { home?: string },
): Promise<void>;

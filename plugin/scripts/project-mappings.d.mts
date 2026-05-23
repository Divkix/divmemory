export function divmemoryHome(home?: string): string;
export function getProjectName(projectId: string): string;
export function mappingsPath(home?: string): string;
export function encodePath(absolutePath: string): string;
export function lookupProjectMapping(
	absolutePath: string,
	options?: { home?: string },
): string | null;
export function getAllMappingKeys(options?: { home?: string }): string[];
export function normalizeGitRemote(url: string): string;
export function hasGitOrigin(cwd?: string): Promise<boolean>;
export function localProjectId(absolutePath: string): string;
export function resolveProjectId(cwd?: string, options?: { home?: string }): Promise<string>;
export const getProjectId: typeof resolveProjectId;
export function writeProjectMapping(
	absolutePath: string,
	projectId: string,
	options?: { home?: string },
): Promise<void>;

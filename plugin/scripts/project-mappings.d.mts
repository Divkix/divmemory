export function divmemoryHome(home?: string): string;
export function mappingsPath(home?: string): string;
export function writeProjectMapping(
	absolutePath: string,
	projectId: string,
	options?: { home?: string },
): Promise<void>;

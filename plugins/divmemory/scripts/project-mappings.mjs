// Local wrapper that re-exports from @divmemory/plugin for plugin-only installs.
// When installed standalone, the parent package may not exist; this file
// provides a local fallback that imports from the sibling plugin workspace.
export {
	divmemoryHome,
	encodePath,
	getAllMappingKeys,
	getProjectId,
	getProjectName,
	hasGitOrigin,
	localProjectId,
	lookupProjectMapping,
	mappingsPath,
	normalizeGitRemote,
	resolveProjectId,
	writeProjectMapping,
} from "../../../plugin/scripts/project-mappings.mjs";

export { getProjectId, processSessionStart } from "./runtime.mjs";

import { processSessionStart } from "./runtime.mjs";

async function main() {
	let stdinData = "";
	try {
		for await (const chunk of process.stdin) {
			stdinData += chunk;
		}
	} catch (err) {
		console.error("[divmemory] Failed to read stdin:", err.message);
		process.exit(0);
	}
	await processSessionStart(stdinData);
	process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}

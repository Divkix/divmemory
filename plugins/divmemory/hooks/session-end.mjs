export { extractConversation, getProjectId, processSessionEnd } from "./runtime.mjs";

import { processSessionEnd } from "./runtime.mjs";

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
	await processSessionEnd(stdinData);
	process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}

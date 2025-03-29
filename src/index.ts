import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";

async function main() {
	const transport = new StdioServerTransport();

	const server = createMcpServer();
	await server.connect(transport);

	console.error("Appium MCP Server running on stdio");
}

main().catch((error) => {
	console.error("Fatal error in main():", error);
	error("Fatal error in main(): " + JSON.stringify(error.stack));
	process.exit(1);
});

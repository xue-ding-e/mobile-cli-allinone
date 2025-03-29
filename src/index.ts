import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { appendFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { remote } from 'webdriverio';

const capabilities = {
	platformName: 'Android',
	'appium:automationName': 'UiAutomator2',
	'appium:deviceName': 'Android',
};

const wdOpts = {
	hostname: process.env.APPIUM_HOST || 'localhost',
	port: parseInt(process.env.APPIUM_PORT || "4723", 10) || 4723,
	// logLevel: 'info',
	capabilities,
};

let driver: WebdriverIO.Browser;

const server = new McpServer({
	name: "appium-mcp",
	version: "1.0.0",
	capabilities: {
		resources: {},
		tools: {},
	},
});

const log = (text: string) => {
	appendFileSync('/tmp/log.txt', `${text}\n`);
};

server.tool(
	"list-apps-on-device",
	"List all apps on device",
	{},
	async ({}) => {
		log(`gilm: listing apps on device`);
		const result = execSync(`adb shell pm list packages`)
			.toString()
			.split("\n")
			.filter(line => line.startsWith("package:"))
			.map(line => line.substring("package:".length));
		log(`gilm result: ${result.toString()}`);

		return {
			content: [{ type: 'text', text: `These apps are installed on the device: ${result.join(",")}` }]
		};
	}
);

const resolveLaunchableActivity = async (packageName: string): Promise<string> => {
	const result1 = execSync(`adb shell cmd package resolve-activity ${packageName}`)
		.toString()
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.startsWith("name="))
		.map(line => line.substring("name=".length));

	if (result1.length !== 1) {
		throw new Error(`Error launching app: ${packageName}, got too many entries with 'name': ${result1.join(",")}`);
	}

	return result1[0];
}

server.tool(
	"launch-app",
	"Launch an app on mobile device",
	{
		packageName: z.string().describe("The package name of the app to launch"),
	},
	async ({ packageName }) => {
		log(`gilm launching packageName: "${packageName}"`);
		try {
			// FIXME: use appium or monkey for this
			const activity = await resolveLaunchableActivity(packageName);
			log(`gilm: starting activity: ${packageName}, ${activity}`);
			await driver.startActivity(packageName, activity);

			return {
				content: [{ type: 'text', text: `Successfully launched app ${packageName}` }]
			};
		} catch (error: any) {
			log(`gilm: error: ${JSON.stringify(error.stack)}`);
			return {
				content: [{ type: 'text', text: `Error launching settings app: ${error.message}` }],
				isError: true
			};
		}
	}
);

server.tool(
	"click-on-screen-at-coordinates",
	"Click on the screen at given x,y coordinates",
	{
		x: z.number().describe("The x coordinate to click"),
		y: z.number().describe("The y coordinate to click"),
	},
	async ({ x, y }) => {
		log(`gilm: clicking on screen at coordinates: ${x}, ${y}`);
		try {
			execSync(`adb shell input tap ${x} ${y}`);

			return {
				content: [{ type: 'text', text: `Successfully clicked on screen at coordinates: ${x}, ${y}` }]
			};
		} catch (error: any) {
			log(`gilm: error: ${JSON.stringify(error.stack)}`);
			return {
				content: [{ type: 'text', text: `Failed to click on screen at coordinates: ${x}, ${y}` }],
				isError: true
			};
		}
	}
);

server.tool(
	"click-element",
	"Click on an element on device",
	{
		text: z.string().describe("Text of the element to click"),
	},
	async ({ text }) => {
		log(`gilm: clicking: ${text}`);
		try {
			const element = await driver.$(`//*[contains(@text, "${text}")]`);
			log(`gilm: found element: ${JSON.stringify(element)}`);

			if (!element) {
				log("gilm: element not found");

				return {
					content: [{ type: 'text', text: `Element with text "${text}" not found` }],
					isError: true
				};
			}

			await element.click();

			return {
				content: [{ type: 'text', text: `Successfully clicked on element with text "${text}"` }]
			};
		} catch (error: any) {
			return {
				content: [{ type: 'text', text: `Element with text "${text}" not found` }],
				isError: true
			};
		}
	}
);


server.tool(
	"press-back-button",
	"Press the back button on device",
	{},
	async ({}) => {
		log(`gilm: clicking: back`);
		try {
			await driver.back();
			return {
				content: [{ type: 'text', text: `Successfully pressed the back button` }]
			};
		} catch (error: any) {
			return {
				content: [{ type: 'text', text: `Failed to press the back button` }],
				isError: true
			};
		}
	}
);

server.tool(
	"open-url",
	"Open a URL in browser on device",
	{
		url: z.string().describe("The URL to open"),
	},
	async ({ url }) => {
		log(`gilm: opening URL: ${url}`);
		try {
			await driver.url(url);
			return {
				content: [{ type: 'text', text: `Successfully opened URL: ${url}` }]
			};
		} catch (error: any) {
			return {
				content: [{ type: 'text', text: `Failed to open URL: ${url}` }],
				isError: true,
			};
		}
	}
);

server.tool(
	"swipe-down-on-screen",
	"Swipe down on the screen",
	{},
	async ({}) => {
		log(`gilm: swiping down on screen`);
		try {
			await driver.performActions([{
				type: 'pointer',
				id: 'finger1',
				parameters: { pointerType: 'touch' },
				actions: [
					{ type: 'pointerMove', duration: 0, x: 200, y: 800 }, // start point
					{ type: 'pointerDown', button: 0 },
					{ type: 'pause', duration: 100 },
					{ type: 'pointerMove', duration: 500, x: 200, y: 300 }, // swipe up
					{ type: 'pointerUp', button: 0 }
				]
			}]);

			await driver.releaseActions();

			return {
				content: [{ type: 'text', text: `Successfully swiped down on screen` }]
			};
		} catch (error: any) {
			return {
				content: [{ type: 'text', text: `Failed to swipe down on screen` }],
				isError: true,
			}
		}
	}
);

server.tool(
	"swipe-down-until-element-is-visible",
	"Swipe down on the screen until an element is visible",
	{
		text: z.string().describe("The text of the element to swipe down until"),
	},
	async ({ text }) => {
		log(`gilm: swiping down on screen until element is visible: ${text}`);

		try {
			await driver.swipe({
				direction: 'down',
				duration: 1500,
				percent: 0.95, // Using 95% of the screen to avoid triggering OS features
				scrollableElement: await driver.$(`//*[contains(@text, "${text}")]`),
			});

			return {
				content: [{ type: 'text', text: `Successfully swiped down on screen until element is visible: ${text}` }]
			}

		} catch (error: any) {
			log(`gilm: error: ${JSON.stringify(error.stack)}`);
			return {
				content: [{ type: 'text', text: `Failed to swipe down on screen` }],
				isError: true,
			}
		}
	}
);

server.tool(
	'type-text',
	'Type text into an element',
	{
		text: z.string().describe('The text to type'),
	},
	async ({ text }) => {
		log(`gilm: typing text: ${text}`);

		try {
			await driver.keys(text);
			return {
				content: [{ type: 'text', text: `Successfully typed text: ${text}` }]
			};
		} catch (error: any) {
			return {
				content: [{ type: 'text', text: `Failed to type text: ${text}` }],
				isError: true,
			};
		}
	}
);

server.tool(
	'take-app-screenshot',
	'Take a screenshot of the screen of the mobile device',
	{},
	async ({}) => {
		try {
			log(`gilm: taking app screenshot`);
			const screenshot64 = await driver.takeScreenshot();
			writeFileSync('/tmp/screenshot.png', screenshot64);
			return {
				content: [{ type: 'image', data: screenshot64, mimeType: 'image/png' }]
			};
		} catch (error: any) {
			log(`gilm: error: ${JSON.stringify(error.stack)}`);
			return {
				content: [{ type: 'text', text: `Failed to take app screenshot` }],
				isError: true,
			};
		}
	}
);

async function main() {
	driver = await remote(wdOpts);

	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("Appium MCP Server running on stdio");
}

main().catch((error) => {
	console.error("Fatal error in main():", error);
	process.exit(1);
});
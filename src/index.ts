import { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, ZodRawShape } from "zod";

import { appendFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { remote } from 'webdriverio';

const writeLog = (message: string) => {
	if (process.env.LOG_FILE) {
		const logfile = process.env.LOG_FILE;
		const timestamp = new Date().toISOString();
		const levelStr = 'INFO';
		const logMessage = `[${timestamp}] ${levelStr} ${message}`;
		appendFileSync(logfile, logMessage + '\n');
		console.error(logMessage)
	}
};

const trace = (message: string) => {
	writeLog(message);
};

const error = (message: string) => {
	writeLog(message);
};

const createAppiumDriver = async (): Promise<WebdriverIO.Browser> => {
	const capabilities = {
		// platformName: 'iOS',
		// 'appium:platformVersion': '18.3',
		platformName: 'Android',
		// 'appium:automationName': 'XCUITest',
		'appium:automationName': 'UiAutomator2',
	};

	const wdOpts = {
		hostname: process.env.APPIUM_HOST || 'localhost',
		port: parseInt(process.env.APPIUM_PORT || "4723", 10) || 4723,
		capabilities,
	};

	trace("Connecting to Appium server with capabilities: " + JSON.stringify(capabilities));
	const driver = await remote(wdOpts);
	trace("Connected to Appium server with driver: " + JSON.stringify(driver));
	return driver;
};

let driver: WebdriverIO.Browser;

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

const createMcpServer = async (): Promise<McpServer> => {

	let driver: WebdriverIO.Browser;

	createAppiumDriver().then(d => driver = d);

	const server = new McpServer({
		name: "appium-mcp",
		version: "1.0.0",
		capabilities: {
			resources: {},
			tools: {},
		},
	});

	const tool = (name: string, description: string, paramsSchema: ZodRawShape, cb: (args: ZodRawShape) => Promise<string>) => {
		const wrappedCb = async (args: ZodRawShape): Promise<CallToolResult> => {
			try {
				trace(`Invoking tool: ${description}`);
				const response = await cb(args);
				trace(`Tool ${description} returned: ${response}`);
				return {
					content: [{ type: 'text', text: response }],
				};
			} catch (error: any) {
				return {
					content: [{ type: 'text', text: `Error: ${error.message}` }],
					isError: true,
				};
			}
		};

		server.tool(name, description, paramsSchema, (args) => wrappedCb(args));
	};

	tool(
		"list-apps-on-device",
		"List all apps on device",
		{},
		async ({}) => {
			const result = execSync(`adb shell pm list packages`)
				.toString()
				.split("\n")
				.filter(line => line.startsWith("package:"))
				.map(line => line.substring("package:".length));

			return `Found this packages on device: ${result.join(",")}`;
		}
	);

	server.tool(
		"launch-app",
		"Launch an app on mobile device",
		{
			packageName: z.string().describe("The package name of the app to launch"),
		},
		async ({ packageName }) => {
			trace(`Launching packageName: "${packageName}"`);
			try {
				// FIXME: use appium or monkey for this
				const activity = await resolveLaunchableActivity(packageName);
				trace(`Found launchable activity: ${packageName}/${activity}`);

				await driver.startActivity(packageName, activity);

				return {
					content: [{ type: 'text', text: `Launched app ${packageName}` }]
				};
			} catch (error: any) {
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
			trace(`Clicking on screen at coordinates ${x},${y}`);
			try {
				execSync(`adb shell input tap ${x} ${y}`);

				return {
					content: [{ type: 'text', text: `Clicked on screen at coordinates: ${x}, ${y}` }]
				};
			} catch (error: any) {
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
			try {
				trace(`Clicking on element "${text}"`);
				const element = await driver.$(`//*[contains(@text, "${text}")]`);

				if (!element) {
					trace("Element not found on screen");
					return {
						content: [{ type: 'text', text: `Element with text "${text}" not found` }],
						isError: true
					};
				}

				await element.click();

				return {
					content: [{ type: 'text', text: `Clicked on element with text "${text}"` }]
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
			try {
				trace("Pressing back button");
				await driver.back();

				return {
					content: [{ type: 'text', text: `Pressed the back button` }]
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
			try {
				trace(`Opening URL: ${url}`);
				await driver.url(url);
				return {
					content: [{ type: 'text', text: `Opened URL: ${url}` }]
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
			try {
				const centerX = 200;
				await driver.performActions([{
					type: 'pointer',
					id: 'finger1',
					parameters: { pointerType: 'touch' },
					actions: [
						{ type: 'pointerMove', duration: 0, x: centerX, y: 900 }, // start point
						{ type: 'pointerDown', button: 0 },
						{ type: 'pause', duration: 100 },
						{ type: 'pointerMove', duration: 500, x: centerX, y: 100 }, // swipe up
						{ type: 'pointerUp', button: 0 }
					]
				}]);

				await driver.releaseActions();

				return {
					content: [{ type: 'text', text: `Swiped down on screen` }]
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
			try {
				await driver.swipe({
					direction: 'down',
					duration: 1500,
					percent: 0.95, // Using 95% of the screen to avoid triggering OS features
					scrollableElement: await driver.$(`//*[contains(@text, "${text}")]`),
				});

				return {
					content: [{ type: 'text', text: `Swiped down on screen until element is visible: ${text}` }]
				}

			} catch (error: any) {
				return {
					content: [{ type: 'text', text: `Failed to swipe down on screen` }],
					isError: true,
				}
			}
		}
	);

	server.tool(
		'type-text',
		'Type text into the focused element',
		{
			text: z.string().describe('The text to type'),
		},
		async ({ text }) => {
			try {
				await driver.keys(text);
				return {
					content: [{ type: 'text', text: `Typed text: ${text}` }]
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
		'Take a screenshot of the mobile device',
		{},
		async ({}) => {
			try {
				const screenshot64 = await driver.takeScreenshot();
				writeFileSync('/tmp/screenshot.png', screenshot64);
				return {
					content: [{ type: 'image', data: screenshot64, mimeType: 'image/png' }]
				};
			} catch (error: any) {
				return {
					content: [{ type: 'text', text: `Failed to take app screenshot` }],
					isError: true,
				};
			}
		}
	);

	return server;
}

async function main() {
	const transport = new StdioServerTransport();

	const server = await createMcpServer();
	await server.connect(transport);

	console.error("Appium MCP Server running on stdio");
}

main().catch((error) => {
	console.error("Fatal error in main():", error);
	error("Fatal error in main(): " + JSON.stringify(error.stack));
	process.exit(1);
});

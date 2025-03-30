import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types";

import { execSync } from "child_process";
import { error, trace } from "./logger";
import { z, ZodRawShape, ZodTypeAny } from "zod";
import { getElementsOnScreen, getScreenSize, listApps, swipe, takeScreenshot } from "./android";

import sharp from "sharp";

const getAgentVersion = (): string => {
	const json = require("../package.json");
	return json.version;
};

export const createMcpServer = (): McpServer => {

	const server = new McpServer({
		name: "mobile-mcp",
		version: getAgentVersion(),
		capabilities: {
			resources: {},
			tools: {},
		},
	});

	const tool = (name: string, description: string, paramsSchema: ZodRawShape, cb: (args: z.objectOutputType<ZodRawShape, ZodTypeAny>) => Promise<string>) => {
		const wrappedCb = async (args: ZodRawShape): Promise<CallToolResult> => {
			try {
				trace(`Invoking ${name} with args: ${JSON.stringify(args)}`);
				const response = await cb(args);
				trace(`=> ${response}`);
				return {
					content: [{ type: "text", text: response }],
				};
			} catch (error: any) {
				trace(`Tool '${description}' failed: ${error.message} stack: ${error.stack}`);
				return {
					content: [{ type: "text", text: `Error: ${error.message}` }],
					isError: true,
				};
			}
		};

		server.tool(name, description, paramsSchema, args => wrappedCb(args));
	};

	tool(
		"list-apps-on-device",
		"List all apps on device",
		{},
		async ({}) => {
			/*
			const result = execSync(`adb shell pm list packages`)
				.toString()
				.split("\n")
				.filter(line => line.startsWith("package:"))
				.map(line => line.substring("package:".length));
			*/

			const result = listApps();
			return `Found these packages on device: ${result.join(",")}`;
		}
	);

	tool(
		"launch-app",
		"Launch an app on mobile device",
		{
			packageName: z.string().describe("The package name of the app to launch"),
		},
		async ({ packageName }) => {
			execSync(`adb shell monkey -p "${packageName}" -c android.intent.category.LAUNCHER 1`);
			return `Launched app ${packageName}`;
		}
	);

	tool(
		"get-screen-size",
		"Get the screen size of the mobile device in pixels",
		{},
		async ({}) => {
			const screenSize = getScreenSize();
			return `Screen size is ${screenSize[0]}x${screenSize[1]} pixels`;
		}
	);

	tool(
		"click-on-screen-at-coordinates",
		"Click on the screen at given x,y coordinates",
		{
			x: z.number().describe("The x coordinate to click between 0 and 1"),
			y: z.number().describe("The y coordinate to click between 0 and 1"),
		},
		async ({ x, y }) => {
			const screenSize = getScreenSize();
			const x0 = Math.floor(screenSize[0] * x);
			const y0 = Math.floor(screenSize[1] * y);
			execSync(`adb shell input tap ${x0} ${y0}`);
			return `Clicked on screen at coordinates: ${x}, ${y}`;
		}
	);

	tool(
		"list-elements-on-screen",
		"List elements on screen and their coordinates, based on text or accessibility label",
		{
		},
		async ({}) => {
			const elements = getElementsOnScreen();
			return `Found these elements on screen: ${JSON.stringify(elements)}`;
		}
	);

	tool(
		"press-button",
		"Press a button on device",
		{
			button: z.string().describe("The button to press. Supported buttons: KEYCODE_BACK, KEYCODE_HOME, KEYCODE_MENU, KEYCODE_VOLUME_UP, KEYCODE_VOLUME_DOWN, KEYCODE_ENTER"),
		},
		async ({ button }) => {
			execSync(`adb shell input keyevent ${button}`);
			return `Pressed the button: ${button}`;
		}
	);

	tool(
		"open-url",
		"Open a URL in browser on device",
		{
			url: z.string().describe("The URL to open"),
		},
		async ({ url }) => {
			execSync(`adb shell am start -a android.intent.action.VIEW -d "${url}"`);
			return `Opened URL: ${url}`;
		}
	);

	tool(
		"swipe-on-screen",
		"Swipe on the screen",
		{
			direction: z.enum(["up", "down"]).describe("The direction to swipe"),
		},
		async ({ direction }) => {
			swipe(direction);
			return `Swiped ${direction} on screen`;
		}
	);

	tool(
		"type-text",
		"Type text into the focused element",
		{
			text: z.string().describe("The text to type"),
		},
		async ({ text }) => {
			const _text = text.replace(/ /g, "\\ ");
			execSync(`adb shell input text "${_text}"`);
			return `Typed text: ${text}`;
		}
	);

	server.tool(
		"take-device-screenshot",
		"Take a screenshot of the mobile device",
		{},
		async ({}) => {
			try {
				const screenshot = await takeScreenshot();

				// Scale down the screenshot by 50%
				const image = sharp(screenshot);
				const metadata = await image.metadata();
				if (!metadata.width) {
					throw new Error("Failed to get screenshot metadata");
				}

				const resizedScreenshot = await image
					.resize(Math.floor(metadata.width / 2))
					.jpeg({ quality: 75 })
					.toBuffer();

				// debug:
				// writeFileSync('/tmp/screenshot.png', screenshot);
				// writeFileSync('/tmp/screenshot-scaled.jpg', resizedScreenshot);

				const screenshot64 = resizedScreenshot.toString("base64");
				trace(`Screenshot taken: ${screenshot.length} bytes`);

				return {
					content: [{ type: "image", data: screenshot64, mimeType: "image/jpeg" }]
				};
			} catch (err: any) {
				error(`Error taking screenshot: ${err.message} ${err.stack}`);
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					isError: true,
				};
			}
		}
	);

	return server;
};

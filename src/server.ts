import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { error, trace } from './logger';
import { z, ZodRawShape, ZodTypeAny } from "zod";
import { getElementCoordinates, getScreenSize, resolveLaunchableActivities, swipe, takeScreenshot } from './android';

import sharp from 'sharp';

const getAgentVersion = (): string => {
        const json = require('../package.json');
        return json.version;
}

export const createMcpServer = (): McpServer => {

        const server = new McpServer({
                name: "appium-mcp",
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
                                        content: [{ type: 'text', text: response }],
                                };
                        } catch (error: any) {
                                trace(`Tool '${description}' failed: ${error.message} stack: ${error.stack}`);
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
                "find-element-on-screen",
                "Find coordinates of an element on device by text",
                {
                        text: z.string().describe("Text of the element to find"),
                },
                async ({ text }) => {
                        const coordinates = getElementCoordinates(text);
                        const screenSize = getScreenSize();
                        const x = coordinates.x / screenSize[0];
                        const y = coordinates.y / screenSize[1];
                        return `Found element with text "${text}" at coordinates: ${x},${y}`;
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
                "swipe-down-on-screen",
                "Swipe down on the screen",
                {},
                async ({}) => {
                        swipe("down");
                        return `Swiped down on screen`;
                }
        );

        tool(
                "swipe-down-until-element-is-visible",
                "Swipe down on the screen until an element is visible",
                {
                        text: z.string().describe("The text of the element to swipe down until"),
                },
                async ({ text }) => {
                        let found = false;
                        for (let i = 0; i < 10; i++) {
                                try {
                                        const coordinates = getElementCoordinates(text);
                                        // element is visible on screen, break
                                        found = true;
                                        break;
                                } catch (error: any) {
                                        trace(`Element with text "${text}" not found on screen, retrying...`);
                                        swipe("down");
                                }
                        }

                        if (!found) {
                                throw new Error(`Element with text "${text}" not found on screen after scrolling down 10 times`);
                        }

                        return `Swiped down on screen until element is visible: ${text}`;
                }
        );

        tool(
                'type-text',
                'Type text into the focused element',
                {
                        text: z.string().describe('The text to type'),
                },
                async ({ text }) => {
                        const _text = text.replace(/ /g, '\\ ');
                        execSync(`adb shell input text "${_text}"`);
                        return `Typed text: ${text}`;
                }
        );

        server.tool(
                'take-device-screenshot',
                'Take a screenshot of the mobile device',
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

                                const screenshot64 = resizedScreenshot.toString('base64');
                                trace(`Screenshot taken: ${screenshot.length} bytes`);

                                return {
                                        content: [{ type: 'image', data: screenshot64, mimeType: 'image/jpeg' }]
                                };
                        } catch (err: any) {
                                error(`Error taking screenshot: ${err.message} ${err.stack}`);
                                return {
                                        content: [{ type: 'text', text: `Error: ${err.message}` }],
                                        isError: true,
                                };
                        }
                }
        );

        return server;
}
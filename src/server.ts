import { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { remote } from 'webdriverio';
import { trace } from './logger';
import { z, ZodRawShape, ZodTypeAny } from "zod";
import { resolveLaunchableActivities } from './android';

enum APPIUM_SERVER_STATE {
        STOPPED,
        STARTING,
        STARTED,
        STOPPING,
}

let appiumServerState: APPIUM_SERVER_STATE = APPIUM_SERVER_STATE.STOPPED;

const isSimulatorRunning = () => {
}

const createAppiumDriver = async (): Promise<WebdriverIO.Browser> => {

        const capabilities = {
                platformName: 'Android',
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

const getAgentVersion = (): string => {
        const text = readFileSync('./package.json');
        const json = JSON.parse(text.toString());
        return json.version;
}

export const createMcpServer = (): McpServer => {

        let driver: WebdriverIO.Browser;

        appiumServerState = APPIUM_SERVER_STATE.STARTING;
        createAppiumDriver().then((d) => {
                driver = d;
                appiumServerState = APPIUM_SERVER_STATE.STARTED;
        });

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
                                trace(`Invoking tool: ${description}`);
                                const response = await cb(args);
                                trace(`Tool '${description}' returned: ${response}`);
                                return {
                                        content: [{ type: 'text', text: response }],
                                };
                        } catch (error: any) {
                                trace(`Tool '${description}' failed: ${error.message}`);
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
                        const activities = await resolveLaunchableActivities(packageName);
                        trace(`Found launchable activities: ${activities.join(",")}`);

                        if (activities.length === 0) {
                                throw new Error(`No launchable activities found for package ${packageName}`);
                        }

                        if (activities.length > 1) {
                                trace(`Found multiple launchable activities for package ${packageName}, please specify the activity to launch from this list: ${activities.join(",")}`);
                        }

                        execSync(`adb shell am start -n ${packageName}/${activities[0]}`);
                        return `Launched app ${packageName}`;
                }
        );

        tool(
                "click-on-screen-at-coordinates",
                "Click on the screen at given x,y coordinates",
                {
                        x: z.number().describe("The x coordinate to click"),
                        y: z.number().describe("The y coordinate to click"),
                },
                async ({ x, y }) => {
                        execSync(`adb shell input tap ${x} ${y}`);
                        return `Clicked on screen at coordinates: ${x}, ${y}`;
                }
        );

        tool(
                "click-element",
                "Click on an element on device",
                {
                        text: z.string().describe("Text of the element to click"),
                },
                async ({ text }) => {
                        const element = await driver.$(`//*[contains(@text, "${text}")]`);

                        if (!element) {
                                trace("Element not found on screen");
                                throw new Error(`Element with text "${text}" not found`);
                        }

                        await element.click();
                        return `Clicked on element with text "${text}"`;
                }
        );

        tool(
                "press-back-button",
                "Press the back button on device",
                {},
                async ({}) => {
                        execSync(`adb shell input keyevent 4`);
                        return `Pressed the back button`;
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
                        const screenSize = await driver.getWindowSize();
                        const centerX = screenSize.width / 2;
                        const y0 = screenSize.height * 0.90;
                        const y1 = screenSize.height * 0.10;

                        await driver.performActions([{
                                type: 'pointer',
                                id: 'finger1',
                                parameters: { pointerType: 'touch' },
                                actions: [
                                        { type: 'pointerMove', duration: 0, x: centerX, y: y1 }, // start point
                                        { type: 'pointerDown', button: 0 },
                                        { type: 'pause', duration: 100 },
                                        { type: 'pointerMove', duration: 500, x: centerX, y: y0 }, // swipe up
                                        { type: 'pointerUp', button: 0 }
                                ]
                        }]);

                        await driver.releaseActions();
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
                        await driver.swipe({
                                direction: 'down',
                                duration: 1500,
                                percent: 0.90, // Using 90% of the screen to avoid triggering OS features
                                scrollableElement: await driver.$(`//*[contains(@text, "${text}")]`),
                        });

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
                'take-app-screenshot',
                'Take a screenshot of the mobile device',
                {},
                async ({}) => {
                        try {
                                const screenshot = execSync(`adb exec-out screencap -p`);
                                writeFileSync('/tmp/screenshot.png', screenshot);
                                
                                const screenshot64 = screenshot.toString('base64');
                                trace(`Screenshot taken: ${screenshot.length} bytes`);

                                return {
                                        content: [{ type: 'image', data: screenshot64, mimeType: 'image/png' }]
                                };
                        } catch (error: any) {
                                error(`Error taking screenshot: ${error.message} ${error.stack}`);
                                return {
                                        content: [{ type: 'text', text: `Error: ${error.message}` }],
                                        isError: true,
                                };
                        }
                }
        );

        return server;
}
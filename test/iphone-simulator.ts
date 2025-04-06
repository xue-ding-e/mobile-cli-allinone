import assert from "assert";

import sharp from "sharp";
import { SimctlManager } from "../src/iphone-simulator";

describe("ios", () => {

	const manager = new SimctlManager();
	const bootedSimulators = manager.listBootedSimulators();
	assert.ok(bootedSimulators.length === 1, "should have exactly one booted simulator");
	const simctl = manager.getSimulator(bootedSimulators[0].uuid);

	it("should be able to get the screen size", async () => {
		const screenSize = await simctl.getScreenSize();
		assert.ok(screenSize.width > 256);
		assert.ok(screenSize.height > 256);
		assert.equal(Object.keys(screenSize).length, 2, "screenSize should have exactly 2 properties");
	});

	it("should be able to get screenshot", async () => {
		const screenshot = await simctl.getScreenshot();
		assert.ok(screenshot.length > 64 * 1024);

		// must be a valid png image that matches the screen size
		const image = sharp(screenshot);
		const metadata = await image.metadata();
		const screenSize = await simctl.getScreenSize();
		assert.equal(metadata.width, screenSize.width);
		assert.equal(metadata.height, screenSize.height);
	});

	it("should be able to open url", async () => {
		// simply checking thato openurl with https:// launches safari
		await simctl.openUrl("https://www.example.com");

		const elements = await simctl.getElementsOnScreen();
		assert.ok(elements.length > 0);

		const addressBar = elements.find(element => element.type === "TextField" && element.name === "TabBarItemTitle" && element.label === "Address");
		assert.ok(addressBar !== undefined, "should have address bar");
	}).timeout(10000);

	it("should be able to list apps", async () => {
		const apps = await simctl.listApps();
		assert.ok(apps.includes("com.apple.mobilesafari"));
		assert.ok(apps.includes("com.apple.reminders"));
		assert.ok(apps.includes("com.apple.Preferences"));
	});

	it("should be able to get elements on screen", async () => {
		await simctl.pressButton("HOME");
		await new Promise(resolve => setTimeout(resolve, 2000));

		const elements = await simctl.getElementsOnScreen();
		assert.ok(elements.length > 0);

		// must have News app in home screen
		const element = elements.find(e => e.type === "Icon" && e.label === "News");
		assert.ok(element !== undefined, "should have News app in home screen");
	}).timeout(10000);

	it("should be able to launch and terminate app", async () => {
		// make sure app is not running before launching
		await simctl.launchApp("com.apple.Preferences");
		await simctl.terminateApp("com.apple.Preferences");

		await simctl.launchApp("com.apple.Preferences");
		await new Promise(resolve => setTimeout(resolve, 2000));
		const elements = await simctl.getElementsOnScreen();

		const buttons = elements.filter(e => e.type === "Button").map(e => e.label);
		assert.ok(buttons.includes("General"));
		assert.ok(buttons.includes("Accessibility"));

		// make sure app is terminated
		await simctl.terminateApp("com.apple.Preferences");
		const elements2 = await simctl.getElementsOnScreen();
		const buttons2 = elements2.filter(e => e.type === "Button").map(e => e.label);
		assert.ok(!buttons2.includes("General"));
	}).timeout(20000);
});

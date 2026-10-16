import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFlow } from "../src/flows";
import { WebviewManager } from "../src/webview";
import { IosManager } from "../src/ios";
import { listIosDevices } from "../src/cli-platform";

const cli = path.resolve(__dirname, "../lib/cli.js");
let home: string;
test.beforeAll(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-ios-test-"));
});
test.afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
	encoding: "utf8", timeout: 10000,
	env: { ...process.env, HOME: home, USERPROFILE: home, GO_IOS_PATH: path.join(home, "missing-ios") },
});

test("iOS capability discovery works without devices or tools", () => {
	const result = run("capabilities", "--platform", "ios");
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({ platform: "ios", webview: false, record: false });
});
test("iOS missing go-ios reports actionable error rather than falling back to ADB", () => {
	const result = run("elements", "--platform", "ios");
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("GO_IOS_PATH");
	expect(result.stdout).toBe("");
});
for (const command of ["wv-pages", "wv-eval", "record", "wake", "power-state", "connect"]) {
	test(`iOS ${command} is rejected before device access`, () => {
		const result = run(command, "example", "--platform", "ios", "--device", "stub-phone");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("不支持");
		expect(result.stdout).toBe("");
	});
}
test("iOS selection persists and eval uses existing IosRobot", () => {
	const selected = run("use", "stub-phone", "--platform", "ios");
	expect(selected.status).toBe(0);
	expect(JSON.parse(selected.stdout)).toMatchObject({ platform: "ios", device: "stub-phone" });
	const result = run("eval", "return {platform, device, driver: robot.constructor.name}");
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ platform: "ios", device: "stub-phone", driver: "IosRobot" });
});
for (const op of ["webview_connect", "webview_evaluate", "webview_disconnect", "assert_route", "assert_eval"]) {
	test(`iOS flow blocks ${op} before touching Android webview`, async () => {
		const webview = new Proxy({}, { get: () => { throw new Error("Android webview was touched"); } }) as WebviewManager;
		const result = await runFlow([{ op }], { platform: "ios" as any, defaultDevice: "stub-phone", getRobot: () => { throw new Error("robot accessed"); }, webview });
		expect(result.passed).toBe(false);
		expect(result.results[0].info).toContain("未实现");
	});
}

test("simulator capabilities and routing require no Apple tools", () => {
	const result = run("capabilities", "--platform", "ios-simulator");
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({ platform: "ios-simulator", webview: false });
	const routed = run("eval", "return robot.constructor.name", "--platform", "ios-simulator", "--device", "stub-simulator");
	expect(routed.status).toBe(0);
	expect(JSON.parse(routed.stdout)).toBe("Simctl");
});
test("simulator discovery on non-macOS explains the requirement", () => {
	test.skip(process.platform === "darwin", "macOS has a real simulator discovery path");
	const result = run("devices", "--platform", "ios-simulator");
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("macOS");
});
test("failed iOS flow emits failed results and nonzero CLI status", () => {
	const file = path.join(home, "unsupported.json");
	fs.writeFileSync(file, JSON.stringify([{ op: "assert_eval", expression: "true" }]));
	const result = run("flow-run", file, "--platform", "ios", "--device", "stub-phone");
	expect(result.status).toBe(1);
	expect(JSON.parse(result.stdout).passed).toBe(false);
});
test("flow checks the platform of each overridden device", async () => {
	const inspected: string[] = [];
	const context = {
		platform: "android" as const, defaultDevice: "android-phone",
		getPlatform: (device: string) => {inspected.push(device); return device === "android-phone" ? "android" as const : "ios" as const;},
		getRobot: () => {throw new Error("robot accessed");},
		webview: { evaluate: async () => true } as unknown as WebviewManager,
	};
	const result = await runFlow([{ op: "assert_eval" }, { op: "assert_eval", device: "ios-phone" }], context);
	expect(inspected).toEqual(["android-phone", "ios-phone"]);
	expect(result.results.map(r => r.ok)).toEqual([true, false]);
});


test("CLI iOS discovery uses a bounded ten-second process timeout", () => {
	const installed = IosManager.prototype.isGoIosInstalled;
	const details = IosManager.prototype.listDevicesWithDetails;
	try {
		IosManager.prototype.isGoIosInstalled = () => true;
		IosManager.prototype.listDevicesWithDetails = function() {
			expect((this as unknown as { discoveryTimeout: number }).discoveryTimeout).toBe(10000);
			return [];
		};
		expect(listIosDevices("ios")).toEqual([]);
	} finally {
		IosManager.prototype.isGoIosInstalled = installed;
		IosManager.prototype.listDevicesWithDetails = details;
	}
});

import childProcess from "node:child_process";
import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server";
import { AndroidDeviceManager, AndroidRobot } from "../src/android";
import { HarmonyDeviceManager, HarmonyRobot } from "../src/harmony";
import { IosManager, IosRobot } from "../src/ios";
import { Mobilecli } from "../src/mobilecli";
import { MobileDevice } from "../src/mobile-device";
import { WebviewManager } from "../src/webview";

const originalIosList = IosManager.prototype.listDevices;
const originalMobilecliDevices = Mobilecli.prototype.getDevices;
const originalExecFileSync = childProcess.execFileSync;

const restore: (() => void)[] = [];
function stub(target: any, key: string, fn: (...args: any[]) => any): void {
	const old = target[key]; target[key] = fn; restore.push(() => { target[key] = old; });
}
const missing = (): never => { throw new Error("backend missing"); };
let client: Client;
let server: ReturnType<typeof createMcpServer>;
let calls: string[];
let previousTelemetry: string | undefined;

test.beforeEach(async () => {
	previousTelemetry = process.env.MOBILEMCP_DISABLE_TELEMETRY;
	process.env.MOBILEMCP_DISABLE_TELEMETRY = "1";
	calls = [];
	// No backend may launch a host executable, even if a test unexpectedly routes there.
	for (const [target, keys] of [
		[AndroidDeviceManager.prototype, ["getConnectedDevices", "getConnectedDevicesWithDetails"]],
		[IosManager.prototype, ["listDevices", "listDevicesWithDetails"]],
		[HarmonyDeviceManager.prototype, ["listTargets"]],
		[Mobilecli.prototype, ["getVersion", "getDevices", "agentStatus", "agentInstall", "spawnCommand", "crashesList", "crashesGet"]],
	] as [any, string[]][]) {for (const key of keys) {stub(target, key, missing);}}
	for (const [target, platform] of [[HarmonyRobot.prototype, "harmony"], [AndroidRobot.prototype, "android"], [IosRobot.prototype, "ios"], [MobileDevice.prototype, "simulator"]] as const) {
		stub(target, "tap", async () => { calls.push(platform); });
		stub(target, "getScreenSize", async () => ({ width: 100, height: 200, scale: 1 }));
	}
	stub(WebviewManager.prototype, "connect", async () => { calls.push("cdp"); return {}; });
	server = createMcpServer();
	client = new Client({ name: "platform-routing-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
});
test.afterEach(async () => {
	await client.close(); await server.close();
	while (restore.length) {restore.pop()!();}
	if (previousTelemetry === undefined) {delete process.env.MOBILEMCP_DISABLE_TELEMETRY;} else {process.env.MOBILEMCP_DISABLE_TELEMETRY = previousTelemetry;}
});
const call = (name: string, args: any = {}): Promise<any> => client.callTool({ name, arguments: args });
const tap = (device: string): Promise<any> => call("mobile_click_on_screen_at_coordinates", { device, x: 1, y: 2 });
function harmony(status = "Connected"): void {
	stub(HarmonyDeviceManager.prototype, "listTargets", () => [{ id: "h", platform: "harmony", status, transport: "USB" }]);
}
function android(id = "a"): void {
	const devices = () => [{ deviceId: id, name: "Android", version: "15" }];
	stub(AndroidDeviceManager.prototype, "getConnectedDevices", devices);
	stub(AndroidDeviceManager.prototype, "getConnectedDevicesWithDetails", devices);
}

test("HDC-only discovery and native operations work without other dependencies", async () => {
	harmony();
	const devices = JSON.parse((await call("mobile_list_available_devices")).content[0].text).devices;
	expect(devices).toEqual([{ id: "h", name: "h", platform: "harmony", type: "real", version: "unknown", state: "online", status: "Connected", transport: "USB" }]);
	expect((await tap("h")).isError).not.toBe(true);
	expect((await call("mobile_get_screen_size", { device: "h" })).isError).not.toBe(true);
	expect(calls).toEqual(["harmony"]);
});
test("ADB-only discovery and tap do not require mobilecli", async () => {
	android();
	expect(JSON.parse((await call("mobile_list_available_devices")).content[0].text).devices[0].platform).toBe("android");
	expect((await tap("a")).isError).not.toBe(true);
	expect(calls).toEqual(["android"]);
});
test("physical iOS uses go-ios robot without requiring simulator dependency", async () => {
	stub(IosManager.prototype, "listDevices", () => [{ deviceId: "i", deviceName: "iPhone" }]);
	expect((await tap("i")).isError).not.toBe(true);
	expect(calls).toEqual(["ios"]);
});
test("iOS simulator preserves mobilecli agent setup and caches successful setup", async () => {
	stub(Mobilecli.prototype, "getDevices", () => ({ status: "ok", data: { devices: [{ id: "s", name: "Simulator", platform: "ios", type: "simulator", version: "18" }] } }));
	stub(Mobilecli.prototype, "getVersion", () => "1.0.0");
	stub(Mobilecli.prototype, "agentStatus", () => ({ status: "fail" }));
	stub(Mobilecli.prototype, "agentInstall", () => { calls.push("install"); });
	expect((await tap("s")).isError).not.toBe(true);
	expect((await tap("s")).isError).not.toBe(true);
	expect(calls).toEqual(["install", "simulator", "simulator"]);
});
test("unauthorized, unknown and ambiguous IDs fail before any action", async () => {
	harmony("Unauthorized");
	expect(JSON.parse((await call("mobile_list_available_devices")).content[0].text).devices[0].state).toBe("offline");
	expect((await tap("h")).content[0].text).toContain("Unauthorized");
	expect((await tap("missing")).isError).toBe(true);
	harmony(); android("h");
	expect((await tap("h")).content[0].text).toContain("ambiguous");
	expect(calls).toEqual([]);
});
test("Harmony unsupported native, mobilecli and WebView tools fail explicitly", async () => {
	harmony();
	for (const [name, args, message] of [
		["mobile_open_url", { url: "https://example.com" }, "暂未验证"],
		["mobile_start_screen_recording", {}, "do not support Harmony"],
		["mobile_list_crashes", {}, "do not support Harmony"],
		["webview_connect", { packageName: "app" }, "Android only"],
		["webview_pages", { packageName: "app" }, "Android only"],
	] as const) {
		const result = await call(name, { device: "h", ...args });
		expect(result.isError, name).toBe(true); expect(result.content[0].text, name).toContain(message);
	}
	expect(calls).toEqual([]);
});
test("MCP mixed-device flow guards the actual WebView step device", async () => {
	harmony(); android();
	const result = await call("run_flow", { device: "a", steps: [{ op: "tap", x: 1, y: 2 }, { op: "webview_connect", device: "h", packageName: "app" }] });
	expect(JSON.parse(result.content[0].text).passed).toBe(false);
	expect(calls).toEqual(["android"]);
});
test("Android WebView and native Harmony flow still work", async () => {
	harmony(); android();
	expect((await call("webview_connect", { device: "a", packageName: "app" })).isError).not.toBe(true);
	const result = await call("run_flow", { device: "h", steps: [{ op: "tap", x: 1, y: 2 }] });
	expect(JSON.parse(result.content[0].text).passed).toBe(true);
	expect(calls).toEqual(["cdp", "harmony"]);
});
test("iOS WebView fails without routing to ADB", async () => {
	stub(IosManager.prototype, "listDevices", () => [{ deviceId: "i", deviceName: "iPhone" }]);
	const result = await call("webview_connect", { device: "i", packageName: "app" });
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toContain("Android only");
	expect(calls).toEqual([]);
});
test("Android mobilecli-specific operations still require mobilecli", async () => {
	android();
	const result = await call("mobile_list_crashes", { device: "a" });
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toContain("mobilecli is not available");
});
test("Harmony CDP-only flow cannot bypass platform routing", async () => {
	harmony();
	const result = await call("run_flow", { device: "h", steps: [{ op: "webview_connect", packageName: "app" }] });
	expect(JSON.parse(result.content[0].text).passed).toBe(false);
	expect(calls).toEqual([]);
});

test("hung unrelated go-ios and mobilecli processes are killed within discovery deadlines", async () => {
	harmony();
	stub(IosManager.prototype, "listDevices", originalIosList);
	stub(Mobilecli.prototype, "getDevices", originalMobilecliDevices);
	stub(Mobilecli.prototype, "getPath", () => "hung-mobilecli");
	const deadlines: number[] = [];
	stub(childProcess, "execFileSync", (_file, _args, options) => {
		deadlines.push(options?.timeout);
		// Never launch an unbounded fixture, including when run against old code.
		if (!options?.timeout || options.killSignal !== "SIGKILL") {throw new Error("Missing bounded discovery timeout");}
		return originalExecFileSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
	});
	const started = Date.now();
	expect((await tap("h")).isError).not.toBe(true);
	expect(deadlines).toEqual([3000, 3000]);
	expect(Date.now() - started).toBeLessThan(15000);
	expect(calls).toEqual(["harmony"]);
});

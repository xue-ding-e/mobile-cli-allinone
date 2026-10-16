// CLI adapters reuse the native Robot implementations; no MCP startup dependency.
import { execFileSync } from "node:child_process";
import { AndroidRobot } from "./android";
import { HarmonyRobot } from "./harmony";
import { IosManager, IosRobot } from "./ios";
import { Simctl } from "./iphone-simulator";
import { IosWifiRobot } from "./ios-wifi-bridge";

export type DevicePlatform = "android" | "harmony" | "ios" | "ios-simulator";
export const platforms: DevicePlatform[] = ["android", "harmony", "ios", "ios-simulator"];
export const makeRobot = (device: string, platform: DevicePlatform, opts: Record<string, string | boolean> = {}) => {
	if (opts["simulator-wda-config"] !== undefined && platform !== "ios-simulator") {throw new Error("--simulator-wda-config requires ios-simulator; it cannot bind another platform");}
	switch (platform) {
		case "android": return new AndroidRobot(device);
		case "harmony": return new HarmonyRobot(device);
		case "ios": {
			if (opts["ios-config"] !== undefined || opts["wda-url"] !== undefined) {
				if (typeof opts["ios-config"] !== "string" || !opts["ios-config"].trim()) {throw new Error("--ios-config requires a non-empty value");}
				if (opts["wda-url"] !== undefined && (typeof opts["wda-url"] !== "string" || !opts["wda-url"].trim())) {throw new Error("--wda-url requires a non-empty value");}
				return new IosWifiRobot(device, opts["ios-config"], typeof opts.pkg === "string" ? opts.pkg : undefined, typeof opts["wda-url"] === "string" ? opts["wda-url"] : undefined);
			}
			return new IosRobot(device);
		}
		case "ios-simulator": {
			const config = opts["simulator-wda-config"];
			if (config !== undefined && (typeof config !== "string" || !config.trim())) {throw new Error("--simulator-wda-config requires a non-empty value");}
			return new Simctl(device, typeof config === "string" ? config : undefined);
		}
	}
};

export const capabilities = (platform: DevicePlatform) => ({
	platform,
	native: true,
	webview: platform === "android",
	record: platform === "android",
	connect: platform === "android" || platform === "harmony",
	wake: platform === "android" || platform === "harmony",
	powerState: platform === "android" || platform === "harmony",
	keepAwake: platform === "harmony",
	fileTransfer: platform === "harmony",
	setOrientation: platform !== "harmony",
	screenshotBackend: platform === "ios-simulator" ? "simctl-explicit-uuid-png" : undefined,
	screenshotRequiresWda: platform === "ios-simulator" ? false : undefined,
	uiRequiresOwnedWdaBinding: platform === "ios-simulator" ? true : undefined,
	buttons: platform.startsWith("ios") ? ["HOME", "VOLUME_UP", "VOLUME_DOWN", "ENTER"] : undefined,
	requirements: platform === "ios" ? ["go-ios (GO_IOS_PATH)", "WebDriverAgent on localhost:8100 must forward to the selected device (single target)", "iOS 17+: tunnel on localhost:60105"]
		: platform === "ios-simulator" ? ["macOS with Xcode/xcrun", "booted simulator with explicit UUID", "size/elements/input require --simulator-wda-config binding an exclusive loopback WDA port to the live installed runner PID/start/code hashes; native screenshot and app management do not require WDA", "no shared localhost:8100 or automatic runner startup"]
			: platform === "harmony" ? ["HDC (MOBILE_HDC_PATH)", "authorized device"] : ["ADB", "authorized device"],
	// Capability support is static; this does not assert tool/device readiness.
});

export const listIosDevices = (platform: "ios" | "ios-simulator", includeOffline = false) => {
	if (platform === "ios") {
		const manager = new IosManager(10000);
		if (!manager.isGoIosInstalled()) {throw new Error("go-ios 不可用，请安装 go-ios 或设置 GO_IOS_PATH；UI 操作还需 WebDriverAgent");}
		return manager.listDevicesWithDetails().map(d => ({ id: d.deviceId, name: d.deviceName, version: d.version, platform, status: "device" }));
	}
	if (process.platform !== "darwin") {throw new Error("iOS simulator 需要 macOS 和 Xcode/xcrun");}
	const output = execFileSync("xcrun", ["simctl", "list", "devices", "available", "--json"], { timeout: 10000, encoding: "utf8" });
	const parsed = JSON.parse(output) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> };
	return Object.entries(parsed.devices).flatMap(([version, devices]) => devices
		.filter(d => includeOffline || d.state === "Booted")
		.map(d => ({ id: d.udid, name: d.name, version, platform, status: d.state })));
};

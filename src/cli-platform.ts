// CLI adapters reuse the native Robot implementations; no MCP startup dependency.
import { execFileSync } from "node:child_process";
import { AndroidRobot } from "./android";
import { HarmonyRobot } from "./harmony";
import { IosManager, IosRobot } from "./ios";
import { Simctl } from "./iphone-simulator";

export type DevicePlatform = "android" | "harmony" | "ios" | "ios-simulator";
export const platforms: DevicePlatform[] = ["android", "harmony", "ios", "ios-simulator"];
export const makeRobot = (device: string, platform: DevicePlatform) => {
	switch (platform) {
		case "android": return new AndroidRobot(device);
		case "harmony": return new HarmonyRobot(device);
		case "ios": return new IosRobot(device);
		case "ios-simulator": return new Simctl(device);
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
	buttons: platform.startsWith("ios") ? ["HOME", "VOLUME_UP", "VOLUME_DOWN", "ENTER"] : undefined,
	requirements: platform === "ios" ? ["go-ios (GO_IOS_PATH)", "WebDriverAgent on localhost:8100 must forward to the selected device (single target)", "iOS 17+: tunnel on localhost:60105"]
		: platform === "ios-simulator" ? ["macOS with Xcode/xcrun", "booted simulator", "WebDriverAgent on localhost:8100 must forward to the selected device (single target)"]
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

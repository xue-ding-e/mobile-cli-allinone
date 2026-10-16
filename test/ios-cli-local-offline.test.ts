import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { IosRobot } from "../src/ios";
import { readIosWifiConfiguration, validateWdaUrl, parseIosBridgeResult } from "../src/ios-wifi-bridge";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-ios-offline-"));
const config = path.join(directory, "environment.json");
const fixture = { device: { udid: "FAKE-OFFLINE-IOS-UDID", wdaUrl: "http://127.0.0.1:18100", lastWifiHost: "127.0.0.1" }, pythonRelative: "nonexistent-offline-runtime.exe" };
fs.writeFileSync(config, JSON.stringify(fixture));
const cli = (...args: string[]) => spawnSync(process.execPath, [path.resolve("lib/cli.js"), ...args], { encoding: "utf8", timeout: 10_000, windowsHide: true });
const flags = ["--platform", "ios", "--device", fixture.device.udid, "--ios-config", config];

test.afterAll(() => {fs.rmSync(directory, { recursive: true, force: true });});

test("explicit endpoint rejects credentials, path, query, foreign origin and changed UDID before IO", () => {
	for (const invalid of ["file:///tmp/a", "http://user:secret@127.0.0.1:18100", "http://127.0.0.1:18100/path", "http://127.0.0.1:18100/?x=1", "http://127.0.0.1:18100/#x"]) {
		expect(() => validateWdaUrl(invalid)).toThrow();
	}
	expect(validateWdaUrl("http://[::1]:18100/")).toBe("http://[::1]:18100");
	expect(() => readIosWifiConfiguration(config, "FOREIGN-DEVICE")).toThrow(/UDID/);
	expect(() => readIosWifiConfiguration(config, fixture.device.udid, "http://127.0.0.1:18101")).toThrow(/endpoint/);
	expect(readIosWifiConfiguration(config, fixture.device.udid).device.wdaUrl).toBe(fixture.device.wdaUrl);
});

test("transport confirmation requires authenticated identity and the specific action result", () => {
	const identity = JSON.stringify({ transport: "WIFI_TCP", udid: fixture.device.udid });
	expect(parseIosBridgeResult(`${identity}\n{"result":"CONNECTED"}`, fixture.device.udid, "probe").result).toBe("CONNECTED");
	expect(() => parseIosBridgeResult('{"result":"CONNECTED"}', fixture.device.udid, "probe")).toThrow(/identity/);
	expect(() => parseIosBridgeResult(`${identity}\n{"udid":"FOREIGN"}\n{"result":"CONNECTED"}`, fixture.device.udid, "probe")).toThrow(/identity/);
	expect(() => parseIosBridgeResult(`${identity}\n{"action":"launch","bundle":"dev.fixture.app","pid":0}`, fixture.device.udid, "launch", "dev.fixture.app")).toThrow(/confirm launch/);
	expect(parseIosBridgeResult(`${identity}\n{"action":"launch","bundle":"dev.fixture.app","pid":123}`, fixture.device.udid, "launch", "dev.fixture.app").pid).toBe(123);
	expect(() => parseIosBridgeResult(`${identity}\n{"result":"INSTALLED_AND_LOOKED_UP","bundle":"dev.foreign.app","udid":"${fixture.device.udid}"}`, fixture.device.udid, "install", "dev.fixture.app")).toThrow(/confirm install/);
});

test("CLI help and capability routes require no device", () => {
	const help = cli("--help"); expect(help.status).toBe(0); expect(help.stdout).toContain("--ios-config");
	for (const platform of ["android", "harmony", "ios"]) {
		const result = cli("capabilities", "--platform", platform);
		expect(result.status).toBe(0); const value = JSON.parse(result.stdout);
		expect(value.platform).toBe(platform);
	}
});

test("CLI eval injects the iOS robot and device without selecting global defaults", () => {
	const result = cli("eval", "return { platform, device, robot: robot.constructor.name }", ...flags);
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ platform: "ios", device: fixture.device.udid, robot: "IosWifiRobot" });
});

test("missing iOS target and foreign bridge identity fail rather than choosing Android", () => {
	const missing = cli("screen-size", "--platform", "ios", "--ios-config", config); expect(missing.status).toBe(1); expect(missing.stderr).toContain("explicit --device");
	const foreign = cli("elements", "--platform", "ios", "--device", "FOREIGN", "--ios-config", config);
	expect(foreign.status).toBe(1); expect(foreign.stderr).toContain("UDID");
	const bridge = cli("probe", ...flags); expect(bridge.status).toBe(1); expect(bridge.stderr).toContain("runtime was not found");
});

test("missing or empty endpoint/config options never fall back to an unbound localhost robot", () => {
	for (const extra of [["--ios-config"], ["--ios-config", ""], ["--wda-url"], ["--wda-url", ""]]) {
		const result = cli("eval", "return robot.constructor.name", "--platform", "ios", "--device", fixture.device.udid, ...extra);
		expect(result.status).toBe(1); expect(result.stderr).toContain("requires a non-empty value");
	}
	const unbound = cli("screen-size", "--platform", "ios", "--device", fixture.device.udid, "--wda-url", fixture.device.wdaUrl);
	expect(unbound.status).toBe(1); expect(unbound.stderr).toContain("requires --ios-config");
});

test("iOS eval refuses ADB, HDC and Android WebView before reaching any device", () => {
	for (const [code, error] of [["return adb('devices')", "仅支持 --platform android"], ["return hdc('list')", "仅支持 --platform harmony"], ["return await wv.outline()", "不支持 WebView CDP"]]) {
		const result = cli("eval", code, ...flags); expect(result.status).toBe(1); expect(result.stderr).toContain(error);
	}
});

test("unsupported iOS commands and app-management gaps never reach ADB or silently succeed", () => {
	for (const [command, args, error] of [
		["connect", ["127.0.0.1:5555"], "不支持 connect"], ["wake", [], "不支持 wake"], ["power-state", [], "不支持 power-state"],
		["record", ["start"], "不支持 record"], ["apps", [], "does not implement apps"], ["stop", ["dev.fixture.app"], "does not implement stop"],
		["uninstall", ["dev.fixture.app"], "does not implement uninstall"], ["install", ["fixture.ipa"], "requires --pkg"],
		["wv-pages", [], "不支持"], ["use", [fixture.device.udid], "global default is not changed"]
	] as [string, string[], string][]) {
		const result = cli(command, ...args, ...flags); expect(result.status, command).toBe(1); expect(result.stderr).toContain(error);
	}
});

test("flow platform restrictions and overridden device identity are checked before transport", () => {
	for (const steps of [[{ op: "webview_evaluate", expression: "1" }], [{ op: "tap", device: "FOREIGN", x: 1, y: 1 }]]) {
		const file = path.join(directory, `flow-${steps[0].op}.json`); fs.writeFileSync(file, JSON.stringify(steps));
		const result = cli("flow-run", file, ...flags);
		// Failed flows retain their structured result and the current nonzero exit contract.
		expect(result.status, result.stderr).toBe(1);
		const value = JSON.parse(result.stdout);
		expect(value.passed).toBe(false);
		expect(value.results.every((step: { ok: boolean }) => !step.ok)).toBe(true);
		expect(result.stdout).toMatch(/未实现|UDID/);
	}
});

test("an explicit WDA endpoint without authenticated binding cannot be used directly", async () => {
	const robot = new IosRobot(fixture.device.udid, { wdaUrl: fixture.device.wdaUrl });
	await expect(robot.getScreenSize()).rejects.toThrow(/authenticated device binding/);
});

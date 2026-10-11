import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { HarmonyRobot, HarmonyDeviceManager, harmonyRect, harmonyElements, pngScreenSize, hdcCommand, parseHarmonyTargets, parseBmBundle } from "../src/harmony";
import { runFlow } from "../src/flows";
import { Robot } from "../src/robot";
import { WebviewManager } from "../src/webview";

test("HDC inventory distinguishes transport and authorization", () => {
	const targets = parseHarmonyTargets("192.168.0.4:46001 TCP Connected localhost hdc\nphone USB Unauthorized localhost hdc\n[Empty]");
	expect(targets).toEqual([
		{ id: "192.168.0.4:46001", transport: "TCP", status: "Connected", platform: "harmony" },
		{ id: "phone", transport: "USB", status: "Unauthorized", platform: "harmony" },
	]);
});
test("Unauthorized is not a successful connection", () => {
	const manager = new HarmonyDeviceManager();
	manager.listTargets = () => [{ id: "phone", transport: "USB", status: "Unauthorized", platform: "harmony" }];
	expect(() => manager.connect("phone")).toThrow("Unauthorized");
});
test("HDC exit zero with a failure message still rejects", () => {
	const previous = process.env.MOBILE_HDC_PATH;
	try {
		process.env.MOBILE_HDC_PATH = process.execPath;
		expect(() => hdcCommand(["-e", "process.stdout.write('[Fail][E000002]:The device unauthorized.')"])).toThrow("unauthorized");
	} finally {
		if (previous === undefined) {delete process.env.MOBILE_HDC_PATH;} else {process.env.MOBILE_HDC_PATH = previous;}
	}
});
test("HDC exit zero with a stderr failure and nonzero status both reject", () => {
	const previous = process.env.MOBILE_HDC_PATH;
	try {
		process.env.MOBILE_HDC_PATH = process.execPath;
		expect(() => hdcCommand(["-e", "process.stderr.write('[Fail] Unauthorized')"])).toThrow("Unauthorized");
		expect(() => hdcCommand(["-e", "process.stderr.write('device offline'); process.exit(7)"])).toThrow("device offline");
	} finally {
		if (previous === undefined) {delete process.env.MOBILE_HDC_PATH;} else {process.env.MOBILE_HDC_PATH = previous;}
	}
});
test("Layout keeps text bounds but taps its clickable launcher icon", () => {
	const root = { attributes: { bounds: "[0,0][2240,2440]" }, children: [{
		attributes: { type: "RelativeContainer", clickable: "true", bounds: "[1135,483][1394,771]" },
		children: [
			{ attributes: { type: "Image", clickable: "true", bounds: "[1183,509][1346,672]" } },
			{ attributes: { type: "Text", text: "目标App", clickable: "false", bounds: "[1194,682][1335,726]" } },
		],
	}] };
	const el = harmonyElements(root).find(e => e.text === "目标App")!;
	expect(el.rect).toEqual({ x: 1194, y: 682, width: 141, height: 44 });
	expect(el.tapRect).toEqual({ x: 1183, y: 509, width: 163, height: 163 });
	expect(() => harmonyRect("[0,0][NaN,30]")).toThrow();
	expect(() => harmonyRect("[30,0][10,20]")).toThrow();
});
test("Native flow uses target action bounds and rejects Android-only CDP", async () => {
	const taps: number[][] = [];
	const robot = {
		getElementsOnScreen: async () => [{ type: "Text", text: "目标", rect: { x: 0, y: 200, width: 50, height: 20 }, tapRect: { x: 10, y: 20, width: 100, height: 60 } }],
		tap: async (x: number, y: number) => { taps.push([x, y]); },
	} as Robot;
	const context = { getRobot: () => robot, defaultDevice: "phone", platform: "harmony" as const, webview: new WebviewManager() };
	expect((await runFlow([{ op: "tap_text", text: "目标" }], context)).passed).toBe(true);
	expect(taps).toEqual([[60, 50]]);
	const result = await runFlow([{ op: "webview_connect", packageName: "com.test" }], context);
	expect(result.passed).toBe(false);
	expect(result.results[0].info).toContain("未实现");
});
test("Keep-awake validates bounds and restores the native timeout", () => {
	const robot = new HarmonyRobot("phone");
	const calls: string[][] = [];
	robot.hdc = (...args: string[]) => { calls.push(args); return Buffer.from("OK"); };
	expect(() => robot.keepAwake(-1)).toThrow();
	expect(() => robot.keepAwake(Infinity)).toThrow();
	robot.keepAwake(7200);
	robot.keepAwake("restore");
	expect(calls).toEqual([
		["shell", "\u0027power-shell\u0027 \u0027timeout\u0027 \u0027-o\u0027 \u00277200000\u0027"],
		["shell", "\u0027power-shell\u0027 \u0027timeout\u0027 \u0027-r\u0027"],
	]);
});
test("bm dump parser ignores diagnostic objects and trailing noise", async () => {
	const dump = '[Info] {"note":"before"}\\n' +
		'{"hapModuleInfos":[{"abilities":[{"name":"EntryAbility","meta":{"note":"brace } inside"}}]}]}\\n[Info] done';
	expect(parseBmBundle(dump).hapModuleInfos[0].abilities[0].name).toBe("EntryAbility");
	const robot = new HarmonyRobot("phone");
	const calls: string[][] = [];
	robot.hdc = (...args: string[]) => {
		calls.push(args);
		return Buffer.from(args[1].includes("'bm'") ? dump : "start ability successfully");
	};
	await expect(robot.launchApp("com.example.app")).resolves.toBeUndefined();
	expect(calls.some(args => args[1].includes("'aa' 'start'"))).toBe(true);
});
test("dump and screenshot cleanup cannot replace the primary error", async () => {
	const robot = new HarmonyRobot("phone");
	let local = "";
	robot.hdc = (...args: string[]) => {
		if (args[0] === "file") {local = args[3]; fs.writeFileSync(local, "bad png"); return Buffer.alloc(0);}
		if (args[1].includes("'rm'")) {throw new Error("cleanup failed");}
		if (args[1].includes("'dumpLayout'")) {throw new Error("capture failed");}
		return Buffer.alloc(0);
	};
	expect(() => robot.readLayout()).toThrow("capture failed");
	await expect(robot.getScreenshot()).rejects.toThrow("HDC 没有返回 PNG 截图");
	expect(fs.existsSync(local)).toBe(false);
});
test("APK is not silently treated as a native Harmony HAP install", async () => {
	await expect(new HarmonyRobot("phone").installApp("test.apk")).rejects.toThrow("卓易通");
});

function pngHeader(width: number, height: number): Buffer {
	const buffer = Buffer.alloc(33);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
	buffer.writeUInt32BE(13, 8);
	buffer.write("IHDR", 12, "ascii");
	buffer.writeUInt32BE(width, 16);
	buffer.writeUInt32BE(height, 20);
	return buffer;
}

test("partial UITest tree does not shrink physical Harmony screen size", async () => {
	const robot = new HarmonyRobot("tablet");
	let layoutReads = 0;
	robot.readLayout = () => { layoutReads++; return { attributes: { bounds: "[0,0][1600,87]" } }; };
	robot.getScreenshot = async () => pngHeader(1600, 2560);
	await expect(robot.getScreenSize()).resolves.toEqual({ width: 1600, height: 2560, scale: 1 });
	expect(layoutReads).toBe(0);
});
test("PNG IHDR supplies portrait and landscape dimensions", async () => {
	expect(pngScreenSize(pngHeader(1600, 2560))).toEqual({ width: 1600, height: 2560, scale: 1 });
	expect(pngScreenSize(pngHeader(2560, 1600))).toEqual({ width: 2560, height: 1600, scale: 1 });
	const robot = new HarmonyRobot("tablet");
	robot.getScreenshot = async () => pngHeader(2560, 1600);
	await expect(robot.getOrientation()).resolves.toBe("landscape");
});

test("missing or malformed PNG header fails explicitly", async () => {
	const wrongSignature = pngHeader(1600, 2560);
	wrongSignature[0] = 0;
	const wrongChunk = pngHeader(1600, 2560);
	wrongChunk.write("IDAT", 12, "ascii");
	const wrongLength = pngHeader(1600, 2560);
	wrongLength.writeUInt32BE(12, 8);
	for (const buffer of [Buffer.alloc(0), pngHeader(1, 1).subarray(0, 24), wrongSignature, wrongChunk, wrongLength]) {
		expect(() => pngScreenSize(buffer)).toThrow("PNG IHDR");
	}
	const robot = new HarmonyRobot("tablet");
	robot.getScreenshot = async () => wrongChunk;
	await expect(robot.getScreenSize()).rejects.toThrow("PNG IHDR");
});
test("PNG IHDR rejects zero and out-of-range dimensions", () => {
	expect(() => pngScreenSize(pngHeader(0, 2560))).toThrow("PNG 尺寸无效");
	expect(() => pngScreenSize(pngHeader(1600, 0))).toThrow("PNG 尺寸无效");
	expect(() => pngScreenSize(pngHeader(0x80000000, 2560))).toThrow("PNG 尺寸无效");
});

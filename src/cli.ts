#!/usr/bin/env node
// mobile CLI —— agent 原生(wxdt 架构):code-execution 主入口(run/eval 一段脚本一条连接做完 N 步)
// + 持久 handle(~/.mobile-cli/state.json 记默认设备/包,免每命令传参)
// + 薄单命令(webview 类内部自动 connect→用→close;原生 adb 类天然无状态)。
// 复用 MCP 同一核心(AndroidRobot/WebviewManager/flows),MCP 服务器保留为兜底。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execFileSync } from "node:child_process";
import { AndroidRobot, AndroidDeviceManager, getAdbPath } from "./android";
import { HarmonyRobot, HarmonyDeviceManager } from "./harmony";
import { DevicePlatform, platforms, makeRobot, capabilities, listIosDevices } from "./cli-platform";
import { IosWifiRobot } from "./ios-wifi-bridge";
import { WebviewManager } from "./webview";
import { runFlow, saveFlow, loadFlow, listFlows, FlowStep, FlowContext } from "./flows";

const STATE_DIR = path.join(os.homedir(), ".mobile-cli");
const STATE_FILE = path.join(STATE_DIR, "state.json");

interface CliState {
	device?: string;
	platform?: DevicePlatform;
	powerOriginal?: { device: string; value: string };
	pkg?: string;
	port?: number;
	recordPid?: number;
	recordDevice?: string;
	recordRemote?: string;
	updatedAt?: string;
}

const loadState = (): CliState => {
	try {
		return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
};

const saveState = (patch: CliState): CliState => {
	const next = { ...loadState(), ...patch, updatedAt: new Date().toISOString() };
	fs.mkdirSync(STATE_DIR, { recursive: true });
	fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
	return next;
};

// 紧凑单行 JSON 到 stdout;Buffer/大对象不直接吐
const out = (v: unknown): void => {
	process.stdout.write(JSON.stringify(v, (_k, val) => {
		if (val && val.type == "Buffer" && Array.isArray(val.data)) {
			return `<Buffer ${val.data.length}B omitted>`;
		}
		return val;
	}) + "\n");
};

const die = (msg: string): never => {
	// Propagate through owned session/finally scopes before ending the CLI.
	throw new Error(msg);
};

// 轻量 argv:位置参数 + --k v / --k=v / --flag
const parseArgs = (argv: string[]): { pos: string[]; opts: Record<string, string | boolean> } => {
	const pos: string[] = [];
	const opts: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq > 0) {
				opts[a.slice(2, eq)] = a.slice(eq + 1);
			} else if (a === "--secret") {
				opts.secret = true;
			} else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
				opts[a.slice(2)] = argv[++i];
			} else {
				opts[a.slice(2)] = true;
			}
		} else {
			pos.push(a);
		}
	}
	return { pos, opts };
};

const resolvePlatform = (opts: Record<string, string | boolean>): DevicePlatform => {
	const value = opts.platform || loadState().platform || "android";
	if (!platforms.includes(value as DevicePlatform)) {return die("--platform 必须是 " + platforms.join("|"));}
	return value as DevicePlatform;
};

// 解析目标设备:--device > 对应平台 handle > 唯一在线设备(自动记住)
const resolveDevice = (opts: Record<string, string | boolean>): string => {
	if (typeof opts.device == "string") {
		return opts.device;
	}
	const st = loadState(), platform = resolvePlatform(opts);
	if (opts["ios-config"] !== undefined) {return die("iOS Wi-Fi requires explicit --device <UDID>; no global default is selected");}
	if (st.device && (st.platform || "android") === platform) {return st.device;}
	if (platform === "harmony") {
		const devices = new HarmonyDeviceManager().listTargets().filter(d => d.status === "Connected");
		if (devices.length === 1) { saveState({ device: devices[0].id, platform }); return devices[0].id; }
		return die("HDC 需要已授权的目标；USB/无线为独立连接，用 --device 指定。mobile devices --all 查看状态");
	}
	if (platform === "ios" || platform === "ios-simulator") {
		const devices = listIosDevices(platform);
		if (devices.length === 1) {saveState({ device: devices[0].id, platform }); return devices[0].id;}
		return die(devices.length ? `多台 iOS 设备在线，请用 --device 指定: ${devices.map(d => d.id).join(", ")}` : "无在线 iOS 设备；模拟器需先启动，真机需信任此电脑");
	}
	const devices = new AndroidDeviceManager().getConnectedDevices();
	if (devices.length == 1) {
		saveState({ device: devices[0].deviceId, platform: "android" });
		return devices[0].deviceId;
	}
	if (devices.length == 0) {
		return die("无在线安卓设备(adb devices 为空;模拟器需先 adb connect)");
	}
	return die(`多台设备在线,用 mobile use <serial> 指定默认或 --device 传参: ${devices.map(d => d.deviceId).join(", ")}`);
};

const resolvePkg = (opts: Record<string, string | boolean>): string => {
	if (typeof opts.pkg == "string") {
		return opts.pkg;
	}
	const st = loadState();
	if (st.pkg) {
		return st.pkg;
	}
	return die("webview 操作需要目标 App 包名:--pkg com.xxx 或先 mobile use <serial> --pkg com.xxx 记住");
};

// webview 单命令生命周期:connect→干活→close(单 webview 只允许一个 CDP 连接,正好适配)
const withWebview = async <T>(opts: Record<string, string | boolean>, fn: (wv: WebviewManager, serial: string) => Promise<T>): Promise<T> => {
	if (resolvePlatform(opts) !== "android") {die("此平台不支持 wv-*；WebView CDP 仅支持 Android");}
	const serial = resolveDevice(opts);
	const pkg = resolvePkg(opts);
	const port = typeof opts.port == "string" ? parseInt(opts.port, 10) : (loadState().port || 9222);
	const wv = new WebviewManager();
	await wv.connect(serial, pkg, port);
	try {
		return await fn(wv, serial);
	} finally {
		wv.disconnect(serial);
	}
};

const HELP = `mobile —— Android/鸿蒙/iOS CLI（复用 ADB/HDC/go-ios/Simctl Robot）

用法: mobile <命令> [参数] [--platform android|harmony|ios|ios-simulator] [--device <serial>] [--pkg <包名>]

主入口(code-execution,推荐):
  run <script.js>            跑脚本:注入 robot/wv/flows/device/adb,可 return 紧凑结果
  eval "<js>"                内联跑代码,同上注入。例: mobile eval "return (await robot.getScreenSize())"

设备/状态:
  devices [--all]            列 ADB/HDC/iOS 设备，--all 含离线状态
  capabilities [--platform 平台]  静态能力与依赖（不代表设备已就绪）
  iOS Wi-Fi: --platform ios --device <UDID> --ios-config <private.json>
  配置绑定现有无线配对/认证桥与 WDA；不启动代理、不配对、不构建签名
  --wda-url <origin> 可核对配置中的同一 WDA 地址，不能静默改目标
  probe / wda-status / devices / screen-size / elements / shot / tap-text
  wda-status 单次只读 GET /status，保真实 HTTP/body/error/elapsed
  iOS 批量读取：run/eval 中 await robot.captureScreen() 返回 {size,elements,screenshot:Buffer}
  captureScreen 的三项读取共享自己创建的 WDA session，完成或失败均清理
  Wi-Fi bridge: launch <bundle> / install <ipa> --pkg <bundle>
  Wi-Fi bridge 暂不支持 apps/stop/uninstall；原 go-ios 后端保留
  iOS 真机用 --platform ios；模拟器用 --platform ios-simulator（macOS/Xcode）。
  默认 go-ios 的 UI 操作需 WDA localhost:8100；iOS 17+ 真机还需 tunnel localhost:60105。
  iOS 不支持 wv-*、录屏、connect、wake/power-state、HDC 文件传输。
  connect <地址> --platform harmony|android
  use <设备> --platform harmony  持久选择 HDC；USB 和无线地址分开
  wake / keep-awake [秒数|restore] / power-state  鸿蒙防息屏与状态核验
  file-send <本地> <设备> / file-recv <设备> <本地>  HDC 文件传输
  tap-text <文字或identifier>  按实际控件定位点击
  use <serial> [--pkg 包名]  记住设备和平台；run/eval 注入 hdc/platform（Harmony）
  鸿蒙尚不支持 wv-* CDP、录屏、强制方向；APK 经卓易通导入，HDC install 仅 HAP。
  state                      查看已记住的 handle

原生(adb,无状态):
  apps [--all]               列已装应用     launch <pkg> / stop <pkg>
  install <apk路径> / uninstall <pkg>
  tap <x> <y> / longpress <x> <y> [ms] / doubletap <x> <y>
  swipe <up|down|left|right> [--from x,y] [--distance n]
  key <文本> [--submit] / button <BACK|HOME|ENTER|...> / url <链接>
  shot <保存路径.png>        原生截图     elements   屏幕元素(紧凑)
  screen-size / orientation [portrait|landscape]
  record start [--path 远端路径] / record stop <本地保存路径>

webview(page级CDP,自动 connect→用→close;需 --pkg 或 use 记住):
  wv-eval "<js>"             执行JS(chrome68 禁 ?./??,用 a&&a.b)
  wv-outline [selector]      DOM 结构紧凑轮廓
  wv-style <selector> [--props a,b]  计算样式
  wv-tap-text <文本>          按文本点击
  wv-shot <路径.png>          webview 截图
  wv-net [ms]                抓 N 毫秒网络请求
  wv-pages                   列 webview 页面目标

流程重放:
  flow-run <名称|steps.json> [--keep-going]   flow-list   flow-save <名称> <steps.json>

任一命令输出为紧凑单行 JSON;图片/大 Buffer 一律落盘返回路径。`;

const main = async (): Promise<void> => {
	const [cmd, ...rest] = process.argv.slice(2);
	const { pos, opts } = parseArgs(rest);

	if (!cmd || cmd == "help" || cmd == "--help" || cmd == "-h") {
		process.stdout.write(HELP + "\n");
		return;
	}

	if (opts["ios-config"] !== undefined || opts["wda-url"] !== undefined) {
		if (opts.platform !== "ios") {return die("iOS Wi-Fi options require explicit --platform ios");}
		for (const name of ["ios-config", "wda-url"]) {
			if (opts[name] !== undefined && (typeof opts[name] !== "string" || !String(opts[name]).trim())) {return die(`--${name} requires a non-empty value`);}
		}
		if (!opts["ios-config"]) {return die("--wda-url requires --ios-config to bind the endpoint to the selected device");}
		if (typeof opts.device !== "string" || !opts.device.trim()) {return die("iOS Wi-Fi requires explicit --device <UDID>");}
		if (cmd === "use") {return die("iOS Wi-Fi uses explicit --device; global default is not changed");}
	}
	const selectedPlatform = cmd === "devices" ? "android" : resolvePlatform(opts);
	if (selectedPlatform.startsWith("ios") && ["connect", "wake", "keep-awake", "power-state", "file-send", "file-recv", "record"].includes(cmd)) {
		die(`${selectedPlatform} 不支持 ${cmd}；用 capabilities 查看能力`);
	}
	switch (cmd) {
		case "capabilities": {
			out({ ...capabilities(selectedPlatform), ...(opts["ios-config"] ? { backend: "pymobiledevice3-existing-wifi-bridge+WDA", requirements: ["Python >=3.11 with optional Wi-Fi bridge requirements", "existing paired Wi-Fi device", "explicit --device + --ios-config bound WDA origin"], unsupported: ["apps", "stop", "uninstall", "WebView/CDP", "build/sign"], coordinateUnit: "WDA points; PNG dimensions are physical pixels" } : {}) }); return;
		}
		case "probe":
		case "wda-status": {
			const robot = makeRobot(resolveDevice(opts), resolvePlatform(opts), opts);
			if (!(robot instanceof IosWifiRobot)) {return die(`${cmd} requires --platform ios --ios-config`);}
			if (cmd === "probe") {out(await robot.probe()); return;}
			const diagnostic = await robot.getWdaStatusDiagnostic(); out(diagnostic);
			if (!diagnostic.ok) {process.exitCode = 1;}
			return;
		}
		case "devices": {
			if (opts.platform === "ios" && opts["ios-config"]) {
				const robot = makeRobot(resolveDevice(opts), "ios", opts) as IosWifiRobot;
				out([await robot.probe()]); return;
			}
			const platform = opts.platform || "all", includeOffline = Boolean(opts.all || opts["include-offline"]);
			if (![...platforms, "all"].includes(String(platform))) {die("devices --platform android|harmony|ios|ios-simulator|all");}
			const list: unknown[] = [];
			if (platform === "all" || platform === "android") {
				let raw: string | undefined;
				try {raw = execFileSync(getAdbPath(), ["devices", "-l"], { windowsHide: true, timeout: 5000 }).toString();} catch {
					list.push({ platform: "android", status: "unavailable", diagnostic: "ADB 不可用，请检查 adb/ANDROID_HOME" });
				}
				if (raw !== undefined) {
					const online = new AndroidDeviceManager().getConnectedDevicesWithDetails();
					list.push(...online.map(d => ({ id: d.deviceId, name: d.name, version: d.version, platform: "android", status: "device" })));
					if (includeOffline) {
						for (const line of raw.split(/\r?\n/)) {
							const [id, status] = line.trim().split(/\s+/);
							if (["offline", "unauthorized"].includes(status)) {list.push({ id, platform: "android", status });}
						}
					}
				}
			}
			if (platform === "all" || platform === "harmony") {
				try { list.push(...new HarmonyDeviceManager().listTargets().filter(d => includeOffline || d.status === "Connected")); } catch (error) {
					if (platform === "harmony") {throw error;}
					list.push({ platform: "harmony", status: "unavailable", diagnostic: "HDC 不可用，请检查 hdc/MOBILE_HDC_PATH" });
				}
			}
			for (const iosPlatform of ["ios", "ios-simulator"] as const) {
				if (platform !== "all" && platform !== iosPlatform) {continue;}
				try {list.push(...listIosDevices(iosPlatform, includeOffline));} catch (error) {
					if (platform === iosPlatform) {throw error;}
					list.push({ platform: iosPlatform, status: "unavailable", diagnostic: (error as Error).message });
				}
			}
			out(list); return;
		}
		case "connect": {
			const id = pos[0] || die("用法: mobile connect <地址或序列号> --platform harmony|android");
			if (resolvePlatform(opts) === "harmony") {out(new HarmonyDeviceManager().connect(id));} else {out({ platform: "android", result: execFileSync(getAdbPath(), ["connect", id], { timeout: 15000, windowsHide: true }).toString().trim() });}
			return;
		}
		case "use": {
			if (!pos[0]) {
				die("用法: mobile use <serial> [--pkg 包名] [--port 9222]");
			}
			const platform = resolvePlatform(opts);
			if (platform === "harmony") {new HarmonyDeviceManager().connect(pos[0]);}
			const patch: CliState = { device: pos[0], platform, pkg: (loadState().platform || "android") === platform ? loadState().pkg : undefined };
			if (typeof opts.pkg == "string") {
				patch.pkg = opts.pkg;
			}
			if (typeof opts.port == "string") {
				patch.port = parseInt(opts.port, 10);
			}
			out(saveState(patch));
			return;
		}
		case "state": {
			out({ stateFile: STATE_FILE, ...loadState() });
			return;
		}
	}

	// ===== code-execution 主入口 =====
	if (cmd == "run" || cmd == "eval") {
		const code = cmd == "run"
			? fs.readFileSync(pos[0] || die("用法: mobile run <script.js>"), "utf8")
			: (pos[0] || die("用法: mobile eval \"<js>\""));
		const device = resolveDevice(opts);
		const platform = resolvePlatform(opts);
		const robot = makeRobot(device, platform, opts);
		const wvMgr = new WebviewManager();
		const st = loadState();
		// wv:惰性连接的 Android webview 便捷面(首次用到才 connect,脚本结束统一断开)
		let wvConnected = false;
		const ensureWv = async (): Promise<WebviewManager> => {
			if (platform !== "android") {throw new Error("此平台不支持 WebView CDP，请使用 robot.getElementsOnScreen()");}
			if (!wvConnected) {
				const pkg = typeof opts.pkg == "string" ? opts.pkg : (st.pkg || die("脚本用 wv 需 --pkg 或先 mobile use --pkg"));
				await wvMgr.connect(device, pkg, st.port || 9222);
				wvConnected = true;
			}
			return wvMgr;
		};
		const wv = {
			eval: async (expr: string) => (await ensureWv()).evaluate(device, expr),
			outline: async (selector = "body", maxChars = 4000) => (await ensureWv()).domOutline(device, selector, maxChars),
			style: async (selector: string, props?: string[]) => (await ensureWv()).computedStyle(device, selector, props),
			tapText: async (text: string) => (await ensureWv()).clickText(device, text),
			shot: async (savePath: string) => (await ensureWv()).screenshot(device, savePath),
			net: async (ms = 3000) => (await ensureWv()).networkCapture(device, ms),
		};
		const flows = {
			run: async (name: string, stopOnError = true) => runFlow(loadFlow(name), flowCtx(device, wvMgr, resolvePlatform(opts), opts), stopOnError),
			list: () => listFlows(),
		};
		const adb = (...args: string[]): string => {
			if (!(robot instanceof AndroidRobot)) {throw new Error("adb(...) 仅支持 --platform android；Harmony 请用 hdc(...)");}
			return robot.adb(...args).toString("utf8");
		};
		const hdc = (...args: string[]): string => {
			if (!(robot instanceof HarmonyRobot)) {throw new Error("hdc(...) 仅支持 --platform harmony");}
			return robot.hdc(...args).toString("utf8");
		};
		const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
		let scriptTimer: NodeJS.Timeout | undefined;
		try {
			const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
			const fn = new AsyncFunction("robot", "wv", "flows", "adb", "device", "sleep", "hdc", "platform", code);
			const timeoutSec = typeof opts.timeout == "string" ? parseInt(opts.timeout, 10) : 120;
			const result = await Promise.race([
				fn(robot, wv, flows, adb, device, sleep, hdc, platform),
				new Promise((_r, rej) => { scriptTimer = setTimeout(() => rej(new Error(`脚本超时 ${timeoutSec}s`)), timeoutSec * 1000); }),
			]);
			out(result ?? null);
		} finally {
			clearTimeout(scriptTimer);
			if (wvConnected) {
				wvMgr.disconnect(device);
			}
		}
		return;
	}

	// ===== 原生 adb 薄命令(无状态) =====
	const robotOf = () => makeRobot(resolveDevice(opts), resolvePlatform(opts), opts);
	switch (cmd) {
		case "apps": {
			const apps = await robotOf().listApps();
			out(opts.all ? apps : apps.map(a => a.packageName));
			return;
		}
		case "launch": {
			const robot = robotOf(), pkg = pos[0] || die("用法: mobile launch <包名>");
			if (typeof opts.ability === "string") {
				if (!(robot instanceof HarmonyRobot)) {return die("--ability 仅用于 Harmony HDC");}
				await robot.launchAbility(pkg, opts.ability);
			} else {await robot.launchApp(pkg);}
			out({ launched: pos[0] });
			return;
		}
		case "stop": {
			await robotOf().terminateApp(pos[0] || die("用法: mobile stop <包名>"));
			out({ stopped: pos[0] });
			return;
		}
		case "install": {
			await robotOf().installApp(pos[0] || die("用法: mobile install <apk路径>"));
			out({ installed: pos[0] });
			return;
		}
		case "uninstall": {
			await robotOf().uninstallApp(pos[0] || die("用法: mobile uninstall <包名>"));
			out({ uninstalled: pos[0] });
			return;
		}
		case "wake": {
			const robot = robotOf();
			if (robot instanceof HarmonyRobot) {out({ result: robot.wake(), platform: "harmony" });} else if (robot instanceof AndroidRobot) { robot.adb("shell", "input", "keyevent", "224"); out({ awake: true }); }
			return;
		}
		case "keep-awake": {
			const robot = robotOf();
			if (!(robot instanceof HarmonyRobot)) {return die("keep-awake 目前支持鸿蒙 HDC");}
			const duration = pos[0] === "restore" ? "restore" : Number(pos[0] || 3600);
			out({ result: robot.keepAwake(duration), powerState: robot.powerState() }); return;
		}
		case "power-state": {
			const robot = robotOf();
			out({ powerState: robot instanceof HarmonyRobot ? robot.powerState() : robot instanceof AndroidRobot ? robot.adb("shell", "dumpsys", "power").toString() : die("此平台不支持 power-state") }); return;
		}
		case "file-send":
		case "file-recv": {
			const robot = robotOf();
			if (!(robot instanceof HarmonyRobot)) {return die("file-send/file-recv 目前支持鸿蒙 HDC");}
			if (!pos[0] || !pos[1]) {die("缺本地/设备文件路径");}
			out({ result: cmd === "file-send" ? robot.fileSend(pos[0], pos[1]) : robot.fileRecv(pos[0], pos[1]) }); return;
		}
		case "tap-text": {
			const robot = robotOf(), text = pos[0] || die("缺要点击的文字或 identifier");
			const element = (await robot.getElementsOnScreen()).find(e => e.text === text || e.identifier === text || e.label === text);
			if (!element) {return die("未找到控件: " + text);}
			const rect = element.tapRect || element.rect;
			await robot.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
			out({ tapped: text, rect }); return;
		}
		case "tap": {
			await robotOf().tap(parseInt(pos[0], 10), parseInt(pos[1], 10));
			out({ tapped: [pos[0], pos[1]] });
			return;
		}
		case "doubletap": {
			await robotOf().doubleTap(parseInt(pos[0], 10), parseInt(pos[1], 10));
			out({ doubleTapped: [pos[0], pos[1]] });
			return;
		}
		case "longpress": {
			await robotOf().longPress(parseInt(pos[0], 10), parseInt(pos[1], 10), pos[2] ? parseInt(pos[2], 10) : 1000);
			out({ longPressed: [pos[0], pos[1]] });
			return;
		}
		case "swipe": {
			const dir = (pos[0] || die("用法: mobile swipe <up|down|left|right> [--from x,y] [--distance n]")) as "up" | "down" | "left" | "right";
			const robot = robotOf();
			if (typeof opts.from == "string") {
				const [x, y] = opts.from.split(",").map(n => parseInt(n, 10));
				const distance = typeof opts.distance == "string" ? parseInt(opts.distance, 10) : undefined;
				await robot.swipeFromCoordinate(x, y, dir, distance);
			} else {
				await robot.swipe(dir);
			}
			out({ swiped: dir });
			return;
		}
		case "key": {
			try {
				await robotOf().sendKeys(pos[0] || "");
				if (opts.submit) {await robotOf().pressButton("ENTER" as never);}
			} catch (error) {
				if (opts.secret) {die("文字输入失败；秘密未记录，请检查设备授权和输入焦点");}
				throw error;
			}
			out(opts.secret ? { typedLength: (pos[0] || "").length } : { typed: pos[0] });
			return;
		}
		case "button": {
			await robotOf().pressButton((pos[0] || die("用法: mobile button <BACK|HOME|ENTER|...>")) as never);
			out({ pressed: pos[0] });
			return;
		}
		case "url": {
			await robotOf().openUrl(pos[0] || die("用法: mobile url <链接>"));
			out({ opened: pos[0] });
			return;
		}
		case "shot": {
			const p = pos[0] || die("用法: mobile shot <保存路径.png>");
			const buf = await robotOf().getScreenshot();
			fs.writeFileSync(p, buf);
			out({ screenshot: path.resolve(p), bytes: buf.length });
			return;
		}
		case "elements": {
			out(await robotOf().getElementsOnScreen());
			return;
		}
		case "screen-size": {
			out(await robotOf().getScreenSize());
			return;
		}
		case "orientation": {
			const robot = robotOf();
			if (pos[0]) {
				await robot.setOrientation(pos[0] as never);
				out({ orientation: pos[0] });
			} else {
				out({ orientation: await robot.getOrientation() });
			}
			return;
		}
	}

	// ===== 录屏(唯一跨命令状态,pid 记 handle 文件) =====
	if (cmd == "record") {
		const robot = robotOf();
		if (!(robot instanceof AndroidRobot)) {return die("鸿蒙录屏暂未实现；使用 shot 验证");}
		const serial = resolveDevice(opts);
		if (pos[0] == "start") {
			const remote = typeof opts.path == "string" ? opts.path : `/sdcard/mobile-cli-rec-${Date.now()}.mp4`;
			const { spawn } = await import("node:child_process");
			const child = spawn("adb", ["-s", serial, "shell", "screenrecord", remote], { detached: true, stdio: "ignore" });
			child.unref();
			saveState({ recordPid: child.pid, recordDevice: serial, recordRemote: remote });
			out({ recording: true, pid: child.pid, remote });
			return;
		}
		if (pos[0] == "stop") {
			const st = loadState();
			if (!st.recordRemote) {
				die("没有进行中的录屏(先 mobile record start)");
			}
			// 结束设备端 screenrecord(SIGINT 落盘),等落盘后 pull
			robot.adb("shell", "pkill", "-INT", "screenrecord");
			await new Promise(r => setTimeout(r, 1500));
			const local = pos[1] || `./record-${Date.now()}.mp4`;
			robot.adb("pull", st.recordRemote!, local);
			robot.adb("shell", "rm", "-f", st.recordRemote!);
			saveState({ recordPid: undefined, recordDevice: undefined, recordRemote: undefined });
			out({ saved: path.resolve(local) });
			return;
		}
		die("用法: mobile record start [--path 远端路径] | mobile record stop <本地保存路径>");
	}

	// ===== webview 薄命令(自动 connect→用→close) =====
	switch (cmd) {
		case "wv-eval": {
			out(await withWebview(opts, (wv, s) => wv.evaluate(s, pos[0] || die("用法: mobile wv-eval \"<js>\""))));
			return;
		}
		case "wv-outline": {
			const maxChars = typeof opts.max == "string" ? parseInt(opts.max, 10) : 4000;
			out(await withWebview(opts, (wv, s) => wv.domOutline(s, pos[0] || "body", maxChars)));
			return;
		}
		case "wv-style": {
			const props = typeof opts.props == "string" ? opts.props.split(",") : undefined;
			out(await withWebview(opts, (wv, s) => wv.computedStyle(s, pos[0] || die("用法: mobile wv-style <selector> [--props a,b]"), props)));
			return;
		}
		case "wv-tap-text": {
			out(await withWebview(opts, (wv, s) => wv.clickText(s, pos[0] || die("用法: mobile wv-tap-text <文本>"))));
			return;
		}
		case "wv-shot": {
			out(await withWebview(opts, (wv, s) => wv.screenshot(s, pos[0] || die("用法: mobile wv-shot <路径.png>"))));
			return;
		}
		case "wv-net": {
			out(await withWebview(opts, (wv, s) => wv.networkCapture(s, pos[0] ? parseInt(pos[0], 10) : 3000)));
			return;
		}
		case "wv-pages": {
			if (resolvePlatform(opts) !== "android") {die("此平台不支持 WebView CDP");}
			// 只列页面目标,不建 CDP 会话(forward 后直接 HTTP /json)
			const serial = resolveDevice(opts);
			const pkg = resolvePkg(opts);
			const port = loadState().port || 9222;
			const { autoForward, listPages } = await import("./webview");
			autoForward(serial, pkg, port);
			out((await listPages(port)).map(p => ({ type: p.type, url: p.url, title: p.title })));
			return;
		}
	}

	// ===== flow 重放 =====
	if (cmd == "flow-run") {
		const nameOrFile = pos[0] || die("用法: mobile flow-run <名称|steps.json> [--keep-going]");
		const device = resolveDevice(opts);
		const wvMgr = new WebviewManager();
		const steps: FlowStep[] = nameOrFile.endsWith(".json")
			? JSON.parse(fs.readFileSync(nameOrFile, "utf8"))
			: loadFlow(nameOrFile);
		try {
			const result = await runFlow(steps, flowCtx(device, wvMgr, resolvePlatform(opts), opts), !opts["keep-going"]);
			out(result);
			if (!result.passed) {process.exitCode = 1;}
		} finally {
			wvMgr.disconnect(device);
		}
		return;
	}
	if (cmd == "flow-list") {
		out(listFlows());
		return;
	}
	if (cmd == "flow-save") {
		const name = pos[0] || die("用法: mobile flow-save <名称> <steps.json>");
		const steps = JSON.parse(fs.readFileSync(pos[1] || die("缺 steps.json 路径"), "utf8"));
		out({ saved: saveFlow(name, steps) });
		return;
	}

	die(`未知命令: ${cmd}(mobile help 看全部)`);
};

const flowCtx = (device: string, wvMgr: WebviewManager, platform: DevicePlatform, opts: Record<string, string | boolean>): FlowContext => ({
	getRobot: (d: string) => makeRobot(d, platform, opts),
	platform,
	webview: wvMgr,
	defaultDevice: device,
});

main().catch(e => {
	process.stderr.write("错误: " + (e && e.message || String(e)) + "\n");
	// An immediate process.exit can interrupt Windows HTTP handle cleanup.
	process.exitCode = 1;
});

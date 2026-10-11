import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Robot, ScreenElement, ScreenElementRect, ScreenSize, InstalledApp, Button, SwipeDirection, Orientation, ActionableError } from "./robot";

export interface HarmonyTarget { id: string; transport: string; status: string; platform: "harmony" }
export interface HarmonyNode { attributes?: Record<string, string>; children?: HarmonyNode[] }
export function getHdcPath(): string {
	const configured = process.env.MOBILE_HDC_PATH;
	if (configured) {
		if (!fs.existsSync(configured)) {throw new ActionableError("MOBILE_HDC_PATH 指向不存在的 HDC");}
		return configured;
	}
	const bundled = "C:\\Program Files (x86)\\HiSuite\\hwtools\\hdc.exe";
	return process.platform === "win32" && fs.existsSync(bundled) ? bundled : "hdc";
}
export function hdcCommand(args: string[]): Buffer {
	const result = spawnSync(getHdcPath(), args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
	const stdout = result.stdout || Buffer.alloc(0), stderr = result.stderr || Buffer.alloc(0);
	const message = [stdout.toString("utf8"), stderr.toString("utf8")].filter(Boolean).join("\n").trim();
	// HDC 有些失败退出码仍是 0；stdout/stderr 任一端报失败都不可当作成功。
	if (result.error || result.status !== 0 || /\[Fail\]|\[Error\]|^Error!|^\s*Failed\b/im.test(message)) {
		throw new ActionableError(message || (result.error?.message ?? `HDC 退出状态: ${result.status}`));
	}
	return stdout;
}
export function parseHarmonyTargets(output: string): HarmonyTarget[] {
	return output.split(/\r?\n/).flatMap(line => {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 3 || !["USB", "TCP", "UART"].includes(parts[1])) {return [];}
		return [{ id: parts[0], transport: parts[1], status: parts[2], platform: "harmony" as const }];
	});
}
export function parseBmBundle(output: string): any {
	let start = -1, depth = 0, inString = false, escaped = false;
	for (let i = 0; i < output.length; i++) {
		const char = output[i];
		if (start < 0) {if (char === "{") {start = i; depth = 1;} continue;}
		if (inString) {
			if (escaped) {escaped = false;} else if (char === "\\") {escaped = true;} else if (char === '"') {inString = false;}
			continue;
		}
		if (char === '"') {inString = true;} else if (char === "{") {depth++;} else if (char === "}" && --depth === 0) {
			try {
				const bundle = JSON.parse(output.slice(start, i + 1));
				if (Array.isArray(bundle.hapModuleInfos)) {return bundle;}
			} catch { /* 诊断行中也可能带花括号，继续寻找包信息。 */ }
			start = -1;
		}
	}
	throw new ActionableError("bm dump 未返回可用的包信息 JSON");
}
export class HarmonyDeviceManager {
	public listTargets(): HarmonyTarget[] { return parseHarmonyTargets(hdcCommand(["list", "targets", "-v"]).toString()); }
	public connect(id: string): HarmonyTarget {
		if (id.includes(":")) {hdcCommand(["tconn", id]);}
		const target = this.listTargets().find(d => d.id === id);
		if (!target || target.status !== "Connected") {throw new ActionableError("HDC 未就绪: " + (target?.status || id) + "；请在手机确认调试授权");}
		return target;
	}
}
export function harmonyRect(value: string | undefined): ScreenElementRect {
	const match = value?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
	if (!match) {throw new ActionableError("HDC 控件没有有效 bounds");}
	const [x, y, right, bottom] = match.slice(1).map(Number);
	if (right < x || bottom < y) {throw new ActionableError("HDC bounds 顺序错误");}
	return { x, y, width: right - x, height: bottom - y };
}
export function pngScreenSize(buffer: Buffer): ScreenSize {
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature) ||
		buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") {
		throw new ActionableError("HDC 截图缺少有效 PNG IHDR，无法读取屏幕尺寸");
	}
	const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
	if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
		throw new ActionableError("HDC 截图的 PNG 尺寸无效");
	}
	return { width, height, scale: 1 };
}
export function harmonyElements(root: HarmonyNode): ScreenElement[] {
	const result: ScreenElement[] = [];
	const visit = (node: HarmonyNode, ancestors: HarmonyNode[]): void => {
		const a = node.attributes;
		if (a?.bounds && (a.text || a.description || a.clickable === "true")) {
			const rect = harmonyRect(a.bounds);
			// 鸿蒙桌面的文字标签不可点击，操作应落在同一图标容器中的 Image。
			const parent = ancestors[ancestors.length - 1];
			const icon = parent?.children?.find(c => c.attributes?.type === "Image" && c.attributes.clickable === "true");
			const action = icon || [...ancestors].reverse().find(c => c.attributes?.clickable === "true");
			result.push({ type: a.type || "", text: a.text || undefined, label: a.description || undefined,
				identifier: a.id || a.key || undefined, focused: a.focused === "true", rect,
				tapRect: a.clickable !== "true" && action?.attributes?.bounds ? harmonyRect(action.attributes.bounds) : undefined });
		}
		for (const child of node.children || []) {visit(child, [...ancestors, node]);}
	};
	visit(root, []);
	return result;
}
export class HarmonyRobot implements Robot {
	public constructor(private deviceId: string) {}
	public hdc(...args: string[]): Buffer { return hdcCommand(["-t", this.deviceId, ...args]); }
	private shell(...args: string[]): string {
		const quote = (value: string): string => "\u0027" + value.replace(/\u0027/g, "\u0027\\\u0027\u0027") + "\u0027";
		return this.hdc("shell", args.map(quote).join(" ")).toString("utf8").trim();
	}
	public readLayout(): HarmonyNode {
		const remote = "/data/local/tmp/mobile-cli-" + randomUUID() + ".json";
		try {
			this.shell("uitest", "dumpLayout", "-p", remote, "-a");
			return JSON.parse(this.shell("cat", remote)) as HarmonyNode;
		} finally {
			try { this.shell("rm", "-f", remote); } catch { /* 保留 dump/解析的原始错误。 */ }
		}
	}
	public async getElementsOnScreen(): Promise<ScreenElement[]> { return harmonyElements(this.readLayout()); }
	public async getScreenSize(): Promise<ScreenSize> {
		// UITest 在启动期间可能只返回状态栏等 partial tree，不代表物理显示尺寸。
		return pngScreenSize(await this.getScreenshot());
	}
	private point(x: number, y: number): string[] {
		if (![x, y].every(Number.isFinite) || x < 0 || y < 0) {throw new ActionableError("点击坐标无效");}
		return [String(Math.round(x)), String(Math.round(y))];
	}
	public async tap(x: number, y: number): Promise<void> { this.shell("uitest", "uiInput", "click", ...this.point(x, y)); }
	public async doubleTap(x: number, y: number): Promise<void> { this.shell("uitest", "uiInput", "doubleClick", ...this.point(x, y)); }
	public async longPress(x: number, y: number, _duration: number): Promise<void> {
		// UITest longClick 使用系统长按时长，未提供自定义持续时间参数。
		this.shell("uitest", "uiInput", "longClick", ...this.point(x, y));
	}
	public async swipe(direction: SwipeDirection): Promise<void> {
		const s = await this.getScreenSize();
		const points: Record<SwipeDirection, number[]> = {
			up: [s.width / 2, s.height * .8, s.width / 2, s.height * .2],
			down: [s.width / 2, s.height * .2, s.width / 2, s.height * .8],
			left: [s.width * .8, s.height / 2, s.width * .2, s.height / 2],
			right: [s.width * .2, s.height / 2, s.width * .8, s.height / 2],
		};
		if (!points[direction]) {throw new ActionableError("无效滑动方向");}
		this.shell("uitest", "uiInput", "swipe", ...points[direction].map(n => String(Math.round(n))));
	}
	public async swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance?: number): Promise<void> {
		const s = await this.getScreenSize(), length = distance ?? Math.min(s.width, s.height) * .3;
		const offsets: Record<SwipeDirection, number[]> = { up: [0, -length], down: [0, length], left: [-length, 0], right: [length, 0] };
		const offset = offsets[direction];
		if (!offset || !Number.isFinite(length) || length <= 0) {throw new ActionableError("滑动参数无效");}
		const toX = Math.max(0, Math.min(s.width - 1, x + offset[0])), toY = Math.max(0, Math.min(s.height - 1, y + offset[1]));
		this.shell("uitest", "uiInput", "swipe", ...this.point(x, y), ...this.point(toX, toY));
	}
	public async sendKeys(text: string): Promise<void> {
		try { this.shell("uitest", "uiInput", "text", text); } catch { throw new ActionableError("文字输入失败；请检查设备授权和输入焦点"); }
	}
	public async pressButton(button: Button): Promise<void> {
		const keys: Partial<Record<Button, string>> = { BACK: "Back", HOME: "Home", ENTER: "2054", VOLUME_UP: "16", VOLUME_DOWN: "17" };
		const key = keys[button];
		if (!key) {throw new ActionableError("鸿蒙当前不支持此按键: " + button);}
		this.shell("uitest", "uiInput", "keyEvent", key);
	}
	public async getScreenshot(): Promise<Buffer> {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-cli-hdc-"));
		const local = path.join(directory, "screen.png"), remote = "/data/local/tmp/mobile-cli-" + randomUUID() + ".png";
		try {
			this.shell("uitest", "screenCap", "-p", remote);
			this.hdc("file", "recv", remote, local);
			const buffer = fs.readFileSync(local);
			if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {throw new ActionableError("HDC 没有返回 PNG 截图");}
			return buffer;
		} finally {
			try { this.shell("rm", "-f", remote); } catch { /* 不覆盖截图失败。 */ }
			try { if (fs.existsSync(local)) {fs.unlinkSync(local);} } catch { /* 继续清理临时目录。 */ }
			try { fs.rmdirSync(directory); } catch { /* 临时文件清理尽力完成。 */ }
		}
	}
	public async listApps(): Promise<InstalledApp[]> {
		return this.shell("bm", "dump", "-a").split(/\r?\n/).filter(l => /^\s+[a-zA-Z][\w.]+\s*$/.test(l))
			.map(l => ({ packageName: l.trim(), appName: l.trim() }));
	}
	public async launchApp(packageName: string, locale?: string): Promise<void> {
		if (locale) {throw new ActionableError("HDC 暂不支持设置 App locale");}
		const value = this.shell("bm", "dump", "-n", packageName);
		const bundle = parseBmBundle(value);
		const modules = bundle.hapModuleInfos || [];
		const abilities = modules.flatMap((m: any) => m.abilities || m.abilityInfos || []);
		const ability = abilities.find((a: any) => a.name === "EntryAbility") || abilities.find((a: any) => a.type === 1);
		if (!ability) {throw new ActionableError("未找到可启动的鸿蒙 Ability");}
		await this.launchAbility(packageName, ability.name);
	}
	public async launchAbility(packageName: string, ability: string): Promise<void> {
		if (!/^[a-zA-Z0-9_.]+$/.test(packageName) || !/^[a-zA-Z0-9_.$]+$/.test(ability)) {throw new ActionableError("Bundle/Ability 名称无效");}
		const result = this.shell("aa", "start", "-b", packageName, "-a", ability);
		if (!/start ability successfully/i.test(result)) {throw new ActionableError(result);}
	}
	public async terminateApp(packageName: string): Promise<void> { this.shell("aa", "force-stop", packageName); }
	public async installApp(file: string): Promise<void> {
		if (!file.endsWith(".hap")) {throw new ActionableError("HDC 直装仅支持签名 HAP；卓易通 APK 请用 file-send 导入后在手机安装，不能当作 adb install");}
		this.hdc("install", path.resolve(file));
	}
	public async uninstallApp(packageName: string): Promise<void> { this.hdc("uninstall", packageName); }
	public async openUrl(_url: string): Promise<void> { throw new ActionableError("HDC openUrl 暂未验证，请通过目标 App 界面导航"); }
	public async setOrientation(_orientation: Orientation): Promise<void> { throw new ActionableError("鸿蒙方向设置暂未实现，请旋转真机，不修改全局显示参数"); }
	public async getOrientation(): Promise<Orientation> { const s = await this.getScreenSize(); return s.width > s.height ? "landscape" : "portrait"; }
	public wake(): string { return this.shell("power-shell", "wakeup"); }
	public keepAwake(seconds: number | "restore"): string {
		if (seconds === "restore") {return this.shell("power-shell", "timeout", "-r");}
		if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) {throw new ActionableError("keep-awake 秒数应在 1~86400 内");}
		return this.shell("power-shell", "timeout", "-o", String(Math.round(seconds * 1000)));
	}
	public powerState(): string { return this.shell("hidumper", "-s", "PowerManagerService", "-a", "-s"); }
	public fileSend(local: string, remote: string): string { return this.hdc("file", "send", path.resolve(local), remote).toString().trim(); }
	public fileRecv(remote: string, local: string): string { return this.hdc("file", "recv", remote, path.resolve(local)).toString().trim(); }
}

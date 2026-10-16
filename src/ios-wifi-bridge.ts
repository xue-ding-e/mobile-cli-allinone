// Reuse an explicitly selected, already-paired local transport. This adapter
// never creates pairing records, starts WDA, or changes tunnel/server state.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { IosRobot } from "./ios";
import { ActionableError, InstalledApp } from "./robot";
import { validatePackageName } from "./utils";

export interface IosWifiConfiguration {
	device: { udid: string; wdaUrl: string; lastWifiHost: string; model?: string; ios?: string };
	pythonRelative: string;
}

export const validateWdaUrl = (input: string): string => {
	const url = new URL(input);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
		throw new ActionableError("WDA URL must be an explicit HTTP(S) origin without credentials, path, query or fragment");
	}
	return url.origin;
};

export const readIosWifiConfiguration = (filename: string, device: string, endpoint?: string): IosWifiConfiguration => {
	const config = JSON.parse(fs.readFileSync(filename, "utf8")) as IosWifiConfiguration;
	if (!device || !config.device || config.device.udid !== device) {throw new ActionableError("iOS device does not match the explicit Wi-Fi configuration UDID");}
	if (!config.device.lastWifiHost || !config.pythonRelative) {throw new ActionableError("iOS Wi-Fi configuration requires its existing host and Python runtime");}
	const configured = validateWdaUrl(config.device.wdaUrl);
	if (endpoint && validateWdaUrl(endpoint) !== configured) {throw new ActionableError("WDA endpoint does not match the selected device configuration; verify its target before changing the configuration");}
	return { ...config, device: { ...config.device, wdaUrl: configured } };
};

// Bridge JSON is evidence from the authenticated transport, not a substitute
// for it. Missing identity, failed commands and missing success records fail.
export const parseIosBridgeResult = (stdout: string, udid: string, action: "probe" | "launch" | "install", bundle?: string): Record<string, unknown> => {
	const records: Record<string, unknown>[] = [];
	for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
		try {const item = JSON.parse(line); if (item && typeof item === "object") {records.push(item);}} catch { /* Transport libraries may emit diagnostic lines. */ }
	}
	const identities = records.filter(record => record.udid !== undefined);
	if (!identities.length || identities.some(record => record.udid !== udid)) {throw new ActionableError("Authenticated iOS bridge returned a missing or mismatched device identity");}
	const result = records.find(record => action === "probe"
		? record.result === "CONNECTED"
		: action === "launch" ? record.action === "launch" && record.bundle === bundle && Number.isInteger(record.pid) && Number(record.pid) > 0
			: record.result === "INSTALLED_AND_LOOKED_UP" && record.bundle === bundle && record.udid === udid);
	if (!result) {throw new ActionableError(`iOS bridge did not confirm ${action}`);}
	return result;
};

export class IosWifiRobot extends IosRobot {
	private readonly config: IosWifiConfiguration;
	private readonly directory: string;
	private readonly bridgeDirectory: string;
	private verified?: Promise<void>;
	public constructor(private readonly udid: string, configPath: string, private readonly installBundle?: string, endpoint?: string) {
		const config = readIosWifiConfiguration(configPath, udid, endpoint);
		// The existing per-device configuration binds WDA to the paired UDID.
		// A fresh transport probe validates that identity once per CLI process.
		super(udid, { wdaUrl: config.device.wdaUrl, verifyDevice: () => this.verify() });
		this.config = config;
		this.directory = path.dirname(path.resolve(configPath));
		const bridgeFiles = ["device.py", "identity_probe.py", "install_wifi.py"];
		this.bridgeDirectory = bridgeFiles.every(name => fs.existsSync(path.join(this.directory, name)))
			? this.directory : path.resolve(__dirname, "../scripts/ios-wifi-bridge");
	}
	private invoke(action: "probe" | "launch" | "install", bundle?: string, packagePath?: string): Record<string, unknown> {
		const script = path.join(this.bridgeDirectory, action === "install" ? "install_wifi.py" : action === "probe" ? "identity_probe.py" : "device.py");
		const python = path.resolve(this.directory, this.config.pythonRelative);
		if (!fs.existsSync(python) || !fs.existsSync(script)) {throw new ActionableError("Existing iOS Wi-Fi bridge or Python runtime was not found; configure Python and install the optional Wi-Fi requirements");}
		const args = action === "install"
			? [script, "--udid", this.udid, "--host", this.config.device.lastWifiHost, "--package", packagePath!, "--bundle", bundle!]
			: [script, ...(action === "probe" ? [] : [action]), "--udid", this.udid, "--host", this.config.device.lastWifiHost, ...(bundle ? ["--bundle", bundle] : [])];
		const stdout = execFileSync(python, ["-X", "utf8", ...args], { encoding: "utf8", windowsHide: true, timeout: action === "install" ? 190_000 : 50_000, maxBuffer: 2 * 1024 * 1024 });
		return parseIosBridgeResult(stdout, this.udid, action, bundle);
	}
	private async verify(): Promise<void> {
		this.verified ??= Promise.resolve().then(() => {this.invoke("probe");});
		await this.verified;
	}
	public async probe(): Promise<Record<string, unknown>> {
		await this.verify();
		return { id: this.udid, name: this.config.device.model, version: this.config.device.ios, platform: "ios", status: "CONNECTED", wdaStatus: "NOT_CHECKED", backend: "pymobiledevice3-existing-wifi-bridge+WDA", wdaUrl: this.config.device.wdaUrl };
	}
	public override async getIosVersion(): Promise<string> {await this.verify(); return this.config.device.ios || "unknown";}
	public override async launchApp(bundle: string, locale?: string): Promise<void> {
		validatePackageName(bundle);
		if (locale) {throw new ActionableError("Existing Wi-Fi bridge does not implement launch locale overrides");}
		this.invoke("launch", bundle);
	}
	public override async installApp(packagePath: string): Promise<void> {
		if (!this.installBundle) {throw new ActionableError("iOS Wi-Fi install requires --pkg <bundle-id> for authenticated installation read-back");}
		validatePackageName(this.installBundle);
		this.invoke("install", this.installBundle, path.resolve(packagePath));
	}
	public override async listApps(): Promise<InstalledApp[]> {throw new ActionableError("Existing Wi-Fi bridge does not implement apps; go-ios backend is required");}
	public override async terminateApp(_bundle: string): Promise<void> {throw new ActionableError("Existing Wi-Fi bridge does not implement stop");}
	public override async uninstallApp(_bundle: string): Promise<void> {throw new ActionableError("Existing Wi-Fi bridge does not implement uninstall");}
}

// A WDA status response contains no Simulator UDID. Join its live listener to
// the exact simctl app container before allowing any HTTP request or session.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ActionableError } from "./robot";
import { WebDriverAgent, WebDriverStatusDiagnostic } from "./webdriver-agent";

export interface SimulatorWdaConfiguration {
	schemaVersion: 1;
	simulatorUuid: string;
	wdaOrigin: string;
	runner: {
		bundleId: string;
		pid: number;
		processStart: string;
		executableSha256: string;
		wdaProductBundleIdentifier: string;
		codeFiles: Array<{ relativePath: string; sha256: string; mappedPath?: string }>;
	};
}

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const hashPattern = /^[0-9a-f]{64}$/;
const bundlePattern = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;
const normalizedSpace = (value: string) => value.trim().replace(/\s+/g, " ");
const fail = (reason: string): never => {throw new ActionableError(`Simulator WDA binding failed: ${reason}`);};
const isTestExecutable = (filename: string) => /^PlugIns\/[^/]+\.xctest\/[^/]+$/.test(filename);
const isWdaFramework = (filename: string) => /^PlugIns\/[^/]+\.xctest\/Frameworks\/WebDriverAgentLib\.framework\/WebDriverAgentLib$/.test(filename);

export function readSimulatorWdaConfiguration(filename: string, explicitUuid: string): SimulatorWdaConfiguration {
	if (!uuidPattern.test(explicitUuid)) {fail("an explicit simulator UUID is required");}
	const config = JSON.parse(readFileSync(filename, "utf8")) as SimulatorWdaConfiguration;
	if (!config || config.schemaVersion !== 1 || config.simulatorUuid !== explicitUuid) {fail("configuration does not match the explicit simulator UUID");}
	let origin: URL;
	try {origin = new URL(config.wdaOrigin);} catch {return fail("wdaOrigin must be an explicit dedicated loopback HTTP origin");}
	if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || !origin.port || Number(origin.port) < 1 || origin.port === "8100" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
		fail("wdaOrigin must use a dedicated numeric loopback port other than shared 8100");
	}
	const runner = config.runner;
	if (!runner || typeof runner.bundleId !== "string" || !bundlePattern.test(runner.bundleId) || !runner.bundleId.endsWith(".xctrunner") || typeof runner.wdaProductBundleIdentifier !== "string" || !bundlePattern.test(runner.wdaProductBundleIdentifier)
		|| !Number.isSafeInteger(runner.pid) || runner.pid < 1 || typeof runner.processStart !== "string" || !normalizedSpace(runner.processStart) || !hashPattern.test(runner.executableSha256)) {
		fail("runner requires its bundle, live PID/start, executable SHA256 and WDA product identity");
	}
	if (!Array.isArray(runner.codeFiles) || runner.codeFiles.length < 1 || runner.codeFiles.length > 128) {fail("runner requires a bounded list of installed WDA code files");}
	const paths = new Set<string>();
	for (const file of runner.codeFiles) {
		if (!file || typeof file.relativePath !== "string" || !file.relativePath || file.relativePath.includes("\\") || file.relativePath.includes("\0")
			|| path.posix.isAbsolute(file.relativePath) || file.relativePath.split("/").some(part => !part || part === "." || part === "..") || !hashPattern.test(file.sha256) || paths.has(file.relativePath)) {
			fail("codeFiles must contain unique contained relative paths and SHA256 values");
		}
		paths.add(file.relativePath);
		if ((isTestExecutable(file.relativePath) || isWdaFramework(file.relativePath)) && !file.mappedPath) {fail("critical WDA code requires an explicit live mappedPath");}
		if (file.mappedPath !== undefined && (typeof file.mappedPath !== "string" || !path.isAbsolute(file.mappedPath) || file.mappedPath.includes("\0") || /[\r\n]/.test(file.mappedPath))) {fail("mappedPath must be an absolute code file path");}
	}
	if (!runner.codeFiles.some(file => isTestExecutable(file.relativePath))) {fail("codeFiles must include the WDA XCTest executable, not only its runner shell");}
	if (!runner.codeFiles.some(file => isWdaFramework(file.relativePath))) {fail("codeFiles must include the WebDriverAgentLib framework executable");}
	return { ...config, wdaOrigin: origin.origin, runner: { ...runner, processStart: normalizedSpace(runner.processStart), codeFiles: runner.codeFiles.map(file => ({ ...file })) } };
}

export class SimulatorWdaBinding {
	private readonly config: SimulatorWdaConfiguration;
	constructor(private readonly simulatorUuid: string, filename: string) {
		this.config = readSimulatorWdaConfiguration(filename, simulatorUuid);
	}
	private command(executable: string, args: string[]): string {
		return execFileSync(executable, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }).trim();
	}
	public verifyCurrentProcess(): void {
		if (process.platform !== "darwin") {fail("owned Simulator WDA verification must run on macOS");}
		const { runner } = this.config;
		const port = new URL(this.config.wdaOrigin).port;
		const listener = this.command("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
		const pids = new Set<number>();
		let currentPid: number | undefined;
		for (const line of listener.split(/\r?\n/).filter(Boolean)) {
			if (/^p[1-9][0-9]*$/.test(line)) {
				currentPid = Number(line.slice(1));
				pids.add(currentPid);
			} else if (!/^f[0-9]+$/.test(line) || currentPid === undefined) {
				fail("listener lookup returned an unexpected record");
			}
			// macOS lsof emits implicit f<descriptor> records with -Fp.
			// These are file records for the preceding PID, not more PIDs.
		}
		if (pids.size !== 1 || !pids.has(runner.pid)) {fail("dedicated port listener does not match the owned runner PID");}
		const start = this.command("/bin/ps", ["-p", String(runner.pid), "-o", "lstart="]);
		if (normalizedSpace(start) !== runner.processStart) {fail("owned runner process start changed or PID was reused");}
		const executable = this.command("/bin/ps", ["-p", String(runner.pid), "-o", "comm="]);
		const container = realpathSync(this.command("xcrun", ["simctl", "get_app_container", this.simulatorUuid, runner.bundleId, "app"]));
		const info = JSON.parse(this.command("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(container, "Info.plist")])) as { CFBundleIdentifier?: unknown; CFBundleExecutable?: unknown };
		if (info.CFBundleIdentifier !== runner.bundleId || typeof info.CFBundleExecutable !== "string" || !/^[A-Za-z0-9_.-]+$/.test(info.CFBundleExecutable) || [".", ".."].includes(info.CFBundleExecutable)) {fail("installed runner Info.plist identity is invalid");}
		const main = this.containedFile(container, info.CFBundleExecutable as string);
		if (!path.isAbsolute(executable) || realpathSync(executable) !== main) {fail("listener executable is not the runner installed in the selected simulator");}
		const textFiles = new Set<string>();
		let ownedProcess = false;
		let textDescriptor = false;
		for (const line of this.command("/usr/sbin/lsof", ["-a", "-p", String(runner.pid), "-d", "txt", "-Fn"]).split(/\r?\n/).filter(Boolean)) {
			if (line === `p${runner.pid}`) {ownedProcess = true; textDescriptor = false;} else if (line === "ftxt" && ownedProcess) {textDescriptor = true;} else if (line.startsWith("n") && textDescriptor) {
				try {textFiles.add(realpathSync(line.slice(1)));} catch { /* An unrelated system mapping may no longer have an on-disk name. */ }
			} else {fail("text mapping lookup returned a foreign process or unexpected record");}
		}
		if (!textFiles.has(main)) {fail("live runner text mappings do not contain the installed executable");}
		this.assertHash(main, runner.executableSha256);
		for (const file of runner.codeFiles) {
			this.assertHash(this.containedFile(container, file.relativePath), file.sha256);
			if (file.mappedPath) {
				// XCTest may load its framework from an exclusive DerivedData
				// directory. Verify the live mapping's bytes as well as the app.
				const loaded = realpathSync(file.mappedPath);
				if (!textFiles.has(loaded) || !statSync(loaded).isFile()) {fail("expected WDA code is not mapped by the live runner");}
				this.assertHash(loaded, file.sha256);
			}
		}
		// Close the process/port check around file reads. This cannot make an OS
		// process immutable, but rejects a restart observed during verification.
		if (this.command("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]) !== listener
			|| normalizedSpace(this.command("/bin/ps", ["-p", String(runner.pid), "-o", "lstart="])) !== runner.processStart) {fail("runner changed during live verification");}
	}
	private containedFile(container: string, relativePath: string): string {
		const filename = realpathSync(path.join(container, relativePath));
		const relative = path.relative(container, filename);
		if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) || !statSync(filename).isFile()) {return fail("runner code file escapes its selected simulator container");}
		return filename;
	}
	private assertHash(filename: string, expected: string): void {
		if (createHash("sha256").update(readFileSync(filename)).digest("hex") !== expected) {fail("installed runner code SHA256 does not match the owned build");}
	}
	public createClient(): WebDriverAgent {
		const origin = new URL(this.config.wdaOrigin);
		return new WebDriverAgent(origin.hostname, Number(origin.port), { verifyTarget: () => this.verifyCurrentProcess() });
	}
	public async assertHttpIdentity(client: WebDriverAgent, diagnostic?: WebDriverStatusDiagnostic): Promise<void> {
		const status = diagnostic ?? await client.getStatusDiagnostic();
		if (!status.ok) {
			const error = new ActionableError(`Simulator WDA is not ready: ${status.networkError ?? status.protocolError ?? "response value.ready is not true"}`);
			Object.defineProperty(error, "statusDiagnostic", { value: status, enumerable: true });
			throw error;
		}
		const body = status.parsedJSON as { value?: { build?: { productBundleIdentifier?: unknown } } } | undefined;
		if (body?.value?.build?.productBundleIdentifier !== this.config.runner.wdaProductBundleIdentifier) {fail("HTTP status build product does not match the owned WDA build");}
		const info = await client.requestJson("/wda/device/info");
		if (info.value?.isSimulator !== true) {fail("HTTP device info does not confirm a simulator; vendor UUID is not a simulator UDID");}
	}
}

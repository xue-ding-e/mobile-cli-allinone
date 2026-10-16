import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const modulePath = path.resolve(__dirname, "../lib/simulator-wda-binding.js");
const uuid = "00000000-0000-4000-8000-000000000001";
type Scenario = { action?: string; mutation?: string; explicitUuid?: string; platform?: string; http?: string };
type Result = { ok: boolean; error?: string; calls: string[]; fetches: string[]; events: string[]; nativeShots: number; value?: any };

// OS commands are stubbed before requiring the actual compiled implementation.
// Only this test's temporary app bundle is read. No Mac, simulator or HTTP
// server is contacted; undeclared commands and requests fail immediately.
const harness = `
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const prefix = path.join(os.tmpdir(), "simulator-wda-binding-");
const root = fs.mkdtempSync(prefix);
const app = path.join(root, "Fixture.app");
const mainName = "FixtureRunner";
const mainPath = path.join(app, mainName);
const testRelative = "PlugIns/FixtureTests.xctest/FixtureTests";
const frameworkRelative = "PlugIns/FixtureTests.xctest/Frameworks/WebDriverAgentLib.framework/WebDriverAgentLib";
const testPath = path.join(app, ...testRelative.split("/"));
const frameworkPath = path.join(app, ...frameworkRelative.split("/"));
const external = path.join(root, "external-code");
const configPath = path.join(root, "binding.json");
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const mainBytes = Buffer.from("fake owned runner executable");
const testBytes = Buffer.from("fake owned XCTest executable");
const frameworkBytes = Buffer.from("fake owned WDA framework executable");
fs.mkdirSync(path.dirname(testPath), { recursive: true });
fs.mkdirSync(path.dirname(frameworkPath), { recursive: true });
fs.writeFileSync(mainPath, mainBytes);
fs.writeFileSync(testPath, testBytes);
fs.writeFileSync(frameworkPath, frameworkBytes);
fs.writeFileSync(external, testBytes);
const config = {
  schemaVersion: 1,
  simulatorUuid: "00000000-0000-4000-8000-000000000001",
  wdaOrigin: "http://127.0.0.1:18173",
  runner: {
    bundleId: "dev.example.fixture.xctrunner", pid: 42424,
    processStart: "Mon Jan  1 00:00:00 2024",
    executableSha256: hash(mainBytes),
    wdaProductBundleIdentifier: "dev.example.fixture.runner",
    codeFiles: [
      { relativePath: mainName, sha256: hash(mainBytes) },
      { relativePath: testRelative, mappedPath: testPath, sha256: hash(testBytes) },
      { relativePath: frameworkRelative, mappedPath: frameworkPath, sha256: hash(frameworkBytes) },
    ],
  },
};
const info = { CFBundleIdentifier: config.runner.bundleId, CFBundleExecutable: mainName };
// macOS lsof -Fp includes implicit file-descriptor records, even though p
// is the only requested field. Captured OS shape, with a synthetic PID.
let listener = "p42424\\nf8\\n";
let start = config.runner.processStart + "\\n";
let processExecutable = mainPath + "\\n";
let mappings = [mainPath, testPath, frameworkPath];
let listenerReads = 0;
let startReads = 0;
const calls = [];
const fetches = [];
const events = [];
let nativeShots = 0;
switch (input.mutation) {
  case "wrong-schema": config.schemaVersion = 2; break;
  case "missing-uuid": delete config.simulatorUuid; break;
  case "non-uuid": config.simulatorUuid = "not-a-uuid"; break;
  case "missing-origin": delete config.wdaOrigin; break;
  case "shared-8100": config.wdaOrigin = "http://127.0.0.1:8100"; break;
  case "implicit-port": config.wdaOrigin = "http://127.0.0.1"; break;
  case "dns-localhost": config.wdaOrigin = "http://localhost:18173"; break;
  case "foreign-host": config.wdaOrigin = "http://192.0.2.7:18173"; break;
  case "wildcard": config.wdaOrigin = "http://0.0.0.0:18173"; break;
  case "origin-credentials": config.wdaOrigin = "http://user:placeholder@127.0.0.1:18173"; break;
  case "origin-path": config.wdaOrigin = "http://127.0.0.1:18173/wda"; break;
  case "origin-query": config.wdaOrigin = "http://127.0.0.1:18173?foo=bar"; break;
  case "origin-fragment": config.wdaOrigin = "http://127.0.0.1:18173#fragment"; break;
  case "origin-protocol": config.wdaOrigin = "ftp://127.0.0.1:18173"; break;
  case "zero-port": config.wdaOrigin = "http://127.0.0.1:0"; break;
  case "ipv6": config.wdaOrigin = "http://[::1]:18173"; break;
  case "missing-runner": delete config.runner; break;
  case "bad-pid": config.runner.pid = 0; break;
  case "missing-start": delete config.runner.processStart; break;
  case "bad-executable-sha": config.runner.executableSha256 = "not-a-sha"; break;
  case "bad-code-sha": config.runner.codeFiles[1].sha256 = "not-a-sha"; break;
  case "missing-product": delete config.runner.wdaProductBundleIdentifier; break;
  case "relative-escape": config.runner.codeFiles[1].relativePath = "../external-code"; break;
  case "absolute-code-path": config.runner.codeFiles[1].relativePath = external; break;
  case "missing-xctest-entry": config.runner.codeFiles.splice(1, 1); break;
  case "missing-framework-entry": config.runner.codeFiles.splice(2, 1); break;
  case "missing-mapped-path": delete config.runner.codeFiles[1].mappedPath; break;
  case "relative-mapped-path": config.runner.codeFiles[1].mappedPath = "relative-code"; break;
  case "stale-pid": listener = "p42425\\n"; break;
  case "multiple-listeners": listener = "p42424\\np42425\\n"; break;
  case "no-listener": listener = ""; break;
  case "malformed-descriptor": listener = "p42424\\nf8unknown\\n"; break;
  case "descriptor-before-pid": listener = "f8\\np42424\\n"; break;
  case "unexpected-listener-record": listener = "p42424\\nzunknown\\n"; break;
  case "multiple-listeners-with-descriptors": listener = "p42424\\nf8\\np42425\\nf9\\n"; break;
  case "stale-start": start = "Tue Jan  2 00:00:00 2024\\n"; break;
  case "wrong-executable": processExecutable = external + "\\n"; break;
  case "missing-main-file": fs.unlinkSync(mainPath); break;
  case "missing-xctest-file": fs.unlinkSync(testPath); break;
  case "changed-main-hash": fs.writeFileSync(mainPath, "changed runner"); break;
  case "changed-xctest-hash": fs.writeFileSync(testPath, "changed XCTest"); break;
  case "changed-framework-hash": fs.writeFileSync(frameworkPath, "changed framework"); break;
  case "wrong-bundle": info.CFBundleIdentifier = "dev.example.other.xctrunner"; break;
  case "unsafe-executable": info.CFBundleExecutable = "../external-code"; break;
  case "missing-main-mapping": mappings = [testPath, frameworkPath]; break;
  case "foreign-mapping": mappings = [mainPath, external, frameworkPath]; break;
  case "changed-loaded-hash":
    fs.writeFileSync(external, "different loaded XCTest code");
    config.runner.codeFiles[1].mappedPath = external;
    mappings = [mainPath, external, frameworkPath];
    break;
  case "derived-data-mapping":
    fs.writeFileSync(external, testBytes);
    config.runner.codeFiles[1].mappedPath = external;
    mappings = [mainPath, external, frameworkPath];
    break;
}
fs.writeFileSync(path.join(app, "Info.plist"), JSON.stringify(info));
fs.writeFileSync(configPath, JSON.stringify(config));
const originalRealpath = fs.realpathSync;
const fixtureRealpath = (filename, ...rest) => {
  if (input.mutation === "realpath-escape" && path.resolve(String(filename)) === testPath) return external;
  return originalRealpath(filename, ...rest);
};
fixtureRealpath.native = fixtureRealpath;
fs.realpathSync = fixtureRealpath;
cp.execFileSync = (command, args) => {
  calls.push(command);
  if (command === "/usr/sbin/lsof" && JSON.stringify(args) === JSON.stringify(["-nP", "-iTCP:18173", "-sTCP:LISTEN", "-Fp"])) {
    listenerReads++;
    return input.mutation === "restart-during-proof" && listenerReads > 1 ? "p42425\\n" : listener;
  }
  if (command === "/usr/sbin/lsof" && JSON.stringify(args) === JSON.stringify(["-a", "-p", "42424", "-d", "txt", "-Fn"])) return (input.mutation === "foreign-text-pid" ? "p42425\\n" : "p42424\\n") + (input.mutation === "unexpected-text-record" ? "zunknown\\n" : "") + mappings.map(filename => "ftxt\\nn" + filename).join("\\n") + "\\n";
  if (command === "/bin/ps" && JSON.stringify(args) === JSON.stringify(["-p", "42424", "-o", "lstart="])) {
    startReads++;
    return input.mutation === "start-changes-during-proof" && startReads > 1 ? "Wed Jan  3 00:00:00 2024\\n" : start;
  }
  if (command === "/bin/ps" && JSON.stringify(args) === JSON.stringify(["-p", "42424", "-o", "comm="])) return processExecutable;
  if (command === "xcrun" && JSON.stringify(args) === JSON.stringify(["simctl", "get_app_container", "00000000-0000-4000-8000-000000000001", "dev.example.fixture.xctrunner", "app"])) return app + "\\n";
  if (command === "xcrun" && args[0] === "simctl" && args[1] === "io" && args[2] === "00000000-0000-4000-8000-000000000001" && args[3] === "screenshot" && args[4] === "--type=png" && args.length === 6) {
    nativeShots++;
    events.push("native screenshot explicit UUID");
    const capturePath = path.resolve(args[5]);
    const directory = path.dirname(capturePath);
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("mobile-sim-shot-")) throw new Error("UNOWNED_SCREENSHOT_OUTPUT");
    fs.writeFileSync(capturePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64"));
    return Buffer.alloc(0);
  }
  if (command === "/usr/bin/plutil" && JSON.stringify(args) === JSON.stringify(["-convert", "json", "-o", "-", path.join(app, "Info.plist")])) return JSON.stringify(info);
  throw new Error("UNDECLARED_OS_COMMAND: " + command + " " + JSON.stringify(args));
};
Object.defineProperty(process, "platform", { value: input.platform || "darwin" });
global.fetch = async (url, init) => {
  const target = new URL(String(url));
  const pathname = target.pathname;
  fetches.push(pathname + target.search);
  events.push("HTTP " + pathname + target.search);
  if (pathname === "/status") return Response.json({ value: { ready: input.http !== "not-ready",
    build: { productBundleIdentifier: input.http === "wrong-product" ? "dev.example.other.runner" : "dev.example.fixture.runner" } } });
  if (pathname === "/wda/device/info") return Response.json({ value: { isSimulator: input.http !== "physical-device", uuid: "FAKE_VENDOR_IDENTIFIER_IS_NOT_SIMULATOR_UDID" } });
  if (pathname === "/session" && init && init.method === "POST") return Response.json({ value: { sessionId: "owned-case-session" } });
  if (pathname === "/session/owned-case-session" && init && init.method === "DELETE") return Response.json({ value: null });
  if (pathname === "/session/owned-case-session/wda/screen") return Response.json({ value: { screenSize: { width: 390, height: 844 }, scale: 3 } });
  if (pathname === "/session/owned-case-session/source" && target.search === "?format=json") return Response.json({ value: {
    type: "Application", rect: { x: 0, y: 0, width: 390, height: 844 }, children: [{ type: "Button", name: "FixtureButton", label: "FixtureButton", isVisible: "1", rect: { x: 10, y: 20, width: 100, height: 40 } }]
  } });
  throw new Error("UNDECLARED_HTTP_REQUEST: " + pathname);
};
(async () => {
  let result;
  try {
    const api = require(process.argv[1]);
    const explicitUuid = input.explicitUuid === undefined ? "00000000-0000-4000-8000-000000000001" : input.explicitUuid;
    if (input.action === "read") result = { ok: true, value: api.readSimulatorWdaConfiguration(configPath, explicitUuid) };
    else if (input.action === "simctl-capture") {
      const { Simctl } = require(path.join(path.dirname(process.argv[1]), "iphone-simulator.js"));
      const capture = await new Simctl(explicitUuid, configPath).captureScreen();
      result = { ok: true, value: { size: capture.size, elements: capture.elements, screenshotBytes: capture.screenshot.length,
        signature: capture.screenshot.subarray(0, 8).toString("hex") } };
    }
    else {
      const binding = new api.SimulatorWdaBinding(explicitUuid, configPath);
      if (input.action === "http") await binding.assertHttpIdentity(binding.createClient());
      else if (input.action === "request-guard") {
        const client = binding.createClient();
        await client.requestJson("/status");
        const before = fetches.length;
        start = "Wed Jan  3 00:00:00 2024\\n";
        let rejected = false;
        try { await client.requestJson("/status"); } catch { rejected = true; }
        if (!rejected || fetches.length !== before) throw new Error("STALE_PROCESS_REACHED_HTTP");
      } else binding.verifyCurrentProcess();
      result = { ok: true };
    }
  } catch (error) { result = { ok: false, error: String(error && error.stack || error) }; }
  finally {
    fs.realpathSync = originalRealpath;
    if (!path.resolve(root).startsWith(path.resolve(prefix))) throw new Error("UNSAFE_TEST_CLEANUP");
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify({ ...result, calls, fetches, events, nativeShots }));
})().catch(error => { process.stderr.write(String(error)); process.exitCode = 2; });
`;

function runScenario(scenario: Scenario = {}): Result {
	const result = spawnSync(process.execPath, ["-e", harness, modulePath], {
		input: JSON.stringify(scenario), encoding: "utf8", windowsHide: true, timeout: 10000,
	});
	expect(result.error, result.stderr).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout);
}

function rejected(result: Result) {
	expect(result.ok, result.error).toBe(false);
	expect(result.error).toBeTruthy();
	expect(result.error).not.toContain("Cannot find module");
	expect(result.error).not.toContain("UNDECLARED_OS_COMMAND");
}

test("current owned runner process and installed code verify without HTTP", () => {
	const result = runScenario();
	expect(result.ok, result.error).toBe(true);
	expect(result.fetches).toEqual([]);
	expect(result.calls).toEqual(expect.arrayContaining(["/usr/sbin/lsof", "/bin/ps", "xcrun", "/usr/bin/plutil"]));
});

test("valid explicit configuration is read without OS or HTTP access", () => {
	const result = runScenario({ action: "read" });
	expect(result.ok, result.error).toBe(true);
	expect(result.value).toMatchObject({ schemaVersion: 1, simulatorUuid: uuid, wdaOrigin: "http://127.0.0.1:18173" });
	expect(result.calls).toEqual([]);
	expect(result.fetches).toEqual([]);
});

for (const mutation of ["wrong-schema", "missing-uuid", "non-uuid", "missing-origin", "shared-8100", "implicit-port", "dns-localhost", "foreign-host", "wildcard",
	"origin-credentials", "origin-path", "origin-query", "origin-fragment", "origin-protocol", "zero-port", "missing-runner", "bad-pid", "missing-start",
	"bad-executable-sha", "bad-code-sha", "missing-product", "relative-escape", "absolute-code-path", "missing-xctest-entry", "missing-framework-entry", "missing-mapped-path", "relative-mapped-path"]) {
	test(`configuration rejects ${mutation} before OS or HTTP`, () => {
		const result = runScenario({ action: "read", mutation });
		rejected(result);
		expect(result.calls).toEqual([]);
		expect(result.fetches).toEqual([]);
	});
}

for (const explicitUuid of ["", "not-a-uuid", "00000000-0000-4000-8000-000000000002"]) {
	test(`explicit UUID is required and exact: ${explicitUuid || "missing"}`, () => {
		const result = runScenario({ action: "read", explicitUuid });
		rejected(result);
		expect(result.calls).toEqual([]);
	});
}

test("numeric IPv6 loopback with a dedicated explicit port is accepted", () => {
	const result = runScenario({ action: "read", mutation: "ipv6" });
	expect(result.ok, result.error).toBe(true);
});

for (const mutation of ["stale-pid", "multiple-listeners", "no-listener", "malformed-descriptor", "descriptor-before-pid", "unexpected-listener-record", "multiple-listeners-with-descriptors", "foreign-text-pid", "unexpected-text-record", "stale-start", "wrong-executable", "missing-main-file", "missing-xctest-file",
	"changed-main-hash", "changed-xctest-hash", "changed-framework-hash", "wrong-bundle", "unsafe-executable", "missing-main-mapping", "foreign-mapping",
	"changed-loaded-hash", "realpath-escape", "restart-during-proof", "start-changes-during-proof"]) {
	test(`current runtime proof rejects ${mutation} without HTTP`, () => {
		const result = runScenario({ mutation });
		rejected(result);
		expect(result.fetches).toEqual([]);
	});
}

test("matching explicitly owned DerivedData code mappings are accepted", () => {
	const result = runScenario({ mutation: "derived-data-mapping" });
	expect(result.ok, result.error).toBe(true);
});

test("non-macOS runtime proof fails without fallback or OS commands", () => {
	const result = runScenario({ platform: "linux" });
	rejected(result);
	expect(result.calls).toEqual([]);
	expect(result.fetches).toEqual([]);
});

test("HTTP identity accepts only the bound product and a simulator", () => {
	const result = runScenario({ action: "http" });
	expect(result.ok, result.error).toBe(true);
	expect(result.fetches).toEqual(["/status", "/wda/device/info"]);
});

for (const http of ["not-ready", "wrong-product", "physical-device"]) {
	test(`HTTP identity rejects ${http} without touching a session`, () => {
		const result = runScenario({ action: "http", http });
		rejected(result);
		expect(result.fetches.every(route => route === "/status" || route === "/wda/device/info")).toBe(true);
	});
}

test("every request rechecks the runtime and rejects stale identity before fetch", () => {
	const result = runScenario({ action: "request-guard" });
	expect(result.ok, result.error).toBe(true);
	expect(result.fetches).toEqual(["/status"]);
});

test("actual Simctl capture joins owned WDA reads with an explicit UUID native screenshot", () => {
	const result = runScenario({ action: "simctl-capture" });
	expect(result.ok, result.error).toBe(true);
	expect(result.value).toMatchObject({ size: { width: 390, height: 844, scale: 3 },
		elements: [{ type: "Button", label: "FixtureButton" }], signature: "89504e470d0a1a0a" });
	expect(result.value.screenshotBytes).toBeGreaterThan(24);
	expect(result.fetches).toEqual(["/status", "/wda/device/info", "/session", "/session/owned-case-session/wda/screen",
		"/session/owned-case-session/source?format=json", "/session/owned-case-session"]);
	// The screenshot comes from the explicit simctl UUID, not a WDA screenshot.
	expect(result.fetches.some(target => target.includes("screenshot"))).toBe(false);
	expect(result.nativeShots).toBe(1);
	expect(result.events).toEqual(["HTTP /status", "HTTP /wda/device/info", "HTTP /session", "HTTP /session/owned-case-session/wda/screen",
		"HTTP /session/owned-case-session/source?format=json", "native screenshot explicit UUID", "HTTP /session/owned-case-session"]);
});

test("actual Simctl rejects the wrong HTTP product before session creation or native screenshot", () => {
	const result = runScenario({ action: "simctl-capture", http: "wrong-product" });
	rejected(result);
	expect(result.fetches).toEqual(["/status"]);
	expect(result.nativeShots).toBe(0);
});

const cliPath = path.resolve(__dirname, "../lib/cli.js");
const cliHarness = `
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const prefix = path.join(os.tmpdir(), "simulator-wda-cli-");
const root = fs.mkdtempSync(prefix);
const configPath = path.join(root, "binding.json");
const flowPath = path.join(root, "foreign-flow.json");
const fakeHash = "0".repeat(64);
fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1,
 simulatorUuid: "00000000-0000-4000-8000-000000000001", wdaOrigin: "http://127.0.0.1:18173",
 runner: { bundleId: "dev.example.fixture.xctrunner", pid: 42424, processStart: "fake owned process start",
 executableSha256: fakeHash, wdaProductBundleIdentifier: "dev.example.fixture.runner", codeFiles: [
 { relativePath: "FixtureRunner", sha256: fakeHash },
 { relativePath: "PlugIns/FixtureTests.xctest/FixtureTests", mappedPath: path.join(root, "mapped-test"), sha256: fakeHash },
 { relativePath: "PlugIns/FixtureTests.xctest/Frameworks/WebDriverAgentLib.framework/WebDriverAgentLib", mappedPath: path.join(root, "mapped-framework"), sha256: fakeHash },
 ] } }));
fs.writeFileSync(flowPath, JSON.stringify([{ op: "tap", device: "00000000-0000-4000-8000-000000000002", x: 10, y: 20 }]));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.MOBILEMCP_DISABLE_TELEMETRY = "1";
Object.defineProperty(process, "platform", { value: "darwin" });
cp.execFileSync = () => { throw new Error("UNEXPECTED_DEVICE_COMMAND"); };
global.fetch = async () => { throw new Error("UNEXPECTED_HTTP_REQUEST"); };
process.on("exit", () => {
 if (!path.resolve(root).startsWith(path.resolve(prefix))) throw new Error("UNSAFE_TEST_CLEANUP");
 fs.rmSync(root, { recursive: true, force: true });
});
const args = input.args.map(arg => arg === "CONFIG" ? configPath : arg === "FLOW" ? flowPath : arg === "MISSING_CONFIG" ? path.join(root, "missing.json") : arg);
process.argv = [process.execPath, process.argv[1], ...args];
require(process.argv[1]);
`;

function rejectedCli(args: string[]) {
	const result = spawnSync(process.execPath, ["-e", cliHarness, cliPath], {
		input: JSON.stringify({ args }), encoding: "utf8", windowsHide: true, timeout: 10000,
	});
	expect(result.error, result.stderr).toBeUndefined();
	expect(result.status, result.stdout + result.stderr).toBe(1);
	expect(result.stdout + result.stderr).not.toContain("UNEXPECTED_DEVICE_COMMAND");
	expect(result.stdout + result.stderr).not.toContain("UNEXPECTED_HTTP_REQUEST");
	expect(result.stdout + result.stderr).not.toContain("Cannot find module");
	return result;
}

for (const operation of [["screen-size"], ["elements"], ["tap", "10", "20"]]) {
	test(`CLI ${operation[0]} without binding fails before WDA or autostart`, () => {
		const result = rejectedCli([...operation, "--platform", "ios-simulator", "--device", uuid]);
		expect(result.stderr).toContain("--simulator-wda-config");
	});
}

test("CLI rejects a simulator WDA config on another platform before dispatch", () => {
	const result = rejectedCli(["elements", "--platform", "android", "--device", uuid, "--simulator-wda-config", "CONFIG"]);
	expect(result.stderr).toContain("ios-simulator");
});

test("CLI rejects a missing simulator WDA config file before OS or HTTP", () => {
	const result = rejectedCli(["elements", "--platform", "ios-simulator", "--device", uuid, "--simulator-wda-config", "MISSING_CONFIG"]);
	expect(result.stderr).toContain("ENOENT");
});

test("CLI binding requires an explicit UUID rather than a saved device", () => {
	const result = rejectedCli(["elements", "--platform", "ios-simulator", "--simulator-wda-config", "CONFIG"]);
	expect(result.stderr).toContain("--device");
});

test("CLI flow cannot switch from the bound simulator to a foreign serial", () => {
	const result = rejectedCli(["flow-run", "FLOW", "--platform", "ios-simulator", "--device", uuid, "--simulator-wda-config", "CONFIG"]);
	expect(result.stdout + result.stderr).toContain("does not match the explicit simulator UUID");
});

test("CLI key submit freezes one binding and refuses a replacement runner between its two actions", () => {
	// This isolates CLI Robot lifetime; the preceding tests cover real binding
	// proof and HTTP dispatch. No configuration or device transport is opened.
	const harness = `
const cp = require('node:child_process');
cp.execFileSync = () => { throw new Error('UNEXPECTED_DEVICE_COMMAND'); };
global.fetch = async () => { throw new Error('UNEXPECTED_HTTP_REQUEST'); };
const platform = require(${JSON.stringify(path.resolve("lib/cli-platform.js"))});
let receipt = 1; const trace = [];
platform.makeRobot = () => {
 const frozen = receipt; trace.push({createdWithReceipt:frozen});
 return {
  async sendKeys() { trace.push({typedWithReceipt:frozen}); receipt = 2; },
  async pressButton() { trace.push({enterWithReceipt:frozen}); if (frozen !== receipt) throw new Error('old owned runner changed'); }
 };
};
process.on('exit', () => process.stderr.write(JSON.stringify({offlineMockOnly:true,trace})+'\\n'));
process.argv = [process.execPath, ${JSON.stringify(cliPath)}, 'key', 'OFFLINE-TEXT', '--submit', '--platform', 'ios-simulator', '--device', ${JSON.stringify(uuid)}, '--simulator-wda-config', 'OFFLINE-NOT-READ.json'];
require(${JSON.stringify(cliPath)});
`;
	const result = spawnSync(process.execPath, ["-e", harness], { encoding: "utf8", timeout: 10_000, windowsHide: true });
	expect(result.status, result.stdout + result.stderr).toBe(1);
	expect(result.stderr).toContain("old owned runner changed");
	expect(result.stderr).not.toContain("UNEXPECTED_");
	const trace = JSON.parse(result.stderr.trim().split(/\r?\n/).at(-1)!);
	expect(trace).toEqual({ offlineMockOnly: true, trace: [{ createdWithReceipt: 1 }, { typedWithReceipt: 1 }, { enterWithReceipt: 1 }] });
});

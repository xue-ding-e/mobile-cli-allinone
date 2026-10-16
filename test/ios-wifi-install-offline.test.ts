import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const python = process.env.MOBILE_IOS_TEST_PYTHON || "python";
const probe = spawnSync(python, ["-c", "import sys; print(int(sys.version_info >= (3, 11)))"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
const pythonReady = !probe.error && probe.status === 0 && probe.stdout.trim() === "1";
const script = path.resolve(__dirname, "../scripts/ios-wifi-bridge/install_wifi.py");
const bundle = "dev.example.fixture";
const identity = { CFBundleIdentifier: bundle, CFBundleVersion: "42", CFBundleShortVersionString: "1.2.3" };

type Entry = { name: string; plist?: unknown; raw?: string; binary?: boolean };
type Fixture = { entries?: readonly Entry[]; rawArchive?: string; bundle?: string; lookup?: unknown; replaceInputOnTransport?: boolean; captureInstalledIdentity?: boolean };
type Result = { error: string | null; calls: Array<{ action: string; query?: unknown; installedIdentity?: unknown; inputPathUsed?: boolean }>; snapshotExistsAfter: boolean; records: Array<Record<string, unknown>> };

// Only a temporary ZIP and in-memory fake modules are used. The real device
// adapter and pymobiledevice3 are never imported by this subprocess.
const harness = `
import asyncio, contextlib, importlib.util, io, json, plistlib, sys, tempfile, types, zipfile
from pathlib import Path
fixture = json.load(sys.stdin)
calls = []
records = []
installed_paths = []
device = types.ModuleType("device")
@contextlib.asynccontextmanager
async def wifi_device(*args, **kwargs):
    calls.append({"action": "transport"})
    if fixture.get("replaceInputOnTransport"):
        package.write_bytes(b"caller build output replaced during RPC")
    yield object(), None
device.wifi_device = wifi_device
sys.modules["device"] = device
for name in ["pymobiledevice3", "pymobiledevice3.services", "pymobiledevice3.services.installation_proxy"]:
    sys.modules[name] = types.ModuleType(name)
class InstallationProxyService:
    def __init__(self, lockdown):
        pass
    async def __aenter__(self):
        return self
    async def __aexit__(self, *args):
        return False
    async def install_from_local(self, target, developer=False):
        installed_paths.append(Path(target))
        record = {"action": "install"}
        if fixture.get("captureInstalledIdentity"):
            record["installedIdentity"] = module.read_package_identity(Path(target), args.bundle)
            record["inputPathUsed"] = Path(target) == package
        calls.append(record)
    async def lookup(self, query):
        calls.append({"action": "lookup", "query": query})
        return fixture.get("lookup")
sys.modules["pymobiledevice3.services.installation_proxy"].InstallationProxyService = InstallationProxyService
spec = importlib.util.spec_from_file_location("install_fixture", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix="mobile-ios-install-offline-") as directory:
    package = Path(directory) / "Fixture.ipa"
    if "rawArchive" in fixture:
        package.write_bytes(fixture["rawArchive"].encode())
    else:
        with zipfile.ZipFile(package, "w") as archive:
            for entry in fixture.get("entries", []):
                if "plist" in entry:
                    fmt = plistlib.FMT_BINARY if entry.get("binary") else plistlib.FMT_XML
                    content = plistlib.dumps(entry["plist"], fmt=fmt)
                else:
                    content = entry.get("raw", "fixture").encode()
                # Preserve malicious raw ZIP paths even on Windows, where the
                # ZipInfo constructor otherwise normalizes backslashes.
                info = zipfile.ZipInfo(entry["name"])
                info.filename = entry["name"]
                archive.writestr(info, content)
    args = types.SimpleNamespace(package=str(package), bundle=fixture.get("bundle", "dev.example.fixture"),
                                 udid="FAKE_TEST_UDID", host="FAKE_TEST_HOST")
    output = io.StringIO()
    error = None
    with contextlib.redirect_stdout(output):
        try:
            asyncio.run(module.main(args))
        except Exception as failure:
            error = type(failure).__name__ + ": " + str(failure)
    for line in output.getvalue().splitlines():
        records.append(json.loads(line))
    print(json.dumps({"error": error, "calls": calls, "records": records,
                      "snapshotExistsAfter": any(target.exists() for target in installed_paths)}))
`;

function runFixture(fixture: Fixture): Result {
	const result = spawnSync(python, ["-X", "utf8", "-c", harness, script], {
		input: JSON.stringify(fixture), encoding: "utf8", windowsHide: true, timeout: 10000,
	});
	expect(result.error, result.stderr).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout.trim());
}

function validFixture(patch: Partial<Fixture> = {}): Fixture {
	return { entries: [{ name: "Payload/Fixture.app/Info.plist", plist: identity }], lookup: { [bundle]: identity }, ...patch };
}

test.beforeEach(() => {
	test.skip(!pythonReady, `Python >= 3.11 is unavailable at ${python}; no device or transport was attempted`);
});

test("matching IPA and installed metadata produce success after exact bundle lookup", () => {
	const result = runFixture(validFixture());
	expect(result.error).toBeNull();
	expect(result.calls).toEqual([{ action: "transport" }, { action: "install" }, { action: "lookup", query: { BundleIDs: [bundle] } }]);
	expect(result.records.at(-1)).toMatchObject({ result: "INSTALLED_AND_LOOKED_UP", bundle, version: "42", shortVersion: "1.2.3" });
});

test("IPA A with requested already-installed B is rejected before transport or installation", () => {
	const other = "dev.example.alreadyinstalled";
	const result = runFixture(validFixture({ bundle: other, lookup: { [other]: { ...identity, CFBundleIdentifier: other } } }));
	expect(result.error).toContain("CFBundleIdentifier does not match --bundle");
	expect(result.calls).toEqual([]);
	expect(result.records).toEqual([]);
});

for (const [label, lookup, expectedError] of [
	["wrong installed bundle under expected map key", { [bundle]: { ...identity, CFBundleIdentifier: "dev.example.old" } }, "CFBundleIdentifier"],
	["old build version", { [bundle]: { ...identity, CFBundleVersion: "41" } }, "CFBundleVersion"],
	["old short version", { [bundle]: { ...identity, CFBundleShortVersionString: "1.2.2" } }, "CFBundleShortVersionString"],
	["missing installed bundle ID", { [bundle]: { CFBundleVersion: "42", CFBundleShortVersionString: "1.2.3" } }, "CFBundleIdentifier"],
	["missing installed build version", { [bundle]: { CFBundleIdentifier: bundle, CFBundleShortVersionString: "1.2.3" } }, "CFBundleVersion"],
	["missing installed short version", { [bundle]: { CFBundleIdentifier: bundle, CFBundleVersion: "42" } }, "CFBundleShortVersionString"],
	["only already-installed B returned", { "dev.example.old": identity }, "not returned"],
	["no lookup result", null, "not returned"],
	["invalid lookup envelope", [identity], "not returned"],
] as const) {
	test(`${label} cannot produce installation success`, () => {
		const result = runFixture(validFixture({ lookup }));
		expect(result.error).toContain(expectedError);
		expect(result.calls.map(call => call.action)).toEqual(["transport", "install", "lookup"]);
		expect(result.records.some(record => record.result === "INSTALLED_AND_LOOKED_UP")).toBe(false);
	});
}

for (const [label, fixture, expectedError] of [
	["non ZIP", { rawArchive: "not a ZIP" }, "metadata could not be read"],
	["no main app", { entries: [{ name: "unrelated.txt" }] }, "exactly one main Payload"],
	["multiple main apps", { entries: [{ name: "Payload/A.app/Info.plist", plist: identity }, { name: "Payload/B.app/Info.plist", plist: identity }] }, "exactly one main Payload"],
	["missing main plist", { entries: [{ name: "Payload/Fixture.app/asset.txt" }] }, "exactly one main app Info.plist"],
	["duplicate main plist", { entries: [{ name: "Payload/Fixture.app/Info.plist", plist: identity }, { name: "Payload/Fixture.app/Info.plist", plist: identity }] }, "exactly one main app Info.plist"],
	["bad main plist", { entries: [{ name: "Payload/Fixture.app/Info.plist", raw: "not a plist" }] }, "metadata could not be read"],
	["malformed XML plist", { entries: [{ name: "Payload/Fixture.app/Info.plist", raw: "<?xml version=\"1.0\"?><plist><dict>" }] }, "metadata could not be read"],
	["non dictionary plist", { entries: [{ name: "Payload/Fixture.app/Info.plist", plist: ["invalid"] }] }, "must be a dictionary"],
	["missing build version", { entries: [{ name: "Payload/Fixture.app/Info.plist", plist: { CFBundleIdentifier: bundle } }] }, "CFBundleVersion"],
	["blank build version", { entries: [{ name: "Payload/Fixture.app/Info.plist", plist: { ...identity, CFBundleVersion: " " } }] }, "CFBundleVersion"],
	["numeric build version", { entries: [{ name: "Payload/Fixture.app/Info.plist", plist: { ...identity, CFBundleVersion: 42 } }] }, "CFBundleVersion"],
	["blank short version", { entries: [{ name: "Payload/Fixture.app/Info.plist", plist: { ...identity, CFBundleShortVersionString: "" } }] }, "CFBundleShortVersionString"],
	["parent traversal", { entries: [{ name: "Payload/Fixture.app/../escape", raw: "bad" }, { name: "Payload/Fixture.app/Info.plist", plist: identity }] }, "unsafe archive path"],
	["absolute path", { entries: [{ name: "/escape" }, { name: "Payload/Fixture.app/Info.plist", plist: identity }] }, "unsafe archive path"],
	["Windows backslash path", { entries: [{ name: "Payload\\Fixture.app\\Info.plist", plist: identity }] }, "unsafe archive path"],
	["Windows drive path", { entries: [{ name: "C:/escape" }, { name: "Payload/Fixture.app/Info.plist", plist: identity }] }, "unsafe archive path"],
	["oversized plist", { entries: [{ name: "Payload/Fixture.app/Info.plist", raw: "a".repeat(1024 * 1024 + 1) }] }, "exceeds the 1 MiB limit"],
] as const) {
	test(`${label} is rejected before authenticated transport`, () => {
		const result = runFixture(validFixture(fixture));
		expect(result.error).toContain(expectedError);
		expect(result.calls).toEqual([]);
		expect(result.records.some(record => record.result === "INSTALLED_AND_LOOKED_UP")).toBe(false);
	});
}

test("binary main plist and nested app-extension metadata use the main app identity", () => {
	const result = runFixture(validFixture({ entries: [
		{ name: "Payload/Fixture.app/Info.plist", plist: identity, binary: true },
		{ name: "Payload/Fixture.app/PlugIns/Extension.appex/Info.plist", plist: { ...identity, CFBundleIdentifier: "dev.example.extension" } },
		{ name: "Payload/Fixture.app/Watch/Watch.app/Info.plist", plist: { ...identity, CFBundleIdentifier: "dev.example.watch" } },
	] }));
	expect(result.error).toBeNull();
	expect(result.records.at(-1)).toMatchObject({ result: "INSTALLED_AND_LOOKED_UP", bundle, version: "42" });
});

test("a short version is optional but the required build identity remains exact", () => {
	const app = { CFBundleIdentifier: bundle, CFBundleVersion: "42" };
	const result = runFixture(validFixture({ entries: [{ name: "Payload/Fixture.app/Info.plist", plist: app }], lookup: { [bundle]: app } }));
	expect(result.error).toBeNull();
	expect(result.records.at(-1)).toMatchObject({ result: "INSTALLED_AND_LOOKED_UP", version: "42" });
});


test("overwriting the caller IPA during RPC cannot change the validated installation snapshot", () => {
	const result = runFixture(validFixture({ replaceInputOnTransport: true, captureInstalledIdentity: true }));
	expect(result.error).toBeNull();
	expect(result.calls[1]).toEqual({ action: "install", inputPathUsed: false,
		installedIdentity: { bundle, version: "42", shortVersion: "1.2.3" } });
	expect(result.records[0]).toMatchObject({ inputMode: "PRIVATE_INSTALL_SNAPSHOT", bundle, version: "42" });
	expect(result.records.at(-1)).toMatchObject({ result: "INSTALLED_AND_LOOKED_UP", bundle, version: "42" });
	expect(result.snapshotExistsAfter).toBe(false);
});

test("a lookup failure also cleans the private install snapshot", () => {
	const result = runFixture(validFixture({ captureInstalledIdentity: true, lookup: { [bundle]: { ...identity, CFBundleVersion: "41" } } }));
	expect(result.error).toContain("CFBundleVersion");
	expect(result.calls[1].inputPathUsed).toBe(false);
	expect(result.snapshotExistsAfter).toBe(false);
});

// Local CLI + actual Python process + loopback WDA. These are tool contract
// tests and never communicate with an Apple device or pairing service.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync, spawn } from "node:child_process";

test("wda-status CLI preserves a not-ready HTTP body and exits nonzero after one status request", async () => {
	const runtime = spawnSync("python", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8", windowsHide: true });
	test.skip(runtime.status !== 0, "Python is unavailable; synthetic bridge subprocess integration NOT_RUN");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-ios-cli-http-"));
	const python = runtime.stdout.trim();
	const device = "SYNTHETIC-OFFLINE-UDID";
	fs.writeFileSync(path.join(root, "device.py"), "import json, sys\nudid=sys.argv[sys.argv.index('--udid')+1]\nprint(json.dumps({'transport':'WIFI_TCP','udid':udid}))\nprint(json.dumps({'result':'CONNECTED'}))\n");
	fs.copyFileSync(path.join(root, "device.py"), path.join(root, "identity_probe.py"));
	fs.writeFileSync(path.join(root, "install_wifi.py"), "raise RuntimeError('Offline test must never install')\n");
	let requests = 0;
	const body = JSON.stringify({ value: { ready: false, message: "SYNTHETIC_WDA_NOT_READY" } });
	const server = http.createServer((request, response) => {
		requests++; expect(request.method).toBe("GET"); expect(request.url).toBe("/status");
		response.writeHead(200, { "Content-Type": "application/json" }); response.end(body);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		const config = path.join(root, "environment.json");
		fs.writeFileSync(config, JSON.stringify({ device: { udid: device, lastWifiHost: "127.0.0.1", wdaUrl: endpoint }, pythonRelative: python }));
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const child = spawn(process.execPath, [path.resolve("lib/cli.js"), "wda-status", "--platform", "ios", "--device", device, "--ios-config", config], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "", stderr = "";
			child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
			child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
		});
		expect(result.code, result.stderr).toBe(1);
		const diagnostic = JSON.parse(result.stdout);
		expect(diagnostic.httpStatus).toBe(200); expect(diagnostic.rawBody).toBe(body);
		expect(diagnostic.ready).toBe(false); expect(diagnostic.ok).toBe(false);
		expect(diagnostic.parsedJSON.value.message).toBe("SYNTHETIC_WDA_NOT_READY");
		expect(diagnostic.networkError).toBeNull(); expect(requests).toBe(1);
	} finally {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		fs.rmSync(root, { recursive: true, force: true });
	}
});

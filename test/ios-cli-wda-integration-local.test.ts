// Local CLI + actual Python process + loopback WDA. These are tool contract
// tests and never communicate with an Apple device or pairing service.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";

async function listenLoopback(server: http.Server): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			server.listen(49152 + Math.floor(Math.random() * (65535 - 49152)), "127.0.0.1");
			await once(server, "listening"); return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt === 2) {throw error;}
		}
	}
}

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
	await listenLoopback(server);
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

for (const sourceFailure of [false, true]) {
	test(`CLI capture uses canonical source route and one owned session: sourceFailure=${sourceFailure}`, async () => {
		const runtime = spawnSync("python", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8", windowsHide: true });
		test.skip(runtime.status !== 0, "Python is unavailable; CLI capture subprocess integration NOT_RUN");
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-ios-capture-http-"));
		const device = "SYNTHETIC-CAPTURE-UDID";
		const bridge = "import json,sys\nudid=sys.argv[sys.argv.index('--udid')+1]\nprint(json.dumps({'transport':'WIFI_TCP','udid':udid,'result':'CONNECTED'}))\n";
		for (const filename of ["device.py", "identity_probe.py", "install_wifi.py"]) {fs.writeFileSync(path.join(root, filename), bridge);}
		const requests: string[] = [];
		const imageBytes = Buffer.from([0, 137, 80, 78, 71, 255]); // Synthetic binary transport evidence, not a rendered image.
		const server = http.createServer((request, response) => {
			const route = `${request.method} ${request.url}`; requests.push(route);
			response.setHeader("Content-Type", "application/json");
			const send = (value: unknown) => response.end(JSON.stringify({ value }));
			if (route === "GET /status") {send({ ready: true });} else if (route === "POST /session") {send({ sessionId: "owned-capture" });} else if (route === "GET /session/owned-capture/wda/screen") {send({ screenSize: { width: 390, height: 844 }, scale: 3 });} else if (route === "GET /session/owned-capture/source?format=json" && !sourceFailure) {
				send({ type: "Application", rect: { x: 0, y: 0, width: 390, height: 844 }, children: [{ type: "Button", isVisible: "1", name: "fixture", label: "合成按钮", rawIdentifier: "fixture-button", rect: { x: 10, y: 20, width: 80, height: 40 } }] });
			} else if (route === "GET /session/owned-capture/screenshot") {send(imageBytes.toString("base64"));} else if (route === "DELETE /session/owned-capture") {send(null);} else {response.statusCode = 404; send({ error: "unknown command", message: "Strict WDA route not registered: " + route });}
		});
		await listenLoopback(server);
		try {
			const config = path.join(root, "environment.json");
			fs.writeFileSync(config, JSON.stringify({ device: { udid: device, lastWifiHost: "127.0.0.1", wdaUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, pythonRelative: runtime.stdout.trim() }));
			const code = "const frame=await robot.captureScreen(); return {size:frame.size,elements:frame.elements,binary:Array.from(frame.screenshot)};";
			const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
				const child = spawn(process.execPath, [path.resolve("lib/cli.js"), "eval", code, "--platform", "ios", "--device", device, "--ios-config", config], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
				let stdout = "", stderr = "";
				child.stdout.on("data", data => {stdout += data;}); child.stderr.on("data", data => {stderr += data;});
				child.on("error", reject); child.on("close", exitCode => resolve({ code: exitCode, stdout, stderr }));
			});
			expect(result.code, result.stderr).toBe(sourceFailure ? 1 : 0);
			if (sourceFailure) {expect(result.stderr).toContain("HTTP 404"); expect(result.stdout).toBe("");} else {
				const frame = JSON.parse(result.stdout);
				expect(frame.size).toEqual({ width: 390, height: 844, scale: 3 });
				expect(frame.elements).toMatchObject([{ type: "Button", label: "合成按钮", identifier: "fixture-button", rect: { x: 10, y: 20, width: 80, height: 40 } }]);
				expect(frame.binary).toEqual(Array.from(imageBytes));
			}
			expect(requests).toEqual(["GET /status", "POST /session", "GET /session/owned-capture/wda/screen", "GET /session/owned-capture/source?format=json", ...(!sourceFailure ? ["GET /session/owned-capture/screenshot"] : []), "DELETE /session/owned-capture"]);
		} finally {
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

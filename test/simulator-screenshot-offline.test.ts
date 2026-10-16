// The real compiled Robot/CLI runs with only xcrun and HTTP transports replaced.
// No Simulator, Apple tool or WDA process is contacted by these tests.
import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const uuid = "11111111-2222-3333-4444-555555555555";
const foreignUuid = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=", "base64");

function runCapture(device: string, mode = "success", cliOutput?: string) {
	const harness = `
const cp=require('node:child_process'),fs=require('node:fs');
const calls=[];let httpCalls=0;
globalThis.fetch=async()=>{httpCalls++;throw new Error('WDA must not be used for native simulator screenshots')};
cp.execFileSync=(file,args,options)=>{
 calls.push({file,args,timeout:options.timeout,maxBuffer:options.maxBuffer,encoding:options.encoding});
 if(file!=='xcrun')throw new Error('Unexpected executable: '+file);
 if(${JSON.stringify(mode)}==='failure'||${JSON.stringify(device)}===${JSON.stringify(foreignUuid)}){
  const error=new Error('xcrun failed');error.status=149;error.stderr=Buffer.from('Invalid device: '+args[2]);error.stdout=Buffer.from('partial progress');throw error;
 }
 if(${JSON.stringify(mode)}==='missing'){const error=new Error('spawnSync xcrun ENOENT');error.code='ENOENT';throw error}
 const data=Buffer.from(${JSON.stringify(png.toString("base64"))},'base64');
 if(${JSON.stringify(mode)}==='invalid')return Buffer.from('not a PNG');
 if(${JSON.stringify(mode)}==='truncated')return data.subarray(0,8);
 if(${JSON.stringify(mode)}==='zero')data.writeUInt32BE(0,16);
 return data;
};
${cliOutput ? `
process.on('exit',()=>fs.writeFileSync(${JSON.stringify(cliOutput + ".trace.json")},JSON.stringify({calls,httpCalls})));
process.argv=[process.execPath,${JSON.stringify(path.resolve("lib/cli.js"))},'shot',${JSON.stringify(cliOutput)},'--platform','ios-simulator','--device',${JSON.stringify(device)}];
require(${JSON.stringify(path.resolve("lib/cli.js"))});
` : `
const {Simctl}=require(${JSON.stringify(path.resolve("lib/iphone-simulator.js"))});
new Simctl(${JSON.stringify(device)}).getScreenshot().then(data=>{
 console.log(JSON.stringify({ok:true,calls,httpCalls,base64:data.toString('base64')}));
},error=>{console.log(JSON.stringify({ok:false,calls,httpCalls,error:error.message}));process.exitCode=1});
`}
`;
	return spawnSync(process.execPath, ["-e", harness], { encoding: "utf8", timeout: 10_000, windowsHide: true });
}

test("native simulator screenshot uses exact xcrun UUID command and preserves binary bytes", () => {
	const result = runCapture(uuid); expect(result.status, result.stderr).toBe(0);
	const output = JSON.parse(result.stdout);
	expect(output.base64).toBe(png.toString("base64")); expect(output.httpCalls).toBe(0);
	expect(output.calls).toEqual([{ file: "xcrun", args: ["simctl", "io", uuid, "screenshot", "--type=png", "-"], timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }]);
});

for (const device of ["", "booted", "127.0.0.1:5557", "PHYSICAL-IOS-UDID"]) {
	test(`invalid or implicit simulator target never reaches xcrun/WDA: ${device}`, () => {
		const result = runCapture(device); expect(result.status).toBe(1);
		const output = JSON.parse(result.stdout); expect(output.error).toContain("explicit simulator UUID");
		expect(output.calls).toEqual([]); expect(output.httpCalls).toBe(0);
	});
}

for (const mode of ["failure", "missing", "invalid", "truncated", "zero"]) {
	test(`native screenshot rejects ${mode} without falling back to WDA or another device`, () => {
		const result = runCapture(uuid, mode); expect(result.status).toBe(1);
		const output = JSON.parse(result.stdout); expect(output.ok).toBe(false);
		expect(output.calls).toHaveLength(1); expect(output.httpCalls).toBe(0);
		expect(output.error).toMatch(mode === "failure" ? /Invalid device/ : mode === "missing" ? /ENOENT/ : /PNG/);
	});
}

test("an unavailable foreign UUID is not silently replaced by a booted simulator", () => {
	const result = runCapture(foreignUuid); expect(result.status).toBe(1);
	const output = JSON.parse(result.stdout); expect(output.error).toContain(foreignUuid);
	expect(output.calls).toHaveLength(1); expect(output.calls[0].args[2]).toBe(foreignUuid);
	expect(output.httpCalls).toBe(0);
});

for (const mode of ["success", "failure"]) {
	test(`real CLI shot saves validated bytes only on success: ${mode}`, () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-sim-shot-"));
		try {
			const outputPath = path.join(directory, "shot.png");
			const result = runCapture(uuid, mode, outputPath); expect(result.status, result.stderr).toBe(mode === "success" ? 0 : 1);
			const trace = JSON.parse(fs.readFileSync(outputPath + ".trace.json", "utf8"));
			expect(trace.calls).toHaveLength(1); expect(trace.httpCalls).toBe(0);
			if (mode === "success") {
				expect(fs.readFileSync(outputPath)).toEqual(png);
				expect(JSON.parse(result.stdout)).toMatchObject({ screenshot: outputPath, bytes: png.length });
			} else {expect(fs.existsSync(outputPath)).toBe(false); expect(result.stderr).toContain("Invalid device");}
		} finally {fs.rmSync(directory, { recursive: true, force: true });}
	});
}

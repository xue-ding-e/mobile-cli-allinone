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
const cp=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const originalMkdtemp=fs.mkdtempSync.bind(fs),originalRm=fs.rmSync.bind(fs);
const foreignDirectory=originalMkdtemp(path.join(os.tmpdir(),'mobile-sim-shot-foreign-'));
const foreignSentinel=path.join(foreignDirectory,'keep.txt');fs.writeFileSync(foreignSentinel,'DO NOT REMOVE');
const calls=[],directories=[],cleanupAttempts=[];let httpCalls=0;
fs.mkdtempSync=(prefix,...args)=>{const directory=originalMkdtemp(prefix,...args);directories.push(directory);return directory};
fs.rmSync=(target,options)=>{
 cleanupAttempts.push({target,recursive:options?.recursive,force:options?.force});
 if(['failure-cleanup','success-cleanup'].includes(${JSON.stringify(mode)})&&directories.includes(target))throw new Error('MOCK cleanup failure');
 return originalRm(target,options);
};
const snapshot=()=>({calls,httpCalls,cleanupAttempts,directories:directories.map(directory=>({path:directory,exists:fs.existsSync(directory)})),foreignDirectory,foreignIntact:fs.existsSync(foreignSentinel)&&fs.readFileSync(foreignSentinel,'utf8')==='DO NOT REMOVE'});
const cleanupFixtures=()=>{for(const directory of directories)originalRm(directory,{recursive:true,force:true});originalRm(foreignDirectory,{recursive:true,force:true})};
globalThis.fetch=async()=>{httpCalls++;throw new Error('WDA must not be used for native simulator screenshots')};
cp.execFileSync=(file,args,options)=>{
 calls.push({file,args,timeout:options.timeout,maxBuffer:options.maxBuffer,encoding:options.encoding});
 if(file!=='xcrun')throw new Error('Unexpected executable: '+file);
 if(${JSON.stringify(mode)}==='missing'){const error=new Error('spawnSync xcrun ENOENT');error.code='ENOENT';throw error}
 let data=Buffer.from(${JSON.stringify(png.toString("base64"))},'base64');
 if(${JSON.stringify(mode)}==='invalid')data=Buffer.from('not a PNG');
 if(${JSON.stringify(mode)}==='truncated')data=data.subarray(0,8);
 if(${JSON.stringify(mode)}==='zero')data.writeUInt32BE(0,16);
 fs.writeFileSync(args[5],data);
 if(['failure','failure-cleanup'].includes(${JSON.stringify(mode)})||${JSON.stringify(device)}===${JSON.stringify(foreignUuid)}){
  const error=new Error('xcrun failed');error.status=149;error.stderr=Buffer.from('Invalid device: '+args[2]);error.stdout=Buffer.from('partial progress');throw error;
 }
 return ${JSON.stringify(mode)}==='stdout-text'?Buffer.from('Detected file type PNG; wrote screenshot'):Buffer.alloc(0);
};
${cliOutput ? `
process.on('exit',()=>{try{fs.writeFileSync(${JSON.stringify(cliOutput + ".trace.json")},JSON.stringify(snapshot()))}finally{cleanupFixtures()}});
process.argv=[process.execPath,${JSON.stringify(path.resolve("lib/cli.js"))},'shot',${JSON.stringify(cliOutput)},'--platform','ios-simulator','--device',${JSON.stringify(device)}];
require(${JSON.stringify(path.resolve("lib/cli.js"))});
` : `
const {Simctl}=require(${JSON.stringify(path.resolve("lib/iphone-simulator.js"))});
new Simctl(${JSON.stringify(device)}).getScreenshot().then(data=>{
 try{console.log(JSON.stringify({ok:true,...snapshot(),base64:data.toString('base64')}))}finally{cleanupFixtures()}
},error=>{try{console.log(JSON.stringify({ok:false,...snapshot(),error:error.message,cleanupError:error.cleanupError?.message}));process.exitCode=1}finally{cleanupFixtures()}});
`}
`;
	return spawnSync(process.execPath, ["-e", harness], { encoding: "utf8", timeout: 10_000, windowsHide: true });
}

function expectOwnedCapture(output: { calls: Array<{ file: string; args: string[]; timeout: number; maxBuffer: number }>; directories: Array<{ path: string; exists: boolean }>; cleanupAttempts: Array<{ target: string; recursive: boolean; force: boolean }>; foreignDirectory: string; foreignIntact: boolean }, device = uuid, cleanupFailed = false) {
	expect(output.calls).toHaveLength(1); expect(output.directories).toHaveLength(1);
	const directory = output.directories[0].path;
	expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
	expect(path.basename(directory)).toMatch(/^mobile-sim-shot-/);
	expect(output.calls).toEqual([{ file: "xcrun", args: ["simctl", "io", device, "screenshot", "--type=png", path.join(directory, "capture.png")], timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }]);
	expect(output.cleanupAttempts).toEqual([{ target: directory, recursive: true, force: true }]);
	expect(output.directories[0].exists).toBe(cleanupFailed);
	expect(directory).not.toBe(output.foreignDirectory); expect(output.foreignIntact).toBe(true);
}

for (const mode of ["success", "stdout-text"]) {
	test(`native simulator screenshot reads exact UUID capture file and preserves binary bytes: ${mode}`, () => {
		const result = runCapture(uuid, mode); expect(result.status, result.stderr).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.base64).toBe(png.toString("base64")); expect(output.httpCalls).toBe(0);
		expectOwnedCapture(output);
	});
}

for (const device of ["", "booted", "127.0.0.1:5557", "PHYSICAL-IOS-UDID"]) {
	test(`invalid or implicit simulator target never reaches xcrun/WDA: ${device}`, () => {
		const result = runCapture(device); expect(result.status).toBe(1);
		const output = JSON.parse(result.stdout); expect(output.error).toContain("explicit simulator UUID");
		expect(output.calls).toEqual([]); expect(output.httpCalls).toBe(0);
		expect(output.directories).toEqual([]); expect(output.cleanupAttempts).toEqual([]); expect(output.foreignIntact).toBe(true);
	});
}

for (const mode of ["failure", "missing", "invalid", "truncated", "zero"]) {
	test(`native screenshot rejects ${mode} without falling back to WDA or another device`, () => {
		const result = runCapture(uuid, mode); expect(result.status).toBe(1);
		const output = JSON.parse(result.stdout); expect(output.ok).toBe(false);
		expect(output.calls).toHaveLength(1); expect(output.httpCalls).toBe(0);
		expect(output.error).toMatch(mode === "failure" ? /Invalid device/ : mode === "missing" ? /ENOENT/ : /PNG/);
		expectOwnedCapture(output);
	});
}

test("an unavailable foreign UUID is not silently replaced by a booted simulator", () => {
	const result = runCapture(foreignUuid); expect(result.status).toBe(1);
	const output = JSON.parse(result.stdout); expect(output.error).toContain(foreignUuid);
	expect(output.calls).toHaveLength(1); expect(output.calls[0].args[2]).toBe(foreignUuid);
	expect(output.httpCalls).toBe(0);
	expectOwnedCapture(output, foreignUuid);
});

test("cleanup failure preserves the primary capture error and never removes a foreign sentinel", () => {
	const result = runCapture(uuid, "failure-cleanup"); expect(result.status).toBe(1);
	const output = JSON.parse(result.stdout);
	expect(output.ok).toBe(false); expect(output.error).toContain("Invalid device"); expect(output.error).not.toContain("MOCK cleanup failure");
	expect(output.cleanupError).toBe("MOCK cleanup failure");
	expect(output.httpCalls).toBe(0); expectOwnedCapture(output, uuid, true);
});

test("successful capture is rejected if its owned temporary directory cannot be cleaned", () => {
	const result = runCapture(uuid, "success-cleanup"); expect(result.status).toBe(1);
	const output = JSON.parse(result.stdout);
	expect(output.ok).toBe(false); expect(output.error).toContain("Failed to clean simulator screenshot temporary directory");
	expect(output.error).toContain("MOCK cleanup failure"); expect(output.base64).toBeUndefined();
	expect(output.httpCalls).toBe(0); expectOwnedCapture(output, uuid, true);
});

for (const mode of ["success", "failure"]) {
	test(`real CLI shot saves validated bytes only on success: ${mode}`, () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-sim-shot-"));
		try {
			const outputPath = path.join(directory, "shot.png");
			const result = runCapture(uuid, mode, outputPath); expect(result.status, result.stderr).toBe(mode === "success" ? 0 : 1);
			const trace = JSON.parse(fs.readFileSync(outputPath + ".trace.json", "utf8"));
			expect(trace.calls).toHaveLength(1); expect(trace.httpCalls).toBe(0);
			expectOwnedCapture(trace);
			if (mode === "success") {
				expect(fs.readFileSync(outputPath)).toEqual(png);
				expect(JSON.parse(result.stdout)).toMatchObject({ screenshot: outputPath, bytes: png.length });
			} else {expect(fs.existsSync(outputPath)).toBe(false); expect(result.stdout).toBe(""); expect(result.stderr).toContain("Invalid device");}
		} finally {fs.rmSync(directory, { recursive: true, force: true });}
	});
}

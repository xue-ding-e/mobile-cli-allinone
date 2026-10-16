// Execute the actual identity helper with only its paired TCP client injected.
// No Apple service or real pair record is available to this subprocess.
import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

for (const mode of ["paired", "foreign", "untrusted"]) {
	test(`identity probe uses only paired lockdown and cleans its own client: ${mode}`, () => {
		const runtime = spawnSync("python", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8", windowsHide: true });
		test.skip(runtime.status !== 0, "Python is unavailable; identity subprocess contract NOT_RUN");
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-identity-offline-"));
		try {
			const harness = `
import sys,types,pathlib,plistlib,json,runpy
root=pathlib.Path(sys.argv[1]); mode=sys.argv[2]; script=sys.argv[3]
pair=root/'.pymobiledevice3';pair.mkdir();(pair/'SYNTHETIC-UDID.plist').write_bytes(plistlib.dumps({'fixture':True}))
pathlib.Path.home=classmethod(lambda cls: root)
class Lockdown:
 paired=mode!='untrusted'
 product_version='OFFLINE_FIXTURE'
 all_values={'UniqueDeviceID':'FOREIGN' if mode=='foreign' else 'SYNTHETIC-UDID'}
 async def validate_pairing(self):return False
 async def close(self):print(json.dumps({'ownClientClosed':True}))
 async def start_lockdown_service(self,*args):raise RuntimeError('Identity must not open heartbeat/developer services')
async def create_using_tcp(**kwargs):
 assert kwargs['autopair'] is False and kwargs['identifier']=='SYNTHETIC-UDID'
 assert kwargs['hostname']=='127.0.0.1' and kwargs['pair_record']=={'fixture':True}
 return Lockdown()
package=types.ModuleType('pymobiledevice3');package.__path__=[]
module=types.ModuleType('pymobiledevice3.lockdown');module.create_using_tcp=create_using_tcp
sys.modules['pymobiledevice3']=package;sys.modules['pymobiledevice3.lockdown']=module
sys.argv=[script,'--udid','SYNTHETIC-UDID','--host','127.0.0.1']
runpy.run_path(script,run_name='__main__')
`;
			const result = spawnSync(runtime.stdout.trim(), ["-c", harness, directory, mode, path.resolve("scripts/ios-wifi-bridge/identity_probe.py")], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
			expect(result.stdout).toContain('"ownClientClosed": true');
			if (mode === "paired") {
				expect(result.status, result.stderr).toBe(0);
				const data = JSON.parse(result.stdout.split(/\r?\n/)[0]);
				expect(data).toMatchObject({ udid: "SYNTHETIC-UDID", result: "CONNECTED", developerTunnelOpened: false, scope: "PAIRED_LOCKDOWN_IDENTITY_ONLY" });
			} else {
				expect(result.status).toBe(1); expect(result.stdout).not.toContain('"result": "CONNECTED"');
				expect(result.stderr).toMatch(/identity mismatch|pairing was rejected/);
			}
		} finally {fs.rmSync(directory, { recursive: true, force: true });}
	});
}

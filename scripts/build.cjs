const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc")], { stdio: "inherit", windowsHide: true });
if (process.platform !== "win32") fs.chmodSync(path.join(__dirname, "../lib/index.js"), 0o755);

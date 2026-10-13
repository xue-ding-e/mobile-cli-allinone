import { test, expect } from "@playwright/test";
import { AndroidRobot } from "../src/android";
import { ActionableError } from "../src/robot";

const apkPath = "C:\\owned-fixture\\consumer.apk";

/** Only the ADB transport is injected; every case executes production installApp. */
function robotWithTransport(response: string | Error): { robot: AndroidRobot; calls: string[][] } {
	const robot = new AndroidRobot("fixture-device");
	const calls: string[][] = [];
	robot.adb = (...args: string[]): Buffer => {
		calls.push(args);
		if (response instanceof Error) {throw response;}
		return Buffer.from(response);
	};
	return { robot, calls };
}

function expectSingleInstall(calls: string[][]): void {
	expect(calls).toEqual([["install", "--no-incremental", "-r", apkPath]]);
}

for (const output of ["Success\n", "Performing Streamed Install\r\n  Success  \r\n"]) {
	test(`install accepts actual terminal Success: ${JSON.stringify(output)}`, async () => {
		const { robot, calls } = robotWithTransport(output);
		await expect(robot.installApp(apkPath)).resolves.toBeUndefined();
		expectSingleInstall(calls);
	});
}

for (const { name, output, reason } of [
	{
		name: "MuMu streamed progress followed by signature mismatch even with exit zero",
		output: "Serving...\nPerforming Streamed Install\nSuccess: streamed install finished\nFailure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package dev.example signatures do not match previously installed version]\n",
		reason: "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
	},
	{
		name: "Failure takes precedence over a later Success",
		output: "Failure [INSTALL_FAILED_INVALID_APK]\nSuccess\n",
		reason: "INSTALL_FAILED_INVALID_APK",
	},
	{
		name: "exception takes precedence over a later Success",
		output: "Exception occurred while executing 'install':\njava.lang.IllegalArgumentException: IncrementalNotAllowed\nSuccess\n",
		reason: "IncrementalNotAllowed",
	},
	{
		name: "named Java exception is still an installation failure",
		output: "java.lang.SecurityException: install denied\nSuccess\n",
		reason: "SecurityException",
	},
	{
		name: "streamed progress Success is not terminal installation Success",
		output: "Performing Streamed Install\nSuccess: streamed install finished\n",
		reason: "terminal Success",
	},
	{
		name: "missing Success cannot report success",
		output: "Performing Streamed Install\n",
		reason: "terminal Success",
	},
	{
		name: "empty output cannot report success",
		output: "",
		reason: "terminal Success",
	},
	{
		name: "Success followed by an unverified final status cannot report success",
		output: "Success\nWaiting for installation result\n",
		reason: "terminal Success",
	},
]) {
	test(`install rejects ${name}`, async () => {
		const { robot, calls } = robotWithTransport(output);
		const result = robot.installApp(apkPath);
		await expect(result).rejects.toBeInstanceOf(ActionableError);
		await expect(result).rejects.toThrow(reason);
		expectSingleInstall(calls);
	});
}

test("nonzero ADB transport errors preserve stdout/stderr in ActionableError", async () => {
	const error = Object.assign(new Error("ADB exited with status 1"), {
		status: 1,
		stdout: Buffer.from("Performing Streamed Install\nSuccess: streamed install finished\n"),
		stderr: Buffer.from("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]\n"),
	});
	const { robot, calls } = robotWithTransport(error);
	const result = robot.installApp(apkPath);
	await expect(result).rejects.toBeInstanceOf(ActionableError);
	await expect(result).rejects.toThrow("INSTALL_FAILED_UPDATE_INCOMPATIBLE");
	await expect(result).rejects.toThrow("streamed install finished");
	expectSingleInstall(calls);
});

test("ADB startup errors preserve the actionable message without fake Success", async () => {
	const { robot, calls } = robotWithTransport(new Error("spawn adb ENOENT"));
	const result = robot.installApp(apkPath);
	await expect(result).rejects.toBeInstanceOf(ActionableError);
	await expect(result).rejects.toThrow("spawn adb ENOENT");
	expectSingleInstall(calls);
});

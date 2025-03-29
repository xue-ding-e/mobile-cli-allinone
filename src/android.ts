import { execSync } from "child_process";

export const getConnectedDevices = () => {
        const devices = execSync(`adb devices`)
                .toString()
                .split("\n")
                .filter(line => !line.startsWith("List of devices attached"))
                .filter(line => line.trim() != "");

        return devices.length > 0;
};

export const resolveLaunchableActivities = async (packageName: string): Promise<string[]> => {
	return execSync(`adb shell cmd package resolve-activity ${packageName}`)
		.toString()
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.startsWith("name="))
		.map(line => line.substring("name=".length));
}

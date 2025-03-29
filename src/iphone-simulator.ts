import { execSync } from "child_process";

export interface Simulator {
        name: string;
        uuid: string;
};

export const getConnectedDevices = (): Simulator[] => {
        return execSync(`xcrun simctl list devices`)
                .toString()
                .split("\n")
                .map(line => {
                        // extract device name and UUID from the line
                        const match = line.match(/(.*?)\s+\(([\w-]+)\)\s+\(Booted\)/);
                        if (!match) {
                                return null;
                        }

                        const deviceName = match[1].trim();
                        const deviceUuid = match[2];
                        return {
                                name: deviceName,
                                uuid: deviceUuid,
                        };
                })
                .filter(line => line !== null);
}

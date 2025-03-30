import { execSync } from "child_process";
import * as xml from "fast-xml-parser";
import { readFileSync, unlinkSync } from "fs";

interface Bounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

interface ElementCoordinates {
	x: number,
	y: number;
}

export const getConnectedDevices = (): string[] => {
	return execSync(`adb devices`)
		.toString()
		.split("\n")
		.filter(line => !line.startsWith("List of devices attached"))
		.filter(line => line.trim() !== "");
};

export const resolveLaunchableActivities = (packageName: string): string[] => {
	return execSync(`adb shell cmd package resolve-activity ${packageName}`)
		.toString()
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.startsWith("name="))
		.map(line => line.substring("name=".length));
};

export const getScreenSize = (): [number, number] => {
	const screenSize = execSync("adb shell wm size")
		.toString()
		.split(" ")
		.pop();

	if (!screenSize) {
		throw new Error("Failed to get screen size");
	}

	const [width, height] = screenSize.split("x").map(Number);
	return [width, height];
};

const collectElements = (node: any, screenSize: [number, number]): any[] => {
	const elements: any[] = [];

	const getCoordinates = (element: any): Bounds => {
		const bounds = String(element.bounds);

		const [, left, top, right, bottom] = bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.map(Number) || [];
		return { left, top, right, bottom };
	};

	const getCenter = (coordinates: Bounds): ElementCoordinates => {
		return {
			x: Math.floor((coordinates.left + coordinates.right) / 2),
			y: Math.floor((coordinates.top + coordinates.bottom) / 2),
		};
	};

	const normalizeCoordinates = (coordinates: ElementCoordinates, screenSize: [number, number]): ElementCoordinates => {
		return {
			x: Number((coordinates.x / screenSize[0]).toFixed(3)),
			y: Number((coordinates.y / screenSize[1]).toFixed(3)),
		};
	};

	if (node.node) {
		if (Array.isArray(node.node)) {
			for (const childNode of node.node) {
				elements.push(...collectElements(childNode, screenSize));
			}
		} else {
			elements.push(...collectElements(node.node, screenSize));
		}
	}

	if (node.text) {
		elements.push({
			"text": node.text,
			"coordinates": normalizeCoordinates(getCenter(getCoordinates(node)), screenSize),
		});
	}

	if (node["content-desc"]) {
		elements.push({
			"text": node["content-desc"],
			"coordinates": normalizeCoordinates(getCenter(getCoordinates(node)), screenSize),
		});
	}

	return elements;
};

export const getElementsOnScreen = (): any[] => {
	const dump = execSync(`adb exec-out uiautomator dump /dev/tty`);

	const parser = new xml.XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: ""
	});

	const parsedXml = parser.parse(dump);
	const hierarchy = parsedXml.hierarchy;

	const screenSize = getScreenSize();
	const elements = collectElements(hierarchy, screenSize);
	return elements;
};

export const swipe = (direction: "up" | "down" | "left" | "right") => {

	const screenSize = getScreenSize();
	const centerX = screenSize[0] >> 1;
	// const centerY = screenSize[1] >> 1;

	let x0, y0, x1, y1: number;

	switch (direction) {
		case "down":
			x0 = x1 = centerX;
			y0 = Math.floor(screenSize[1] * 0.80);
			y1 = Math.floor(screenSize[1] * 0.20);
			break;
		case "up":
			x0 = x1 = centerX;
			y0 = Math.floor(screenSize[1] * 0.20);
			y1 = Math.floor(screenSize[1] * 0.80);
			break;
		default:
			throw new Error(`Swipe direction "${direction}" is not supported`);
	}

	execSync(`adb shell input swipe ${x0} ${y0} ${x1} ${y1} 1000`);
};

export const takeScreenshot = async (): Promise<Buffer> => {
	const randomFilename = `screenshot-${Date.now()}.png`;

	// take screenshot and save on device
	const remoteFilename = `/sdcard/Download/${randomFilename}`;
	execSync(`adb shell screencap -p ${remoteFilename}`);

	// pull the file locally
	const localFilename = `/tmp/${randomFilename}`;
	execSync(`adb pull ${remoteFilename} ${localFilename}`);
	execSync(`adb shell rm ${remoteFilename}`);

	const screenshot = readFileSync(localFilename);
	unlinkSync(localFilename);
	return screenshot;
};

export const listApps = (): string[] => {
	const result = execSync(`adb shell cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LAUNCHER`)
		.toString()
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.startsWith("packageName="))
		.map(line => line.substring("packageName=".length))
		.filter((value, index, self) => self.indexOf(value) === index);

	return result;
};

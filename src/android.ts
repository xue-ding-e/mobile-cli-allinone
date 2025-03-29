import { exec, execSync } from "child_process";
import * as xml from "fast-xml-parser";

interface Bounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

interface ElementCoordinates {
	x: number,
	y: number;
};

export const getConnectedDevices = (): string[] => {
	return execSync(`adb devices`)
		.toString()
		.split("\n")
		.filter(line => !line.startsWith("List of devices attached"))
		.filter(line => line.trim() != "");
};

export const resolveLaunchableActivities = (packageName: string): string[] => {
	return execSync(`adb shell cmd package resolve-activity ${packageName}`)
		.toString()
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.startsWith("name="))
		.map(line => line.substring("name=".length));
}

export const getScreenSize = (): [number, number] => {
	const screenSize = execSync('adb shell wm size')
		.toString()
		.split(" ")
		.pop();

	if (!screenSize) {
		throw new Error("Failed to get screen size");
	}

	const [width, height] = screenSize.split("x").map(Number);
	return [width, height];
}

export const getElementCoordinates = (text: string): ElementCoordinates => {
	const dump = execSync(`adb exec-out uiautomator dump /dev/tty`);

	const parser = new xml.XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: ""
	});

	const parsedXml = parser.parse(dump);
	const hierarchy = parsedXml.hierarchy;

	// Function to recursively search for text elements in the UI hierarchy
	const findTextElement = (node: any): any => {
		// Base case: if node is null or undefined
		if (!node) {
			return null;
		}

		// Check if current node has the text we're looking for
		if (node.text && node.text.includes(text)) {
			return node;
		}

		// If node has a "node" property
		if (node.node) {
			// If node.node is an array, search in each element
			if (Array.isArray(node.node)) {
				for (const childNode of node.node) {
					const result = findTextElement(childNode);
					if (result) {
						return result;
					}
				}
			}
			// If node.node is an object, recurse on it
			else {
				const result = findTextElement(node.node);
				if (result) {
					return result;
				}
			}
		}

		return null;
	};

	const textElement = findTextElement(hierarchy);

	if (!textElement) {
		console.log(`Element with text "${text}" not found`);
		throw new Error(`Element with text "${text}" was not found on screen`);
	}

	const getCoordinates = (element: any): Bounds => {
		const bounds = String(element.bounds);
		const [_, left, top, right, bottom] = bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.map(Number) || [];
		return { left, top, right, bottom };
	}

	const getCenter = (coordinates: Bounds): ElementCoordinates => {
		return {
			x: Math.floor((coordinates.left + coordinates.right) / 2),
			y: Math.floor((coordinates.top + coordinates.bottom) / 2),
		};
	}

	return getCenter(getCoordinates(textElement));

	/*
	const jsonOutput = JSON.stringify(textElement, null, 2);
	console.dir(jsonOutput.toString());
	console.dir(getCoordinates(textElement));
	console.dir(getCenter(getCoordinates(textElement)));
	*/
}

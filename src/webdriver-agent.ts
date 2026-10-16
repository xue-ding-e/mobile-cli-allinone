import { ActionableError, SwipeDirection, ScreenSize, ScreenElement, Orientation } from "./robot";

export interface SourceTreeElementRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface SourceTreeElement {
	type: string;
	label?: string;
	name?: string;
	value?: string;
	rawIdentifier?: string;
	rect: SourceTreeElementRect;
	isVisible?: string; // "0" or "1"
	children?: Array<SourceTreeElement>;
}

export interface SourceTree {
	value: SourceTreeElement;
}

export class WebDriverAgent {

	constructor(private readonly host: string, private readonly port: number) {
	}

	// Validate both HTTP and WebDriver protocol failures, including commands
	// whose callers do not consume their response body.
	private async request(url: string, options?: RequestInit): Promise<Response> {
		const response = await fetch(url, options);
		if (!response.ok) {
			throw new ActionableError(`WebDriver request failed: ${response.status} ${await response.text()}`);
		}
		const body = await response.clone().text();
		if (body) {
			let json: any;
			try {json = JSON.parse(body);} catch {throw new ActionableError("Invalid WebDriver JSON response");}
			if (json.value?.error || (typeof json.status === "number" && json.status !== 0)) {
				throw new ActionableError(`WebDriver request failed: ${json.value?.message || json.value?.error || body}`);
			}
		}
		return response;
	}

	public async isRunning(): Promise<boolean> {
		const url = `http://${this.host}:${this.port}/status`;
		try {
			const response = await this.request(url);
			const json = await response.json();
			return response.status === 200 && json.value?.ready === true;
		} catch (error) {
			// console.error(`Failed to connect to WebDriverAgent: ${error}`);
			return false;
		}
	}

	public async createSession(): Promise<string> {
		const url = `http://${this.host}:${this.port}/session`;
		const response = await this.request(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ capabilities: { alwaysMatch: { platformName: "iOS" } } }),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new ActionableError(`Failed to create WebDriver session: ${response.status} ${errorText}`);
		}

		const json = await response.json();
		if (!json.value || !json.value.sessionId) {
			throw new ActionableError(`Invalid session response: ${JSON.stringify(json)}`);
		}

		return json.value.sessionId;
	}

	public async deleteSession(sessionId: string) {
		const url = `http://${this.host}:${this.port}/session/${sessionId}`;
		const response = await this.request(url, { method: "DELETE" });
		return response.json();
	}

	public async withinSession(fn: (url: string) => Promise<any>) {
		const sessionId = await this.createSession();
		const url = `http://${this.host}:${this.port}/session/${sessionId}`;
		let failed = false;
		try {
			return await fn(url);
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			try {await this.deleteSession(sessionId);} catch (error) {
				// Preserve the primary operation error if cleanup also fails.
				if (!failed) {throw error;}
			}
		}
	}

	public async getScreenSize(sessionUrl?: string): Promise<ScreenSize> {
		if (sessionUrl) {
			const url = `${sessionUrl}/wda/screen`;
			const response = await this.request(url);
			const json = await response.json();
			return {
				width: json.value.screenSize.width,
				height: json.value.screenSize.height,
				scale: json.value.scale || 1,
			};
		} else {
			return this.withinSession(async sessionUrlInner => {
				const url = `${sessionUrlInner}/wda/screen`;
				const response = await this.request(url);
				const json = await response.json();
				return {
					width: json.value.screenSize.width,
					height: json.value.screenSize.height,
					scale: json.value.scale || 1,
				};
			});
		}
	}

	public async sendKeys(keys: string) {
		await this.withinSession(async sessionUrl => {
			const url = `${sessionUrl}/wda/keys`;
			await this.request(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ value: [keys] }),
			});
		});
	}

	public async pressButton(button: string) {
		const _map = {
			"HOME": "home",
			"VOLUME_UP": "volumeup",
			"VOLUME_DOWN": "volumedown",
		};

		if (button === "ENTER") {
			await this.sendKeys("\n");
			return;
		}

		// Type assertion to check if button is a key of _map
		if (!(button in _map)) {
			throw new ActionableError(`Button "${button}" is not supported`);
		}

		await this.withinSession(async sessionUrl => {
			const url = `${sessionUrl}/wda/pressButton`;
			const response = await this.request(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name: _map[button as keyof typeof _map],
				}),
			});

			return response.json();
		});
	}

	public async tap(x: number, y: number) {
		await this.withinSession(async sessionUrl => {
			const url = `${sessionUrl}/actions`;
			await this.request(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					actions: [
						{
							type: "pointer",
							id: "finger1",
							parameters: { pointerType: "touch" },
							actions: [
								{ type: "pointerMove", duration: 0, x, y },
								{ type: "pointerDown", button: 0 },
								{ type: "pause", duration: 100 },
								{ type: "pointerUp", button: 0 }
							]
						}
					]
				}),
			});
		});
	}

	public async doubleTap(x: number, y: number) {
		await this.withinSession(async sessionUrl => {
			const url = `${sessionUrl}/actions`;
			await this.request(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					actions: [
						{
							type: "pointer",
							id: "finger1",
							parameters: { pointerType: "touch" },
							actions: [
								{ type: "pointerMove", duration: 0, x, y },
								{ type: "pointerDown", button: 0 },
								{ type: "pause", duration: 50 },
								{ type: "pointerUp", button: 0 },

								{ type: "pause", duration: 100 },

								{ type: "pointerDown", button: 0 },
								{ type: "pause", duration: 50 },
								{ type: "pointerUp", button: 0 }
							]
						}
					]
				}),
			});
		});
	}

	public async longPress(x: number, y: number, duration: number) {
		await this.withinSession(async sessionUrl => {
			const url = `${sessionUrl}/actions`;
			await this.request(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					actions: [
						{
							type: "pointer",
							id: "finger1",
							parameters: { pointerType: "touch" },
							actions: [
								{ type: "pointerMove", duration: 0, x, y },
								{ type: "pointerDown", button: 0 },
								{ type: "pause", duration },
								{ type: "pointerUp", button: 0 }
							]
						}
					]
				}),
			});
		});
	}

	private isVisible(rect: SourceTreeElementRect): boolean {
		return rect.x >= 0 && rect.y >= 0;
	}

	private filterSourceElements(source: SourceTreeElement): Array<ScreenElement> {
		const output: ScreenElement[] = [];

		const acceptedTypes = ["TextField", "Button", "Switch", "Icon", "SearchField", "StaticText", "Image"];

		if (acceptedTypes.includes(source.type)) {
			if (source.isVisible === "1" && this.isVisible(source.rect)) {
				if (source.label !== null || source.name !== null || source.rawIdentifier !== null) {
					output.push({
						type: source.type,
						label: source.label,
						name: source.name,
						value: source.value,
						identifier: source.rawIdentifier,
						rect: {
							x: source.rect.x,
							y: source.rect.y,
							width: source.rect.width,
							height: source.rect.height,
						},
					});
				}
			}
		}

		if (source.children) {
			for (const child of source.children) {
				output.push(...this.filterSourceElements(child));
			}
		}

		return output;
	}

	public async getPageSource(): Promise<SourceTree> {
		const url = `http://${this.host}:${this.port}/source/?format=json`;
		const response = await this.request(url);
		const json = await response.json();
		return json as SourceTree;
	}

	public async getElementsOnScreen(): Promise<ScreenElement[]> {
		const source = await this.getPageSource();
		return this.filterSourceElements(source.value);
	}

	public async openUrl(url: string): Promise<void> {
		await this.withinSession(async sessionUrl => {
			await this.request(`${sessionUrl}/url`, {
				method: "POST",
				body: JSON.stringify({ url }),
			});
		});
	}

	public async getScreenshot(): Promise<Buffer> {
		const url = `http://${this.host}:${this.port}/screenshot`;
		const response = await this.request(url);
		const json = await response.json();
		return Buffer.from(json.value, "base64");
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		await this.withinSession(async sessionUrl => {
			const screenSize = await this.getScreenSize(sessionUrl);
			let x0: number, y0: number, x1: number, y1: number;
			// Use 60% of the width/height for swipe distance
			const verticalDistance = Math.floor(screenSize.height * 0.6);
			const horizontalDistance = Math.floor(screenSize.width * 0.6);
			const centerX = Math.floor(screenSize.width / 2);
			const centerY = Math.floor(screenSize.height / 2);

			switch (direction) {
				case "up":
					x0 = x1 = centerX;
					y0 = centerY + Math.floor(verticalDistance / 2);
					y1 = centerY - Math.floor(verticalDistance / 2);
					break;
				case "down":
					x0 = x1 = centerX;
					y0 = centerY - Math.floor(verticalDistance / 2);
					y1 = centerY + Math.floor(verticalDistance / 2);
					break;
				case "left":
					y0 = y1 = centerY;
					x0 = centerX + Math.floor(horizontalDistance / 2);
					x1 = centerX - Math.floor(horizontalDistance / 2);
					break;
				case "right":
					y0 = y1 = centerY;
					x0 = centerX - Math.floor(horizontalDistance / 2);
					x1 = centerX + Math.floor(horizontalDistance / 2);
					break;
				default:
					throw new ActionableError(`Swipe direction "${direction}" is not supported`);
			}

			const url = `${sessionUrl}/actions`;
			const response = await this.request(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					actions: [
						{
							type: "pointer",
							id: "finger1",
							parameters: { pointerType: "touch" },
							actions: [
								{ type: "pointerMove", duration: 0, x: x0, y: y0 },
								{ type: "pointerDown", button: 0 },
								{ type: "pointerMove", duration: 1000, x: x1, y: y1 },
								{ type: "pointerUp", button: 0 }
							]
						}
					]
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new ActionableError(`WebDriver actions request failed: ${response.status} ${errorText}`);
			}

			// Clear actions to ensure they complete
			await this.request(`${sessionUrl}/actions`, {
				method: "DELETE",
			});
		});
	}

	public async swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance: number = 400): Promise<void> {
		await this.withinSession(async sessionUrl => {
			// Use simple coordinates like the working swipe method
			const x0 = x;
			const y0 = y;
			let x1 = x;
			let y1 = y;

			// Calculate target position based on direction and distance
			switch (direction) {
				case "up":
					y1 = y - distance; // Move up by specified distance
					break;
				case "down":
					y1 = y + distance; // Move down by specified distance
					break;
				case "left":
					x1 = x - distance; // Move left by specified distance
					break;
				case "right":
					x1 = x + distance; // Move right by specified distance
					break;
				default:
					throw new ActionableError(`Swipe direction "${direction}" is not supported`);
			}

			const url = `${sessionUrl}/actions`;
			const response = await this.request(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					actions: [
						{
							type: "pointer",
							id: "finger1",
							parameters: { pointerType: "touch" },
							actions: [
								{ type: "pointerMove", duration: 0, x: x0, y: y0 },
								{ type: "pointerDown", button: 0 },
								{ type: "pointerMove", duration: 1000, x: x1, y: y1 },
								{ type: "pointerUp", button: 0 }
							]
						}
					]
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new ActionableError(`WebDriver actions request failed: ${response.status} ${errorText}`);
			}

			// Clear actions to ensure they complete
			await this.request(`${sessionUrl}/actions`, {
				method: "DELETE",
			});
		});
	}

	public async setOrientation(orientation: Orientation): Promise<void> {
		await this.withinSession(async sessionUrl => {
			const url = `${sessionUrl}/orientation`;
			await this.request(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					orientation: orientation.toUpperCase()
				})
			});
		});
	}

	public async getOrientation(): Promise<Orientation> {
		return this.withinSession(async sessionUrl => {
			const url = `${sessionUrl}/orientation`;
			const response = await this.request(url);
			const json = await response.json();
			return json.value.toLowerCase() as Orientation;
		});
	}
}

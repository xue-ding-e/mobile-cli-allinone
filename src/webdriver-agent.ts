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

export interface WebDriverScreenCapture {
	size: ScreenSize;
	elements: ScreenElement[];
	screenshot: Buffer;
}

export interface WebDriverAgentOptions {
	requestTimeoutMs?: number;
	protocol?: "http:" | "https:";
}

interface WebDriverResponse {
	value: any;
	sessionId?: string;
	status?: unknown;
}

export interface WebDriverStatusDiagnostic {
	endpoint: string;
	httpStatus: number | null;
	rawBody: string;
	truncated: boolean;
	parsedJSON?: unknown;
	parseError: string | null;
	parseSkipped: boolean;
	elapsedMs: number;
	networkError: string | null;
	protocolError: string | null;
	ready: boolean;
	ok: boolean;
}

const STATUS_BODY_LIMIT_BYTES = 64 * 1024;

function boundedErrorText(value: unknown): string {
	const text = value instanceof Error ? value.message : String(value);
	return text.length <= 4096 ? text : `${text.slice(0, 4096)} [truncated]`;
}

function networkErrorText(error: unknown): string {
	let text = boundedErrorText(error);
	if (error instanceof Error && error.cause && typeof error.cause === "object") {
		const cause = error.cause as { code?: unknown; message?: unknown };
		const code = typeof cause.code === "string" || typeof cause.code === "number" ? String(cause.code) : "";
		const message = typeof cause.message === "string" ? cause.message : "";
		if (code || message) {
			text += `; cause ${code}${code && message ? ": " : ""}${message}`;
		}
	}
	return boundedErrorText(text);
}

export class WebDriverAgent {

	private readonly baseUrl: string;
	private readonly requestTimeoutMs: number;

	constructor(host: string, port: number, options: WebDriverAgentOptions = {}) {
		const protocol = options.protocol ?? "http:";
		if (protocol !== "http:" && protocol !== "https:") {
			throw new ActionableError("WebDriverAgent requires HTTP or HTTPS");
		}
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new ActionableError("WebDriverAgent port must be between 1 and 65535");
		}
		this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
		if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
			throw new ActionableError("WebDriverAgent request deadline must be a positive finite duration");
		}
		const hostname = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
		const authority = hostname.includes(":") ? `[${hostname}]` : hostname;
		try {
			const endpoint = new URL(`${protocol}//${authority}:${port}`);
			if (!hostname || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
				throw new Error("Expected only a hostname or IP address");
			}
			this.baseUrl = endpoint.origin;
		} catch {
			throw new ActionableError("Invalid WebDriverAgent hostname");
		}
	}

	/** All WDA calls share transport, protocol-error and response validation. */
	public async requestJson(pathOrUrl: string, init: RequestInit = {}): Promise<WebDriverResponse> {
		return this.checkedRequestJson(pathOrUrl, init);
	}

	// Validate both HTTP and WebDriver protocol failures, including commands
	// whose callers do not consume their response body.
	private async checkedRequestJson(pathOrUrl: string, init: RequestInit = {}, diagnostic?: WebDriverStatusDiagnostic): Promise<WebDriverResponse> {
		const url = new URL(pathOrUrl, `${this.baseUrl}/`);
		if (url.origin !== this.baseUrl || url.username || url.password) {
			throw new ActionableError("WebDriverAgent requests must use the configured origin");
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
		const abortFromCaller = () => controller.abort();
		if (init.signal?.aborted) {
			controller.abort();
		} else {
			init.signal?.addEventListener("abort", abortFromCaller, { once: true });
		}
		const operation = `${init.method ?? "GET"} ${url.pathname}`;
		try {
			const headers = new Headers(init.headers);
			if (init.body !== undefined && !headers.has("Content-Type")) {
				headers.set("Content-Type", "application/json");
			}
			const response = await fetch(url, { ...init, headers, signal: controller.signal, redirect: "error" });
			if (diagnostic) {
				diagnostic.httpStatus = response.status;
			}
			const text = await response.text();
			if (diagnostic) {
				const bytes = Buffer.from(text, "utf8");
				diagnostic.truncated = bytes.length > STATUS_BODY_LIMIT_BYTES;
				let end = Math.min(bytes.length, STATUS_BODY_LIMIT_BYTES);
				// Keep the diagnostic prefix on a UTF-8 boundary, without splitting a code point.
				while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) {
					end--;
				}
				diagnostic.rawBody = bytes.subarray(0, end).toString("utf8");
				diagnostic.parseSkipped = diagnostic.truncated;
			}
			let json: WebDriverResponse;
			try {
				json = JSON.parse(text);
				if (diagnostic && !diagnostic.truncated) {
					diagnostic.parsedJSON = json;
				}
			} catch (error) {
				if (diagnostic) {
					diagnostic.parseError = boundedErrorText(error);
				}
				if (!response.ok) {
					throw new ActionableError(`WebDriverAgent ${operation} failed: HTTP ${response.status} ${text.slice(0, 1000)}`);
				}
				throw new ActionableError(`WebDriverAgent ${operation} returned invalid JSON`);
			}
			if (!response.ok) {
				throw new ActionableError(`WebDriverAgent ${operation} failed: HTTP ${response.status} ${text.slice(0, 1000)}`);
			}
			if (!json || typeof json !== "object" || Array.isArray(json) || !("value" in json)) {
				throw new ActionableError(`WebDriverAgent ${operation} returned an invalid response envelope`);
			}
			if (json.status !== undefined && json.status !== null && json.status !== 0 && json.status !== "0") {
				throw new ActionableError(`WebDriverAgent ${operation} failed: status ${boundedErrorText(json.status)} ${JSON.stringify(json.value).slice(0, 1000)}`);
			}
			if (json.value && typeof json.value === "object" && json.value.error !== undefined && json.value.error !== null) {
				throw new ActionableError(`WebDriverAgent ${operation} failed: ${boundedErrorText(json.value.error)} ${String(json.value.message ?? "").slice(0, 1000)}`);
			}
			return json;
		} catch (error) {
			if (error instanceof ActionableError) {
				throw error;
			}
			const detail = controller.signal.aborted ? "request aborted or deadline exceeded" : networkErrorText(error);
			if (diagnostic) {
				diagnostic.networkError = detail;
			}
			throw new ActionableError(`WebDriverAgent ${operation} failed: ${detail}`);
		} finally {
			clearTimeout(timer);
			init.signal?.removeEventListener("abort", abortFromCaller);
		}
	}

	public async getStatusDiagnostic(): Promise<WebDriverStatusDiagnostic> {
		const started = performance.now();
		const diagnostic: WebDriverStatusDiagnostic = {
			endpoint: `${this.baseUrl}/status`,
			httpStatus: null,
			rawBody: "",
			truncated: false,
			parseError: null,
			parseSkipped: false,
			elapsedMs: 0,
			networkError: null,
			protocolError: null,
			ready: false,
			ok: false,
		};
		try {
			const json = await this.checkedRequestJson(diagnostic.endpoint, {}, diagnostic);
			diagnostic.ready = json.value?.ready === true;
			diagnostic.ok = diagnostic.ready;
		} catch (error) {
			if (!diagnostic.networkError) {
				diagnostic.protocolError = boundedErrorText(error);
			}
		} finally {
			diagnostic.elapsedMs = Math.round((performance.now() - started) * 100) / 100;
		}
		return diagnostic;
	}

	public async assertReady(): Promise<void> {
		const diagnostic = await this.getStatusDiagnostic();
		if (!diagnostic.ready) {
			const reason = diagnostic.networkError ?? diagnostic.protocolError ?? "response value.ready is not true";
			const error = new ActionableError(`WebDriverAgent is not ready at ${diagnostic.endpoint} (HTTP ${diagnostic.httpStatus ?? "unavailable"}): ${reason}`);
			Object.defineProperty(error, "statusDiagnostic", { value: diagnostic, enumerable: true });
			throw error;
		}
	}

	public async isRunning(): Promise<boolean> {
		const url = `${this.baseUrl}/status`;
		try {
			const json = await this.requestJson(url);
			return json.value?.ready === true;
		} catch (error) {
			// console.error(`Failed to connect to WebDriverAgent: ${error}`);
			return false;
		}
	}

	public async createSession(): Promise<string> {
		const url = `${this.baseUrl}/session`;
		const json = await this.requestJson(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ capabilities: { alwaysMatch: { platformName: "iOS" } } }),
		});

		const sessionId = json.sessionId ?? json.value?.sessionId;
		this.sessionUrl(sessionId);
		return sessionId;
	}

	private sessionUrl(sessionId: string): string {
		if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId === "." || sessionId === "..") {
			throw new ActionableError("Invalid WebDriverAgent session ID");
		}
		try {
			return `${this.baseUrl}/session/${encodeURIComponent(sessionId)}`;
		} catch {
			throw new ActionableError("WebDriverAgent returned a session ID with invalid Unicode");
		}
	}

	public async deleteSession(sessionId: string) {
		return this.requestJson(this.sessionUrl(sessionId), { method: "DELETE" });
	}

	public async withinSession<T>(fn: (url: string) => Promise<T>): Promise<T> {
		const sessionId = await this.createSession();
		const url = this.sessionUrl(sessionId);
		let operationFailed = false;
		let operationError: unknown;
		try {
			return await fn(url);
		} catch (error) {
			operationFailed = true;
			operationError = error;
			throw error;
		} finally {
			try {
				await this.deleteSession(sessionId);
			} catch (cleanupError) {
				if (!operationFailed) {
					throw cleanupError;
				}
				// Preserve the primary operation error if cleanup also fails.
				if (operationError instanceof Error) {
					try {
						Object.defineProperty(operationError, "cleanupError", { value: cleanupError, configurable: true });
					} catch {
						// A frozen caller error must still be rethrown unchanged.
					}
				}
			}
		}
	}

	public async getScreenSize(sessionUrl?: string): Promise<ScreenSize> {
		if (sessionUrl) {
			const url = `${sessionUrl}/wda/screen`;
			const json = await this.requestJson(url);
			return {
				width: json.value.screenSize.width,
				height: json.value.screenSize.height,
				scale: json.value.scale || 1,
			};
		} else {
			return this.withinSession(async sessionUrlInner => {
				const url = `${sessionUrlInner}/wda/screen`;
				const json = await this.requestJson(url);
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
			await this.requestJson(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ value: [keys] }),
			});
		});
	}

	public async pressButton(button: string) {
		const _map: Record<string, string> = {
			"HOME": "home",
			"VOLUME_UP": "volumeup",
			"VOLUME_DOWN": "volumedown",
		};

		if (button === "ENTER") {
			await this.sendKeys("\n");
			return;
		}

		// Type assertion to check if button is a key of _map
		if (!Object.prototype.hasOwnProperty.call(_map, button)) {
			throw new ActionableError(`Button "${button}" is not supported`);
		}

		await this.withinSession(async sessionUrl => {
			const url = `${sessionUrl}/wda/pressButton`;
			const json = await this.requestJson(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name: _map[button],
				}),
			});

			return json;
		});
	}

	public async tap(x: number, y: number) {
		await this.withinSession(async sessionUrl => {
			const url = `${sessionUrl}/actions`;
			await this.requestJson(url, {
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
			await this.requestJson(url, {
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
			await this.requestJson(url, {
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

	public async getPageSource(sessionUrl?: string): Promise<SourceTree> {
		if (!sessionUrl) {
			return this.withinSession(url => this.getPageSource(url));
		}
		const url = `${sessionUrl}/source?format=json`;
		const json = await this.requestJson(url);
		return json as SourceTree;
	}

	public async getElementsOnScreen(sessionUrl?: string): Promise<ScreenElement[]> {
		const source = await this.getPageSource(sessionUrl);
		return this.filterSourceElements(source.value);
	}

	public async openUrl(url: string): Promise<void> {
		await this.withinSession(async sessionUrl => {
			await this.requestJson(`${sessionUrl}/url`, {
				method: "POST",
				body: JSON.stringify({ url }),
			});
		});
	}

	public async getScreenshot(sessionUrl?: string): Promise<Buffer> {
		if (!sessionUrl) {
			return this.withinSession(url => this.getScreenshot(url));
		}
		const url = `${sessionUrl}/screenshot`;
		const json = await this.requestJson(url);
		return Buffer.from(json.value, "base64");
	}

	public async captureScreen(): Promise<WebDriverScreenCapture> {
		// One owned session spans the ordered reads; never borrow a server session.
		return this.withinSession(async sessionUrl => ({
			size: await this.getScreenSize(sessionUrl),
			elements: await this.getElementsOnScreen(sessionUrl),
			screenshot: await this.getScreenshot(sessionUrl),
		}));
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
			await this.requestJson(url, {
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

			// Clear actions to ensure they complete
			await this.requestJson(`${sessionUrl}/actions`, {
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
			await this.requestJson(url, {
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

			// Clear actions to ensure they complete
			await this.requestJson(`${sessionUrl}/actions`, {
				method: "DELETE",
			});
		});
	}

	public async setOrientation(orientation: Orientation): Promise<void> {
		await this.withinSession(async sessionUrl => {
			const url = `${sessionUrl}/orientation`;
			await this.requestJson(url, {
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
			const json = await this.requestJson(url);
			return json.value.toLowerCase() as Orientation;
		});
	}
}

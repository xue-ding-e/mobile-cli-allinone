import { expect, test } from "@playwright/test";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import { WebDriverAgent } from "../src/webdriver-agent";

type RequestRecord = { method: string; path: string; body: any; contentType?: string };
type Handler = (request: RequestRecord, response: ServerResponse) => void;
const servers: Server[] = [];

function json(response: ServerResponse, value: unknown, statusCode = 200) {
	response.writeHead(statusCode, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

async function mockWda(handler?: Handler, requestTimeoutMs = 2000) {
	const requests: RequestRecord[] = [];
	const server = createServer(async (request: IncomingMessage, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			chunks.push(Buffer.from(chunk));
		}
		const body = Buffer.concat(chunks).toString("utf8");
		const record = {
			method: request.method ?? "GET",
			path: request.url ?? "/",
			body: body ? JSON.parse(body) : undefined,
			contentType: request.headers["content-type"],
		};
		requests.push(record);
		if (handler) {
			handler(record, response);
		} else {
			json(response, { value: null });
		}
	});
	// Windows listen(0) can allocate a Fetch-forbidden port such as 6000.
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			server.listen(49152 + Math.floor(Math.random() * (65535 - 49152)), "127.0.0.1");
			await once(server, "listening");
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt === 2) {
				throw error;
			}
		}
	}
	servers.push(server);
	const port = (server.address() as AddressInfo).port;
	return { client: new WebDriverAgent("127.0.0.1", port, { requestTimeoutMs }), requests, port, server };
}

function sessionResponse(request: RequestRecord, response: ServerResponse): boolean {
	if (request.method === "POST" && request.path === "/session") {
		json(response, { value: { sessionId: "test-session" } });
		return true;
	}
	if (request.method === "DELETE" && request.path === "/session/test-session") {
		json(response, { value: null });
		return true;
	}
	return false;
}

test.afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});

test("all WDA HTTP calls reject unsuccessful HTTP, JSONWP and W3C responses", async () => {
	const cases = [
		{ body: { value: { error: "invalid argument", message: "refused action" } }, status: 200, error: /invalid argument.*refused action/ },
		{ body: { value: "legacy failure", status: 13 }, status: 200, error: /status 13.*legacy failure/ },
		{ body: { value: null }, status: 503, error: /HTTP 503/ },
	];
	for (const item of cases) {
		const { client } = await mockWda((_request, response) => json(response, item.body, item.status));
		await expect(client.requestJson("/status")).rejects.toThrow(item.error);
		await expect(client.isRunning()).resolves.toBe(false);
	}
});

test("invalid JSON and invalid success envelopes cannot become successful commands", async () => {
	for (const body of ["not json", "null", "[]", "{}", '{"ready":true}']) {
		const { client } = await mockWda((_request, response) => response.end(body));
		await expect(client.requestJson("/status")).rejects.toThrow(/invalid JSON|invalid response envelope/);
	}
});

test("a request deadline covers both headers and a response body that never completes", async () => {
	for (const startBody of [false, true]) {
		const { client } = await mockWda((_request, response) => {
			if (startBody) {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.flushHeaders();
				response.write('{"value":');
			}
		}, 250);
		await expect(client.requestJson("/status")).rejects.toThrow(/deadline exceeded/);
	}
});

test("withinSession always deletes after a callback failure without replacing the original error", async () => {
	const { client, requests } = await mockWda((request, response) => {
		if (request.method === "POST") {
			json(response, { value: { sessionId: "test-session" } });
		} else {
			json(response, { value: { error: "cleanup failed" } });
		}
	});
	const original = new Error("original callback failure");
	await expect(client.withinSession(async () => { throw original; })).rejects.toBe(original);
	expect((original as Error & { cleanupError: Error }).cleanupError.message).toContain("cleanup failed");
	expect(requests.map(request => request.method)).toEqual(["POST", "DELETE"]);
});

test("cleanup failure rejects an otherwise successful operation", async () => {
	const { client } = await mockWda((request, response) => {
		json(response, request.method === "POST" ? { value: { sessionId: "test-session" } } : { value: null, status: 13 });
	});
	await expect(client.withinSession(async () => "done")).rejects.toThrow(/status 13/);
});

test("a frozen caller error and thrown primitive survive cleanup failures", async () => {
	const { client } = await mockWda((request, response) => {
		json(response, request.method === "POST" ? { value: { sessionId: "test-session" } } : { value: null }, request.method === "POST" ? 200 : 500);
	});
	const frozen = Object.freeze(new Error("frozen operation"));
	await expect(client.withinSession(async () => { throw frozen; })).rejects.toBe(frozen);
	await expect(client.withinSession(async () => { throw "primitive operation"; })).rejects.toBe("primitive operation");
});

test("session IDs are single encoded URL components for commands and cleanup", async () => {
	const sessionId = "test/escape?# %雪";
	const { client, requests } = await mockWda((request, response) => {
		json(response, request.method === "POST" ? { value: { sessionId } } : { value: null });
	});
	let observedUrl = "";
	await client.withinSession(async url => { observedUrl = url; });
	expect(new URL(observedUrl).pathname).toBe(`/session/${encodeURIComponent(sessionId)}`);
	expect(requests[1].path).toBe(`/session/${encodeURIComponent(sessionId)}`);
});

test("legacy top-level session IDs remain supported and missing IDs are rejected", async () => {
	const valid = await mockWda((_request, response) => json(response, { value: {}, sessionId: "legacy" }));
	await expect(valid.client.createSession()).resolves.toBe("legacy");
	const invalid = await mockWda((_request, response) => json(response, { value: {} }));
	await expect(invalid.client.createSession()).rejects.toThrow(/Invalid WebDriverAgent session ID/);
});

test("button names use WDA mappings and inherited object keys never become buttons", async () => {
	const { client, requests } = await mockWda((request, response) => {
		if (!sessionResponse(request, response)) {
			json(response, { value: null });
		}
	});
	for (const button of ["HOME", "VOLUME_UP", "VOLUME_DOWN", "ENTER"]) {
		await client.pressButton(button);
	}
	expect(requests.filter(request => request.path.endsWith("/pressButton")).map(request => request.body.name))
		.toEqual(["home", "volumeup", "volumedown"]);
	expect(requests.find(request => request.path.endsWith("/keys"))?.body).toEqual({ value: ["\n"] });
	const previousCount = requests.length;
	for (const name of ["toString", "__proto__", "BACK"]) {
		await expect(client.pressButton(name)).rejects.toThrow(/not supported/);
	}
	expect(requests).toHaveLength(previousCount);
});

const commandCases: Array<{ name: string; path: string; run: (client: WebDriverAgent) => Promise<unknown> }> = [
	{ name: "tap", path: "/actions", run: client => client.tap(10, 20) },
	{ name: "doubleTap", path: "/actions", run: client => client.doubleTap(10, 20) },
	{ name: "longPress", path: "/actions", run: client => client.longPress(10, 20, 500) },
	{ name: "swipe", path: "/actions", run: client => client.swipe("up") },
	{ name: "coordinate swipe", path: "/actions", run: client => client.swipeFromCoordinate(10, 20, "up", 10) },
	{ name: "keys", path: "/wda/keys", run: client => client.sendKeys("text") },
	{ name: "pressButton", path: "/wda/pressButton", run: client => client.pressButton("HOME") },
	{ name: "screen", path: "/wda/screen", run: client => client.getScreenSize() },
	{ name: "orientation read", path: "/orientation", run: client => client.getOrientation() },
	{ name: "orientation write", path: "/orientation", run: client => client.setOrientation("portrait") },
	{ name: "openUrl", path: "/url", run: client => client.openUrl("https://example.invalid") },
	{ name: "source", path: "/source/?format=json", run: client => client.getPageSource() },
	{ name: "screenshot", path: "/screenshot", run: client => client.getScreenshot() },
];
for (const command of commandCases) {
	test(`${command.name} rejects protocol failure and cleans any created session`, async () => {
		const { client, requests } = await mockWda((request, response) => {
			if (sessionResponse(request, response)) {
				return;
			}
			if (request.path === `/session/test-session${command.path}` || request.path === command.path) {
				json(response, { value: { error: "unsupported operation", message: command.name } });
			} else {
				json(response, { value: { screenSize: { width: 390, height: 844 }, scale: 3 } });
			}
		});
		await expect(command.run(client)).rejects.toThrow(/unsupported operation/);
		if (requests[0].path === "/session") {
			expect(requests.at(-1)?.method).toBe("DELETE");
			expect(requests.at(-1)?.path).toBe("/session/test-session");
		}
	});
}

test("swipe validates DELETE actions response and still deletes its session", async () => {
	const { client, requests } = await mockWda((request, response) => {
		if (sessionResponse(request, response)) {
			return;
		}
		if (request.method === "DELETE" && request.path.endsWith("/actions")) {
			json(response, { value: { error: "action cleanup refused" } });
		} else if (request.path.endsWith("/screen")) {
			json(response, { value: { screenSize: { width: 390, height: 844 }, scale: 3 } });
		} else {
			json(response, { value: null });
		}
	});
	await expect(client.swipe("up")).rejects.toThrow(/action cleanup refused/);
	expect(requests.at(-1)?.path).toBe("/session/test-session");
});

test("successful JSON envelopes keep screen, source, screenshot, orientation and URL behavior", async () => {
	const { client, requests } = await mockWda((request, response) => {
		if (sessionResponse(request, response)) {
			return;
		}
		const value = request.path.endsWith("/screen") ? { screenSize: { width: 390, height: 844 }, scale: 3 }
			: request.path === "/screenshot" ? Buffer.from("png content").toString("base64")
				: request.path.startsWith("/source") ? { type: "Application", rect: { x: 0, y: 0, width: 390, height: 844 } }
					: request.path.endsWith("/orientation") ? "PORTRAIT"
						: request.path === "/status" ? { ready: true } : null;
		json(response, { value, status: 0 });
	});
	await expect(client.isRunning()).resolves.toBe(true);
	await expect(client.getScreenSize()).resolves.toEqual({ width: 390, height: 844, scale: 3 });
	await expect(client.getScreenshot()).resolves.toEqual(Buffer.from("png content"));
	await expect(client.getPageSource()).resolves.toMatchObject({ value: { type: "Application" } });
	await expect(client.getOrientation()).resolves.toBe("portrait");
	await client.openUrl("https://example.invalid/path");
	const openUrl = requests.find(request => request.path.endsWith("/url"));
	expect(openUrl?.contentType).toBe("application/json");
	expect(openUrl?.body).toEqual({ url: "https://example.invalid/path" });
});

test("IPv6 and HTTPS constructor options preserve the endpoint and reject malformed hosts", async () => {
	for (const host of ["::1", "[::1]"]) {
		const client = new WebDriverAgent(host, 8100, { protocol: "https:" });
		// Validate URL construction without touching an IPv6 or phone endpoint.
		expect((client as unknown as { baseUrl: string }).baseUrl).toBe("https://[::1]:8100");
	}
	for (const host of ["", "user@localhost", "localhost/path", "localhost?query", "localhost#fragment"]) {
		expect(() => new WebDriverAgent(host, 8100)).toThrow(/hostname/);
	}
	expect(() => new WebDriverAgent("127.0.0.1", 0)).toThrow(/port/);
	expect(() => new WebDriverAgent("127.0.0.1", 8100, { requestTimeoutMs: Infinity })).toThrow(/deadline/);
});

test("public requests reject foreign origins before opening a connection", async () => {
	const { client, requests } = await mockWda();
	await expect(client.requestJson("http://127.0.0.1:1/status")).rejects.toThrow(/configured origin/);
	expect(requests).toHaveLength(0);
});


test("HTTP redirects cannot escape the configured WDA origin", async () => {
	const target = await mockWda();
	const source = await mockWda((_request, response) => {
		response.writeHead(302, { Location: `http://127.0.0.1:${target.port}/status` });
		response.end();
	});
	await expect(source.client.requestJson("/status")).rejects.toThrow(/failed/);
	expect(target.requests).toHaveLength(0);
});


test("unaddressable session IDs are rejected instead of normalizing into another endpoint", async () => {
	for (const sessionId of [".", "..", "\ud800"]) {
		const { client, requests } = await mockWda((_request, response) => json(response, { value: { sessionId } }));
		await expect(client.createSession()).rejects.toThrow(/Invalid WebDriverAgent session ID|invalid Unicode/);
		await expect(client.deleteSession(sessionId)).rejects.toThrow(/Invalid WebDriverAgent session ID|invalid Unicode/);
		expect(requests.map(request => request.path)).toEqual(["/session"]);
	}
});


test("status diagnostics use one GET and preserve the actual ready response", async () => {
	const body = { value: { ready: true, message: "WebDriverAgent is ready" }, status: 0 };
	const { client, requests, port } = await mockWda((_request, response) => json(response, body));
	const diagnostic = await client.getStatusDiagnostic();
	expect(diagnostic).toMatchObject({ endpoint: `http://127.0.0.1:${port}/status`, httpStatus: 200, ready: true, ok: true,
		rawBody: JSON.stringify(body), parsedJSON: body, truncated: false, parseSkipped: false, parseError: null,
		networkError: null, protocolError: null });
	expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(0);
	expect(requests.map(request => [request.method, request.path])).toEqual([["GET", "/status"]]);
});

test("HTTP 200 alone and alternate status shapes never assert readiness", async () => {
	for (const body of [{ value: { ready: false } }, { value: { message: "ready" } }, { value: { ready: "true" } }, { value: { status: "success" } }]) {
		const { client, requests } = await mockWda((_request, response) => json(response, body));
		const diagnostic = await client.getStatusDiagnostic();
		expect(diagnostic).toMatchObject({ httpStatus: 200, ready: false, ok: false, parsedJSON: body, networkError: null });
		expect(requests).toHaveLength(1);
		await expect(client.assertReady()).rejects.toThrow(/value.ready is not true/);
		expect(requests).toHaveLength(2);
	}
});

test("status diagnostics preserve HTTP, protocol and malformed JSON failures", async () => {
	const cases = [
		{ status: 503, raw: '{"value":{"ready":true}}', error: /HTTP 503/ },
		{ status: 200, raw: '{"value":{"ready":true,"error":"unknown error"}}', error: /unknown error/ },
		{ status: 200, raw: '{"value":{"ready":true},"status":13}', error: /status 13/ },
		{ status: 200, raw: "this is not JSON", error: /invalid JSON/ },
	];
	for (const item of cases) {
		const { client, requests } = await mockWda((_request, response) => { response.writeHead(item.status); response.end(item.raw); });
		const diagnostic = await client.getStatusDiagnostic();
		expect(diagnostic).toMatchObject({ httpStatus: item.status, rawBody: item.raw, ready: false, ok: false, networkError: null });
		expect(diagnostic.protocolError).toMatch(item.error);
		if (item.raw === "this is not JSON") {
			expect(diagnostic.parseError).toBeTruthy();
		}
		expect(requests).toHaveLength(1);
	}
});

test("assertReady attaches the same failed probe without a duplicate GET", async () => {
	const { client, requests } = await mockWda((_request, response) => json(response, { value: { error: "session unavailable", message: "wda stopped" } }, 500));
	const failure = await client.assertReady().catch(error => error);
	expect(failure.message).toMatch(/HTTP 500/);
	expect(failure.statusDiagnostic).toMatchObject({ httpStatus: 500, ready: false, ok: false,
		parsedJSON: { value: { error: "session unavailable", message: "wda stopped" } } });
	expect(requests).toHaveLength(1);
});

test("status diagnostic deadlines return structured network failures", async () => {
	const { client, requests } = await mockWda(() => {}, 250);
	const diagnostic = await client.getStatusDiagnostic();
	expect(diagnostic).toMatchObject({ httpStatus: null, rawBody: "", ready: false, ok: false, protocolError: null });
	expect(diagnostic.networkError).toMatch(/deadline exceeded/);
	expect(requests).toHaveLength(1);
});

test("diagnostic output caps the UTF-8 body and omits oversized parsed JSON", async () => {
	const body = { value: { ready: true, message: "雪".repeat(30000) } };
	const { client, requests } = await mockWda((_request, response) => json(response, body));
	const diagnostic = await client.getStatusDiagnostic();
	expect(diagnostic).toMatchObject({ httpStatus: 200, ready: true, ok: true, truncated: true, parseSkipped: true, parseError: null });
	expect(Buffer.byteLength(diagnostic.rawBody, "utf8")).toBeLessThanOrEqual(64 * 1024);
	expect(diagnostic.rawBody).not.toContain("\ufffd");
	expect(diagnostic.parsedJSON).toBeUndefined();
	expect(JSON.stringify(diagnostic).length).toBeLessThan(64 * 1024 + 2000);
	expect(requests).toHaveLength(1);
});


test("oversized WDA error fields cannot bypass the diagnostic body limit", async () => {
	for (const body of [{ value: { error: "e".repeat(100000) } }, { value: null, status: "s".repeat(100000) }]) {
		const { client } = await mockWda((_request, response) => json(response, body));
		const diagnostic = await client.getStatusDiagnostic();
		expect(diagnostic).toMatchObject({ ready: false, ok: false, truncated: true, parseSkipped: true });
		expect(diagnostic.protocolError?.length).toBeLessThanOrEqual(4096 + " [truncated]".length);
		expect(diagnostic.protocolError).toContain("[truncated]");
		expect(JSON.stringify(diagnostic).length).toBeLessThan(72 * 1024);
		const failure = await client.assertReady().catch(error => error);
		expect(failure.message.length).toBeLessThan(5000);
	}
});


test("refused loopback connections retain the actual transport cause code", async () => {
	const { client, server } = await mockWda();
	servers.splice(servers.indexOf(server), 1);
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	const diagnostic = await client.getStatusDiagnostic();
	expect(diagnostic).toMatchObject({ httpStatus: null, rawBody: "", ready: false, ok: false, protocolError: null });
	expect(diagnostic.networkError).toContain("ECONNREFUSED");
	expect(diagnostic.networkError?.length).toBeLessThanOrEqual(4096 + " [truncated]".length);
});

import { test, expect } from "@playwright/test";
import { WebDriverAgent } from "../src/webdriver-agent";
const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; options?: RequestInit }>;
test.beforeEach(() => {calls = [];});
test.afterEach(() => {globalThis.fetch = originalFetch;});
const mock = (failure?: number, cleanupFailure = false) => {
	globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
		const url = String(input);
		calls.push({ url, options });
		if (url.endsWith("/session")) {return Response.json({ value: { sessionId: "stub-session" } });}
		if (options?.method === "DELETE") {return Response.json({ value: cleanupFailure ? { error: "cleanup failed" } : null }, { status: cleanupFailure ? 500 : 200 });}
		return Response.json({ value: failure ? { error: "invalid argument", message: "operation rejected" } : null }, { status: failure || 200 });
	}) as typeof fetch;
};
test("WDA maps HOME to the wire button name", async () => {
	mock();
	await new WebDriverAgent("localhost", 8100).pressButton("HOME");
	expect(JSON.parse(calls[1].options!.body as string)).toEqual({ name: "home" });
});
for (const operation of ["tap", "sendKeys", "openUrl", "pressButton"] as const) {
	test(`WDA ${operation} rejects HTTP errors and deletes session`, async () => {
		mock(500, true);
		const wda = new WebDriverAgent("localhost", 8100);
		const action = operation === "tap" ? wda.tap(1, 2) : operation === "sendKeys" ? wda.sendKeys("a") : operation === "openUrl" ? wda.openUrl("https://example.com") : wda.pressButton("HOME");
		await expect(action).rejects.toThrow("operation rejected");
		expect(calls.at(-1)?.options?.method).toBe("DELETE");
	});
}
test("WDA rejects protocol errors even with HTTP 200", async () => {
	mock(200);
	await expect(new WebDriverAgent("localhost", 8100).tap(1, 2)).rejects.toThrow("operation rejected");
});
test("WDA reports cleanup failure after successful operation", async () => {
	mock(undefined, true);
	await expect(new WebDriverAgent("localhost", 8100).tap(1, 2)).rejects.toThrow("cleanup failed");
});

/**
 * Wire test: drive the plugin's real seams and read the headers off the
 * requests the SDK actually sent. Nothing here asserts on a formatting helper —
 * a header that is built correctly and never reaches a request is the failure
 * this is for.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../src/index.ts";

/** A cordis context reduced to what `apply()` touches. */
function stubContext() {
  const handlers = new Map<string, Function[]>();
  const tools: { name: string; execute: Function }[] = [];
  const ctx = {
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    // Capture is wired behind `ctx.inject(["sessionQuery"])`; this test is
    // about headers, so the seam is left unmounted (the degraded path).
    inject() {},
    effect() {},
    get: () => undefined,
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: { register: (tool: { name: string; execute: Function }) => tools.push(tool) },
  };
  const fire = (name: string, ...args: unknown[]) =>
    Promise.all((handlers.get(name) ?? []).map((handler) => handler(...args)));
  /** A model-facing tool call: the awaited path to a request, after the turn
   *  that made it has settled. */
  const search = () =>
    tools.find((tool) => tool.name === "honcho_search")!.execute(
      { query: "what do you know", limit: 1 },
      { agent: { session: { id: "session-1", header: { cwd: "/tmp/project" } } } },
    );
  return { ctx, fire, search };
}

const sessionEvent = (type: string, data: unknown) =>
  ["session/event", { id: "session-1" }, { type, data }] as const;

const preStep = (fire: ReturnType<typeof stubContext>["fire"]) =>
  fire(
    "agent/pre-step",
    { agent: { session: { id: "session-1", header: { cwd: "/tmp/project" } } }, messages: [], step: 1 },
    async () => ({ kind: "enter", messages: [] }),
  );

test("every request carries host, plugin, and the model that is answering", async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), "dsh-honcho-telemetry-")), "config.json");
  writeFileSync(configPath, JSON.stringify({ peerName: "abigail", auth: { apiKey: "test-key" } }));

  const sent: Headers[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    sent.push(new Headers(init.headers));
    // Enough of a body for the SDK to build a peer, a session, and a context
    // from; the assertions are on what went out, not on what came back.
    const body = { id: "test", metadata: {}, configuration: {}, created_at: new Date().toISOString(), is_active: true, messages: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const { ctx, fire, search } = stubContext();
    apply(ctx as never, { configPath });

    // Turn 1: memory is fetched before any model has answered.
    await preStep(fire);
    const beforeModel = sent.length;
    expect(beforeModel).toBeGreaterThan(0);

    // The request-time snapshot names the model before any answer comes back.
    await fire(...sessionEvent("request/header", { header: { config: { provider: "deepseek", model: "deepseek-chat" } } }));
    await search();
    const afterHeader = sent.length;

    // A completed assistant message from a different model — a mid-session switch.
    await fire(...sessionEvent("assistant/message", { message: { source: { kind: "model", provider: "openrouter", model: "kimi-k2" } } }));
    await search();

    const plugin = `dsh-honcho/${(JSON.parse(readFileSync("package.json", "utf-8")) as { version: string }).version}`;
    const host = new RegExp(`^dsh/\\S+ \\(${process.platform}\\)$`);

    expect(sent.length).toBeGreaterThan(afterHeader);
    for (const headers of sent) {
      expect(headers.get("X-Honcho-Host")).toMatch(host);
      expect(headers.get("X-Honcho-Plugin")).toBe(plugin);
    }
    for (const headers of sent.slice(0, beforeModel)) expect(headers.get("X-Honcho-Agent-Model")).toBeNull();
    for (const headers of sent.slice(beforeModel, afterHeader)) {
      expect(headers.get("X-Honcho-Agent-Model")).toBe("deepseek/deepseek-chat");
    }
    for (const headers of sent.slice(afterHeader)) {
      expect(headers.get("X-Honcho-Agent-Model")).toBe("openrouter/kimi-k2");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * Client telemetry identity: who is talking to Honcho, and with which model.
 *
 * The header formatting is `@honcho-ai/harness-plugin-core`'s, re-exported here
 * so the rest of the plugin has one telemetry import and every integration
 * sends byte-identical values. What this file owns is the dsh half: where the
 * harness version and the answering model come from, which is per-harness work.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type { TelemetryIdentity } from "@honcho-ai/harness-plugin-core";

export {
  hostHeaderValue,
  pluginHeaderValue,
  setTelemetryHeaders,
  telemetryHeaders,
  HEADER_AGENT_MODEL,
  HEADER_HOST,
  HEADER_PLUGIN,
  type TelemetryIdentity,
} from "@honcho-ai/harness-plugin-core";

// ── dsh's half: where each value comes from ────────────────────────────────

/** The `hosts.<name>` config key this plugin resolves under. */
export const HOST_ID = "dsh";
/** npm package name without the scope. */
export const PLUGIN_ID = "dsh-honcho";

/** The parts of the identity that are only known once a session is running. */
export type TelemetryOverrides = Pick<TelemetryIdentity, "hostVersion" | "model">;

const requireFrom = createRequire(import.meta.url);

function versionAt(manifestPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

let plugin: string | undefined;

/**
 * This plugin's own version, from the `package.json` npm always ships. Read
 * lazily, memoized on success only, and guarded: a wrong relative path must
 * never be able to stop the plugin from loading. `../package.json` holds from
 * both `src/` and the built `lib/`.
 */
export function pluginVersion(): string {
  return (plugin ??= versionAt(fileURLToPath(new URL("../package.json", import.meta.url)))) ?? "unknown";
}

/**
 * Manifests whose version is the running harness's, best first.
 *
 * dsh exposes no version to a plugin — not on the context, not in the
 * environment, not in a session event; `readVersion()` in its CLI reads its own
 * `package.json` only to answer `--version`. So the version is read back off
 * the installation. `@deepseek-ai/dsh` is the CLI package itself, and
 * `healProfilesModuleFallback()` symlinks the whole installation closure into
 * `$DSH_HOME/profiles/node_modules`, which is on this module's resolution path
 * — so the exact running harness answers first.
 *
 * `@deepseek-ai/dsh-session` is the fallback for the case that symlink is
 * absent (a packaged executable writes ESM proxies instead, and skips a package
 * with no importable entry, which `@deepseek-ai/dsh` is). The harness publishes
 * every package in lockstep, so a peer's version is the harness's — unless a
 * profile installed its own copy of that peer, which is why it is second.
 */
const HOST_VERSION_SOURCES = ["@deepseek-ai/dsh/package.json", "@deepseek-ai/dsh-session/package.json"];

let host: string | undefined;

/** The running harness's version, or undefined — in which case it is omitted. */
export function hostVersion(): string | undefined {
  if (host) return host;
  for (const specifier of HOST_VERSION_SOURCES) {
    try {
      const version = versionAt(requireFrom.resolve(specifier));
      if (version) return (host = version);
    } catch {
      // Not resolvable from here; try the next source.
    }
  }
  return undefined;
}

/** The full identity, with whatever the running session has taught us. */
export function telemetryIdentity(overrides: TelemetryOverrides = {}): TelemetryIdentity {
  return {
    host: HOST_ID,
    plugin: PLUGIN_ID,
    pluginVersion: pluginVersion(),
    ...(overrides.hostVersion ? { hostVersion: overrides.hostVersion } : {}),
    ...(overrides.model ? { model: overrides.model } : {}),
  };
}

/**
 * The model behind one durable session event, as `provider/model`.
 *
 * Two event types carry it. `assistant/message` is authoritative — its
 * `source` is the provenance of the message the model actually produced
 * (`ModelMessageSource`, `@deepseek-ai/dsh-llm`). `request/header` is the
 * request-time snapshot, logged on the first request and again whenever the
 * call config changes, so it names the model one request earlier and covers a
 * mid-session `/model` switch before any answer comes back. Everything else
 * returns undefined, which leaves the last known model in place.
 */
export function modelFromSessionEvent(event: unknown): string | undefined {
  const { type, data } = (event ?? {}) as { type?: string; data?: unknown };
  if (type === "assistant/message") {
    const source = (data as { message?: { source?: unknown } })?.message?.source;
    return route(source);
  }
  if (type === "request/header") {
    return route((data as { header?: { config?: unknown } })?.header?.config);
  }
  return undefined;
}

/** `provider/model` from anything carrying that pair; the bare id when the provider is missing.
 *  Core sanitizes the value it puts on the wire; this only has to reject what is not a
 *  usable string. */
function route(source: unknown): string | undefined {
  const { provider, model } = (source ?? {}) as { provider?: unknown; model?: unknown };
  const id = text(model);
  if (!id) return undefined;
  const from = text(provider);
  return from ? `${from}/${id}` : id;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

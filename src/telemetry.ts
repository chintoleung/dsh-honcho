/**
 * Client telemetry identity: who is talking to Honcho, and with which model.
 * Formatting is core's, re-exported so the plugin has one telemetry import;
 * this file owns the dsh half — where the version and the model come from.
 * Sources and rationale: ARCHITECTURE.md, "Telemetry".
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

/** This plugin's own version. Lazy, memoized on success only, and guarded;
 *  `../package.json` resolves from both `src/` and the built `lib/`. */
export function pluginVersion(): string {
  return (plugin ??= versionAt(fileURLToPath(new URL("../package.json", import.meta.url)))) ?? "unknown";
}

/** Manifests whose version is the running harness's, best first. dsh exposes no
 *  version to a plugin, so it is read off the installation instead. */
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
 * `assistant/message` is authoritative; `request/header` is the request-time
 * snapshot, which lands one request earlier and on every mid-session switch.
 * Anything else returns undefined, leaving the last known model in place.
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

/** `provider/model`, or the bare id when the provider is missing. Core sanitizes
 *  what goes on the wire; this only rejects what is not a usable string. */
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

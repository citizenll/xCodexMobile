import type { SessionOutboundMessage } from "../../shared/messages.js";
import type { XcodexBridgeAppServerEvent } from "../xcodex-bridge.js";
import { isXcodexTurnLifecycleAppServerEvent } from "./stream-events.js";

type AgentStreamPayload = Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"];

export interface XcodexBridgeEventRoute {
  agentId: string;
  workspaceId: string;
  agentStreamPayload: AgentStreamPayload | null;
  refreshDirectory: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringField(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function xcodexThreadIdFromEvent(event: XcodexBridgeAppServerEvent): string | null {
  const message = recordFromUnknown(event.payload.message);
  const params = recordFromUnknown(message?.params);
  return (
    stringField(params, ["threadId", "thread_id"]) ??
    stringField(recordFromUnknown(params?.turn), ["threadId", "thread_id"]) ??
    stringField(recordFromUnknown(params?.item), ["threadId", "thread_id"]) ??
    stringField(recordFromUnknown(params?.thread), ["id", "threadId", "thread_id"])
  );
}

function xcodexMethodFromEvent(event: XcodexBridgeAppServerEvent): string {
  const message = recordFromUnknown(event.payload.message);
  return typeof message?.method === "string" ? message.method : "";
}

export function shouldRefreshXcodexDirectoryForEvent(event: XcodexBridgeAppServerEvent): boolean {
  const method = xcodexMethodFromEvent(event);
  return method === "thread/status/changed" || isXcodexTurnLifecycleAppServerEvent(event);
}

function xcodexEventTimestamp(event: XcodexBridgeAppServerEvent): string {
  const emittedAtMs =
    typeof event.payload.emittedAtMs === "number" ? event.payload.emittedAtMs : Date.now();
  return new Date(emittedAtMs).toISOString();
}

export function buildXcodexBridgeEventRoute(options: {
  event: XcodexBridgeAppServerEvent;
  hasAgentInterest: (agentId: string) => boolean;
  mapStreamEvent: (event: XcodexBridgeAppServerEvent) => AgentStreamPayload["event"] | null;
}): XcodexBridgeEventRoute | null {
  const { event } = options;
  const threadId = xcodexThreadIdFromEvent(event);
  if (!threadId) return null;

  const workspaceId = event.payload.workspaceId;
  const agentId = `xcodex:${workspaceId}:${threadId}`;
  let agentStreamPayload: AgentStreamPayload | null = null;

  if (options.hasAgentInterest(agentId)) {
    const streamEvent = options.mapStreamEvent(event);
    if (streamEvent) {
      agentStreamPayload = {
        agentId,
        event: streamEvent,
        timestamp: xcodexEventTimestamp(event),
      };
    }
  }

  return {
    agentId,
    workspaceId,
    agentStreamPayload,
    refreshDirectory: shouldRefreshXcodexDirectoryForEvent(event),
  };
}

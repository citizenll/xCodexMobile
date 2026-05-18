import { expect, test } from "vitest";

import type { AgentStreamEventPayload } from "../../shared/messages.js";
import type { XcodexBridgeAppServerEvent } from "../xcodex-bridge.js";
import { buildXcodexBridgeEventRoute } from "./event-routing.js";

function appServerEvent(
  method: string,
  params: Record<string, unknown>,
  seq = 1,
): XcodexBridgeAppServerEvent {
  return {
    kind: "event",
    event: "appServer",
    seq,
    payload: {
      workspaceId: "workspace-1",
      profileId: "profile-1",
      sessionKey: "session-1",
      seq,
      emittedAtMs: Date.parse("2026-05-16T00:00:00.000Z") + seq,
      message: {
        method,
        params: {
          threadId: "thread-1",
          ...params,
        },
      },
    },
  };
}

const timelineEvent: AgentStreamEventPayload = {
  type: "timeline",
  provider: "xcodex",
  item: {
    type: "assistant_message",
    messageId: "assistant-1",
    text: "hello",
  },
};

test("routes interested xCodex stream events as live deltas without canonical seq metadata", () => {
  const route = buildXcodexBridgeEventRoute({
    event: appServerEvent(
      "item/agentMessage/delta",
      {
        itemId: "assistant-1",
        delta: "hello",
      },
      500,
    ),
    hasAgentInterest: (agentId) => agentId === "xcodex:workspace-1:thread-1",
    mapStreamEvent: () => timelineEvent,
  });

  expect(route?.agentStreamPayload).toEqual({
    agentId: "xcodex:workspace-1:thread-1",
    event: timelineEvent,
    timestamp: "2026-05-16T00:00:00.500Z",
  });
  expect(route?.agentStreamPayload).not.toHaveProperty("seq");
  expect(route?.agentStreamPayload).not.toHaveProperty("epoch");
  expect(route?.refreshDirectory).toBe(false);
});

test("does not map or forward realtime stream events for agents outside the session interest set", () => {
  let mapperCalled = false;
  const route = buildXcodexBridgeEventRoute({
    event: appServerEvent("item/agentMessage/delta", {
      itemId: "assistant-1",
      delta: "unrelated",
    }),
    hasAgentInterest: () => false,
    mapStreamEvent: () => {
      mapperCalled = true;
      return timelineEvent;
    },
  });

  expect(mapperCalled).toBe(false);
  expect(route?.agentStreamPayload).toBeNull();
  expect(route?.refreshDirectory).toBe(false);
});

test("keeps directory refreshes for status and turn lifecycle events", () => {
  const statusRoute = buildXcodexBridgeEventRoute({
    event: appServerEvent("thread/status/changed", {}),
    hasAgentInterest: () => false,
    mapStreamEvent: () => null,
  });
  const turnRoute = buildXcodexBridgeEventRoute({
    event: appServerEvent("turn/completed", {
      turn: {
        id: "turn-1",
        status: "completed",
      },
    }),
    hasAgentInterest: () => false,
    mapStreamEvent: () => null,
  });

  expect(statusRoute?.refreshDirectory).toBe(true);
  expect(turnRoute?.refreshDirectory).toBe(true);
  expect(statusRoute?.agentStreamPayload).toBeNull();
  expect(turnRoute?.agentStreamPayload).toBeNull();
});

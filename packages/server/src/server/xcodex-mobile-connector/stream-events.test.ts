import { expect, test } from "vitest";

import { AgentStreamEventPayloadSchema } from "../../shared/messages.js";
import type { XcodexBridgeAppServerEvent } from "../xcodex-bridge.js";
import {
  createXcodexStreamEventMapper,
  isXcodexTurnLifecycleAppServerEvent,
} from "./stream-events.js";

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

function expectValidStreamEvent(value: unknown) {
  const parsed = AgentStreamEventPayloadSchema.safeParse(value);
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data : null;
}

test("maps xCodex assistant deltas without duplicating the completed agent message", () => {
  const mapper = createXcodexStreamEventMapper({ realtimeStreamingEnabled: true });

  expectValidStreamEvent(mapper.fromAppServer(appServerEvent("turn/started", {})));

  const delta = expectValidStreamEvent(
    mapper.fromAppServer(
      appServerEvent("item/agentMessage/delta", {
        itemId: "assistant-1",
        delta: "hello",
      }),
    ),
  );

  expect(delta).toMatchObject({
    type: "timeline",
    provider: "xcodex",
    item: {
      type: "assistant_message",
      messageId: "assistant-1",
      text: "hello",
    },
  });

  expect(
    mapper.fromAppServer(
      appServerEvent("item/completed", {
        item: {
          id: "assistant-1",
          type: "agentMessage",
          text: "hello",
        },
      }),
    ),
  ).toBeNull();
});

test("maps non-streamed completed agent messages", () => {
  const mapper = createXcodexStreamEventMapper({ realtimeStreamingEnabled: true });

  const event = expectValidStreamEvent(
    mapper.fromAppServer(
      appServerEvent("item/completed", {
        item: {
          id: "assistant-2",
          type: "agentMessage",
          text: "done",
        },
      }),
    ),
  );

  expect(event).toMatchObject({
    type: "timeline",
    provider: "xcodex",
    item: {
      type: "assistant_message",
      messageId: "assistant-2",
      text: "done",
    },
  });
});

test("maps reasoning deltas and skips the final duplicate reasoning item", () => {
  const mapper = createXcodexStreamEventMapper({ realtimeStreamingEnabled: true });

  const delta = expectValidStreamEvent(
    mapper.fromAppServer(
      appServerEvent("item/reasoning/summaryTextDelta", {
        itemId: "reasoning-1",
        delta: "thinking",
      }),
    ),
  );

  expect(delta).toMatchObject({
    type: "timeline",
    provider: "xcodex",
    item: {
      type: "reasoning",
      text: "thinking",
    },
  });

  expect(
    mapper.fromAppServer(
      appServerEvent("item/completed", {
        item: {
          id: "reasoning-1",
          type: "reasoning",
          summary: [{ text: "thinking" }],
        },
      }),
    ),
  ).toBeNull();
});

test("accumulates command output deltas into canonical tool_call stream events", () => {
  const mapper = createXcodexStreamEventMapper({ realtimeStreamingEnabled: true });

  const started = expectValidStreamEvent(
    mapper.fromAppServer(
      appServerEvent("item/started", {
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: ["npm", "test"],
          cwd: "D:\\Dev\\self\\paseo",
          status: "inProgress",
        },
      }),
    ),
  );
  expect(started).toMatchObject({
    type: "timeline",
    item: {
      type: "tool_call",
      callId: "cmd-1",
      status: "running",
      detail: {
        type: "shell",
        command: "npm test",
      },
    },
  });

  mapper.fromAppServer(
    appServerEvent("item/commandExecution/outputDelta", {
      itemId: "cmd-1",
      delta: "one",
    }),
  );
  const output = expectValidStreamEvent(
    mapper.fromAppServer(
      appServerEvent("item/commandExecution/outputDelta", {
        itemId: "cmd-1",
        delta: "two",
      }),
    ),
  );

  expect(output).toMatchObject({
    type: "timeline",
    item: {
      type: "tool_call",
      callId: "cmd-1",
      status: "running",
      detail: {
        type: "shell",
        output: "onetwo",
      },
    },
  });

  const completed = expectValidStreamEvent(
    mapper.fromAppServer(
      appServerEvent("item/completed", {
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: ["npm", "test"],
          status: "completed",
        },
      }),
    ),
  );

  expect(completed).toMatchObject({
    type: "timeline",
    item: {
      type: "tool_call",
      callId: "cmd-1",
      status: "completed",
      detail: {
        type: "shell",
        command: "npm test",
        output: "onetwo",
      },
    },
  });
});

test("maps interrupted turn completion as canceled", () => {
  const mapper = createXcodexStreamEventMapper({ realtimeStreamingEnabled: true });

  const event = expectValidStreamEvent(
    mapper.fromAppServer(
      appServerEvent("turn/completed", {
        turn: {
          id: "turn-1",
          status: "interrupted",
        },
      }),
    ),
  );

  expect(event).toMatchObject({
    type: "turn_canceled",
    provider: "xcodex",
    reason: "canceled",
  });
});

test("default mapper only forwards turn lifecycle events", () => {
  const mapper = createXcodexStreamEventMapper();

  expectValidStreamEvent(mapper.fromAppServer(appServerEvent("turn/started", {})));
  expect(
    mapper.fromAppServer(
      appServerEvent("item/agentMessage/delta", {
        itemId: "assistant-1",
        delta: "hidden until turn end",
      }),
    ),
  ).toBeNull();
  expect(
    mapper.fromAppServer(
      appServerEvent("item/started", {
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "pwd",
        },
      }),
    ),
  ).toBeNull();
  expectValidStreamEvent(
    mapper.fromAppServer(
      appServerEvent("turn/completed", {
        turn: {
          id: "turn-1",
          status: "completed",
        },
      }),
    ),
  );
});

test("default mapper forwards xCodex user ingress without enabling realtime streaming", () => {
  const mapper = createXcodexStreamEventMapper();

  const desktopIngress = expectValidStreamEvent(
    mapper.fromAppServer(
      appServerEvent("x-codex/desktop/ingress", {
        text: "sent from desktop",
        sourceMessageId: "desktop-msg-1",
      }),
    ),
  );

  expect(desktopIngress).toMatchObject({
    type: "timeline",
    provider: "xcodex",
    item: {
      type: "user_message",
      text: "sent from desktop",
      messageId: "desktop-msg-1",
    },
  });

  const mobileIngress = expectValidStreamEvent(
    mapper.fromAppServer(
      appServerEvent("x-codex/mobile/ingress", {
        text: "sent from mobile",
        sourceMessageId: "mobile-msg-1",
      }),
    ),
  );

  expect(mobileIngress).toMatchObject({
    type: "timeline",
    provider: "xcodex",
    item: {
      type: "user_message",
      text: "sent from mobile",
      messageId: "mobile-msg-1",
    },
  });
});

test("mobile ingress without a stable source message id is not converted to a second user row", () => {
  const mapper = createXcodexStreamEventMapper();

  expect(
    mapper.fromAppServer(
      appServerEvent("x-codex/mobile/ingress", {
        text: "sent from mobile",
        ingressId: "random-bridge-id",
      }),
    ),
  ).toBeNull();

  const desktopIngress = expectValidStreamEvent(
    mapper.fromAppServer(
      appServerEvent("x-codex/desktop/ingress", {
        text: "sent from desktop",
        ingressId: "desktop-random-bridge-id",
      }),
    ),
  );

  expect(desktopIngress).toMatchObject({
    item: {
      type: "user_message",
      messageId: "desktop-random-bridge-id",
    },
  });
});

test("identifies turn lifecycle events for non-realtime subscription updates", () => {
  expect(isXcodexTurnLifecycleAppServerEvent(appServerEvent("turn/started", {}))).toBe(true);
  expect(
    isXcodexTurnLifecycleAppServerEvent(
      appServerEvent("turn/completed", {
        turn: {
          id: "turn-1",
          status: "completed",
        },
      }),
    ),
  ).toBe(true);
  expect(
    isXcodexTurnLifecycleAppServerEvent(
      appServerEvent("item/agentMessage/delta", {
        itemId: "assistant-1",
        delta: "not lifecycle",
      }),
    ),
  ).toBe(false);
});

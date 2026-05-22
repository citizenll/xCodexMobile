import type { AgentStreamEventPayload } from "../../shared/messages.js";
import type { XcodexBridgeAppServerEvent } from "../xcodex-bridge.js";

const XCODEX_PROVIDER = "xcodex";

type TimelineEvent = Extract<AgentStreamEventPayload, { type: "timeline" }>;
type TimelineItem = TimelineEvent["item"];
type ToolCallItem = Extract<TimelineItem, { type: "tool_call" }>;
type ToolCallDetail = ToolCallItem["detail"];
type ToolCallStatus = ToolCallItem["status"];

interface AppServerMessage {
  method?: unknown;
  params?: unknown;
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

function textField(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return null;
}

function numberField(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function messageParams(event: XcodexBridgeAppServerEvent): {
  message: AppServerMessage | null;
  params: Record<string, unknown> | null;
  method: string;
} {
  const message = recordFromUnknown(event.payload.message) as AppServerMessage | null;
  const method = typeof message?.method === "string" ? message.method : "";
  return {
    message,
    params: recordFromUnknown(message?.params),
    method,
  };
}

function threadIdFromParams(params: Record<string, unknown> | null): string | null {
  return (
    stringField(params, ["threadId", "thread_id"]) ??
    stringField(recordFromUnknown(params?.turn), ["threadId", "thread_id"]) ??
    stringField(recordFromUnknown(params?.item), ["threadId", "thread_id"]) ??
    stringField(recordFromUnknown(params?.thread), ["id", "threadId", "thread_id"])
  );
}

function itemIdFromParams(params: Record<string, unknown> | null): string | null {
  return (
    stringField(params, ["itemId", "item_id", "messageId", "message_id"]) ??
    stringField(recordFromUnknown(params?.item), [
      "id",
      "itemId",
      "item_id",
      "messageId",
      "message_id",
    ])
  );
}

function timeline(item: TimelineItem): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: XCODEX_PROVIDER,
    item,
  };
}

function normalizeTurnError(
  params: Record<string, unknown> | null,
  turn: Record<string, unknown> | null,
): string {
  const error = recordFromUnknown(turn?.error);
  return (
    stringField(error, ["message"]) ??
    stringField(params, ["error", "message"]) ??
    "xCodex turn failed"
  );
}

function isCanceledStatus(status: string | null): boolean {
  return (
    status === "canceled" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "aborted"
  );
}

function turnLifecycleEvent(
  method: string,
  params: Record<string, unknown> | null,
): AgentStreamEventPayload | null {
  const turn = recordFromUnknown(params?.turn);
  const status = stringField(turn, ["status"]) ?? stringField(params, ["status"]);
  const errorMessage = normalizeTurnError(params, turn);

  if (method === "turn/started") {
    return { type: "turn_started", provider: XCODEX_PROVIDER };
  }
  if (method === "turn/failed") {
    return { type: "turn_failed", provider: XCODEX_PROVIDER, error: errorMessage };
  }
  if (method === "turn/canceled" || method === "turn/cancelled") {
    return { type: "turn_canceled", provider: XCODEX_PROVIDER, reason: "canceled" };
  }
  if (method !== "turn/completed") {
    return null;
  }
  if (status === "failed") {
    return { type: "turn_failed", provider: XCODEX_PROVIDER, error: errorMessage };
  }
  if (isCanceledStatus(status)) {
    return { type: "turn_canceled", provider: XCODEX_PROVIDER, reason: "canceled" };
  }
  return { type: "turn_completed", provider: XCODEX_PROVIDER };
}

function userIngressEvent(
  method: string,
  params: Record<string, unknown> | null,
): AgentStreamEventPayload | null {
  if (method !== "x-codex/mobile/ingress" && method !== "x-codex/desktop/ingress") {
    return null;
  }
  const text = textField(params, ["text", "content", "message"]);
  if (text === null) {
    return null;
  }
  const messageId =
    method === "x-codex/mobile/ingress"
      ? stringField(params, ["sourceMessageId", "source_message_id", "messageId", "message_id"])
      : stringField(params, [
          "sourceMessageId",
          "source_message_id",
          "messageId",
          "message_id",
          "ingressId",
          "ingress_id",
        ]);
  if (method === "x-codex/mobile/ingress" && !messageId) {
    return null;
  }
  return timeline({
    type: "user_message",
    text,
    ...(messageId ? { messageId } : {}),
  });
}

export function isXcodexTurnLifecycleAppServerEvent(event: XcodexBridgeAppServerEvent): boolean {
  const { method, params } = messageParams(event);
  return turnLifecycleEvent(method, params) !== null;
}

function valueAsText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function outputFromItem(item: Record<string, unknown>, accumulatedOutput?: string): string | null {
  if (accumulatedOutput && accumulatedOutput.length > 0) {
    return accumulatedOutput;
  }
  for (const key of ["aggregatedOutput", "output", "result", "error", "review"]) {
    const text = valueAsText(item[key]);
    if (text && text.length > 0) {
      return text;
    }
  }
  return null;
}

function commandFromItem(item: Record<string, unknown>): string | null {
  const command = item.command;
  if (Array.isArray(command)) {
    const parts = command.map((part) => valueAsText(part)?.trim()).filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : null;
  }
  return textField(item, ["command"]);
}

function unknownToolDetail(item: Record<string, unknown>, output: string | null): ToolCallDetail {
  return {
    type: "unknown",
    input: item,
    output,
  };
}

function fileChangesFromItem(item: Record<string, unknown>): Array<{
  path: string | null;
  diff: string | null;
}> {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes
    .map((change) => {
      const record = recordFromUnknown(change);
      if (!record) {
        return null;
      }
      return {
        path: stringField(record, ["path", "filePath", "file_path"]),
        diff: textField(record, ["diff", "unifiedDiff", "patch", "content"]),
      };
    })
    .filter((change): change is { path: string | null; diff: string | null } => change !== null);
}

function buildFileChangeDetail(
  item: Record<string, unknown>,
  output: string | null,
): ToolCallDetail {
  const changes = fileChangesFromItem(item);
  const filePath =
    changes.find((change) => change.path)?.path ??
    stringField(item, ["path", "filePath", "file_path"]);
  if (!filePath) {
    return unknownToolDetail(item, output);
  }
  const unifiedDiff =
    output ??
    changes
      .map((change) => change.diff)
      .filter(Boolean)
      .join("\n\n");
  return {
    type: "edit",
    filePath,
    ...(unifiedDiff ? { unifiedDiff } : {}),
  };
}

function buildCommandExecutionDetail(
  item: Record<string, unknown>,
  output: string | null,
): ToolCallDetail {
  const cwd = stringField(item, ["cwd"]);
  const exitCode = numberField(item, ["exitCode", "exit_code"]);
  return {
    type: "shell",
    command: commandFromItem(item) ?? "command",
    ...(cwd ? { cwd } : {}),
    ...(output ? { output } : {}),
    ...(exitCode !== null ? { exitCode } : {}),
  };
}

function buildWebSearchDetail(
  item: Record<string, unknown>,
  output: string | null,
): ToolCallDetail {
  return {
    type: "search",
    query: textField(item, ["query", "prompt"]) ?? "web search",
    toolName: "web_search",
    ...(output ? { content: output } : {}),
  };
}

function buildImageViewDetail(
  item: Record<string, unknown>,
  output: string | null,
): ToolCallDetail | null {
  const filePath = stringField(item, ["path", "filePath", "file_path"]);
  if (!filePath) {
    return null;
  }
  return {
    type: "read",
    filePath,
    ...(output ? { content: output } : {}),
  };
}

function receiverThreadIdsFromItem(item: Record<string, unknown>): string[] {
  return Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds
        .map((value) => valueAsText(value)?.trim())
        .filter((value): value is string => Boolean(value))
    : [];
}

function buildSubAgentDetail(item: Record<string, unknown>, output: string | null): ToolCallDetail {
  const receiverThreadIds = receiverThreadIdsFromItem(item);
  const subAgentType =
    stringField(item, ["agentType", "agent_type"]) ?? stringField(item, ["tool"]);
  const description = textField(item, ["prompt", "description", "message"]);
  return {
    type: "sub_agent",
    ...(subAgentType ? { subAgentType } : {}),
    ...(description !== null ? { description } : {}),
    ...(receiverThreadIds[0] ? { childSessionId: receiverThreadIds[0] } : {}),
    log: output ?? "",
    actions: [],
  };
}

function buildImageGenerationDetail(output: string | null): ToolCallDetail {
  return {
    type: "plain_text",
    label: "Image generation",
    ...(output ? { text: output } : {}),
    icon: "sparkles",
  };
}

function buildToolDetail(
  type: string,
  item: Record<string, unknown>,
  accumulatedOutput?: string,
): ToolCallDetail {
  const output = outputFromItem(item, accumulatedOutput);

  switch (type) {
    case "commandExecution":
      return buildCommandExecutionDetail(item, output);
    case "fileChange":
      return buildFileChangeDetail(item, output);
    case "webSearch":
      return buildWebSearchDetail(item, output);
    case "imageView":
      return buildImageViewDetail(item, output) ?? unknownToolDetail(item, output);
    case "collabToolCall":
    case "collabAgentToolCall":
      return buildSubAgentDetail(item, output);
    case "imageGeneration":
      return buildImageGenerationDetail(output);
    default:
      return unknownToolDetail(item, output);
  }
}

function normalizeToolStatus(method: string, item: Record<string, unknown>): ToolCallStatus {
  const raw = stringField(item, ["status"]);
  if (raw === "failed" || raw === "error") {
    return "failed";
  }
  if (isCanceledStatus(raw)) {
    return "canceled";
  }
  if (raw === "completed" || raw === "done" || method === "item/completed") {
    return "completed";
  }
  return "running";
}

function toolError(item: Record<string, unknown>): NonNullable<ToolCallItem["error"]> {
  const error = item.error;
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (error !== null && error !== undefined) {
    return error;
  }
  return "Tool call failed";
}

function toolName(type: string, item: Record<string, unknown>): string {
  if (type === "commandExecution") {
    return commandFromItem(item) ?? "shell";
  }
  if (type === "fileChange") {
    return "file_change";
  }
  if (type === "mcpToolCall") {
    const server = stringField(item, ["server"]);
    const tool = stringField(item, ["tool", "name"]);
    return [server, tool].filter(Boolean).join("/") || "mcp_tool";
  }
  if (type === "webSearch") {
    return "web_search";
  }
  if (type === "imageView") {
    return "image_view";
  }
  if (type === "imageGeneration") {
    return "image_generation";
  }
  return stringField(item, ["tool", "name"]) ?? (type || "tool");
}

function toolCallTimelineItem(params: {
  callId: string;
  name: string;
  status: ToolCallStatus;
  detail: ToolCallDetail;
  error?: unknown;
  metadata?: Record<string, unknown>;
}): ToolCallItem {
  const base = {
    type: "tool_call" as const,
    callId: params.callId,
    name: params.name,
    detail: params.detail,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  if (params.status === "failed") {
    return {
      ...base,
      status: "failed",
      error: params.error ?? "Tool call failed",
    };
  }
  return {
    ...base,
    status: params.status,
    error: null,
  };
}

function normalizeReasoningSection(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeReasoningSection).filter(Boolean).join("\n\n").trim();
  }
  const record = recordFromUnknown(value);
  if (!record) {
    return "";
  }
  const direct = textField(record, ["text", "body", "reasoning_content", "reasoningContent"]) ?? "";
  if (direct.trim().length > 0) {
    return direct.trim();
  }
  if (Array.isArray(record.content)) {
    return record.content.map(normalizeReasoningSection).filter(Boolean).join("\n").trim();
  }
  if (Array.isArray(record.summary)) {
    return record.summary.map(normalizeReasoningSection).filter(Boolean).join("\n\n").trim();
  }
  return "";
}

function reasoningTextFromItem(item: Record<string, unknown>): string | null {
  const sections = [item.summary, item.content, item.text]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map(normalizeReasoningSection)
    .filter(Boolean);
  const text = sections.join("\n\n").trim();
  return text || null;
}

function agentTextFromItem(item: Record<string, unknown>): string | null {
  return textField(item, ["text", "message", "content"]);
}

function shouldTreatItemAsTool(type: string): boolean {
  return !["", "userMessage", "agentMessage", "reasoning"].includes(type);
}

export class XcodexStreamEventMapper {
  private readonly assistantDeltaItemIds = new Set<string>();
  private readonly assistantDeltaThreadIds = new Set<string>();
  private readonly reasoningDeltaItemIds = new Set<string>();
  private readonly reasoningDeltaThreadIds = new Set<string>();
  private readonly toolOutputByCallId = new Map<string, string>();

  constructor(private readonly realtimeStreamingEnabled = false) {}

  fromAppServer(event: XcodexBridgeAppServerEvent): AgentStreamEventPayload | null {
    const { method, params } = messageParams(event);
    const threadId = threadIdFromParams(params);

    const lifecycleEvent = turnLifecycleEvent(method, params);
    if (lifecycleEvent) {
      this.clearThreadDeltaState(threadId);
      return lifecycleEvent;
    }

    const ingressEvent = userIngressEvent(method, params);
    if (ingressEvent) {
      return ingressEvent;
    }

    if (!this.realtimeStreamingEnabled) {
      return null;
    }

    return this.realtimeEvent(method, params, threadId);
  }

  private clearThreadDeltaState(threadId: string | null) {
    if (!this.realtimeStreamingEnabled || !threadId) {
      return;
    }
    this.assistantDeltaThreadIds.delete(threadId);
    this.reasoningDeltaThreadIds.delete(threadId);
  }

  private realtimeEvent(
    method: string,
    params: Record<string, unknown> | null,
    threadId: string | null,
  ): AgentStreamEventPayload | null {
    if (method === "item/agentMessage/delta") {
      return this.assistantDeltaEvent(params, threadId);
    }

    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      return this.reasoningDeltaEvent(params, threadId);
    }

    if (
      method === "item/commandExecution/outputDelta" ||
      method === "item/fileChange/outputDelta"
    ) {
      return this.toolOutputDeltaEvent(method, params);
    }

    if (method === "item/started" || method === "item/completed") {
      return this.itemLifecycleEvent(method, params, threadId);
    }

    return null;
  }

  private assistantDeltaEvent(
    params: Record<string, unknown> | null,
    threadId: string | null,
  ): AgentStreamEventPayload | null {
    const delta = textField(params, ["delta"]);
    if (delta === null) {
      return null;
    }
    const itemId = itemIdFromParams(params);
    if (itemId) {
      this.assistantDeltaItemIds.add(itemId);
    }
    if (threadId) {
      this.assistantDeltaThreadIds.add(threadId);
    }
    return timeline({
      type: "assistant_message",
      text: delta,
      ...(itemId ? { messageId: itemId } : {}),
    });
  }

  private reasoningDeltaEvent(
    params: Record<string, unknown> | null,
    threadId: string | null,
  ): AgentStreamEventPayload | null {
    const delta = textField(params, ["delta"]);
    if (delta === null) {
      return null;
    }
    const itemId = itemIdFromParams(params);
    if (itemId) {
      this.reasoningDeltaItemIds.add(itemId);
    }
    if (threadId) {
      this.reasoningDeltaThreadIds.add(threadId);
    }
    return timeline({ type: "reasoning", text: delta });
  }

  private toolOutputDeltaEvent(
    method: string,
    params: Record<string, unknown> | null,
  ): AgentStreamEventPayload | null {
    const callId = itemIdFromParams(params);
    const delta = textField(params, ["delta"]);
    if (!callId || delta === null) {
      return null;
    }
    const output = `${this.toolOutputByCallId.get(callId) ?? ""}${delta}`;
    this.toolOutputByCallId.set(callId, output);

    const isCommand = method === "item/commandExecution/outputDelta";
    const detail: ToolCallDetail = isCommand
      ? {
          type: "shell",
          command: stringField(params, ["command"]) ?? "command",
          output,
        }
      : {
          type: "plain_text",
          label: "File change output",
          text: output,
        };

    return timeline({
      type: "tool_call",
      callId,
      name: isCommand ? "shell" : "file_change",
      status: "running",
      error: null,
      detail,
    });
  }

  private itemLifecycleEvent(
    method: "item/started" | "item/completed",
    params: Record<string, unknown> | null,
    threadId: string | null,
  ): AgentStreamEventPayload | null {
    const item = recordFromUnknown(params?.item);
    if (!item) {
      return null;
    }
    const type = stringField(item, ["type"]) ?? "";
    const itemId = itemIdFromParams(params) ?? stringField(item, ["id"]);

    if (type === "agentMessage") {
      return this.completedAgentMessageEvent(method, item, itemId, threadId);
    }

    if (type === "reasoning") {
      return this.completedReasoningEvent(method, item, itemId, threadId);
    }

    if (type === "contextCompaction") {
      return contextCompactionEvent(method);
    }

    if (!shouldTreatItemAsTool(type)) {
      return null;
    }

    return this.toolLifecycleEvent(method, item, type, itemId, threadId);
  }

  private completedAgentMessageEvent(
    method: "item/started" | "item/completed",
    item: Record<string, unknown>,
    itemId: string | null,
    threadId: string | null,
  ): AgentStreamEventPayload | null {
    if (method !== "item/completed" || this.hasSeenAssistantDelta(itemId, threadId)) {
      return null;
    }
    const text = agentTextFromItem(item);
    if (!text) {
      return null;
    }
    return timeline({
      type: "assistant_message",
      text,
      ...(itemId ? { messageId: itemId } : {}),
    });
  }

  private completedReasoningEvent(
    method: "item/started" | "item/completed",
    item: Record<string, unknown>,
    itemId: string | null,
    threadId: string | null,
  ): AgentStreamEventPayload | null {
    if (method !== "item/completed" || this.hasSeenReasoningDelta(itemId, threadId)) {
      return null;
    }
    const text = reasoningTextFromItem(item);
    return text ? timeline({ type: "reasoning", text }) : null;
  }

  private hasSeenAssistantDelta(itemId: string | null, threadId: string | null): boolean {
    return (
      (itemId !== null && this.assistantDeltaItemIds.delete(itemId)) ||
      (itemId === null && threadId !== null && this.assistantDeltaThreadIds.has(threadId))
    );
  }

  private hasSeenReasoningDelta(itemId: string | null, threadId: string | null): boolean {
    return (
      (itemId !== null && this.reasoningDeltaItemIds.delete(itemId)) ||
      (itemId === null && threadId !== null && this.reasoningDeltaThreadIds.has(threadId))
    );
  }

  private toolLifecycleEvent(
    method: "item/started" | "item/completed",
    item: Record<string, unknown>,
    type: string,
    itemId: string | null,
    threadId: string | null,
  ): AgentStreamEventPayload {
    const callId = itemId ?? `xcodex-tool-${Date.now()}`;
    if (method === "item/started" && !this.toolOutputByCallId.has(callId)) {
      this.toolOutputByCallId.set(callId, "");
    }
    const accumulatedOutput = this.toolOutputByCallId.get(callId);
    const status = normalizeToolStatus(method, item);
    const detail = buildToolDetail(type, item, accumulatedOutput);
    const streamEvent = timeline(
      toolCallTimelineItem({
        callId,
        name: toolName(type, item),
        status,
        detail,
        error: toolError(item),
        metadata: {
          xcodexItemType: type,
          ...(threadId ? { xcodexThreadId: threadId } : {}),
        },
      }),
    );
    if (method === "item/completed") {
      this.toolOutputByCallId.delete(callId);
    }
    return streamEvent;
  }
}

function contextCompactionEvent(
  method: "item/started" | "item/completed",
): AgentStreamEventPayload {
  return timeline({
    type: "compaction",
    status: method === "item/completed" ? "completed" : "loading",
  });
}

export function createXcodexStreamEventMapper(options?: {
  realtimeStreamingEnabled?: boolean;
}): XcodexStreamEventMapper {
  return new XcodexStreamEventMapper(options?.realtimeStreamingEnabled ?? false);
}

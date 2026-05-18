import { describe, expect, test, vi } from "vitest";

import { resolveEventWorkspaceUpsertPayload } from "./workspace-updates.js";

describe("resolveEventWorkspaceUpsertPayload", () => {
  test("finds the workspace across unfiltered pages", async () => {
    const listWorkspacePayloads = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [{ id: "workspace-a" }],
        pageInfo: { hasMore: true, nextCursor: "next" },
      })
      .mockResolvedValueOnce({
        entries: [{ id: "workspace-b" }],
        pageInfo: { hasMore: false, nextCursor: null },
      });

    await expect(
      resolveEventWorkspaceUpsertPayload({
        workspaceId: "workspace-b",
        listWorkspacePayloads,
        pageLimit: 1,
      }),
    ).resolves.toEqual({
      kind: "upsert",
      workspace: { id: "workspace-b" },
    });
    expect(listWorkspacePayloads).toHaveBeenCalledTimes(2);
    expect(listWorkspacePayloads.mock.calls[1]?.[0]).toMatchObject({
      page: { limit: 1, cursor: "next" },
    });
  });

  test("does not infer deletion when the workspace is absent", async () => {
    const listWorkspacePayloads = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-a" }],
      pageInfo: { hasMore: false, nextCursor: null },
    });

    await expect(
      resolveEventWorkspaceUpsertPayload({
        workspaceId: "workspace-missing",
        listWorkspacePayloads,
      }),
    ).resolves.toBeNull();
  });
});

interface WorkspaceDescriptorLike {
  id: string;
}

interface WorkspacePageLike<TWorkspace extends WorkspaceDescriptorLike> {
  entries: TWorkspace[];
  pageInfo: {
    hasMore?: boolean;
    nextCursor?: string | null;
  };
}

interface WorkspaceListRequestLike {
  type: "fetch_workspaces_request";
  requestId: string;
  sort: Array<Record<string, unknown>>;
  page: {
    limit: number;
    cursor?: string;
  };
}

export interface EventWorkspaceUpsertPayload<TWorkspace extends WorkspaceDescriptorLike> {
  kind: "upsert";
  workspace: TWorkspace;
}

export async function resolveEventWorkspaceUpsertPayload<
  TWorkspace extends WorkspaceDescriptorLike,
>(input: {
  workspaceId: string;
  listWorkspacePayloads: (
    request: WorkspaceListRequestLike,
  ) => Promise<WorkspacePageLike<TWorkspace>>;
  pageLimit?: number;
}): Promise<EventWorkspaceUpsertPayload<TWorkspace> | null> {
  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) {
    return null;
  }

  let cursor: string | null = null;
  const pageLimit = input.pageLimit ?? 200;
  while (true) {
    const payload = await input.listWorkspacePayloads({
      type: "fetch_workspaces_request",
      requestId: `workspace-update:${workspaceId}`,
      sort: [{ key: "activity_at", direction: "desc" }],
      page: cursor ? { limit: pageLimit, cursor } : { limit: pageLimit },
    });
    const workspace = payload.entries.find((entry) => entry.id === workspaceId);
    if (workspace) {
      return { kind: "upsert", workspace };
    }
    if (!payload.pageInfo.hasMore || !payload.pageInfo.nextCursor) {
      return null;
    }
    cursor = payload.pageInfo.nextCursor;
  }
}

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import { ensureAgentLoaded } from "./agent/agent-loading.js";
import type { PaseoDaemonConfig } from "./bootstrap.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

const originalEnv = {
  PATH: process.env.PATH,
  PATHEXT: process.env.PATHEXT,
};

describe("bootstrap provider availability", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    process.env.PATH = originalEnv.PATH;
    process.env.PATHEXT = originalEnv.PATHEXT;
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("loads a persisted Codex record without spawning a missing Codex binary", async () => {
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-bootstrap-provider-"));
    tempRoots.push(root);
    const binDir = await mkdtemp(path.join(os.tmpdir(), "paseo-bootstrap-provider-bin-"));
    tempRoots.push(binDir);
    process.env.PATH = binDir;
    if (process.platform === "win32") {
      process.env.PATHEXT = ".CMD";
    }
    const paseoHome = path.join(root, ".paseo");
    const staticDir = path.join(root, "static");
    const agentStoragePath = path.join(paseoHome, "agents");
    const now = new Date("2026-04-16T00:00:00.000Z").toISOString();
    const agentId = "11111111-1111-4111-8111-111111111111";
    await mkdir(agentStoragePath, { recursive: true });
    await mkdir(staticDir, { recursive: true });
    await writeFile(
      path.join(agentStoragePath, `${agentId}.json`),
      JSON.stringify({
        id: agentId,
        provider: "codex",
        cwd: root,
        createdAt: now,
        updatedAt: now,
        lastStatus: "idle",
        lastModeId: "auto",
        config: {
          modeId: "auto",
          model: "gpt-5.4",
        },
        persistence: {
          provider: "codex",
          sessionId: "codex-session-1",
          metadata: {
            provider: "codex",
            cwd: root,
          },
        },
      }),
    );

    const config: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      connectorMode: "paseo",
      agentRuntimeEnabled: true,
      agentClients: {},
      agentStoragePath,
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: undefined,
    };
    const processFailures: Error[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      processFailures.push(reason instanceof Error ? reason : new Error(String(reason)));
    };
    const onUncaughtException = (error: Error) => {
      processFailures.push(error);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    process.on("uncaughtException", onUncaughtException);

    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
    try {
      await expect(daemon.agentStorage.list()).resolves.toHaveLength(1);
      await expect(daemon.agentManager.listProviderAvailability()).resolves.toContainEqual({
        provider: "codex",
        available: false,
        error: null,
      });
      await expect(
        ensureAgentLoaded(agentId, {
          agentManager: daemon.agentManager,
          agentStorage: daemon.agentStorage,
          logger: pino({ level: "silent" }),
        }),
      ).rejects.toThrow("Provider 'codex' is not available");
      await new Promise((resolve) => setImmediate(resolve));
      expect(processFailures).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      process.off("uncaughtException", onUncaughtException);
      await daemon.stop().catch(() => undefined);
      await daemon.agentManager.flush().catch(() => undefined);
    }
  });

  test("connector-only mode ignores injected agent clients", async () => {
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const { createTestAgentClients } = await import("./test-utils/fake-agent-client.js");
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-bootstrap-connector-"));
    tempRoots.push(root);
    const paseoHome = path.join(root, ".paseo");
    const staticDir = path.join(root, "static");
    const agentStoragePath = path.join(paseoHome, "agents");
    await mkdir(agentStoragePath, { recursive: true });
    await mkdir(staticDir, { recursive: true });

    const config: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      connectorMode: "xcodex",
      agentRuntimeEnabled: false,
      agentClients: createTestAgentClients(),
      agentStoragePath,
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: undefined,
    };

    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
    try {
      await expect(daemon.agentManager.listProviderAvailability()).resolves.toEqual([]);
      expect(daemon.agentManager.getRegisteredProviderIds()).toEqual([]);
    } finally {
      await daemon.stop().catch(() => undefined);
      await daemon.agentManager.flush().catch(() => undefined);
    }
  });

  test("connector-only mode does not expose legacy Paseo agent storage by default", async () => {
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-bootstrap-connector-storage-"));
    tempRoots.push(root);
    const paseoHome = path.join(root, ".paseo");
    const staticDir = path.join(root, "static");
    const agentStoragePath = path.join(paseoHome, "agents");
    const now = new Date("2026-04-16T00:00:00.000Z").toISOString();
    const agentId = "22222222-2222-4222-8222-222222222222";
    await mkdir(agentStoragePath, { recursive: true });
    await mkdir(staticDir, { recursive: true });
    await writeFile(
      path.join(agentStoragePath, `${agentId}.json`),
      JSON.stringify({
        id: agentId,
        provider: "codex",
        cwd: root,
        createdAt: now,
        updatedAt: now,
        lastStatus: "idle",
        config: {
          title: "legacy-paseo-agent",
          model: "gpt-5.4",
        },
        persistence: {
          provider: "codex",
          sessionId: "legacy-codex-session",
        },
      }),
    );

    const config: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      connectorMode: "xcodex",
      agentRuntimeEnabled: true,
      agentClients: {},
      agentStoragePath,
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: undefined,
    };

    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
    try {
      await daemon.start();
      const listenTarget = daemon.getListenTarget();
      if (!listenTarget || listenTarget.type !== "tcp") {
        throw new Error("Test daemon did not expose a bound TCP listen target");
      }
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${listenTarget.port}/ws`,
        appVersion: "0.1.75",
        reconnect: { enabled: false },
      });
      try {
        await client.connect();
        const agents = await client.fetchAgents();
        expect(agents.entries).toEqual([]);
      } finally {
        await client.close();
      }
    } finally {
      await daemon.stop().catch(() => undefined);
    }
  });
});

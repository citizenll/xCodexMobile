import { describe, expect, it } from "vitest";

import { buildLanDiscoveryEndpoints } from "./lan-discovery";

describe("buildLanDiscoveryEndpoints", () => {
  it("scans the current IPv4 /24 first and skips the mobile device address", () => {
    const endpoints = buildLanDiscoveryEndpoints({
      localIp: "192.168.31.42",
      port: 6767,
    });

    expect(endpoints[0]).toBe("192.168.31.1:6767");
    expect(endpoints).not.toContain("192.168.31.42:6767");
    expect(endpoints).toContain("192.168.31.254:6767");
    expect(endpoints).toContain("192.168.1.1:6767");
  });

  it("falls back to common private LAN prefixes when no local IPv4 is available", () => {
    const endpoints = buildLanDiscoveryEndpoints({ localIp: null, port: 7676 });

    expect(endpoints[0]).toBe("192.168.31.1:7676");
    expect(endpoints).toContain("10.0.0.254:7676");
  });
});

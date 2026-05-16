import { describe, expect, it } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";

import { buildOfferEndpoints, selectLanIps, selectPrimaryLanIp } from "./connection-offer.js";

function ipv4(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/24`,
  };
}

describe("server connection offers", () => {
  it("prefers routable private LAN addresses over link-local adapters", () => {
    const nets = {
      "Bluetooth Network Connection": [ipv4("169.254.161.95")],
      singbox_tun: [ipv4("172.18.0.1")],
      "VMware Network Adapter VMnet8": [ipv4("169.254.223.136")],
      "Wi-Fi": [ipv4("192.168.31.203")],
    };

    expect(selectPrimaryLanIp(nets)).toBe("192.168.31.203");
    expect(selectLanIps(nets)).toEqual(["192.168.31.203", "172.18.0.1"]);
  });

  it("builds wildcard offers with LAN endpoints before localhost fallback", () => {
    const previousOverride = process.env.PASEO_PRIMARY_LAN_IP;
    process.env.PASEO_PRIMARY_LAN_IP = "192.168.31.203";
    try {
      expect(buildOfferEndpoints({ listenHost: "0.0.0.0", port: 6767 })).toEqual([
        "192.168.31.203:6767",
        "localhost:6767",
      ]);
    } finally {
      process.env.PASEO_PRIMARY_LAN_IP = previousOverride;
    }
  });
});

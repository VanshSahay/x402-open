import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  aggregateSupportedKinds,
  handleGatewayRegister,
  PeerRegistry,
} from "../src/gateway/core";

describe("aggregateSupportedKinds", () => {
  let healthyServer: http.Server;
  let hangingServer: http.Server;
  let healthyUrl: string;
  let hangingUrl: string;

  beforeAll(async () => {
    healthyServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ kinds: [{ x402Version: 1, scheme: "exact", network: "base-sepolia" }] }));
    });
    // Accepts the request but never responds
    hangingServer = http.createServer(() => {});
    await Promise.all([
      new Promise<void>((r) => healthyServer.listen(0, () => r())),
      new Promise<void>((r) => hangingServer.listen(0, () => r())),
    ]);
    healthyUrl = `http://127.0.0.1:${(healthyServer.address() as AddressInfo).port}`;
    hangingUrl = `http://127.0.0.1:${(hangingServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    healthyServer.closeAllConnections?.();
    hangingServer.closeAllConnections?.();
    await Promise.all([
      new Promise<void>((r) => healthyServer.close(() => r())),
      new Promise<void>((r) => hangingServer.close(() => r())),
    ]);
  });

  it("returns within the timeout when a peer hangs, keeping healthy peers' kinds", async () => {
    const start = Date.now();
    const kinds = await aggregateSupportedKinds([hangingUrl, healthyUrl], 300);
    const elapsed = Date.now() - start;

    expect(kinds).toEqual([{ x402Version: 1, scheme: "exact", network: "base-sepolia" }]);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("PeerRegistry URL normalization", () => {
  it("treats trailing-slash and non-slash registrations as the same peer", () => {
    const registry = new PeerRegistry(false);
    registry.register("http://peer1:3000/");
    registry.register("http://peer1:3000");
    expect(registry.size).toBe(1);
    expect(registry.getActivePeers([])).toEqual(["http://peer1:3000"]);
    registry.destroy();
  });
});

describe("handleGatewayRegister", () => {
  it("registers a peer with valid kinds", () => {
    const registry = new PeerRegistry(false);
    const r = handleGatewayRegister(registry, {
      url: "http://peer1:3000",
      kinds: [{ x402Version: 1, scheme: "exact", network: "base-sepolia" }],
    });
    expect(r.status).toBe(200);
    expect(registry.getActivePeers([])).toEqual(["http://peer1:3000"]);
    registry.destroy();
  });

  it("registers the peer but drops malformed kinds", () => {
    const registry = new PeerRegistry(false);
    const r = handleGatewayRegister(registry, {
      url: "http://peer1:3000",
      kinds: ["not-an-object"],
    });
    expect(r.status).toBe(200);
    expect(registry.getActivePeers([])).toEqual(["http://peer1:3000"]);
    registry.destroy();
  });

  it("rejects invalid urls", () => {
    const registry = new PeerRegistry(false);
    expect(handleGatewayRegister(registry, { url: "ftp://nope" }).status).toBe(400);
    expect(handleGatewayRegister(registry, {}).status).toBe(400);
    expect(handleGatewayRegister(registry, undefined).status).toBe(400);
    expect(registry.size).toBe(0);
    registry.destroy();
  });
});

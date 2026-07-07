import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  StickyRouter,
  PeerRegistry,
  SELECTION_TTL_MS,
  REGISTRY_TTL_MS,
} from "../src/gateway/core";

describe("StickyRouter cleanup", () => {
  let router: StickyRouter;

  beforeEach(() => {
    // Disable auto-cleanup so we can control timing manually
    router = new StickyRouter(false);
  });

  afterEach(() => {
    router.destroy();
  });

  it("removes expired entries on cleanup()", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    // Record a selection
    router.recordSelection(
      "http://peer1:3000",
      {
        paymentPayload: {
          payload: { authorization: { from: "0x1111" } },
        } as any,
      },
      { payer: "0x1111" }
    );

    expect(router.size.payers).toBe(1);

    // Advance time past TTL
    vi.setSystemTime(now + SELECTION_TTL_MS + 1000);

    // Run cleanup
    router.cleanup();

    expect(router.size.payers).toBe(0);
    expect(router.size.headers).toBe(0);

    vi.useRealTimers();
  });

  it("retains non-expired entries", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    router.recordSelection(
      "http://peer1:3000",
      {
        paymentPayload: {
          payload: { authorization: { from: "0x2222" } },
        } as any,
      },
      { payer: "0x2222" }
    );

    expect(router.size.payers).toBe(1);

    // Advance time but stay within TTL
    vi.setSystemTime(now + SELECTION_TTL_MS - 1000);

    router.cleanup();

    expect(router.size.payers).toBe(1);

    vi.useRealTimers();
  });

  it("destroy() clears all state", () => {
    router.recordSelection(
      "http://peer1:3000",
      {
        paymentPayload: {
          payload: { authorization: { from: "0x3333" } },
        } as any,
      },
      { payer: "0x3333" }
    );

    router.recordSelection(
      "http://peer2:3000",
      { paymentHeader: "header123" },
      {}
    );

    expect(router.size.payers).toBeGreaterThan(0);

    router.destroy();

    expect(router.size.payers).toBe(0);
    expect(router.size.headers).toBe(0);
  });

  it("getPreferredPeer returns undefined for expired entries", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    router.recordSelection(
      "http://peer1:3000",
      {
        paymentPayload: {
          payload: { authorization: { from: "0x4444" } },
        } as any,
      },
      { payer: "0x4444" }
    );

    // Should find the peer
    const body = {
      paymentPayload: {
        payload: { authorization: { from: "0x4444" } },
      } as any,
    };
    expect(router.getPreferredPeer(body)).toBe("http://peer1:3000");

    // Advance past TTL
    vi.setSystemTime(now + SELECTION_TTL_MS + 1);

    // Should not find the peer anymore
    expect(router.getPreferredPeer(body)).toBeUndefined();

    vi.useRealTimers();
  });
});

describe("PeerRegistry cleanup", () => {
  let registry: PeerRegistry;

  beforeEach(() => {
    // Disable auto-cleanup so we can control timing manually
    registry = new PeerRegistry(false);
  });

  afterEach(() => {
    registry.destroy();
  });

  it("removes stale peers on cleanup()", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    registry.register("http://peer1:3000", [
      { x402Version: 1, scheme: "exact", network: "base-sepolia" },
    ]);

    expect(registry.size).toBe(1);

    // Advance time past TTL
    vi.setSystemTime(now + REGISTRY_TTL_MS + 1000);

    registry.cleanup();

    expect(registry.size).toBe(0);

    vi.useRealTimers();
  });

  it("retains recently registered peers", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    registry.register("http://peer1:3000");

    expect(registry.size).toBe(1);

    // Advance time but stay within TTL
    vi.setSystemTime(now + REGISTRY_TTL_MS - 1000);

    registry.cleanup();

    expect(registry.size).toBe(1);

    vi.useRealTimers();
  });

  it("destroy() clears all state", () => {
    registry.register("http://peer1:3000");
    registry.register("http://peer2:3000");

    expect(registry.size).toBe(2);

    registry.destroy();

    expect(registry.size).toBe(0);
  });

  it("getActivePeers filters out stale peers", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    registry.register("http://dynamic1:3000");
    registry.register("http://dynamic2:3000");

    const staticPeers = ["http://static:3000"];

    // All should be active initially
    let active = registry.getActivePeers(staticPeers);
    expect(active).toContain("http://static:3000");
    expect(active).toContain("http://dynamic1:3000");
    expect(active).toContain("http://dynamic2:3000");
    expect(active.length).toBe(3);

    // Advance past TTL
    vi.setSystemTime(now + REGISTRY_TTL_MS + 1);

    // Dynamic peers should be filtered out
    active = registry.getActivePeers(staticPeers);
    expect(active).toContain("http://static:3000");
    expect(active).not.toContain("http://dynamic1:3000");
    expect(active).not.toContain("http://dynamic2:3000");
    expect(active.length).toBe(1);

    vi.useRealTimers();
  });

  it("re-registration refreshes lastSeenMs", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    registry.register("http://peer1:3000");

    // Advance time close to TTL
    vi.setSystemTime(now + REGISTRY_TTL_MS - 1000);

    // Re-register (heartbeat)
    registry.register("http://peer1:3000");

    // Advance time past original TTL but within new TTL
    vi.setSystemTime(now + REGISTRY_TTL_MS + 1000);

    // Should still be active due to re-registration
    const active = registry.getActivePeers([]);
    expect(active).toContain("http://peer1:3000");

    vi.useRealTimers();
  });
});

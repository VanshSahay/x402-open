import { describe, it, expect, vi } from "vitest";

vi.mock("x402/facilitator", () => ({
  verify: vi.fn(async () => true),
  settle: vi.fn(async () => ({ txHash: "0x123" })),
}));

import { Facilitator } from "../src/facilitator.js";

describe("Facilitator", () => {
  it("/supported lists EVM networks", async () => {
    const facilitator = new Facilitator({
      evmPrivateKey: "0xabc" as any,
      networks: [{ network: "base-sepolia" } as any],
    });
    const res = await facilitator.handleRequest({ method: "GET", path: "/supported" });
    expect(res.status).toBe(200);
    expect((res.body as any).kinds.length).toBeGreaterThan(0);
  });

  it("/verify proxies to x402 verify", async () => {
    const facilitator = new Facilitator({
      networks: [{ network: "base-sepolia" } as any],
    });
    // Bypass schema parsing for unit test
    (facilitator as any).parseBody = () => ({ paymentPayload: {}, paymentRequirements: { network: "base-sepolia" } });
    const res = await facilitator.handleRequest({
      method: "POST",
      path: "/verify",
      body: {
        paymentPayload: {},
        paymentRequirements: { network: "base-sepolia" },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe(true);
  });
});



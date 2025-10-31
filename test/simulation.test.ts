import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock x402 core so facilitator verify/settle behave deterministically
vi.mock("x402/facilitator", () => ({
  verify: vi.fn(async (_client: any, _payload: any, _reqs: any) => true),
  settle: vi.fn(async (_signer: any, _payload: any, _reqs: any) => ({ txHash: "0xSIMULATED" })),
}));

import { Facilitator } from "../src/facilitator.js";
import { createGatewayAdapter } from "../src/gateway.js";

type P2PShape = NonNullable<Facilitator["p2p"]>;

class MockNetwork {
  private readonly peerIdToFacilitator = new Map<string, Facilitator>();
  register(peerId: string, facilitator: Facilitator) {
    this.peerIdToFacilitator.set(peerId, facilitator);
  }
  getP2PForGateway(): P2PShape {
    const listeners: Array<(peerId: string, kinds: any[]) => void> = [];
    return {
      start: async () => {},
      stop: async () => {},
      onAnnouncement: (h) => {
        listeners.push(h);
        return () => {
          const i = listeners.indexOf(h);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      requestVerify: async (peerId, body) => {
        const f = this.peerIdToFacilitator.get(peerId)!;
        const res = await f.handleRequest({ method: "POST", path: "/verify", body });
        return res;
      },
      requestSettle: async (peerId, body) => {
        const f = this.peerIdToFacilitator.get(peerId)!;
        const res = await f.handleRequest({ method: "POST", path: "/settle", body });
        return res;
      },
      getPeerId: () => "gateway",
      getMultiaddrs: () => [],
      // not used in this test
      requestVerifyByMultiaddr: async () => ({ status: 503, body: {} }),
      requestSettleByMultiaddr: async () => ({ status: 503, body: {} }),
      requestHealth: async () => ({ status: 200, body: { ok: true } }),
      requestHealthByMultiaddr: async () => ({ status: 200, body: { ok: true } }),
    } as unknown as P2PShape;
  }
}

function makeFacilitator(): Facilitator {
  // Only need EVM verify client path to be valid; networks is used for /supported
  const f = new Facilitator({
    evmPrivateKey: "0xabc" as any,
    networks: [{ network: "base-sepolia" } as any],
    decentralized: { enabled: false },
  });
  // Accept spec-shaped body and bypass strict schema for simulation
  (f as any).parseBody = (body: any) => {
    const paymentRequirements = body?.paymentRequirements ?? { network: "base-sepolia" };
    const paymentPayload = body?.paymentPayload ?? { header: body?.paymentHeader ?? "header" };
    return { paymentPayload, paymentRequirements };
  };
  // Bypass network/signature dependencies
  (f as any).getVerifyClient = async () => ({});
  (f as any).getSettleSigner = async () => ({});
  return f;
}

function makeGatewayApp(p2p: P2PShape, staticPeers: string[], verifyQuorum = 1) {
  const app = express();
  app.use(express.json());
  const fakeFacilitator: any = { p2p };
  createGatewayAdapter(fakeFacilitator, app as any, {
    basePath: "/facilitator",
    staticPeers,
    verifyQuorum,
  });
  return app;
}

let originalRandom: typeof Math.random;
beforeEach(() => {
  originalRandom = Math.random;
});
afterEach(() => {
  (Math.random as any) = originalRandom;
});

describe("Simulation: gateway + facilitators (mock network)", () => {
  it("verify: 200 true when any peer validates true", async () => {
    const net = new MockNetwork();
    const peerA = "peerA";
    const peerB = "peerB";
    net.register(peerA, makeFacilitator());
    net.register(peerB, makeFacilitator());
    const app = makeGatewayApp(net.getP2PForGateway(), [peerA, peerB], 1);

    const res = await request(app)
      .post("/facilitator/rpc/verify")
      .send({ x402Version: 1, paymentHeader: "hdr", paymentRequirements: { network: "base-sepolia" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isValid: true, invalidReason: null });
  });

  it("settle: forwards to one selected peer and returns tx object", async () => {
    const net = new MockNetwork();
    const peerA = "peerA";
    const peerB = "peerB";
    net.register(peerA, makeFacilitator());
    net.register(peerB, makeFacilitator());
    // Make selection deterministic
    (Math.random as any) = () => 0;
    const app = makeGatewayApp(net.getP2PForGateway(), [peerA, peerB], 1);

    const res = await request(app)
      .post("/facilitator/rpc/settle")
      .send({ x402Version: 1, paymentHeader: "hdr", paymentRequirements: { network: "base-sepolia" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, error: null, txHash: "0xSIMULATED", networkId: null });
  });

  it("verify quorum=2: with one true and one false returns 200 false", async () => {
    const net = new MockNetwork();
    const peerA = "peerA";
    const peerB = "peerB";
    // peerA facilitator returns true (default mock)
    net.register(peerA, makeFacilitator());
    // peerB facilitator will return false → mock x402.verify at runtime for this call by wrapping handleRequest
    const fb = makeFacilitator();
    const origHandle = fb.handleRequest.bind(fb);
    fb.handleRequest = async (req) => {
      if (req.method === "POST" && req.path === "/verify") {
        return { status: 200, body: false };
      }
      return origHandle(req);
    };
    net.register(peerB, fb);

    const app = makeGatewayApp(net.getP2PForGateway(), [peerA, peerB], 2);
    const res = await request(app)
      .post("/facilitator/rpc/verify")
      .send({ x402Version: 1, paymentHeader: "hdr", paymentRequirements: { network: "base-sepolia" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isValid: false, invalidReason: null });
  });
});



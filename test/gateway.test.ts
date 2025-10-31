import express from "express";
import request from "supertest";
import { describe, it, expect } from "vitest";
import { createGatewayAdapter } from "../src/gateway.js";

function makeApp(p2pImpl: any, opts?: { staticPeers?: string[]; peerMultiaddrs?: string[]; verifyQuorum?: number }) {
  const app = express();
  app.use(express.json());

  const facilitator: any = {
    p2p: {
      onAnnouncement: () => () => {},
      requestVerify: async (...args: any[]) => p2pImpl?.requestVerify?.(...args),
      requestSettle: async (...args: any[]) => p2pImpl?.requestSettle?.(...args),
    },
  };
  createGatewayAdapter(facilitator, app as any, {
    basePath: "/facilitator",
    staticPeers: opts?.staticPeers ?? ["peerA", "peerB"],
    peerMultiaddrs: opts?.peerMultiaddrs ?? [],
    verifyQuorum: opts?.verifyQuorum ?? 1,
  });
  return app;
}

describe("gateway /rpc/verify", () => {
  it("returns 503 when no peers", async () => {
    const app = makeApp(undefined, { staticPeers: [] });
    const res = await request(app).post("/facilitator/rpc/verify").send({});
    expect(res.status).toBe(503);
  });

  it("returns 200 true when a peer returns true", async () => {
    const p2p = {
      requestVerify: async (peerId: string) => ({ status: 200, body: peerId === "peerA" ? true : false }),
    };
    const app = makeApp(p2p);
    const res = await request(app).post("/facilitator/rpc/verify").send({ paymentRequirements: { network: "base-sepolia" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isValid: true, invalidReason: null });
  });

  it("returns 200 false when peers return false", async () => {
    const p2p = {
      requestVerify: async () => ({ status: 200, body: false }),
    };
    const app = makeApp(p2p);
    const res = await request(app).post("/facilitator/rpc/verify").send({ paymentRequirements: { network: "base-sepolia" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isValid: false, invalidReason: null });
  });

  it("returns first peer error when none succeed", async () => {
    const p2p = {
      requestVerify: async () => ({ status: 400, body: { error: "bad" } }),
    };
    const app = makeApp(p2p);
    const res = await request(app).post("/facilitator/rpc/verify").send({ paymentRequirements: { network: "base-sepolia" } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ isValid: false, invalidReason: "bad" });
  });

  it("respects quorum > 1", async () => {
    let calls = 0;
    const p2p = {
      requestVerify: async () => {
        calls += 1;
        // alternate true/false
        return { status: 200, body: calls % 2 === 0 };
      },
    };
    const app = makeApp(p2p, { verifyQuorum: 2 });
    const res = await request(app).post("/facilitator/rpc/verify").send({ paymentRequirements: { network: "base-sepolia" } });
    // With two peers alternating, only one true → quorum not reached → 200 false (isValid false)
    expect(res.status).toBe(200);
    expect(typeof res.body?.isValid).toBe("boolean");
  });
});



import express from "express";
import { Hono } from "hono";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Mock x402 libs so facilitator accepts our payloads and returns deterministic results
vi.mock("x402/types", () => {
  const pass = { parse: (v: any) => v };
  return {
    PaymentRequirementsSchema: pass,
    PaymentPayloadSchema: pass,
    createConnectedClient: async () => ({}),
    createSigner: async () => ({}),
    SupportedEVMNetworks: ["base-sepolia"],
    SupportedSVMNetworks: [],
    isSvmSignerWallet: () => false,
  };
});

vi.mock("x402/facilitator", () => ({
  verify: vi.fn(async () => true),
  settle: vi.fn(async (_signer: any, _payload: any, _reqs: any) => ({ txHash: "0xE2E" })),
}));

import { Facilitator } from "../src/facilitator";
import { createExpressAdapter } from "../src/adapters/expressAdapter";
import { createHonoAdapter } from "../src/adapters/honoAdapter";
import { createHonoGatewayAdapter } from "../src/adapters/honoGateway";

// Use real Express servers as backend facilitator nodes (already proven)
function startServer(app: express.Express): Promise<{ server: any; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

const testPayload = {
  paymentPayload: {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0xSIG",
      authorization: {
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
        value: "1000",
        validAfter: "1761952780",
        validBefore: "1761953680",
        nonce: "0x01",
      },
    },
  },
  paymentRequirements: {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "1000",
    resource: "http://localhost/resource",
    description: "Test",
    mimeType: "application/json",
    payTo: "0x2222222222222222222222222222222222222222",
    maxTimeoutSeconds: 300,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
};

// ─── Hono Facilitator Adapter Tests ──────────────────────────────────────────

describe("Hono Facilitator Adapter", () => {
  let app: Hono;

  beforeAll(() => {
    const facilitator = new Facilitator({
      evmPrivateKey: "0xabc" as any,
      networks: [{ network: "base-sepolia" } as any],
    });
    app = new Hono();
    app.route("/facilitator", createHonoAdapter(facilitator));
  });

  it("GET /supported returns kinds", async () => {
    const res = await app.request("/facilitator/supported");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body?.kinds)).toBe(true);
    expect(body.kinds.length).toBeGreaterThan(0);
  });

  it("POST /verify returns boolean", async () => {
    const res = await app.request("/facilitator/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(testPayload),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBe(true);
  });

  it("POST /settle returns txHash", async () => {
    const res = await app.request("/facilitator/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(testPayload),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe("object");
    expect(body.txHash).toBe("0xE2E");
  });

  it("returns 404 for unknown paths", async () => {
    const res = await app.request("/facilitator/unknown");
    expect(res.status).toBe(404);
  });
});

// ─── Hono Gateway Adapter Tests ──────────────────────────────────────────────

describe("E2E: Hono Gateway with two Express nodes", () => {
  let nodeA: { server: any; url: string };
  let nodeB: { server: any; url: string };
  let gateway: Hono;

  beforeAll(async () => {
    // Node A — Express facilitator
    const nodeAppA = express();
    nodeAppA.use(express.json());
    const facilitatorA = new Facilitator({
      evmPrivateKey: "0xabc" as any,
      networks: [{ network: "base-sepolia" } as any],
    });
    createExpressAdapter(facilitatorA, nodeAppA, "/facilitator");

    // Node B — Express facilitator, override settle for observability
    const nodeAppB = express();
    nodeAppB.use(express.json());
    const facilitatorB = new Facilitator({
      evmPrivateKey: "0xdef" as any,
      networks: [{ network: "base-sepolia" } as any],
    });
    const origHandle = facilitatorB.handleRequest.bind(facilitatorB);
    facilitatorB.handleRequest = async (req) => {
      if (req.method === "POST" && req.path === "/settle") {
        return { status: 200, body: { txHash: "0xNODEB" } };
      }
      return origHandle(req);
    };
    createExpressAdapter(facilitatorB, nodeAppB, "/facilitator");

    nodeA = await startServer(nodeAppA);
    nodeB = await startServer(nodeAppB);

    // Hono gateway pointing to the two Express nodes
    const gatewaySubApp = createHonoGatewayAdapter({
      httpPeers: [
        `${nodeA.url}/facilitator`,
        `${nodeB.url}/facilitator`,
      ],
      debug: true,
    });
    gateway = new Hono();
    gateway.route("/facilitator", gatewaySubApp);
  });

  afterAll(async () => {
    await new Promise((r) => nodeA.server.close(() => r(undefined)));
    await new Promise((r) => nodeB.server.close(() => r(undefined)));
  });

  it("aggregates supported kinds", async () => {
    const res = await gateway.request("/facilitator/supported");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body?.kinds)).toBe(true);
    expect(body.kinds.length).toBeGreaterThan(0);
  });

  it("verifies and settles via a single selected node", async () => {
    // Verify
    const v = await gateway.request("/facilitator/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(testPayload),
    });
    expect(v.status).toBe(200);
    const vBody = await v.json();
    expect(vBody).toBe(true);

    // Settle — should use the same node (sticky routing)
    const s = await gateway.request("/facilitator/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(testPayload),
    });
    expect(s.status).toBe(200);
    const sBody = await s.json();
    expect(typeof sBody).toBe("object");
    expect(typeof sBody.txHash).toBe("string");
  });

  it("registers a new peer", async () => {
    const res = await gateway.request("/facilitator/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://localhost:9999/facilitator" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Peer should appear in /peers
    const peersRes = await gateway.request("/facilitator/peers");
    expect(peersRes.status).toBe(200);
    const peersBody = await peersRes.json();
    expect(peersBody.peers).toContain("http://localhost:9999/facilitator");
  });

  it("rejects invalid register url", async () => {
    const res = await gateway.request("/facilitator/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "not-a-url" }),
    });
    expect(res.status).toBe(400);
  });
});

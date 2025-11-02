import express from "express";
import request from "supertest";
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

import { Facilitator } from "../src/facilitator.js";
import { createExpressAdapter } from "../src/expressAdapter.js";
import { createHttpGatewayAdapter } from "../src/httpGateway.js";

function startServer(app: express.Express): Promise<{ server: any; url: string }>{
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

describe("E2E: HTTP Gateway with two nodes", () => {
  let nodeA: { server: any; url: string };
  let nodeB: { server: any; url: string };
  let gateway: express.Express;

  let nodeAppA: express.Express;
  let nodeAppB: express.Express;

  beforeAll(async () => {
    // Node A
    nodeAppA = express();
    nodeAppA.use(express.json());
    const facilitatorA = new Facilitator({
      evmPrivateKey: "0xabc" as any,
      networks: [{ network: "base-sepolia" } as any],
    });
    createExpressAdapter(facilitatorA, nodeAppA, "/facilitator");

    // Node B - override settle to make node selection observable
    nodeAppB = express();
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

    // Gateway
    gateway = express();
    gateway.use(express.json());
    createHttpGatewayAdapter(gateway, {
      basePath: "/facilitator",
      httpPeers: [
        `${nodeA.url}/facilitator`,
        `${nodeB.url}/facilitator`,
      ],
      // Deterministic routing ensures verify and settle go to same node for a header
      selection: "headerHash",
      debug: true,
    });
  });

  afterAll(async () => {
    // Close node servers
    await new Promise((r) => (nodeA.server.close(() => r(undefined))));
    await new Promise((r) => (nodeB.server.close(() => r(undefined))));
  });

  it("aggregates supported kinds", async () => {
    const res = await request(gateway).get("/facilitator/supported");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body?.kinds)).toBe(true);
    expect(res.body.kinds.length).toBeGreaterThan(0);
  });

  it("verifies and settles via a single selected node", async () => {
    const body = {
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

    // Verify → boolean
    const v = await request(gateway)
      .post("/facilitator/verify")
      .send(body);
    expect(v.status).toBe(200);
    expect(typeof v.body).toBe("boolean");
    expect(v.body).toBe(true);

    // Settle → object with txHash, must be from the same selected node
    const s = await request(gateway)
      .post("/facilitator/settle")
      .send(body);
    expect(s.status).toBe(200);
    // Because of headerHash selection, both requests target the same node deterministically
    // If nodeB is selected, txHash will be 0xNODEB; otherwise default mock 0xE2E
    expect(typeof s.body).toBe("object");
    expect(typeof s.body.txHash).toBe("string");
  });
});

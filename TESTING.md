# Testing Gateway-to-Gateway Communication

This guide shows you how to test the gateway-to-gateway communication feature.

## Quick Test Setup

### Step 1: Start Two Facilitator Nodes

**Terminal 1 - Node A:**
```bash
# Create a test file: test-node-a.ts
```

```typescript
import express from "express";
import { Facilitator, createExpressAdapter } from "./src/index.js";
import { baseSepolia } from "viem/chains";

const app = express();
app.use(express.json());

const facilitator = new Facilitator({
  evmPrivateKey: "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
  evmNetworks: [baseSepolia],
});

createExpressAdapter(facilitator, app, "/facilitator");

app.listen(4101, () => {
  console.log("Node A running on http://localhost:4101/facilitator");
});
```

**Terminal 2 - Node B:**
```bash
# Create a test file: test-node-b.ts
```

```typescript
import express from "express";
import { Facilitator, createExpressAdapter } from "./src/index.js";
import { baseSepolia } from "viem/chains";

const app = express();
app.use(express.json());

const facilitator = new Facilitator({
  evmPrivateKey: "0x0000000000000000000000000000000000000000000000000000000000000002" as `0x${string}`,
  evmNetworks: [baseSepolia],
});

createExpressAdapter(facilitator, app, "/facilitator");

app.listen(4102, () => {
  console.log("Node B running on http://localhost:4102/facilitator");
});
```

Run them:
```bash
# Terminal 1
npx tsx test-node-a.ts

# Terminal 2
npx tsx test-node-b.ts
```

### Step 2: Start Two Gateways

**Terminal 3 - Gateway A:**
```bash
# Create a test file: test-gateway-a.ts
```

```typescript
import express from "express";
import { createHttpGatewayAdapter } from "./src/index.js";

const app = express();
app.use(express.json());

createHttpGatewayAdapter(app, {
  basePath: "/facilitator",
  // Gateway A knows about Node A
  httpPeers: ["http://localhost:4101/facilitator"],
  debug: true,
});

app.listen(8080, () => {
  console.log("Gateway A running on http://localhost:8080/facilitator");
  console.log("Known nodes: http://localhost:4101/facilitator");
});
```

**Terminal 4 - Gateway B:**
```bash
# Create a test file: test-gateway-b.ts
```

```typescript
import express from "express";
import { createHttpGatewayAdapter } from "./src/index.js";

const app = express();
app.use(express.json());

createHttpGatewayAdapter(app, {
  basePath: "/facilitator",
  // Gateway B knows about Node B
  httpPeers: ["http://localhost:4102/facilitator"],
  debug: true,
});

app.listen(8081, () => {
  console.log("Gateway B running on http://localhost:8081/facilitator");
  console.log("Known nodes: http://localhost:4102/facilitator");
});
```

Run them:
```bash
# Terminal 3
npx tsx test-gateway-a.ts

# Terminal 4
npx tsx test-gateway-b.ts
```

### Step 3: Test Gateway Discovery

**Terminal 5 - Test Commands:**

```bash
# 1. Check Gateway A's initial nodes
curl http://localhost:8080/facilitator/nodes
# Should return: {"nodes":["http://localhost:4101/facilitator"]}

# 2. Check Gateway B's initial nodes
curl http://localhost:8081/facilitator/nodes
# Should return: {"nodes":["http://localhost:4102/facilitator"]}

# 3. Register Gateway B as a peer of Gateway A
curl -X POST http://localhost:8080/facilitator/peers \
  -H "Content-Type: application/json" \
  -d '{"url": "http://localhost:8081/facilitator"}'

# 4. Wait a moment for discovery, then check Gateway A's nodes again
sleep 2
curl http://localhost:8080/facilitator/nodes
# Should now return: {"nodes":["http://localhost:4101/facilitator","http://localhost:4102/facilitator"]}
# Gateway A discovered Node B from Gateway B!

# 5. Check registered peer gateways
curl http://localhost:8080/facilitator/peers
# Should return: {"peers":["http://localhost:8081/facilitator"]}
```

### Step 4: Test Verify/Settle with Discovered Nodes

```bash
# Test verify with a sample payload
curl -X POST http://localhost:8080/facilitator/verify \
  -H "Content-Type: application/json" \
  -d '{
    "paymentPayload": {
      "x402Version": 1,
      "scheme": "exact",
      "network": "base-sepolia",
      "payload": {
        "signature": "0xSIG",
        "authorization": {
          "from": "0x1111111111111111111111111111111111111111",
          "to": "0x2222222222222222222222222222222222222222",
          "value": "1000",
          "validAfter": "1761952780",
          "validBefore": "1761953680",
          "nonce": "0x01"
        }
      }
    },
    "paymentRequirements": {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "1000",
      "resource": "http://localhost/resource",
      "description": "Test",
      "mimeType": "application/json",
      "payTo": "0x2222222222222222222222222222222222222222",
      "maxTimeoutSeconds": 300,
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    }
  }'

# The verify should work and may route to either Node A or Node B
# (since Gateway A now knows about both)
```

## Automated Test Script

Create `test-gateway-discovery.ts`:

```typescript
import express from "express";
import { Facilitator, createExpressAdapter, createHttpGatewayAdapter } from "./src/index.js";
import { baseSepolia } from "viem/chains";

async function test() {
  // Start Node A
  const nodeA = express();
  nodeA.use(express.json());
  const facilitatorA = new Facilitator({
    evmPrivateKey: "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
    evmNetworks: [baseSepolia],
  });
  createExpressAdapter(facilitatorA, nodeA, "/facilitator");
  const nodeAServer = nodeA.listen(4101);
  console.log("✓ Node A started on port 4101");

  // Start Node B
  const nodeB = express();
  nodeB.use(express.json());
  const facilitatorB = new Facilitator({
    evmPrivateKey: "0x0000000000000000000000000000000000000000000000000000000000000002" as `0x${string}`,
    evmNetworks: [baseSepolia],
  });
  createExpressAdapter(facilitatorB, nodeB, "/facilitator");
  const nodeBServer = nodeB.listen(4102);
  console.log("✓ Node B started on port 4102");

  // Start Gateway A (knows Node A)
  const gatewayA = express();
  gatewayA.use(express.json());
  createHttpGatewayAdapter(gatewayA, {
    basePath: "/facilitator",
    httpPeers: ["http://localhost:4101/facilitator"],
    debug: true,
  });
  const gatewayAServer = gatewayA.listen(8080);
  console.log("✓ Gateway A started on port 8080");

  // Start Gateway B (knows Node B)
  const gatewayB = express();
  gatewayB.use(express.json());
  createHttpGatewayAdapter(gatewayB, {
    basePath: "/facilitator",
    httpPeers: ["http://localhost:4102/facilitator"],
    debug: true,
  });
  const gatewayBServer = gatewayB.listen(8081);
  console.log("✓ Gateway B started on port 8081");

  // Wait for servers to be ready
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    // Test 1: Check initial state
    console.log("\n📋 Test 1: Check initial nodes");
    const nodesA1 = await fetch("http://localhost:8080/facilitator/nodes").then(r => r.json());
    console.log("Gateway A nodes:", nodesA1.nodes);
    console.log("Expected: ['http://localhost:4101/facilitator']");
    console.log(nodesA1.nodes.length === 1 ? "✓ PASS" : "✗ FAIL");

    const nodesB1 = await fetch("http://localhost:8081/facilitator/nodes").then(r => r.json());
    console.log("Gateway B nodes:", nodesB1.nodes);
    console.log("Expected: ['http://localhost:4102/facilitator']");
    console.log(nodesB1.nodes.length === 1 ? "✓ PASS" : "✗ FAIL");

    // Test 2: Register Gateway B as peer of Gateway A
    console.log("\n📋 Test 2: Register peer gateway");
    const registerRes = await fetch("http://localhost:8080/facilitator/peers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://localhost:8081/facilitator" }),
    });
    console.log("Register response:", await registerRes.json());
    console.log(registerRes.ok ? "✓ PASS" : "✗ FAIL");

    // Test 3: Wait for discovery and check nodes again
    console.log("\n📋 Test 3: Wait for node discovery");
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds for discovery

    const nodesA2 = await fetch("http://localhost:8080/facilitator/nodes").then(r => r.json());
    console.log("Gateway A nodes after discovery:", nodesA2.nodes);
    console.log("Expected: ['http://localhost:4101/facilitator', 'http://localhost:4102/facilitator']");
    const hasBothNodes = nodesA2.nodes.length === 2 && 
      nodesA2.nodes.includes("http://localhost:4101/facilitator") &&
      nodesA2.nodes.includes("http://localhost:4102/facilitator");
    console.log(hasBothNodes ? "✓ PASS" : "✗ FAIL");

    // Test 4: Check peer gateways list
    console.log("\n📋 Test 4: Check peer gateways");
    const peers = await fetch("http://localhost:8080/facilitator/peers").then(r => r.json());
    console.log("Gateway A peer gateways:", peers.peers);
    console.log("Expected: ['http://localhost:8081/facilitator']");
    console.log(peers.peers.length === 1 && peers.peers[0] === "http://localhost:8081/facilitator" ? "✓ PASS" : "✗ FAIL");

    console.log("\n✅ All tests completed!");

  } finally {
    // Cleanup
    nodeAServer.close();
    nodeBServer.close();
    gatewayAServer.close();
    gatewayBServer.close();
    console.log("\n🧹 Servers closed");
  }
}

test().catch(console.error);
```

Run it:
```bash
npx tsx test-gateway-discovery.ts
```

## Testing Checklist

- [ ] **Initial State**: Each gateway only knows its own nodes
- [ ] **Peer Registration**: POST `/peers` successfully registers a peer gateway
- [ ] **Node Discovery**: After registration, nodes from peer gateway appear in `/nodes`
- [ ] **Peer Listing**: GET `/peers` returns registered peer gateways
- [ ] **Verify Works**: `/verify` can route to discovered nodes
- [ ] **Settle Works**: `/settle` can route to discovered nodes
- [ ] **Periodic Sync**: After 30 seconds, nodes stay in sync (check logs)

## Debugging Tips

1. **Enable debug mode**: Set `debug: true` in gateway options to see discovery logs
2. **Check discovery timing**: Discovery happens immediately on registration, then every 30 seconds
3. **Verify node endpoints**: Make sure `/nodes` endpoint is accessible on peer gateways
4. **Check network**: Ensure all services can reach each other (localhost or proper network config)
5. **Watch console logs**: The `debug: true` option will show discovery attempts and results

## Expected Behavior

1. **Before peer registration**: Each gateway only sees its own nodes
2. **After peer registration**: Gateway immediately queries peer's `/nodes` endpoint
3. **After discovery**: Gateway's `/nodes` includes both local and discovered nodes
4. **Verify/Settle**: Routes can use any available node (local or discovered)
5. **Periodic sync**: Every 30 seconds, gateway re-discovers nodes from all peer gateways

## Troubleshooting

**Nodes not discovered?**
- Check that peer gateway's `/nodes` endpoint is accessible
- Verify the peer gateway URL is correct (no trailing slash issues)
- Check console logs with `debug: true`
- Wait a few seconds - discovery happens asynchronously

**Discovery not working?**
- Ensure both gateways are running
- Check network connectivity between gateways
- Verify the `/nodes` endpoint returns the correct format: `{ nodes: string[] }`
- Check for CORS issues if testing across different origins

**Verify/Settle failing?**
- Make sure the discovered nodes are actually running
- Check that nodes support the required network (e.g., base-sepolia)
- Verify the payment payload format is correct

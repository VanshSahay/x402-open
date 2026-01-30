/**
 * 
 * This script:
 * 1. Starts two facilitator nodes (Node A and Node B)
 * 2. Starts two gateways (Gateway A knows Node A, Gateway B knows Node B)
 * 3. Registers Gateway B as a peer of Gateway A
 * 4. Verifies that Gateway A discovers Node B from Gateway B
 * 
 * Run: npx tsx test-gateway-discovery.ts
 */

import express from "express";
import { Facilitator, createExpressAdapter, createHttpGatewayAdapter } from "./src/index.js";
import { baseSepolia } from "viem/chains";

async function test() {
  console.log("🚀 Starting gateway-to-gateway communication test...\n");

  // Start Node A
  const nodeA = express();
  nodeA.use(express.json());
  const facilitatorA = new Facilitator({
    evmPrivateKey: "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
    evmNetworks: [baseSepolia],
  });
  createExpressAdapter(facilitatorA, nodeA, "/facilitator");
  const nodeAServer = nodeA.listen(4101);
  console.log("✓ Node A started on http://localhost:4101/facilitator");

  // Start Node B
  const nodeB = express();
  nodeB.use(express.json());
  const facilitatorB = new Facilitator({
    evmPrivateKey: "0x0000000000000000000000000000000000000000000000000000000000000002" as `0x${string}`,
    evmNetworks: [baseSepolia],
  });
  createExpressAdapter(facilitatorB, nodeB, "/facilitator");
  const nodeBServer = nodeB.listen(4102);
  console.log("✓ Node B started on http://localhost:4102/facilitator");

  // Start Gateway A (knows Node A)
  const gatewayA = express();
  gatewayA.use(express.json());
  createHttpGatewayAdapter(gatewayA, {
    basePath: "/facilitator",
    httpPeers: ["http://localhost:4101/facilitator"],
    debug: true,
  });
  const gatewayAServer = gatewayA.listen(8080);
  console.log("✓ Gateway A started on http://localhost:8080/facilitator");

  // Start Gateway B (knows Node B)
  const gatewayB = express();
  gatewayB.use(express.json());
  createHttpGatewayAdapter(gatewayB, {
    basePath: "/facilitator",
    httpPeers: ["http://localhost:4102/facilitator"],
    debug: true,
  });
  const gatewayBServer = gatewayB.listen(8081);
  console.log("✓ Gateway B started on http://localhost:8081/facilitator");

  // Wait for servers to be ready
  console.log("\n⏳ Waiting for servers to initialize...");
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    // Test 1: Check initial state
    console.log("\n📋 Test 1: Check initial nodes");
    const nodesA1 = await fetch("http://localhost:8080/facilitator/nodes").then(r => r.json());
    console.log("  Gateway A nodes:", nodesA1.nodes);
    const test1Pass = nodesA1.nodes.length === 1 && 
      nodesA1.nodes[0] === "http://localhost:4101/facilitator";
    console.log(test1Pass ? "  ✓ PASS" : "  ✗ FAIL");

    const nodesB1 = await fetch("http://localhost:8081/facilitator/nodes").then(r => r.json());
    console.log("  Gateway B nodes:", nodesB1.nodes);
    const test1bPass = nodesB1.nodes.length === 1 && 
      nodesB1.nodes[0] === "http://localhost:4102/facilitator";
    console.log(test1bPass ? "  ✓ PASS" : "  ✗ FAIL");

    // Test 2: Register Gateway B as peer of Gateway A
    console.log("\n📋 Test 2: Register peer gateway");
    const registerRes = await fetch("http://localhost:8080/facilitator/peers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://localhost:8081/facilitator" }),
    });
    const registerData = await registerRes.json();
    console.log("  Register response:", registerData);
    const test2Pass = registerRes.ok && registerData.ok === true;
    console.log(test2Pass ? "  ✓ PASS" : "  ✗ FAIL");

    // Test 3: Wait for discovery and check nodes again
    console.log("\n📋 Test 3: Wait for node discovery (2 seconds)");
    await new Promise(resolve => setTimeout(resolve, 2000));

    const nodesA2 = await fetch("http://localhost:8080/facilitator/nodes").then(r => r.json());
    console.log("  Gateway A nodes after discovery:", nodesA2.nodes);
    const hasBothNodes = nodesA2.nodes.length === 2 && 
      nodesA2.nodes.includes("http://localhost:4101/facilitator") &&
      nodesA2.nodes.includes("http://localhost:4102/facilitator");
    console.log(hasBothNodes ? "  ✓ PASS - Gateway A discovered Node B!" : "  ✗ FAIL");

    // Test 4: Check peer gateways list
    console.log("\n📋 Test 4: Check peer gateways");
    const peers = await fetch("http://localhost:8080/facilitator/peers").then(r => r.json());
    console.log("  Gateway A peer gateways:", peers.peers);
    const test4Pass = peers.peers.length === 1 && 
      peers.peers[0] === "http://localhost:8081/facilitator";
    console.log(test4Pass ? "  ✓ PASS" : "  ✗ FAIL");

    // Summary
    console.log("\n" + "=".repeat(50));
    const allPassed = test1Pass && test1bPass && test2Pass && hasBothNodes && test4Pass;
    if (allPassed) {
      console.log("✅ All tests PASSED!");
      console.log("\nGateway-to-gateway communication is working correctly.");
      console.log("Gateway A can now route requests to both Node A and Node B.");
    } else {
      console.log("❌ Some tests FAILED. Check the output above.");
    }
    console.log("=".repeat(50));

  } finally {
    // Cleanup
    console.log("\n🧹 Closing servers...");
    nodeAServer.close();
    nodeBServer.close();
    gatewayAServer.close();
    gatewayBServer.close();
    console.log("✓ Servers closed");
  }
}

test().catch(console.error);

# Run multiple x402-open nodes locally

This guide shows how to run two facilitators that advertise over libp2p and test a verify flow across peers.

## Prereqs
- Node 18+ (or 20+)
- Install libp2p deps in your app:

```bash
pnpm add libp2p @chainsafe/libp2p-noise @libp2p/mplex @chainsafe/libp2p-gossipsub @libp2p/kad-dht @libp2p/tcp @libp2p/websockets @libp2p/identify @libp2p/circuit-relay-v2 @libp2p/bootstrap @libp2p/ping
```

## Example app
Create `nodeA.ts` and `nodeB.ts` in a test project that depends on `x402-open`.

```ts
// nodeA.ts
import express from "express";
import { Facilitator, createExpressAdapter } from "x402-open";
import { baseSepolia } from "viem/chains";

const app = express();
app.use(express.json());

const facilitator = new Facilitator({
  evmPrivateKey: process.env.EVM_PRIVATE_KEY as `0x${string}`,
  networks: [baseSepolia],
  decentralized: {
    enabled: true,
    bootstrapPeers: [],
  },
});

createExpressAdapter(facilitator, app, "/facilitator");

(async () => {
  await facilitator.p2p?.start();
  console.log("Node A peerId:", facilitator.p2p?.getPeerId());
  console.log("Node A multiaddrs:", facilitator.p2p?.getMultiaddrs());
  app.listen(4101, () => console.log("Node A HTTP on 4101"));
})();
```

```ts
// nodeB.ts
import express from "express";
import { Facilitator, createExpressAdapter } from "x402-open";
import { baseSepolia } from "viem/chains";

const app = express();
app.use(express.json());

const facilitator = new Facilitator({
  evmPrivateKey: process.env.EVM_PRIVATE_KEY as `0x${string}`,
  networks: [baseSepolia],
  decentralized: {
    enabled: true,
    bootstrapPeers: [], // you can paste Node A's multiaddrs here if you have a relay
  },
});

createExpressAdapter(facilitator, app, "/facilitator");

(async () => {
  await facilitator.p2p?.start();
  console.log("Node B peerId:", facilitator.p2p?.getPeerId());
  console.log("Node B multiaddrs:", facilitator.p2p?.getMultiaddrs());
  app.listen(4102, () => console.log("Node B HTTP on 4102"));
})();
```

Notes:
- With no bootstrap, local nodes may not discover each other automatically unless you dial directly (peerId known) or you run a shared bootstrap peer.
- For quick testing of direct RPC, once both nodes start, log `peerId` from the p2p node if you expose it, then from A call `facilitator.p2p?.requestVerify("<peerIdB>", { paymentPayload, paymentRequirements })`.
 - For quick testing of direct RPC, once both nodes start, copy `peerId` lines from logs. Use those as `staticPeers` in a gateway (or to dial directly). If peers run on different machines/processes, also copy one WebSockets/TCP `multiaddr` per node and pass them as `bootstrapPeers` in the gateway's decentralized config so it can discover and dial.

## Optional: add a local bootstrap
You can run an additional libp2p node as a bootstrap and add its multiaddr to `bootstrapPeers` for both nodes. Any public libp2p bootstrap can work as well.

## Troubleshooting
- If streams don’t open, check NAT/firewall and consider enabling circuit relay: `decentralized: { relay: { enabled: true } }`.
- Ensure both nodes advertise or dial WebSockets if running across different processes/machines.
- Use logs to confirm announcements on topic `x402/1.0/announcements`.

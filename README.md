# x402-open

Decentralized facilitator toolkit for the X402 protocol. Anyone can run a facilitator node, or point a gateway at multiple nodes to expose a single public URL.

- `Facilitator`: EVM and Solana (SVM) support
- `createExpressAdapter`: mounts `/supported`, `/verify`, `/settle`
- `createHttpGatewayAdapter`: routes requests across multiple nodes

## Installation

```bash
pnpm add x402-open express viem
# or
npm i x402-open express viem
```

Note: `express` is a peer dependency of this package.

## Quickstart (run a facilitator node)

```ts
import express from "express";
import { Facilitator, createExpressAdapter } from "x402-open";
import { baseSepolia } from "viem/chains";

const app = express();
app.use(express.json());

const facilitator = new Facilitator({
  evmPrivateKey: process.env.EVM_PRIVATE_KEY as `0x${string}`,
  evmNetworks: [baseSepolia],
  // Optional SVM:
  // svmPrivateKey: process.env.SOLANA_PRIVATE_KEY,
  // svmNetworks: ["solana-devnet"],
});

// GET /facilitator/supported, POST /facilitator/verify, POST /facilitator/settle
createExpressAdapter(facilitator, app, "/facilitator");

app.listen(4101, () => console.log("Node HTTP on 4101"));
```

### Node endpoints

Base path: e.g. `/facilitator`.

- GET `<basePath>/supported`
  - Returns `{ kinds: [{ scheme, network, extra? }, ...] }` based on configured networks/keys
- POST `<basePath>/verify`
  - Body: `{ paymentPayload, paymentRequirements }`
  - Forwards the underlying facilitator verification result
- POST `<basePath>/settle`
  - Body: `{ paymentPayload, paymentRequirements }`
  - Returns a settlement object (e.g., `{ txHash, ... }`)

The `paymentPayload` and `paymentRequirements` types come from the `x402` package.

## Run a server with a co-located node

```ts
import express from "express";
import { paymentMiddleware } from "x402-express";
import { Facilitator, createExpressAdapter } from "x402-open";
import { baseSepolia } from "viem/chains";

const app = express();
app.use(express.json());

const facilitator = new Facilitator({
  evmPrivateKey: process.env.PRIVATE_KEY as `0x${string}`,
  evmNetworks: [baseSepolia],
  // svmPrivateKey: process.env.SOLANA_PRIVATE_KEY,
  // svmNetworks: ["solana-devnet"],
});

createExpressAdapter(facilitator, app, "/facilitator");

app.use(paymentMiddleware(
  "0xYourReceivingWallet",
  {
    "GET /weather": { price: "$0.0001", network: "base-sepolia" },
    // or: "GET /weather": { price: "$0.0001", network: "solana-devnet" }
  },
  { url: "http://localhost:4021/facilitator" }
));

app.get("/weather", (_req, res) => {
  res.send({ report: { weather: "sunny", temperature: 70 } });
});

app.listen(4021, () => console.log("Server on http://localhost:4021"));
```

## Gateway (single URL, many nodes)

```ts
import express from "express";
import { createHttpGatewayAdapter } from "x402-open";

const app = express();
app.use(express.json());

createHttpGatewayAdapter(app, {
  basePath: "/facilitator",
  httpPeers: [
    "http://localhost:4101/facilitator",
    "http://localhost:4102/facilitator",
    "http://localhost:4103/facilitator",
  ],
  debug: true,
});

app.listen(8080, () => console.log("HTTP Gateway on http://localhost:8080"));
```

### Gateway behavior

- POST `/facilitator/verify`:
  - Chooses a random node per request; forwards the node’s response body as-is
  - Stores the chosen node keyed by payer (from verify response `payer`, or from `authorization.from`) and by header (fallback)
- POST `/facilitator/settle`:
  - Sends to the same node chosen during verify (sticky by payer/header); falls back to others on error
- GET `/facilitator/supported`:
  - Aggregates kinds across all nodes

## Facilitator configuration

```ts
new Facilitator({
  evmPrivateKey?: `0x${string}`,
  svmPrivateKey?: string,
  evmNetworks?: readonly Chain[],   // EVM chains (via viem), e.g. [baseSepolia]
  svmNetworks?: readonly string[],  // SVM networks, e.g. ["solana-devnet"]
  // Back-compat: 'networks' maps to evmNetworks
})
```

- To support EVM: set `evmPrivateKey` and list `evmNetworks` (e.g., `base-sepolia`)
- To support Solana: set `svmPrivateKey` (and optional `svmRpcUrl`) and list `svmNetworks` (e.g., `"solana-devnet"`)
- `/supported` will only advertise what you configure

## Notes

- Uses `x402` for verification and settlement logic
- Errors return `400 { error }` or `500` for unexpected failures
- Gateway selections are in-memory and expire after ~1 minute

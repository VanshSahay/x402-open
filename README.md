# x402-open

Decentralized facilitator toolkit for the X402 protocol. Run a facilitator node anywhere, or point a gateway at multiple nodes to get a single public URL that verifies and settles payments through the network.

- Facilitator node: EVM + SVM (Solana) support
- Express adapter: mounts `/supported`, `/verify`, `/settle`
- HTTP gateway: routes `verify` and `settle` across many nodes
- Auto-registration: nodes can self-register with the gateway (no manual peer lists)

## Installation

```bash
pnpm add x402-open express viem
# or
npm i x402-open express viem
```

`express` is a peer dependency.

---
## Run a facilitator node

```ts
import express from "express";
import { Facilitator, createExpressAdapter } from "x402-open";
import { baseSepolia } from "viem/chains";

const app = express();
app.use(express.json());

const facilitator = new Facilitator({
  // EVM support
  evmPrivateKey: process.env.PRIVATE_KEY as `0x${string}`,
  evmNetworks: [baseSepolia], // advertise base-sepolia via /supported

  // SVM (Solana) support (optional)
  // svmPrivateKey: process.env.SOLANA_PRIVATE_KEY!,
  // svmNetworks: ["solana-devnet"], // advertise solana-devnet via /supported
});

// Exposes: GET /facilitator/supported, POST /facilitator/verify, POST /facilitator/settle
createExpressAdapter(facilitator, app, "/facilitator");

app.listen(4101, () => console.log("Node HTTP on http://localhost:4101"));
```

### Node endpoints

- `GET /facilitator/supported` → `{ kinds: [{ scheme, network, extra? }, ...] }`
- `POST /facilitator/verify` → body `{ paymentPayload, paymentRequirements }` → returns a verify result (boolean or object depending on underlying X402 impl)
- `POST /facilitator/settle` → body `{ paymentPayload, paymentRequirements }` → returns settlement result (e.g., `{ txHash, ... }`)

The `paymentPayload` and `paymentRequirements` types come from the `x402` package.

---
## Run a server with a co‑located node

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

app.use(
  paymentMiddleware(
    "0xYourReceivingWallet",
    {
      "GET /weather": { price: "$0.0001", network: "base-sepolia" },
      // or: "GET /weather": { price: "$0.0001", network: "solana-devnet" }
    },
    { url: "http://localhost:4021/facilitator" }
  )
);

app.get("/weather", (_req, res) => {
  res.send({ report: { weather: "sunny", temperature: 70 } });
});

app.listen(4021, () => console.log("Server on http://localhost:4021"));
```

---
## Run the HTTP gateway (single URL for many nodes)

```ts
import express from "express";
import { createHttpGatewayAdapter } from "x402-open";

const app = express();
app.use(express.json());

createHttpGatewayAdapter(app, {
  basePath: "/facilitator",
  // Optional static peers; can be empty when using auto-registration
  httpPeers: [
    "http://localhost:4101/facilitator",
    // "http://localhost:4102/facilitator",
    // "http://localhost:4103/facilitator",
  ],
  debug: true,
});

app.listen(8080, () => console.log("HTTP Gateway on http://localhost:8080"));
```

### Gateway behavior

- `POST /facilitator/verify`
  - Selects a random node for each request
  - Forwards the node’s verification response body as‑is
  - Caches the chosen node keyed by payer (from `verify` response `payer`, or from `paymentPayload.payload.authorization.from`) and by header as a fallback (cache TTL ~1 minute)
- `POST /facilitator/settle`
  - Sends to the same node selected during `verify` (sticky by payer/header)
  - Falls back to other nodes if the selected node errors
- `GET /facilitator/supported`
  - Aggregates kinds from all known nodes (static + registered)
- `POST /facilitator/register`
  - For node auto‑registration (see below)

---
## Auto‑register nodes (no manual gateway config)

Nodes can self‑register with one or more gateways so you don’t have to edit `httpPeers`.

```ts
import { startGatewayRegistration } from "x402-open";

// After starting your node at http://localhost:4101/facilitator
const stop = startGatewayRegistration({
  gatewayUrls: ["http://localhost:8080/facilitator"],
  nodeBaseUrl: "http://localhost:4101/facilitator",
  // Optional: include supported kinds in your registration
  kindsProvider: async () => {
    const r = await fetch("http://localhost:4101/facilitator/supported");
    const j = await r.json();
    return j?.kinds ?? [];
  },
  debug: true,
});

// call `stop()` to stop heartbeats
```

The gateway keeps a registry of active nodes, expiring entries without a recent heartbeat (~2 minutes). Static `httpPeers` and registered peers are merged.

You can also register manually by POSTing to the gateway:

```http
POST /facilitator/register
{
  "url": "http://localhost:4101/facilitator",
  "kinds": [{ "scheme": "exact", "network": "base-sepolia" }]
}
```

---
## Facilitator configuration

```ts
new Facilitator({
  // EVM
  evmPrivateKey?: `0x${string}`,
  evmNetworks?: readonly Chain[],     // e.g., [baseSepolia]

  // SVM (Solana)
  svmPrivateKey?: string,
  svmNetworks?: readonly string[],    // e.g., ["solana-devnet"]
})
```

- To support EVM: set `evmPrivateKey` and provide `evmNetworks` (e.g., `base-sepolia`)
- To support Solana: set `svmPrivateKey` and list `svmNetworks` (e.g., `"solana-devnet"`)
- `GET /facilitator/supported` only advertises what you configure

---
## Notes

- Under the hood this package uses `x402` for verification and settlement
- Errors return `400 { error }` or `500` for unexpected failures
- Gateway selections are in‑memory (per process) and expire after ~1 minute

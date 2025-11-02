# x402-open

Core facilitator utilities for building X402 payment facilitators in Node.js/Express.

- Exposes a `Facilitator` class that implements the X402 flow
- Provides `createExpressAdapter` to mount ready-to-use HTTP endpoints
- Works with EVM networks (via `viem/chains`) and optional SVM support

## Installation

```bash
pnpm add x402-open express viem
# or
npm i x402-open express viem
```

Note: `express` is a peer dependency of this package.

## Quickstart (Express)

```ts
import express from "express";
import { Facilitator, createExpressAdapter } from "x402-open";
import { baseSepolia } from "viem/chains";

const app = express();
app.use(express.json());

const facilitator = new Facilitator({
  evmPrivateKey: process.env.EVM_PRIVATE_KEY as `0x${string}`,
  networks: [baseSepolia],
});

// Mounts GET /facilitator/supported, POST /facilitator/verify, POST /facilitator/settle
createExpressAdapter(facilitator, app, "/facilitator");

app.listen(3000, () => {
  console.log("Listening on http://localhost:3000");
});
```

## Endpoints

Mounted base path: your choice (e.g. `"/facilitator"`).

- GET `<basePath>/supported`
  - Returns supported payment kinds based on configured networks/keys.
- POST `<basePath>/verify`
  - Body: `{ paymentPayload, paymentRequirements }`
  - Validates an X402 authorization using `x402` SDK.
- POST `<basePath>/settle`
  - Body: `{ paymentPayload, paymentRequirements }`
  - Settles a payment on-chain using the appropriate signer.

The `paymentPayload` and `paymentRequirements` types are defined in the `x402` package. Refer to the `x402` docs for exact schemas: `https://www.npmjs.com/package/x402`.

## API

### `new Facilitator(config)`

Config:
- `evmPrivateKey?: \`0x${string}\``: Private key for EVM settlements
- `svmPrivateKey?: string`: Private key for SVM settlements (optional)
- `svmRpcUrl?: string`: Custom SVM RPC URL (optional)
- `networks?: readonly Chain[]`: EVM chains (from `viem/chains`) to advertise in `/supported`
 - `decentralized?: { enabled: boolean; bootstrapPeers?: string[]; relay?: { enabled?: boolean }; announceAddrs?: string[]; dataDir?: string; allowlist?: string[] }`

Methods:
- `handleRequest({ method, path, body? })` → `{ status, body }`
  - Low-level handler used by the Express adapter

### `createExpressAdapter(facilitator, routerOrApp, basePath = "")`

- Mounts the three endpoints listed above on an Express `Router` or `App` at `basePath`.

### Gateway (HTTP only)

Expose one URL that behaves like a facilitator and forwards to multiple node URLs.

## SVM (optional)

Provide `svmPrivateKey` (and optionally `svmRpcUrl`) to enable SVM support. Currently, the adapter advertises `solana-devnet` in `/supported` when an SVM key is provided.

## Notes

- This package depends on `x402` under the hood for verification and settlement logic.
- For EVM support in `/supported`, pass the target `viem` chains via the `networks` array.
- On error, endpoints return `400` with `{ error: string }` or `500` for unexpected failures.

See `MULTINODE.md` for a local multi-node example.

If you prefer to route via HTTP, use `createHttpGatewayAdapter` and list node URLs (where their Express adapter is mounted).

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
  ],
  // selection: "headerHash" | "random" (default: headerHash)
});

app.listen(8080, () => console.log("HTTP Gateway on http://localhost:8080"));
```

Mounted endpoints (at basePath):
- GET `/supported` → aggregated kinds
- POST `/verify` → returns boolean
- POST `/settle` → returns node settlement response

## License

ISC

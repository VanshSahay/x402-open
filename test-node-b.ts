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
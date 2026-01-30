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
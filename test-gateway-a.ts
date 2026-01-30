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
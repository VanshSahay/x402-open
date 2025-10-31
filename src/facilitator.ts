import {
  PaymentRequirementsSchema,
  type PaymentRequirements,
  type PaymentPayload,
  PaymentPayloadSchema,
  createConnectedClient,
  createSigner,
  SupportedEVMNetworks,
  SupportedSVMNetworks,
  Signer,
  ConnectedClient,
  SupportedPaymentKind,
  isSvmSignerWallet,
  type X402Config,
} from "x402/types";
import { verify, settle } from "x402/facilitator";
import type { Chain } from "viem/chains";
import type { DecentralizedConfig } from "./p2p.js";
import { P2PManager } from "./p2p.js";

export type FacilitatorConfig = {
  evmPrivateKey?: `0x${string}`;
  svmPrivateKey?: string;
  svmRpcUrl?: string;
  networks?: readonly Chain[];
  decentralized?: DecentralizedConfig;
};

export type HandlerRequest = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
};

export type HandlerResponse<TBody = unknown> = {
  status: number;
  body: TBody;
};

export class Facilitator {
  private readonly evmPrivateKey?: `0x${string}`;
  private readonly svmPrivateKey?: string;
  private readonly svmRpcUrl?: string;
  private readonly networks: readonly Chain[];
  private readonly x402Config: X402Config | undefined;
  public readonly p2p?: {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    requestVerify: (peerId: string, body: unknown, timeoutMs?: number) => Promise<HandlerResponse>;
    requestSettle: (peerId: string, body: unknown, timeoutMs?: number) => Promise<HandlerResponse>;
  };

  constructor(config: FacilitatorConfig) {
    this.evmPrivateKey = config.evmPrivateKey;
    this.svmPrivateKey = config.svmPrivateKey;
    this.svmRpcUrl = config.svmRpcUrl;
    this.networks = config.networks ?? [];
    this.x402Config = this.svmRpcUrl ? { svmConfig: { rpcUrl: this.svmRpcUrl } } : undefined;

    if (config.decentralized?.enabled) {
      const manager = new P2PManager(
        config.decentralized,
        async (req) => this.handleRequest(req),
        async () => this.getSupportedKinds()
      );
      this.p2p = {
        start: () => manager.start(),
        stop: () => manager.stop(),
        requestVerify: async (peerId, body, timeoutMs) => {
          const res = await manager.requestVerify(peerId, { paymentPayload: (body as any)?.paymentPayload, paymentRequirements: (body as any)?.paymentRequirements }, timeoutMs);
          return { status: res.status, body: res.body };
        },
        requestSettle: async (peerId, body, timeoutMs) => {
          const res = await manager.requestSettle(peerId, { paymentPayload: (body as any)?.paymentPayload, paymentRequirements: (body as any)?.paymentRequirements }, timeoutMs);
          return { status: res.status, body: res.body };
        },
      };
    }
  }

  async handleRequest(req: HandlerRequest): Promise<HandlerResponse> {
    try {
      if (req.method === "GET" && req.path === "/supported") {
        const kinds = await this.getSupportedKinds();
        return { status: 200, body: { kinds } };
      }

      if (req.method === "POST" && req.path === "/verify") {
        const { paymentPayload, paymentRequirements } = this.parseBody(req.body);
        const client = await this.getVerifyClient(paymentRequirements);
        const valid = await verify(client, paymentPayload, paymentRequirements, this.x402Config);
        return { status: 200, body: valid };
      }

      if (req.method === "POST" && req.path === "/settle") {
        const { paymentPayload, paymentRequirements } = this.parseBody(req.body);
        const signer = await this.getSettleSigner(paymentRequirements);
        const response = await settle(signer, paymentPayload, paymentRequirements, this.x402Config);
        return { status: 200, body: response };
      }

      return { status: 404, body: { error: "Not Found" } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { status: 400, body: { error: message } };
    }
  }

  private parseBody(body: unknown): { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements } {
    const raw = (body ?? {}) as { paymentPayload?: unknown; paymentRequirements?: unknown };
    const paymentRequirements = PaymentRequirementsSchema.parse(raw.paymentRequirements);
    const paymentPayload = PaymentPayloadSchema.parse(raw.paymentPayload);
    return { paymentPayload, paymentRequirements };
  }

  private async getVerifyClient(paymentRequirements: PaymentRequirements): Promise<Signer | ConnectedClient> {
    if (SupportedEVMNetworks.includes(paymentRequirements.network)) {
      return createConnectedClient(paymentRequirements.network);
    }
    if (SupportedSVMNetworks.includes(paymentRequirements.network)) {
      if (!this.svmPrivateKey) throw new Error("Missing svmPrivateKey for SVM verification");
      return createSigner(paymentRequirements.network, this.svmPrivateKey);
    }
    throw new Error("Invalid network");
  }

  private async getSettleSigner(paymentRequirements: PaymentRequirements): Promise<Signer> {
    if (SupportedEVMNetworks.includes(paymentRequirements.network)) {
      if (!this.evmPrivateKey) throw new Error("Missing evmPrivateKey for EVM settlement");
      return createSigner(paymentRequirements.network, this.evmPrivateKey);
    }
    if (SupportedSVMNetworks.includes(paymentRequirements.network)) {
      if (!this.svmPrivateKey) throw new Error("Missing svmPrivateKey for SVM settlement");
      return createSigner(paymentRequirements.network, this.svmPrivateKey);
    }
    throw new Error("Invalid network");
  }

  private async getSupportedKinds(): Promise<SupportedPaymentKind[]> {
    const kinds: SupportedPaymentKind[] = [];

    if (this.evmPrivateKey && this.networks.length > 0) {
      for (const chain of this.networks) {
        const network = this.getViemChainNetwork(chain) as SupportedPaymentKind["network"];
        kinds.push({ x402Version: 1, scheme: "exact", network });
      }
    }

    if (this.svmPrivateKey) {
      // Default to solana-devnet for now; can be extended to accept SVM networks later
      const signer = await createSigner("solana-devnet", this.svmPrivateKey);
      const feePayer = isSvmSignerWallet(signer) ? signer.address : undefined;
      kinds.push({ x402Version: 1, scheme: "exact", network: "solana-devnet", extra: { feePayer } });
    }

    return kinds;
  }

  private getViemChainNetwork(chain: Chain): string {
    const network = (chain as unknown as { network?: string }).network;
    if (!network) {
      throw new Error("Provided viem Chain is missing the 'network' identifier");
    }
    return network;
  }
}



import type { SupportedPaymentKind } from "x402/types";

export type DecentralizedConfig = {
  enabled: boolean;
  bootstrapPeers?: string[];
  relay?: { enabled?: boolean };
  announceAddrs?: string[];
  dataDir?: string;
  allowlist?: string[];
};

export type P2PRequest = {
  method: "POST" | "GET";
  path: "/verify" | "/settle" | "/supported";
  body?: unknown;
};

export type P2PResponse = { status: number; body: unknown };

type Handler = (req: P2PRequest) => Promise<P2PResponse>;
type SupportedKindsProvider = () => Promise<SupportedPaymentKind[]>;

/**
 * Minimal libp2p manager. Uses dynamic imports to avoid hard dependency
 * during builds when decentralized mode is disabled.
 */
export class P2PManager {
  private readonly conf: DecentralizedConfig;
  private readonly handleRequest: Handler;
  private readonly getSupportedKinds: SupportedKindsProvider;
  private node: any | undefined;

  constructor(conf: DecentralizedConfig, handleRequest: Handler, getSupportedKinds: SupportedKindsProvider) {
    this.conf = conf;
    this.handleRequest = handleRequest;
    this.getSupportedKinds = getSupportedKinds;
  }

  async start(): Promise<void> {
    if (!this.conf.enabled || this.node) return;

    // Dynamic imports (typed as any to avoid compile-time dependency)
    const [{ createLibp2p }, { noise }, { mplex }, { gossipsub }, { kadDHT }, { tcp }, { webSockets }, { identify }, { circuitRelayTransport, circuitRelayServer }, { bootstrap }]: any = await Promise.all([
      import("libp2p"),
      import("@chainsafe/libp2p-noise"),
      import("@libp2p/mplex"),
      import("@chainsafe/libp2p-gossipsub"),
      import("@libp2p/kad-dht"),
      import("@libp2p/tcp"),
      import("@libp2p/websockets"),
      import("@libp2p/identify"),
      import("@libp2p/circuit-relay-v2"),
      import("@libp2p/bootstrap"),
    ]);

    const transports = [tcp(), webSockets()];
    if (this.conf.relay?.enabled) transports.push(circuitRelayTransport());

    const peerDiscovery = this.conf.bootstrapPeers?.length ? [bootstrap({ list: this.conf.bootstrapPeers })] : [];

    const services: any = {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroPeers: true }),
      dht: kadDHT({ clientMode: false }),
    };
    if (this.conf.relay?.enabled) {
      services.relay = circuitRelayServer({ advertise: true });
    }

    this.node = await createLibp2p({
      transports,
      streamMuxers: [mplex()],
      connectionEncryption: [noise()],
      services,
      peerDiscovery,
      addresses: { announce: this.conf.announceAddrs ?? [] },
    });

    // Direct RPC handlers
    this.node.handle("/x402/1.0/verify", this.wrapHandler({ method: "POST", path: "/verify" }));
    this.node.handle("/x402/1.0/settle", this.wrapHandler({ method: "POST", path: "/settle" }));
    this.node.handle("/x402/1.0/health", async ({ stream }: any) => {
      const kinds = await this.getSupportedKinds();
      const payload = JSON.stringify({ ok: true, kinds });
      const writer = stream.sink ? stream : await this.asSink(stream);
      await writer.sink(this.toIterable(payload));
    });

    // Announce capabilities periodically
    const announce = async () => {
      const kinds = await this.getSupportedKinds();
      const msg = JSON.stringify({ version: 1, kinds });
      await this.node.services.pubsub.publish("x402/1.0/announcements", new TextEncoder().encode(msg));
    };
    announce().catch(() => undefined);
    setInterval(() => announce().catch(() => undefined), 60_000);
  }

  async stop(): Promise<void> {
    if (!this.node) return;
    await this.node.stop();
    this.node = undefined;
  }

  // Basic client helpers: dial peerId and open a stream
  async requestVerify(peerId: string, body: unknown, timeoutMs = 10_000): Promise<P2PResponse> {
    return this.sendRequest(peerId, "/x402/1.0/verify", { body });
  }

  async requestSettle(peerId: string, body: unknown, timeoutMs = 30_000): Promise<P2PResponse> {
    return this.sendRequest(peerId, "/x402/1.0/settle", { body });
  }

  private wrapHandler(base: { method: "GET" | "POST"; path: P2PRequest["path"] }) {
    return async ({ stream }: any) => {
      const text = await this.readAll(stream);
      const req = JSON.parse(text || "{}");
      const res = await this.handleRequest({ ...base, body: req?.body });
      const writer = stream.sink ? stream : await this.asSink(stream);
      await writer.sink(this.toIterable(JSON.stringify(res)));
    };
  }

  private async sendRequest(peerId: string, protocol: string, payload: unknown): Promise<P2PResponse> {
    if (!this.node) throw new Error("P2P not started");
    const conn = await this.node.dial(peerId);
    const { stream } = await conn.newStream(protocol);
    const writer = stream.sink ? stream : await this.asSink(stream);
    await writer.sink(this.toIterable(JSON.stringify(payload)));
    const text = await this.readAll(stream);
    return JSON.parse(text || "{}") as P2PResponse;
  }

  private async readAll(stream: any): Promise<string> {
    const decoder = new TextDecoder();
    let out = "";
    for await (const chunk of stream.source) {
      out += decoder.decode(chunk, { stream: true });
    }
    out += decoder.decode();
    return out;
  }

  private toIterable(text: string): AsyncIterable<Uint8Array> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    return (async function* () {
      yield data;
    })();
  }

  private async asSink(stream: any): Promise<any> {
    // Some libp2p versions attach sink/source differently; normalize
    if (stream.sink) return stream;
    if (stream.writer && stream.reader) return stream;
    return stream; // best-effort
  }
}



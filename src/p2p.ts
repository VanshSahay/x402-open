import type { SupportedPaymentKind } from "x402/types";

export type DecentralizedConfig = {
  enabled: boolean;
  bootstrapPeers?: string[];
  relay?: { enabled?: boolean };
  announceAddrs?: string[];
  listenAddrs?: string[];
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
  private readonly announcementHandlers: Array<(peerId: string, kinds: SupportedPaymentKind[]) => void> = [];

  constructor(conf: DecentralizedConfig, handleRequest: Handler, getSupportedKinds: SupportedKindsProvider) {
    this.conf = conf;
    this.handleRequest = handleRequest;
    this.getSupportedKinds = getSupportedKinds;
  }

  async start(): Promise<void> {
    if (!this.conf.enabled || this.node) return;

    // Dynamic imports (typed as any to avoid compile-time dependency)
    const [{ createLibp2p }, { noise }, { mplex }, { gossipsub }, { kadDHT }, { tcp }, { webSockets, filters }, { identify }, { circuitRelayTransport, circuitRelayServer }, { bootstrap }, { ping }]: any = await Promise.all([
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
      import("@libp2p/ping"),
    ]);

    const transports = [
      tcp(),
      // Allow dialing ws to localhost/ip addresses in dev
      webSockets({ filter: filters?.all ?? (() => true) }),
    ];
    if (this.conf.relay?.enabled) transports.push(circuitRelayTransport());

    const peerDiscovery = this.conf.bootstrapPeers?.length ? [bootstrap({ list: this.conf.bootstrapPeers })] : [];

    const services: any = {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroPeers: true }),
      dht: kadDHT({ clientMode: false }),
      ping: ping(),
    };
    if (this.conf.relay?.enabled) {
      services.relay = circuitRelayServer({ advertise: true });
    }

    this.node = await createLibp2p({
      transports,
      streamMuxers: [mplex()],
      connectionEncrypters: [noise()],
      services,
      peerDiscovery,
      addresses: {
        listen: this.conf.listenAddrs ?? [
          "/ip4/127.0.0.1/tcp/0",
          "/ip4/127.0.0.1/tcp/0/ws",
        ],
        announce: this.conf.announceAddrs ?? [],
      },
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

    // Subscribe to announcements from other peers
    try {
      await this.node.services.pubsub.subscribe("x402/1.0/announcements");
      // Best-effort event listener; libp2p/gossipsub event shape varies by version
      this.node.services.pubsub.addEventListener?.("message", async (evt: any) => {
        try {
          const detail = evt?.detail ?? evt; // some versions place data directly
          const topic = detail?.topic ?? detail?.msg?.topic;
          if (topic !== "x402/1.0/announcements") return;
          const from = detail?.from ?? detail?.msg?.from;
          const dataBuf = detail?.data ?? detail?.msg?.data;
          if (!dataBuf) return;
          const text = typeof dataBuf === "string" ? dataBuf : new TextDecoder().decode(dataBuf);
          const parsed = JSON.parse(text || "{}");
          const kinds = Array.isArray(parsed?.kinds) ? parsed.kinds : [];
          const peerId = typeof from?.toString === "function" ? from.toString() : String(from ?? "");
          if (!peerId || kinds.length === 0) return;
          for (const handler of this.announcementHandlers) {
            try {
              handler(peerId, kinds);
            } catch {}
          }
        } catch {}
      });
    } catch {
      // ignore subscription errors; announcements are optional
    }
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

  async requestVerifyByMultiaddr(multiaddr: string, body: unknown, timeoutMs = 10_000): Promise<P2PResponse> {
    return this.sendRequestByMultiaddr(multiaddr, "/x402/1.0/verify", { body });
  }

  async requestSettleByMultiaddr(multiaddr: string, body: unknown, timeoutMs = 30_000): Promise<P2PResponse> {
    return this.sendRequestByMultiaddr(multiaddr, "/x402/1.0/settle", { body });
  }

  async requestHealth(peerId: string): Promise<P2PResponse> {
    return this.sendRequest(peerId, "/x402/1.0/health", {});
  }

  async requestHealthByMultiaddr(multiaddr: string): Promise<P2PResponse> {
    return this.sendRequestByMultiaddr(multiaddr, "/x402/1.0/health", {});
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
    const opened = await conn.newStream(protocol);
    const stream = (opened as any)?.stream ?? opened;
    if (!stream) throw new Error("Failed to open stream");
    const writer = stream.sink ? stream : await this.asSink(stream);
    await writer.sink(this.toIterable(JSON.stringify(payload)));
    const text = await this.readAll(stream);
    return JSON.parse(text || "{}") as P2PResponse;
  }

  private async sendRequestByMultiaddr(multiaddrStr: string, protocol: string, payload: unknown): Promise<P2PResponse> {
    if (!this.node) throw new Error("P2P not started");
    const { multiaddr } = await import("@multiformats/multiaddr");
    const conn = await this.node.dial(multiaddr(multiaddrStr));
    const opened = await conn.newStream(protocol);
    const stream = (opened as any)?.stream ?? opened;
    if (!stream) throw new Error("Failed to open stream");
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

  onAnnouncement(handler: (peerId: string, kinds: SupportedPaymentKind[]) => void): () => void {
    this.announcementHandlers.push(handler);
    return () => {
      const idx = this.announcementHandlers.indexOf(handler);
      if (idx >= 0) this.announcementHandlers.splice(idx, 1);
    };
  }

  getPeerId(): string | undefined {
    // toString is available on modern PeerId
    try {
      const pid = this.node?.peerId;
      if (!pid) return undefined;
      if (typeof pid.toString === "function") return pid.toString();
      return String(pid);
    } catch {
      return undefined;
    }
  }

  getMultiaddrs(): string[] {
    try {
      const addrs = this.node?.getMultiaddrs?.();
      if (!addrs || !Array.isArray(addrs)) return [];
      return addrs.map((ma: any) => (typeof ma?.toString === "function" ? ma.toString() : String(ma)));
    } catch {
      return [];
    }
  }
}



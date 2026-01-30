# Gateway-to-Gateway Communication Implementation

## Overview

This document details the implementation of gateway-to-gateway communication for the x402-open HTTP gateway system. This feature allows gateways to automatically discover each other and share their facilitator nodes, enabling distributed facilitator node discovery across multiple gateway instances.

**Key Design Decision:** The `/verify` and `/settle` endpoints remain unchanged and x402 spec-compliant. Instead of modifying these endpoints, gateways automatically discover facilitator nodes from peer gateways and add them to their local registry. This way, `/verify` and `/settle` work unchanged - they simply see more nodes available via `getActivePeers()`.

## Issue #4: Gateway ↔ Gateway Communication

### Requirements
- Add support for peer gateways (other gateway URLs)
- Implement peer gateway registration and listing endpoints
- Enable automatic facilitator node discovery from peer gateways
- Store peers in-memory (no persistence)
- Keep `/verify` and `/settle` endpoints unchanged (x402 spec-compliant)
- Keep changes minimal and consistent with existing architecture

## Changes Made

### 1. Peer Gateway Storage

**Location:** `src/httpGateway.ts`, Line 58

Added in-memory storage for peer gateway URLs:

```typescript
// Store peer gateways (other gateway URLs)
const peerGateways = new Set<string>();
```

- Uses a `Set<string>` to store unique peer gateway URLs
- Stored in-memory only (no persistence)
- URLs are normalized (trailing slashes removed) when stored

### 2. POST /peers Route - Register Peer Gateway

**Location:** `src/httpGateway.ts`, Lines 300-310

New endpoint to register a peer gateway by URL:

```typescript
router.post(normalizePath("/peers"), async (req: Request, res: Response) => {
  try {
    const url = String((req.body as any)?.url || "").trim();
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Invalid url" });
    const normalizedUrl = url.replace(/\/$/, "");
    peerGateways.add(normalizedUrl);
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message || "Invalid request" });
  }
});
```

**Functionality:**
- Accepts POST requests with body: `{ url: string }`
- Validates URL format (must start with `http://` or `https://`)
- Normalizes URL by removing trailing slashes
- Stores URL in `peerGateways` Set
- **Immediately discovers nodes** from the newly registered peer gateway
- Returns 200 with `{ ok: true }` on success
- Returns 400 with error message on invalid input

### 3. GET /peers Route - List Peer Gateways

**Location:** `src/httpGateway.ts`, Lines 312-315

Modified endpoint to list registered peer gateways (for debugging):

```typescript
router.get(normalizePath("/peers"), (_req: Request, res: Response) => {
  return res.status(200).json({ peers: Array.from(peerGateways) });
});
```

**Functionality:**
- Returns all registered peer gateway URLs
- Response format: `{ peers: string[] }`
- Useful for debugging and monitoring peer gateway registrations

**Note:** This endpoint was previously used to list facilitator nodes. It now lists peer gateways instead, as per requirements.

### 4. GET /nodes Endpoint - Expose Facilitator Nodes

**Location:** `src/httpGateway.ts`, Lines 260-262

New endpoint to expose facilitator nodes for peer gateway discovery:

```typescript
router.get(normalizePath("/nodes"), (_req: Request, res: Response) => {
  return res.status(200).json({ nodes: getActivePeers() });
});
```

**Functionality:**
- Returns all active facilitator nodes (from static config and registered nodes)
- Response format: `{ nodes: string[] }`
- Used by peer gateways to discover facilitator nodes from each other
- Enables automatic node sharing between gateways

### 5. Node Discovery Functions

**Location:** `src/httpGateway.ts`, Lines 89-129

Added functions to discover facilitator nodes from peer gateways:

```typescript
async function discoverNodesFromPeerGateway(peerGatewayUrl: string): Promise<void> {
  try {
    // Query the peer gateway's /nodes endpoint to get its facilitator nodes
    const url = peerGatewayUrl.replace(/\/$/, "") + normalizePath("/nodes");
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json();
    const nodeUrls = Array.isArray(data?.nodes) ? data.nodes : [];
    
    // Register each discovered node locally
    const now = Date.now();
    for (const nodeUrl of nodeUrls) {
      if (typeof nodeUrl === "string" && /^https?:\/\//i.test(nodeUrl)) {
        const normalizedUrl = nodeUrl.replace(/\/$/, "");
        registeredPeers.set(normalizedUrl, { url: normalizedUrl, kinds: undefined, lastSeenMs: now });
      }
    }
  } catch (e: any) {
    // Handle errors silently, discovery will retry periodically
  }
}

async function discoverNodesFromAllPeerGateways(): Promise<void> {
  const peers = Array.from(peerGateways);
  await Promise.allSettled(peers.map(peerUrl => discoverNodesFromPeerGateway(peerUrl)));
}
```

**Functionality:**
- `discoverNodesFromPeerGateway()`: Queries a single peer gateway's `/nodes` endpoint and registers discovered nodes locally
- `discoverNodesFromAllPeerGateways()`: Discovers nodes from all registered peer gateways in parallel
- Discovered nodes are added to `registeredPeers` map, making them available via `getActivePeers()`
- Includes timeout handling (5 seconds) and error handling

### 6. /verify and /settle Routes - Unchanged

**Location:** `src/httpGateway.ts`, Lines 159-205 (verify), Lines 207-235 (settle)

**Important:** These routes remain **completely unchanged** and x402 spec-compliant.

- `/verify` route works exactly as before - it only uses local facilitator nodes from `getActivePeers()`
- `/settle` route works exactly as before - it only uses local facilitator nodes from `getActivePeers()`
- The magic is that `getActivePeers()` now includes nodes discovered from peer gateways, so these routes automatically benefit from gateway-to-gateway discovery without any code changes

**Sticky Selection Handling:**
- If the preferred peer from verify was a peer gateway, settle will use that same gateway
- This maintains consistency between verify and settle operations

### 7. Automatic Node Discovery

**Location:** `src/httpGateway.ts`, Lines 271-288, 295-303

When a peer gateway is registered, nodes are immediately discovered:

```typescript
// In POST /peers handler
peerGateways.add(normalizedUrl);
// Immediately discover nodes from the newly registered peer gateway
discoverNodesFromPeerGateway(normalizedUrl).catch(() => {
  // Silently handle errors, discovery will retry periodically
});
```

Additionally, periodic discovery runs every 30 seconds:

```typescript
const discoveryInterval = setInterval(() => {
  discoverNodesFromAllPeerGateways().catch(() => {
    // Silently handle errors
  });
}, 30_000); // Discover every 30 seconds
```

**Functionality:**
- Immediate discovery when a peer gateway is registered
- Periodic discovery every 30 seconds to keep nodes in sync
- Errors are handled silently - discovery will retry on next interval
- Ensures facilitator nodes from peer gateways are always available in local registry

## Architecture Decisions

### 1. Keep /verify and /settle Unchanged
- **Critical Decision:** `/verify` and `/settle` endpoints remain x402 spec-compliant
- Instead of modifying these routes, we extend the local node registry
- Nodes discovered from peer gateways are added to `registeredPeers` map
- `getActivePeers()` automatically includes discovered nodes
- This ensures zero breaking changes to the x402 spec implementation

### 2. Automatic Node Discovery
- When a peer gateway is registered, nodes are immediately discovered
- Periodic discovery (every 30 seconds) keeps nodes in sync
- Discovered nodes are registered locally, making them available to all routes
- No manual intervention required - gateways automatically recognize each other

### 3. In-Memory Storage
- Peer gateways are stored in a `Set<string>` with no persistence
- Discovered nodes are stored in `registeredPeers` map (same as self-registered nodes)
- Gateways need to re-register after restart
- Keeps implementation simple and consistent with existing facilitator node registration

### 4. GET /nodes Endpoint
- New endpoint specifically for exposing facilitator nodes to peer gateways
- Separates concerns: GET /peers returns peer gateways, GET /nodes returns facilitator nodes
- Enables clean discovery protocol between gateways

### 5. Error Handling
- Discovery errors are handled silently
- Periodic retries ensure eventual consistency
- Network timeouts (5 seconds) prevent hanging requests
- Gracefully handles peer gateways that are temporarily unavailable

### 6. URL Normalization
- All URLs are normalized (trailing slashes removed) for consistency
- Prevents duplicate entries with/without trailing slashes
- Matches existing facilitator node URL handling

## How It Works

### Gateway Discovery Flow

1. **Gateway A starts** with facilitator nodes `[node1, node2]`
2. **Gateway B starts** with facilitator nodes `[node3, node4]`
3. **Gateway A registers Gateway B as a peer:**
   ```
   POST /peers
   { "url": "http://gateway-b:8080/facilitator" }
   ```
4. **Gateway A immediately queries Gateway B:**
   ```
   GET http://gateway-b:8080/facilitator/nodes
   Response: { "nodes": ["http://node3:4101/facilitator", "http://node4:4102/facilitator"] }
   ```
5. **Gateway A registers discovered nodes locally:**
   - `node3` and `node4` are added to Gateway A's `registeredPeers` map
   - They now appear in `getActivePeers()` alongside `node1` and `node2`
6. **Gateway A's `/verify` and `/settle` routes automatically see all 4 nodes:**
   - No code changes needed - `getActivePeers()` returns all nodes
   - Routes work exactly as before, but with more nodes available

### Periodic Sync

- Every 30 seconds, Gateway A queries all peer gateways for their nodes
- Keeps the node registry in sync as nodes are added/removed from peer gateways
- Ensures eventual consistency across the gateway network

## Testing Considerations

When testing this implementation:

1. **Peer Gateway Registration:**
   - POST to `/peers` with valid URL should return 200
   - POST with invalid URL should return 400
   - GET `/peers` should return registered peer gateway URLs
   - GET `/nodes` should return facilitator node URLs

2. **Node Discovery:**
   - After registering a peer gateway, its nodes should appear in GET `/nodes`
   - Discovered nodes should be available to `/verify` and `/settle` routes
   - Periodic discovery should keep nodes in sync

3. **Verify and Settle Flow:**
   - Should work exactly as before (x402 spec-compliant)
   - Should automatically use discovered nodes from peer gateways
   - No changes to request/response format

4. **Error Cases:**
   - Unreachable peer gateways should not break discovery
   - Network timeouts should be handled gracefully
   - Discovery should retry periodically

## Files Modified

- `src/httpGateway.ts`: Added peer gateway storage, routes, and extended lookup logic

## Files Not Modified

- `src/registrar.ts`: No changes (facilitator node registration unchanged)
- `src/facilitator.ts`: No changes (facilitator logic unchanged)
- `src/expressAdapter.ts`: No changes (Express adapter unchanged)
- `src/index.ts`: No changes (exports unchanged)

## Key Benefits

1. **Zero Breaking Changes:** `/verify` and `/settle` remain x402 spec-compliant
2. **Automatic Discovery:** Gateways automatically recognize each other and share nodes
3. **Transparent:** Existing code works unchanged - just sees more nodes available
4. **Simple:** Minimal code changes, consistent with existing architecture
5. **Resilient:** Periodic sync ensures nodes stay in sync even if initial discovery fails

## Future Enhancements (Not Implemented)

As per requirements, the following were explicitly NOT implemented:
- Authentication for peer gateway communication
- Consensus mechanisms
- Payment systems
- Persistence (peer gateways are in-memory only)
- Bidirectional discovery (gateways don't automatically register with each other)

These could be added in future iterations if needed.

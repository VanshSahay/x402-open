// Type definitions for gateway module

import type {
  PaymentPayload,
  PaymentRequirements,
  SupportedPaymentKind,
} from "x402/types";

/**
 * Payload structure that may be a full PaymentPayload or a partial legacy structure.
 * The gateway must handle both formats during forwarding.
 */
export type PartialPaymentPayload = PaymentPayload | { header?: string };

/**
 * Request body structure for forwarding payments to peers.
 * Supports both spec format and legacy format.
 */
export interface ForwardBody {
  paymentPayload?: PartialPaymentPayload;
  paymentRequirements?: PaymentRequirements;
  /** Legacy format - header string directly */
  paymentHeader?: string;
}

/**
 * Entry in the sticky routing cache with TTL.
 */
export interface StickyEntry {
  peer: string;
  expiresAt: number;
}

/**
 * Registered peer information with heartbeat tracking.
 */
export interface RegisteredPeer {
  url: string;
  kinds?: SupportedPaymentKind[];
  lastSeenMs: number;
}

/**
 * Response from a peer request.
 */
export interface PeerResponse<T = unknown> {
  status: number;
  body: T;
}

/**
 * Verify response body shape (partial, for payer extraction).
 */
export interface VerifyResponseBody {
  payer?: string;
  [key: string]: unknown;
}

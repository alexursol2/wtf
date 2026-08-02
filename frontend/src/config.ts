/**
 * Deployment wiring.
 *
 * Addresses come from the deploy scripts, which write ../deployments/*.json.
 * Override any of them with a Vite env var so the demo can point at a fresh
 * testnet deployment without a rebuild:
 *
 *   VITE_VENUE=0x...  VITE_CHAIN_ID=11155111  npm run dev
 */

/** NoxCompute, hardcoded per chain in the Nox SDK. Not configurable there, so not here. */
export const NOX_COMPUTE: Record<number, string> = {
  31337: "0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685",
  421614: "0xd464B198f06756a1d00be223634b85E0a731c229",
  11155111: "0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF",
};

export const CHAIN_NAMES: Record<number, string> = {
  31337: "Hardhat local",
  421614: "Arbitrum Sepolia",
  11155111: "Ethereum Sepolia",
};

const env = import.meta.env as Record<string, string | undefined>;

export const CONFIG = {
  venue: env.VITE_VENUE ?? "",
  sharesWrapper: env.VITE_SHARES_WRAPPER ?? "",
  cashWrapper: env.VITE_CASH_WRAPPER ?? "",
  expectedChainId: env.VITE_CHAIN_ID ? Number(env.VITE_CHAIN_ID) : undefined,
};

export enum OrderState {
  Open = 0,
  PendingResolution = 1,
  Cancelled = 2,
}

export const ORDER_STATE_LABEL: Record<number, string> = {
  [OrderState.Open]: "open",
  [OrderState.PendingResolution]: "pending resolution",
  [OrderState.Cancelled]: "cancelled",
};

export enum Bucket {
  Standard = 0,
  LargeInScale = 1,
}

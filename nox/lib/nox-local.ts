/**
 * Local Nox test harness.
 *
 * The Nox SDK resolves NoxCompute from a HARDCODED per-chain address —
 * 0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685 on chainid 31337. The official
 * local stack ships that address via a Docker-based Hardhat plugin. This helper
 * reproduces the on-chain half without Docker: it deploys NoxCompute from the
 * package's own shipped artifact, copies the runtime bytecode to the hardcoded
 * address with hardhat_setCode, and initialises it there.
 *
 * That works because NoxCompute's constructor only calls _disableInitializers()
 * (which setCode does not replay) and OZ's EIP712 rebuilds its domain separator
 * whenever address(this) differs from the cached deploy address — so the
 * verifyingContract in signatures is correctly the hardcoded address.
 *
 * WHAT THIS HARNESS CAN AND CANNOT TEST — read before trusting a green run.
 *
 * CAN: that every transaction executes, that handles are produced, and above
 * all that ACL GRANTS LAND. Missed grants are the single most likely bug in a
 * Nox project (a dead handle looks exactly like async lag from the frontend),
 * and isAllowed/isViewer/isPubliclyDecryptable are readable on-chain, so this
 * is checkable here and worth checking.
 *
 * CANNOT: assert decrypted VALUES. Computation is TEE-async — NoxCompute emits
 * an event, an off-chain Ingestor and Runner decrypt inside Intel TDX, compute,
 * re-encrypt and store. No Runner runs here, so no value ever materialises.
 * Balance-correctness assertions require the real stack (Docker locally, or
 * testnet). Do not read a green suite as proof the arithmetic is right.
 */
import { network } from "hardhat";
import { createRequire } from "node:module";
import { keccak256, toHex, concatHex, pad, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const require = createRequire(import.meta.url);

/** Hardcoded in Nox.sol for chainid 31337. Not configurable. */
export const NOX_COMPUTE_LOCAL = "0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685" as const;

/** Hardhat account #9 key — stands in for the Nox gateway signer. */
export const GATEWAY_PK = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" as const;

/** TEEType enum values from utils/TypeUtils.sol. */
export const TEEType = { Bool: 0, Uint256: 35 } as const;

const HANDLE_PROOF_TYPEHASH = keccak256(
  toHex("HandleProof(bytes32 handle,address owner,address app,uint256 createdAt)"),
);
const DECRYPTION_PROOF_TYPEHASH = keccak256(
  toHex("DecryptionProof(bytes32 handle,bytes decryptedResult)"),
);

/**
 * Builds a handle in the exact layout NoxCompute validates (HandleUtils.sol):
 *   [0]=version(0x00) [1-4]=chainId [5]=teeType [6]=attrs [7-31]=payload
 * attrs bit0 (ATTR_IS_UNIQUE_HANDLE) MUST be set, otherwise the handle counts
 * as "public", bypasses all ACL, and every allow/addViewer call silently skips.
 */
export function buildHandle(chainId: number, teeType: number, salt: number): Hex {
  const bytes = new Uint8Array(32);
  bytes[0] = 0x00;
  bytes[1] = (chainId >>> 24) & 0xff;
  bytes[2] = (chainId >>> 16) & 0xff;
  bytes[3] = (chainId >>> 8) & 0xff;
  bytes[4] = chainId & 0xff;
  bytes[5] = teeType;
  bytes[6] = 0x01; // private handle, ACL applies
  // payload — arbitrary but must be unique per input handle
  bytes[7] = (salt >>> 8) & 0xff;
  bytes[8] = salt & 0xff;
  bytes[9] = 0xab;
  return toHex(bytes);
}

export async function connect() {
  // Must be the "hardhat" entry explicitly: it is the one pinned to chainId
  // 31337 (the id Nox.sol maps to a local NoxCompute) and the one with
  // allowUnlimitedContractSize. Hardhat 3 would otherwise pick its own
  // built-in simulated network.
  const { viem, networkHelpers, provider } = await network.connect({ network: "hardhat" });
  return { viem, networkHelpers, provider };
}

/**
 * Deploys NoxCompute and installs it at the SDK's hardcoded local address.
 * Returns the gateway account used to sign proofs.
 */
export async function bootstrapNoxCompute(viem: any, provider: any) {
  const artifact = require("@iexec-nox/nox-protocol-contracts/artifacts/contracts/NoxCompute.sol/NoxCompute.json");
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  // 1. Deploy normally to obtain compiled runtime bytecode.
  const hash = await deployer.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as Hex,
    args: [],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const tempAddress = receipt.contractAddress!;
  const runtimeCode = await publicClient.getCode({ address: tempAddress });

  // 2. Install that code at the address the SDK will call.
  await provider.request({
    method: "hardhat_setCode",
    params: [NOX_COMPUTE_LOCAL, runtimeCode],
  });

  // 3. Initialise in place. The constructor's _disableInitializers() was not
  //    replayed by setCode, so the initializer is still available here.
  const gateway = privateKeyToAccount(GATEWAY_PK);

  await deployer.writeContract({
    address: NOX_COMPUTE_LOCAL as Hex,
    abi: artifact.abi,
    functionName: "initialize",
    args: [
      deployer.account.address, // admin
      deployer.account.address, // upgrader
      "0xdeadbeef", // kmsPublicKey — only required to be non-empty on-chain
      gateway.address, // gateway: the signer whose EIP-712 proofs are accepted
    ],
  });

  return { gateway, abi: artifact.abi, publicClient, deployer };
}

/** EIP-712 domain for NoxCompute at the hardcoded local address. */
function domain(chainId: number) {
  return {
    name: "NoxCompute",
    version: "1",
    chainId,
    verifyingContract: NOX_COMPUTE_LOCAL as Hex,
  };
}

/**
 * Forges the 137-byte input proof NoxCompute expects:
 *   owner(20) ++ app(20) ++ createdAt(32) ++ gatewaySignature(65)
 * `app` must equal the CONTRACT that calls fromExternal (msg.sender there),
 * not the user — a mismatch reverts with "App mismatch".
 */
export async function makeInputProof(opts: {
  gateway: ReturnType<typeof privateKeyToAccount>;
  chainId: number;
  handle: Hex;
  owner: Hex;
  app: Hex;
  createdAt?: bigint;
}): Promise<Hex> {
  const createdAt = opts.createdAt ?? BigInt(Math.floor(Date.now() / 1000));

  const signature = await opts.gateway.signTypedData({
    domain: domain(opts.chainId),
    types: {
      HandleProof: [
        { name: "handle", type: "bytes32" },
        { name: "owner", type: "address" },
        { name: "app", type: "address" },
        { name: "createdAt", type: "uint256" },
      ],
    },
    primaryType: "HandleProof",
    message: { handle: opts.handle, owner: opts.owner, app: opts.app, createdAt },
  });

  return concatHex([opts.owner, opts.app, pad(toHex(createdAt), { size: 32 }), signature]);
}

/**
 * Forges a decryption proof: gatewaySignature(65) ++ decryptedResult(n).
 * Used to test the wrapper's claimUnwrap, which releases the underlying only
 * against a proof that the encrypted lock actually succeeded.
 */
export async function makeDecryptionProof(opts: {
  gateway: ReturnType<typeof privateKeyToAccount>;
  chainId: number;
  handle: Hex;
  decryptedResult: Hex;
}): Promise<Hex> {
  const signature = await opts.gateway.signTypedData({
    domain: domain(opts.chainId),
    types: {
      DecryptionProof: [
        { name: "handle", type: "bytes32" },
        { name: "decryptedResult", type: "bytes" },
      ],
    },
    primaryType: "DecryptionProof",
    message: { handle: opts.handle, decryptedResult: opts.decryptedResult },
  });
  return concatHex([signature, opts.decryptedResult]);
}

export { DECRYPTION_PROOF_TYPEHASH, HANDLE_PROOF_TYPEHASH };

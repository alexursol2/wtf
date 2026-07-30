/**
 * Test-facing re-export of the local Nox harness.
 *
 * The implementation lives in ../../lib/nox-local.ts because the deploy script
 * needs the same bootstrap to stand up a demo chain — a deploy script should
 * not import from test/.
 *
 * WHAT THE HARNESS CAN AND CANNOT PROVE — read before trusting a green run.
 *
 * CAN: that every transaction executes, that handles are produced, and above
 * all that ACL GRANTS LAND. A missed grant is the single most likely bug in a
 * Nox project — a dead handle looks exactly like async lag from the frontend —
 * and isAllowed/isViewer/isPubliclyDecryptable are readable on-chain, so it is
 * checkable here and worth checking.
 *
 * CANNOT: assert decrypted VALUES. Computation is TEE-async: NoxCompute emits
 * an event, an off-chain Ingestor and Runner decrypt inside Intel TDX, compute,
 * re-encrypt and store. No Runner runs locally, so no value ever materialises.
 * Balance-correctness requires the real stack (Docker locally, or testnet).
 * Do not read a green suite as proof the arithmetic is right.
 */
export {
  connect,
  bootstrapNoxCompute,
  makeInputProof,
  makeDecryptionProof,
  buildHandle,
  NOX_COMPUTE_LOCAL,
  GATEWAY_PK,
  TEEType,
} from "../../lib/nox-local.js";

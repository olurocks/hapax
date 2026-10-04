// Server-side check for owner-signed requests (see api.ts).
import type { Address } from "viem";
import { creditFacilityAbi } from "./abis.ts";
import { OWNER_REQUEST_MAX_AGE_S, ownerMessage, type OwnerAction, type SignedOwnerRequest } from "./api.ts";
import { publicClient } from "./env.ts";

/** Throws unless the request is fresh, for the expected action, and signed by the facility's onchain owner. */
export async function verifyOwnerRequest(req: SignedOwnerRequest, action: OwnerAction): Promise<Address> {
  if (req.action !== action) throw new Error(`Expected a ${action} request`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(req.facility ?? "")) throw new Error("Invalid facility address");
  const age = Math.floor(Date.now() / 1000) - Number(req.issuedAt);
  if (!(age >= -60 && age <= OWNER_REQUEST_MAX_AGE_S)) throw new Error("Request expired; sign it again");
  const owner = (await publicClient.readContract({
    address: req.facility,
    abi: creditFacilityAbi,
    functionName: "owner",
  })) as Address;
  const ok = await publicClient.verifyMessage({
    address: owner,
    message: ownerMessage(req),
    signature: req.signature,
  });
  if (!ok) throw new Error("Signature is not from the facility owner");
  return owner;
}

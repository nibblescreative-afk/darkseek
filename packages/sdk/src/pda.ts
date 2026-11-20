import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { ASSOCIATED_TOKEN_PROGRAM_ID, BPF_LOADER_UPGRADEABLE_ID, PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants.js';

const find = (seeds: (Buffer | Uint8Array)[], programId: PublicKey) => PublicKey.findProgramAddressSync(seeds, programId)[0];

/** Program derived addresses of the vault program. Pass `programId` for a deployment under another id. */
export const pda = {
  config: (programId = PROGRAM_ID) => find([Buffer.from('config')], programId),
  custody: (programId = PROGRAM_ID) => find([Buffer.from('custody')], programId),
  dsCustody: (programId = PROGRAM_ID) => find([Buffer.from('ds_custody')], programId),
  vault: (owner: PublicKey, programId = PROGRAM_ID) => find([Buffer.from('vault'), owner.toBuffer()], programId),
  room: (index: number, programId = PROGRAM_ID) => find([Buffer.from('room'), Buffer.from([index])], programId),
  vesting: (mint: PublicKey, beneficiary: PublicKey, id: bigint, programId = PROGRAM_ID) => {
    const le = Buffer.alloc(8);
    le.writeBigUInt64LE(id);
    return find([Buffer.from('vesting'), mint.toBuffer(), beneficiary.toBuffer(), le], programId);
  },
  vestingTokens: (vesting: PublicKey, programId = PROGRAM_ID) => find([Buffer.from('vesting_tokens'), vesting.toBuffer()], programId),
  /** where the upgradeable loader keeps the program's bytes and upgrade authority */
  programData: (programId = PROGRAM_ID) => find([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_ID),
};

/** The associated token account of `owner` for `mint`. */
export function ata(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID): PublicKey {
  return find([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
}

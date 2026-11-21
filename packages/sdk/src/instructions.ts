// Instruction builders for every handler of the vault program. Account order
// follows programs/darkseek-vault/src/contexts.rs exactly.

import { SystemProgram, TransactionInstruction, type AccountMeta, type PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { discriminator, encode } from './codec.js';
import { PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants.js';
import { INSTRUCTION_ARGS, type InstructionName } from './layouts.js';
import { ata, pda } from './pda.js';
import type { FeeSplit } from './accounts.js';

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

export const INSTRUCTION_DISCRIMINATORS = Object.fromEntries(
  (Object.keys(INSTRUCTION_ARGS) as InstructionName[]).map((n) => [n, discriminator('global', n)]),
) as Record<InstructionName, Buffer>;

export interface InitArgs {
  authority: PublicKey;
  /** [casual Hider, casual Seeker, pro Hider, pro Seeker] in base units */
  stakes: [bigint, bigint, bigint, bigint];
  feeBps: number;
  split: FeeSplit;
}

export interface DsArgs {
  /** $DS base units per whole USDC until the first fill */
  genesisPrice: bigint;
  floorPrice: bigint;
  /** seconds from the start price to the floor */
  duration: bigint;
  /** most USDC per fill (base units) */
  lot: bigint;
  /** least USDC per fill (base units), unless a fill takes all that is on offer */
  minFill: bigint;
  /** USDC the first buyback round spends (base units): half the USDC value of the launch buy */
  buybackTarget: bigint;
}

/** Builds instructions for one deployment of the program. */
export class VaultInstructions {
  constructor(readonly programId: PublicKey = PROGRAM_ID) {}

  private ix(name: InstructionName, keys: AccountMeta[], args: Record<string, unknown> = {}): TransactionInstruction {
    const data = Buffer.concat([INSTRUCTION_DISCRIMINATORS[name], encode({ struct: INSTRUCTION_ARGS[name] }, args)]);
    return new TransactionInstruction({ programId: this.programId, keys, data });
  }

  private get config() {
    return pda.config(this.programId);
  }
  private vault(owner: PublicKey) {
    return pda.vault(owner, this.programId);
  }
  private room(index: number) {
    return pda.room(index, this.programId);
  }

  // ---------------------------------------------------------------- admin
  initialize(admin: PublicKey, mint: PublicKey, args: InitArgs) {
    return this.ix(
      'initialize',
      [w(admin, true), w(this.config), r(mint), w(pda.custody(this.programId)), r(this.programId), r(pda.programData(this.programId)), r(TOKEN_PROGRAM_ID), r(SystemProgram.programId)],
      { args },
    );
  }
  setAuthority(admin: PublicKey, authority: PublicKey) {
    return this.ix('set_authority', [r(admin, true), w(this.config)], { authority });
  }
  proposeAdmin(admin: PublicKey, pendingAdmin: PublicKey) {
    return this.ix('propose_admin', [r(admin, true), w(this.config)], { pendingAdmin });
  }
  acceptAdmin(pendingAdmin: PublicKey) {
    return this.ix('accept_admin', [r(pendingAdmin, true), w(this.config)]);
  }
  initRoom(admin: PublicKey, index: number, tier: number) {
    return this.ix('init_room', [w(admin, true), r(this.config), w(this.room(index)), r(SystemProgram.programId)], { index, tier });
  }
  /** `dsTokenProgram`: SPL Token or Token 2022, whichever owns the $DS mint. */
  initDs(admin: PublicKey, dsMint: PublicKey, args: DsArgs, dsTokenProgram = TOKEN_PROGRAM_ID) {
    return this.ix('init_ds', [w(admin, true), w(this.config), r(dsMint), w(pda.dsCustody(this.programId)), r(dsTokenProgram), r(SystemProgram.programId)], { args });
  }
  sweepTreasury(admin: PublicKey, mint: PublicKey, to: PublicKey, amount: bigint) {
    return this.ix('sweep_treasury', [r(admin, true), w(this.config), r(mint), w(pda.custody(this.programId)), w(to), r(TOKEN_PROGRAM_ID)], { amount });
  }

  // ---------------------------------------------------------------- players
  openVault(payer: PublicKey, owner: PublicKey) {
    return this.ix('open_vault', [w(payer, true), r(owner), w(this.vault(owner)), r(SystemProgram.programId)]);
  }
  setSession(owner: PublicKey, dailyCap: bigint, expiresAt: bigint) {
    return this.ix('set_session', [r(owner, true), w(this.vault(owner))], { dailyCap, expiresAt });
  }
  /** USDC from `from` (a token account `depositor` owns) into `vaultOwner`'s vault. */
  deposit(depositor: PublicKey, mint: PublicKey, vaultOwner: PublicKey, amount: bigint, from = ata(depositor, mint)) {
    return this.ix('deposit', [r(depositor, true), r(this.config), r(mint), w(pda.custody(this.programId)), w(from), w(this.vault(vaultOwner)), r(TOKEN_PROGRAM_ID)], { amount });
  }
  withdraw(owner: PublicKey, mint: PublicKey, amount: bigint, to = ata(owner, mint)) {
    return this.ix('withdraw', [r(owner, true), r(this.config), r(mint), w(pda.custody(this.programId)), w(to), w(this.vault(owner)), r(TOKEN_PROGRAM_ID)], { amount });
  }
  charge(owner: PublicKey, amount: bigint) {
    return this.ix('charge', [r(owner, true), w(this.config), w(this.vault(owner))], { amount });
  }
  pay(owner: PublicKey, to: PublicKey, amount: bigint) {
    return this.ix('pay', [r(owner, true), w(this.vault(owner)), w(this.vault(to))], { amount });
  }

  // ---------------------------------------------------------------- rooms (game server)
  lockStake(authority: PublicKey, room: number, owner: PublicKey, round: bigint, slot: number) {
    return this.ix('lock_stake', [r(authority, true), r(this.config), w(this.room(room)), w(this.vault(owner))], { round, slot });
  }
  unlockStake(authority: PublicKey, room: number, owner: PublicKey, round: bigint, slot: number) {
    return this.ix('unlock_stake', [r(authority, true), r(this.config), w(this.room(room)), w(this.vault(owner))], { round, slot });
  }
  /** The seat's owner leaves an open lobby on their own, once it has formed for LEAVE_AFTER_SECS (v0.4.0). */
  leaveSeat(owner: PublicKey, room: number, round: bigint, slot: number) {
    return this.ix('leave_seat', [r(owner, true), w(this.vault(owner)), w(this.room(room))], { round, slot });
  }
  startRound(authority: PublicKey, room: number, round: bigint) {
    return this.ix('start_round', [r(authority, true), w(this.config), w(this.room(room))], { round });
  }
  /** `seated`: the ten wallets in slot order. `outcomes[i]` is Hider slot 2 + i: SURVIVED or the Seeker slot that caught it. */
  settleRound(authority: PublicKey, room: number, round: bigint, outcomes: number[], seated: PublicKey[]) {
    return this.ix('settle_round', [r(authority, true), w(this.config), w(this.room(room)), ...seated.map((o) => w(this.vault(o)))], { round, outcomes });
  }
  /** `seated`: the wallets in occupied seats, in slot order. */
  cancelRound(authority: PublicKey, room: number, round: bigint, seated: PublicKey[]) {
    return this.ix('cancel_round', [r(authority, true), w(this.config), w(this.room(room)), ...seated.map((o) => w(this.vault(o)))], { round });
  }
  abortStaleRound(caller: PublicKey, room: number, round: bigint, seated: PublicKey[]) {
    return this.ix('abort_stale_round', [r(caller, true), w(this.config), w(this.room(room)), ...seated.map((o) => w(this.vault(o)))], { round });
  }

  // ---------------------------------------------------------------- $DS
  // `dsTokenProgram`: the token program of the $DS mint (config.dsTokenProgram).
  depositDs(depositor: PublicKey, dsMint: PublicKey, vaultOwner: PublicKey, amount: bigint, dsTokenProgram = TOKEN_PROGRAM_ID, from = ata(depositor, dsMint, dsTokenProgram)) {
    return this.ix(
      'deposit_ds',
      [r(depositor, true), r(this.config), r(dsMint), w(pda.dsCustody(this.programId)), w(from), w(this.vault(vaultOwner)), r(dsTokenProgram)],
      { amount },
    );
  }
  withdrawDs(owner: PublicKey, dsMint: PublicKey, amount: bigint, dsTokenProgram = TOKEN_PROGRAM_ID, to = ata(owner, dsMint, dsTokenProgram)) {
    return this.ix('withdraw_ds', [r(owner, true), r(this.config), r(dsMint), w(pda.dsCustody(this.programId)), w(to), w(this.vault(owner)), r(dsTokenProgram)], { amount });
  }
  stakeDs(owner: PublicKey, amount: bigint) {
    return this.ix('stake_ds', [r(owner, true), w(this.config), w(this.vault(owner))], { amount });
  }
  unstakeDs(owner: PublicKey, amount: bigint) {
    return this.ix('unstake_ds', [r(owner, true), w(this.config), w(this.vault(owner))], { amount });
  }
  claimRewards(owner: PublicKey) {
    return this.ix('claim_rewards', [w(this.config), w(this.vault(owner))]);
  }
  /** Turns the vault's rebate credit into $DS from the reserve. Anyone may send it. */
  claimRebate(owner: PublicKey) {
    return this.ix('claim_rebate', [w(this.config), w(this.vault(owner))]);
  }
  /** Sells up to `maxDs` $DS for at least `minUsdc`, at the current auction price. */
  sellDs(
    seller: PublicKey,
    mint: PublicKey,
    dsMint: PublicKey,
    maxDs: bigint,
    minUsdc: bigint,
    dsTokenProgram = TOKEN_PROGRAM_ID,
    sellerDs = ata(seller, dsMint, dsTokenProgram),
    sellerUsdc = ata(seller, mint),
  ) {
    return this.ix(
      'sell_ds',
      [
        r(seller, true),
        w(this.config),
        r(mint),
        w(pda.custody(this.programId)),
        w(dsMint),
        w(pda.dsCustody(this.programId)),
        w(sellerDs),
        w(sellerUsdc),
        r(TOKEN_PROGRAM_ID),
        r(dsTokenProgram),
      ],
      { maxDs, minUsdc },
    );
  }

  // ---------------------------------------------------------------- token locks
  // `tokenProgram`: the token program of `mint` (SPL Token or Token 2022).
  createVesting(
    funder: PublicKey,
    beneficiary: PublicKey,
    mint: PublicKey,
    p: { id: bigint; total: bigint; start: bigint; cliff: bigint; end: bigint },
    tokenProgram = TOKEN_PROGRAM_ID,
    from = ata(funder, mint, tokenProgram),
  ) {
    const vesting = pda.vesting(mint, beneficiary, p.id, this.programId);
    return this.ix(
      'create_vesting',
      [w(funder, true), r(beneficiary), r(mint), w(vesting), w(pda.vestingTokens(vesting, this.programId)), w(from), r(tokenProgram), r(SystemProgram.programId)],
      p,
    );
  }
  claimVesting(mint: PublicKey, beneficiary: PublicKey, id: bigint, tokenProgram = TOKEN_PROGRAM_ID, to = ata(beneficiary, mint, tokenProgram)) {
    const vesting = pda.vesting(mint, beneficiary, id, this.programId);
    return this.ix('claim_vesting', [w(vesting), r(mint), w(pda.vestingTokens(vesting, this.programId)), w(to), r(tokenProgram)]);
  }
}

/** Builders for the program at its declared id. */
export const ixs = new VaultInstructions();

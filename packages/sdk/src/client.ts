// Read only access to one deployment: decoded accounts and the auction quote.

import type { Commitment, Connection, PublicKey } from '@solana/web3.js';
import { decodeConfig, decodeRoom, decodeVault, decodeVesting, type ConfigAccount, type RoomAccount, type VaultAccount, type VestingAccount } from './accounts.js';
import { PROGRAM_ID, ROOMS } from './constants.js';
import { pda } from './pda.js';
import { auctionFill, auctionPrice, buybackAvailable, rebateClaim, type Fill } from './rules.js';
import { decodeMint, decodeTokenAccount, type MintInfo } from './spl.js';
import { VaultInstructions } from './instructions.js';

export class DarkSeekReader {
  readonly ix: VaultInstructions;

  constructor(
    readonly conn: Connection,
    readonly programId: PublicKey = PROGRAM_ID,
    readonly commitment: Commitment = 'confirmed',
  ) {
    this.ix = new VaultInstructions(programId);
  }

  async config(): Promise<ConfigAccount> {
    const info = await this.conn.getAccountInfo(pda.config(this.programId), this.commitment);
    if (!info) throw new Error('the program is not initialized on this cluster');
    return decodeConfig(info.data);
  }

  async vault(owner: PublicKey): Promise<VaultAccount | null> {
    const info = await this.conn.getAccountInfo(pda.vault(owner, this.programId), this.commitment);
    return info ? decodeVault(info.data) : null;
  }

  async room(index: number): Promise<RoomAccount | null> {
    const info = await this.conn.getAccountInfo(pda.room(index, this.programId), this.commitment);
    return info ? decodeRoom(info.data) : null;
  }

  async rooms(): Promise<RoomAccount[]> {
    const infos = await this.conn.getMultipleAccountsInfo(
      Array.from({ length: ROOMS }, (_, i) => pda.room(i + 1, this.programId)),
      this.commitment,
    );
    return infos.flatMap((i) => (i ? [decodeRoom(i.data)] : []));
  }

  async vesting(mint: PublicKey, beneficiary: PublicKey, id: bigint): Promise<VestingAccount | null> {
    const info = await this.conn.getAccountInfo(pda.vesting(mint, beneficiary, id, this.programId), this.commitment);
    return info ? decodeVesting(info.data) : null;
  }

  async tokenBalance(account: PublicKey): Promise<bigint> {
    const info = await this.conn.getAccountInfo(account, this.commitment);
    return info ? decodeTokenAccount(info.data).amount : 0n;
  }

  async mint(mint: PublicKey): Promise<MintInfo | null> {
    const info = await this.conn.getAccountInfo(mint, this.commitment);
    return info ? decodeMint(info.data, info.owner) : null;
  }

  /** What selling up to `maxDs` would pay right now (null: nothing on offer, or below the minimum fill). */
  async quote(maxDs: bigint, now = BigInt(Math.floor(Date.now() / 1000))): Promise<{ price: bigint; fill: Fill | null; buybackOpen: boolean }> {
    const c = await this.config();
    const price = auctionPrice(c.auction, now);
    const buyback = buybackAvailable(c.buybackPool, c.buybackTarget, c.buybackRoundLeft);
    const onOffer = buyback + c.rebatePool < c.auction.lot ? buyback + c.rebatePool : c.auction.lot;
    const fill = auctionFill(price, maxDs, buyback, c.rebatePool, c.auction.lot, 10n ** BigInt(c.decimals));
    return { price, fill: fill && (fill.usdc >= c.auction.minFill || fill.usdc === onOffer) ? fill : null, buybackOpen: buyback > 0n };
  }

  /** What `claim_rebate` would pay a vault now: [credit used, $DS]. */
  async rebateQuote(owner: PublicKey): Promise<[bigint, bigint]> {
    const [c, v] = await Promise.all([this.config(), this.vault(owner)]);
    return v ? rebateClaim(v.rebateCredit, c.dsReserve, c.reserveCost) : [0n, 0n];
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_LAYOUTS,
  ACCOUNT_SIZES,
  EVENT_DISCRIMINATORS,
  EVENT_LAYOUTS,
  PROGRAM_ID,
  VAULT_ERRORS,
  accountKind,
  decodeRoom,
  decodeVault,
  encode,
  errorCode,
  eventToJson,
  ixs,
  parseEvents,
  pda,
  vaultErrorOf,
  INSTRUCTION_DISCRIMINATORS,
} from '../src/index.js';

test('account sizes match the program (8 + INIT_SPACE)', () => {
  assert.deepEqual(ACCOUNT_SIZES, { Config: 620, Vault: 137, Room: 460, Vesting: 153 });
});

test('discriminators are sha256 prefixes and all distinct', () => {
  const all = [...Object.values(ACCOUNT_DISCRIMINATORS), ...Object.values(EVENT_DISCRIMINATORS), ...Object.values(INSTRUCTION_DISCRIMINATORS)].map((d) => d.toString('hex'));
  assert.equal(new Set(all).size, all.length);
  // a value anyone can recompute: sha256("account:Vault")[..8]
  assert.equal(ACCOUNT_DISCRIMINATORS.Vault.toString('hex'), Buffer.from('d308e82b02987577', 'hex').toString('hex'));
});

test('accounts round trip through the layouts', () => {
  const owner = Keypair.generate().publicKey;
  const vault = { owner, balance: 5n, locked: 7n, sessionExpires: -1n, dailyCap: 100n, spentDay: 20_000n, spent: 3n, dsBalance: 9n, dsStaked: 11n, rewardIndex: (1n << 100n) + 5n, rewards: 13n, rebateCredit: 17n, bump: 254 };
  const data = Buffer.concat([ACCOUNT_DISCRIMINATORS.Vault, encode({ struct: ACCOUNT_LAYOUTS.Vault }, vault)]);
  assert.equal(data.length, ACCOUNT_SIZES.Vault);
  assert.deepEqual(decodeVault(data), vault);
  assert.equal(accountKind(data), 'Vault');
  assert.throws(() => decodeRoom(data), /not a Room account/);
});

test('instruction data: discriminator then Borsh arguments', () => {
  const authority = Keypair.generate().publicKey;
  const seated = Array.from({ length: 10 }, () => Keypair.generate().publicKey);
  const ix = ixs.settleRound(authority, 4, 9n, [0, 1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], seated);
  assert.equal(ix.data.length, 8 + 8 + 8);
  assert.deepEqual(ix.data.subarray(0, 8), INSTRUCTION_DISCRIMINATORS.settle_round);
  assert.equal(ix.data.readBigUInt64LE(8), 9n);
  assert.deepEqual([...ix.data.subarray(16)], [0, 1, 255, 255, 255, 255, 255, 255]);
  assert.equal(ix.keys.length, 3 + 10);
  assert.ok(ix.keys[2].pubkey.equals(pda.room(4)));
  assert.ok(ix.keys[3].pubkey.equals(pda.vault(seated[0])) && ix.keys[3].isWritable);
  assert.ok(ix.programId.equals(PROGRAM_ID));
});

function eventLine(name: keyof typeof EVENT_LAYOUTS, data: Record<string, unknown>): string {
  return `Program data: ${Buffer.concat([EVENT_DISCRIMINATORS[name], encode({ struct: EVENT_LAYOUTS[name] }, data)]).toString('base64')}`;
}

test('events are taken only from lines the program itself logged', () => {
  const id = PROGRAM_ID.toBase58();
  const owner = Keypair.generate().publicKey;
  const locked = { room: 2, round: 5n, slot: 3, owner, stake: 500_000n };
  const forged = { room: 2, round: 5n, slot: 3, owner, stake: 999n };
  const logs = [
    `Program ${id} invoke [1]`,
    'Program log: Instruction: LockStake',
    `Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]`,
    eventLine('StakeLocked', forged), // logged by another program: ignored
    `Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success`,
    eventLine('StakeLocked', locked),
    `Program ${id} consumed 5000 of 200000 compute units`,
    `Program ${id} success`,
    `Program 11111111111111111111111111111111 invoke [1]`,
    eventLine('StakeLocked', forged),
    `Program 11111111111111111111111111111111 success`,
  ];
  const events = parseEvents(logs);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'StakeLocked');
  assert.deepEqual(events[0].data, locked);
  assert.deepEqual(eventToJson(events[0].data), { room: 2, round: '5', slot: 3, owner: owner.toBase58(), stake: '500000' });
});

test('program errors are recognised by name and by code', () => {
  assert.equal(errorCode('NotAdmin'), 6000);
  assert.equal(vaultErrorOf({ message: 'x', logs: ['Program log: AnchorError ... Error Code: RoomNotFull. Error Number: 6012.'] }), 'RoomNotFull');
  assert.equal(vaultErrorOf(new Error('custom program error: 0x1770')), 'NotAdmin');
  assert.equal(vaultErrorOf(new Error(`{"InstructionError":[0,{"Custom":${6000 + VAULT_ERRORS.indexOf('PriceMoved')}}]}`)), 'PriceMoved');
  assert.equal(vaultErrorOf(new Error('blockhash not found')), null);
});

test('PDAs are stable', () => {
  // seeds as documented in docs/verify.md
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
  assert.ok(pda.config().equals(config));
  assert.ok(!pda.room(1).equals(pda.room(2)));
});

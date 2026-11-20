// The SDK's hand written layouts and builders against the IDL built from the
// Rust source (scripts/build-idl.sh). If the program changes and the SDK
// does not follow, this fails.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_LAYOUTS,
  EVENT_DISCRIMINATORS,
  EVENT_LAYOUTS,
  INSTRUCTION_ARGS,
  INSTRUCTION_DISCRIMINATORS,
  PROGRAM_ID,
  VAULT_ERRORS,
  VaultInstructions,
  type Ty,
} from '../src/index.js';
import type { TransactionInstruction } from '@solana/web3.js';

interface IdlField {
  name: string;
  type: IdlType;
}
type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } };
interface Idl {
  address: string;
  instructions: { name: string; discriminator: number[]; accounts: { name: string; writable?: boolean; signer?: boolean }[]; args: IdlField[] }[];
  accounts: { name: string; discriminator: number[] }[];
  events: { name: string; discriminator: number[] }[];
  errors: { code: number; name: string }[];
  types: { name: string; type: { kind: string; fields: IdlField[] } }[];
}

const idl = JSON.parse(readFileSync(new URL('../../../programs/darkseek-vault/idl/darkseek_vault.json', import.meta.url), 'utf8')) as Idl;
const types = new Map(idl.types.map((t) => [t.name, t.type.fields]));
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function toTy(t: IdlType): Ty {
  if (typeof t === 'string') return t as Ty;
  if ('array' in t) return { array: [toTy(t.array[0]), t.array[1]] };
  return { struct: toFields(types.get(t.defined.name)!) };
}
const toFields = (fields: IdlField[]) => fields.map((f) => [camel(f.name), toTy(f.type)] as const);
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

test('program id', () => {
  assert.equal(idl.address, PROGRAM_ID.toBase58());
});

test('accounts: names, discriminators and layouts', () => {
  assert.deepEqual(idl.accounts.map((a) => a.name).sort(), Object.keys(ACCOUNT_LAYOUTS).sort());
  for (const a of idl.accounts) {
    const name = a.name as keyof typeof ACCOUNT_LAYOUTS;
    assert.deepEqual([...ACCOUNT_DISCRIMINATORS[name]], a.discriminator, `${name} discriminator`);
    assert.deepEqual(plain(ACCOUNT_LAYOUTS[name]), plain(toFields(types.get(name)!)), `${name} layout`);
  }
});

test('events: names, discriminators and layouts', () => {
  assert.deepEqual(idl.events.map((e) => e.name).sort(), Object.keys(EVENT_LAYOUTS).sort());
  for (const e of idl.events) {
    const name = e.name as keyof typeof EVENT_LAYOUTS;
    assert.deepEqual([...EVENT_DISCRIMINATORS[name]], e.discriminator, `${name} discriminator`);
    assert.deepEqual(plain(EVENT_LAYOUTS[name]), plain(toFields(types.get(name)!)), `${name} layout`);
  }
});

test('errors: same names, same codes', () => {
  assert.deepEqual(
    idl.errors.map((e) => [e.code, e.name]),
    VAULT_ERRORS.map((n, i) => [6000 + i, n]),
  );
});

test('instructions: discriminators, arguments and every account flag', () => {
  assert.deepEqual(idl.instructions.map((i) => i.name).sort(), Object.keys(INSTRUCTION_ARGS).sort());
  const k = () => Keypair.generate().publicKey;
  const b = new VaultInstructions();
  const built: Record<string, TransactionInstruction> = {
    initialize: b.initialize(k(), k(), { authority: k(), stakes: [1n, 2n, 3n, 4n], feeBps: 1000, split: { stakers: 1000, rebate: 2000, buyback: 2000, treasury: 5000 } }),
    set_authority: b.setAuthority(k(), k()),
    propose_admin: b.proposeAdmin(k(), k()),
    accept_admin: b.acceptAdmin(k()),
    init_room: b.initRoom(k(), 1, 0),
    init_ds: b.initDs(k(), k(), { genesisPrice: 1n, floorPrice: 1n, duration: 1n, lot: 1n, minFill: 1n, buybackTarget: 1n }),
    sweep_treasury: b.sweepTreasury(k(), k(), k(), 1n),
    open_vault: b.openVault(k(), k()),
    set_session: b.setSession(k(), 1n, 1n),
    deposit: b.deposit(k(), k(), k(), 1n),
    withdraw: b.withdraw(k(), k(), 1n),
    charge: b.charge(k(), 1n),
    pay: b.pay(k(), k(), 1n),
    lock_stake: b.lockStake(k(), 1, k(), 1n, 0),
    unlock_stake: b.unlockStake(k(), 1, k(), 1n, 0),
    start_round: b.startRound(k(), 1, 1n),
    settle_round: b.settleRound(k(), 1, 1n, [0, 0, 0, 0, 0, 0, 0, 0], []),
    cancel_round: b.cancelRound(k(), 1, 1n, []),
    abort_stale_round: b.abortStaleRound(k(), 1, 1n, []),
    deposit_ds: b.depositDs(k(), k(), k(), 1n),
    withdraw_ds: b.withdrawDs(k(), k(), 1n),
    stake_ds: b.stakeDs(k(), 1n),
    unstake_ds: b.unstakeDs(k(), 1n),
    claim_rewards: b.claimRewards(k()),
    claim_rebate: b.claimRebate(k()),
    sell_ds: b.sellDs(k(), k(), k(), 1n, 1n),
    create_vesting: b.createVesting(k(), k(), k(), { id: 1n, total: 1n, start: 0n, cliff: 0n, end: 1n }),
    claim_vesting: b.claimVesting(k(), k(), 1n),
  };
  for (const ins of idl.instructions) {
    const name = ins.name as keyof typeof INSTRUCTION_ARGS;
    assert.deepEqual([...INSTRUCTION_DISCRIMINATORS[name]], ins.discriminator, `${name} discriminator`);
    assert.deepEqual(plain(INSTRUCTION_ARGS[name]), plain(toFields(ins.args)), `${name} arguments`);
    const ix = built[name];
    assert.ok(ix, `no builder test for ${name}`);
    assert.equal(ix.keys.length, ins.accounts.length, `${name} account count`);
    ins.accounts.forEach((a, i) => {
      assert.equal(ix.keys[i].isWritable, !!a.writable, `${name}.${a.name} writable`);
      assert.equal(ix.keys[i].isSigner, !!a.signer, `${name}.${a.name} signer`);
    });
  }
});

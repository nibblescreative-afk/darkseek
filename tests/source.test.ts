// Reads the program source and pins down every place where value can leave
// custody or a protected counter can go down. A new path (a hidden one, or an
// honest change) fails this test until it is reviewed and listed here and in
// docs/security-model.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness/chain.js';

const SRC = path.join(ROOT, 'programs/darkseek-vault/src');
const lib = fs.readFileSync(path.join(SRC, 'lib.rs'), 'utf8');

/** Every `fn name(...) { body }` in lib.rs, body included. */
function functions(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\bfn (\w+)(?:<[^>]*>)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = src.indexOf('{', m.index);
    let depth = 0;
    const startBody = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    out.set(m[1], src.slice(startBody, i + 1));
  }
  return out;
}

const fns = functions(lib);
const using = (pattern: RegExp) =>
  [...fns.entries()]
    .filter(([, body]) => pattern.test(body))
    .map(([name]) => name)
    .sort();

test('the program has the instructions the docs list, and no others', () => {
  const program = lib.slice(lib.indexOf('#[program]'), lib.indexOf('// ---------------------------------------------------------------------- helpers'));
  const handlers = [...program.matchAll(/pub fn (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(handlers, [
    'abort_stale_round', 'accept_admin', 'cancel_round', 'charge', 'claim_rebate', 'claim_rewards', 'claim_vesting',
    'create_vesting', 'deposit', 'deposit_ds', 'init_ds', 'init_room', 'initialize', 'lock_stake', 'open_vault', 'pay',
    'propose_admin', 'sell_ds', 'set_authority', 'set_session', 'settle_round', 'stake_ds', 'start_round', 'sweep_treasury',
    'unlock_stake', 'unstake_ds', 'withdraw', 'withdraw_ds',
  ]);
  const doc = fs.readFileSync(path.join(ROOT, 'docs/security-model.md'), 'utf8');
  for (const h of handlers) assert.ok(doc.includes(`\`${h}\``), `docs/security-model.md describes ${h}`);
});

test('tokens leave a program account only in these places', () => {
  // pay_out signs USDC out of custody as the config PDA
  assert.deepEqual(using(/\bpay_out\(/), ['sell_ds', 'sweep_treasury', 'withdraw']);
  // ds_transfer moves $DS or locked tokens; with seeds the program signs: $DS custody to its owner, or a lock to its beneficiary
  assert.deepEqual(using(/ds_transfer\([^;]*Some\(seeds\)/), ['claim_vesting', 'withdraw_ds']);
  assert.match(fns.get('withdraw_ds')!, /ds_transfer\(&a\.ds_token_program, &a\.ds_custody, &a\.ds_mint, &a\.to, a\.config\.to_account_info\(\), Some\(seeds\), amount\)/);
  assert.match(fns.get('claim_vesting')!, /ds_transfer\(&a\.token_program, &a\.vesting_tokens, &a\.mint, &a\.to, a\.vesting\.to_account_info\(\), Some\(seeds\), amount\)/);
  // $DS is burned only by the auction, from the seller's own account
  assert.deepEqual(using(/ti::burn\(/), ['sell_ds']);
  assert.match(fns.get('sell_ds')!, /ti::Burn \{ mint: a\.ds_mint\.to_account_info\(\), from: a\.seller_ds\.to_account_info\(\), authority: a\.seller\.to_account_info\(\) \}/);
});

test('protected counters only go down in these places', () => {
  assert.deepEqual(using(/\.treasury -=/), ['sweep_treasury']);
  assert.deepEqual(using(/\.buyback_pool -=/), ['sell_ds']);
  assert.deepEqual(using(/\.rebate_pool -=/), ['sell_ds']);
  assert.deepEqual(using(/staker_pool\.checked_sub|\.staker_pool -=/), ['claim_rewards']);
  assert.deepEqual(using(/\.ds_reserve -=/), ['claim_rebate']);
  assert.deepEqual(using(/\.reserve_cost -=/), ['claim_rebate']);
  assert.deepEqual(using(/\.rebate_credits -=/), ['claim_rebate']);
  assert.deepEqual(using(/\.rebate_credit -=/), ['claim_rebate']);
  // a vault's free USDC goes down: the owner withdraws or spends, or a stake is locked under a session
  assert.deepEqual(using(/\.balance -=/), ['charge', 'pay', 'spend_session', 'withdraw']);
  assert.deepEqual(using(/\.ds_balance -=/), ['stake_ds', 'withdraw_ds']);
  assert.deepEqual(using(/spend_session\(/), ['lock_stake']);
});

test('who must sign, as Anchor checks it', () => {
  const ctx = fs.readFileSync(path.join(SRC, 'contexts.rs'), 'utf8');
  // the vault owner signs everything that spends from a vault
  for (const name of ['OwnerOnly', 'Withdraw', 'Charge', 'Pay', 'WithdrawDs', 'StakeDs']) {
    const body = ctx.slice(ctx.indexOf(`pub struct ${name}<`), ctx.indexOf('}', ctx.indexOf(`pub struct ${name}<`)));
    assert.match(body, /pub owner: Signer<'info>/, `${name} needs the owner's signature`);
    assert.match(body, /seeds = \[b"vault", owner\.key\(\)\.as_ref\(\)\]/, `${name} works only on the signer's own vault`);
  }
  // the game server signs room operations, checked against the config
  for (const name of ['LockStake', 'RoomOp']) {
    const body = ctx.slice(ctx.indexOf(`pub struct ${name}<`), ctx.indexOf('}', ctx.indexOf(`pub struct ${name}<`)));
    assert.match(body, /pub authority: Signer<'info>/);
    assert.match(body, /has_one = authority/);
  }
  // the admin signs admin operations
  for (const name of ['AdminOnly', 'InitRoom', 'InitDs', 'SweepTreasury']) {
    const body = ctx.slice(ctx.indexOf(`pub struct ${name}<`), ctx.indexOf('}', ctx.indexOf(`pub struct ${name}<`)));
    assert.match(body, /has_one = admin @ VaultError::NotAdmin/, `${name} is admin only`);
  }
});

test('no instruction can change the fee, the split, the stakes or the $DS mint after setup', () => {
  for (const field of ['fee_bps', 'split', 'stakes', 'ds_mint', 'mint', 'custody', 'ds_custody', 'ds_token_program']) {
    const writers = using(new RegExp(`\\bc\\.${field} = `));
    assert.deepEqual(writers, field.startsWith('ds_') ? ['init_ds'] : ['initialize'], `${field} is written once`);
  }
  const auction = using(/c\.auction(\.\w+)? = /);
  assert.deepEqual(auction, ['init_ds', 'sell_ds'], 'only a fill moves the auction');
  assert.match(fns.get('sell_ds')!, /c\.auction\.last_price = price;\s*c\.auction\.started_at = now;/);
});

test('the buyback target is set once and can only go down by 2% per completed round', () => {
  assert.deepEqual(using(/c\.buyback_target_initial = /), ['init_ds']);
  assert.deepEqual(using(/c\.buyback_target = /), ['init_ds', 'sell_ds']);
  const sell = fns.get('sell_ds')!;
  assert.equal(sell.match(/c\.buyback_target = /g)?.length, 1);
  assert.match(sell, /c\.buybacks_done \+= 1;\s*c\.buyback_target = next_buyback_target\(c\.buyback_target\);/);
  const rules = fs.readFileSync(path.join(SRC, 'rules.rs'), 'utf8');
  assert.match(rules, /pub fn next_buyback_target\(target: u64\) -> u64 \{\s*\(target as u128 \* BUYBACK_TARGET_DECAY_BPS as u128 \/ BPS as u128\) as u64/);
  assert.match(fs.readFileSync(path.join(SRC, 'state.rs'), 'utf8'), /pub const BUYBACK_TARGET_DECAY_BPS: u64 = 9_800;/);
  // init_ds runs once: it creates the $DS custody account, which cannot exist twice
  assert.match(fs.readFileSync(path.join(SRC, 'contexts.rs'), 'utf8'), /#\[account\(init, payer = admin, seeds = \[b"ds_custody"\]/);
});

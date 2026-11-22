# Security model

Who can do what with the DarkSeek vault program, listed exhaustively from the
source (`programs/darkseek-vault/src`). `tests/source.test.ts` fails if an
instruction is added without being described here, or if a new path appears
where tokens leave custody or a protected balance goes down.

## Roles

| Role | What it is | Held by, in a deployment with real money |
|---|---|---|
| Upgrade authority | can replace the program | a Squads multisig, 3 of 5, 48 hour timelock |
| Admin | `config.admin` | the same multisig |
| Game server | `config.authority` | a hot key on the game server, rotated by the admin |
| Vault owner | the wallet a vault belongs to | each player |
| Anyone | any key | |

Nothing is deployed yet. A deployment's keys are listed in
[deployments.md](deployments.md); `npm run verify -- config --program <id>`
shows the admin and game server keys onchain, and `npm run verify -- program
--program <id>` the upgrade authority.

## The upgrade authority

The upgrade authority can replace the program with any other code. It is the
largest power in the system: new code could do anything the program's
accounts allow, including moving custody. Everything else on this page holds
for the code that is deployed; this is how the deployed code stays the code in
this repository:

1. **Every deployment is a tagged release** with a verifiable build: anyone can
   rebuild the program from the tag and get the same hash as the chain
   ([verify.md](verify.md)).
2. **Before any deployment with real money, the upgrade authority is a Squads
   multisig**: five signers on separate hardware wallets, three needed, and a
   48 hour timelock between approval and execution. An upgrade is proposed as a buffer whose
   hash anyone can compare with the release before it can execute.
3. **Upgrades are announced** with the release notes and the buffer hash when
   they are proposed, so players can withdraw during the timelock if they
   disagree.
4. **Once the program has run unchanged through an audit and two seasons**, the
   upgrade authority will be removed (`solana program set-upgrade-authority
   --final`), making the program immutable.

`initialize` can only be called by the upgrade authority, so nobody can set the
program up under their own admin key before its deployer does.

## The admin

| Instruction | What the admin can do | Limits |
|---|---|---|
| `initialize` | create the config and the USDC custody, choosing the game server key, the stakes, the fee and its split | once; signer must be the upgrade authority; fee at most 20%; the four fee shares must add up to 100% |
| `init_room` | create rooms 1 to 6 with a tier | once per room |
| `init_ds` | record the $DS mint, its token program, the first buyback target and the auction parameters | once; refuses a mint with a mint authority or a freeze authority, without six decimals, with more than one billion tokens, or (Token 2022) with any extension but metadata; target above zero; genesis price at or above the floor |
| `set_authority` | replace the game server key | takes effect at once; emits `AuthoritySet` |
| `propose_admin`, `accept_admin` | hand the admin role over | two steps: the new key must sign to accept |
| `sweep_treasury` | withdraw from the treasury to any USDC account | at most `config.treasury` |

**The admin cannot:**

- take anything from a vault, a room, the staker pool, the rebate pool, the
  buyback pool, the $DS reserve, staked $DS or a vesting account. The only
  instruction that pays the admin is `sweep_treasury`, capped by the treasury.
  From v0.4.0 the three pools fill only from the round after `init_ds` (until
  then the whole fee is the treasury's), so the choice of the $DS mint can never
  hand over anything that waited for it;
- change the fee, its split, the stakes, the USDC mint, the $DS mint or the
  auction's parameters after setup: no instruction writes them again;
- raise or reset the buyback target: `init_ds` sets it once, and the only
  other write lowers it to 98% when a buyback round completes;
- pause the program, block withdrawals or freeze anyone: there is no pause;
- mint $DS: the mint has no mint authority, and `init_ds` refuses one that does.

**What to watch.** The admin can make any key the game server with
`set_authority`, including its own, and then has the game server's powers
below. Every change is an event on the program's history. The program cannot
tell a copycat token from the real $DS when `init_ds` runs; it only checks that
the supply is fixed. Check that `config.ds_mint` is the published $DS mint
(`npm run verify -- config` does). The auction settings `init_ds` records are
bounded by the program from v0.4.0: a floor above zero and at most the genesis
price, legs of six hours to seven days, a lot of at most 100,000 USDC, a first
target of at most 1,000,000 USDC; `npm run verify -- config` checks them too.
Whatever the floor, past the last fill the auction's bid at most doubles every
leg, so no setting lets anyone empty the pools at an absurd price in one go.

## The game server

The game server runs the rounds and pays the network fees. Every instruction
it signs is checked against `config.authority`.

| Instruction | What it can do | Limits |
|---|---|---|
| `open_vault` | create a vault for any wallet (anyone can) | pays the rent; the vault belongs to that wallet |
| `lock_stake` | move a seat's stake from a player's free balance into a room | only with an active session from that player; counts toward the session's daily cap; only the fixed stake for that tier and role; one seat per wallet per room; only while the room is open, or to open the next round of a settled room (only the next round number, from v0.4.0); never for the all zero key |
| `unlock_stake` | give a stake back before the round starts | the whole stake, to the vault it came from |
| `start_round` | start a round and take the fee | only when all ten seats are staked; the fee is 10% of each seat, split by the fixed shares |
| `settle_round` | report the outcome: who survived, and which Seeker caught each Hider | the program computes every payout from the published rules; only the ten seated vaults are paid, each must be passed in slot order; payouts never exceed the room's pot |
| `cancel_round` | end a round without a result | before the start every stake goes back in full; after it, the stake less the fee already taken |

**The game server cannot:**

- keep a player's stake in a lobby that does not start: from v0.4.0 the seat's
  owner can leave on their own (`leave_seat`) once the lobby has been forming
  for 30 minutes, and while they stay seated no lock or unlock restarts that
  clock (seating them again in a fresh lobby means giving the stake back and
  locking it anew under their session, against its daily cap; once they revoke
  the session, it cannot);

- withdraw, spend or move a player's free balance anywhere but into a room
  seat, and only under that player's session and cap;
- pay itself or anyone who is not seated in that room;
- pay more than the room holds, or choose amounts: it reports outcomes only;
- start a round with an empty seat. (It could seat wallets it controls as if
  they were players: the program cannot tell whose wallet sits in a seat. That
  the game never does is a promise the game keeps, and the public history of
  every wallet and the game's fair play watch are how it is checked.)
- touch the treasury, the pools, the $DS reserve, staked $DS or rewards;
- change any setting.

**What you trust the game server for.** The game runs on the server, so the
program cannot know who really caught whom; it takes the server's report. A
dishonest server could report a wrong outcome, or cancel a round after it
started (which costs every player the fee, never more). This trust is bounded:

- a player's exposure is limited to the stakes the session's daily cap allows
  (100 USDC a day by default, chosen by the player; the day is the UTC
  calendar day, so up to twice the cap can be locked within a few seconds
  around midnight UTC) and ends when the player revokes the session
  (`set_session` with a past expiry; locks already made stay);
- every round is public: `RoundStarted` lists the ten wallets and the fee,
  `RoundSettled` the outcome and every payout, so anyone can audit win rates
  per wallet;
- every round's result is signed by this same key and published by the game
  (`/api/rounds`): the seats, who caught whom and when, the outcome sent to
  `settle_round`, and the seed the spawns and roles were dealt from, revealed
  against a commit made before anyone sat down ([fairness.md](fairness.md)).
  `npm run verify -- rounds` checks each record's signature, its deal and its
  settle transaction, so a server that settles one thing and reports another
  is caught by anyone;
- planned: replays, so a disputed round can be checked against what the
  players saw.

## The vault owner

| Instruction | What the owner can do |
|---|---|
| `set_session` | let the game server lock room stakes until an expiry (at most 90 days), up to a daily cap; a past expiry revokes it |
| `deposit` | put USDC from their token account into a vault (anyone can deposit into any vault) |
| `withdraw` | take free USDC out, to any token account, at any time, without the game server |
| `charge` | pay the treasury from the vault (a shop purchase) |
| `pay` | pay another player's vault (a P2P purchase) |
| `deposit_ds` | put $DS into a vault (anyone can, into any vault) |
| `withdraw_ds` | take free $DS (claimed rebates, deposits, unstaked $DS) out |
| `stake_ds`, `unstake_ds` | stake free $DS or unstake it, with no lockup |
| `leave_seat` | leave an open lobby with the whole stake (v0.4.0) | only the seat's owner; only once the lobby has been forming for 30 minutes (the first seat in an empty room starts the clock; while the player stays seated, nothing restarts it) |

Every instruction that spends from a vault needs the owner's signature and
works only on the signer's own vault (Anchor checks the vault's address
against the signer). Locked stakes leave a vault only through the room rules.

## Anyone

| Instruction | What anyone can do | Why it is safe |
|---|---|---|
| `abort_stale_round` | return the stakes of a room with no progress for two hours: an open lobby in full, a live round less the fee | the money goes only to the seated vaults |
| `sell_ds` | sell $DS to the program at the current auction price | the price is set by the rules; the seller signs for their own $DS; the buyback spends only an open round's fixed budget and burns what it buys in the same instruction; at most one lot per fill |
| `claim_rewards` | move a vault's staking rewards into its USDC balance | the USDC can only land in that vault |
| `claim_rebate` | turn a vault's rebate credit into $DS at the reserve's average purchase price | the $DS can only land in that vault; never more than the reserve holds |
| `create_vesting` | lock tokens of any SPL Token or Token 2022 mint for a beneficiary, with a cliff and an end | the funder's own tokens; nobody can revoke or speed it up; refuses a mint with any extension but metadata, which could leave the lock short or empty |
| `claim_vesting` | release what has vested | only to the beneficiary's own token account |

## Where value can leave custody

Exactly four instructions sign tokens out of a custody account, and one more
signs tokens out of a vesting account:

| Instruction | From | To | Bound |
|---|---|---|---|
| `withdraw` | USDC custody | the owner's chosen account | the owner's free balance; owner signs |
| `withdraw_ds` | $DS custody | the owner's chosen account | the owner's free $DS; owner signs |
| `sweep_treasury` | USDC custody | the admin's chosen account | the treasury counter; admin signs |
| `sell_ds` | USDC custody | the seller's USDC account | one fill of the open buyback round and the rebate pool at the auction price |
| `claim_vesting` | a vesting account | the beneficiary's account | what has vested |

$DS is burned only in `sell_ds`, from the seller's own account with the
seller's signature.

$DS paths go through the token interface, so they work the same whether pump.fun
created $DS on SPL Token or on Token 2022; the token program is recorded with
the mint and checked on every $DS instruction.

## Known limits of v0.3.0, and what v0.4.0 changes

An internal review of release v0.3.0 (November 2026,
[audits/2026-11-21-internal-review.md](audits/2026-11-21-internal-review.md);
not an external audit) found no way for a player, an outsider or the game
server to take funds beyond what this page concedes, and the payout and fee
arithmetic sound to the base unit. Release v0.4.0 changes the program for each
of its findings; until a deployment runs v0.4.0, the v0.3.0 limits apply to it.
Testnet runs it since 2026-11-22 (release v0.4.1, the same code with its build
files); devnet still runs v0.3.0.

| v0.3.0 | v0.4.0 |
|---|---|
| Every round fills the staker, rebate and buyback pools before $DS is recorded, and an admin recording a token of its own with loose auction settings could take them | until $DS is recorded the whole fee goes to the treasury; the auction settings are bounded onchain |
| `lock_stake` on a settled room accepts any higher round number, so the game server key could leave a room with no round after it | only the next round number |
| Only the game server can give a lobby stake back, and each lock or unlock restarts the stale clock | the seat's owner can leave on their own after 30 minutes of the lobby forming (`leave_seat`) |
| Back to back fills each restart the price at only 1.5 times the last | a fill within ten minutes of the one before restarts it at 3 times |
| The price stops at a fixed floor after one descent, so while the market is above that cap nobody sells and the pools wait | no fixed rate: the descent follows the last fill, and past it the bid at most doubles every leg of six hours or more |
| What waited for stakers goes in full to whoever is staked at the next round start | at most a tenth of it goes out at each round start |
| A vault can be opened for the all zero key, which marks empty seats | refused |

Still true in v0.4.0: the session's daily cap is per UTC day (up to twice the
cap within a few seconds around midnight UTC); the auction has no price
oracle, so a sudden fall in the price of $DS still costs the pools something
before the bid catches up (less than before), and when nobody else sells for
hours a lone seller can wait while the bid doubles every leg past the market;
under an active session the game
server can give a lobby stake back and lock it again in a fresh lobby, against
the daily cap, until the player revokes the session; the program cannot tell
whose wallets sit in a room.

## Not covered by the program

- **The stake token.** USDC's issuer can freeze any USDC account, including
  custody. The program cannot prevent that.
- **Collusion between players**, such as a Hider signalling a friend who is a
  Seeker. The server limits what each browser can see; the rest is a game
  integrity question, not a custody one.
- **Front ends.** A copy of the website could ask you to sign something else.
  Sign only transactions that call the program id in [deployments.md](deployments.md).

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).

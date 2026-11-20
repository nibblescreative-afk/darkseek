# DarkSeek white paper

Version 0.2, November 2026. Amounts in USDC unless marked $DS.

DarkSeek is a Web3 hide and seek game played for stakes. Eight Hiders and two
Seekers share a pitch black cave; the only money in a round is the money its
ten players put in, and a program on Solana decides who gets it. This paper
describes the game as far as it matters for the money, the protocol around it,
and the $DS token. Everything it says about money can be checked against the
program in this repository and against the chain.

Why DarkSeek exists and where it is going is in [VISION.md](VISION.md).

**Status.** Not deployed yet. The game runs at
[thedarkseek.xyz](https://thedarkseek.xyz) (play money until launch). The
program goes to Solana devnet first, with a test token that has no value, and
to mainnet only after an external audit and with the multisig upgrade
authority described in [security-model.md](security-model.md). The code has
not been audited.

## 1. The game

A round is a 2D side view of a cave where nobody can see far.

- **Eight Hiders, two Seekers.** Hiders see a small circle around them. Seekers
  carry a light that follows the mouse and a weapon.
- **Blind pick, then a 10 second head start.** Everyone picks a character in
  secret. Hiders get 10 seconds to scatter while the Seekers wait in the dark.
- **A 2:00 hunt.** Seekers try to catch every Hider before time runs out. Every
  Seeker attack has a 1.5 second cooldown, whatever the weapon.
- **Two lives.** The first hit wounds a Hider; the second catches them. Three
  Hiders each round get a role at random (healer, jester, detective), whatever
  character they play.
- **People only.** Staked rounds are ten people, every seat staked by the person
  in it. A round starts only when two Seekers and eight Hiders are seated. No
  bot ever takes a staked seat and the house never plays. Free practice against
  bots exists, without money.

The game server runs every round at 60 ticks a second and decides what happened.
What each browser receives is limited to what that player could see, so a
modified client has nothing hidden to reveal. The game itself is not in this
repository; see the [README](../README.md) for why.

## 2. Rooms and stakes

Six rooms run at once: three casual, three pro.

| | Casual | Pro |
|---|---:|---:|
| Hider stake, 8 seats | 0.50 | 2.50 |
| Seeker stake, 2 seats | 1.50 | 7.50 |
| Room total | 7.00 | 35.00 |
| Protocol fee, 10% | 0.70 | 3.50 |
| Net pool, 90% | 6.30 | 31.50 |

A stake is locked from the player's vault when they take a seat. The fee is
taken seat by seat when the round starts, so every Hider plays for a net stake
of 0.45 (casual) or 2.25 (pro), and every Seeker for 1.35 or 6.75. Before the
round starts a player can leave and get the whole stake back.

## 3. Who gets paid

The game server reports only who survived and which Seeker caught each Hider.
The program turns that into payouts with three rules:

1. **Each Seeker keeps the net stake of every Hider they caught**, win or lose.
2. **Seekers win only if every Hider is caught.** Then each Seeker also gets
   their own net stake back.
3. **Otherwise the Hiders win.** Survivors get their own net stake back and
   split both Seekers' net stakes evenly.

Payouts can never exceed the room's net pool. When survivors split a stake that
does not divide evenly, the remainder (at most a few millionths of a USDC) goes
to the treasury.

Worked examples (the same numbers the tests check):

| Casual room | Payout | Net |
|---|---:|---:|
| **Hiders win, 4 of 8 survive** | | |
| Seeker who caught 3 | 1.35 | lost 0.15 |
| Seeker who caught 1 | 0.45 | lost 1.05 |
| Each survivor | 1.125 | won 0.625 |
| Each caught Hider | 0 | lost 0.50 |
| **Seekers win, 6 and 2 catches** | | |
| Seeker who caught 6 | 4.05 | won 2.55 |
| Seeker who caught 2 | 2.25 | won 0.75 |
| Each Hider | 0 | lost 0.50 |

In a pro room every amount is five times larger. A Seeker stakes three times
what a Hider stakes and carries the risk: unless every Hider is caught, a
Seeker breaks even only with four catches or more.

## 4. The protocol fee

Every stake pays 10%. That fee is shared four ways, by shares fixed in the
program when it is set up:

| Share of the fee | Share of each stake | Goes to | Paid in | Casual room | Pro room |
|---:|---:|---|---|---:|---:|
| 10% | 1% | $DS stakers, pro rata to stake | USDC | 0.07 | 0.35 |
| 20% | 2% | players who lost money that round | $DS | 0.14 | 0.70 |
| 20% | 2% | buyback: buys $DS and burns it | burned $DS | 0.14 | 0.70 |
| 50% | 5% | treasury | USDC | 0.35 | 1.75 |
| **100%** | **10%** | | | **0.70** | **3.50** |

Of a 0.50 casual Hider stake, for example, 0.45 goes into the round, 0.005 to
stakers, 0.01 to the rebate, 0.01 to the buyback and 0.025 to the treasury.

The four parts always add up to the fee exactly; the treasury takes the
rounding remainder. The treasury pays for servers, network fees, development
and audits. The admin can withdraw the treasury's share and nothing else: the
staker, rebate and buyback pools can never reach the treasury or the team.

## 5. $DS

$DS is DarkSeek's token. Staked, it earns a share of every fee in USDC;
players who lose money in a round get part of the fee back in $DS.

### A fair launch on pump.fun

- **Created by pump.fun**: 1,000,000,000 $DS with six decimals, no mint
  authority and no freeze authority, pump.fun's standard. Nobody, the team
  included, can mint more or freeze a holder. pump.fun creates either an SPL
  Token mint or a Token 2022 mint with its metadata inside; the vault program
  accepts both and refuses any other Token 2022 extension.
- **No presale and no private allocation.** No tokens are set aside for
  anyone, the team included, and no vesting schedules are created for anyone.
- **One launch buy.** At launch the team's wallet buys 3% of the supply on
  pump.fun's bonding curve, the same way as any buyer. Its address and the buy
  transaction are published in [deployments.md](deployments.md).
- **Liquidity only from pump.fun**: the bonding curve, then pump.fun's own pool
  once the token graduates. The team adds no liquidity and holds no LP tokens.
- **The treasury holds no $DS.** It is funded only by its 50% share of the fee.
- **The address.** The $DS mint address is published in
  [deployments.md](deployments.md) and on the site at launch. A token with
  another address is not $DS.

The supply only goes down, through the buyback burn. The program never creates
$DS: the only $DS it pays out is $DS it bought with fee money.

### Rebates for players who lost money

1. When a round settles, the program finds the players who ended it with less
   than they staked: caught Hiders, and Seekers below their stake.
2. They share that round's rebate (20% of the fee, 2% of every stake)
   equally, as USDC credit in their vaults. In a casual round where six players
   lost money, each is credited 0.023333 USDC. A round cancelled after its
   start cost every seat the fee, so all ten share its rebate.
3. The rebate pool buys $DS continuously in the auction (section 7) and keeps
   it in a reserve, recording what it paid.
4. Credit turns into $DS at the average price the reserve paid
   (`claim_rebate`; anyone may send it and the $DS can only land in that
   player's vault). Credit the reserve cannot cover yet waits for the next
   purchases.

Every credit is backed by USDC in the rebate pool or by $DS the pool already
bought; [solvency.md](solvency.md) shows how anyone checks it.

### Token locks

The vault program has a lock any holder may use for any token: nothing before
a cliff, then a straight line to an end date, and nobody can revoke it or
speed it up. If the team locks any of its own tokens, the lock is listed in
[deployments.md](deployments.md). No lock is promised.

## 6. Staking

Players stake $DS from their vault; stakers share 10% of every protocol fee
(1% of every stake), in USDC, in proportion to their stake: 0.07 from each
casual round and 0.35 from each pro round.

- Rewards build up from the next round that starts after staking. The program
  keeps one running total of USDC earned per staked $DS, so every staker's
  share is exact and nobody decides who gets paid.
- Rewards are claimed into the vault's USDC balance at any time. Anyone may
  trigger the claim for a vault; the USDC can only land in that vault.
- No lockup: unstaking is immediate.
- While nobody stakes, the stakers' share waits in the staker pool for the
  first stakers.

## 7. Buyback and burn

The buyback share of the fee (20%, so 2% of every stake) buys $DS and burns
it, in rounds of a fixed USDC size set at launch.

- **The first target** is half the USDC value of the team's launch buy. It is
  recorded once when $DS is set up in the program; deployments.md shows the
  launch buy transaction and the conversion to USDC used.
- **A round opens** only when the buyback pool holds the whole target, and it
  spends exactly the target. Every $DS it buys is burned in the same
  instruction that buys it.
- **The next target is 98% of the last**, rounded down to the USDC base unit,
  each time a round's budget is spent. As the target shrinks and more rounds
  are played, rounds come more often.
- **Nobody can raise or reset the target**, the admin included: no
  instruction can. Every fill's `Buyback` event carries the current target and
  the number of completed rounds, and `npm run verify -- config` checks that
  target n equals the first target times 0.98 n times, rounded down at each step.

Worked example, with an assumed launch buy of 2 SOL at an assumed 150 USDC per
SOL (both only for the arithmetic): the buy is worth 300 USDC, so the first
target is 150 USDC.

| Buyback round | Target (USDC) | Casual rounds of fees to fill it | or pro rounds |
|---:|---:|---:|---:|
| 1 | 150.000000 | 1,072 | 215 |
| 2 | 147.000000 | 1,050 | 210 |
| 3 | 144.060000 | 1,029 | 206 |
| 4 | 141.178800 | 1,009 | 202 |
| 5 | 138.355224 | 989 | 198 |
| 11 | 122.560917 | 876 | 176 |
| 36 | 73.961181 | 529 | 106 |

A casual round adds 0.14 USDC to the buyback pool and a pro round 0.70. From
round 36 on, a target is under half the first.

### The auction

The program buys $DS through a descending price auction that runs entirely
onchain, with no oracle and no operator.

- **Anyone can sell $DS to the program** at the current price. The seller
  signs; the program burns the buyback share of what it buys, adds the rebate
  share to the reserve, then pays the seller USDC from custody. A fill pays
  from the open buyback round and from the rebate pool in proportion; the
  rebate pool buys at any time, the buyback only during a round.
- **The price** is quoted in $DS per USDC. After each fill it restarts at 1.5
  times the price of that fill (asking for 50% more $DS per USDC) and falls in a
  straight line to a floor over six hours. Sellers wait until the program's bid
  is worth taking, so fills land near the market price.
- **Limits.** One fill pays at most 1,000 USDC and at least 1 USDC, unless it
  takes all that is on offer. The floor, set at launch to a thousandth of the
  launch price in $DS per USDC, caps what the program ever pays per $DS; while
  the market price is above that cap, nobody sells and the pools wait.
- **Fixed rules.** The $DS mint, the first target and the auction's parameters
  are recorded once. Nobody, the admin included, can change them, pause the
  auction or take USDC from the pools any other way.

## 8. Custody and solvency

Players deposit USDC into a vault: an account of the vault program that
records their balance. USDC sits in one custody account the program owns, and
$DS (staked, claimed rebates, the rebate reserve) in another.

- Only the owner can withdraw, at any time, without the game server.
- The game server can lock a room stake only for players who approved a game
  session (at most 90 days, revocable at any time), and only up to the daily
  cap they chose.
- Shop and P2P payments from a vault need the owner's own signature.
- If the game server ever stops, anyone can return the stakes of a round that
  made no progress for two hours.

The program keeps one set of books. At every moment the USDC custody holds at
least every vault balance, every room's escrow, the treasury and the three
pools; the $DS custody holds at least the reserve and every vault's $DS; and
every rebate credit is backed by the rebate pool or by $DS it bought. Anyone
can check it with one command. The invariants and how to check
them are in [solvency.md](solvency.md); every power the server and the admin
have, and what they cannot do, is in [security-model.md](security-model.md).

## 9. Characters

Characters are NFTs on Token 2022: every copy is its own mint with a supply of
exactly one, its metadata stored in the mint, and the mint authority removed
after the single mint, so a copy can never be duplicated. Each character has a
fixed supply and a flat mint price; once one sells out, players trade it among
themselves.

| | Free | NFT characters | Copies ever |
|---|---|---:|---:|
| Seekers | The Warden | 4 | 240 |
| Hiders | Sprinter | 8 | 480 |

Prices run from 3 USDC (Smokey, Chameleon) to 35 USDC (Abyssal Lord).

## 10. Skill, not pay to win

The free Seeker and the free Hider can win any round. A paid character buys a
different skill and small, bounded differences: at most 4% more speed and a
skill cooldown a few seconds shorter. Weapons and their 1.5 second cooldown
are the same rules for everyone, roles are dealt at random, and the house never
plays. The details and the limits are in [fairness.md](fairness.md).

## 11. Roadmap

| Phase | What | Status |
|---|---|---|
| 1. Playable cave | The cave, lighting, 14 characters, practice rounds | done |
| 2. Online rooms | Six rooms on an authoritative 60 Hz server; people only staked rounds (demo build, play money) | done |
| 3. Open protocol | This repository: vaults, settlement, the fee split, rebates, $DS staking, the buyback rule and auction, token locks, the SDK and the indexer | done |
| 4. Devnet | The program deployed from a tagged release with the owner's keys, test money only | next |
| 5. Mainnet and $DS | After an external audit, with the multisig upgrade authority; $DS launched on pump.fun, its address published in deployments.md | planned |
| 6. Seasons | Tournaments paid from the treasury, replays, signed round results | planned |

## 12. Risks

- **Software.** The program and the game server can have bugs. The program is
  tested on a local validator but has not been audited, and no test proves the
  absence of bugs.
- **The game server reports results.** The program enforces every money rule,
  but who caught whom comes from the server. [security-model.md](security-model.md)
  lists what that trust covers and how it is bounded.
- **Market.** $DS has no guaranteed value. Staking rewards and buybacks depend
  on how much is played.
- **Law.** Staking money on the result of a game can count as gambling where you
  live. Check your local law before playing for money.

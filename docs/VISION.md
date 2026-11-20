# Vision

Every online game played for money has asked players for the same leap of
faith: that whoever runs the table holds the money, pays it out, does not play
against you, does not change the odds, and will still be there tomorrow.
DarkSeek is built so that the leap is not needed.

The game is hide and seek in the dark. The promise is older than the game:
**the house cannot cheat and the house cannot sink**, and anyone can check
both, at any time, without asking us.

## What is broken today

- **Custody.** The operator holds the players' money. When it is mismanaged,
  frozen or gone, players learn last.
- **A hidden edge.** The operator sets the odds, can fill tables with its own
  bots, and can change the rules quietly.
- **Nothing to check.** Players cannot see whether the money they won exists,
  or whether a round was played fairly.
- **Printed rewards.** Many Web3 games paid players with newly printed tokens.
  The rewards were real only as long as new money kept arriving.

## Five properties, enforced in code

These are not promises in a terms of service. Each one is a rule in the vault
program, and each links to the document that shows how to check it.

1. **Your money stays yours until a round settles.** It sits in your own vault
   in the program, and only you can withdraw it. The game server can only lock
   the stake of a seat you took, under your session and its daily cap.
   ([security model](security-model.md))
2. **People only.** A staked round starts only when ten people have staked
   their seats. No bot and no house stake, ever: the program refuses
   (`RoomNotFull`). ([fairness](fairness.md))
3. **Solvent by construction.** Every payout comes from the stakes in that
   room, and custody equals what the program owes, to the base unit, after
   every instruction. The payout rules are checked on all 6,561 outcomes of a
   round, and random sequences of every instruction are fuzzed against the
   real program with the books checked after each step. Anyone can run the
   same check against a deployment with one command. ([solvency](solvency.md))
4. **One fee, split in public.** 10% of every stake, split by fixed shares:
   10% to $DS stakers, 20% back to the players who lost, 20% to buy back and
   burn $DS, 50% to the treasury that runs the game. The treasury can never
   reach the other three. ([white paper](WHITEPAPER.md#4-the-protocol-fee))
5. **A token without a printer.** $DS launches on pump.fun with a fixed supply
   and no mint authority. The program never creates $DS: stakers are paid in
   USDC from real fees, and the buyback only ever shrinks the supply.
   ([white paper](WHITEPAPER.md#5-ds))

## Skill, not luck

Hide and seek is a game of reading the dark, timing and nerve. The money
follows the play: a Seeker is paid for every Hider they catch, the Seekers win
only by catching everyone, and the Hiders who outlast the light split the
Seekers' stakes. A character bought in the shop changes how you play, never
whether you can win. ([fairness](fairness.md))

## The one thing still trusted, and how it shrinks

Today one input is trusted: the game server reports who caught whom.
Everything else, every amount included, is computed by the program, and the
server's powers are bounded ([security model](security-model.md)). The
direction is to move that last piece of trust from a server to something
anyone can recompute:

1. **Signed results.** Every result is signed by the server and published with
   the round's events, so a wrong report can be proven wrong.
2. **Replays.** A round can be replayed from its inputs, so anyone can
   recompute the result the server reported.
3. **A challenge window.** Payouts become final after a short window in which
   a replay that disagrees can stop them.
4. **More than one referee.** Independent servers attest each result, and
   payouts need a quorum of them.

From trusting a server, to trusting a replay, to trusting the math. Steps 1
and 2 are on the [roadmap](https://github.com/nibblescreative-afk/darkseek/issues/12);
steps 3 and 4 are research, not promises.

## Beyond one game

The vault program is a small settlement layer: rooms, seats, stakes, a fee
split by fixed shares, an outcome, and payouts computed by published rules.
Hide and seek is the first game on it. Any skill game played for stakes
between people at a fixed table has the same shape. The aim after mainnet is
to factor the payout rules out, so other games can plug in their own, audited
and verified the same way, with their money as checkable as ours.

## Open by default

The part that holds money is open today, with reproducible builds, checksums,
build provenance and immutable releases. The license of this repository turns
into GPL 2.0 or later on 2030-11-20, by itself. ([license](../LICENSE))

## What success looks like

- A player who has never heard of us checks, in one command, that the money
  is there.
- A round's result can be recomputed by anyone who has its replay.
- The fee pays for the game and its players, and nothing is printed to pay
  them.
- Seasons and tournaments are paid from a treasury the game earned.

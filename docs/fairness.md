# Fairness

DarkSeek is a skill game with money on it, so two promises matter: the
character you pay for does not decide the round, and the house is never one of
your opponents.

## The house never plays

- Every staked seat is taken by the person who staked it. A round starts only
  when two Seekers and eight Hiders are seated; the program refuses to start a
  round with an empty seat (`RoomNotFull`), and there is no house stake to put
  in one. The program cannot tell whose wallet sits in a seat, so that the game
  never seats wallets of its own is a promise the game keeps; every wallet's
  history is public onchain, which is how it is checked.
- No bot ever takes a staked seat. Bots exist only in free practice, where no
  money is involved.
- A player who drops or goes quiet keeps their seat: their character stands
  still where it was (it can still be caught) until they reconnect. Nobody,
  human or bot, plays it for them.
- DarkSeek earns the same 10% fee whoever wins, so it has no reason to
  favour either side.

## Free characters are competitive

Anyone can play from day one with the two free characters, The Warden
(Seeker) and Sprinter (Hider), and they can win any round. Everything that
decides a round is the same for every character:

- the cave, the dark, the 10 second head start and the 2:00 hunt;
- every Seeker attack has the same 1.5 second cooldown;
- every Hider has two lives;
- the Hider roles (healer, jester, detective) are dealt at random each round,
  whatever character holds them;
- what each player can see is decided by the server for everyone alike.

## What a price buys, and its limits

A paid character buys a different active skill and its look. Its numbers may
be slightly better, never decisively:

| Stat | Free character | Most expensive | Largest difference |
|---|---:|---:|---|
| Movement speed | 1.00 | 1.04 | 4% |
| Seeker skill cooldown | 26 s | 21 s | 5 s |
| Hider skill cooldown | 22 s | 18 s | 4 s |
| Attack cooldown | 1.5 s | 1.5 s | none |
| Lives | 2 | 2 | none |

Each skill is a trade off rather than an upgrade: a Seeker who sees through
walls for two seconds, one who reads fresh footprints, one who slips through
rock; a Hider who blinks a few meters, one who turns into a prop, one who
blocks the light with smoke. Seeker weapons differ in shape (a thin laser, a
wide short swipe, a cone, a burst around the staff head), and their reach is
tuned against each other, so none outranges the rest.

Prices and supplies are fixed and public (see the [white paper](WHITEPAPER.md#9-characters)).
A character never gains strength over time and there are no consumable boosts
for money.

## Payouts reward play, not spending

- Seekers are paid per catch and win only by catching every Hider.
- Hiders are paid for surviving, and survivors split both Seekers' stakes.
- The rebate (20% of the fee) is credited to everyone who lost money that
  round, equally, and paid in $DS the rebate pool buys.

None of these depend on the character played. The payout rules are in the
program (`programs/darkseek-vault/src/rules.rs`) and tested on every possible
outcome.

## The fair deal

Where each Hider starts, who is the healer, the jester and the detective, and
each Hider's disguise are dealt from one round seed that neither the server
nor any player can steer, and that no browser sees before the round is over.

1. Before anyone sits down, the server draws a secret 32 byte seed and shows
   only its SHA-256, the commit, in the room's details.
2. Each browser that takes a seat sends a nonce of its own (16 random bytes).
3. The round seed is SHA-256 of `DarkSeek round seed v1|<room>|<round>|`, the
   server's seed, and the ten nonces in seat order (s0, s1, h0 to h7) joined by
   `|`. Seats follow the escrow slots, claimed one by one as people sat down,
   before the seed could be known.
4. Every draw is the first four bytes of SHA-256(round seed,
   `<label>:<i>:<k>`), read big endian; `k` counts up until the number is under
   the largest multiple of the range (no outcome is more likely than another).
   The spawns are a shuffle of the Hider spawn points (Fisher and Yates from the
   last place down, label `spawn`), Hider `i` taking place `i`; the healer is
   drawn from all Hiders (`healer`), the jester from the rest (`jester`), the
   detective from the rest after that (`detective`); Hider `i` is a crate when
   draw `mimic` `i` of 2 is 1, else a stalagmite.
5. During the round each browser is told its own spawn and role and nothing
   else. After it, the server reveals its seed and every nonce; your browser
   checks the seed against the commit it saw before you sat down, finds its own
   nonce in it, deals again and compares your spawn and role, and says so on
   the result screen.

`packages/sdk/src/rounds.ts` holds the same algorithm, tested against vectors
made by the game.

## Signed round results

When a round ends the game server writes down its result: the seats with their
wallets and escrow slots, every capture with its time, the outcome it sends to
`settle_round`, and the deal (the commit, the revealed seed, the nonces, the
round seed and the spawns and roles). It signs one line naming the record's
SHA-256 (of its JSON with sorted keys) as a standard Solana off-chain message,
with the game server key: the program's `config.authority`, the key that
settles the round. The records are public at `<site>/api/rounds` and
`<site>/api/rounds/<room>/<round>`.

```sh
# the signature, with nothing but the Solana CLI
solana verify-offchain-signature "<message>" <signature> --signer <config.authority>
# every published record: signature, deal, captures against outcome, and the settle transaction onchain
npm run verify -- rounds --cluster testnet --site https://thedarkseek.xyz
```

A server that settled one outcome onchain and reported another, dealt from a
seed it did not commit to, or wrote an outcome its own captures contradict is
caught by this check. The game runs the same check every 15 minutes and shows
it on its status page.

## Integrity

- The server is authoritative: browsers send only inputs. Players who are out
  of your light are never sent to your browser, so a modified client cannot
  reveal them. Roles are secret too: the jester and the detective are known
  only to themselves, the healer to the Hiders, never to the Seekers.
- Players who are caught stop seeing the round, so they cannot help their
  friends from the dark.
- A fair play watch on the server notes what a fair browser would not do (inputs
  that do not decode or claim the future, hits on Hiders a Seeker could not
  see, one network on both sides of a round, the same Seeker catching the same
  Hider early round after round) and attacks on the site, for a person to
  review. It bans nobody by itself.
- Every staked round is public onchain with its ten wallets and its outcome,
  and its signed result is public on the game's site.

What still depends on the game server, and how that is bounded, is in
[security-model.md](security-model.md).

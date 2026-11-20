# Fairness

DarkSeek is a skill game with money on it, so two promises matter: the
character you pay for does not decide the round, and the house is never one of
your opponents.

## The house never plays

- Every staked seat is taken by the person who staked it. A round starts only
  when two Seekers and eight Hiders are seated; the program refuses to start a
  round with an empty seat (`RoomNotFull`), and there is no house stake to put
  in one.
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

## Integrity

- The server is authoritative: browsers send only inputs. Players who are out
  of your light are never sent to your browser, so a modified client cannot
  reveal them.
- Players who are caught stop seeing the round, so they cannot help their
  friends from the dark.
- Every staked round is public onchain with its ten wallets and its outcome.

What still depends on the game server, and how that is bounded, is in
[security-model.md](security-model.md).

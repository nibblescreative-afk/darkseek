# Accessibility

DarkSeek is a game about seeing in the dark, so part of it is hard on purpose.
This page says what works today, what does not yet, and how to tell us about a
barrier.

## What works

- The website around the game (shop, staking, leaderboard, docs) can be used
  with a keyboard: controls show a visible focus outline, and icon buttons
  carry text labels for screen readers.
- Animations on the site and the end of round scenes follow the system's
  reduce motion setting.
- Everything in this repository is plain Markdown and code, readable with any
  screen reader.

## Known limitations

- A round needs sight, a keyboard and a mouse: Seekers aim a light with the
  mouse and Hiders have to stay out of it. There is no screen reader or switch
  access inside a round.
- The cave is dark and low in contrast by design.
- Keys cannot be remapped yet (`A` `D` move, `W` `S` jump and crouch, `Q`
  skill, `E` interact, `R` detective, `Esc` menu).
- The game is made for desktop browsers. Phones and tablets are not supported
  yet.

## Supported environments

Desktop browsers with a keyboard and a mouse or trackpad. We test in Chromium
based browsers (Chrome, Edge).

## Report a barrier

[Open a bug report](https://github.com/nibblescreative-afk/darkseek/issues/new/choose),
choose "The game" and start the title with "Accessibility:". Say what you
tried, on which device and with which assistive technology, and what got in
the way. We label these reports `accessibility` and answer each one.

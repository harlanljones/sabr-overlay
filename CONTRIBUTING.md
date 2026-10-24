# Contributing

## Setup

```sh
make run    # Firefox + extension, reloads on save
make lint   # must pass before a PR
```

## Ground rules

- One change per PR. Describe what the viewer sees differently.
- No build step, no dependencies, no frameworks. Plain ES2022 in three files.
- Stat definitions must cite a source (Savant, FanGraphs, StatsAPI docs) in the PR.
- New panels: add an entry to `PANELS`, a `RENDER.<id>` function, and a row in the README table.
- Test against a live game and a final game; both code paths differ (`abstractGameState`).

## Reporting bugs

Include the `gamePk`, your delay setting, and the output of `window.__sabrOverlayDebug.settings` from the page console.

# Strip Silence

An [Ableton Live](https://www.ableton.com) extension that removes silence from audio tracks in the Arrangement view. Built with the Ableton Extensions SDK.

## Features

- Detects and removes silent regions from one or more audio tracks
- Configurable threshold, minimum silence duration, pre-roll, and post-roll
- Option to snap cuts to the nearest beat
- Right-click an arrangement selection (across multiple tracks) or a single track header to run
- Remembers your last-used settings

## Installation

1. Download the latest `Strip-Silence-x.x.x.ablx` from the [Releases](../../releases) page
2. Open Ableton Live → **Preferences → Extensions**
3. Drag and drop the `.ablx` file onto the Extensions page

Requires the Ableton Live beta build that supports Extensions.

## Usage

**From a time selection (one or more tracks):**

1. In the Arrangement view, drag a time selection across the region you want to process — select multiple tracks to process them all
2. Right-click on the selection → **Strip Silence**
3. Adjust the settings and click **Strip Silence**

**From a track header (single track, full extent):**

1. Right-click any audio track header → **Strip Silence**
2. Adjust the settings and click **Strip Silence**

### Settings

| Setting | Description |
|---|---|
| **Threshold** | Signal level below which audio is considered silence (dB) |
| **Minimum Duration** | Shortest gap that counts as silence — shorter gaps are ignored |
| **Pre-roll** | Silence kept before the next sound starts (cushion at the start of each cut) |
| **Post-roll** | Silence kept after the previous sound ends (cushion at the end of each cut) |
| **Cut to nearest beat** | Snaps each cut point to the nearest beat in the arrangement |

All settings are saved and restored between sessions.

## Development

### Prerequisites

- Node.js ≥ 24.14.1
- The Ableton Extensions SDK (available to beta testers via Ableton's Centercode program — place the `.tgz` files in `vendor/`)

### Setup

```sh
npm install
```

### Scripts

```sh
npm start          # build (dev) + load into Live via Developer Mode
npm run build:dev  # dev bundle with sourcemaps
npm run build      # production bundle
npm run package    # bump patch version, build, and produce a .ablx
```

`npm run package` automatically increments the patch version in `manifest.json` and `package.json` on every run.

## License

MIT © Ellis Moss

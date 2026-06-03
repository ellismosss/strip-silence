# Strip Silence

An [Ableton Live](https://www.ableton.com) extension that removes silence from audio tracks in the Arrangement view. Built with the Ableton Extensions SDK.

## Installation

1. Download **`Strip-Silence-1.0.19.ablx`** from this page
2. Open Ableton Live → **Preferences → Extensions**
3. Drag and drop the `.ablx` file onto the Extensions page

Requires the Ableton Live beta build that supports Extensions.

## Features

- Detects and removes silent regions from one or more audio tracks
- Configurable threshold, minimum silence duration, pre-roll, and post-roll
- Option to snap cuts to the nearest beat
- Ripple edit option — automatically closes the gaps after stripping, sliding clips together
- Right-click an arrangement time selection to process one or more tracks simultaneously
- Right-click a track header to process the full track automatically
- Remembers your last-used settings between sessions

## Usage

**From a time selection (one or more tracks):**

1. In the Arrangement view, drag a time selection across the region you want to process
2. Right-click anywhere in the selection → **Strip Silence**
3. Adjust the settings and click **Strip Silence**

**From a track header (single track, full extent):**

1. Right-click any audio track header → **Strip Silence**
2. Adjust the settings and click **Strip Silence**

### Settings

| Setting | Description |
|---|---|
| **Threshold** | Signal level below which audio is considered silence (dB) |
| **Minimum Duration** | Shortest gap that counts as silence — shorter gaps are ignored |
| **Pre-roll** | Silence kept before the next sound starts |
| **Post-roll** | Silence kept after the previous sound ends |
| **Cut to nearest beat** | Snaps each cut point to the nearest beat |
| **Ripple edit** | Slides clips together after cutting, closing the gaps |

## Development

All source files are in the `source/` folder.

### Prerequisites

- Node.js ≥ 24.14.1
- The Ableton Extensions SDK (available to beta testers via Ableton's Centercode program — place the `.tgz` files in `source/vendor/`)

### Setup

```sh
cd source
npm install
```

### Scripts

```sh
npm start          # build (dev) + load into Live via Developer Mode
npm run build:dev  # dev bundle with sourcemaps
npm run build      # production bundle
npm run package    # bump patch version, build, and move .ablx to repo root
```

`npm run package` automatically increments the patch version and places the new `.ablx` in the repo root ready to commit.

## License

MIT © Ellis Moss

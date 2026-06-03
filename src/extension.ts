import type { ArrangementSelection } from "@ableton-extensions/sdk";
import {
  initialize,
  type ActivationContext,
  DataModelObject,
  AudioTrack,
  Handle,
} from "@ableton-extensions/sdk";
import * as fs from "fs/promises";
import * as path from "path";

import settingsInterface from "../ui/interface.html";

interface StripSilenceOptions {
  thresholdDb: number;
  minSilenceDuration: number;
  preRollMs: number;
  postRollMs: number;
  snapToBeats: boolean;
}

const DEFAULTS: StripSilenceOptions = {
  thresholdDb: -60,
  minSilenceDuration: 0.5,
  preRollMs: 50,
  postRollMs: 50,
  snapToBeats: false,
};

interface SilenceRange {
  start: number; // seconds, relative to selection start
  end: number;
}

// ── Font loader ───────────────────────────────────────────────────────────────

async function loadFontCss(): Promise<string> {
  const dirsToTry: string[] = [];

  const appMatch = process.execPath.match(/(.*\.app)\//);
  if (appMatch?.[1]) {
    dirsToTry.push(path.join(appMatch[1], "Contents", "App-Resources", "Fonts"));
  }

  for (const name of [
    "Ableton Live 12 Beta",
    "Ableton Live 12 Suite",
    "Ableton Live 12",
    "Ableton Live 11 Suite",
    "Ableton Live 11",
  ]) {
    dirsToTry.push(`/Applications/${name}.app/Contents/App-Resources/Fonts`);
  }

  for (const dir of dirsToTry) {
    try {
      const [regular, bold] = await Promise.all([
        fs.readFile(path.join(dir, "AbletonSansSmall-Regular.ttf")),
        fs.readFile(path.join(dir, "AbletonSansSmall-Bold.ttf")),
      ]);
      return `
@font-face {
  font-family: 'AbletonSans';
  font-weight: 400;
  src: url('data:font/ttf;base64,${regular.toString("base64")}') format('truetype');
}
@font-face {
  font-family: 'AbletonSans';
  font-weight: 700;
  src: url('data:font/ttf;base64,${bold.toString("base64")}') format('truetype');
}`;
    } catch {
      continue;
    }
  }

  return "";
}

// ── Settings persistence ──────────────────────────────────────────────────────

async function loadSettings(storageDir: string | undefined): Promise<StripSilenceOptions> {
  if (!storageDir) return { ...DEFAULTS };
  try {
    const raw = await fs.readFile(path.join(storageDir, "settings.json"), "utf-8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

async function saveSettings(storageDir: string | undefined, opts: StripSilenceOptions): Promise<void> {
  if (!storageDir) return;
  await fs.writeFile(path.join(storageDir, "settings.json"), JSON.stringify(opts, null, 2)).catch(() => {});
}

// ── AIFF parser ───────────────────────────────────────────────────────────────

interface AiffInfo {
  sampleRate: number;
  numChannels: number;
  sampleSize: number;
  numFrames: number;
  pcmData: Buffer;
}

function readExtendedFloat(buf: Buffer, offset: number): number {
  const exp = (buf.readUInt16BE(offset) & 0x7FFF) - 16383;
  const mantHi = buf.readUInt32BE(offset + 2);
  const mantLo = buf.readUInt32BE(offset + 6);
  return mantHi * Math.pow(2, exp - 31) + mantLo * Math.pow(2, exp - 63);
}

function parseAiff(buf: Buffer): AiffInfo {
  if (buf.toString("ascii", 0, 4) !== "FORM") throw new Error("Not a FORM file");
  const formType = buf.toString("ascii", 8, 12);
  if (formType !== "AIFF" && formType !== "AIFC") throw new Error(`Unsupported form type: ${formType}`);

  let numChannels = 0, sampleRate = 0, sampleSize = 0, numFrames = 0;
  let pcmData: Buffer | null = null;

  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const chunkSize = buf.readUInt32BE(pos + 4);
    const dataStart = pos + 8;

    if (id === "COMM") {
      numChannels = buf.readUInt16BE(dataStart);
      numFrames = buf.readUInt32BE(dataStart + 2);
      sampleSize = buf.readUInt16BE(dataStart + 6);
      sampleRate = readExtendedFloat(buf, dataStart + 8);
    } else if (id === "SSND") {
      const pcmOffset = buf.readUInt32BE(dataStart);
      pcmData = buf.subarray(dataStart + 8 + pcmOffset);
    }

    pos = dataStart + chunkSize;
    if (pos & 1) pos++;
  }

  if (!pcmData || !numChannels || !sampleRate) throw new Error("AIFF: missing COMM or SSND chunk");
  return { sampleRate, numChannels, sampleSize, numFrames, pcmData };
}

// ── Silence detection ─────────────────────────────────────────────────────────

function detectSilenceFromAiff(info: AiffInfo, rmsThreshold: number, minSilenceDuration: number): SilenceRange[] {
  const { sampleRate, numChannels, sampleSize, pcmData } = info;
  const bytesPerSample = Math.ceil(sampleSize / 8);
  const bytesPerFrame = bytesPerSample * numChannels;
  const totalFrames = Math.floor(pcmData.length / bytesPerFrame);

  const windowFrames = Math.max(1, Math.floor(sampleRate * 0.01));
  const windowDuration = windowFrames / sampleRate;
  const minWindows = Math.ceil(minSilenceDuration / windowDuration);
  const threshSq = rmsThreshold * rmsThreshold;

  const silent: boolean[] = [];

  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx += windowFrames) {
    const frameEnd = Math.min(frameIdx + windowFrames, totalFrames);
    let sumSq = 0, count = 0;

    for (let f = frameIdx; f < frameEnd; f++) {
      for (let c = 0; c < numChannels; c++) {
        const b = (f * numChannels + c) * bytesPerSample;
        let v: number;

        if (sampleSize === 24) {
          let i = (pcmData[b]! << 16) | (pcmData[b + 1]! << 8) | pcmData[b + 2]!;
          if (i & 0x800000) i |= ~0xFFFFFF;
          v = i / 8388608;
        } else if (sampleSize === 16) {
          const u = (pcmData[b]! << 8) | pcmData[b + 1]!;
          v = (u > 32767 ? u - 65536 : u) / 32768;
        } else if (sampleSize === 32) {
          const u = (pcmData[b]! << 24) | (pcmData[b + 1]! << 16) | (pcmData[b + 2]! << 8) | pcmData[b + 3]!;
          v = u / 2147483648;
        } else {
          v = 0;
        }

        sumSq += v * v;
        count++;
      }
    }

    silent.push(count > 0 ? sumSq / count < threshSq : true);
  }

  const ranges: SilenceRange[] = [];
  let runStart = -1;
  for (let i = 0; i <= silent.length; i++) {
    if (i < silent.length && silent[i]) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      if (i - runStart >= minWindows) ranges.push({ start: runStart * windowDuration, end: i * windowDuration });
      runStart = -1;
    }
  }

  return ranges;
}

// ── Roll adjustment ───────────────────────────────────────────────────────────

function applyRolls(ranges: SilenceRange[], preRollMs: number, postRollMs: number): SilenceRange[] {
  const preRoll = preRollMs / 1000;
  const postRoll = postRollMs / 1000;
  return ranges
    .map((r) => ({ start: r.start + postRoll, end: r.end - preRoll }))
    .filter((r) => r.end - r.start > 0.001);
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

// ── Extension entry point ─────────────────────────────────────────────────────

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  const storageDir = context.environment.storageDirectory;

  // Shared: build dialog HTML with saved settings, show it, return parsed opts
  async function showDialog(): Promise<StripSilenceOptions | null> {
    const [saved, fontCss] = await Promise.all([loadSettings(storageDir), loadFontCss()]);

    const dialogHtml = settingsInterface
      .replace("__FONT_CSS__", fontCss)
      .replace("__THRESHOLD__", String(saved.thresholdDb))
      .replace("__MIN_SILENCE__", String(saved.minSilenceDuration))
      .replace("__PRE_ROLL__", String(saved.preRollMs))
      .replace("__POST_ROLL__", String(saved.postRollMs))
      .replace("__SNAP_CHECKED__", saved.snapToBeats ? "checked" : "");

    const raw = await context.ui
      .showModalDialog(`data:text/html,${encodeURIComponent(dialogHtml)}`, 320, 370)
      .catch(() => "");

    if (!raw) return null;

    try {
      const opts: StripSilenceOptions = JSON.parse(raw);
      await saveSettings(storageDir, opts);
      return opts;
    } catch {
      return null;
    }
  }

  // Shared: run the actual analysis + edit for a set of tracks over a beat range
  async function process(
    tracks: AudioTrack<"1.0.0">[],
    selectionStart: number,
    selectionEnd: number,
    opts: StripSilenceOptions,
  ): Promise<void> {
    const rmsThreshold = dbToLinear(opts.thresholdDb);
    const snapBeat = (b: number) => opts.snapToBeats ? Math.round(b) : b;

    await context.ui.withinProgressDialog("Strip Silence", {}, async (update, signal) => {
      // Renders must be sequential — Live cannot handle concurrent render requests
      // inside a progress dialog without freezing. We pipeline by kicking off each
      // track's file-read + analysis immediately after its render completes, so
      // track N's analysis overlaps with track N+1's render.
      type PendingResult = { track: AudioTrack<"1.0.0">; ranges: SilenceRange[] } | null;
      const analysisTasks: Promise<PendingResult>[] = [];

      for (let i = 0; i < tracks.length; i++) {
        if (signal.aborted) break;
        const track = tracks[i]!;
        update(`Rendering (${i + 1}/${tracks.length})`, (i / tracks.length) * 70);

        let aifPath: string;
        try {
          aifPath = await context.resources.renderPreFxAudio(track, selectionStart, selectionEnd);
        } catch (e) {
          console.error(`[Strip Silence] Render failed for "${track.name}":`, e);
          continue;
        }

        // Start analysis without awaiting — it runs while the next track renders
        analysisTasks.push(
          fs.readFile(aifPath)
            .then((buf): PendingResult => {
              const aiffInfo  = parseAiff(buf);
              const silenceRaw = detectSilenceFromAiff(aiffInfo, rmsThreshold, opts.minSilenceDuration);
              const silenceAdj = applyRolls(silenceRaw, opts.preRollMs, opts.postRollMs);
              console.log(`[Strip Silence] "${track.name}": ${silenceRaw.length} regions → ${silenceAdj.length} after rolls`);
              return silenceAdj.length ? { track, ranges: silenceAdj } : null;
            })
            .catch((e) => {
              console.error(`[Strip Silence] Analysis failed for "${track.name}":`, e);
              return null;
            }),
        );
      }

      if (signal.aborted) return;

      update("Analyzing…", 75);
      const results = await Promise.all(analysisTasks);
      const pending = results.filter((r): r is { track: AudioTrack<"1.0.0">; ranges: SilenceRange[] } => r !== null);

      if (signal.aborted || !pending.length) {
        if (!pending.length) console.log("[Strip Silence] No silence regions found.");
        return;
      }

      update("Applying changes…", 85);

      const secondsPerBeat = 60 / context.application.song.tempo;

      const promises = context.withinTransaction(() =>
        pending.flatMap(({ track, ranges }) =>
          ranges.flatMap((r) => {
            const startBeat = snapBeat(selectionStart + r.start / secondsPerBeat);
            const endBeat   = snapBeat(selectionStart + r.end   / secondsPerBeat);
            if (endBeat <= startBeat) return [];
            return [track.clearClipsInRange(startBeat, endBeat)];
          }),
        ),
      );

      await Promise.all(promises);
      update("Done", 100);
    });
  }

  // ── Command: arrangement selection (right-click selection) ────────────────
  context.commands.registerCommand(
    "stripSilence.run",
    (arg: unknown) =>
      void (async (selection: ArrangementSelection) => {
        const tracks = selection.selected_lanes
          .map((h) => context.getObjectFromHandle(h, DataModelObject))
          .filter((o): o is AudioTrack<"1.0.0"> => o instanceof AudioTrack);

        if (!tracks.length) {
          console.log("[Strip Silence] No audio tracks in selection.");
          return;
        }

        const opts = await showDialog();
        if (!opts) return;

        await process(tracks, selection.time_selection_start, selection.time_selection_end, opts);
      })(arg as ArrangementSelection).catch((e) => console.error("[Strip Silence] Error:", e)),
  );

  // ── Command: track header (right-click audio track → full track) ──────────
  context.commands.registerCommand(
    "stripSilence.runOnTrack",
    (arg: unknown) =>
      void (async (handle: Handle) => {
        const track = context.getObjectFromHandle(handle as Handle, AudioTrack);
        const clips = track.arrangementClips;

        if (!clips.length) {
          console.log(`[Strip Silence] "${track.name}": no arrangement clips.`);
          return;
        }

        const selectionStart = Math.min(...clips.map((c) => c.startTime));
        const selectionEnd   = Math.max(...clips.map((c) => c.endTime));

        const opts = await showDialog();
        if (!opts) return;

        await process([track], selectionStart, selectionEnd, opts);
      })(arg as Handle).catch((e) => console.error("[Strip Silence] Error:", e)),
  );

  // ── Context menu registrations ────────────────────────────────────────────
  context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    "Strip Silence",
    "stripSilence.run",
  );

  context.ui.registerContextMenuAction(
    "AudioTrack",
    "Strip Silence",
    "stripSilence.runOnTrack",
  );
}

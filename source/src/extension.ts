import type { ArrangementSelection } from "@ableton-extensions/sdk";
import {
  initialize,
  type ActivationContext,
  DataModelObject,
  AudioTrack,
  AudioClip,
  type ClipLoopSettings,
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
  rippleEdit: boolean;
}

const DEFAULTS: StripSilenceOptions = {
  thresholdDb: -60,
  minSilenceDuration: 0.5,
  preRollMs: 50,
  postRollMs: 50,
  snapToBeats: false,
  rippleEdit: false,
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

// ── Audio file streaming silence detector ────────────────────────────────────
// Supports both AIFF (big-endian, macOS default) and WAV (little-endian, used
// when the user has "Record, Warp & Launch" set to WAV in Ableton preferences).
// Reads in 10 MB chunks — peak memory stays flat regardless of file size.

const CHUNK_TARGET_BYTES = 10 * 1024 * 1024;

/** Unified metadata for both AIFF and WAV renders. */
interface AudioFileMeta {
  sampleRate: number;
  numChannels: number;
  sampleSize: number;    // bits per sample
  isFloat: boolean;      // true for 32-bit IEEE float (WAV format type 3)
  numFrames: number;
  pcmByteOffset: number; // absolute byte position where PCM data begins
  littleEndian: boolean; // true = WAV, false = AIFF
}

// ── AIFF (big-endian, FORM/AIFF container) ───────────────────────────────────

function readExtendedFloat(buf: Buffer, offset: number): number {
  const exp = (buf.readUInt16BE(offset) & 0x7FFF) - 16383;
  const mantHi = buf.readUInt32BE(offset + 2);
  const mantLo = buf.readUInt32BE(offset + 6);
  return mantHi * Math.pow(2, exp - 31) + mantLo * Math.pow(2, exp - 63);
}

function parseAiffMeta(buf: Buffer): AudioFileMeta {
  if (buf.toString("ascii", 0, 4) !== "FORM") throw new Error("Not a FORM file");
  const formType = buf.toString("ascii", 8, 12);
  if (formType !== "AIFF" && formType !== "AIFC") throw new Error(`Unsupported AIFF variant: ${formType}`);

  let numChannels = 0, sampleRate = 0, sampleSize = 0, numFrames = 0, pcmByteOffset = -1;
  let pos = 12;

  while (pos + 8 <= buf.length) {
    const id        = buf.toString("ascii", pos, pos + 4);
    const chunkSz   = buf.readUInt32BE(pos + 4);
    const dataStart = pos + 8;

    if (id === "COMM") {
      numChannels = buf.readUInt16BE(dataStart);
      numFrames   = buf.readUInt32BE(dataStart + 2);
      sampleSize  = buf.readUInt16BE(dataStart + 6);
      sampleRate  = readExtendedFloat(buf, dataStart + 8);
    } else if (id === "SSND") {
      const pcmOffset = buf.readUInt32BE(dataStart); // usually 0
      pcmByteOffset   = dataStart + 8 + pcmOffset;
    }

    if (numChannels && pcmByteOffset >= 0) break;

    pos = dataStart + chunkSz;
    if (pos & 1) pos++;
  }

  if (pcmByteOffset < 0 || !numChannels || !sampleRate) throw new Error("AIFF: missing COMM or SSND chunk");
  return { sampleRate, numChannels, sampleSize, isFloat: false, numFrames, pcmByteOffset, littleEndian: false };
}

// ── WAV (little-endian, RIFF/WAVE container) ─────────────────────────────────

function parseWavMeta(buf: Buffer): AudioFileMeta {
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("Not a RIFF file");
  if (buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAVE file");

  let numChannels = 0, sampleRate = 0, sampleSize = 0, numFrames = 0, pcmByteOffset = -1;
  let isFloat = false, dataBytes = 0;
  let pos = 12;

  while (pos + 8 <= buf.length) {
    const id        = buf.toString("ascii", pos, pos + 4);
    const chunkSz   = buf.readUInt32LE(pos + 4); // WAV is little-endian
    const dataStart = pos + 8;

    if (id === "fmt ") {
      const audioFmt = buf.readUInt16LE(dataStart);
      isFloat      = audioFmt === 3;             // 1 = PCM int, 3 = IEEE float
      numChannels  = buf.readUInt16LE(dataStart + 2);
      sampleRate   = buf.readUInt32LE(dataStart + 4);
      sampleSize   = buf.readUInt16LE(dataStart + 14);
    } else if (id === "data") {
      pcmByteOffset = dataStart;
      dataBytes     = chunkSz === 0xFFFFFFFF ? 0 : chunkSz; // 0xFFFFFFFF = streamed/unknown
    }

    if (pcmByteOffset >= 0 && numChannels && sampleRate) break;

    pos = dataStart + chunkSz;
    if (pos & 1) pos++;
  }

  if (pcmByteOffset < 0 || !numChannels || !sampleRate) throw new Error("WAV: missing fmt or data chunk");

  const bytesPerFrame = Math.ceil(sampleSize / 8) * numChannels;
  numFrames = dataBytes > 0 ? Math.floor(dataBytes / bytesPerFrame) : 0;

  return { sampleRate, numChannels, sampleSize, isFloat, numFrames, pcmByteOffset, littleEndian: true };
}

// ── Format dispatcher ─────────────────────────────────────────────────────────

function parseAudioFileMeta(buf: Buffer): AudioFileMeta {
  const sig = buf.toString("ascii", 0, 4);
  if (sig === "FORM") return parseAiffMeta(buf);
  if (sig === "RIFF") return parseWavMeta(buf);
  throw new Error(`Unrecognised audio file signature: "${sig}" — expected AIFF (FORM) or WAV (RIFF)`);
}

// ── Silence detection ─────────────────────────────────────────────────────────

async function detectSilenceStreaming(
  filePath: string,
  rmsThreshold: number,
  minSilenceDuration: number,
): Promise<SilenceRange[]> {
  const fd = await fs.open(filePath, "r");
  try {
    // 64 KB is always enough to hold any AIFF or WAV header
    const headerBuf = Buffer.allocUnsafe(65536);
    await fd.read(headerBuf, 0, headerBuf.length, 0);

    const meta = parseAudioFileMeta(headerBuf);
    const { sampleRate, numChannels, sampleSize, isFloat, numFrames, pcmByteOffset, littleEndian: le } = meta;

    const bytesPerSample  = Math.ceil(sampleSize / 8);
    const bytesPerFrame   = bytesPerSample * numChannels;
    const windowFrames    = Math.max(1, Math.floor(sampleRate * 0.02)); // 20 ms
    const windowDuration  = windowFrames / sampleRate;
    const windowBytes     = windowFrames * bytesPerFrame;
    const windowSamples   = windowFrames * numChannels;
    const minWindows      = Math.ceil(minSilenceDuration / windowDuration);
    const threshSq        = rmsThreshold * rmsThreshold;
    const maxWindowSumSq  = threshSq * windowSamples;

    const windowsPerChunk = Math.max(1, Math.floor(CHUNK_TARGET_BYTES / windowBytes));
    const chunkBytes      = windowsPerChunk * windowBytes;
    const chunkBuf        = Buffer.allocUnsafe(chunkBytes);

    const silent: boolean[] = [];
    let filePos = pcmByteOffset;
    const fileEnd = numFrames > 0
      ? pcmByteOffset + numFrames * bytesPerFrame
      : Number.MAX_SAFE_INTEGER; // streamed WAV: read until EOF

    while (filePos < fileEnd) {
      const toRead  = Math.min(chunkBytes, fileEnd - filePos);
      const aligned = Math.floor(toRead / windowBytes) * windowBytes;
      if (aligned === 0) break;

      const { bytesRead } = await fd.read(chunkBuf, 0, aligned, filePos);
      if (bytesRead === 0) break;
      filePos += bytesRead;

      const windowsInChunk = Math.floor(bytesRead / windowBytes);

      for (let w = 0; w < windowsInChunk; w++) {
        const base   = w * windowBytes;
        let sumSq    = 0;
        let isSilent = true;

        outer: for (let f = 0; f < windowFrames; f++) {
          for (let c = 0; c < numChannels; c++) {
            const b = base + (f * numChannels + c) * bytesPerSample;
            let v: number;

            if (isFloat && sampleSize === 32) {
              // 32-bit IEEE float (common in Ableton WAV renders)
              v = le ? chunkBuf.readFloatLE(b) : chunkBuf.readFloatBE(b);
            } else if (sampleSize === 24) {
              let i: number;
              if (le) {
                i = chunkBuf[b]! | (chunkBuf[b + 1]! << 8) | (chunkBuf[b + 2]! << 16);
              } else {
                i = (chunkBuf[b]! << 16) | (chunkBuf[b + 1]! << 8) | chunkBuf[b + 2]!;
              }
              if (i & 0x800000) i |= ~0xFFFFFF; // sign-extend
              v = i / 8388608;
            } else if (sampleSize === 16) {
              const u = le
                ? chunkBuf[b]! | (chunkBuf[b + 1]! << 8)
                : (chunkBuf[b]! << 8) | chunkBuf[b + 1]!;
              v = (u > 32767 ? u - 65536 : u) / 32768;
            } else if (sampleSize === 32) {
              // 32-bit integer PCM
              const u = le
                ? chunkBuf[b]! | (chunkBuf[b + 1]! << 8) | (chunkBuf[b + 2]! << 16) | (chunkBuf[b + 3]! << 24)
                : (chunkBuf[b]! << 24) | (chunkBuf[b + 1]! << 16) | (chunkBuf[b + 2]! << 8) | chunkBuf[b + 3]!;
              v = u / 2147483648;
            } else {
              v = 0;
            }

            sumSq += v * v;
            if (sumSq > maxWindowSumSq) { isSilent = false; break outer; }
          }
        }

        silent.push(isSilent);
      }
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
  } finally {
    await fd.close();
  }
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
      .replace("__SNAP_CHECKED__",   saved.snapToBeats ? "checked" : "")
      .replace("__RIPPLE_CHECKED__", saved.rippleEdit   ? "checked" : "");

    const raw = await context.ui
      .showModalDialog(`data:text/html,${encodeURIComponent(dialogHtml)}`, 260, 340)
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
    const rmsThreshold   = dbToLinear(opts.thresholdDb);
    const snapBeat = (b: number) => opts.snapToBeats ? Math.round(b) : b;

    await context.ui.withinProgressDialog("Strip Silence", {}, async (update, signal) => {
      const secondsPerBeat = 60 / context.application.song.tempo;

      // Build per-track render segments: merge clip extents so we skip empty gaps.
      // A selection spanning 5 min but containing only 90 s of clips renders 90 s,
      // not 5 min. Clips are merged so overlapping ones aren't rendered twice.
      type Segment = { track: AudioTrack<"1.0.0">; start: number; end: number };
      const segments: Segment[] = [];

      for (const track of tracks) {
        const clips = track.arrangementClips
          .filter(c => c.startTime < selectionEnd && c.endTime > selectionStart)
          .sort((a, b) => a.startTime - b.startTime);

        if (!clips.length) {
          // No clips in range — fall back to rendering the full selection
          segments.push({ track, start: selectionStart, end: selectionEnd });
          continue;
        }

        // Merge overlapping/adjacent clip extents into minimal render segments
        let segStart = Math.max(clips[0]!.startTime, selectionStart);
        let segEnd   = Math.min(clips[0]!.endTime,   selectionEnd);

        for (let i = 1; i < clips.length; i++) {
          const cs = Math.max(clips[i]!.startTime, selectionStart);
          const ce = Math.min(clips[i]!.endTime,   selectionEnd);
          if (cs <= segEnd) {
            segEnd = Math.max(segEnd, ce); // extend current segment
          } else {
            segments.push({ track, start: segStart, end: segEnd });
            segStart = cs;
            segEnd   = ce;
          }
        }
        segments.push({ track, start: segStart, end: segEnd });
      }

      // Result type: beat ranges already converted, ready for clearClipsInRange
      type BeatRange = { start: number; end: number };
      type PendingResult = { track: AudioTrack<"1.0.0">; beatRanges: BeatRange[] } | null;
      const analysisTasks: Promise<PendingResult>[] = [];

      for (let i = 0; i < segments.length; i++) {
        if (signal.aborted) break;
        const { track, start: segStart, end: segEnd } = segments[i]!;
        update(`Rendering (${i + 1}/${segments.length})`, (i / segments.length) * 70);

        let aifPath: string;
        try {
          aifPath = await context.resources.renderPreFxAudio(track, segStart, segEnd);
        } catch (e) {
          console.error(`[Strip Silence] Render failed "${track.name}" @${segStart}:`, e);
          continue;
        }

        // Start analysis immediately — overlaps with the next segment's render
        analysisTasks.push(
          detectSilenceStreaming(aifPath, rmsThreshold, opts.minSilenceDuration)
            .then((silenceRaw): PendingResult => {
              const silenceAdj = applyRolls(silenceRaw, opts.preRollMs, opts.postRollMs);
              if (!silenceAdj.length) return null;

              // Convert from seconds-relative-to-segment-start → absolute beats
              const beatRanges = silenceAdj
                .map(r => ({
                  start: snapBeat(segStart + r.start / secondsPerBeat),
                  end:   snapBeat(segStart + r.end   / secondsPerBeat),
                }))
                .filter(r => r.end > r.start);

              console.log(`[Strip Silence] "${track.name}" @${segStart}: ${silenceRaw.length} → ${beatRanges.length}`);
              return beatRanges.length ? { track, beatRanges } : null;
            })
            .catch(e => { console.error(`[Strip Silence] Analysis failed:`, e); return null; }),
        );
      }

      if (signal.aborted) return;

      update("Analyzing…", 75);
      const results = await Promise.all(analysisTasks);
      const pending = results.filter((r): r is { track: AudioTrack<"1.0.0">; beatRanges: BeatRange[] } => r !== null);

      if (!pending.length) {
        console.log("[Strip Silence] No silence regions found.");
        return;
      }

      update("Applying changes…", 85);

      const promises = context.withinTransaction(() =>
        pending.flatMap(({ track, beatRanges }) =>
          beatRanges.flatMap(r =>
            r.end > r.start ? [track.clearClipsInRange(r.start, r.end)] : [],
          ),
        ),
      );

      await Promise.all(promises);
      // ── Ripple edit ──────────────────────────────────────────────────────
      if (opts.rippleEdit && pending.length) {
        update("Ripple editing…", 92);
        const uniqueTracks = [...new Set(pending.map(p => p.track))];
        for (const track of uniqueTracks) {
          await rippleTrack(track, selectionStart, selectionEnd);
        }
      }

      update("Done", 100);
    });
  }

  // ── Ripple edit ───────────────────────────────────────────────────────────
  // Packs clips within the selection leftward to close gaps left by silence
  // removal. Processes left-to-right and creates each clip at its new position
  // BEFORE deleting the original — so if a create fails, the clip is preserved.
  async function rippleTrack(
    track: AudioTrack<"1.0.0">,
    selectionStart: number,
    selectionEnd: number,
  ): Promise<void> {
    const MIN_DURATION = 0.01;

    const clips = track.arrangementClips
      .filter(c =>
        c.startTime >= selectionStart - 0.001 &&
        c.endTime   <= selectionEnd   + 0.001 &&
        c.duration  >= MIN_DURATION
      )
      .filter((c): c is AudioClip<"1.0.0"> => c instanceof AudioClip)
      .sort((a, b) => a.startTime - b.startTime);

    if (!clips.length) return;

    let cursor = selectionStart;
    const moves: Array<{ clip: AudioClip<"1.0.0">; newStart: number }> = [];

    for (const clip of clips) {
      if (Math.abs(clip.startTime - cursor) > 0.001) {
        moves.push({ clip, newStart: cursor });
      }
      cursor += clip.duration;
    }

    if (!moves.length) return;

    const snapshots = moves.map(({ clip, newStart }) => ({
      clip,
      newStart,
      filePath: clip.filePath,
      duration: clip.duration,
      isWarped: clip.warping,
      loopSettings: {
        looping:     clip.warping && clip.looping,
        startMarker: clip.startMarker,
        endMarker:   clip.endMarker,
        loopStart:   clip.warping && clip.looping ? clip.loopStart : clip.startMarker,
        loopEnd:     clip.endMarker, // SDK requires loopEnd === endMarker
      } as ClipLoopSettings,
      name:  clip.name,
      color: clip.color,
      muted: clip.muted,
    }));

    // Create at new position FIRST (so original is safe if create fails),
    // then delete original. Left-to-right order avoids position conflicts.
    for (const s of snapshots) {
      try {
        const newClip = await context.withinTransaction(() =>
          track.createAudioClip({
            filePath:     s.filePath,
            startTime:    s.newStart,
            duration:     s.duration,
            isWarped:     s.isWarped,
            loopSettings: s.loopSettings,
          })
        );

        await context.withinTransaction(() => track.deleteClip(s.clip));

        context.withinTransaction(() => {
          newClip.name  = s.name;
          newClip.color = s.color;
          newClip.muted = s.muted;
        });
      } catch (e) {
        console.error(`[Strip Silence] Ripple: could not move "${s.clip.name}":`, e);
      }
    }

    console.log(`[Strip Silence] Ripple: moved ${moves.length} clip(s) on "${track.name}"`);
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

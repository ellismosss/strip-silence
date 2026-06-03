import { initialize, type ActivationContext } from "@ableton-extensions/sdk";

// esbuild inlines this HTML file as a string for production builds.
import bundledInterface from "../ui/interface.html";

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  const { tempo } = context.application.song;
  console.log(
    `Hello from my-extension! Your Live Set's tempo is: ${tempo} bpm.`,
  );

  context.application.song.tempo = 165;
  console.log(`The tempo is now ${context.application.song.tempo} bpm`);
}
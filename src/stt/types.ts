export type EngineName = "apple" | "whisper" | "soniox" | "wispr";
/** One engine (failures are errors), "auto", or the auto order as a list: "wispr,soniox,apple,whisper". */
export type EngineChoice = EngineName | "auto" | `${string},${string}`;

export interface STTEvent {
  type: "partial" | "final";
  /** For partials: the whole in-progress utterance so far (replace, don't append). */
  text: string;
  /** Seconds from the start of the stream. */
  start: number;
  end: number;
  /** The locale the stream was opened with. */
  lang: string;
  engine: EngineName;
  /** Language the engine heard in this utterance (ISO 639-1, e.g. "zh"), from engines that detect it (soniox). */
  detectedLang?: string;
  /** Speaker label ("1", "2", ...) when diarization is on (soniox). */
  speaker?: string;
  /** Mean token confidence 0-1, from engines that report it (soniox). */
  confidence?: number;
}

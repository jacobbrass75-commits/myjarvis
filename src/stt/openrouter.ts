// OpenRouter speech-to-text: one recorded clip -> text through OpenRouter's transcription endpoint
// (POST {OPENROUTER_BASE_URL}/v1/audio/transcriptions, openrouter.ai/docs/guides/overview/multimodal/stt),
// with the OPENROUTER_API_KEY Studio uses. Request/response, not streaming, so it is for push-to-talk
// finals and the batch path: STT_BATCH_ENGINE=openrouter:<model>, e.g. openrouter:elevenlabs/scribe-v2.
// Body: { model, input_audio: { data: base64 wav, format: "wav" }, language? } -> { text, usage }.
// The audio leaves the Mac (to OpenRouter and the model's provider).

export const OPENROUTER_STT_DEFAULT_BASE = "https://openrouter.ai/api";

export function openRouterKey(): string {
  return process.env.OPENROUTER_API_KEY?.trim() || "";
}

function url(): string {
  return `${(process.env.OPENROUTER_BASE_URL?.trim() || OPENROUTER_STT_DEFAULT_BASE).replace(/\/+$/, "")}/v1/audio/transcriptions`;
}

export class OpenRouterSTTError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function wav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** BCP-47 "en-US" -> "en"; undefined = let the model detect it. */
const iso = (lang?: string) => {
  const b = (lang ?? "").toLowerCase().split(/[-_]/)[0];
  return b && b !== "auto" && /^[a-z]{2}$/.test(b) ? b : undefined;
};

export interface OpenRouterSTTResult {
  text: string;
  /** usage.cost (USD) and usage.seconds, as OpenRouter reports them. */
  cost?: number;
  seconds?: number;
}

/** One clip (s16le mono) -> text with an OpenRouter transcription model. */
export async function openRouterTranscribe(pcm: Buffer, o: { sampleRate: number; model: string; lang?: string; timeoutMs?: number }): Promise<OpenRouterSTTResult> {
  const key = openRouterKey();
  if (!key) throw new OpenRouterSTTError("OPENROUTER_API_KEY is not set");
  const model = o.model.replace(/^openrouter:/, "").trim();
  if (!model) throw new OpenRouterSTTError("no OpenRouter transcription model named (STT_BATCH_ENGINE=openrouter:<model>)");
  const language = iso(o.lang);
  let res: Response;
  try {
    res = await fetch(url(), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input_audio: { data: wav(pcm, o.sampleRate).toString("base64"), format: "wav" }, ...(language ? { language } : {}) }),
      signal: AbortSignal.timeout(o.timeoutMs ?? (Number(process.env.OPENROUTER_STT_TIMEOUT_MS) || 20_000)),
    });
  } catch (e: any) {
    throw new OpenRouterSTTError(`OpenRouter STT unreachable (${e?.name === "TimeoutError" ? "timed out" : e?.message ?? e})`);
  }
  const j = (await res.json().catch(() => null)) as { text?: unknown; usage?: { cost?: unknown; seconds?: unknown }; error?: { message?: unknown } } | null;
  if (!res.ok) {
    const msg = typeof j?.error?.message === "string" ? j.error.message : "";
    const why = res.status === 401 ? "rejected the key: check OPENROUTER_API_KEY" : res.status === 402 ? "out of credit (openrouter.ai/credits)" : `${res.status}${msg ? `: ${msg.slice(0, 160)}` : ""}`;
    throw new OpenRouterSTTError(`OpenRouter STT (${model}) ${why}`, res.status);
  }
  if (!j || typeof j.text !== "string") throw new OpenRouterSTTError(`OpenRouter STT (${model}) sent no text`);
  return {
    text: j.text.trim(),
    ...(typeof j.usage?.cost === "number" ? { cost: j.usage.cost } : {}),
    ...(typeof j.usage?.seconds === "number" ? { seconds: j.usage.seconds } : {}),
  };
}

import {
  AudioInputSource,
  AudioSpeakerRole,
  EventSourceType,
  OsEventTypeList,
  StartUpPageCreateResult,
  type CreateStartUpPageContainer,
  type EvenAppBridge,
  type EvenHubEvent,
  type ListContainerProperty,
  type RebuildPageContainer,
  type TextContainerProperty,
  type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";

// A stand-in for the Even App bridge so the glasses UI can be developed in any browser.
// It draws the page containers onto a 576x288 "lens", and turns buttons / keys / your
// computer's microphone into the same events the G2 temples and R1 ring produce.
// Only the bridge methods main.ts uses are implemented.

type Page = { text: TextContainerProperty[]; list: ListContainerProperty[]; image: any[] };

const CSS = `
  .emu { display: grid; gap: 14px; max-width: 640px; }
  .lens { width: 576px; max-width: 100%; aspect-ratio: 2 / 1; background: #000; border-radius: 18px; position: relative;
    overflow: hidden; box-shadow: 0 0 0 10px #1a1d1c, 0 0 0 11px #2b302e, 0 12px 40px rgba(0,0,0,.5); }
  .lens-inner { position: absolute; inset: 0; transform-origin: top left; width: 576px; height: 288px; }
  .c { position: absolute; color: #4dff91; font: 400 19px/25px "SF Pro Text", -apple-system, system-ui, sans-serif;
    white-space: pre-wrap; overflow: hidden; text-shadow: 0 0 6px rgba(77,255,145,.35); }
  .c.capture { outline: 1px dashed rgba(77,255,145,.15); }
  .item { padding: 1px 8px; border: 1.5px solid transparent; border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .item.sel { border-color: #4dff91; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .controls button { font: 600 14px system-ui; padding: 10px 14px; border-radius: 10px; border: 1px solid #2d3a33;
    background: #141917; color: #cfe8d8; cursor: pointer; min-height: 44px; }
  .controls button:active, .controls button.live { background: #4dff91; color: #04140b; }
  .controls label { font: 13px system-ui; color: #8b9690; display: flex; gap: 6px; align-items: center; }
  .keys { font: 12px system-ui; color: #8b9690; }
`;

export function createEmulatorBridge(mount: HTMLElement): EvenAppBridge {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  mount.innerHTML = `
    <div class="emu">
      <div class="lens"><div class="lens-inner"></div></div>
      <div class="controls">
        <button data-g="up">▲ Swipe up</button>
        <button data-g="tap">● Tap</button>
        <button data-g="double">●● Double</button>
        <button data-g="down">▼ Swipe down</button>
        <button data-g="hold">🎙 Hold to talk</button>
        <label><input type="checkbox" checked id="emu-ring" /> from ring</label>
      </div>
      <div class="keys">Keys: ↑/↓ swipe · Enter tap · Backspace double · hold Space to talk</div>
    </div>`;
  const lens = mount.querySelector<HTMLElement>(".lens")!;
  const inner = mount.querySelector<HTMLElement>(".lens-inner")!;
  const ringBox = mount.querySelector<HTMLInputElement>("#emu-ring")!;
  new ResizeObserver(() => (inner.style.transform = `scale(${lens.clientWidth / 576})`)).observe(lens);

  const listeners = new Set<(e: EvenHubEvent) => void>();
  const emit = (e: EvenHubEvent) => listeners.forEach((l) => l(e));
  let page: Page = { text: [], list: [], image: [] };
  const bitmaps = new Map<number, ImageBitmap>();
  let selected = 0;

  function draw() {
    inner.innerHTML = "";
    type Geo = { xPosition?: number; yPosition?: number; width?: number; height?: number; paddingLength?: number; isEventCapture?: number; borderWidth?: number; borderColor?: number; borderRadius?: number };
    const place = (el: HTMLElement, c: Geo) => {
      el.className = "c" + (c.isEventCapture ? " capture" : "");
      Object.assign(el.style, { left: `${c.xPosition ?? 0}px`, top: `${c.yPosition ?? 0}px`, width: `${c.width ?? 576}px`, height: `${c.height ?? 288}px`, padding: `${c.paddingLength ?? 0}px` });
      // Firmware borders: width in px, colour = one of the 16 green levels, square or round corners.
      if (c.borderWidth) {
        el.style.border = `${c.borderWidth}px solid rgba(77,255,145,${((c.borderColor ?? 15) + 1) / 16})`;
        el.style.borderRadius = `${c.borderRadius ?? 0}px`;
      }
      el.style.boxSizing = "border-box";
      inner.append(el);
    };
    for (const t of page.text) {
      const el = document.createElement("div");
      el.textContent = t.content ?? "";
      el.style.opacity = String(((t.textColor ?? 4) + 1) / 5);
      place(el, t);
    }
    for (const im of page.image) {
      const c = document.createElement("canvas");
      c.width = im.width;
      c.height = im.height;
      // Stacking follows draw order (text, then images, then lists) unless a page sets z itself.
      Object.assign(c.style, { position: "absolute", left: `${im.xPosition}px`, top: `${im.yPosition}px`, width: `${im.width}px`, height: `${im.height}px`, imageRendering: "pixelated" });
      if (im.zOrderIndex !== undefined) c.style.zIndex = String(im.zOrderIndex);
      const bmp = bitmaps.get(im.containerID);
      if (bmp) {
        const ctx = c.getContext("2d")!;
        ctx.drawImage(bmp, 0, 0, im.width, im.height);
        // greyscale → the lens' green
        const d = ctx.getImageData(0, 0, im.width, im.height);
        for (let i = 0; i < d.data.length; i += 4) {
          const v = d.data[i];
          d.data[i] = v * 0.3;
          d.data[i + 1] = v;
          d.data[i + 2] = v * 0.57;
        }
        ctx.putImageData(d, 0, 0);
      }
      inner.append(c);
    }
    for (const l of page.list) {
      const el = document.createElement("div");
      const names = l.itemContainer?.itemName ?? [];
      selected = Math.min(selected, Math.max(0, names.length - 1));
      // Keep the selection in view like the firmware list does.
      const perPage = Math.max(1, Math.floor(((l.height ?? 288) - 2 * (l.paddingLength ?? 0)) / 29));
      const first = Math.max(0, Math.min(selected - perPage + 1, names.length - perPage));
      names.slice(first, first + perPage).forEach((n, i) => {
        const item = document.createElement("div");
        item.className = "item" + (first + i === selected && l.itemContainer?.isItemSelectBorderEn ? " sel" : "");
        item.textContent = n;
        el.append(item);
      });
      place(el, l);
    }
  }

  const capture = () => page.list.find((l) => l.isEventCapture) ?? page.text.find((t) => t.isEventCapture);

  const TYPE = {
    tap: OsEventTypeList.CLICK_EVENT,
    double: OsEventTypeList.DOUBLE_CLICK_EVENT,
    up: OsEventTypeList.SCROLL_TOP_EVENT,
    down: OsEventTypeList.SCROLL_BOTTOM_EVENT,
    hold: OsEventTypeList.LONG_PRESS_EVENT,
    release: OsEventTypeList.LONG_PRESS_RELEASE_EVENT,
  } as const;

  function gesture(g: keyof typeof TYPE) {
    const eventType = TYPE[g] === OsEventTypeList.CLICK_EVENT ? undefined : TYPE[g]; // mirror the SDK's CLICK quirk
    const eventSource = ringBox.checked ? EventSourceType.TOUCH_EVENT_FROM_RING : EventSourceType.TOUCH_EVENT_FROM_GLASSES_R;
    const c = capture();
    const list = page.list.find((l) => l === c);
    if (list && (g === "up" || g === "down")) {
      const n = list.itemContainer?.itemName?.length ?? 0;
      selected = Math.max(0, Math.min(n - 1, selected + (g === "down" ? 1 : -1)));
      draw();
    }
    // Source-aware event first (as on current firmware), then the container's own event.
    emit({ sysEvent: { eventType, eventSource } as any });
    if (g === "hold" || g === "release" || !c) return;
    if (list)
      emit({ listEvent: { containerID: list.containerID, containerName: list.containerName, currentSelectItemIndex: selected, currentSelectItemName: list.itemContainer?.itemName?.[selected], eventType } as any });
    else emit({ textEvent: { containerID: c.containerID, containerName: c.containerName, eventType } as any });
  }

  // ---- input wiring ----
  let holding = false;
  const hold = (on: boolean) => {
    if (on === holding) return;
    holding = on;
    mount.querySelector('[data-g="hold"]')!.classList.toggle("live", on);
    gesture(on ? "hold" : "release");
  };
  mount.querySelectorAll<HTMLButtonElement>("[data-g]").forEach((b) => {
    const g = b.dataset.g as keyof typeof TYPE;
    if (g === "hold") {
      b.addEventListener("pointerdown", () => hold(true));
      b.addEventListener("pointerup", () => hold(false));
      b.addEventListener("pointerleave", () => hold(false));
    } else b.addEventListener("click", () => gesture(g));
  });
  window.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const g = ({ ArrowUp: "up", ArrowDown: "down", Enter: "tap", Backspace: "double" } as const)[e.key as "Enter"];
    if (g) {
      e.preventDefault();
      gesture(g);
    } else if (e.key === " " && !e.repeat) {
      e.preventDefault();
      hold(true);
    }
  });
  window.addEventListener("keyup", (e) => e.key === " " && hold(false));

  // ---- microphone: browser mic -> 16 kHz s16le mono, like the G2 array ----
  let mic: { stop(): void } | null = null;
  async function startMic(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const ratio = ctx.sampleRate / 16000;
      proc.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        const out = new Int16Array(Math.floor(input.length / ratio));
        for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)])) * 0x7fff;
        emit({ audioEvent: { audioPcm: new Uint8Array(out.buffer), source: AudioInputSource.Glasses, direction: null, speakerRole: AudioSpeakerRole.Unknown } as any });
      };
      src.connect(proc);
      proc.connect(ctx.destination);
      mic = { stop: () => (proc.disconnect(), src.disconnect(), stream.getTracks().forEach((t) => t.stop()), ctx.close()) };
      return true;
    } catch {
      return false;
    }
  }

  const store = (k: string) => `emu:${k}`;
  const bridge = {
    async createStartUpPageContainer(c: CreateStartUpPageContainer) {
      page = { text: c.textObject ?? [], list: c.listObject ?? [], image: c.imageObject ?? [] };
      draw();
      return StartUpPageCreateResult.success;
    },
    async rebuildPageContainer(c: RebuildPageContainer) {
      page = { text: c.textObject ?? [], list: c.listObject ?? [], image: c.imageObject ?? [] };
      bitmaps.clear();
      selected = 0;
      draw();
      return true;
    },
    async textContainerUpgrade(u: TextContainerUpgrade) {
      const t = page.text.find((x) => x.containerID === u.containerID);
      if (!t) return false;
      t.content = u.content;
      if (u.textColor !== undefined) t.textColor = u.textColor;
      draw();
      return true;
    },
    async updateImageRawData(u: any) {
      try {
        bitmaps.set(u.containerID, await createImageBitmap(new Blob([new Uint8Array(u.imageData)], { type: "image/png" })));
        draw();
        await new Promise((r) => setTimeout(r, 60)); // a little like the real link, so games behave similarly
        return "success";
      } catch {
        return "imageException";
      }
    },
    async audioControl(open: boolean) {
      if (!open) {
        mic?.stop();
        mic = null;
        return true;
      }
      return mic ? true : startMic();
    },
    onEvenHubEvent(cb: (e: EvenHubEvent) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async getLocalStorage(k: string) {
      try {
        return localStorage.getItem(store(k)) ?? "";
      } catch {
        return "";
      }
    },
    async setLocalStorage(k: string, v: string) {
      try {
        localStorage.setItem(store(k), v);
      } catch {}
      return true;
    },
  };
  return bridge as unknown as EvenAppBridge;
}

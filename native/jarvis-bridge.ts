/**
 * Makes the native BLE driver look like the Even App's bridge, so the exact same Jarvis glasses app
 * (glasses/src/app.ts) runs on a Mac talking to the glasses directly, with no Even App involved.
 * Only the bridge calls the Jarvis app uses are implemented.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { G2Driver, InputDetail } from "./driver/src/driver.ts";
import type { Gesture, InputSource, PageSpec } from "./driver/src/messages/evenhub.ts";

// Even Hub SDK enum values (OsEventTypeList / EventSourceType), so app code sees what it expects.
const EVENT: Record<Gesture, number | undefined> = {
  tap: undefined, // the SDK reports CLICK (0) as undefined
  scroll_up: 1,
  scroll_down: 2,
  double_tap: 3,
  foreground_enter: 4,
  foreground_exit: 5,
  abnormal_exit: 6,
  system_exit: 7,
  long_press: 9,
  long_press_release: 10,
};
const SOURCE: Record<InputSource, number> = { unknown: 0, glasses_right: 1, ring: 2, glasses_left: 3 };

const STORE = join(homedir(), ".g2-orchestrator", "native-storage.json");

export function nativeBridge(g2: G2Driver) {
  const listeners = new Set<(e: any) => void>();
  const emit = (e: any) => listeners.forEach((l) => l(e));
  let stopMic: (() => void) | null = null;

  g2.onInput((gesture: Gesture, source: InputSource, d: InputDetail) => {
    const eventType = EVENT[gesture];
    if (d.via === "list")
      emit({ listEvent: { containerID: d.containerId, containerName: d.containerName, currentSelectItemIndex: d.itemIndex, currentSelectItemName: d.itemName, eventType } });
    else if (d.via === "text") emit({ textEvent: { containerID: d.containerId, containerName: d.containerName, eventType } });
    else emit({ sysEvent: { eventType, eventSource: SOURCE[source] } });
  });

  const spec = (c: any): PageSpec => ({
    text: c.textObject?.map((t: any) => ({
      id: t.containerID, name: t.containerName, x: t.xPosition ?? 0, y: t.yPosition ?? 0, width: t.width ?? 576, height: t.height ?? 288,
      borderWidth: t.borderWidth, borderColor: t.borderColor, borderRadius: t.borderRadius, paddingLength: t.paddingLength,
      captureEvents: !!t.isEventCapture, content: t.content ?? "",
    })),
    list: c.listObject?.map((l: any) => ({
      id: l.containerID, name: l.containerName, x: l.xPosition ?? 0, y: l.yPosition ?? 0, width: l.width ?? 576, height: l.height ?? 288,
      borderWidth: l.borderWidth, borderColor: l.borderColor, borderRadius: l.borderRadius, paddingLength: l.paddingLength,
      captureEvents: !!l.isEventCapture, items: l.itemContainer?.itemName ?? [], itemWidth: l.itemContainer?.itemWidth,
      selectBorder: l.itemContainer?.isItemSelectBorderEn !== 0,
    })),
    image: c.imageObject?.map((i: any) => ({ id: i.containerID, name: i.containerName, x: i.xPosition ?? 0, y: i.yPosition ?? 0, width: i.width, height: i.height })),
  });

  const storage = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(STORE, "utf8"));
    } catch {
      return {};
    }
  };

  return {
    async createStartUpPageContainer(c: any) {
      await g2.createPage(spec(c));
      return 0; // StartUpPageCreateResult.success
    },
    async rebuildPageContainer(c: any) {
      await g2.rebuildPage(spec(c));
      return true;
    },
    async textContainerUpgrade(u: any) {
      await g2.setText(u.containerID, u.content ?? "");
      return true;
    },
    async updateImageRawData(u: any) {
      return (await g2.setImage(u.containerID, Uint8Array.from(u.imageData), u.containerName)) ? "success" : "sendFailed";
    },
    /** The glasses send LC3 audio; PCM needs a decoder (G2Driver option `lc3`). Without one the mic reports unavailable. */
    async audioControl(open: boolean) {
      if (!open) {
        stopMic?.();
        stopMic = null;
        await g2.stopMic();
        return true;
      }
      let gotPcm = false;
      stopMic = await g2.startMic((chunk) => {
        if (!chunk.pcm) return;
        gotPcm = true;
        emit({ audioEvent: { audioPcm: chunk.pcm, source: "glasses", direction: null, speakerRole: "unknown" } });
      });
      // Report failure if no decoder is configured (no PCM within 1.5 s).
      await new Promise((r) => setTimeout(r, 1500));
      return gotPcm || process.env.G2_ASSUME_MIC === "1";
    },
    onEvenHubEvent(cb: (e: any) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async getLocalStorage(k: string) {
      return storage()[k] ?? "";
    },
    async setLocalStorage(k: string, v: string) {
      mkdirSync(join(homedir(), ".g2-orchestrator"), { recursive: true });
      writeFileSync(STORE, JSON.stringify({ ...storage(), [k]: v }));
      return true;
    },
  };
}

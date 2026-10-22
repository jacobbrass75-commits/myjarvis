// Page geometry rules for the lens, as plain functions (no SDK, no DOM) so tests can run them in Node.
// The iPhone app (G2Kit EvenHub.validatePage) rejects most of these anyway; failing here first says why.

export const LENS_W = 576;
export const LENS_H = 288;

/** Columns of the glasses' own font that fit in a box (about 12.5 px per character; tune with LENS TEST). */
export const colsFor = (w: number, pad = 6, border = 0) => Math.max(1, Math.floor((w - 2 * pad - 2 * border) / 12.5));
/** Lines that fit (about 36 px per line; tune with LENS TEST). */
export const rowsFor = (h: number, pad = 6) => Math.max(1, Math.floor((h - 2 * pad) / 36));

type Geo = { xPosition?: number; yPosition?: number; width?: number; height?: number; containerID?: number; containerName?: string };
type TextLike = Geo & { content?: string; isEventCapture?: number };
export interface PageLike {
  containerTotalNum?: number;
  textObject?: TextLike[];
  listObject?: (Geo & { isEventCapture?: number; itemContainer?: { itemName?: string[] } })[];
  imageObject?: Geo[];
}

const box = (c: Geo) => ({ x: c.xPosition ?? 0, y: c.yPosition ?? 0, w: c.width ?? LENS_W, h: c.height ?? LENS_H });
const overlap = (a: Geo, b: Geo) => {
  const p = box(a), q = box(b);
  return p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
};
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Throws on a page the glasses would reject or draw wrongly. */
export function checkLayout(page: PageLike): void {
  const text = page.textObject ?? [], list = page.listObject ?? [], image = page.imageObject ?? [];
  const all: Geo[] = [...text, ...list, ...image];
  const fail = (s: string) => {
    throw new Error(`layout: ${s}`);
  };
  if (!all.length) fail("no containers");
  if (all.length > 12) fail(`${all.length} containers (max 12)`);
  if (text.length + list.length > 8) fail(`${text.length + list.length} text+list containers (max 8)`);
  if (image.length > 4) fail(`${image.length} images (max 4)`);
  if (page.containerTotalNum !== undefined && page.containerTotalNum !== all.length) fail(`containerTotalNum ${page.containerTotalNum} but ${all.length} containers`);
  const ids = new Set<number>(), names = new Set<string>();
  for (const c of all) {
    const id = c.containerID ?? -1, name = c.containerName ?? "";
    if (ids.has(id)) fail(`duplicate id ${id}`);
    ids.add(id);
    if (!name) fail(`container ${id} has no name`);
    if (name.length > 14) fail(`name "${name}" is longer than 14`);
    if (names.has(name)) fail(`duplicate name "${name}"`);
    names.add(name);
    const b = box(c);
    if (b.x < 0 || b.y < 0 || b.w <= 0 || b.h <= 0 || b.x + b.w > LENS_W || b.y + b.h > LENS_H) fail(`${name} (${b.x},${b.y} ${b.w}x${b.h}) is outside 576x288`);
  }
  for (const t of text) {
    if (!t.content) fail(`${t.containerName} has empty text (use " ")`);
    else if (bytes(t.content) > 1000) fail(`${t.containerName} has ${bytes(t.content)} bytes of text (max 1000)`);
  }
  for (const im of image) {
    const b = box(im);
    if (b.w < 20 || b.w > 288 || b.h < 20 || b.h > 144) fail(`${im.containerName} is ${b.w}x${b.h} (images are 20..288 x 20..144)`);
  }
  // Which of two overlapping containers shows is up to the firmware; only the blank input catcher may.
  const hidden = (t: TextLike) => !!t.isEventCapture && !(t.content ?? "").trim();
  for (const t of [...text.filter((t) => !hidden(t)), ...list])
    for (const im of image) if (overlap(t, im)) fail(`${t.containerName} overlaps ${im.containerName}`);
  for (let i = 0; i < image.length; i++) for (let j = i + 1; j < image.length; j++) if (overlap(image[i], image[j])) fail(`${image[i].containerName} overlaps ${image[j].containerName}`);
  const captures = [...text, ...list].filter((c) => c.isEventCapture).length;
  if (captures !== 1) fail(`${captures} containers capture input (exactly 1)`);
}

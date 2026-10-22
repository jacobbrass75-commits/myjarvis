// Fixed inputs for the SKY tests and previews.

/** ISS elements from CelesTrak, epoch 2026-10-21 01:09 UTC (frozen for repeatable passes). */
export const ISS_TLE = {
  l1: "1 25544U 98067A   26294.04791053  .00009575  00000+0  18188-3 0  9996",
  l2: "2 25544  51.6327  37.2623 0006759 289.5321  70.4938 15.48967427591263",
};

/** Berkeley, CA. */
export const BERKELEY = { lat: 37.87, lon: -122.27 };

/** Reference night: 2026-10-22 04:30 UTC = Oct 21, 9:30 PM PDT (Orionids peak, Moon waxing gibbous). */
export const REF_NIGHT = Date.UTC(2026, 9, 22, 4, 30);
/** Reference day: 2026-10-21 20:00 UTC = 1 PM PDT. */
export const REF_DAY = Date.UTC(2026, 9, 21, 20, 0);

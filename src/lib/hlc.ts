// Hybrid logical clock encoded as a lexicographically sortable string:
// <13-digit wall ms>-<4-digit counter>-<device id>. Comparing strings compares clocks.

const MAX_COUNTER = 9999; // the counter field is four digits; a fifth would break string order

let lastWall = 0;
let counter = 0;

export function hlcNow(device: string): string {
  const now = Date.now();
  if (now > lastWall) {
    lastWall = now;
    counter = 0;
  } else if (counter < MAX_COUNTER) {
    counter++;
  } else {
    // Over 10k stamps in one millisecond (a bulk write): borrow the next millisecond.
    lastWall++;
    counter = 0;
  }
  return encode(lastWall, counter, device);
}

/** Advance the local clock past a remote stamp so our next write sorts after it. */
export function hlcObserve(remote: string) {
  if (!/^\d{13}-\d{4}-.+$/.test(remote)) return;
  const [wallStr, countStr] = remote.split("-");
  const wall = Number(wallStr);
  const count = Number(countStr);
  if (!Number.isFinite(wall) || !Number.isFinite(count)) return;
  if (wall > lastWall || (wall === lastWall && count > counter)) {
    lastWall = wall;
    counter = count;
  }
}

function encode(wall: number, count: number, device: string) {
  return `${String(wall).padStart(13, "0")}-${String(count).padStart(4, "0")}-${device}`;
}

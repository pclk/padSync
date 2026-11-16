// Hybrid logical clock encoded as a lexicographically sortable string:
// <13-digit wall ms>-<4-digit counter>-<device id>. Comparing strings compares clocks.

let lastWall = 0;
let counter = 0;

export function hlcNow(device: string): string {
  const now = Date.now();
  if (now > lastWall) {
    lastWall = now;
    counter = 0;
  } else {
    counter++;
  }
  return encode(lastWall, counter, device);
}

/** Advance the local clock past a remote stamp so our next write sorts after it. */
export function hlcObserve(remote: string) {
  const [wallStr, countStr] = remote.split("-");
  const wall = Number(wallStr);
  const count = Number(countStr);
  if (wall > lastWall || (wall === lastWall && count > counter)) {
    lastWall = wall;
    counter = count;
  }
}

function encode(wall: number, count: number, device: string) {
  return `${String(wall).padStart(13, "0")}-${String(count).padStart(4, "0")}-${device}`;
}

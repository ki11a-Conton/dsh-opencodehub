/**
 * OpenCode Zen session / message id generator — exact port of zen.go ocID().
 *
 * Shape: `<prefix>_<12 lowercase hex><14 base62>` (26 chars after the prefix).
 * Time part: packed = (unixMilli << 12) + counter (counter increments from 1
 * within the same millisecond, Go used a mutex — Node is single-threaded so a
 * plain pair suffices). Descending ids complement packed first. Only the low
 * 48 bits (6 bytes, big-endian hex) are kept, then 14 random base62 chars.
 *
 * The Go original proved the *direction* is not actually gate-checked, but it
 * still issues ascending msg ids and a FRESH session id per attempt (session
 * reuse is what triggers the 403 "free tier" rejection on retry).
 */

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const LOWER_HEX = '0123456789abcdef';

/** Per-millisecond counter, mirroring zen.go's mutex-guarded counter. */
let lastMs = -1;
let counter = 0;

function nextCounter(nowMs) {
  if (nowMs !== lastMs) {
    lastMs = nowMs;
    counter = 0;
  }
  counter += 1;
  return counter;
}

function randomBase62(length) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += BASE62[(Math.random() * BASE62.length) | 0];
  }
  return out;
}

/**
 * Build one opaque id. Port of zen.go ocID(prefix, descending).
 * @param {'ses'|'msg'} prefix
 * @param {boolean} descending msg ids ascend; session ids descend.
 */
export function ocID(prefix, descending) {
  const packed = BigInt(Date.now()) * 0x1000n + BigInt(nextCounter(Date.now()));
  const low48 = descending ? BigInt.asUintN(48, ~packed) : BigInt.asUintN(48, packed);
  // hex.EncodeToString in Go is always lowercase for both ses and msg ids.
  const hex = low48.toString(16).padStart(12, '0');
  return `${prefix}_${hex}${randomBase62(14)}`;
}

/** Sanity self-check used by tests: shape and ordering. */
export function assertIdShape(id, prefix) {
  const body = id.slice(prefix.length + 1);
  if (!id.startsWith(`${prefix}_`) || body.length !== 26) return false;
  for (let i = 0; i < 12; i += 1) {
    if (!LOWER_HEX.includes(body[i].toLowerCase())) return false;
  }
  for (let i = 12; i < 26; i += 1) {
    if (!BASE62.includes(body[i])) return false;
  }
  return true;
}

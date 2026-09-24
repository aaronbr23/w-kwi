// Minimal .zip reader for project import: central directory + local headers, store/deflate only.
// No zip64, no encryption, no data-descriptor-only entries - those are skipped with a console.log
// (not a hard failure) rather than sunk into a hand-rolled edge case. Uses only node:zlib
// (inflateRawSync handles raw DEFLATE, method 8 - what virtually every zip tool produces).
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, LOCAL_SIG = 0x04034b50;
const MAX_ENTRY_SIZE = 100 * 1024 * 1024; // cap decompressed size per entry, zip-bomb guard

/** Returns a flat map of {path: textContent} for every readable file entry in the zip. */
export function unzip(buf: Buffer): Record<string, string> {
  let eocd = -1;
  const searchFrom = Math.max(0, buf.length - 22 - 0xffff); // EOCD comment can be up to 64KiB
  for (let i = buf.length - 22; i >= searchFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip file (no end-of-central-directory record found)');

  const cdCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const out: Record<string, string> = {};

  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(cdOffset) !== CD_SIG) throw new Error('Malformed zip central directory');
    const flags = buf.readUInt16LE(cdOffset + 8);
    const method = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);
    cdOffset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry, no data
    if (flags & 1) { console.log(`unzip: skipping encrypted entry "${name}" (not supported)`); continue; }
    if (compSize === 0xffffffff) { console.log(`unzip: skipping zip64 entry "${name}" (not supported)`); continue; }
    if (method !== 0 && method !== 8) { console.log(`unzip: skipping "${name}" - unsupported compression method ${method}`); continue; }

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`Malformed zip local header for "${name}"`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    if (raw.length > MAX_ENTRY_SIZE) { console.log(`unzip: skipping "${name}" - compressed size exceeds cap`); continue; }
    let data: Buffer;
    try {
      data = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_SIZE });
    } catch { console.log(`unzip: skipping "${name}" - failed to inflate or exceeded ${MAX_ENTRY_SIZE} byte cap`); continue; }
    out[name] = data.toString('utf8');
  }
  return out;
}

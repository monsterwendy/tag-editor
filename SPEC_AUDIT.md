# Tag Editor — Spec Compliance Audit

Audited: `index.html` (v1.5.0)
Date: 2026-05-01
Specs referenced: ID3v2.3.0, ID3v2.4.0-structure, RFC 9639 (FLAC), OGG Framing spec, Vorbis I Comment spec, RFC 7845 (Opus in OGG), ISO BMFF / MP4, VorbisComment wiki (METADATA_BLOCK_PICTURE)

---

## CRITICAL — Data Corruption Possible

### 1. OGG: Multi-page comment write duplicates stale pages
**Spec:** OGG Framing — pages carry packets across boundaries; the comment packet can span pages 1, 2, ...N
**Code:** `writeOggComments` (line ~1727) always copies original pages from index 2 onward: `for (let i = 2; i < pages.length; i++)`
**Bug:** If the original comment packet spanned pages 1, 2, 3 (e.g., large embedded art), the writer replaces only page 1 with the new comment pages, then copies pages 2 and 3 verbatim — which are stale comment continuation pages. The output file contains duplicate/corrupt comment data mixed into the audio stream.
The `seqDelta` calculation (`newPages.length - 1`) is also wrong — it assumes only 1 original page was replaced, but multi-page comments replace N pages.
**Fix:** Track how many original pages the comment packet occupied (info available during `parseOggComments` since it walks pages 1..N). Store that count in `parsedMeta`. In the writer, skip that many pages instead of always starting at index 2. Compute `seqDelta = newPages.length - originalCommentPageCount`.

### 2. ID3v2: Extended header not skipped
**Spec:** ID3v2.3.0 §3.2 — "The extended header contains information that is not vital to the correct parsing of the tag ... If bit 6 [of flags] is set, the header is followed by an extended header."
**Code:** `parseId3` (line ~1851) starts parsing frames at `offset = 10` unconditionally. The flags byte at `bytes[5]` is never checked.
**Bug:** If bit 6 of the flags byte is set, an extended header immediately follows the 10-byte tag header. The parser would interpret the extended header bytes as frame data, producing garbage tags. ID3v2.3 extended header is 6 or 10 bytes; ID3v2.4 uses a synchsafe-sized extended header.
**Fix:** After reading flags byte, check `flags & 0x40`. If set:
- v2.3: Read 4-byte big-endian size, skip `size + 4` bytes (size excludes itself but includes padding size)
- v2.4: Read 4-byte synchsafe size, skip `size` bytes (size includes itself)

### 3. ID3v2: Unsynchronisation not reversed
**Spec:** ID3v2.3.0 §5 — "Whenever a false synchronisation is found within the tag, one zeroed byte is inserted ... The 'unsynchronisation flag' in the header indicates if the tag has been unsynchronised."
In v2.4, unsynchronisation can also be per-frame (frame flag bit 1 of second flag byte).
**Code:** Neither `parseId3` nor frame extraction code checks or reverses unsynchronisation. The unsync flag (bit 7 of `bytes[5]`) is ignored.
**Bug:** Files with unsynchronisation enabled have `$FF $00` byte pairs inserted throughout the tag data. Without reversing this, frame sizes are wrong (extra bytes), text data contains stray null bytes, and binary frames (APIC) are corrupted. This affects any file written by a tool that enables unsynchronisation.
**Fix:** After reading the tag header, if `flags & 0x80`:
- v2.3: Reverse unsync on the entire tag data block (replace `FF 00` → `FF`)
- v2.4: Check per-frame flag instead; reverse unsync on individual frame data when the frame's unsync flag is set

---

## MAJOR — Incorrect Output or Wrong Values

### 4. ID3: writeId3 writes v2.3 header but uses UTF-8 encoding (invalid)
**Spec:** ID3v2.3.0 — encoding byte values: `$00` = ISO-8859-1, `$01` = UTF-16 with BOM. Only two encodings exist in v2.3. Encoding byte `$03` (UTF-8) was introduced in ID3v2.4.
**Code:** `writeId3` (line ~2021) writes header version `0x03 0x00` (v2.3) but all text frames use encoding byte 3 (UTF-8) at lines 1967, 1976, 1985, 1991, 1999.
**Bug:** Creates technically invalid ID3v2.3 tags. Most modern players handle this gracefully, but strict parsers (e.g., some car head units, older firmware) may display garbage for non-ASCII text or reject the tag entirely.
**Fix:** Either change header to v2.4 (`out[3] = 0x04`) — but then frame sizes must use synchsafe encoding — or use encoding byte 1 (UTF-16 with BOM) for v2.3 compatibility. Switching to v2.4 is the cleaner option since the reader already handles v2.4.

### 5. Opus: Duration doesn't subtract pre-skip
**Spec:** RFC 7845 §4 — "The granule position of the first audio data page ... is the number of samples at 48 kHz ... For computing duration, the pre-skip value MUST be subtracted."
**Code:** `parseAudioInfo` Opus section (line ~2618): `info.duration = Number(lastPage.granule) / 48000`
**Bug:** Duration is inflated by pre-skip / 48000 seconds. Default pre-skip is 3840 samples = 80ms. For a 3-minute track, this is negligible but technically wrong. For tools that rely on exact duration (gapless playback, concatenation), it matters.
**Fix:** Read pre-skip from OpusHead at offset 10-11 (uint16le): `const preskip = dv.getUint16(10, true); info.duration = (Number(lastPage.granule) - preskip) / 48000;`

### 6. MP3: Bitrate table only covers MPEG1 Layer III
**Spec:** ISO 11172-3 / ISO 13818-3 — MPEG1 and MPEG2/2.5 have different bitrate index tables. Layer I, II, and III each have their own table.
**Code:** `parseAudioInfo` MP3 section (line ~2527): `const MP3_BITRATES = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0]` — this is MPEG1 Layer III only.
**Bug:** For MPEG2/2.5 Layer III files (common for low-bitrate podcasts, audiobooks), the bitrate lookup is wrong. MPEG2 Layer III bitrates are: [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0]. Reported bitrate would be wildly off (e.g., index 5 = 64 instead of 40). Duration estimate (CBR fallback) would also be wrong.
**Fix:** Select bitrate table based on MPEG version. Add MPEG2/2.5 table. The version is already decoded as `mpegVer` for VBR detection — move that earlier and use it for bitrate lookup too.

### 7. MP3: Sample rate table only covers MPEG1
**Spec:** Same as above — MPEG2 sample rates are [22050, 24000, 16000, 0] and MPEG2.5 rates are [11025, 12000, 8000, 0].
**Code:** `const MP3_SAMPLERATES = [44100,48000,32000,0]` (line ~2528)
**Bug:** MPEG2/2.5 files would get wrong sample rate (e.g., a 22050Hz podcast reported as 44100Hz). This also breaks VBR duration calculation since it divides by sampleRate.
**Fix:** Select sample rate table based on MPEG version bits.

### 8. ID3v2.4: Footer not accounted for in headerSize
**Spec:** ID3v2.4.0-structure §3.4 — "A footer ... MUST be added ... A footer is a copy of the header, but with a different identifier." The footer is 10 bytes. tagSize does NOT include the footer.
**Code:** `const headerSize = 10 + tagSize` (line ~1833). For v2.4 files with a footer, audio data starts at `10 + tagSize + 10`, but the code assumes it starts at `10 + tagSize`.
**Bug:** When saving an MP3 that was originally v2.4 with footer, `currentBuffer.slice(parsedMeta.headerSize)` includes the 10-byte footer as "audio data". The footer bytes (starting with "3DI") would be treated as the first few bytes of audio — causing a click/pop or sync issues.
**Fix:** Check footer flag (bit 4 of flags byte, v2.4 only): `if (majorVer >= 4 && (bytes[5] & 0x10)) headerSize += 10;`

### 9. M4A: Extended atom size (size=1) not handled
**Spec:** ISO 14496-12 §4.2 — "if size is 1 then the actual size is in the field largesize" (64-bit integer at bytes 8-15 of the atom).
**Code:** `atomAt` (line ~966) and `walkAtoms` (line ~2636) both reject atoms with `size < 8`.
**Bug:** Any M4A file with an atom using 64-bit extended size (required for atoms >4GB, sometimes used by muxers for mdat even in smaller files) would fail to parse. The moov/ilst wouldn't be found if any preceding atom uses extended size.
**Fix:** When size === 1, read 8-byte big-endian size from bytes 8-15, set data offset to 16 instead of 8.

### 10. FLAC: writeFlacWithArt removes ALL PICTURE blocks
**Spec:** RFC 9639 §8.8 — PICTURE blocks have a picType field (0-20). Type 3 = front cover, type 4 = back cover, type 8 = artist, etc.
**Code:** `writeFlacWithArt` (line ~693): `const filtered = blocks.filter(b => b.type !== 6)` removes every metadata block with type 6 (PICTURE), regardless of the picture type encoded within the block data.
**Bug:** If a FLAC file has front cover (picType 3), back cover (picType 4), and artist photo (picType 8), saving with updated front cover art silently deletes the back cover and artist photo. This is the exact same class of bug as OGG fix #5 (which was fixed for OGG but not for FLAC).
**Fix:** Parse each PICTURE block's picType (first 4 bytes of block data, big-endian uint32). Only remove blocks with picType === 3. Preserve all others.

### 11. ID3v2: Frame flags (compression, grouping) ignored
**Spec:** ID3v2.3.0 §3.3.2 — Frame flag byte 2: bit 7 = compression (zlib, with 4-byte decompressed-size prefix), bit 6 = encryption, bit 5 = grouping identity (1 extra byte).
**Code:** Frame flags at `bytes[offset+8]` and `bytes[offset+9]` are never read. The frame data is read raw from `ds = offset + 10`.
**Bug:** If a frame has compression enabled, there's a 4-byte decompressed size before the zlib-compressed data. The parser would try to decode compressed bytes as text, producing garbage. Grouping identity adds 1 byte before the frame data. While compressed frames are uncommon, they exist in some tagging tools' output.
**Fix:** Read frame flags. If compression bit is set, skip 4-byte decompressed size and inflate the remaining data. If grouping bit is set, skip 1 byte. If encryption bit is set, skip frame (can't decrypt).

---

## MINOR — Edge Cases or Cosmetic Issues

### 12. MP3: MPEG layer not validated
**Code:** Frame sync detection (line ~2530) matches any MPEG audio frame (`0xFF` + `(byte & 0xE0) === 0xE0`). This includes Layer I, II, and III. The bitrate table and samples-per-frame values are Layer III specific.
**Impact:** Layer I files (rare, .mp1) would get wrong bitrate. Layer II files (.mp2, used in some broadcast) would also be wrong. Low real-world impact since .mp3 files are almost always Layer III.
**Fix:** Extract layer bits: `const layer = (bytes[i+1] >> 1) & 0x3`. Validate `layer === 1` (Layer III) before using the table.

### 13. M4A: Atom size=0 (extends to EOF) not handled
**Spec:** ISO 14496-12 §4.2 — "if size is 0 then box extends to end of file."
**Code:** `atomAt` rejects size < 8, and `walkAtoms` breaks on `off + size > endOff`.
**Impact:** The mdat atom sometimes uses size=0 in streaming/progressive files. Since mdat isn't needed for tag parsing (it comes after moov in most files), this rarely matters. But if mdat with size=0 appears before moov, moov scan would never find it.
**Fix:** When size === 0, compute size as `endOff - off`.

### 14. ID3: v2.4 → v2.3 downgrade on save
**Code:** `writeId3` always writes a v2.3 header, even if the file was originally v2.4. Frame sizes use regular uint32 (correct for v2.3) but encoding uses UTF-8 (see issue #4).
**Impact:** v2.4-specific features are silently lost on save: footer, per-frame unsync, restriction flags. The frame size encoding change (synchsafe → regular) could cause issues for strict v2.4 readers if the file is later re-tagged by a v2.4-aware tool that checks the version.
**Fix:** If original was v2.4, write v2.4 output (synchsafe frame sizes, appropriate flags).

### 15. VBRI comment has wrong offsets
**Code:** Line ~2567: `// bytes: +42, frames: +46 within VBRI header (+36 base)`
**Actual:** VBRI layout: version +4, delay +6, quality +8, bytes +10, frames +14. Absolute from frame start: bytes at i+46, frames at i+50.
**Impact:** Code reads `i + 50` which IS correct (frames at VBRI+14 = 36+14 = 50). Only the comment is misleading.
**Fix:** Update comment to: `// VBRI: version +4, delay +6, quality +8, byteCount +10, frameCount +14; absolute = i+36+14 = i+50`

### 16. OGG: Vorbis comment field names force-uppercased on write
**Spec:** Vorbis I Comment — "Field names are not case sensitive." But the spec doesn't mandate uppercase.
**Code:** `enc.encode(k.toUpperCase() + '=' + v)` in both `writeFlac` and `writeOggComments`.
**Impact:** Files with lowercase field names (common in ffmpeg output) get uppercased on save. This is technically spec-compliant but changes the cosmetic appearance. Some tools that do binary comparison of before/after would flag a change.
**Fix:** None needed — this is compliant behavior. Note for awareness.

### 17. M4A: Only first trak atom searched for audio info
**Code:** `findAtom(moov.off + 8, moov.off + moov.size, 'trak')` at line ~2672 finds the first trak.
**Impact:** If an M4A file has a non-audio first track (unusual but possible for M4A files converted from MP4 video), the audio info would show video track properties. Pure .m4a files always have audio as the first/only track.
**Fix:** Walk all trak atoms and look for one containing an audio handler (hdlr atom with type 'soun').

### 18. Opus: Channel count at wrong OpusHead offset
**Spec:** RFC 7845 §5.1 — OpusHead: magic (8 bytes), version (1 byte at offset 8), channel count (1 byte at offset 9).
**Code:** `info.channels = p0[9]` (line ~2611)
**Status:** ✓ Correct — offset 9 is the channel count field.

### 19. Opus: Sample rate from OpusHead is informational only
**Spec:** RFC 7845 §5.1 — "Input Sample Rate ... This is not the sample rate to use for playback ... Opus can switch between any supported sample rate."
**Code:** `info.sampleRate = dv.getUint32(12, true)` (line ~2613) and displays it as the sample rate.
**Impact:** This is the original input sample rate, which is reasonable to display. Opus always decodes at 48kHz. Displaying 44100 Hz for an Opus file is technically misleading but matches what most tools show.
**Fix:** Consider labeling as "original sample rate" or showing 48000 Hz. Low priority.

---

## Summary by Format

| Format | Critical | Major | Minor |
|--------|----------|-------|-------|
| MP3/ID3 | 2 (#2, #3) | 4 (#4, #6, #7, #8) | 3 (#11, #12, #14) |
| OGG/Opus | 1 (#1) | 1 (#5) | 2 (#16, #19) |
| FLAC | 0 | 1 (#10) | 0 |
| M4A | 0 | 1 (#9) | 2 (#13, #17) |

**Priority order for fixes:**
1. OGG multi-page comment write (#1) — will corrupt files with large embedded art
2. ID3 extended header (#2) — will corrupt tags on files from tools that use extended headers
3. ID3 unsynchronisation (#3) — will corrupt tags on files from tools that enable unsync
4. ID3 v2.3/UTF-8 mismatch (#4) — technically invalid output
5. MP3 MPEG2 bitrate/sample rate (#6, #7) — wrong info for MPEG2 files
6. Opus pre-skip (#5) — wrong duration by ~80ms
7. FLAC PICTURE blocks (#10) — data loss for multi-art files
8. Everything else

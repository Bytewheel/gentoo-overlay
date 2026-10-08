#!/usr/bin/env python3
"""In-place omni.ja rebuilder for the optimized Firefox jar layout.

Layout (verified on rozelynx 154.0 browser/omni.ja):
  [4 magic bytes][central dir @4][EOCD][local headers+data][trailing EOCD]
All entries STORED (method 0). Local header offsets in the CD are absolute.

Usage: rebuild-omni.py <omni.ja> <out.omni.ja>  then read replacements from
a JSON file: {"path/in/jar": "/path/to/new/file", ...}
"""
import json
import struct
import sys
import zlib

OMNI, OUT, REPL = sys.argv[1], sys.argv[2], sys.argv[3]
repl = json.load(open(REPL))

data = open(OMNI, "rb").read()
magic = data[:4]

# --- locate trailing EOCD ---
eocd_tail = data.rfind(b"PK\x05\x06")
assert eocd_tail != -1
(n_total, cd_size, cd_off) = struct.unpack("<HII", data[eocd_tail + 10:eocd_tail + 20])
assert cd_off == 4, cd_off

# --- parse central directory ---
pos = cd_off
entries = []  # dicts: fixed(46B fields), name, extra, comment, lh_off, data
for _ in range(n_total):
    assert data[pos:pos + 4] == b"PK\x01\x02"
    fields = struct.unpack("<IHHHHHHIIIHHHHHII", data[pos:pos + 46])
    nlen, elen, clen = fields[10], fields[11], fields[12]
    name = data[pos + 46:pos + 46 + nlen].decode("utf-8")
    extra = data[pos + 46 + nlen:pos + 46 + nlen + elen]
    comment = data[pos + 46 + nlen + elen:pos + 46 + nlen + elen + clen]
    entries.append({
        "fields": list(fields), "name": name, "extra": extra,
        "comment": comment, "lh_off": fields[16],
    })
    pos += 46 + nlen + elen + clen
assert pos == cd_off + cd_size

# --- parse local headers + data (original order preserved) ---
for e in entries:
    off = e["lh_off"]
    assert data[off:off + 4] == b"PK\x03\x04", (e["name"], off)
    lh = struct.unpack("<IHHHHHIIIHH", data[off:off + 30])
    nlen2, elen2 = lh[9], lh[10]
    e["lh_fields"] = list(lh)
    e["lh_extra"] = data[off + 30 + nlen2:off + 30 + nlen2 + elen2]
    dstart = off + 30 + nlen2 + elen2
    e["data"] = bytearray(data[dstart:dstart + lh[7]])  # csize bytes (stored)

# --- apply replacements ---
replaced = 0
for e in entries:
    if e["name"] in repl:
        new = open(repl[e["name"]], "rb").read()
        e["data"] = bytearray(new)
        e["fields"][7] = zlib.crc32(new) & 0xFFFFFFFF  # crc
        e["fields"][8] = len(new)                       # csize
        e["fields"][9] = len(new)                       # usize
        e["lh_fields"][6] = e["fields"][7]   # crc
        e["lh_fields"][7] = len(new)         # csize
        e["lh_fields"][8] = len(new)         # usize
        replaced += 1
assert replaced == len(repl), (replaced, len(repl))

# --- rebuild ---
out = bytearray(magic)
# central directory first (with updated fields; lh_off patched after layout known)
cd = bytearray()
local = bytearray()
# compute local region base: 4 (magic) + cd_size + 22 (EOCD)
# two-pass: first build locals with placeholder offsets to get cd size,
# but cd size is independent of lh_off values (fixed 46-byte records), so:
for e in entries:
    nmb = e["name"].encode("utf-8")
    cd += struct.pack("<IHHHHHHIIIHHHHHII", *e["fields"])
    cd += nmb + e["extra"] + e["comment"]
cd_size = len(cd)
local_base = 4 + cd_size + 22

for e in entries:
    nmb = e["name"].encode("utf-8")
    off = local_base + len(local)
    e["fields"][16] = off
    # local header has no offset field; order in local region defines it
    local += struct.pack("<IHHHHHIIIHH", *e["lh_fields"][:11])
    local += nmb + e["lh_extra"] + e["data"]

# rewrite CD with final offsets
cd = bytearray()
for e in entries:
    nmb = e["name"].encode("utf-8")
    cd += struct.pack("<IHHHHHHIIIHHHHHII", *e["fields"])
    cd += nmb + e["extra"] + e["comment"]
assert len(cd) == cd_size

eocd = b"PK\x05\x06" + struct.pack("<HHHHIIH", 0, 0, len(entries), len(entries), cd_size, 4, 0)
assert len(eocd) == 22

out += cd + eocd + local + eocd
open(OUT, "wb").write(out)
print(f"rebuilt: {len(entries)} entries, {replaced} replaced, {len(data)} -> {len(out)} bytes")

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "js", "textures-data.js"), "utf8");
const runtimeSource = fs.readFileSync(path.join(ROOT, "js", "textures.js"), "utf8");
const sandbox = { globalThis: {} };
vm.runInNewContext(source, sandbox, { filename: "textures-data.js", timeout: 20000 });

const textures = sandbox.globalThis.MTP_TEXTURE_DATA;
assert(textures && typeof textures === "object", "generated texture dictionary must load");

function dimensions(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  assert(match, "texture must be a base64 data URI");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    assert.strictEqual(match[1], "image/png", "PNG bytes must declare image/png");
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  assert(bytes[0] === 0xff && bytes[1] === 0xd8, "texture must contain PNG or JPEG bytes");
  assert.strictEqual(match[1], "image/jpeg", "JPEG bytes must declare image/jpeg");
  for (let offset = 2; offset < bytes.length - 9;) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    assert(length >= 2, "invalid JPEG segment length");
    offset += 2 + length;
  }
  throw new Error("JPEG dimensions were not found");
}

assert.deepStrictEqual(dimensions(textures.earth), { width: 2048, height: 1024 },
  "Earth must use the 2K NASA global map");
assert.deepStrictEqual(dimensions(textures.moon), { width: 2048, height: 1024 },
  "Moon must use the 2K NASA global map");

const generatorSources = ["get_textures.html", "get_textures.ps1"]
  .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"));
for (const generator of generatorSources) {
  assert(generator.includes("57730/land_ocean_ice_2048.jpg"), "generator must pin NASA Blue Marble 2K");
  assert(generator.includes("LRO_WAC_Mosaic_Global_303ppd_v02"), "generator must pin NASA LRO Moon Trek mosaic");
}

assert(/SPRITE_REFRESH_MS = 80/.test(runtimeSource) &&
  /radiusBucket = requestedR < 48 \? 1 : \(requestedR < 120 \? 3 : 6\)/.test(runtimeSource) &&
  /large && _largeBuilds >= 1/.test(runtimeSource),
"textured globe motion must reuse bounded-size sprites instead of rebuilding every frame");

console.log("Texture tests: NASA Earth and Moon maps are 2048x1024 and reproducibly sourced.");

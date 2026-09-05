#!/usr/bin/env node
// Static server for the reference page. Every asset request (png/webp/jpg)
// is answered with a generated placeholder PNG so the real game code runs
// without the site's artwork; audio and fonts 404 (the game tolerates that).
//   node test/server.js [port]   → http://127.0.0.1:port/
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', 'reference');

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
// w×h RGBA PNG: white background with a coloured disc, so the game's white-keying
// (fpKeyUI) leaves a visible sprite and its column-run splitter finds something.
function png(w, h, rgb) {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.42;
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;
        for (let x = 0; x < w; x++) {
            const o = y * (w * 4 + 1) + 1 + x * 4;
            const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
            raw[o] = inside ? rgb[0] : 255; raw[o + 1] = inside ? rgb[1] : 255; raw[o + 2] = inside ? rgb[2] : 255; raw[o + 3] = 255;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const cache = new Map();
function placeholder(name) {
    // Bigger than every maxW the game keys with (260..600), so fpKey's downscale
    // path — which copies canvas→canvas — runs here as it does on the real site.
    let w = 640, h = 640;
    if (/deco|strip|ribbon/.test(name)) { w = 900; h = 120; }
    if (/bg_|logo/.test(name)) { w = 700; h = 420; }
    const key = w + 'x' + h;
    if (!cache.has(key)) cache.set(key, png(w, h, [40, 90, 200]));
    return cache.get(key);
}

const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/' || u === '/index.html' || u === '/bar_party.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return fs.createReadStream(path.join(ROOT, 'happyhour.html')).pipe(res);
    }
    if (/\.(png|webp|jpg|jpeg|gif)$/i.test(u)) {
        const body = placeholder(path.basename(u));
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length, 'cache-control': 'no-store' });
        return res.end(body);
    }
    res.writeHead(404); res.end();
});
module.exports = server;
if (require.main === module) {
    const port = Number(process.argv[2] || process.env.PORT || 8123);
    server.listen(port, '127.0.0.1', () => console.log('reference server on http://127.0.0.1:' + port + '/'));
}

// images.js：缩放规划、降质和缩小的步进（纯函数），以及 processImage 的流程。
// Node 里没有 createImageBitmap 和 canvas：用假的读图和画布，画布按"像素 × 质量 × 系数"给出编码后的大小。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planResize, planThumb, nextStep, processImage, ImageError,
  LIMIT_BYTES, MAX_FILE_BYTES, MIN_QUALITY, THUMB_WIDTH, MAX_SIDE, WEBP, JPEG,
} from '../src/images.js';

/**
 * 假的读图和画布。
 * - 读出来的图是 width × height；用完会被 close()。
 * - 画布编码：encoder(type, quality, w, h) 返回 { type, bytes } 或 null（模拟 toBlob 给 null）；
 *   默认按要求的格式输出、大小 = 像素 × 质量 × bytesPerPixel；webp: false 时请求 WebP 会悄悄给 PNG。
 * - api: 'toBlob'（<canvas>，回调）或 'convertToBlob'（OffscreenCanvas，Promise）。
 */
function fakeImaging({ width = 1920, height = 1080, webp = true, bytesPerPixel = 0.05, encoder = null, api = 'toBlob', decodeError = null } = {}) {
  const log = { decoded: 0, closed: 0, canvases: [], encodes: [] };
  const sizeOf = encoder || ((type, quality, w, h) => ({
    type: type === WEBP.type && !webp ? 'image/png' : type,
    bytes: Math.round(w * h * quality * bytesPerPixel),
  }));
  const source = { width, height, close() { log.closed += 1; } };
  const decode = async () => {
    log.decoded += 1;
    if (decodeError) throw decodeError;
    return source;
  };
  const createCanvas = (w, h) => {
    const ops = [];
    const g = {
      fillStyle: '',
      fillRect: (x, y, fw, fh) => ops.push(['fillRect', fw, fh, g.fillStyle]),
      drawImage: (src, x, y, dw, dh) => ops.push(['drawImage', src === source, dw, dh]),
    };
    const canvas = { width: w, height: h, ops, getContext: (kind) => (kind === '2d' ? g : null) };
    const make = (type, quality) => {
      log.encodes.push({ type, quality, width: canvas.width, height: canvas.height });
      const out = sizeOf(type, quality, canvas.width, canvas.height);
      return out === null ? null : new Blob([new Uint8Array(out.bytes)], { type: out.type });
    };
    if (api === 'convertToBlob') canvas.convertToBlob = async ({ type, quality }) => make(type, quality);
    else canvas.toBlob = (cb, type, quality) => { const b = make(type, quality); setTimeout(() => cb(b), 0); };
    log.canvases.push(canvas);
    return canvas;
  };
  return { log, source, opts: { decode, createCanvas } };
}

const png = () => new Blob([new Uint8Array(16)], { type: 'image/png' });

// ---------- 纯函数 ----------

test('planResize：长边超过 1920 等比缩到 1920，不超不动、不放大', () => {
  assert.equal(MAX_SIDE, 1920);
  assert.deepEqual(planResize(1280, 720), { width: 1280, height: 720 });
  assert.deepEqual(planResize(1920, 1080), { width: 1920, height: 1080 }, '正好 1920 不动');
  assert.deepEqual(planResize(3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(planResize(2560, 1600), { width: 1920, height: 1200 });
  assert.deepEqual(planResize(1080, 2400), { width: 864, height: 1920 }, '竖图按高缩');
  assert.deepEqual(planResize(4000, 4000), { width: 1920, height: 1920 });
  assert.deepEqual(planResize(1921, 1), { width: 1920, height: 1 });
  assert.deepEqual(planResize(5000, 3), { width: 1920, height: 1 }, '至少 1 像素');
  assert.deepEqual(planResize(1000, 500, 240), { width: 240, height: 120 }, '可以指定上限');
  assert.deepEqual(planResize(1919.6, 1080.2), { width: 1920, height: 1080 }, '小数先取整');
  for (const [w, h] of [[0, 10], [10, 0], [-5, 10], [NaN, 10], [10, Infinity], ['a', 1]]) {
    assert.throws(() => planResize(w, h), RangeError, `${w} × ${h}`);
  }
  assert.throws(() => planResize(100, 100, 0), RangeError);
});

test('planThumb：缩略图宽 240、高按比例，窄图不放大', () => {
  assert.equal(THUMB_WIDTH, 240);
  assert.deepEqual(planThumb(1920, 1080), { width: 240, height: 135 });
  assert.deepEqual(planThumb(864, 1920), { width: 240, height: 533 });
  assert.deepEqual(planThumb(200, 100), { width: 200, height: 100 });
  assert.deepEqual(planThumb(1920, 1), { width: 240, height: 1 });
  assert.throws(() => planThumb(0, 10), RangeError);
});

test('nextStep：不超上限就停；超了先一步步降质，最低 0.6，尺寸不动', () => {
  const limit = LIMIT_BYTES;
  assert.equal(limit, 256000);
  assert.equal(nextStep({ quality: 0.82, scale: 1, bytes: limit, limit }), null, '正好等于上限不用再编');
  assert.equal(nextStep({ quality: 0.82, scale: 1, bytes: 1000, limit }), null);
  assert.equal(nextStep({ quality: 0.82, scale: 1, bytes: NaN, limit }), null, '看不懂的输入不再编');

  const ladder = (start) => {
    const out = [start];
    let s = { quality: start, scale: 1 };
    for (;;) {
      const n = nextStep({ ...s, bytes: limit + 1, limit });
      if (!n || n.scale !== 1) break;
      out.push(n.quality);
      s = n;
    }
    return out;
  };
  assert.deepEqual(ladder(WEBP.quality), [0.82, 0.74, 0.66, 0.6], 'WebP 从 0.82 降');
  assert.deepEqual(ladder(JPEG.quality), [0.85, 0.77, 0.69, 0.6], 'JPEG 从 0.85 降；离 0.6 不到半步直接到 0.6');
  assert.deepEqual(nextStep({ quality: 0.82, scale: 0.7, bytes: limit * 2, limit }), { quality: 0.74, scale: 0.7 }, '降质时尺寸不动');
  assert.deepEqual(nextStep({ quality: 0.82, scale: 1, bytes: 100001, limit: 100000, minQuality: 0.8 }), { quality: 0.8, scale: 1 }, '可以指定下限');
});

test('nextStep：质量到 0.6 还超就按超出的比例缩小，每步缩 10%～50%，不低于 minScale', () => {
  const limit = 100000;
  const n = nextStep({ quality: MIN_QUALITY, scale: 1, bytes: 200000, limit });
  assert.equal(n.quality, 0.6, '缩尺寸时质量保持最低');
  assert.ok(Math.abs(n.scale - Math.sqrt(0.5) * 0.95) < 1e-12, '超 2 倍：按像素数估算，缩到 √0.5 × 0.95');
  assert.deepEqual(nextStep({ quality: 0.6, scale: 1, bytes: 100001, limit }), { quality: 0.6, scale: 0.9 }, '只超一点也至少缩 10%');
  assert.deepEqual(nextStep({ quality: 0.6, scale: 0.8, bytes: 5000000, limit }), { quality: 0.6, scale: 0.4 }, '超很多一步最多缩一半');
  assert.deepEqual(nextStep({ quality: 0.6, scale: 0.3, bytes: 5000000, limit, minScale: 0.25 }), { quality: 0.6, scale: 0.25 }, '不低于 minScale');
  assert.equal(nextStep({ quality: 0.6, scale: 0.25, bytes: 5000000, limit, minScale: 0.25 }), null, '已经到底：不再编');
  assert.equal(nextStep({ quality: 0.6, scale: 0.1, bytes: 5000000, limit }), null, '默认 minScale 是 0.1');
  assert.deepEqual(nextStep({ quality: 0.5, scale: 1, bytes: 100001, limit }), { quality: 0.5, scale: 0.9 }, '质量本来就低于下限：不往回调，直接缩');
});

test('nextStep：照它循环一定会停；压得下来时结果不超上限，压不下来时已经到底', () => {
  const minScale = 320 / 1920;
  for (const k of [0.02, 0.12, 0.18, 0.4, 1, 5, 50]) {
    let s = { quality: WEBP.quality, scale: 1 };
    let steps = 0;
    let bytes;
    for (;;) {
      bytes = Math.round(1920 * s.scale * 1080 * s.scale * s.quality * k);
      const n = nextStep({ ...s, bytes, limit: LIMIT_BYTES, minScale });
      if (!n) break;
      assert.ok(n.quality <= s.quality && n.scale <= s.scale, '只会越来越小');
      assert.ok(n.quality < s.quality || n.scale < s.scale, '每一步都有变化');
      s = n;
      steps += 1;
      assert.ok(steps < 30, `k=${k} 不会死循环`);
    }
    const atFloor = s.quality <= MIN_QUALITY + 1e-9 && s.scale <= minScale + 1e-9;
    assert.ok(bytes <= LIMIT_BYTES || atFloor, `k=${k}：要么不超，要么已经缩到底`);
  }
});

// ---------- processImage（假的读图和画布） ----------

test('processImage：普通截图编成 WebP 0.82，尺寸不变，另出宽 240 的缩略图；读图对象和画布用完都释放', async () => {
  const f = fakeImaging({ width: 1280, height: 720 });
  const out = await processImage(png(), f.opts);
  assert.equal(out.ext, 'webp');
  assert.equal(out.type, 'image/webp');
  assert.equal(out.file.type, 'image/webp');
  assert.equal(out.thumb.type, 'image/webp');
  assert.deepEqual([out.width, out.height], [1280, 720]);
  assert.equal(out.bytes, Math.round(1280 * 720 * 0.82 * 0.05));
  assert.equal(out.bytes, out.file.size);
  assert.deepEqual(f.log.encodes, [
    { type: 'image/webp', quality: 0.82, width: 1280, height: 720 },
    { type: 'image/webp', quality: 0.82, width: 240, height: 135 },
  ]);
  assert.deepEqual(f.log.canvases[0].ops, [['drawImage', true, 1280, 720]], 'WebP 不铺底色，直接把原图画上去');
  assert.deepEqual(f.log.canvases[1].ops, [['drawImage', true, 240, 135]], '缩略图从原图直接画');
  assert.deepEqual(f.log.canvases.map((c) => [c.width, c.height]), [[0, 0], [0, 0]], '画布用完都清掉了');
  assert.equal(f.log.closed, 1, '读出来的图用完关掉');
});

test('processImage：长边超过 1920 先等比缩到 1920 再编', async () => {
  const f = fakeImaging({ width: 3840, height: 2160 });
  const out = await processImage(png(), f.opts);
  assert.deepEqual([out.width, out.height], [1920, 1080]);
  assert.deepEqual(f.log.encodes.map((e) => [e.width, e.height]), [[1920, 1080], [240, 135]]);

  const tall = fakeImaging({ width: 1080, height: 2400 });
  const out2 = await processImage(png(), tall.opts);
  assert.deepEqual([out2.width, out2.height], [864, 1920]);
  assert.deepEqual(tall.log.encodes.map((e) => [e.width, e.height]), [[864, 1920], [240, 533]]);
});

test('processImage：浏览器把 WebP 悄悄编成 PNG 时（看 blob.type）整张改用 JPEG 0.85，并先铺白底', async () => {
  const f = fakeImaging({ width: 1280, height: 720, webp: false });
  const out = await processImage(png(), f.opts);
  assert.equal(out.ext, 'jpg');
  assert.equal(out.type, 'image/jpeg');
  assert.equal(out.file.type, 'image/jpeg');
  assert.equal(out.thumb.type, 'image/jpeg', '缩略图和大图同一种格式');
  assert.deepEqual(f.log.encodes.map((e) => [e.type, e.quality, e.width]), [
    ['image/webp', 0.82, 1280],
    ['image/jpeg', 0.85, 1280],
    ['image/jpeg', 0.85, 240],
  ]);
  assert.deepEqual(f.log.canvases[1].ops, [['fillRect', 1280, 720, '#ffffff'], ['drawImage', true, 1280, 720]], 'JPEG 没有透明：先铺白底');
  assert.equal(out.bytes, Math.round(1280 * 720 * 0.85 * 0.05));
});

test('processImage：只有缩略图编不成 WebP 时也整张改 JPEG，保证两个文件扩展名一致', async () => {
  const f = fakeImaging({
    width: 1280, height: 720,
    encoder: (type, q, w) => ({ type: type === WEBP.type && w <= 240 ? 'image/png' : type, bytes: 1000 }),
  });
  const out = await processImage(png(), f.opts);
  assert.equal(out.ext, 'jpg');
  assert.equal(out.file.type, 'image/jpeg');
  assert.equal(out.thumb.type, 'image/jpeg');
  assert.deepEqual(f.log.encodes.map((e) => [e.type, e.width]), [
    ['image/webp', 1280], ['image/webp', 240], ['image/jpeg', 1280], ['image/jpeg', 240],
  ]);
});

test('processImage：超过 250 KB 先逐步降质，降质够了就不缩尺寸（同一张画布反复编）', async () => {
  // 1920 × 1080 × 质量 × 0.18：0.82、0.74 超，0.66 不超
  const f = fakeImaging({ width: 1920, height: 1080, bytesPerPixel: 0.18 });
  const out = await processImage(png(), f.opts);
  const main = f.log.encodes.filter((e) => e.width > THUMB_WIDTH);
  assert.deepEqual(main.map((e) => [e.quality, e.width, e.height]), [[0.82, 1920, 1080], [0.74, 1920, 1080], [0.66, 1920, 1080]]);
  assert.deepEqual([out.width, out.height], [1920, 1080]);
  assert.equal(out.bytes, Math.round(1920 * 1080 * 0.66 * 0.18));
  assert.ok(out.bytes <= LIMIT_BYTES);
  assert.equal(f.log.canvases.length, 2, '只降质时不重画：大图一张画布、缩略图一张');
});

test('processImage：降到 0.6 还超就缩尺寸，最后报告的是实际编出来的尺寸和大小', async () => {
  // 0.6 时 1920 × 1080 × 0.6 × 0.4 = 497,664 字节，超 1.94 倍 → 缩到 √(256000 / 497664) × 0.95 ≈ 0.681
  const f = fakeImaging({ width: 1920, height: 1080, bytesPerPixel: 0.4 });
  const out = await processImage(png(), f.opts);
  const main = f.log.encodes.filter((e) => e.width > THUMB_WIDTH);
  assert.deepEqual(main.map((e) => [e.quality, e.width, e.height]), [
    [0.82, 1920, 1080], [0.74, 1920, 1080], [0.66, 1920, 1080], [0.6, 1920, 1080], [0.6, 1308, 736],
  ]);
  assert.deepEqual([out.width, out.height], [1308, 736]);
  assert.equal(out.bytes, Math.round(1308 * 736 * 0.6 * 0.4));
  assert.ok(out.bytes <= LIMIT_BYTES);
  assert.equal(out.ext, 'webp');
  assert.deepEqual(f.log.canvases[1].ops, [['drawImage', true, 1308, 736]], '缩尺寸时从原图重画，不是把压过的图再缩');
  const thumbs = f.log.encodes.filter((e) => e.width <= THUMB_WIDTH);
  assert.deepEqual(thumbs.map((e) => [e.quality, e.width, e.height]), [[0.82, 240, 135]], '缩略图按大图的比例出');
});

test('processImage：JPEG 也按同样的规则降质（0.85 起）', async () => {
  const f = fakeImaging({ width: 1920, height: 1080, webp: false, bytesPerPixel: 0.17 });
  const out = await processImage(png(), f.opts);
  const jpeg = f.log.encodes.filter((e) => e.type === JPEG.type && e.width > THUMB_WIDTH);
  assert.deepEqual(jpeg.map((e) => e.quality), [0.85, 0.77, 0.69]);
  assert.equal(out.ext, 'jpg');
  assert.ok(out.bytes <= LIMIT_BYTES);
});

test('processImage：OffscreenCanvas 那种 convertToBlob 也能用', async () => {
  const f = fakeImaging({ width: 800, height: 600, api: 'convertToBlob' });
  const out = await processImage(png(), f.opts);
  assert.equal(out.ext, 'webp');
  assert.deepEqual([out.width, out.height], [800, 600]);
  assert.deepEqual(f.log.encodes.map((e) => [e.width, e.height]), [[800, 600], [240, 180]]);
});

test('processImage：压到底还超过 300 KB 就不收（ImageError TOO_LARGE），而且一定会停', async () => {
  const f = fakeImaging({ encoder: (type) => ({ type, bytes: 400 * 1024 }) });
  await assert.rejects(processImage(png(), f.opts), (err) => err instanceof ImageError && err.code === 'TOO_LARGE' && /300 KB/.test(err.message));
  assert.ok(f.log.encodes.length < 30, `编码次数有上限（实际 ${f.log.encodes.length} 次）`);
  const main = f.log.encodes.filter((e) => e.width > THUMB_WIDTH);
  assert.deepEqual(main.slice(0, 4).map((e) => e.quality), [0.82, 0.74, 0.66, 0.6]);
  const last = main[main.length - 1];
  assert.deepEqual([last.width, last.height], [320, 180], '缩到长边 320 为止');
  assert.equal(f.log.closed, 1);
  assert.ok(MAX_FILE_BYTES === 307200);
});

test('processImage：编码失败、读不出图、不是图片，都抛带中文说明的 ImageError，读出来的图照样关掉', async () => {
  const nullBlob = fakeImaging({ encoder: () => null });
  await assert.rejects(processImage(png(), nullBlob.opts), (err) => err instanceof ImageError && err.code === 'ENCODE' && /压缩/.test(err.message));
  assert.equal(nullBlob.log.closed, 1);

  const throwing = fakeImaging({ encoder: () => { throw new Error('SecurityError'); } });
  await assert.rejects(processImage(png(), throwing.opts), (err) => err.code === 'ENCODE' && err.cause.message === 'SecurityError');
  assert.equal(throwing.log.closed, 1);

  const noCtx = { decode: async () => ({ width: 10, height: 10 }), createCanvas: () => ({ width: 0, height: 0, getContext: () => null }) };
  await assert.rejects(processImage(png(), noCtx), { code: 'ENCODE' });

  const bad = fakeImaging({ decodeError: new Error('InvalidStateError') });
  await assert.rejects(processImage(png(), bad.opts), (err) => err.code === 'DECODE' && /读不出这张图片/.test(err.message) && err.cause.message === 'InvalidStateError');

  const zero = { decode: async () => ({ width: 0, height: 0 }), createCanvas: fakeImaging().opts.createCanvas };
  await assert.rejects(processImage(png(), zero), { code: 'DECODE' });

  const g = fakeImaging();
  await assert.rejects(processImage(new Blob(['你好'], { type: 'text/plain' }), g.opts), { code: 'NOT_IMAGE' });
  await assert.rejects(processImage(null, g.opts), { code: 'NOT_IMAGE' });
  await assert.rejects(processImage('不是 Blob', g.opts), { code: 'NOT_IMAGE' });
  assert.equal(g.log.decoded, 0, '不是图片就不去读');

  const untyped = fakeImaging({ width: 100, height: 50 });
  const out = await processImage(new Blob([new Uint8Array(4)]), untyped.opts);
  assert.equal(out.ext, 'webp', '没写类型的文件（有的拖放）照样试着读');
  assert.deepEqual(untyped.log.encodes.map((e) => [e.width, e.height]), [[100, 50], [100, 50]], '比 240 窄的图，缩略图不放大');
});

test('processImage：Node 里没有 createImageBitmap 时给出清楚的错误，不会崩', async () => {
  await assert.rejects(processImage(png()), (err) => err instanceof ImageError && err.code === 'DECODE' && /createImageBitmap/.test(err.message));
});

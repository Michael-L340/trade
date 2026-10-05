// 截图压缩（交接文档 7.8 的"处理"）：粘贴、选择或拖进来的图片 → 压缩后的文件和缩略图。
//
// - planResize(width, height, maxSide = 1920)：长边超过 1920 就等比缩到 1920（纯函数）。
// - planThumb(width, height, thumbWidth = 240)：缩略图宽 240，高按比例（原图更窄时不放大）。
// - nextStep({quality, scale, bytes, limit})：编码结果超过上限时下一次怎么编（纯函数）：
//   先一步步降质量，最低 0.6；还超就保持最低质量、按超出的比例缩小尺寸；不超限或已经缩到底返回 null。
// - processImage(blob, opts)：浏览器里用 createImageBitmap 读图，用 canvas 缩放和编码：
//   先编 WebP（质量 0.82）；浏览器给出来的不是 image/webp（有的浏览器会悄悄给 PNG，9.4 第 5 条）就整张改编 JPEG（0.85）；
//   超过 250 KB 按 nextStep 降质、缩小；另出一张宽 240 的缩略图，和大图同一种格式。
//   opts.decode、opts.createCanvas 可以替换读图和建画布（Node 里没有 canvas，测试用假的）。
// 不碰 IndexedDB，也不碰页面上的元素（只在默认的建画布函数里用 document.createElement('canvas')）。

/** 大图长边上限（像素） */
export const MAX_SIDE = 1920;
/** 缩略图宽度（像素） */
export const THUMB_WIDTH = 240;
/** 压缩目标：超过就降质、缩小（250 KB，1 KB = 1024 字节，和 5.3 桶上限 300 KB = 307,200 字节同一口径） */
export const LIMIT_BYTES = 250 * 1024;
/** 云端桶的单文件上限（5.3）：压到底还超过它就不收，免得以后同步时被桶拒收 */
export const MAX_FILE_BYTES = 300 * 1024;
/** 降质的下限 */
export const MIN_QUALITY = 0.6;
/** 每次降质的步长：WebP 0.82 → 0.74 → 0.66 → 0.6，JPEG 0.85 → 0.77 → 0.69 → 0.6 */
export const QUALITY_STEP = 0.08;
/** 缩尺寸缩到长边这么多像素为止（只是兜底，正常的截图远远到不了） */
export const MIN_LONG_SIDE = 320;

/** 两种输出格式：先试 WebP，浏览器不支持就用 JPEG */
export const WEBP = Object.freeze({ type: 'image/webp', ext: 'webp', quality: 0.82 });
export const JPEG = Object.freeze({ type: 'image/jpeg', ext: 'jpg', quality: 0.85 });

/** 最多编码几次（降质加缩小正常不超过 20 次，这里只是防止死循环） */
const MAX_ATTEMPTS = 30;

/**
 * 截图处理的错误，message 可以直接给用户看。code：
 * 'NOT_IMAGE' 不是图片；'DECODE' 读不出图片；'ENCODE' 浏览器编码失败或不支持 WebP/JPEG；'TOO_LARGE' 压到底还超过 300 KB。
 */
export class ImageError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'ImageError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function checkSize(width, height) {
  const w = Math.round(width);
  const h = Math.round(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
    throw new RangeError(`图片尺寸不对：${width} × ${height}`);
  }
  return { w, h };
}

/**
 * 缩放后的尺寸：长边超过 maxSide 就等比缩到 maxSide，否则原样（不放大）。宽高都是至少 1 的整数。
 * @param {number} width
 * @param {number} height
 * @param {number} [maxSide]
 * @returns {{width: number, height: number}}
 */
export function planResize(width, height, maxSide = MAX_SIDE) {
  const { w, h } = checkSize(width, height);
  const max = Math.floor(maxSide);
  if (!Number.isFinite(max) || max < 1) throw new RangeError(`长边上限不对：${maxSide}`);
  if (Math.max(w, h) <= max) return { width: w, height: h };
  if (w >= h) return { width: max, height: Math.max(1, Math.round((h * max) / w)) };
  return { width: Math.max(1, Math.round((w * max) / h)), height: max };
}

/**
 * 缩略图尺寸：宽 thumbWidth，高按比例；原图比它还窄时用原图的宽（不放大）。
 * @param {number} width
 * @param {number} height
 * @param {number} [thumbWidth]
 * @returns {{width: number, height: number}}
 */
export function planThumb(width, height, thumbWidth = THUMB_WIDTH) {
  const { w, h } = checkSize(width, height);
  const tw = Math.floor(thumbWidth);
  if (!Number.isFinite(tw) || tw < 1) throw new RangeError(`缩略图宽度不对：${thumbWidth}`);
  const width2 = Math.min(tw, w);
  return { width: width2, height: Math.max(1, Math.round((h * width2) / w)) };
}

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * 编码结果超过上限时，下一次用什么质量和缩放（7.8 第 3 步）。
 * - bytes 不超过 limit：返回 null（不用再编）。
 * - 质量还高于 minQuality：降一步（QUALITY_STEP），离下限不到半步就直接降到下限；scale 不变。
 * - 质量已到下限：质量不变，scale 乘以 √(limit / bytes) × 0.95（按像素数估算），每步至少缩 10%、最多缩一半，
 *   不低于 minScale；已经是 minScale 时返回 null（没法再小了，用最后一次的结果）。
 * @param {{quality: number, scale: number, bytes: number, limit: number, minQuality?: number, minScale?: number}} state
 *   scale 是相对 planResize 结果的缩放（1 表示不再缩）。minQuality 默认 0.6，minScale 默认 0.1。
 * @returns {{quality: number, scale: number} | null}
 */
export function nextStep(state) {
  const { quality, scale, bytes, limit } = state;
  const minQuality = state.minQuality ?? MIN_QUALITY;
  const minScale = state.minScale ?? 0.1;
  if (!(bytes > limit)) return null;
  if (quality > minQuality + 1e-9) {
    let q = round2(quality - QUALITY_STEP);
    if (q < minQuality + QUALITY_STEP / 2) q = minQuality;
    return { quality: q, scale };
  }
  if (scale > minScale + 1e-9) {
    const factor = Math.min(0.9, Math.max(0.5, Math.sqrt(limit / bytes) * 0.95));
    return { quality, scale: Math.max(minScale, scale * factor) };
  }
  return null;
}

// ---------- 浏览器里的读图、画布和编码 ----------

function isBlobLike(v) {
  return !!v && typeof v === 'object' && typeof v.size === 'number' && typeof v.type === 'string';
}

/** 默认的读图：createImageBitmap（按图片里的方向信息摆正） */
function decodeImage(blob) {
  if (typeof globalThis.createImageBitmap !== 'function') {
    throw new ImageError('DECODE', '这个浏览器读不了图片（缺少 createImageBitmap），请换最新版的 Chrome 或 Edge');
  }
  return globalThis.createImageBitmap(blob);
}

/** 默认的建画布：页面里用 <canvas>（各浏览器都支持 toBlob），没有 document 时（worker）用 OffscreenCanvas */
function newCanvas(width, height) {
  const doc = globalThis.document;
  if (doc && typeof doc.createElement === 'function') {
    const c = doc.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  if (typeof globalThis.OffscreenCanvas === 'function') return new globalThis.OffscreenCanvas(width, height);
  throw new ImageError('ENCODE', '这个环境没有画布，没法压缩截图');
}

/** 建一张 width × height 的画布，把原图缩放画上去。opaque：先铺白底（JPEG 没有透明，不铺会变黑） */
function paint(createCanvas, source, width, height, opaque) {
  const canvas = createCanvas(width, height);
  if (!canvas || typeof canvas.getContext !== 'function') throw new ImageError('ENCODE', '浏览器没能创建画布，截图没有保存');
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) throw new ImageError('ENCODE', '浏览器没能创建画布，截图没有保存');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if (opaque) {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, width, height);
  }
  g.drawImage(source, 0, 0, width, height);
  return canvas;
}

/** 编码画布：OffscreenCanvas 用 convertToBlob，<canvas> 用 toBlob。结果可能是 null（画布太大等） */
function encodeCanvas(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    try {
      if (typeof canvas.convertToBlob === 'function') {
        Promise.resolve(canvas.convertToBlob({ type, quality })).then(resolve, reject);
      } else {
        canvas.toBlob((blob) => resolve(blob), type, quality);
      }
    } catch (err) {
      reject(err);
    }
  });
}

/** 让浏览器早点收回画布占的内存（Safari 对画布总内存有上限） */
function dispose(canvas) {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch (err) {
    // 有的画布不让改尺寸，交给垃圾回收
  }
}

/**
 * 按一种格式编码，超过 limit 就按 nextStep 降质、缩小，直到不超或没法再小。
 * 浏览器给出来的不是这种格式（不支持）时返回 null，由调用方换格式。
 * @returns {Promise<{blob: Blob, width: number, height: number} | null>}
 */
async function encodeFitting(draw, size, fmt, limit) {
  const opaque = fmt.type === JPEG.type;
  const minScale = Math.min(1, MIN_LONG_SIDE / Math.max(size.width, size.height));
  let quality = fmt.quality;
  let scale = 1;
  let canvas = null;
  let cw = 0;
  let ch = 0;
  try {
    for (let attempt = 1; ; attempt++) {
      const width = Math.max(1, Math.round(size.width * scale));
      const height = Math.max(1, Math.round(size.height * scale));
      if (!canvas || cw !== width || ch !== height) {
        dispose(canvas);
        canvas = draw(width, height, opaque);
        cw = width;
        ch = height;
      }
      let blob;
      try {
        blob = await encodeCanvas(canvas, fmt.type, quality);
      } catch (err) {
        throw new ImageError('ENCODE', '浏览器没能压缩这张截图', err);
      }
      if (!blob) throw new ImageError('ENCODE', '浏览器没能压缩这张截图（图片可能太大）');
      if (blob.type !== fmt.type) return null;
      const next = attempt < MAX_ATTEMPTS ? nextStep({ quality, scale, bytes: blob.size, limit, minScale }) : null;
      if (!next) return { blob, width, height };
      quality = next.quality;
      scale = next.scale;
    }
  } finally {
    dispose(canvas);
  }
}

/**
 * 把一张图片压成可以保存的截图文件和缩略图（7.8）。
 * @param {Blob} blob 剪贴板、文件选择或拖放得到的图片
 * @param {object} [opts]
 * @param {(blob: Blob) => Promise<{width: number, height: number, close?: () => void}>} [opts.decode]
 *   读图，默认 createImageBitmap；返回的对象要能交给 drawImage，用完会调用它的 close()
 * @param {(width: number, height: number) => object} [opts.createCanvas]
 *   建画布，默认 <canvas>（没有 document 时用 OffscreenCanvas）；画布要有 getContext('2d') 和 toBlob 或 convertToBlob
 * @param {number} [opts.limit] 大小目标，默认 250 KB
 * @param {number} [opts.maxSide] 长边上限，默认 1920
 * @param {number} [opts.thumbWidth] 缩略图宽度，默认 240
 * @returns {Promise<{file: Blob, thumb: Blob, width: number, height: number, bytes: number, ext: 'webp'|'jpg', type: string}>}
 *   width、height 是大图最终的尺寸，bytes 是大图的字节数，ext 和 type 对大图和缩略图都适用。
 *   出错时抛 ImageError。
 */
export async function processImage(blob, opts = {}) {
  if (!isBlobLike(blob)) throw new ImageError('NOT_IMAGE', '没有拿到图片');
  if (blob.type && !/^image\//i.test(blob.type)) throw new ImageError('NOT_IMAGE', '这不是图片文件，截图只收图片');
  const limit = opts.limit ?? LIMIT_BYTES;
  const decode = typeof opts.decode === 'function' ? opts.decode : decodeImage;
  const createCanvas = typeof opts.createCanvas === 'function' ? opts.createCanvas : newCanvas;

  let source;
  try {
    source = await decode(blob);
  } catch (err) {
    if (err instanceof ImageError) throw err;
    throw new ImageError('DECODE', '读不出这张图片：文件可能坏了，或者是浏览器不认识的格式', err);
  }
  try {
    const w = source ? source.width : 0;
    const h = source ? source.height : 0;
    if (!(w >= 1 && h >= 1)) throw new ImageError('DECODE', '读不出这张图片的尺寸');
    const size = planResize(w, h, opts.maxSide ?? MAX_SIDE);
    const thumbSize = planThumb(size.width, size.height, opts.thumbWidth ?? THUMB_WIDTH);
    const draw = (width, height, opaque) => paint(createCanvas, source, width, height, opaque);

    for (const fmt of [WEBP, JPEG]) {
      const main = await encodeFitting(draw, size, fmt, limit);
      if (!main) continue; // 浏览器不支持这种格式
      const thumb = await encodeFitting(draw, thumbSize, fmt, limit);
      if (!thumb) continue; // 缩略图编不成同一种格式：整张换下一种，保证两者扩展名一致
      if (main.blob.size > MAX_FILE_BYTES || thumb.blob.size > MAX_FILE_BYTES) {
        throw new ImageError('TOO_LARGE', '这张图片压缩到底还是超过 300 KB，没有保存');
      }
      return {
        file: main.blob,
        thumb: thumb.blob,
        width: main.width,
        height: main.height,
        bytes: main.blob.size,
        ext: fmt.ext,
        type: fmt.type,
      };
    }
    throw new ImageError('ENCODE', '这个浏览器没法把截图存成 WebP 或 JPEG');
  } finally {
    if (source && typeof source.close === 'function') {
      try { source.close(); } catch (err) { /* 已经关过 */ }
    }
  }
}

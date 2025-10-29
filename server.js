// server.js (MathJax + Sharp) — optimized + LRU cache + fast-path
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sharp = require('sharp');
const MathJax = require('mathjax');

const MAX_TILE = 1024;
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const CACHE_CAPACITY = 500; // adjust by memory/usage
const CACHE_TTL = 60 * 60; // cache TTL seconds (1 hour)

const App = express();
App.use(cors());
App.use(bodyParser.json({ limit: '10mb' }));

/* -----------------------------
  Simple LRU cache (in-memory)
   - key -> { timestamp, value }
   - capacity bounded
   - value is full render response object (base64Chunks, tileWidths, width, height, pixelDensity...)
--------------------------------*/
class LruCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map(); // preserves insertion order; we'll use it as LRU
  }
  _touch(key, entry) {
    this.map.delete(key);
    this.map.set(key, entry);
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    // check TTL
    const now = Date.now() / 1000;
    if (entry.ts + entry.ttl < now) {
      this.map.delete(key);
      return null;
    }
    this._touch(key, entry);
    return entry.value;
  }
  set(key, value, ttl = CACHE_TTL) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, ts: Date.now() / 1000, ttl });
    while (this.map.size > this.capacity) {
      // remove oldest
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }
  delete(key) { this.map.delete(key); }
}
const Cache = new LruCache(CACHE_CAPACITY);

/* -----------------------------
  MathJax init (prewarm)
--------------------------------*/
let MathJaxInitPromise = null;
function InitMathJax() {
  if (!MathJaxInitPromise) {
    MathJaxInitPromise = MathJax.init({
      loader: { load: ['input/tex', 'output/svg'] },
      tex: { packages: ['base', 'ams'] }
    });
  }
  return MathJaxInitPromise;
}

/* -----------------------------
  Utils: svg dimension handling (same robust approach)
--------------------------------*/
function ParseViewBox(svgString) {
  const vbMatch = svgString.match(/viewBox=["']([^"']+)["']/);
  if (vbMatch) {
    const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(n => !Number.isNaN(n))) {
      return { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
    }
  }
  const wMatch = svgString.match(/<svg[^>]*\bwidth=["']?([\d.]+)(?:px)?["']?/);
  const hMatch = svgString.match(/<svg[^>]*\bheight=["']?([\d.]+)(?:px)?["']?/);
  if (wMatch && hMatch) {
    const w = Number(wMatch[1]), h = Number(hMatch[1]);
    if (!Number.isNaN(w) && !Number.isNaN(h)) return { minX: 0, minY: 0, width: w, height: h };
  }
  return null;
}
function EnsureSvgHasDimensions(svgString, pixelDensity, fallbackFontPx) {
  const vb = ParseViewBox(svgString);
  if (vb) {
    const W = Math.max(1, Math.ceil(vb.width * pixelDensity));
    const H = Math.max(1, Math.ceil(vb.height * pixelDensity));
    const replaced = svgString.replace(/<svg([^>]*)>/, function(_, attrs) {
      const cleaned = attrs.replace(/\b(width|height)=["'][^"']*["']/g, '');
      return `<svg${cleaned} width="${W}" height="${H}">`;
    });
    return { svg: replaced, pixelWidth: W, pixelHeight: H, usedFallback: false };
  }
  const fallbackWidth = Math.max(256, Math.ceil((fallbackFontPx || 64) * 10 * (pixelDensity || 1)));
  const fallbackHeight = Math.max(32, Math.ceil((fallbackFontPx || 64) * 2 * (pixelDensity || 1)));
  const wrapped =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fallbackWidth}" height="${fallbackHeight}" viewBox="0 0 ${fallbackWidth} ${fallbackHeight}">` +
    svgString +
    `</svg>`;
  return { svg: wrapped, pixelWidth: fallbackWidth, pixelHeight: fallbackHeight, usedFallback: true };
}

/* -----------------------------
  Convert latex -> svg (MathJax)
--------------------------------*/
async function LatexToSvg(latex) {
  const mj = await InitMathJax();
  const svgNode = mj.tex2svg(latex, { display: true });
  const svgString = (typeof svgNode === 'string') ? svgNode : (svgNode.outerHTML || svgNode.toString());
  if (!/<svg[^>]*xmlns=/.test(svgString)) {
    return svgString.replace(/<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return svgString;
}

/* -----------------------------
  Rasterize svg -> raw RGBA tiles (optimized)
  - Sharp will take the svg buffer and output raw RGBA for regions
  - We use sharp.raw when extracting to avoid PNG decode overhead
--------------------------------*/
async function SvgToRgbaTilesFast(svgString, fontPx = 64, pixelDensity = 2) {
  const ensured = EnsureSvgHasDimensions(svgString, pixelDensity, fontPx);
  const finalSvg = ensured.svg;
  // We render to a PNG buffer once then extract tiles raw (this is stable and very fast)
  const pngBuffer = await sharp(Buffer.from(finalSvg, 'utf8')).png({ quality: 100 }).toBuffer();
  const meta = await sharp(pngBuffer).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) throw new Error('SVG rasterized to invalid width/height');

  const base64Chunks = [];
  const tileWidths = [];
  for (let left = 0; left < width; left += MAX_TILE) {
    const tileWidth = Math.min(MAX_TILE, width - left);
    const tileRaw = await sharp(pngBuffer)
      .extract({ left, top: 0, width: tileWidth, height })
      .raw()
      .toBuffer();
    base64Chunks.push(tileRaw.toString('base64'));
    tileWidths.push(tileWidth);
  }
  return {
    base64Chunks,
    tileWidths,
    width,
    height,
    pixelDensity,
    equationHeightPx: height,
    bytesPerPixel: 4,
    channelOrder: 'RGBA'
  };
}

/* -----------------------------
  Key helpers
--------------------------------*/
function CacheKey(latex, fontPx, pixelDensity) {
  return `${latex}|${fontPx}|${pixelDensity}`;
}

/* -----------------------------
  Fast cache-only endpoint
  - returns cached render if present (fast)
  - response: { hit: true, result } or { hit: false }
--------------------------------*/
App.post('/renderFast', async (req, res) => {
  try {
    const { latex, fontSize, pixelDensity } = req.body || {};
    if (!latex || typeof latex !== 'string') return res.status(400).json({ error: 'latex string required' });
    const fontPx = Number.isFinite(fontSize) ? fontSize : 64;
    const density = Number.isFinite(pixelDensity) ? pixelDensity : 2;
    const key = CacheKey(latex, fontPx, density);
    const cached = Cache.get(key);
    if (!cached) return res.json({ hit: false });
    return res.json({ hit: true, result: cached });
  } catch (err) {
    console.error('Fast render error:', err);
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

/* -----------------------------
  Full render endpoint (caches on success)
--------------------------------*/
App.post('/render', async (req, res) => {
  try {
    const { latex, fontSize, pixelDensity } = req.body || {};
    if (!latex || typeof latex !== 'string') return res.status(400).json({ error: 'latex string required' });
    const fontPx = Number.isFinite(fontSize) ? fontSize : 64;
    const density = Number.isFinite(pixelDensity) ? pixelDensity : 2;

    const key = CacheKey(latex, fontPx, density);
    // check cache early (avoid expensive render)
    const cached = Cache.get(key);
    if (cached) return res.json(cached);

    // Render: latex -> svg -> raster tiles
    const svg = await LatexToSvg(latex);
    const result = await SvgToRgbaTilesFast(svg, fontPx, density);

    // store in-cache
    Cache.set(key, result);

    return res.json(result);
  } catch (err) {
    console.error('Render error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

/* -----------------------------
  Optional: prewarm example
  - call this with a list of LaTeX strings you expect to be common,
    the server will populate cache at startup.
--------------------------------*/
async function PrewarmCommon(commonList) {
  try {
    await InitMathJax();
    for (const entry of commonList) {
      try {
        const svg = await LatexToSvg(entry.latex);
        const result = await SvgToRgbaTilesFast(svg, entry.fontPx || 64, entry.pixelDensity || 2);
        Cache.set(CacheKey(entry.latex, entry.fontPx || 64, entry.pixelDensity || 2), result);
        console.log('Prewarmed:', entry.latex.slice(0, 40));
      } catch (e) {
        console.warn('Prewarm failed for', entry.latex, e && e.message);
      }
    }
  } catch (e) {
    console.warn('MathJax prewarm failed:', e && e.message);
  }
}

/* -----------------------------
  Startup: init MathJax and optionally prewarm
--------------------------------*/
(async () => {
  try {
    await InitMathJax();
    console.log('MathJax initialized (prewarmed)');
    // Optionally call PrewarmCommon([...]) with common formulas (highly recommended)
    // Example:
    // PrewarmCommon([{ latex: "\\frac{1}{2}", fontPx: 64, pixelDensity: 2 }, ...])
  } catch (e) {
    console.error('MathJax init error:', e && e.stack ? e.stack : e);
  }
})();

App.listen(PORT, () => console.log(`MathJax renderer listening on ${PORT}`));

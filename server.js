// server.js  (MathJax + Sharp renderer; robust SVG dimension handling)
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sharp = require('sharp');
const MathJax = require('mathjax');

const MAX_TILE = 1024;
const App = express();
App.use(cors());
App.use(bodyParser.json({ limit: '10mb' }));

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

function ParseViewBox(svgString) {
  // returns { minX, minY, width, height } or null
  const vbMatch = svgString.match(/viewBox=["']([^"']+)["']/);
  if (vbMatch) {
    const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(n => !Number.isNaN(n))) {
      return { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
    }
  }
  // try width/height attributes (e.g., width="123px" or width="123")
  const wMatch = svgString.match(/<svg[^>]*\bwidth=["']?([\d.]+)(?:px)?["']?/);
  const hMatch = svgString.match(/<svg[^>]*\bheight=["']?([\d.]+)(?:px)?["']?/);
  if (wMatch && hMatch) {
    const w = Number(wMatch[1]);
    const h = Number(hMatch[1]);
    if (!Number.isNaN(w) && !Number.isNaN(h)) {
      return { minX: 0, minY: 0, width: w, height: h };
    }
  }
  return null;
}

function EnsureSvgHasDimensions(svgString, pixelDensity, fallbackFontPx) {
  // try to get viewBox or width/height from the svg; if found, add width/height attributes scaled by pixelDensity
  const vb = ParseViewBox(svgString);
  if (vb) {
    const W = Math.max(1, Math.ceil(vb.width * pixelDensity));
    const H = Math.max(1, Math.ceil(vb.height * pixelDensity));
    // replace opening <svg ...> to include width & height attributes
    const replaced = svgString.replace(/<svg([^>]*)>/, function(_, attrs) {
      // remove existing width/height if present
      const cleanedAttrs = attrs.replace(/\b(width|height)=["'][^"']*["']/g, '');
      // ensure viewBox present (keep original)
      return `<svg${cleanedAttrs} width="${W}" height="${H}">`;
    });
    return { svg: replaced, pixelWidth: W, pixelHeight: H };
  }

  // No viewBox: try to rasterize by wrapping content in a fixed canvas using fallbackFontPx
  // We attempt a conservative fallback: treat fallbackFontPx * 10 as width, fallbackFontPx * 2 as height
  const fallbackWidth = Math.max(256, Math.ceil((fallbackFontPx || 64) * 10 * (pixelDensity || 1)));
  const fallbackHeight = Math.max(32, Math.ceil((fallbackFontPx || 64) * 2 * (pixelDensity || 1)));
  // Wrap original svg inside an outer svg with explicit width/height and a viewBox if possible
  const wrapped =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fallbackWidth}" height="${fallbackHeight}" viewBox="0 0 ${fallbackWidth} ${fallbackHeight}">` +
    svgString +
    `</svg>`;
  return { svg: wrapped, pixelWidth: fallbackWidth, pixelHeight: fallbackHeight, usedFallback: true };
}

async function LatexToSvg(latex) {
  const mj = await InitMathJax();
  // tex2svg returns an SVG element or string; convert to string
  // mathjax.tex2svg returns a DOM node with outerHTML in many builds
  const svgNode = mj.tex2svg(latex, { display: true });
  const svgString = (typeof svgNode === 'string') ? svgNode : (svgNode.outerHTML || svgNode.toString());
  // ensure that the svgString has xmlns on svg tags (MathJax usually includes it)
  if (!/<svg[^>]*xmlns=/.test(svgString)) {
    // add xmlns to top-level svg (best-effort)
    return svgString.replace(/<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return svgString;
}

async function SvgToRgbaTiles(svgString, fontPx = 64, pixelDensity = 2) {
  // ensure svg has explicit width & height (sharp requires them or a viewBox)
  const ensured = EnsureSvgHasDimensions(svgString, pixelDensity, fontPx);
  const finalSvg = ensured.svg;
  // Rasterize via sharp; we rely on explicit width/height in the svg
  // Use sharp with input as Buffer and output raw RGBA
  // We'll render to PNG first, then extract raw tiles (so we can use .raw().toBuffer on the extracted region)
  let pngBuffer;
  try {
    pngBuffer = await sharp(Buffer.from(finalSvg, 'utf8')).png({ quality: 100 }).toBuffer();
  } catch (err) {
    // include extra debug info
    err.message = `SVG rasterization failed: ${err.message}. SVG sample head: ${finalSvg.slice(0, 512)}`;
    throw err;
  }

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
      .toBuffer(); // raw RGBA
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

App.post('/render', async (req, res) => {
  try {
    const { latex, fontSize, pixelDensity } = req.body || {};
    if (!latex || typeof latex !== 'string') {
      return res.status(400).json({ error: 'latex string required' });
    }
    const fontPx = Number.isFinite(fontSize) ? fontSize : 64;
    const density = Number.isFinite(pixelDensity) ? pixelDensity : 2;

    const svg = await LatexToSvg(latex);
    const result = await SvgToRgbaTiles(svg, fontPx, density);
    return res.json(result);
  } catch (err) {
    console.error('Render error:', err && err.stack ? err.stack : err);
    // Always return JSON with error string
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
App.listen(PORT, () => console.log(`MathJax renderer listening on ${PORT}`));

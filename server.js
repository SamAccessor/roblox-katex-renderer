const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sharp = require('sharp');
const { mathjax } = require('mathjax-full/js/mathjax.js');
const { TeX } = require('mathjax-full/js/input/tex.js');
const { SVG } = require('mathjax-full/js/output/svg.js');
const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js');
const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js');
const { AllPackages } = require('mathjax-full/js/input/tex/AllPackages.js');

const App = express();
App.use(cors());
App.use(bodyParser.json({ limit: '20mb' }));

const MAX_TILE = 1024;
const MAX_RETRIES = 3;
const DEFAULT_PIXEL_DENSITY = 2;

let Adaptor = null;
let Doc = null;

async function InitMathJax() {
  if (Doc) return;
  Adaptor = liteAdaptor();
  RegisterHTMLHandler(Adaptor);
  Doc = mathjax.document('', { InputJax: new TeX({ packages: AllPackages }), OutputJax: new SVG({ fontCache: 'none' }) });
}

function ParseViewBox(svg) {
  const vb = svg.match(/viewBox=["']([^"']+)["']/);
  if (vb) {
    const parts = vb[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(n => Number.isFinite(n))) return { width: parts[2], height: parts[3] };
  }
  const w = svg.match(/<svg[^>]*\bwidth=["']?([\d.]+)(?:px)?["']?/);
  const h = svg.match(/<svg[^>]*\bheight=["']?([\d.]+)(?:px)?["']?/);
  if (w && h) {
    const W = Number(w[1]);
    const H = Number(h[1]);
    if (Number.isFinite(W) && Number.isFinite(H)) return { width: W, height: H };
  }
  return null;
}

function EnsureSvgDimensions(svg, pixelDensity, fallbackFontPx) {
  const vb = ParseViewBox(svg);
  if (vb) {
    const W = Math.max(1, Math.ceil(vb.width * pixelDensity));
    const H = Math.max(1, Math.ceil(vb.height * pixelDensity));
    const replaced = svg.replace(/<svg([^>]*)>/, function(m, attrs) {
      const cleaned = attrs.replace(/\b(width|height)=["'][^"']*["']/g, '');
      return '<svg' + cleaned + ' width="' + W + '" height="' + H + '">';
    });
    const styled = replaced.replace(/<svg/, '<svg style="background:transparent"').replace(/<g /, '<g fill="#FFFFFF" ');
    return { svg: styled, width: W, height: H };
  }
  const Fw = Math.max(256, Math.ceil((fallbackFontPx || 64) * 10 * (pixelDensity || 1)));
  const Fh = Math.max(32, Math.ceil((fallbackFontPx || 64) * 2 * (pixelDensity || 1)));
  const wrapped = '<svg xmlns="http://www.w3.org/2000/svg" width="' + Fw + '" height="' + Fh + '" viewBox="0 0 ' + Fw + ' ' + Fh + '"><g fill="#FFFFFF">' + svg + '</g></svg>';
  return { svg: wrapped, width: Fw, height: Fh };
}

async function LatexToSvg(latex) {
  await InitMathJax();
  const node = Doc.convert(latex, { display: true });
  const svg = Adaptor.outerHTML(node);
  return svg;
}

async function SvgToRgbaTiles(svgString, fontPx, pixelDensity) {
  const ensured = EnsureSvgDimensions(svgString, pixelDensity, fontPx);
  const finalSvg = ensured.svg;
  const pngBuffer = await sharp(Buffer.from(finalSvg, 'utf8'), { limitInputPixels: false }).png({ quality: 100 }).toBuffer();
  const meta = await sharp(pngBuffer).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) throw new Error('invalid raster dimensions');
  const base64Chunks = [];
  const tileWidths = [];
  for (let left = 0; left < width; left += MAX_TILE) {
    const tileWidth = Math.min(MAX_TILE, width - left);
    const raw = await sharp(pngBuffer).extract({ left, top: 0, width: tileWidth, height }).raw().toBuffer();
    base64Chunks.push(raw.toString('base64'));
    tileWidths.push(tileWidth);
  }
  return { base64Chunks, tileWidths, width, height, bytesPerPixel: 4, channelOrder: 'RGBA', pixelDensity };
}

async function RenderWithRetries(latex, fontSize) {
  let lastErr = null;
  let density = DEFAULT_PIXEL_DENSITY;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const svg = await LatexToSvg(latex);
      const result = await SvgToRgbaTiles(svg, fontSize || 64, density);
      return { success: true, tiles: result.base64Chunks, width: result.width, height: result.height, tileWidths: result.tileWidths, tileHeights: [result.height], bytesPerPixel: result.bytesPerPixel, channelOrder: result.channelOrder, pixelDensity: result.pixelDensity };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        density = Math.max(1, Math.floor(density / 2));
        await new Promise(r => setTimeout(r, 150 * attempt));
        continue;
      }
      return { success: false, error: String(e && e.message ? e.message : e) };
    }
  }
  return { success: false, error: String(lastErr) };
}

App.post('/render', async (req, res) => {
  try {
    const body = req.body || {};
    const latex = typeof body.latex === 'string' ? body.latex : '';
    const fontSize = Number.isFinite(body.fontSize) ? body.fontSize : 64;
    if (!latex) return res.status(400).json({ success: false, error: 'latex required' });
    const result = await RenderWithRetries(latex, fontSize);
    if (!result.success) return res.status(500).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
App.listen(PORT);

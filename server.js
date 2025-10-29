// server.js

const express = require('express');
const bodyParser = require('body-parser');
const sharp = require('sharp');

// MathJax v3 (full) SVG pipeline
const { mathjax } = require('mathjax-full/js/mathjax.js');
const { TeX } = require('mathjax-full/js/input/tex.js');
const { SVG } = require('mathjax-full/js/output/svg.js');
const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js');
const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js');

const app = express();

// Keep payload limits sane; speed/memory
app.use(bodyParser.json({ limit: '1mb' }));

// MathJax setup
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const tex = new TeX({
  packages: ['base', 'ams', 'newcommand', 'noerrors', 'noundefined'],
  // allow plain text: you can pass normal text and MathJax will treat it; or wrap \text{} client-side if needed
});
const svg = new SVG({
  fontCache: 'none', // no disk/font cache for speed & memory
});
const mj = mathjax.document('', { InputJax: tex, OutputJax: svg });

// Constants
const MAX_TILE = 1024;

// Utility: produces tightly-cropped PNG then raw RGBA
async function renderLatexToRawTiles(svgString, density = 230) {
  // librsvg handles density for SVG → raster quality
  // Make sure SVG has white currentColor, transparent background
  // Strip XML header (prevents “XML does not have <svg> root” issues in some pipelines)
  svgString = svgString.replace(/<\?xml[^>]*\?>\s*/i, '');

  // Rasterize + trim to remove transparent margins
  const trimmedPng = await sharp(Buffer.from(svgString), { density })
    .png({ compressionLevel: 9, quality: 100 })
    .trim() // removes fully transparent edges
    .toBuffer();

  // Convert trimmed to raw RGBA to avoid client-side PNG decoding complexity
  const { data: raw, info } = await sharp(trimmedPng)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;

  // Tile if necessary
  const tilesMeta = [];
  for (let y = 0; y < height; y += MAX_TILE) {
    for (let x = 0; x < width; x += MAX_TILE) {
      const w = Math.min(MAX_TILE, width - x);
      const h = Math.min(MAX_TILE, height - y);
      tilesMeta.push({ x, y, w, h });
    }
  }

  // Extract tiles from raw buffer efficiently via sharp raw extract
  const tiles = await Promise.all(
    tilesMeta.map(async (t) => {
      const tileRaw = await sharp(raw, {
        raw: { width, height, channels: 4 },
      })
        .extract({ left: t.x, top: t.y, width: t.w, height: t.h })
        .raw()
        .toBuffer();

      return {
        ...t,
        base64: tileRaw.toString('base64'), // raw RGBA
      };
    })
  );

  return { width, height, tiles };
}

// Express route
app.post('/render', async (req, res) => {
  try {
    let { latex, fontsize = 48 } = req.body;

    if (typeof latex !== 'string' || latex.length === 0) {
      return res.status(400).json({ error: 'latex must be a non-empty string' });
    }
    if (typeof fontsize !== 'number' || fontsize <= 0 || !isFinite(fontsize)) {
      return res.status(400).json({ error: 'fontsize must be a positive number' });
    }

    // Convert LaTeX to SVG
    // em: MathJax default is 16px; scale fonts linearly with requested fontsize
    const node = mj.convert(latex, {
      display: true,
      em: fontsize / 16,
      ex: fontsize / 8,
    });

    let svgString = adaptor.outerHTML(node);

    // Ensure white text using currentColor → white at root
    // MathJax SVGs generally use currentColor for fill/stroke; we set the svg style color to white.
    // If user provided explicit color, they can override; default is white here.
    svgString = svgString.replace(
      /<svg\b([^>]*)>/i,
      (m, attrs) => `<svg${attrs} style="color:#ffffff">`
    );

    const { width, height, tiles } = await renderLatexToRawTiles(svgString, 260);

    res.json({
      width,
      height,
      fontsize,
      tiles, // [{x,y,w,h,base64}] base64 is raw RGBA
    });
  } catch (err) {
    // Avoid leaking internals; return concise error
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

// UptimeRobot / health
app.get('/', (req, res) => res.type('text').send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LaTeX renderer listening on ${PORT}`);
});

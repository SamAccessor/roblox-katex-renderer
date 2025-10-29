// server.js
const express = require('express');
const cors = require('cors');
const katex = require('katex');
const puppeteer = require('puppeteer');
const sharp = require('sharp');

const MAX_TILE = 1024;

// Optional: inline KaTeX CSS for robustness (shortened here); you can inline the full CSS string.
const KATEX_CSS_LINK = 'https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.min.css';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors());

function HtmlTemplate(latex, fontPx) {
  const mathHTML = katex.renderToString(latex, {
    throwOnError: false,
    displayMode: true
  });

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8"/>
    <link rel="stylesheet" href="${KATEX_CSS_LINK}">
    <style>
      html, body { margin:0; padding:0; background:transparent; }
      #Math {
        display:inline-block;
        color:white;             /* white text */
        background:transparent;  /* transparent background */
        font-size:${fontPx}px;
      }
      body, #Math { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    </style>
  </head>
  <body>
    <div id="Math">${mathHTML}</div>
  </body>
</html>`;
}

async function RenderLatexToRgbaTiles(latex, fontPx = 64, pixelDensity = 2) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({
    width: 1920,
    height: 1080,
    deviceScaleFactor: pixelDensity
  });

  await page.setContent(HtmlTemplate(latex, fontPx), { waitUntil: 'networkidle0' });

  const el = await page.$('#Math');
  if (!el) {
    await browser.close();
    throw new Error('Math element not found');
  }

  const pngBuffer = await el.screenshot({ type: 'png', omitBackground: true });
  await browser.close();

  // Get full dimensions at device scale
  const { width, height } = await sharp(pngBuffer).metadata();
  if (!width || !height) {
    throw new Error('Unable to read rendered image dimensions');
  }

  // Slice horizontally into MAX_TILE tiles and convert each tile to raw RGBA
  const base64Chunks = [];
  const tileWidths = [];
  for (let left = 0; left < width; left += MAX_TILE) {
    const tileWidth = Math.min(MAX_TILE, width - left);
    const tile = await sharp(pngBuffer)
      .extract({ left, top: 0, width: tileWidth, height })
      .raw()
      .toBuffer(); // raw uncompressed RGBA, 4 bytes/pixel

    base64Chunks.push(tile.toString('base64'));
    tileWidths.push(tileWidth);
  }

  // Explicit metadata to ensure client scales precisely
  return {
    base64Chunks,               // raw RGBA tiles, left→right
    tileWidths,                 // each tile’s width in pixels
    width,                      // full image width
    height,                     // full image height (also equationHeightPx)
    pixelDensity,               // deviceScaleFactor
    equationHeightPx: height,   // alias used by client scaling
    bytesPerPixel: 4,           // RGBA8
    channelOrder: 'RGBA'        // byte order in each pixel
  };
}

app.post('/render', async (req, res) => {
  try {
    const { latex, fontSize, pixelDensity } = req.body || {};
    if (typeof latex !== 'string' || latex.length === 0) {
      return res.status(400).json({ error: 'latex string required' });
    }
    const fontPx = Number.isFinite(fontSize) ? fontSize : 64;
    const density = Number.isFinite(pixelDensity) ? pixelDensity : 2;

    const result = await RenderLatexToRgbaTiles(latex, fontPx, density);
    res.json(result);
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => console.log(`KaTeX renderer listening on ${PORT}`));

// server.js
const express = require('express');
const cors = require('cors');
const katex = require('katex');
const puppeteer = require('puppeteer');
const sharp = require('sharp');

const MAX_TILE = 1024;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors());

// HTML template including KaTeX CSS; body is transparent; text is white.
// We render KaTeX to HTML and place it inside #math.
function buildHtml(latex, fontSizePx) {
  const mathHTML = katex.renderToString(latex, {
    throwOnError: false,
    displayMode: true
  });

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8"/>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.min.css">
    <style>
      html, body { margin:0; padding:0; background:transparent; }
      #math {
        display:inline-block;
        color:white;             /* white text */
        background:transparent;  /* transparent background */
        font-size:${fontSizePx}px;
      }
      /* Improve anti-aliasing */
      body, #math {
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }
    </style>
  </head>
  <body>
    <div id="math">${mathHTML}</div>
  </body>
</html>
`;
}

// Render with Puppeteer, screenshot element as PNG, then tile with Sharp.
async function renderLatexToTiles(latex, fontSizePx = 64, pixelDensity = 2) {
  const browser = await puppeteer.launch({
    // On Render or some hosts, sandbox flags are required:
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({
    width: 1920,  // workspace width; actual capture uses element bounding box
    height: 1080,
    deviceScaleFactor: pixelDensity  // boosts render resolution
  });

  const html = buildHtml(latex, fontSizePx);
  await page.setContent(html, { waitUntil: 'networkidle0' });

  const el = await page.$('#math');
  if (!el) {
    await browser.close();
    throw new Error('Render element not found');
  }

  // Measure box to know final pixel size (post deviceScaleFactor)
  const box = await el.boundingBox();
  if (!box) {
    await browser.close();
    throw new Error('Bounding box unavailable');
  }

  const screenshotBuffer = await el.screenshot({
    type: 'png',
    omitBackground: true  // transparent
  });

  await browser.close();

  // Sharp metadata reflects physical pixels post deviceScaleFactor
  const meta = await sharp(screenshotBuffer).metadata();
  const width = meta.width || Math.ceil(box.width * pixelDensity);
  const height = meta.height || Math.ceil(box.height * pixelDensity);

  // Slice horizontally into MAX_TILE-wide tiles
  const base64Chunks = [];
  const tileWidths = [];
  for (let left = 0, i = 0; left < width; left += MAX_TILE, i += 1) {
    const w = Math.min(MAX_TILE, width - left);
    tileWidths.push(w);

    const tileBuf = await sharp(screenshotBuffer)
      .extract({ left, top: 0, width: w, height })
      .png()
      .toBuffer();

    base64Chunks.push(tileBuf.toString('base64'));
  }

  return { base64Chunks, tileWidths, width, height };
}

app.post('/render', async (req, res) => {
  try {
    const { latex, fontSize, pixelDensity } = req.body || {};
    if (typeof latex !== 'string' || latex.length === 0) {
      return res.status(400).json({ error: 'Missing latex string' });
    }
    const fontSizePx = Number.isFinite(fontSize) ? fontSize : 64;
    const density = Number.isFinite(pixelDensity) ? pixelDensity : 2;

    const result = await renderLatexToTiles(latex, fontSizePx, density);
    // Note: width/height are in pixels of the captured PNG (high-res).
    res.json(result);
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Support Render.com assigned PORT
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => {
  console.log(`KaTeX renderer listening on port ${PORT}`);
});

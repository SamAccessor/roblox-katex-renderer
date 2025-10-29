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

function htmlTemplate(latex, fontPx) {
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
        font-size:${fontPx}px;
      }
      body, #math { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    </style>
  </head>
  <body>
    <div id="math">${mathHTML}</div>
  </body>
</html>`;
}

async function renderLatex(latex, fontPx = 64, pixelDensity = 2) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({
    width: 1920,
    height: 1080,
    deviceScaleFactor: pixelDensity
  });

  await page.setContent(htmlTemplate(latex, fontPx), { waitUntil: 'networkidle0' });

  const el = await page.$('#math');
  if (!el) {
    await browser.close();
    throw new Error('KaTeX element not found');
  }

  const png = await el.screenshot({ type: 'png', omitBackground: true });
  await browser.close();

  const { width, height } = await sharp(png).metadata();

  // Slice horizontally to ≤1024px per tile
  const base64Chunks = [];
  const tileWidths = [];
  for (let left = 0; left < width; left += MAX_TILE) {
    const w = Math.min(MAX_TILE, width - left);
    const tileBuf = await sharp(png).extract({ left, top: 0, width: w, height }).png().toBuffer();
    base64Chunks.push(tileBuf.toString('base64'));
    tileWidths.push(w);
  }

  return { base64Chunks, tileWidths, width, height };
}

app.post('/render', async (req, res) => {
  try {
    const { latex, fontSize, pixelDensity } = req.body || {};
    if (typeof latex !== 'string' || latex.length === 0) {
      return res.status(400).json({ error: 'latex string required' });
    }
    const fontPx = Number.isFinite(fontSize) ? fontSize : 64;
    const density = Number.isFinite(pixelDensity) ? pixelDensity : 2;

    const result = await renderLatex(latex, fontPx, density);
    res.json(result);
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => console.log(`KaTeX renderer listening on ${PORT}`));

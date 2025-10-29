// server.js
// KaTeX renderer -> PNG -> raw RGBA tiles -> base64 JSON response
// Uses: express, cors, katex, puppeteer, sharp

const express = require('express');
const cors = require('cors');
const katex = require('katex');
const puppeteer = require('puppeteer');
const sharp = require('sharp');

const MAX_TILE = 1024;
const KATEX_CSS_LINK = 'https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.min.css';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cors());

// Simple persistent browser/pool singleton for speed
let BrowserSingleton = null;
async function GetBrowser() {
  if (BrowserSingleton && BrowserSingleton.process() && !BrowserSingleton.process().killed) return BrowserSingleton;
  BrowserSingleton = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  return BrowserSingleton;
}

function HtmlTemplate(latex, fontPx) {
  // KaTeX renderToString will escape/convert, use displayMode false for inline fallback
  const mathHTML = katex.renderToString(latex, {
    throwOnError: false,
    displayMode: true
  });

  // inline small CSS to ensure white text and transparent background
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
        color: #FFFFFF;
        background: transparent;
        font-size: ${fontPx}px;
        line-height: 1;
        padding: 0;
        margin: 0;
      }
      /* remove selection artifacts */
      * { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    </style>
  </head>
  <body>
    <div id="Math">${mathHTML}</div>
  </body>
</html>`;
}

async function RenderLatexToRgbaTiles(latex, fontPx = 64, pixelDensity = 2) {
  const browser = await GetBrowser();
  const page = await browser.newPage();

  // Set an initial large viewport; we'll get bounding box of #Math
  await page.setViewport({ width: 4096, height: 2048, deviceScaleFactor: pixelDensity });
  await page.setContent(HtmlTemplate(latex, fontPx), { waitUntil: 'networkidle0' });

  const el = await page.$('#Math');
  if (!el) {
    await page.close();
    throw new Error('Math element not found after rendering');
  }

  // get bounding box (CSS pixels) and adjust size
  const bbox = await el.boundingBox();
  // boundingBox might be null if element invisible
  if (!bbox) {
    await page.close();
    throw new Error('Unable to measure math bounding box');
  }

  // screenshot of element with transparency (omitBackground)
  const pngBuffer = await el.screenshot({ type: 'png', omitBackground: true });
  await page.close();

  // Use sharp to get metadata (reported in device pixels already because image is rasterized)
  const meta = await sharp(pngBuffer).metadata();
  const width = meta.width || Math.ceil(bbox.width * pixelDensity);
  const height = meta.height || Math.ceil(bbox.height * pixelDensity);

  // slice horizontally into tiles (left to right), convert to raw RGBA
  const base64Chunks = [];
  const tileWidths = [];

  for (let left = 0; left < width; left += MAX_TILE) {
    const tileWidth = Math.min(MAX_TILE, width - left);
    const tileBuffer = await sharp(pngBuffer)
      .extract({ left, top: 0, width: tileWidth, height })
      .raw()
      .toBuffer(); // raw RGBA

    base64Chunks.push(tileBuffer.toString('base64'));
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

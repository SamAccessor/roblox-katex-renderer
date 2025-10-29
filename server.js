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

const App = express();
App.use(express.json({ limit: '10mb' }));
App.use(cors());

let BrowserSingleton = null;
async function GetBrowser() {
  if (BrowserSingleton) return BrowserSingleton;
  BrowserSingleton = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  return BrowserSingleton;
}

function HtmlTemplate(latex, fontPx) {
  const mathHTML = katex.renderToString(latex, { throwOnError: false, displayMode: true });
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8"/>
    <link rel="stylesheet" href="${KATEX_CSS_LINK}">
    <style>
      html, body { margin:0; padding:0; background:transparent; }
      #Math { display:inline-block; color:#FFFFFF; background:transparent; font-size:${fontPx}px; line-height:1; margin:0; padding:0; }
      *{ -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }
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
  await page.setViewport({ width: 4096, height: 2048, deviceScaleFactor: pixelDensity });

  await page.setContent(HtmlTemplate(latex, fontPx), { waitUntil: 'networkidle0' });

  const el = await page.$('#Math');
  if (!el) { await page.close(); throw new Error('Math element not found'); }

  const pngBuffer = await el.screenshot({ type: 'png', omitBackground: true });
  await page.close();

  const meta = await sharp(pngBuffer).metadata();
  const Width = meta.width || 0;
  const Height = meta.height || 0;
  if (!Width || !Height) throw new Error('Invalid rendered image dimensions');

  const Base64Chunks = [];
  const TileWidths = [];
  for (let left = 0; left < Width; left += MAX_TILE) {
    const TileWidth = Math.min(MAX_TILE, Width - left);
    const TileBuffer = await sharp(pngBuffer)
      .extract({ left, top: 0, width: TileWidth, height: Height })
      .raw()
      .toBuffer();
    Base64Chunks.push(TileBuffer.toString('base64'));
    TileWidths.push(TileWidth);
  }

  return {
    base64Chunks: Base64Chunks,
    tileWidths: TileWidths,
    width: Width,
    height: Height,
    pixelDensity,
    equationHeightPx: Height,
    bytesPerPixel: 4,
    channelOrder: 'RGBA'
  };
}

App.post('/render', async (req, res) => {
  try {
    const { latex, fontSize, pixelDensity } = req.body || {};
    if (typeof latex !== 'string' || latex.length === 0) {
      return res.status(400).json({ error: 'latex string required' });
    }
    const FontPx = Number.isFinite(fontSize) ? fontSize : 64;
    const Density = Number.isFinite(pixelDensity) ? pixelDensity : 2;
    const Result = await RenderLatexToRgbaTiles(latex, FontPx, Density);
    res.json(Result);
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
App.listen(PORT, () => console.log(`KaTeX renderer listening on ${PORT}`));


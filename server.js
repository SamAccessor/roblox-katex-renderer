// server.js -- MathJax + Sharp renderer
// - Converts LaTeX -> SVG via MathJax (server-side)
// - Uses sharp to rasterize SVG -> PNG/raw RGBA
// - Slices left->right into tiles <= 1024px and returns base64 raw RGBA tiles

const express = require('express');
const cors = require('cors');
const sharp = require('sharp');
const MathJax = require('mathjax'); // mathjax package
const bodyParser = require('body-parser');

const MAX_TILE = 1024;
const App = express();
App.use(cors());
App.use(bodyParser.json({ limit: '10mb' }));

// Initialize MathJax once
let MathJaxInstancePromise = null;
function InitMathJax() {
  if (!MathJaxInstancePromise) {
    // mathjax.init API returns a Promise that resolves to a MathJax object with converters
    MathJaxInstancePromise = MathJax.init({
      loader: { load: ['input/tex', 'output/svg'] },
      tex: { packages: ['base', 'ams'] },
    });
  }
  return MathJaxInstancePromise;
}

// Wrap latex into an SVG string using MathJax
async function LatexToSvg(latex, fontPx = 64) {
  const MathJaxObj = await InitMathJax();
  // tex2svg returns an element-like object or serialized string depending on API;
  // MathJax v4 exported API exposes a `tex2svg` method that returns an SVG node with outerHTML
  // We'll coerce to string
  const svgNode = MathJaxObj.tex2svg(latex, { display: true });
  // Some builds return a node; take outerHTML if present, else assume it's a string.
  const svgString = (typeof svgNode === 'string') ? svgNode : (svgNode.outerHTML || svgNode.toString());
  // Wrap the svg (MathJax output may not set font-size on top-level). Add width:auto and style white fill + transparent background.
  // We'll insert a CSS to ensure fill white and preserve transparency.
  const wrappedSvg = `
    <svg xmlns="http://www.w3.org/2000/svg">
      <foreignObject x="0" y="0" width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml">
          <style>
            :root { background: transparent; color: #FFFFFF; }
            svg { fill: #FFFFFF; }
          </style>
          ${svgString}
        </div>
      </foreignObject>
    </svg>
  `;
  return wrappedSvg;
}

// Rasterize SVG at desired pixelDensity & compute dimensions
async function SvgToRgbaTiles(svgString, fontPx = 64, pixelDensity = 2) {
  // Determine an explicit raster width/height by letting sharp render at an initial scale
  // We'll rasterize the svg to a PNG buffer at a reasonably large width, then use sharp.metadata() to get exact pixels.
  // Because MathJax output has intrinsic sizing, sharp can compute the raster size from the SVG's viewBox.
  // Use density param by scaling via the `density` option when input is SVG (SVG density is DPI-like)
  // We'll pass the svg buffer to sharp and let it rasterize at appropriate dimensions.
  // To ensure crispness, we can multiply by pixelDensity.
  const svgBuffer = Buffer.from(svgString, 'utf8');

  // First rasterize to PNG buffer at scale (sharp has options: svg input supports density but exact sizing depends on SVG)
  // To guarantee high-res, we can render at a large width by setting a big width param, but we don't know desired width
  // Simpler: render to PNG with no explicit width, then use metadata to get pixel dimensions.
  const pngBuffer = await sharp(svgBuffer, { density: 72 * pixelDensity }).png({ quality: 100 }).toBuffer();
  const meta = await sharp(pngBuffer).metadata();
  const width = meta.width;
  const height = meta.height;

  if (!width || !height) throw new Error('Could not rasterize SVG to a valid image (no width/height)');

  const base64Chunks = [];
  const tileWidths = [];

  for (let left = 0; left < width; left += MAX_TILE) {
    const tileWidth = Math.min(MAX_TILE, width - left);
    const tileRaw = await sharp(pngBuffer)
      .extract({ left, top: 0, width: tileWidth, height })
      .raw()
      .toBuffer(); // raw RGBA, 4 bytes per pixel
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

    // Convert latex -> SVG -> rasterized tiles
    const svg = await LatexToSvg(latex, fontPx);
    const result = await SvgToRgbaTiles(svg, fontPx, density);
    res.json(result);
  } catch (err) {
    console.error('Render error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
App.listen(PORT, () => console.log(`MathJax renderer listening on ${PORT}`));

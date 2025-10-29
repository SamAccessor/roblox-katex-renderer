import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import sharp from "sharp";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";

const App = express();
App.use(cors());
App.use(bodyParser.json({ limit: "20mb" }));

const Adaptor = liteAdaptor();
RegisterHTMLHandler(Adaptor);
const Tex = new TeX({ packages: AllPackages });
const SvgOutput = new SVG({ fontCache: "none" });
const MjDocument = mathjax.document("", { InputJax: Tex, OutputJax: SvgOutput });

class LruCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }
  get(key) {
    const v = this.map.get(key);
    if (!v) return null;
    this.map.delete(key);
    this.map.set(key, v);
    return v.value;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, ts: Date.now() });
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);
  }
}

const Cache = new LruCache(800);

function extractSvg(html) {
  if (!html) return null;
  const m = html.match(/<svg[\s\S]*?<\/svg>/i);
  if (m) return m[0].trim();
  const u = html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const m2 = u.match(/<svg[\s\S]*?<\/svg>/i);
  if (m2) return m2[0].trim();
  return null;
}

function ensureXmlns(svg) {
  if (!svg) return svg;
  if (/\sxmlns=/.test(svg)) return svg;
  return svg.replace(/<svg([^>]*)>/i, '<svg xmlns="http://www.w3.org/2000/svg"$1>');
}

async function svgToRgbaTiles(svg, pixelDensity = 2) {
  const png = await sharp(Buffer.from(svg, "utf8"), { limitInputPixels: false }).png().toBuffer();
  const meta = await sharp(png).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) throw new Error("invalid raster dimensions");
  const tiles = [];
  const tileWidths = [];
  const tileHeights = [];
  for (let top = 0; top < height; top += 1024) {
    const rowHeight = Math.min(1024, height - top);
    for (let left = 0; left < width; left += 1024) {
      const tileWidth = Math.min(1024, width - left);
      const raw = await sharp(png).extract({ left, top, width: tileWidth, height: rowHeight }).raw().toBuffer();
      tiles.push(raw.toString("base64"));
      tileWidths.push(tileWidth);
      tileHeights.push(rowHeight);
    }
  }
  return { tiles, tileWidths, tileHeights, width, height, bytesPerPixel: 4, channelOrder: "RGBA", pixelDensity };
}

async function renderLatex(latex, fontSize = 64, pixelDensity = 2, retries = 3) {
  const key = `${latex}|${fontSize}|${pixelDensity}`;
  const cached = Cache.get(key);
  if (cached) return { success: true, cached: true, ...cached };
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const node = MjDocument.convert(latex, { display: true, em: fontSize / 16, ex: fontSize / 8, containerWidth: 80 * 16 });
      let raw = Adaptor.outerHTML(node);
      let svg = extractSvg(raw);
      if (!svg) svg = `<svg xmlns="http://www.w3.org/2000/svg"><g fill="#FFFFFF">${String(raw)}</g></svg>`;
      svg = ensureXmlns(svg);
      if (!svg.includes("<svg")) throw new Error("no svg");
      const tilesResult = await svgToRgbaTiles(svg, pixelDensity);
      Cache.set(key, tilesResult);
      return { success: true, cached: false, ...tilesResult };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, 120 * attempt));
      else return { success: false, error: String(err && err.message ? err.message : err) };
    }
  }
  return { success: false, error: String(lastErr) };
}

App.get("/health", (_, res) => res.json({ ok: true }));

App.post("/renderFast", async (req, res) => {
  try {
    const { latex, fontSize = 64, pixelDensity = 2 } = req.body || {};
    const key = `${latex}|${fontSize}|${pixelDensity}`;
    const cached = Cache.get(key);
    if (!cached) return res.json({ hit: false });
    return res.json({ hit: true, result: cached });
  } catch (err) {
    return res.status(500).json({ hit: false, error: String(err && err.message ? err.message : err) });
  }
});

App.post("/prewarm", async (req, res) => {
  try {
    const jobs = Array.isArray(req.body) ? req.body : [];
    const results = [];
    for (const j of jobs) {
      const latex = String(j.latex || "");
      const fontSize = Number.isFinite(j.fontSize) ? j.fontSize : 64;
      const pixelDensity = Number.isFinite(j.pixelDensity) ? j.pixelDensity : 2;
      if (!latex) continue;
      const r = await renderLatex(latex, fontSize, pixelDensity, 3);
      results.push({ latex, ok: r.success });
    }
    return res.json({ ok: true, results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
});

App.post("/render", async (req, res) => {
  try {
    const { latex, fontSize = 64, pixelDensity = 2, requestId = "" } = req.body || {};
    if (!latex) return res.status(400).json({ success: false, requestId, error: "latex required" });
    const result = await renderLatex(latex, fontSize, pixelDensity, 4);
    if (!result.success) return res.status(500).json({ success: false, requestId, error: result.error || "render error" });
    return res.json({
      success: true,
      requestId,
      tiles: result.tiles,
      tileWidths: result.tileWidths,
      tileHeights: result.tileHeights,
      width: result.width,
      height: result.height,
      bytesPerPixel: result.bytesPerPixel,
      channelOrder: result.channelOrder,
      pixelDensity: result.pixelDensity
    });
  } catch (err) {
    return res.status(500).json({ success: false, requestId: "", error: String(err && err.message ? err.message : err) });
  }
});

const PORT = Number(process.env.PORT || 10000);
App.listen(PORT);

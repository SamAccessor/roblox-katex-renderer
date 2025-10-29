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

const PixelDensity = 3;
const TileMax = 1024;

const Adaptor = liteAdaptor();
RegisterHTMLHandler(Adaptor);
const Tex = new TeX({ packages: AllPackages });
const SvgOutput = new SVG({ fontCache: "none" });
const MjDocument = mathjax.document("", { InputJax: Tex, OutputJax: SvgOutput });

function extractSvg(html) {
  if (!html) return null;
  const m = html.match(/<svg[\s\S]*?<\/svg>/i);
  if (m) return m[0].trim();
  const unescaped = html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const m2 = unescaped.match(/<svg[\s\S]*?<\/svg>/i);
  if (m2) return m2[0].trim();
  return null;
}

function ensureXmlnsOnce(svg) {
  if (!svg) return svg;
  if (/\sxmlns=/.test(svg)) return svg;
  return svg.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
}

async function svgToTiles(svg) {
  const png = await sharp(Buffer.from(svg, "utf8"), { limitInputPixels: false }).png().toBuffer();
  const meta = await sharp(png).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) throw new Error("invalid raster dimensions");
  const tiles = [];
  const tileWidths = [];
  const tileHeights = [];
  for (let top = 0; top < height; top += TileMax) {
    const rowH = Math.min(TileMax, height - top);
    for (let left = 0; left < width; left += TileMax) {
      const tileW = Math.min(TileMax, width - left);
      const raw = await sharp(png).extract({ left, top, width: tileW, height: rowH }).raw().toBuffer();
      tiles.push(raw.toString("base64"));
      tileWidths.push(tileW);
      tileHeights.push(rowH);
    }
  }
  return { tiles, tileWidths, tileHeights, width, height, bytesPerPixel: 4, channelOrder: "RGBA" };
}

async function renderLatex(latex, fontSizeRequested) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const minFontPx = 6;
      const fontPx = Math.max(minFontPx, Math.round(fontSizeRequested * PixelDensity));
      const node = MjDocument.convert(latex, { display: true });
      let raw = Adaptor.outerHTML(node);
      let svg = extractSvg(raw);
      if (!svg) svg = `<svg xmlns="http://www.w3.org/2000/svg"><g>${String(raw)}</g></svg>`;
      svg = ensureXmlnsOnce(svg);
      const styleTag = `<style>svg{font-size:${fontPx}px}svg *{fill:#ffffff !important;color:#ffffff !important;stroke:none !important}svg{background:transparent}</style>`;
      if (!svg.includes("svg *{fill:#ffffff")) svg = svg.replace(/^<svg\b([^>]*)>/i, (m, attrs) => `<svg${attrs}>${styleTag}`);
      const tilesResult = await svgToTiles(svg);
      return { success: true, fontSizeRequested, fontPx, pixelDensity: PixelDensity, ...tilesResult };
    } catch (e) {
      lastErr = e;
      if (attempt < 5) await new Promise(r => setTimeout(r, 120 * attempt));
    }
  }
  return { success: false, error: String(lastErr && lastErr.message ? lastErr.message : lastErr) };
}

// --- Health Check Endpoint --- //
app.get("/health", async (req, res) => {
  try {
    const uptimeSeconds = process.uptime();
    const memory = process.memoryUsage();
    const memoryMB = (memory.rss / 1024 / 1024).toFixed(2);

    res.status(200).json({
      status: "OK",
      timestamp: new Date().toISOString(),
      uptime_seconds: uptimeSeconds,
      memory_mb: memoryMB,
      pid: process.pid,
    });
  } catch (err) {
    console.error("[/health] Error:", err);
    res.status(500).json({ status: "ERROR", message: err.message });
  }
});

App.post("/render", async (req, res) => {
  try {
    const latex = typeof req.body?.latex === "string" ? req.body.latex : "";
    const fontSizeRequested = Number.isFinite(req.body?.fontSize) ? Number(req.body.fontSize) : 64;
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId : "";
    if (!latex) return res.status(400).json({ success: false, requestId, error: "latex required" });
    console.log("[Server] render request", requestId, "fontSizeRequested=", fontSizeRequested, "len=", latex.length);
    const result = await renderLatex(latex, fontSizeRequested);
    if (!result.success) {
      console.error("[Server] render failed", result.error);
      return res.status(500).json({ success: false, requestId, error: result.error });
    }
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
      pixelDensity: result.pixelDensity,
      fontPx: result.fontPx,
      fontSizeRequested: result.fontSizeRequested
    });
  } catch (err) {
    console.error("[Server] unexpected error", err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, requestId: "", error: String(err && err.message ? err.message : err) });
  }
});

const Port = Number(process.env.PORT || 10000);
App.listen(Port, () => console.log(`[Server] listening on port ${Port}`));

// --- Keep Render awake and handle retries --- //
const SELF_URL = "https://roblox-katex-renderer.onrender.com";
const KEEPALIVE_INTERVAL = 25_000; // 25 seconds
const MAX_RETRIES = 3;

async function pingSelf(attempt = 1) {
  try {
    const res = await fetch(`${SELF_URL}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(`[KeepAlive] ✅ Ping OK (Attempt ${attempt})`, data);
  } catch (err) {
    console.warn(`[KeepAlive] ❌ Ping failed (Attempt ${attempt}):`, err.message);
    if (attempt < MAX_RETRIES) {
      setTimeout(() => pingSelf(attempt + 1), 2000); // retry after 2s
    } else {
      console.error("[KeepAlive] 🚨 All retries failed.");
    }
  }
}

// run every 25s
setInterval(pingSelf, KEEPALIVE_INTERVAL);

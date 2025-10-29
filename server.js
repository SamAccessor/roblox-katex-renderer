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

function ExtractSvg(html) {
  if (!html) return null;
  const m = html.match(/<svg[\s\S]*?<\/svg>/i);
  if (m) return m[0].trim();
  const u = html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const m2 = u.match(/<svg[\s\S]*?<\/svg>/i);
  if (m2) return m2[0].trim();
  return null;
}

function EnsureXmlns(svg) {
  if (!svg) return svg;
  if (/\sxmlns=/.test(svg)) return svg;
  return svg.replace(/<svg([^>]*)>/i, '<svg xmlns="http://www.w3.org/2000/svg"$1');
}

async function SvgToTiles(svg, density = PixelDensity) {
  console.log("[Server] SvgToTiles: creating PNG buffer");
  const png = await sharp(Buffer.from(svg, "utf8"), { limitInputPixels: false }).png().toBuffer();
  console.log("[Server] SvgToTiles: png length", png.length);
  const meta = await sharp(png).metadata();
  const width = meta.width;
  const height = meta.height;
  console.log("[Server] SvgToTiles: width,height", width, height);
  if (!width || !height) throw new Error("invalid raster dimensions");
  const tiles = [];
  const tileWidths = [];
  const tileHeights = [];
  for (let top = 0; top < height; top += TileMax) {
    const rowH = Math.min(TileMax, height - top);
    for (let left = 0; left < width; left += TileMax) {
      const tileW = Math.min(TileMax, width - left);
      console.log(`[Server] SvgToTiles: extracting tile left=${left} top=${top} w=${tileW} h=${rowH}`);
      const raw = await sharp(png).extract({ left, top, width: tileW, height: rowH }).raw().toBuffer();
      console.log("[Server] SvgToTiles: raw buffer length", raw.length);
      tiles.push(raw.toString("base64"));
      tileWidths.push(tileW);
      tileHeights.push(rowH);
    }
  }
  return { tiles, tileWidths, tileHeights, width, height, bytesPerPixel: 4, channelOrder: "RGBA", pixelDensity: density };
}

async function RenderLatex(latex, fontSize) {
  console.log("[Server] RenderLatex: start", latex.length, "chars, fontSize=", fontSize);
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log("[Server] RenderLatex: attempt", attempt);
      const node = MjDocument.convert(latex, { display: true, em: fontSize / 16, ex: fontSize / 8, containerWidth: 80 * 16 });
      let raw = Adaptor.outerHTML(node);
      console.log("[Server] RenderLatex: raw length", (raw || "").length);
      let svg = ExtractSvg(raw);
      if (!svg) {
        console.log("[Server] RenderLatex: no svg found, wrapping fallback");
        svg = `<svg xmlns="http://www.w3.org/2000/svg"><g fill="#FFFFFF">${String(raw)}</g></svg>`;
      }
      svg = EnsureXmlns(svg);
      svg = svg.replace(/<svg([^>]*)>/i, (m, attrs) => {
        let out = "<svg" + attrs;
        if (!/style=/.test(attrs)) out += ' style="background:transparent"';
        return out + ">";
      });
      svg = svg.replace(/<g([^>]*)>/i, (m, attrs) => {
        if (/fill=/.test(m)) return m;
        return '<g fill="#FFFFFF">';
      });
      console.log("[Server] RenderLatex: final svg length", svg.length);
      const tilesResult = await SvgToTiles(svg, PixelDensity);
      console.log("[Server] RenderLatex: success, tiles", tilesResult.tiles.length);
      return { success: true, fontSize, pixelDensity: PixelDensity, ...tilesResult };
    } catch (e) {
      console.warn("[Server] RenderLatex: error on attempt", attempt, e && e.message ? e.message : e);
      lastErr = e;
      if (attempt < 5) await new Promise(r => setTimeout(r, 100 * attempt));
    }
  }
  return { success: false, error: String(lastErr && lastErr.message ? lastErr.message : lastErr) };
}

App.get("/health", (_, res) => res.json({ ok: true }));

App.post("/render", async (req, res) => {
  try {
    const latex = typeof req.body?.latex === "string" ? req.body.latex : "";
    const fontSize = Number.isFinite(req.body?.fontSize) ? Number(req.body.fontSize) : 64;
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId : "";
    console.log("[Server] /render received requestId=", requestId, "latex length=", latex.length, "fontSize=", fontSize);
    if (!latex) {
      console.warn("[Server] /render missing latex");
      return res.status(400).json({ success: false, requestId, error: "latex required" });
    }
    const result = await RenderLatex(latex, fontSize);
    if (!result.success) {
      console.error("[Server] /render final failure", result.error);
      return res.status(500).json({ success: false, requestId, error: result.error });
    }
    console.log("[Server] /render returning success, tiles=", result.tiles.length);
    return res.json({ success: true, requestId, tiles: result.tiles, tileWidths: result.tileWidths, tileHeights: result.tileHeights, width: result.width, height: result.height, bytesPerPixel: result.bytesPerPixel, channelOrder: result.channelOrder, pixelDensity: result.pixelDensity, fontSize: result.fontSize });
  } catch (err) {
    console.error("[Server] /render unexpected error", err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, requestId: "", error: String(err && err.message ? err.message : err) });
  }
});

const Port = Number(process.env.PORT || 10000);
App.listen(Port, () => console.log(`[Server] listening on port ${Port}`));

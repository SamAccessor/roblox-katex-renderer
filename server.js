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
  return { tiles, tileWidths, tileHeights, width, height, bytesPerPixel: 4, channelOrder: "RGBA", pixelDensity: density };
}

async function RenderLatex(latex, fontSize) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const node = MjDocument.convert(latex, { display: true, em: fontSize / 16, ex: fontSize / 8, containerWidth: 80 * 16 });
      let raw = Adaptor.outerHTML(node);
      let svg = ExtractSvg(raw);
      if (!svg) svg = `<svg xmlns="http://www.w3.org/2000/svg"><g fill="#FFFFFF">${String(raw)}</g></svg>`;
      svg = EnsureXmlns(svg);
      svg = svg.replace(/<svg([^>]*)>/i, (m, attrs) => {
        let out = "<svg" + attrs;
        if (!/style=/.test(attrs)) out += ' style="background:transparent"';
        if (!/fill=/.test(attrs)) out = out.replace(/<svg/, '<svg');
        return out + ">";
      });
      svg = svg.replace(/<g([^>]*)>/i, (m, attrs) => {
        if (/fill=/.test(m)) return m;
        return '<g fill="#FFFFFF">';
      });
      const tilesResult = await SvgToTiles(svg, PixelDensity);
      return { success: true, fontSize, pixelDensity: PixelDensity, ...tilesResult };
    } catch (e) {
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
    if (!latex) return res.status(400).json({ success: false, requestId, error: "latex required" });
    const result = await RenderLatex(latex, fontSize);
    if (!result.success) return res.status(500).json({ success: false, requestId, error: result.error });
    return res.json({ success: true, requestId, tiles: result.tiles, tileWidths: result.tileWidths, tileHeights: result.tileHeights, width: result.width, height: result.height, bytesPerPixel: result.bytesPerPixel, channelOrder: result.channelOrder, pixelDensity: result.pixelDensity, fontSize: result.fontSize });
  } catch (err) {
    return res.status(500).json({ success: false, requestId: "", error: String(err && err.message ? err.message : err) });
  }
});

const Port = Number(process.env.PORT || 10000);
App.listen(Port);

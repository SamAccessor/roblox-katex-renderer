// server.js
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
App.use(bodyParser.json({ limit: "10mb" }));

const Adaptor = liteAdaptor();
RegisterHTMLHandler(Adaptor);

const Tex = new TeX({ packages: AllPackages });
const SvgOutput = new SVG({ fontCache: "none" });
const MjDocument = mathjax.document("", { InputJax: Tex, OutputJax: SvgOutput });

function extractSvgCandidate(htmlString) {
  if (!htmlString) return null;
  const svgMatch = htmlString.match(/<svg[\s\S]*?<\/svg>/i);
  if (svgMatch) return svgMatch[0].trim();
  // attempt to unescape common entities and try again
  const unescaped = htmlString.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const svgMatch2 = unescaped.match(/<svg[\s\S]*?<\/svg>/i);
  if (svgMatch2) return svgMatch2[0].trim();
  return null;
}

function ensureXmlns(svgText) {
  if (!svgText) return svgText;
  if (/xmlns=/.test(svgText)) return svgText;
  // inject xmlns into opening svg tag
  return svgText.replace(/<svg([\s>])/i, '<svg xmlns="http://www.w3.org/2000/svg"$1');
}

function wrapFallback(content) {
  const safe = String(content)
    .replace(/<\/?script[\s\S]*?>/gi, "") // remove scripts if any
    .replace(/<svg[^>]*>/i, "") // remove accidental nested svg open
    .replace(/<\/svg>/i, "");
  return `<svg xmlns="http://www.w3.org/2000/svg"><g fill="#ffffff">${safe}</g></svg>`;
}

async function renderLatexToBase64(latex, fontSize = 64, retries = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const node = MjDocument.convert(latex, {
        display: true,
        em: fontSize / 16,
        ex: fontSize / 8,
        containerWidth: 80 * 16
      });

      let raw = Adaptor.outerHTML(node);
      if (typeof raw !== "string") raw = String(raw || "");

      const svgCandidate = extractSvgCandidate(raw);
      let finalSvg = svgCandidate;
      if (!finalSvg) finalSvg = wrapFallback(raw);
      finalSvg = ensureXmlns(finalSvg);

      // final sanity check
      if (!finalSvg.includes("<svg") || !finalSvg.includes("</svg>")) {
        throw new Error("Unable to produce valid SVG");
      }

      // optional small trimming of whitespace/newlines
      finalSvg = finalSvg.trim();

      // produce PNG from SVG
      const pngBuffer = await sharp(Buffer.from(finalSvg, "utf8"), { limitInputPixels: false })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();

      return { success: true, base64: pngBuffer.toString("base64") };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 150 * attempt));
        continue;
      }
      return { success: false, error: String(err && err.message ? err.message : err) };
    }
  }
  return { success: false, error: String(lastErr) };
}

App.get("/health", (_, res) => res.json({ ok: true }));

App.post("/render", async (req, res) => {
  try {
    const latex = typeof req.body?.latex === "string" ? req.body.latex : "";
    if (!latex) return res.status(400).json({ success: false, error: "Missing LaTeX" });

    const truncated = (latex.length > 200 ? latex.slice(0, 200) + "..." : latex);
    console.log(`[RenderRaw] Rendering (truncated): ${truncated}`);

    const result = await renderLatexToBase64(latex, Number(req.body.fontSize) || 64, 5);

    if (!result.success) {
      console.error("Render failed:", result.error);
      return res.status(500).json({ success: false, error: result.error });
    }

    return res.json({ success: true, base64: result.base64 });
  } catch (err) {
    console.error("Unexpected render error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  }
});

const PORT = Number(process.env.PORT || 10000);
App.listen(PORT, () => console.log(`✅ MathJax Render Server running on port ${PORT}`));

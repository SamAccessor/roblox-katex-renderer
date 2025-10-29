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

// -------------------- Setup --------------------
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: "none" });
const mj = mathjax.document("", { InputJax: tex, OutputJax: svg });

function sanitizeSVG(svgText) {
  // Extract the <svg> root if wrapped in <mjx-container> or other nodes
  const match = svgText.match(/<svg[^>]*>[\s\S]*<\/svg>/);
  if (match) return match[0].trim();
  return `<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="16" fill="white">Invalid SVG</text></svg>`;
}

// Retry wrapper
async function safeRenderMath(latex, fontSize, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const node = mj.convert(latex, {
        display: true,
        em: fontSize / 16,
        ex: fontSize / 8,
        containerWidth: 80 * 16,
      });

      let svgOutput = adaptor.outerHTML(node).trim();
      svgOutput = sanitizeSVG(svgOutput);

      // Validate that we now have proper <svg>
      if (!svgOutput.includes("<svg") || !svgOutput.includes("</svg>")) {
        throw new Error("MathJax output missing <svg> root");
      }

      const pngBuffer = await sharp(Buffer.from(svgOutput))
        .png({ compressionLevel: 9 })
        .toBuffer();

      return pngBuffer.toString("base64");
    } catch (err) {
      console.warn(`[Attempt ${attempt}] Render error: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

// -------------------- Render Route --------------------
app.post("/render", async (req, res) => {
  try {
    const { latex, fontSize = 32 } = req.body;
    if (!latex || typeof latex !== "string") {
      return res.status(400).json({ success: false, error: "Missing or invalid LaTeX string" });
    }

    console.log(`[RenderRaw] Rendering: ${latex}`);

    const base64 = await safeRenderMath(latex, fontSize);

    res.json({ success: true, base64 });
    console.log("✅ Render successful");
  } catch (err) {
    console.error("❌ Render failed:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------- Launch --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ MathJax Render Server running on port ${PORT}`));

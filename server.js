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
const mathDocument = mathjax.document("", { InputJax: tex, OutputJax: svg });

// -------------------- Render Route --------------------
app.post("/render", async (req, res) => {
  try {
    const { latex, fontSize = 32 } = req.body;
    if (!latex || typeof latex !== "string") {
      return res.status(400).json({ success: false, error: "Missing or invalid LaTeX string" });
    }

    console.log(`[RenderRaw] Rendering: ${latex}`);

    // --- Convert LaTeX → SVG ---
    const node = mathDocument.convert(latex, {
      display: true,
      em: fontSize / 16,
      ex: fontSize / 8,
      containerWidth: 80 * 16
    });

    let svgOutput = adaptor.outerHTML(node).trim();

    // Ensure valid <svg> root
    if (!svgOutput.startsWith("<svg")) {
      console.error("❌ MathJax did not produce a valid SVG root, repairing...");
      svgOutput = `<svg xmlns="http://www.w3.org/2000/svg">${svgOutput}</svg>`;
    }

    // --- Validate ---
    if (!svgOutput.includes("<svg") || !svgOutput.includes("</svg>")) {
      throw new Error("SVG output invalid — missing <svg> tags");
    }

    // --- Convert SVG → PNG (transparent, high-res) ---
    const pngBuffer = await sharp(Buffer.from(svgOutput))
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();

    const base64 = pngBuffer.toString("base64");

    res.json({
      success: true,
      base64,
      width: 1024,
      height: 1024,
    });

    console.log("✅ Render successful");
  } catch (err) {
    console.error("❌ Render failed:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------- Launch --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ MathJax Render Server running on port ${PORT}`));

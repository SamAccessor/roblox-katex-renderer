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

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "20mb" }));

// MathJax setup
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: "none" });
const mathDocument = mathjax.document("", { InputJax: tex, OutputJax: svg });

// Render endpoint
app.post("/render", async (req, res) => {
  try {
    const { latex, fontSize = 32 } = req.body;
    if (!latex) return res.json({ success: false, error: "latex required" });

    // Convert LaTeX → SVG string
    const node = mathDocument.convert(latex, { display: true });
    const svgOutput = adaptor.outerHTML(node);

    if (!svgOutput.includes("<svg")) {
      console.error("❌ Invalid SVG output from MathJax.");
      return res.json({ success: false, error: "invalid svg output" });
    }

    // Convert SVG → PNG
    const pngBuffer = await sharp(Buffer.from(svgOutput))
      .png()
      .toBuffer();

    const base64 = pngBuffer.toString("base64");
    res.json({
      success: true,
      tiles: [base64],
      width: 1024,
      height: 1024,
    });
  } catch (err) {
    console.error("Render failed:", err);
    res.json({ success: false, error: "render failed" });
  }
});

app.listen(3000, () => console.log("✅ Render server ready on port 3000"));

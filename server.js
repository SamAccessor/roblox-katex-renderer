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

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "5mb" }));

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const tex = new TeX({ packages: AllPackages });
const svg = new SVG({ fontCache: "none" });
const mj = mathjax.document("", { InputJax: tex, OutputJax: svg });

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
	try {
		const { latex } = req.body;
		if (!latex) return res.status(400).json({ success: false, error: "Missing LaTeX" });

		const node = mj.convert(latex, { display: true });
		let svgOutput = adaptor.outerHTML(node);

		if (!svgOutput.includes("<svg"))
			throw new Error("MathJax did not return valid SVG.");

		const pngBuffer = await sharp(Buffer.from(svgOutput))
			.png({ compressionLevel: 9 })
			.trim()
			.toBuffer();

		const base64 = pngBuffer.toString("base64");
		res.json({ success: true, base64 });
	} catch (err) {
		console.error("Render failed:", err);
		res.status(500).json({ success: false, error: err.message });
	}
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ MathJax Render Server running on port ${PORT}`));

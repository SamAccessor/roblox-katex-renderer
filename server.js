const express = require("express")
const cors = require("cors")
const bodyParser = require("body-parser")
const sharp = require("sharp")
const mathjax = require("mathjax")
const MaxTileSize = 1024
const PixelDensityPrimary = 2
const PixelDensityFallback = 1
const BytesPerPixel = 4
const ChannelOrder = "RGBA"
const RenderAttempts = 3
const Port = process.env.PORT || 3000
const App = express()
App.disable("x-powered-by")
App.use(cors())
App.use(bodyParser.json({limit: "1mb"}))

let MathJaxInstance = null
async function InitializeMathJax() {
	if (!MathJaxInstance) {
		MathJaxInstance = await mathjax.init({
			loader: {load: ["input/tex", "output/svg"]},
			tex: {packages: "all"},
			svg: {fontCache: "none"}
		})
	}
}
function BuildWhiteTransparentSvg(svgString) {
	let s = svgString
	s = s.replace(/fill="black"/g, 'fill="white"')
	if (!/style="/.test(s)) {
		s = s.replace(/<svg /, '<svg style="background:transparent;" ')
	} else {
		s = s.replace(/style="([^"]*)"/, function(m, p1) {
			const style = p1.includes("background") ? p1 : p1 + ";background:transparent;"
			return 'style="' + style + '"'
		})
	}
	return s
}
async function TexToSvg(latex, fontSize) {
	const mj = MathJaxInstance
	const svgNode = mj.svgDocument().convert(latex, {display: true, em: fontSize, ex: fontSize / 2})
	const svgString = mj.startup.adaptor.outerHTML(svgNode)
	return BuildWhiteTransparentSvg(svgString)
}
async function SvgToRawRgba(svg, density) {
	const svgBuffer = Buffer.from(svg)
	const image = sharp(svgBuffer, {density: density * 72, limitInputPixels: false})
	const metadata = await image.metadata()
	const width = Math.ceil((metadata.width || 0) * density)
	const height = Math.ceil((metadata.height || 0) * density)
	const resized = image.resize(width, height)
	const raw = await resized.raw().toBuffer()
	return {raw, width, height}
}
function TileRawRgba(raw, width, height, tileWidth, tileHeight) {
	const tiles = []
	const tileWidths = []
	const tileHeights = []
	for (let y = 0; y < height; y += tileHeight) {
		const th = Math.min(tileHeight, height - y)
		for (let x = 0; x < width; x += tileWidth) {
			const tw = Math.min(tileWidth, width - x)
			const tileBuffer = Buffer.alloc(tw * th * BytesPerPixel)
			for (let row = 0; row < th; row++) {
				const srcStart = ((y + row) * width + x) * BytesPerPixel
				const srcEnd = srcStart + tw * BytesPerPixel
				const dstStart = row * tw * BytesPerPixel
				raw.copy(tileBuffer, dstStart, srcStart, srcEnd)
			}
			tiles.push(tileBuffer.toString("base64"))
			tileWidths.push(tw)
			tileHeights.push(th)
		}
	}
	return {tiles, tileWidths, tileHeights}
}
async function RenderLatex(latex, fontSize) {
	let lastError = null
	for (let attempt = 1; attempt <= RenderAttempts; attempt++) {
		try {
			const density = attempt === 1 ? PixelDensityPrimary : PixelDensityFallback
			const svg = await TexToSvg(latex, fontSize)
			const {raw, width, height} = await SvgToRawRgba(svg, density)
			const {tiles, tileWidths, tileHeights} = TileRawRgba(raw, width, height, MaxTileSize, MaxTileSize)
			return {
				success: true,
				tiles,
				width,
				height,
				tileWidths,
				tileHeights,
				bytesPerPixel: BytesPerPixel,
				channelOrder: ChannelOrder,
				pixelDensity: density
			}
		} catch (e) {
			lastError = e && e.message ? e.message : "UnknownError"
		}
	}
	return {success: false, error: lastError || "RenderFailed"}
}
App.post("/render", async (req, res) => {
	try {
		const latex = req.body && typeof req.body.latex === "string" ? req.body.latex : null
		const fontSize = req.body && typeof req.body.fontSize === "number" ? req.body.fontSize : null
		if (!latex || !fontSize) {
			res.json({success: false, error: "InvalidInput"})
			return
		}
		await InitializeMathJax()
		const result = await RenderLatex(latex, fontSize)
		res.json(result)
	} catch (e) {
		res.json({success: false, error: "ServerError"})
	}
})
App.listen(Port)

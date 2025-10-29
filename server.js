const express = require("express")
const cors = require("cors")
const bodyParser = require("body-parser")
const sharp = require("sharp")
const mathjax = require("mathjax")
const App = express()
App.disable("x-powered-by")
App.use(cors())
App.use(bodyParser.json({limit: "1mb"}))

const Port = process.env.PORT || 3000
const MaxTileSize = 1024
const BytesPerPixel = 4
const ChannelOrder = "RGBA"
const RenderAttempts = 3
const PixelDensityPrimary = 2
const PixelDensityFallback = 1

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

function BuildWhiteTransparentSvg(S) {
	let R = S.replace(/fill="black"/g, 'fill="white"')
	if (!/style="/.test(R)) {
		R = R.replace(/<svg /, '<svg style="background:transparent;" ')
	} else {
		R = R.replace(/style="([^"]*)"/, function(M, P1) {
			const K = P1.includes("background") ? P1 : P1 + ";background:transparent;"
			return 'style="' + K + '"'
		})
	}
	return R
}

async function TexToSvg(Latex, FontSize) {
	const M = MathJaxInstance
	const Node = M.svgDocument().convert(Latex, {display: true, em: FontSize, ex: FontSize / 2})
	const Svg = M.startup.adaptor.outerHTML(Node)
	return BuildWhiteTransparentSvg(Svg)
}

async function SvgToRawRgba(Svg, Density) {
	const SvgBuffer = Buffer.from(Svg)
	const Image = sharp(SvgBuffer, {density: Density * 72, limitInputPixels: false})
	const Meta = await Image.metadata()
	const Width = Math.ceil((Meta.width || 0) * Density)
	const Height = Math.ceil((Meta.height || 0) * Density)
	const Raw = await Image.resize(Width, Height).raw().toBuffer()
	return {Raw, Width, Height}
}

function TileRawRgba(Raw, Width, Height, TileWidth, TileHeight) {
	const Tiles = []
	const TileWidths = []
	const TileHeights = []
	for (let y = 0; y < Height; y += TileHeight) {
		const Th = Math.min(TileHeight, Height - y)
		for (let x = 0; x < Width; x += TileWidth) {
			const Tw = Math.min(TileWidth, Width - x)
			const TileBuffer = Buffer.alloc(Tw * Th * BytesPerPixel)
			for (let row = 0; row < Th; row++) {
				const SrcStart = ((y + row) * Width + x) * BytesPerPixel
				const SrcEnd = SrcStart + Tw * BytesPerPixel
				const DstStart = row * Tw * BytesPerPixel
				Raw.copy(TileBuffer, DstStart, SrcStart, SrcEnd)
			}
			Tiles.push(TileBuffer.toString("base64"))
			TileWidths.push(Tw)
			TileHeights.push(Th)
		}
	}
	return {Tiles, TileWidths, TileHeights}
}

async function RenderLatex(Latex, FontSize) {
	let LastError = null
	for (let Attempt = 1; Attempt <= RenderAttempts; Attempt++) {
		try {
			const Density = Attempt === 1 ? PixelDensityPrimary : PixelDensityFallback
			const Svg = await TexToSvg(Latex, FontSize)
			const {Raw, Width, Height} = await SvgToRawRgba(Svg, Density)
			const {Tiles, TileWidths, TileHeights} = TileRawRgba(Raw, Width, Height, MaxTileSize, MaxTileSize)
			return {
				success: true,
				tiles: Tiles,
				width: Width,
				height: Height,
				tileWidths: TileWidths,
				tileHeights: TileHeights,
				bytesPerPixel: BytesPerPixel,
				channelOrder: ChannelOrder,
				pixelDensity: Density
			}
		} catch (E) {
			LastError = E && E.message ? E.message : "RenderFailed"
		}
	}
	return {success: false, error: LastError || "RenderFailed"}
}

App.post("/render", async (req, res) => {
	try {
		const Latex = req.body && typeof req.body.latex === "string" ? req.body.latex : null
		const FontSize = req.body && typeof req.body.fontSize === "number" ? req.body.fontSize : null
		if (!Latex || !FontSize) {
			res.json({success: false, error: "InvalidInput"})
			return
		}
		await InitializeMathJax()
		const Result = await RenderLatex(Latex, FontSize)
		res.json(Result)
	} catch (E) {
		res.json({success: false, error: "ServerError"})
	}
})

App.listen(Port)

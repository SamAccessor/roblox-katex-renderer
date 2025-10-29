// server.js

const express = require("express")
const cors = require("cors")
const bodyParser = require("body-parser")
const sharp = require("sharp")
const {mathjax} = require("mathjax-full/js/mathjax.js")
const {TeX} = require("mathjax-full/js/input/tex.js")
const {SVG} = require("mathjax-full/js/output/svg.js")
const {liteAdaptor} = require("mathjax-full/js/adaptors/liteAdaptor.js")
const {RegisterHTMLHandler} = require("mathjax-full/js/handlers/html.js")
const app = express()
app.disable("x-powered-by")
app.use(cors())
app.use(bodyParser.json({limit: "1mb"}))
const Port = process.env.PORT || 3000
const MaxTileSize = 1024
const PixelDensity = 2
const BytesPerPixel = 4
const ChannelOrder = "RGBA"
const RenderAttempts = 3

function RenderLatexToSVG(Latex, FontSize) {
	const Adaptor = liteAdaptor()
	RegisterHTMLHandler(Adaptor)
	const Html = mathjax.document("", {
		InputJax: new TeX({}),
		OutputJax: new SVG({fontCache: "none"})
	})
	const Node = Html.convert(Latex, {
		display: true,
		em: FontSize,
		ex: FontSize / 2,
	})
	let Svg = Adaptor.outerHTML(Node)
	Svg = Svg.replace(/fill="black"/g, 'fill="white"')
	Svg = Svg.replace(/<svg /, `<svg style="background:transparent;" `)
	return Svg
}

async function RenderSVGToPNGBuffer(Svg, Density) {
	const SvgBuffer = Buffer.from(Svg)
	const Image = sharp(SvgBuffer, {density: Density * 72, limitInputPixels: false})
	const Metadata = await Image.metadata()
	const Width = Math.ceil(Metadata.width * Density)
	const Height = Math.ceil(Metadata.height * Density)
	const PngBuffer = await Image
		.resize(Width, Height)
		.png({compressionLevel: 9, adaptiveFiltering: false, force: true})
		.toBuffer()
	return {PngBuffer, Width, Height}
}

function SplitBufferToTiles(Buffer, Width, Height, TileWidth, TileHeight) {
	const Tiles = []
	const TileWidths = []
	const TileHeights = []
	for (let y = 0; y < Height; y += TileHeight) {
		const CurrentTileHeight = Math.min(TileHeight, Height - y)
		TileHeights.push(CurrentTileHeight)
		for (let x = 0; x < Width; x += TileWidth) {
			const CurrentTileWidth = Math.min(TileWidth, Width - x)
			TileWidths.push(CurrentTileWidth)
			const Tile = Buffer.slice(
				(y * Width + x) * BytesPerPixel,
				((y + CurrentTileHeight) * Width + (x + CurrentTileWidth)) * BytesPerPixel
			)
			Tiles.push(Tile)
		}
	}
	return {Tiles, TileWidths, TileHeights}
}

async function RenderLatexImage(Latex, FontSize) {
	for (let Attempt = 1; Attempt <= RenderAttempts; Attempt++) {
		try {
			const Svg = RenderLatexToSVG(Latex, FontSize)
			const {PngBuffer, Width, Height} = await RenderSVGToPNGBuffer(Svg, PixelDensity)
			const Image = sharp(PngBuffer, {limitInputPixels: false})
			const RawBuffer = await Image.raw().toBuffer()
			const TileWidth = MaxTileSize
			const TileHeight = MaxTileSize
			const Tiles = []
			const TileWidths = []
			const TileHeights = []
			for (let y = 0; y < Height; y += TileHeight) {
				const CurrentTileHeight = Math.min(TileHeight, Height - y)
				TileHeights.push(CurrentTileHeight)
				for (let x = 0; x < Width; x += TileWidth) {
					const CurrentTileWidth = Math.min(TileWidth, Width - x)
					TileWidths.push(CurrentTileWidth)
					const TileBuffer = Buffer.alloc(CurrentTileWidth * CurrentTileHeight * BytesPerPixel)
					for (let ty = 0; ty < CurrentTileHeight; ty++) {
						const SrcStart = ((y + ty) * Width + x) * BytesPerPixel
						const SrcEnd = SrcStart + CurrentTileWidth * BytesPerPixel
						const DstStart = ty * CurrentTileWidth * BytesPerPixel
						RawBuffer.copy(TileBuffer, DstStart, SrcStart, SrcEnd)
					}
					Tiles.push(TileBuffer.toString("base64"))
				}
			}
			return {
				success: true,
				tiles: Tiles,
				width: Width,
				height: Height,
				tileWidths: TileWidths,
				tileHeights: TileHeights,
				bytesPerPixel: BytesPerPixel,
				channelOrder: ChannelOrder,
				pixelDensity: PixelDensity
			}
		} catch (Error) {
			if (Attempt === RenderAttempts) {
				return {success: false, error: Error.message}
			}
		}
	}
	return {success: false, error: "Unknown error"}
}

app.post("/render", async (req, res) => {
	const {latex, fontSize} = req.body
	if (typeof latex !== "string" || typeof fontSize !== "number") {
		res.json({success: false, error: "Invalid input"})
		return
	}
	const Result = await RenderLatexImage(latex, fontSize)
	res.json(Result)
})

app.listen(Port)

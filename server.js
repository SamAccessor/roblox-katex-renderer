const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { mathjax } = require('mathjax-full/js/mathjax');
const { TeX } = require('mathjax-full/js/input/tex');
const { SVG } = require('mathjax-full/js/output/svg');
const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor');
const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html');
const { AllPackages } = require('mathjax-full/js/input/tex/AllPackages');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const TexInput = new TeX({ packages: AllPackages });
const SvgOutput = new SVG({ fontCache: 'none' });
const MathJaxDocument = mathjax.document('', { InputJax: TexInput, OutputJax: SvgOutput });

async function RenderLatexToSvg(Latex, FontSize, Attempt = 1) {
    try {
        const ScaleFactor = FontSize / 16;
        const Node = MathJaxDocument.convert(Latex, {
            display: true,
            em: 16,
            ex: 8,
            containerWidth: 10000
        });
        
        let SvgString = adaptor.outerHTML(Node);
        
        SvgString = SvgString.replace(/currentColor/g, 'white');
        SvgString = SvgString.replace(/fill="[^"]*"/g, 'fill="white"');
        SvgString = SvgString.replace(/stroke="[^"]*"/g, 'stroke="white"');
        
        const WidthMatch = SvgString.match(/width="([^"]+)"/);
        const HeightMatch = SvgString.match(/height="([^"]+)"/);
        
        if (!WidthMatch || !HeightMatch) {
            throw new Error('Invalid SVG dimensions');
        }
        
        const ParseDimension = (Dim) => {
            const NumMatch = Dim.match(/[\d.]+/);
            return NumMatch ? parseFloat(NumMatch[0]) : 100;
        };
        
        const OriginalWidth = ParseDimension(WidthMatch[1]);
        const OriginalHeight = ParseDimension(HeightMatch[1]);
        
        const ScaledWidth = Math.ceil(OriginalWidth * ScaleFactor);
        const ScaledHeight = Math.ceil(OriginalHeight * ScaleFactor);
        
        SvgString = SvgString.replace(/width="[^"]+"/, `width="${ScaledWidth}"`);
        SvgString = SvgString.replace(/height="[^"]+"/, `height="${ScaledHeight}"`);
        
        return { SvgString, Width: ScaledWidth, Height: ScaledHeight };
    } catch (Error) {
        if (Attempt < 3) {
            await new Promise(Resolve => setTimeout(Resolve, Attempt * 200));
            return RenderLatexToSvg(Latex, FontSize, Attempt + 1);
        }
        throw Error;
    }
}

async function ConvertSvgToPng(SvgString, Width, Height, Attempt = 1) {
    try {
        const Density = 2;
        const RenderWidth = Width * Density;
        const RenderHeight = Height * Density;
        
        const PngBuffer = await sharp(Buffer.from(SvgString))
            .resize(RenderWidth, RenderHeight, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .png()
            .toBuffer();
        
        const ImageData = await sharp(PngBuffer)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        
        return {
            Buffer: ImageData.data,
            Width: ImageData.info.width,
            Height: ImageData.info.height,
            Density
        };
    } catch (Error) {
        if (Attempt < 3) {
            await new Promise(Resolve => setTimeout(Resolve, Attempt * 200));
            const LowerDensity = Math.max(1, Density - (Attempt - 1) * 0.5);
            return ConvertSvgToPng(SvgString, Width, Height, Attempt + 1);
        }
        throw Error;
    }
}

function SplitIntoTiles(Buffer, Width, Height) {
    const MaxTileSize = 1024;
    const Tiles = [];
    const TileWidths = [];
    const TileHeights = [];
    
    const NumTilesX = Math.ceil(Width / MaxTileSize);
    const NumTilesY = Math.ceil(Height / MaxTileSize);
    
    for (let TileY = 0; TileY < NumTilesY; TileY++) {
        const StartY = TileY * MaxTileSize;
        const TileHeight = Math.min(MaxTileSize, Height - StartY);
        
        if (TileY === 0) {
            for (let TileX = 0; TileX < NumTilesX; TileX++) {
                const StartX = TileX * MaxTileSize;
                const TileWidth = Math.min(MaxTileSize, Width - StartX);
                TileWidths.push(TileWidth);
            }
        }
        
        if (TileY < NumTilesY) {
            TileHeights.push(TileHeight);
        }
        
        for (let TileX = 0; TileX < NumTilesX; TileX++) {
            const StartX = TileX * MaxTileSize;
            const TileWidth = Math.min(MaxTileSize, Width - StartX);
            
            const TileBuffer = Buffer.slice(0);
            const NewBuffer = Buffer.alloc(TileWidth * TileHeight * 4);
            
            for (let Y = 0; Y < TileHeight; Y++) {
                const SrcY = StartY + Y;
                const SrcOffset = (SrcY * Width + StartX) * 4;
                const DstOffset = Y * TileWidth * 4;
                TileBuffer.copy(NewBuffer, DstOffset, SrcOffset, SrcOffset + TileWidth * 4);
            }
            
            Tiles.push(NewBuffer.toString('base64'));
        }
    }
    
    return { Tiles, TileWidths, TileHeights };
}

app.post('/render', async (req, res) => {
    try {
        const { latex, fontSize } = req.body;
        
        if (!latex || !fontSize) {
            return res.json({ success: false, error: 'Missing latex or fontSize' });
        }
        
        const { SvgString, Width, Height } = await RenderLatexToSvg(latex, fontSize);
        const { Buffer: PngBuffer, Width: FinalWidth, Height: FinalHeight, Density } = await ConvertSvgToPng(SvgString, Width, Height);
        
        const { Tiles, TileWidths, TileHeights } = SplitIntoTiles(PngBuffer, FinalWidth, FinalHeight);
        
        res.json({
            success: true,
            tiles: Tiles,
            width: FinalWidth,
            height: FinalHeight,
            tileWidths: TileWidths,
            tileHeights: TileHeights,
            bytesPerPixel: 4,
            channelOrder: 'RGBA',
            pixelDensity: Density
        });
    } catch (Error) {
        res.json({ success: false, error: Error.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: Date.now() });
});

app.listen(PORT, () => {
    console.log(`LaTeX render service running on port ${PORT}`);
});
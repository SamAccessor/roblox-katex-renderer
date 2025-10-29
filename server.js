const Express = require('express');
const Cors = require('cors');
const BodyParser = require('body-parser');
const Sharp = require('sharp');
const MathJax = require('mathjax');

const App = Express();
App.use(Cors());
App.use(BodyParser.json({ limit: '5mb' }));

let MathJaxInstance;
MathJax.init({
    loader: { load: ['input/tex', 'output/svg'] }
}).then((Instance) => {
    MathJaxInstance = Instance;
    console.log("MathJax Initialized Successfully.");
}).catch((Error) => console.error("MathJax Initialization Failed:", Error));

const MaxTileSize = 1024;
const RenderAttempts = 3;

const RenderLatex = async (Latex, FontSize) => {
    for (let Attempt = 1; Attempt <= RenderAttempts; Attempt++) {
        try {
            const SvgNode = await MathJaxInstance.tex2svgPromise(Latex, { display: true });
            let SvgString = MathJaxInstance.startup.adaptor.innerHTML(SvgNode);
            
            SvgString = SvgString.replace(/(<svg [^>]+>)/, `$1<style>*{fill:white;}</style>`);
            
            const PixelDensity = 2;
            const RenderDensity = (FontSize * PixelDensity);

            const { data: RawBuffer, info } = await Sharp(Buffer.from(SvgString), {
                density: RenderDensity,
                limitInputPixels: false
            })
            .trim()
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

            const { width: TotalWidth, height: TotalHeight, channels: BytesPerPixel } = info;
            const ChannelOrder = "RGBA";

            let TileWidths = [];
            for (let x = 0; x < TotalWidth; x += MaxTileSize) {
                TileWidths.push(Math.min(MaxTileSize, TotalWidth - x));
            }

            let TileHeights = [];
            for (let y = 0; y < TotalHeight; y += MaxTileSize) {
                TileHeights.push(Math.min(MaxTileSize, TotalHeight - y));
            }

            let TilesBase64 = [];
            for (let y = 0; y < TotalHeight; y += MaxTileSize) {
                for (let x = 0; x < TotalWidth; x += MaxTileSize) {
                    const TileWidth = Math.min(MaxTileSize, TotalWidth - x);
                    const TileHeight = Math.min(MaxTileSize, TotalHeight - y);

                    const TileBuffer = await Sharp(RawBuffer, {
                        raw: { width: TotalWidth, height: TotalHeight, channels: BytesPerPixel }
                    })
                    .extract({ left: x, top: y, width: TileWidth, height: TileHeight })
                    .png()
                    .toBuffer();
                    
                    TilesBase64.push(TileBuffer.toString('base64'));
                }
            }

            return {
                success: true,
                tiles: TilesBase64,
                width: TotalWidth,
                height: TotalHeight,
                tileWidths: TileWidths,
                tileHeights: TileHeights,
                bytesPerPixel: BytesPerPixel,
                channelOrder: ChannelOrder,
                pixelDensity: PixelDensity
            };

        } catch (Error) {
            console.error(`Render Attempt ${Attempt} Failed:`, Error.message);
            if (Attempt === RenderAttempts) {
                throw Error;
            }
        }
    }
};

App.post('/render', async (Request, Response) => {
    const { latex, fontSize } = Request.body;

    if (!latex || !fontSize || !MathJaxInstance) {
        return Response.status(400).json({ 
            success: false, 
            error: "Invalid request. 'latex', 'fontSize', and MathJax readiness are required." 
        });
    }

    try {
        const RenderData = await RenderLatex(latex, fontSize);
        Response.json(RenderData);
    } catch (Error) {
        Response.status(500).json({ 
            success: false, 
            error: `Failed to render after ${RenderAttempts} attempts: ${Error.message}` 
        });
    }
});

App.get('/', (Request, Response) => {
    Response.send('MathJax Render Service is Online. Use POST /render.');
});

const Port = process.env.PORT || 3000;
App.listen(Port, () => {
    console.log(`Server listening on port ${Port}`);
});
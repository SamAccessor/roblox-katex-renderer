const Express = require('express');
const Cors = require('cors');
const BodyParser = require('body-parser');
const MathJax = require('mathjax-full');
const Sharp = require('sharp');

const App = Express();
App.use(Cors());
App.use(BodyParser.json({ limit: '10mb' }));

const MaxTileSize = 1024;
const RenderAttempts = 3;
const BackoffDelay = 150;
const DefaultCacheCapacity = 500;

class LruCache {
    constructor(Capacity = DefaultCacheCapacity) {
        this.Capacity = Capacity;
        this.Cache = new Map();
    }

    Get(Key) {
        if (!this.Cache.has(Key)) {
            return null;
        }
        const Value = this.Cache.get(Key);
        this.Cache.delete(Key);
        this.Cache.set(Key, Value);
        return Value;
    }

    Set(Key, Value) {
        if (this.Cache.has(Key)) {
            this.Cache.delete(Key);
        } else if (this.Cache.size >= this.Capacity) {
            this.Cache.delete(this.Cache.keys().next().value);
        }
        this.Cache.set(Key, Value);
    }

    Stats() {
        return {
            size: this.Cache.size,
            capacity: this.Capacity
        };
    }
}

const RenderCache = new LruCache();
let MathJaxInstance;

MathJax.init({
    loader: { load: ['input/tex', 'output/svg'] },
    startup: {
        adaptor: 'lite'
    }
}).then((Instance) => {
    MathJaxInstance = Instance;
    console.log("MathJax Initialized Successfully.");
}).catch((Error) => console.error("MathJax Initialization Failed:", Error));

const GetRenderKey = (Latex, FontSize, PixelDensity) => {
    return `${Latex}|${FontSize}|${PixelDensity}`;
};

const RenderLatex = async (Latex, FontSize, PixelDensity) => {
    const SvgNode = await MathJaxInstance.tex2svgPromise(Latex, { display: true });
    let SvgString = MathJaxInstance.startup.adaptor.innerHTML(SvgNode);
    SvgString = SvgString.replace(/(<svg [^>]+>)/, `$1<style>*{fill:#FFFFFF;}</style>`);
    
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
            .png({ quality: 100 })
            .toBuffer();
            
            TilesBase64.push(TileBuffer.toString('base64'));
        }
    }

    return {
        tiles: TilesBase64,
        width: TotalWidth,
        height: TotalHeight,
        tileWidths: TileWidths,
        tileHeights: TileHeights,
        bytesPerPixel: BytesPerPixel,
        channelOrder: ChannelOrder,
        pixelDensity: PixelDensity
    };
};

const RenderWithRetries = async (Latex, FontSize, PixelDensity) => {
    let LastError;
    for (let Attempt = 1; Attempt <= RenderAttempts; Attempt++) {
        try {
            const Result = await RenderLatex(Latex, FontSize, PixelDensity);
            return Result;
        } catch (Error) {
            LastError = Error;
            console.warn(`Render Attempt ${Attempt} failed: ${Error.message}`);
            if (Attempt < RenderAttempts) {
                await new Promise(Resolve => setTimeout(Resolve, BackoffDelay * Attempt));
            }
        }
    }
    throw LastError;
};

const PrewarmCommon = async (Formulas) => {
    console.log(`Prewarming ${Formulas.length} formulas...`);
    for (const Formula of Formulas) {
        const { latex, fontSize, pixelDensity = 2 } = Formula;
        const Key = GetRenderKey(latex, fontSize, pixelDensity);
        if (RenderCache.Get(Key)) {
            continue;
        }
        try {
            const Result = await RenderWithRetries(latex, fontSize, pixelDensity);
            RenderCache.Set(Key, Result);
            console.log(`Prewarmed: ${latex.substring(0, 20)}...`);
        } catch (Error) {
            console.error(`Failed to prewarm: ${latex}: ${Error.message}`);
        }
    }
    console.log("Prewarming complete.");
};

App.post('/renderFast', (Request, Response) => {
    const { latex, fontSize = 64, pixelDensity = 2, requestId = null } = Request.body;
    const Key = GetRenderKey(latex, fontSize, pixelDensity);
    const CachedResult = RenderCache.Get(Key);

    if (CachedResult) {
        Response.json({ 
            hit: true, 
            result: { ...CachedResult, success: true, requestId }
        });
    } else {
        Response.json({ hit: false, requestId });
    }
});

App.post('/render', async (Request, Response) => {
    const { latex, fontSize = 64, pixelDensity = 2, requestId = null } = Request.body;
    
    if (!latex || !MathJaxInstance) {
        return Response.status(400).json({ 
            success: false, 
            requestId, 
            error: "Invalid request or MathJax not ready." 
        });
    }

    const Key = GetRenderKey(latex, fontSize, pixelDensity);
    const CachedResult = RenderCache.Get(Key);
    if (CachedResult) {
        return Response.json({ ...CachedResult, success: true, requestId });
    }

    try {
        const RenderResult = await RenderWithRetries(latex, fontSize, pixelDensity);
        RenderCache.Set(Key, RenderResult);
        Response.json({ ...RenderResult, success: true, requestId });
    } catch (Error) {
        Response.status(500).json({ 
            success: false, 
            requestId, 
            error: `Render failed after ${RenderAttempts} attempts: ${Error.message}` 
        });
    }
});

App.get('/health', (Request, Response) => {
    Response.status(200).json({ 
        status: "OK", 
        mathJaxReady: !!MathJaxInstance,
        cacheStats: RenderCache.Stats()
    });
});

const Port = process.env.PORT || 3000;
App.listen(Port, () => {
    console.log(`Server listening on port ${Port}`);
    PrewarmCommon([
        { latex: "E = mc^2", fontSize: 64, pixelDensity: 2 },
        { latex: "\\frac{a}{b}", fontSize: 64, pixelDensity: 2 }
    ]);
});
// Full URL Rewriting Proxy Server
// This rewrites ALL URLs to go through the proxy, avoiding CORS issues
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;
let puppeteer;
let chromium;

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

if (isProduction) {
    puppeteer = require('puppeteer-core');
    chromium = require('@sparticuz/chromium');
    console.log('🚀 Running in PRODUCTION mode');
} else {
    try {
        puppeteer = require('puppeteer');
        console.log('🔧 Running in DEVELOPMENT mode');
    } catch (e) {
        puppeteer = require('puppeteer-core');
        console.log('🔧 Running in DEVELOPMENT mode with puppeteer-core');
    }
}

app.use(cors());
app.use(express.static('public'));

let browser = null;

async function getBrowser() {
    if (!browser) {
        if (isProduction) {
            browser = await puppeteerExtra.launch({
                args: [
                    ...chromium.args,
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process'
                ],
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath(),
                headless: chromium.headless,
            });
        } else {
            const chromePaths = [
                '/usr/bin/google-chrome',
                '/usr/bin/chromium-browser',
                '/usr/bin/chromium',
                '/snap/bin/chromium',
                process.env.CHROME_PATH
            ].filter(Boolean);

            let executablePath;
            const fs = require('fs');
            for (const path of chromePaths) {
                if (fs.existsSync(path)) {
                    executablePath = path;
                    break;
                }
            }

            browser = await puppeteerExtra.launch({
                headless: 'new',
                executablePath: executablePath,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process'
                ]
            });
        }
    }
    return browser;
}

// Main proxy endpoint that rewrites ALL URLs
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    let cleanUrl;
    try {
        cleanUrl = new URL(targetUrl);
        cleanUrl.pathname = cleanUrl.pathname.replace(/\/\//g, '/');
        cleanUrl = cleanUrl.toString();
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    let page = null;

    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Minimal request interception - only block obvious ads
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const url = request.url();
            const blockedDomains = ['doubleclick.net', 'googleadservices.com'];
            
            if (blockedDomains.some(domain => url.includes(domain))) {
                request.abort();
            } else {
                request.continue();
            }
        });

        console.log(`🌐 Loading: ${cleanUrl}`);
        
        try {
            await page.goto(cleanUrl, { waitUntil: 'networkidle0', timeout: 45000 });
        } catch (e1) {
            try {
                await page.goto(cleanUrl, { waitUntil: 'networkidle2', timeout: 45000 });
            } catch (e2) {
                await page.goto(cleanUrl, { waitUntil: 'load', timeout: 30000 });
            }
        }

        await new Promise(resolve => setTimeout(resolve, 2000));

        const html = await page.content();
        
        // Get the proxy base URL
        const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;
        const targetOrigin = new URL(cleanUrl).origin;
        
        // Rewrite all URLs to go through the proxy
        let modifiedHtml = html;
        
        // Remove CSP
        modifiedHtml = modifiedHtml.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
        
        // Function to create proxy URL
        function makeProxyUrl(url) {
            try {
                const absolute = new URL(url, cleanUrl).href;
                return `${proxyBase}${encodeURIComponent(absolute)}`;
            } catch (e) {
                return url;
            }
        }
        
        // Rewrite script sources
        modifiedHtml = modifiedHtml.replace(/(<script[^>]+src=["'])([^"']+)(["'])/gi, (match, p1, p2, p3) => {
            if (p2.startsWith('data:') || p2.startsWith('blob:')) return match;
            return p1 + makeProxyUrl(p2) + p3;
        });
        
        // Rewrite link hrefs (CSS, etc)
        modifiedHtml = modifiedHtml.replace(/(<link[^>]+href=["'])([^"']+)(["'])/gi, (match, p1, p2, p3) => {
            if (p2.startsWith('data:') || p2.startsWith('blob:') || p2.startsWith('#')) return match;
            return p1 + makeProxyUrl(p2) + p3;
        });
        
        // Rewrite image sources
        modifiedHtml = modifiedHtml.replace(/(<img[^>]+src=["'])([^"']+)(["'])/gi, (match, p1, p2, p3) => {
            if (p2.startsWith('data:') || p2.startsWith('blob:')) return match;
            return p1 + makeProxyUrl(p2) + p3;
        });
        
        // Add base tag
        if (!modifiedHtml.includes('<base')) {
            modifiedHtml = modifiedHtml.replace(/<head>/i, `<head><base href="${cleanUrl}">`);
        }
        
        // Inject comprehensive proxy script
        const injectionScript = `
        <script>
        (function() {
            console.log('🔧 Full proxy mode active');
            const proxyBase = '${proxyBase}';
            const targetOrigin = '${targetOrigin}';
            const currentProxiedUrl = '${cleanUrl}';
            
            function makeProxyUrl(url) {
                if (!url || url.startsWith('data:') || url.startsWith('blob:') || url === '#') return url;
                try {
                    const absolute = new URL(url, currentProxiedUrl).href;
                    return proxyBase + encodeURIComponent(absolute);
                } catch (e) {
                    return url;
                }
            }
            
            // Override fetch
            const originalFetch = window.fetch;
            window.fetch = function(url, options = {}) {
                const proxiedUrl = makeProxyUrl(url);
                console.log('🌐 Fetch:', url, '→', proxiedUrl);
                return originalFetch(proxiedUrl, options);
            };
            
            // Override XMLHttpRequest
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, ...args) {
                const proxiedUrl = makeProxyUrl(url);
                console.log('🌐 XHR:', url, '→', proxiedUrl);
                return originalOpen.call(this, method, proxiedUrl, ...args);
            };
            
            // Intercept link clicks
            document.addEventListener('click', function(e) {
                let el = e.target;
                while (el && el.tagName !== 'A') el = el.parentElement;
                if (el && el.tagName === 'A' && el.href) {
                    if (!el.href.startsWith('javascript:') && !el.href.startsWith('#')) {
                        e.preventDefault();
                        const newUrl = new URL(el.href).searchParams.get('url') || el.href;
                        window.location.href = proxyBase + encodeURIComponent(newUrl);
                    }
                }
            }, true);
            
            console.log('✅ Full proxy injection complete');
        })();
        </script>
        `;
        
        modifiedHtml = modifiedHtml.replace('</head>', injectionScript + '</head>');
        
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Proxied-URL', cleanUrl);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(modifiedHtml);
        
        console.log(`✅ Successfully proxied: ${cleanUrl}`);

    } catch (error) {
        console.error('❌ Proxy error:', error);
        
        let errorMessage = error.message;
        let statusCode = 500;
        
        if (error.name === 'TimeoutError') {
            errorMessage = 'Page load timeout.';
            statusCode = 504;
        }
        
        res.status(statusCode).json({ 
            error: 'Failed to fetch URL', 
            message: errorMessage,
            url: targetUrl
        });
    } finally {
        if (page) {
            await page.close();
        }
    }
});

// Proxy for individual resources (scripts, CSS, images, etc)
app.get('/resource', async (req, res) => {
    const url = req.query.url;
    
    if (!url) {
        return res.status(400).send('URL required');
    }

    try {
        const fetch = require('node-fetch');
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const contentType = response.headers.get('content-type');
        const buffer = await response.buffer();
        
        res.setHeader('Content-Type', contentType || 'application/octet-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(buffer);
    } catch (error) {
        res.status(500).send('Failed to fetch resource');
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Full rewriting proxy server running',
        browser: browser ? 'connected' : 'not initialized'
    });
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

process.on('SIGINT', async () => {
    if (browser) await browser.close();
    process.exit();
});

process.on('SIGTERM', async () => {
    if (browser) await browser.close();
    process.exit();
});

app.listen(PORT, () => {
    console.log(`✅ Full rewriting proxy server running on port ${PORT}`);
});

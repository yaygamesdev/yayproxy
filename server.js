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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.set('trust proxy', 1);

let browser = null;
let browserInitializing = false;
let browserQueue = [];

async function getBrowser() {
    // If browser is already initializing, wait for it
    if (browserInitializing) {
        console.log('⏳ Waiting for browser to initialize...');
        await new Promise(resolve => {
            const checkInterval = setInterval(() => {
                if (!browserInitializing && browser) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);
        });
        return browser;
    }

    // If browser exists and is connected, return it
    if (browser && browser.isConnected()) {
        return browser;
    }

    // Initialize browser
    browserInitializing = true;
    console.log('🚀 Initializing browser...');

    try {
        if (isProduction) {
            // Set executable permissions
            await chromium.executablePath().then(path => {
                const { execSync } = require('child_process');
                try {
                    execSync(`chmod +x ${path}`);
                } catch (e) {
                    console.log('Could not chmod executable');
                }
            });

            browser = await puppeteerExtra.launch({
                args: [
                    ...chromium.args,
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--single-process',
                    '--no-zygote'
                ],
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath(),
                headless: chromium.headless,
                ignoreHTTPSErrors: true
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
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--single-process',
                    '--no-zygote'
                ]
            });
        }

        console.log('✅ Browser initialized successfully');
        browserInitializing = false;
        return browser;
    } catch (error) {
        console.error('❌ Failed to initialize browser:', error);
        browserInitializing = false;
        browser = null;
        throw error;
    }
}

app.get('/proxy', async (req, res) => {
    await handleProxyRequest(req, res);
});

app.post('/proxy', async (req, res) => {
    await handleProxyRequest(req, res);
});

async function handleProxyRequest(req, res) {
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

    const urlPath = cleanUrl.split('?')[0];
    const hasFileExtension = /\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico|json|xml|webp|mp4|webm)$/i.test(urlPath);
    
    const isKnownResourcePath = 
        urlPath.endsWith('/js') || 
        urlPath.includes('/gtag/js') ||
        urlPath.includes('.js?') ||
        urlPath.includes('.css?') ||
        urlPath.includes('/api/') ||
        urlPath.includes('/_next/') ||
        cleanUrl.includes('googletagmanager.com') ||
        cleanUrl.includes('google-analytics.com') ||
        cleanUrl.includes('doubleclick.net');
    
    const isResource = hasFileExtension || isKnownResourcePath;
    
    const hasNoExtension = !urlPath.split('/').pop().includes('.');
    const mightBeAPI = hasNoExtension && (
        urlPath.includes('/api/') || 
        urlPath.includes('/graphql') || 
        urlPath.includes('/_next/data/') ||
        cleanUrl.includes('cloudmoonapp.com/api')
    );

    if (isResource || mightBeAPI) {
        try {
            console.log(`📦 Fetching ${mightBeAPI ? 'API' : 'resource'}: ${cleanUrl}`);
            const fetch = require('node-fetch');
            
            const fetchOptions = {
                method: req.method,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': new URL(cleanUrl).origin,
                    'Accept': mightBeAPI ? 'application/json, text/plain, */*' : '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br'
                },
                timeout: 10000
            };
            
            if (req.method === 'POST' && req.body) {
                fetchOptions.body = JSON.stringify(req.body);
                fetchOptions.headers['Content-Type'] = 'application/json';
            }
            
            const response = await fetch(cleanUrl, fetchOptions);

            if (!response.ok) {
                console.error(`❌ Resource fetch failed: ${response.status} ${response.statusText}`);
                const ext = urlPath.split('.').pop().toLowerCase();
                if (ext === 'js') {
                    res.setHeader('Content-Type', 'application/javascript');
                    res.send('// Resource failed to load');
                } else if (ext === 'css') {
                    res.setHeader('Content-Type', 'text/css');
                    res.send('/* Resource failed to load */');
                } else {
                    res.status(response.status).send(`Resource unavailable: ${response.statusText}`);
                }
                return;
            }

            const contentType = response.headers.get('content-type');
            const buffer = await response.buffer();
            
            if (contentType && contentType.includes('text/html')) {
                if (cleanUrl.includes('gtag/js') || cleanUrl.includes('.js')) {
                    console.log('⚠️ Received HTML for JS resource, returning empty JS');
                    res.setHeader('Content-Type', 'application/javascript');
                    res.send('// Resource returned HTML instead of JS');
                    return;
                } else if (cleanUrl.includes('.css')) {
                    console.log('⚠️ Received HTML for CSS resource, returning empty CSS');
                    res.setHeader('Content-Type', 'text/css');
                    res.send('/* Resource returned HTML instead of CSS */');
                    return;
                }
            }
            
            if (contentType && (contentType.includes('image/gif') || contentType.includes('image/')) && 
                (cleanUrl.includes('doubleclick') || cleanUrl.includes('google-analytics') || cleanUrl.includes('googleadservices'))) {
                console.log('🚫 Blocking tracking image:', cleanUrl);
                res.status(204).send();
                return;
            }
            
            res.setHeader('Content-Type', contentType || 'application/octet-stream');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.send(buffer);
            
            console.log(`✅ ${mightBeAPI ? 'API' : 'Resource'} served: ${cleanUrl}`);
            return;
        } catch (error) {
            console.error(`❌ Failed to fetch ${mightBeAPI ? 'API' : 'resource'}: ${cleanUrl}`, error.message);
            
            const ext = urlPath.split('.').pop().toLowerCase();
            if (ext === 'js') {
                res.setHeader('Content-Type', 'application/javascript');
                res.send('// Resource failed to load: ' + error.message);
            } else if (ext === 'css') {
                res.setHeader('Content-Type', 'text/css');
                res.send('/* Resource failed to load: ' + error.message + ' */');
            } else if (mightBeAPI) {
                res.setHeader('Content-Type', 'application/json');
                res.status(500).json({ error: 'API request failed', message: error.message });
            } else {
                res.status(500).send('Failed to fetch resource');
            }
            return;
        }
    }

    let page = null;

    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

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

        console.log(`🌐 Loading HTML page: ${cleanUrl}`);
        
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
        
        const protocol = (req.headers['x-forwarded-proto'] === 'https' || req.get('host').includes('onrender.com')) ? 'https' : req.protocol;
        const proxyBase = `${protocol}://${req.get('host')}/proxy?url=`;
        const targetOrigin = new URL(cleanUrl).origin;
        
        console.log(`Using proxy base: ${proxyBase}`);
        
        let modifiedHtml = html;
        
        modifiedHtml = modifiedHtml.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
        
        function makeProxyUrl(url) {
            try {
                const absolute = new URL(url, cleanUrl).href;
                return `${proxyBase}${encodeURIComponent(absolute)}`;
            } catch (e) {
                return url;
            }
        }
        
        modifiedHtml = modifiedHtml.replace(/(<script[^>]+src=["'])([^"']+)(["'])/gi, (match, p1, p2, p3) => {
            if (p2.startsWith('data:') || p2.startsWith('blob:')) return match;
            const newUrl = makeProxyUrl(p2);
            console.log(`  Rewriting script: ${p2} → ${newUrl}`);
            return p1 + newUrl + p3;
        });
        
        modifiedHtml = modifiedHtml.replace(/(<link[^>]+href=["'])([^"']+)(["'])/gi, (match, p1, p2, p3) => {
            if (p2.startsWith('data:') || p2.startsWith('blob:') || p2.startsWith('#')) return match;
            const newUrl = makeProxyUrl(p2);
            console.log(`  Rewriting link: ${p2} → ${newUrl}`);
            return p1 + newUrl + p3;
        });
        
        modifiedHtml = modifiedHtml.replace(/(<img[^>]+src=["'])([^"']+)(["'])/gi, (match, p1, p2, p3) => {
            if (p2.startsWith('data:') || p2.startsWith('blob:')) return match;
            return p1 + makeProxyUrl(p2) + p3;
        });
        
        if (!modifiedHtml.includes('<base')) {
            modifiedHtml = modifiedHtml.replace(/<head>/i, `<head><base href="${cleanUrl}">`);
        }
        
        const injectionScript = `
        <script>
        (function() {
            console.log('🔧 Full proxy mode active v2.2');
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
            
            const originalFetch = window.fetch;
            window.fetch = function(url, options = {}) {
                const proxiedUrl = makeProxyUrl(url);
                console.log('🌐 Fetch:', url, '→', proxiedUrl);
                return originalFetch(proxiedUrl, options);
            };
            
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, ...args) {
                const proxiedUrl = makeProxyUrl(url);
                console.log('🌐 XHR:', url, '→', proxiedUrl);
                return originalOpen.call(this, method, proxiedUrl, ...args);
            };
            
            document.addEventListener('click', function(e) {
                let el = e.target;
                while (el && el.tagName !== 'A') el = el.parentElement;
                if (el && el.tagName === 'A' && el.href) {
                    if (!el.href.startsWith('javascript:') && !el.href.startsWith('#')) {
                        e.preventDefault();
                        console.log('🔗 Link clicked:', el.href);
                        if (el.href.includes('/proxy?url=')) {
                            window.location.href = el.href;
                        } else {
                            window.location.href = proxyBase + encodeURIComponent(el.href);
                        }
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
        
        console.log(`✅ Successfully proxied HTML: ${cleanUrl}`);

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
}

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

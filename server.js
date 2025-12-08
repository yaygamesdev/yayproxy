// Puppeteer-based Proxy Server for JavaScript-heavy sites
// Install: npm install express cors node-fetch puppeteer-core @sparticuz/chromium puppeteer-extra puppeteer-extra-plugin-stealth

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Determine environment and load appropriate Puppeteer with stealth
const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;
let puppeteer;
let chromium;

// Use puppeteer-extra with stealth plugin
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

if (isProduction) {
    puppeteer = require('puppeteer-core');
    chromium = require('@sparticuz/chromium');
    console.log('🚀 Running in PRODUCTION mode with @sparticuz/chromium + STEALTH');
} else {
    try {
        puppeteer = require('puppeteer');
        console.log('🔧 Running in DEVELOPMENT mode with puppeteer + STEALTH');
    } catch (e) {
        puppeteer = require('puppeteer-core');
        console.log('🔧 Running in DEVELOPMENT mode with puppeteer-core + STEALTH');
    }
}

// Enable CORS
app.use(cors());
app.use(express.static('public'));

// Browser instance (reuse for performance)
let browser = null;

async function getBrowser() {
    if (!browser) {
        const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;
        
        if (isProduction) {
            console.log('🚀 Launching stealth browser in production mode...');
            try {
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
                console.log('✅ Production stealth browser launched successfully');
            } catch (error) {
                console.error('❌ Failed to launch production browser:', error.message);
                throw error;
            }
        } else {
            console.log('🔧 Launching stealth browser in development mode...');
            
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
                    console.log(`Found Chrome at: ${path}`);
                    break;
                }
            }

            if (!executablePath) {
                console.log('No system Chrome found, using bundled Chromium');
            }

            try {
                browser = await puppeteerExtra.launch({
                    headless: 'new',
                    executablePath: executablePath,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu',
                        '--disable-web-security',
                        '--disable-features=IsolateOrigins,site-per-process'
                    ]
                });
                console.log('✅ Development stealth browser launched successfully');
            } catch (error) {
                console.error('❌ Failed to launch browser:', error.message);
                throw error;
            }
        }
    }
    return browser;
}

// Proxy endpoint with full rendering
app.get('/proxy', async (req, res) => {
    const url = req.query.url;
    const mode = req.query.mode || 'html';
    
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Validate and clean URL
    let cleanUrl;
    try {
        cleanUrl = new URL(url);
        cleanUrl.pathname = cleanUrl.pathname.replace(/\/\//g, '/');
        cleanUrl = cleanUrl.toString();
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    let page = null;

    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        // Set larger viewport for better rendering
        await page.setViewport({ width: 1920, height: 1080 });

        // Set realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Set extra headers to appear more like a real browser
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        });

        // Intelligent request interception - only block truly unnecessary resources
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const url = request.url();
            const resourceType = request.resourceType();
            
            // Only block specific known ad/tracking domains, allow everything else
            const blockedDomains = [
                'doubleclick.net',
                'googleadservices.com',
                'googlesyndication.com',
                'google-analytics.com',
                'googletagmanager.com',
                'facebook.com/tr',
                'analytics.twitter.com'
            ];
            
            if (blockedDomains.some(domain => url.includes(domain))) {
                request.abort();
            } else {
                request.continue();
            }
        });

        // Navigate with multiple fallback strategies
        console.log(`🌐 Loading: ${cleanUrl}`);
        
        try {
            // First attempt: networkidle0 (most complete)
            await page.goto(cleanUrl, { 
                waitUntil: 'networkidle0',
                timeout: 45000
            });
            console.log('✅ Loaded with networkidle0');
        } catch (e1) {
            console.log('⚠️ networkidle0 failed, trying networkidle2...');
            try {
                await page.goto(cleanUrl, { 
                    waitUntil: 'networkidle2',
                    timeout: 45000
                });
                console.log('✅ Loaded with networkidle2');
            } catch (e2) {
                console.log('⚠️ networkidle2 failed, trying load...');
                try {
                    await page.goto(cleanUrl, { 
                        waitUntil: 'load',
                        timeout: 30000
                    });
                    console.log('✅ Loaded with load event');
                } catch (e3) {
                    console.log('⚠️ load failed, trying domcontentloaded...');
                    await page.goto(cleanUrl, { 
                        waitUntil: 'domcontentloaded',
                        timeout: 20000
                    });
                    console.log('✅ Loaded with domcontentloaded');
                }
            }
        }

        // Wait for dynamic content - longer wait for complex sites
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Try to wait for common content indicators
        try {
            await page.waitForSelector('body', { timeout: 5000 });
        } catch (e) {
            console.log('Body element check skipped');
        }

        // Execute JavaScript to ensure everything is loaded
        await page.evaluate(() => {
            // Trigger any lazy-loaded content
            window.scrollTo(0, document.body.scrollHeight / 2);
            window.scrollTo(0, 0);
        });

        // Additional wait after scrolling
        await new Promise(resolve => setTimeout(resolve, 2000));

        if (mode === 'screenshot') {
            const screenshot = await page.screenshot({ 
                fullPage: true,
                type: 'png'
            });
            res.setHeader('Content-Type', 'image/png');
            res.send(screenshot);
        } else if (mode === 'pdf') {
            const pdf = await page.pdf({ 
                format: 'A4',
                printBackground: true
            });
            res.setHeader('Content-Type', 'application/pdf');
            res.send(pdf);
        } else {
            // Get the fully rendered HTML
            const html = await page.content();
            
            // Enhanced HTML modification
            let modifiedHtml = html;
            
            // Add base tag if not present
            if (!modifiedHtml.includes('<base')) {
                const baseTag = `<base href="${cleanUrl}">`;
                modifiedHtml = modifiedHtml.replace(/<head>/i, `<head>${baseTag}`);
            }
            
            // Inject script to fix relative URLs and prevent navigation
            const injectionScript = `
            <script>
            (function() {
                // Fix any remaining relative URLs
                const baseUrl = '${cleanUrl}';
                const base = new URL(baseUrl);
                
                // Function to make URLs absolute
                function makeAbsolute(url) {
                    if (!url || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#')) {
                        return url;
                    }
                    try {
                        return new URL(url, baseUrl).href;
                    } catch (e) {
                        return url;
                    }
                }
                
                // Wait for DOM to be ready
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', fixUrls);
                } else {
                    fixUrls();
                }
                
                function fixUrls() {
                    // Fix images
                    document.querySelectorAll('img[src]').forEach(img => {
                        img.src = makeAbsolute(img.src);
                    });
                    
                    // Fix links
                    document.querySelectorAll('link[href]').forEach(link => {
                        link.href = makeAbsolute(link.href);
                    });
                    
                    // Fix scripts
                    document.querySelectorAll('script[src]').forEach(script => {
                        const oldSrc = script.src;
                        const newSrc = makeAbsolute(oldSrc);
                        if (oldSrc !== newSrc) {
                            script.src = newSrc;
                        }
                    });
                }
                
                console.log('🔧 Proxy URL fixer loaded');
            })();
            </script>
            `;
            
            modifiedHtml = modifiedHtml.replace('</head>', injectionScript + '</head>');
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('X-Proxied-URL', cleanUrl);
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.send(modifiedHtml);
            
            console.log(`✅ Successfully proxied: ${cleanUrl}`);
        }

    } catch (error) {
        console.error('❌ Proxy error:', error);
        
        let errorMessage = error.message;
        let statusCode = 500;
        
        if (error.name === 'TimeoutError') {
            errorMessage = 'Page load timeout. The website took too long to load or may be blocking automated access.';
            statusCode = 504;
        } else if (error.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
            errorMessage = 'Website not found. Check if the URL is correct.';
            statusCode = 404;
        } else if (error.message.includes('net::ERR_CONNECTION_REFUSED')) {
            errorMessage = 'Connection refused. The website may be down or blocking access.';
            statusCode = 503;
        }
        
        res.status(statusCode).json({ 
            error: 'Failed to fetch URL', 
            message: errorMessage,
            url: url,
            details: error.message
        });
    } finally {
        if (page) {
            await page.close();
        }
    }
});

// Simple proxy endpoint (fallback without Puppeteer)
app.get('/proxy-simple', async (req, res) => {
    const url = req.query.url;
    
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    try {
        const fetch = require('node-fetch');
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const content = await response.text();
        res.setHeader('Content-Type', response.headers.get('content-type') || 'text/html');
        res.send(content);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Puppeteer proxy server is running',
        puppeteer: browser ? 'connected' : 'not initialized',
        environment: isProduction ? 'production' : 'development'
    });
});

// Root
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Cleanup on exit
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down...');
    if (browser) {
        await browser.close();
    }
    process.exit();
});

process.on('SIGTERM', async () => {
    console.log('🛑 Shutting down...');
    if (browser) {
        await browser.close();
    }
    process.exit();
});

app.listen(PORT, () => {
    console.log(`✅ Puppeteer proxy server running on http://localhost:${PORT}`);
    console.log(`Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`Proxy endpoint: http://localhost:${PORT}/proxy?url=YOUR_URL`);
    console.log(`Screenshot mode: http://localhost:${PORT}/proxy?url=YOUR_URL&mode=screenshot`);
    console.log(`PDF mode: http://localhost:${PORT}/proxy?url=YOUR_URL&mode=pdf`);
});

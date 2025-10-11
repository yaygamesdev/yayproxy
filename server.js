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
            // Production: use @sparticuz/chromium
            console.log('🚀 Launching browser in production mode...');
            try {
                browser = await puppeteer.launch({
                    args: chromium.args,
                    defaultViewport: chromium.defaultViewport,
                    executablePath: await chromium.executablePath(),
                    headless: chromium.headless,
                });
                console.log('✅ Production browser launched successfully');
            } catch (error) {
                console.error('❌ Failed to launch production browser:', error.message);
                throw error;
            }
        } else {
            // Local development
            console.log('🔧 Launching browser in development mode...');
            
            // Try to find system Chrome
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
                browser = await puppeteer.launch({
                    headless: 'new',
                    executablePath: executablePath,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu'
                    ]
                });
                console.log('✅ Development browser launched successfully');
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
    const mode = req.query.mode || 'html'; // html, screenshot, pdf
    
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Validate and clean URL
    let cleanUrl;
    try {
        cleanUrl = new URL(url);
        // Fix double slashes in path (except after protocol)
        cleanUrl.pathname = cleanUrl.pathname.replace(/\/\//g, '/');
        cleanUrl = cleanUrl.toString();
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    let page = null;

    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        // Set viewport
        await page.setViewport({ width: 1920, height: 1080 });

        // Set user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Block ads and tracking (optional, speeds things up)
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const url = request.url();
            const resourceType = request.resourceType();
            
            // Block ads and analytics
            if (url.includes('doubleclick.net') || 
                url.includes('googleadservices.com') ||
                url.includes('google-analytics.com') ||
                url.includes('facebook.com/tr') ||
                resourceType === 'font') {
                request.abort();
            } else {
                request.continue();
            }
        });

        // Navigate to URL with increased timeout and fallback strategies
        try {
            await page.goto(cleanUrl, { 
                waitUntil: 'networkidle2',
                timeout: 60000  // Increased to 60 seconds
            });
        } catch (timeoutError) {
            // If networkidle2 times out, try with less strict condition
            console.log('First navigation attempt timed out, trying with domcontentloaded...');
            await page.goto(cleanUrl, { 
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
        }

        // Wait a bit for dynamic content
        await new Promise(resolve => setTimeout(resolve, 2000));

        if (mode === 'screenshot') {
            // Return screenshot
            const screenshot = await page.screenshot({ 
                fullPage: true,
                type: 'png'
            });
            res.setHeader('Content-Type', 'image/png');
            res.send(screenshot);
        } else if (mode === 'pdf') {
            // Return PDF
            const pdf = await page.pdf({ 
                format: 'A4',
                printBackground: true
            });
            res.setHeader('Content-Type', 'application/pdf');
            res.send(pdf);
        } else {
            // Return rendered HTML
            const html = await page.content();
            
            // Inject base tag
            let modifiedHtml = html;
            if (!modifiedHtml.includes('<base')) {
                modifiedHtml = modifiedHtml.replace(
                    /<head>/i, 
                    `<head><base href="${url}">`
                );
            }
            
            res.setHeader('Content-Type', 'text/html');
            res.setHeader('X-Proxied-URL', url);
            res.send(modifiedHtml);
        }

    } catch (error) {
        console.error('Proxy error:', error);
        
        let errorMessage = error.message;
        let statusCode = 500;
        
        if (error.name === 'TimeoutError') {
            errorMessage = 'Page load timeout. The website took too long to load.';
            statusCode = 504;
        } else if (error.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
            errorMessage = 'Website not found. Check if the URL is correct.';
            statusCode = 404;
        }
        
        res.status(statusCode).json({ 
            error: 'Failed to fetch URL', 
            message: errorMessage,
            url: url
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
        puppeteer: browser ? 'connected' : 'not initialized'
    });
});

// Root
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Cleanup on exit
process.on('SIGINT', async () => {
    if (browser) {
        await browser.close();
    }
    process.exit();
});

app.listen(PORT, () => {
    console.log(`Puppeteer proxy server running on http://localhost:${PORT}`);
    console.log(`Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`Proxy endpoint: http://localhost:${PORT}/proxy?url=YOUR_URL`);
    console.log(`Screenshot mode: http://localhost:${PORT}/proxy?url=YOUR_URL&mode=screenshot`);
    console.log(`PDF mode: http://localhost:${PORT}/proxy?url=YOUR_URL&mode=pdf`);
});

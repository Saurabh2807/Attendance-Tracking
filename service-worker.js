const CACHE_NAME = 'attendease-cache-v2';
const ASSETS = [
    './',
    './index.html',
    './script.js',
    './styles.css',
    './config.js',
    './favicon.ico',
    './icons/icon-72.png',
    './icons/icon-96.png',
    './icons/icon-128.png',
    './icons/icon-144.png',
    './icons/icon-152.png',
    './icons/icon-192.png',
    './icons/icon-384.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap'
];

// Install Event - Pre-cache static assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing Service Worker and caching static shell...');
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
});

// Activate Event - Clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating Service Worker and cleaning old caches...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) {
                        console.log('[SW] Deleting old cache:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch Event - Serve from Cache (Cache-First) for local assets only
self.addEventListener('fetch', (event) => {
    // Only intercept GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    const url = new URL(event.request.url);

    // Only cache requests matching our own origin (static local assets) or our trusted CDNs
    // Do NOT cache database calls (Supabase), sync service requests (Railway), or auth requests
    const isTrustedCDN = url.origin === 'https://cdn.jsdelivr.net' || 
                         url.origin === 'https://fonts.googleapis.com' || 
                         url.origin === 'https://fonts.gstatic.com';

    if (url.origin !== self.location.origin && !isTrustedCDN) {
        return;
    }

    // Exclude any dynamic API or REST calls
    if (url.pathname.includes('/api/') || url.pathname.includes('/rest/v1/') || url.pathname.includes('/auth/v1/')) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                // Serve from cache
                return cachedResponse;
            }
            // Fallback to network
            return fetch(event.request);
        })
    );
});

// Skip Waiting listener to support automatic reload when a new worker takes over
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});

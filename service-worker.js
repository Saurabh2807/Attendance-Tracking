const CACHE_NAME = 'attendease-cache-v3';
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

// Fetch Event - Dynamic Cache Strategies for static assets and CDNs
self.addEventListener('fetch', (event) => {
    // Only intercept GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    const url = new URL(event.request.url);

    // Only cache requests matching our own origin (static local assets) or our trusted CDNs
    // Do NOT cache database calls (Supabase), sync service requests, or auth requests
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

    // Strategy 1: Network-First for config.js
    // Ensures any changes to window.SYNC_SERVICE_URL are picked up instantly when online,
    // while still falling back to cache if offline.
    if (url.pathname.endsWith('/config.js') || url.pathname.includes('config.js')) {
        event.respondWith(
            fetch(event.request)
                .then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        const responseToCache = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseToCache);
                        });
                    }
                    return networkResponse;
                })
                .catch(() => {
                    return caches.match(event.request);
                })
        );
        return;
    }

    // Strategy 2: Stale-While-Revalidate for other static local assets and CDNs
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            const fetchPromise = fetch(event.request).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200) {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return networkResponse;
            }).catch(() => {
                // Ignore network update errors (e.g. when offline)
            });

            return cachedResponse || fetchPromise;
        })
    );
});

// Skip Waiting listener to support automatic reload when a new worker takes over
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});

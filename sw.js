const CACHE = 'aura-v1';
const ASSETS = ['/', '/index.html', '/manifest.json', '/style.css', '/app.js'];

const ALLOWED_HOSTS = [
    'www.gstatic.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'firestore.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com'
];

const PRIVATE_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc00:|fe80:)/;

function isAllowed(url) {
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (PRIVATE_IP.test(url.hostname)) return false;
    if (url.origin === self.location.origin) return true;
    return ALLOWED_HOSTS.includes(url.hostname);
}

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    let url;
    try { url = new URL(e.request.url); } catch { return; }
    // Let Firebase messaging SW handle its own scope
    if (e.request.url.includes('firebase-messaging-sw')) return;
    if (!isAllowed(url)) return;

    e.respondWith(
        caches.match(e.request).then(cached => {
            if (cached) return cached;
            return fetch(e.request.url, {
                method: e.request.method,
                headers: e.request.headers,
                credentials: e.request.credentials,
                redirect: 'follow'
            }).then(res => {
                if (res && res.status === 200 && e.request.method === 'GET') {
                    caches.open(CACHE).then(c => c.put(e.request, res.clone()));
                }
                return res;
            }).catch(() => caches.match('/index.html'));
        })
    );
});

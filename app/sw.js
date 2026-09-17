const CACHE = 'aura-v1';
const ASSETS = ['/', '/index.html', '/manifest.json'];

const ALLOWED_HOSTS = [
  'www.gstatic.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com'
];

const PRIVATE_IP_RANGES = [
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^169\.254\./,
    /^::1$/,
    /^fc00:/,
    /^fe80:/,
    /^100\.6[4-9]\./,
    /^100\.[7-9][0-9]\./,
    /^100\.1[0-1][0-9]\./,
    /^100\.12[0-7]\./
];

function isPrivateIP(hostname) {
    return PRIVATE_IP_RANGES.some(regex => regex.test(hostname));
}

function isAllowed(url) {
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (isPrivateIP(url.hostname)) return false;
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

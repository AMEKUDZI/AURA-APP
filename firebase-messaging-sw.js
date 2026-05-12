// firebase-messaging-sw.js
// This file MUST be at the root of your site (same level as index.html)
importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js");

firebase.initializeApp({
   apiKey: "AIzaSyAV2BdLdWnZ3g-LVmuZiReesXke4U4tCuM",
  authDomain: "aura-app-1646a.firebaseapp.com",
  projectId: "aura-app-1646a",
  storageBucket: "aura-app-1646a.firebasestorage.app",
  messagingSenderId: "921414427500",
  appId: "1:921414427500:web:957668da87de96ca754949",
  measurementId: "G-XFVH6F9GZB"
});

const messaging = firebase.messaging();

// Handle background messages (app is closed or in background)
messaging.onBackgroundMessage(payload => {
    const { title, body, icon } = payload.notification || {};
    self.registration.showNotification(title || "Aura", {
        body: body || "New message",
        icon: icon || "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: payload.data
    });
});

// Clicking notification opens the app
self.addEventListener("notificationclick", e => {
    e.notification.close();
    e.waitUntil(clients.openWindow("/"));
});

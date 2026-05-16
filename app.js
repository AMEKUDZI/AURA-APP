import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getFirestore, collection, addDoc, query, orderBy, onSnapshot,
    serverTimestamp, setDoc, doc, updateDoc, getDocs, getDoc, where,
    writeBatch, deleteDoc, increment, limit, startAfter
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";

// ── CONFIG ── Replace with your Firebase project credentials
const firebaseConfig = {
    apiKey: "AIzaSyAV2BdLdWnZ3g-LVmuZiReesXke4U4tCuM",
    authDomain: "aura-app-1646a.firebaseapp.com",
    projectId: "aura-app-1646a",
    storageBucket: "aura-app-1646a.firebasestorage.app",
    messagingSenderId: "921414427500",
    appId: "1:921414427500:web:957668da87de96ca754949"
};

const ADMIN_NUMBER = "+233543643780";
// Get this from Firebase Console → Project Settings → Cloud Messaging → VAPID key
const VAPID_KEY = "BOW-RZphXDwKS0Od9vCSHE_esyOQG-8hvNz65FhhJ2dLgpXd2uLJkZuN7VMTCHnqFmahwHRz0q7ekk5GqPgdfls";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const messaging = getMessaging(app);

// ── STATE ──
let currentChatId = null;
let currentPeer = null;       // { uid, name, avatar, phone }
let unsubMessages = null;     // unsubscribe fn for active chat listener
let unsubInbox = null;        // unsubscribe fn for inbox listener
let replyTo = null;
let oldestMsgSnap = null;
const PAGE_SIZE = 30;

// ── ENCRYPTION (AES-GCM, shared symmetric key) ──
// NOTE: Not true E2EE — upgrade to ECDH per-user keypair for production.
const SECRET = "Aura-Cipher-Key-777";
let _cipherKey = null;

async function getCipherKey() {
    if (_cipherKey) return _cipherKey;
    const enc = new TextEncoder();
    const material = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "PBKDF2" }, false, ["deriveKey"]);
    _cipherKey = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: enc.encode("aura-salt"), iterations: 100000, hash: "SHA-256" },
        material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
    return _cipherKey;
}

async function encrypt(text) {
    const key = await getCipherKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
    return {
        c: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
        i: btoa(String.fromCharCode(...iv))
    };
}

async function decrypt(c, i) {
    try {
        const key = await getCipherKey();
        const dec = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: Uint8Array.from(atob(i), ch => ch.charCodeAt(0)) },
            key, Uint8Array.from(atob(c), ch => ch.charCodeAt(0))
        );
        return new TextDecoder().decode(dec);
    } catch {
        return "🔒 Encrypted Message";
    }
}

// ── HELPERS ──
function chatId(uid1, uid2) {
    return [uid1, uid2].sort().join("_");
}

function formatTime(ts) {
    if (!ts) return "";
    const d = ts.toDate();
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    return isToday
        ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function escapeHtml(str) {
    return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── SCREEN NAVIGATION ──
window.showScreen = (id) => {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById(id).classList.add("active");
    if (id !== "chatScreen") clearReply();
};

// ── COUNTRY PICKER ──
let selectedCode = "+234";
const countries = [
    { n: "Nigeria", c: "+234", f: "🇳🇬" }, { n: "Ghana", c: "+233", f: "🇬🇭" },
    { n: "Kenya", c: "+254", f: "🇰🇪" }, { n: "South Africa", c: "+27", f: "🇿🇦" },
    { n: "USA", c: "+1", f: "🇺🇸" }, { n: "UK", c: "+44", f: "🇬🇧" },
    { n: "India", c: "+91", f: "🇮🇳" }, { n: "Canada", c: "+1", f: "🇨🇦" },
    { n: "Australia", c: "+61", f: "🇦🇺" }, { n: "Germany", c: "+49", f: "🇩🇪" },
    { n: "France", c: "+33", f: "🇫🇷" }, { n: "Brazil", c: "+55", f: "🇧🇷" },
    { n: "Mexico", c: "+52", f: "🇲🇽" }, { n: "UAE", c: "+971", f: "🇦🇪" },
    { n: "Saudi Arabia", c: "+966", f: "🇸🇦" }, { n: "Pakistan", c: "+92", f: "🇵🇰" },
    { n: "Bangladesh", c: "+880", f: "🇧🇩" }, { n: "Egypt", c: "+20", f: "🇪🇬" },
    { n: "Ethiopia", c: "+251", f: "🇪🇹" }, { n: "Tanzania", c: "+255", f: "🇹🇿" }
];

window.openCountryModal = () => document.getElementById("countryModal").style.display = "flex";
window.closeCountryModal = () => document.getElementById("countryModal").style.display = "none";
window.selectCountry = (f, n, c) => {
    selectedCode = c;
    document.getElementById("currentFlagName").innerText = `${f} ${n} (${c})`;
    closeCountryModal();
};
window.filterCountries = (t) => {
    const filtered = countries.filter(c => c.n.toLowerCase().includes(t.toLowerCase()) || c.c.includes(t));
    document.getElementById("countryList").innerHTML = filtered.map(item =>
        `<div class="country-item" onclick="selectCountry('${item.f}','${item.n}','${item.c}')">
            <span>${item.f} ${item.n}</span><span style="opacity:0.5">${item.c}</span>
        </div>`
    ).join("");
};

// ── AUTH ──
window.sendOTP = async () => {
    const raw = document.getElementById("phoneInput").value.trim();
    if (!raw) return alert("Enter your phone number.");
    // Strip all spaces, dashes, brackets and leading zeros
    const cleaned = raw.replace(/[\s\-().]/g, "").replace(/^0+/, "");
    const num = selectedCode + cleaned;
    if (!/^\+[1-9]\d{6,14}$/.test(num)) {
        return alert(`Invalid number: ${num}\n\nDo NOT include country code or leading zero.\nExample for 0243123456 → type 243123456`);
    }
    const btn = document.getElementById("sendCodeBtn");
    btn.disabled = true;
    btn.textContent = "Sending...";
    try {
        initRecaptcha();
        window.confirmationResult = await signInWithPhoneNumber(auth, num, window.recaptchaVerifier);
        document.getElementById("otpBox").style.display = "block";
        btn.textContent = "Code Sent ✓";
    } catch (e) {
        // Reset recaptcha on error so user can try again
        window.recaptchaVerifier?.clear();
        window.recaptchaVerifier = null;
        btn.disabled = false;
        btn.textContent = "Verify Number";
        alert("Failed: " + e.message + "\n\nNumber tried: " + num);
    }
};

window.verifyOTP = async () => {
    const code = document.getElementById("otpInput").value.trim();
    if (!code) return alert("Enter the 6-digit code.");
    try {
        await window.confirmationResult.confirm(code);
        Notification.requestPermission();
    } catch (e) {
        alert("Invalid code: " + e.message);
    }
};

// ── AUTH TABS ──
let authMode = "login";
window.switchAuthTab = (mode) => {
    authMode = mode;
    document.getElementById("tabLogin").classList.toggle("active", mode === "login");
    document.getElementById("tabSignup").classList.toggle("active", mode === "signup");
    document.getElementById("confirmPasswordInput").style.display = mode === "signup" ? "block" : "none";
    document.getElementById("authSubmitBtn").textContent = mode === "signup" ? "Create Account" : "Sign In";
    document.getElementById("forgotPassword").style.display = mode === "login" ? "block" : "none";
};

// ── EMAIL AUTH ──
window.submitEmailAuth = async () => {
    const email = document.getElementById("emailInput").value.trim();
    const password = document.getElementById("passwordInput").value;
    const confirm = document.getElementById("confirmPasswordInput").value;
    if (!email || !password) return showToast("Enter email and password.");
    if (authMode === "signup" && password !== confirm) return showToast("Passwords do not match.");
    if (password.length < 6) return showToast("Password must be at least 6 characters.");
    const btn = document.getElementById("authSubmitBtn");
    btn.disabled = true; btn.textContent = "Please wait...";
    try {
        if (authMode === "signup") {
            await createUserWithEmailAndPassword(auth, email, password);
        } else {
            await signInWithEmailAndPassword(auth, email, password);
        }
    } catch (e) {
        const msg = e.code === "auth/email-already-in-use" ? "Email already registered. Sign in instead."
            : e.code === "auth/user-not-found" ? "No account found. Sign up instead."
            : e.code === "auth/wrong-password" ? "Incorrect password."
            : e.code === "auth/invalid-email" ? "Invalid email address."
            : e.message;
        showToast(msg);
        btn.disabled = false;
        btn.textContent = authMode === "signup" ? "Create Account" : "Sign In";
    }
};

window.resetPassword = async () => {
    const email = document.getElementById("emailInput").value.trim();
    if (!email) return showToast("Enter your email address first.");
    try {
        await sendPasswordResetEmail(auth, email);
        showToast("Reset link sent to " + email);
    } catch (e) {
        showToast("Failed: " + e.message);
    }
};

window.logout = async () => {
    await setPresence(false);
    signOut(auth);
};

// ── GOOGLE SIGN-IN ──
window.signInWithGoogle = async () => {
    try {
        const provider = new GoogleAuthProvider();
        const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
        if (isMobile) {
            await signInWithRedirect(auth, provider);
        } else {
            await signInWithPopup(auth, provider);
        }
        Notification.requestPermission();
    } catch (e) {
        alert("Google sign-in failed: " + e.message);
    }
};

// Handle redirect result on page load
getRedirectResult(auth).catch(() => {});

// ── PRESENCE ──
async function setPresence(online) {
    if (!auth.currentUser) return;
    await setDoc(doc(db, "aura_presence", auth.currentUser.uid), {
        online, lastSeen: serverTimestamp()
    }, { merge: true });
}

window.addEventListener("beforeunload", () => setPresence(false));
document.addEventListener("visibilitychange", () => setPresence(!document.hidden));

// ── ONBOARDING ──
window.onboardUploadAvatar = async (input) => {
    const file = input.files[0];
    if (!file) return;
    const storageRef = ref(storage, `avatars/${auth.currentUser.uid}`);
    const snap = await uploadBytes(storageRef, file);
    const url = await getDownloadURL(snap.ref);
    document.getElementById("onboardAvatar").src = url;
    window._onboardAvatarUrl = url;
};

window.finishOnboarding = async () => {
    const name = document.getElementById("onboardName").value.trim();
    if (!name) return showToast("Enter your display name.");
    await setDoc(doc(db, "users", auth.currentUser.uid), {
        name,
        avatar: window._onboardAvatarUrl || "",
        onboarded: true
    }, { merge: true });
    document.getElementById("nameInput").value = name;
    if (window._onboardAvatarUrl) document.getElementById("avatarPreview").src = window._onboardAvatarUrl;
    showScreen("inboxScreen");
    loadInbox();
};

// ── PROFILE ──
window.saveProfile = async () => {
    const name = document.getElementById("nameInput").value.trim();
    if (!name) return alert("Enter a display name.");
    await setDoc(doc(db, "users", auth.currentUser.uid), { name }, { merge: true });
    alert("Profile updated.");
};

window.uploadAvatar = async (input) => {
    const file = input.files[0];
    if (!file) return;
    const storageRef = ref(storage, `avatars/${auth.currentUser.uid}`);
    const snap = await uploadBytes(storageRef, file);
    const url = await getDownloadURL(snap.ref);
    document.getElementById("avatarPreview").src = url;
    await setDoc(doc(db, "users", auth.currentUser.uid), { avatar: url }, { merge: true });
};

// ── USER LIST (Inbox + New Chat) ──
function loadInbox() {
    const me = auth.currentUser.uid;
    const list = document.getElementById("inboxList");
    const searchInput = document.getElementById("userSearchInput");

    // Search users by name
    searchInput.oninput = async () => {
        const q = searchInput.value.trim().toLowerCase();
        if (!q) { loadInboxConversations(); return; }
        const snap = await getDocs(collection(db, "users"));
        const results = snap.docs
            .filter(d => d.id !== me && d.data().name?.toLowerCase().includes(q));
        list.innerHTML = results.length
            ? results.map(d => userRow(d.id, d.data(), null)).join("")
            : `<p class="empty-state">No users found</p>`;
    };

    loadInboxConversations();
    loadGroupsInInbox(document.getElementById("inboxList"));
}

function loadInboxConversations() {
    const me = auth.currentUser.uid;
    const list = document.getElementById("inboxList");

    if (unsubInbox) unsubInbox();

    // Listen to all chats where current user is a member
    unsubInbox = onSnapshot(
        query(collection(db, "chats"), where("members", "array-contains", me), orderBy("lastMessageTime", "desc")),
        async snap => {
            if (snap.empty) {
                list.innerHTML = `<p class="empty-state">No conversations yet.<br>Search for someone above to start chatting.</p>`;
                return;
            }
            const rows = await Promise.all(snap.docs.map(async chatDoc => {
                const data = chatDoc.data();
                const peerId = data.members.find(id => id !== me);
                const peerSnap = await getDoc(doc(db, "users", peerId));
                const peer = peerSnap.exists() ? peerSnap.data() : { name: "Unknown", avatar: "" };
                const lastMsg = data.lastMessage ? await decrypt(data.lastMessage.c, data.lastMessage.i) : "";
                const unread = data.unread?.[me] || 0;
                return userRow(peerId, peer, { lastMsg, time: data.lastMessageTime, unread });
            }));
            list.innerHTML = rows.join("");
        }
    );
}

function userRow(peerId, peer, meta) {
    const avatar = peer.avatar
        ? `<img src="${peer.avatar}" class="avatar">`
        : `<div class="avatar avatar-placeholder">${(peer.name || "?")[0].toUpperCase()}</div>`;
    const badge = meta?.unread > 0 ? `<span class="unread-badge">${meta.unread}</span>` : "";
    const preview = meta?.lastMsg ? `<span class="inbox-preview">${escapeHtml(meta.lastMsg.slice(0, 40))}</span>` : "";
    const time = meta?.time ? `<span class="inbox-time">${formatTime(meta.time)}</span>` : "";
    return `
        <div class="inbox-row" onclick="openChat('${peerId}')">
            <div class="avatar-wrap">${avatar}</div>
            <div class="inbox-info">
                <div class="inbox-top"><span class="inbox-name">${escapeHtml(peer.name || peer.phone || "Unknown")}</span>${time}</div>
                <div class="inbox-bottom">${preview}${badge}</div>
            </div>
        </div>`;
}

// ── OPEN PRIVATE CHAT ──
window.openChat = async (peerId) => {
    const me = auth.currentUser.uid;
    const cid = chatId(me, peerId);
    currentChatId = cid;

    // Load peer info
    const peerSnap = await getDoc(doc(db, "users", peerId));
    currentPeer = peerSnap.exists() ? { uid: peerId, ...peerSnap.data() } : { uid: peerId, name: "Unknown" };

    // Ensure chat document exists
    const chatRef = doc(db, "chats", cid);
    const chatSnap = await getDoc(chatRef);
    if (!chatSnap.exists()) {
        await setDoc(chatRef, { members: [me, peerId], createdAt: serverTimestamp(), lastMessageTime: serverTimestamp() });
    }

    // Reset unread count for me
    await updateDoc(chatRef, { [`unread.${me}`]: 0 });

    // Update chat header
    document.getElementById("chatPeerName").textContent = currentPeer.name || "Chat";
    const peerAvatar = document.getElementById("chatPeerAvatar");
    if (currentPeer.avatar) {
        peerAvatar.src = currentPeer.avatar;
        peerAvatar.style.display = "block";
    } else {
        peerAvatar.style.display = "none";
    }

    showScreen("chatScreen");
    listenMessages(cid);
    listenPeerPresence(peerId);
    listenTyping(peerId);
};

// ── SEND IMAGE / FILE ──
window.sendFile = async (input) => {
    const file = input.files[0];
    if (!file || !currentChatId) return;
    const isImage = file.type.startsWith("image/");
    const previewLabel = isImage ? "📷 Photo" : "📎 " + file.name;
    const encPreview = await encrypt(previewLabel);
    const path = `files/${currentChatId}/${Date.now()}_${file.name}`;
    const storageRef = ref(storage, path);
    const snap = await uploadBytes(storageRef, file);
    const url = await getDownloadURL(snap.ref);
    await addDoc(collection(db, "chats", currentChatId, "messages"), {
        fileUrl: url, storagePath: path,
        fileName: file.name, type: isImage ? "image" : "file",
        uid: auth.currentUser.uid, time: serverTimestamp(), status: "sent"
    });
    await updateDoc(doc(db, "chats", currentChatId), {
        lastMessage: { c: encPreview.c, i: encPreview.i },
        lastMessageTime: serverTimestamp(),
        [`unread.${currentPeer.uid}`]: increment(1)
    });
    input.value = "";
};

// ── LISTEN TO MESSAGES ──
function buildMsgDiv(msgSnap, me) {
    const d = msgSnap.data();
    const isMe = d.uid === me;
    let content = "";
    if (d.type === "voice") {
        content = `<audio controls src="${d.audioUrl}" style="max-width:200px"></audio>`;
    } else if (d.type === "image") {
        content = `<img src="${d.fileUrl}" class="msg-image" onclick="openMediaViewer('${d.fileUrl}')">`;
    } else if (d.type === "file") {
        content = `<a href="${d.fileUrl}" target="_blank" class="msg-file">📎 ${escapeHtml(d.fileName)}</a>`;
    } else {
        return null; // async — handled separately
    }
    return _buildDiv(msgSnap, d, isMe, content);
}

async function buildMsgDivAsync(msgSnap, me) {
    const d = msgSnap.data();
    const isMe = d.uid === me;
    const content = escapeHtml(await decrypt(d.content, d.iv));
    return _buildDiv(msgSnap, d, isMe, content);
}

function _buildDiv(msgSnap, d, isMe, content) {
    const replyHtml = d.replyTo ? `<div class="reply-preview">${escapeHtml(d.replyTo.text)}</div>` : "";
    const reactions = d.reactions ? Object.values(d.reactions) : [];
    const counts = reactions.reduce((a, e) => { a[e] = (a[e] || 0) + 1; return a; }, {});
    const reactionsHtml = Object.keys(counts).length
        ? `<div class="msg-reactions">${Object.entries(counts).map(([e, n]) => `<span>${e}${n > 1 ? ` ${n}` : ""}</span>`).join("")}</div>` : "";
    const tick = isMe ? (d.status === "read" ? `<span style="color:var(--accent)">✓✓</span>` : `<span style="opacity:0.4">✓</span>`) : "";
    const div = document.createElement("div");
    div.className = `msg ${isMe ? "sent" : "received"}`;
    div.dataset.id = msgSnap.id;
    div.innerHTML = `${replyHtml}${content}${reactionsHtml}<div class="msg-meta"><span class="msg-time">${formatTime(d.time)}</span>${tick}</div>`;
    div.addEventListener("contextmenu", e => { e.preventDefault(); showMsgActions(msgSnap.id, isMe, content, d.storagePath, e.clientX, e.clientY); });
    let pressTimer;
    div.addEventListener("touchstart", e => { pressTimer = setTimeout(() => showMsgActions(msgSnap.id, isMe, content, d.storagePath, e.touches[0].clientX, e.touches[0].clientY), 500); });
    div.addEventListener("touchend", () => clearTimeout(pressTimer));
    return div;
}

function listenMessages(cid) {
    if (unsubMessages) unsubMessages();
    oldestMsgSnap = null;
    const me = auth.currentUser.uid;
    const cont = document.getElementById("msgContainer");
    cont.innerHTML = "";

    // Listen only to latest PAGE_SIZE messages
    unsubMessages = onSnapshot(
        query(collection(db, "chats", cid, "messages"), orderBy("time", "asc"), limit(PAGE_SIZE)),
        async snap => {
            if (snap.docs.length) oldestMsgSnap = snap.docs[0];
            const batch = writeBatch(db);
            const fragments = [];
            for (const msgSnap of snap.docs) {
                const d = msgSnap.data();
                const isMe = d.uid === me;
                let div;
                if (d.type === "text") {
                    div = await buildMsgDivAsync(msgSnap, me);
                } else {
                    div = buildMsgDiv(msgSnap, me);
                }
                if (div) fragments.push(div);
                if (!isMe && d.status !== "read") batch.update(msgSnap.ref, { status: "read" });
            }
            await batch.commit();
            cont.replaceChildren(...fragments);
            cont.scrollTop = cont.scrollHeight;
        }
    );

    // Load more on scroll to top
    cont.onscroll = () => { if (cont.scrollTop === 0) loadOlderMessages(cid); };
}

async function loadOlderMessages(cid) {
    if (!oldestMsgSnap) return;
    const me = auth.currentUser.uid;
    const cont = document.getElementById("msgContainer");
    const snap = await getDocs(
        query(collection(db, "chats", cid, "messages"), orderBy("time", "desc"), startAfter(oldestMsgSnap), limit(PAGE_SIZE))
    );
    if (snap.empty) return;
    oldestMsgSnap = snap.docs[snap.docs.length - 1];
    const prevHeight = cont.scrollHeight;
    const fragments = [];
    for (const msgSnap of [...snap.docs].reverse()) {
        const d = msgSnap.data();
        let div;
        if (d.type === "text") { div = await buildMsgDivAsync(msgSnap, me); }
        else { div = buildMsgDiv(msgSnap, me); }
        if (div) fragments.push(div);
    }
    cont.prepend(...fragments);
    cont.scrollTop = cont.scrollHeight - prevHeight;
}

// ── MESSAGE ACTIONS (long press menu) ──
function showMsgActions(msgId, isMe, text, storagePath, x, y) {
    const menu = document.getElementById("msgActionMenu");
    menu.style.display = "flex";
    menu.style.left = Math.min(x, window.innerWidth - 180) + "px";
    menu.style.top = Math.min(y, window.innerHeight - 160) + "px";
    document.getElementById("actionReply").onclick = () => { setReply(msgId, text.replace(/<[^>]+>/g, "")); menu.style.display = "none"; };
    document.getElementById("actionReact").onclick = () => { menu.style.display = "none"; showReactionPicker(msgId, x, y); };
    document.getElementById("actionDelete").style.display = isMe ? "block" : "none";
    document.getElementById("actionDelete").onclick = () => { menu.style.display = "none"; deleteMessage(msgId, storagePath); };
    document.getElementById("actionCopy").onclick = () => { navigator.clipboard?.writeText(text.replace(/<[^>]+>/g, "")); menu.style.display = "none"; };
}
document.addEventListener("click", e => {
    if (!e.target.closest("#msgActionMenu")) document.getElementById("msgActionMenu").style.display = "none";
});

// ── PEER PRESENCE ──
function listenPeerPresence(peerId) {
    onSnapshot(doc(db, "aura_presence", peerId), snap => {
        const data = snap.data();
        const statusEl = document.getElementById("chatPeerStatus");
        if (data?.online) {
            statusEl.textContent = "online";
            statusEl.style.color = "var(--accent)";
        } else if (data?.lastSeen) {
            statusEl.textContent = "last seen " + formatTime(data.lastSeen);
            statusEl.style.color = "rgba(255,255,255,0.4)";
        } else {
            statusEl.textContent = "";
        }
    });
}

// ── TYPING ──
window.handleTyping = () => {
    if (!currentChatId) return;
    setDoc(doc(db, "aura_presence", auth.currentUser.uid), { isTyping: currentChatId }, { merge: true });
    clearTimeout(window.tOut);
    window.tOut = setTimeout(() =>
        setDoc(doc(db, "aura_presence", auth.currentUser.uid), { isTyping: null }, { merge: true }), 2000);
};

function listenTyping(peerId) {
    onSnapshot(doc(db, "aura_presence", peerId), snap => {
        const isTyping = snap.data()?.isTyping === currentChatId;
        document.getElementById("typingIndicator").style.display = isTyping ? "block" : "none";
    });
}

// ── SEND MESSAGE ──
window.sendMessage = async () => {
    const t = document.getElementById("msgInput").value.trim();
    if (!t || !currentChatId) return;
    const me = auth.currentUser.uid;
    const encrypted = await encrypt(t);
    const msgData = {
        content: encrypted.c, iv: encrypted.i, type: "text",
        uid: me, time: serverTimestamp(), status: "sent"
    };
    if (replyTo) {
        msgData.replyTo = { id: replyTo.id, text: replyTo.text.slice(0, 80) };
    }
    await addDoc(collection(db, "chats", currentChatId, "messages"), msgData);
    await updateDoc(doc(db, "chats", currentChatId), {
        lastMessage: { c: encrypted.c, i: encrypted.i },
        lastMessageTime: serverTimestamp(),
        [`unread.${currentPeer.uid}`]: increment(1)
    });
    document.getElementById("msgInput").value = "";
    clearReply();
    setDoc(doc(db, "aura_presence", me), { isTyping: null }, { merge: true });
};

// ── REPLY ──
function setReply(msgId, text) {
    replyTo = { id: msgId, text };
    const bar = document.getElementById("replyBar");
    document.getElementById("replyText").textContent = text.slice(0, 60);
    bar.style.display = "flex";
    document.getElementById("msgInput").focus();
}
function clearReply() {
    replyTo = null;
    document.getElementById("replyBar").style.display = "none";
}
window.clearReply = clearReply;

// ── DELETE MESSAGE ──
window.deleteMessage = async (msgId, storageUrl) => {
    if (!confirm("Delete this message?")) return;
    await deleteDoc(doc(db, "chats", currentChatId, "messages", msgId));
    if (storageUrl) {
        try { await deleteObject(ref(storage, storageUrl)); } catch {}
    }
};

// ── REACT TO MESSAGE ──
window.reactToMessage = async (msgId, emoji) => {
    const me = auth.currentUser.uid;
    await updateDoc(doc(db, "chats", currentChatId, "messages", msgId), {
        [`reactions.${me}`]: emoji
    });
    document.getElementById("reactionPicker").style.display = "none";
};

window.showReactionPicker = (msgId, x, y) => {
    const picker = document.getElementById("reactionPicker");
    picker.style.display = "flex";
    picker.style.left = Math.min(x, window.innerWidth - 220) + "px";
    picker.style.top = Math.max(y - 60, 10) + "px";
    picker.dataset.msgId = msgId;
};
document.addEventListener("click", e => {
    if (!e.target.closest("#reactionPicker") && !e.target.closest(".msg")) {
        document.getElementById("reactionPicker").style.display = "none";
    }
});

document.getElementById("msgInput").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); window.sendMessage(); }
});

// ── PUSH NOTIFICATIONS ──
async function initPushNotifications() {
    try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") return;
        const token = await getToken(messaging, { vapidKey: VAPID_KEY });
        if (token) {
            await setDoc(doc(db, "users", auth.currentUser.uid), { fcmToken: token }, { merge: true });
        }
        onMessage(messaging, payload => {
            // App is in foreground — show a subtle in-app toast
            const { title, body } = payload.notification || {};
            if (title) showToast(`${title}: ${body}`);
        });
    } catch {}
}

function showToast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
}

// ── VOICE MESSAGES ──
let recorder, chunks = [];
window.startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
        if (!currentChatId) return;
        const blob = new Blob(chunks, { type: "audio/mpeg" });
        const storageRef = ref(storage, `voice/${currentChatId}/${Date.now()}.mp3`);
        const snap = await uploadBytes(storageRef, blob);
        const url = await getDownloadURL(snap.ref);
        await addDoc(collection(db, "chats", currentChatId, "messages"), {
            audioUrl: url, type: "voice",
            uid: auth.currentUser.uid, time: serverTimestamp(), status: "sent"
        });
    };
    recorder.start();
    document.getElementById("voiceBtn").style.background = "var(--secondary)";
};
window.stopRecording = () => {
    recorder?.stop();
    document.getElementById("voiceBtn").style.background = "var(--glass)";
};

// ── AUTH STATE ──
onAuthStateChanged(auth, async user => {
    if (user) {
        await setDoc(doc(db, "users", user.uid), {
            uid: user.uid,
            phone: user.phoneNumber || "",
            email: user.email || "",
            lastSeen: serverTimestamp()
        }, { merge: true });

        // Pre-fill Google profile if available
        if (user.displayName || user.photoURL) {
            await setDoc(doc(db, "users", user.uid), {
                name: user.displayName || "",
                avatar: user.photoURL || "",
                onboarded: true
            }, { merge: true });
        }

        setPresence(true);
        initPushNotifications();

        // Check if user has completed onboarding
        const profileSnap = await getDoc(doc(db, "users", user.uid));
        const profile = profileSnap.exists() ? profileSnap.data() : {};

        if (!profile.onboarded) {
            showScreen("onboardScreen");
        } else {
            showScreen("inboxScreen");
            loadInbox();
        }

        if (profile.name) document.getElementById("nameInput").value = profile.name;
        if (profile.avatar) document.getElementById("avatarPreview").src = profile.avatar;

        // Admin button
        if (user.phoneNumber === ADMIN_NUMBER) {
            const btn = document.createElement("button");
            btn.textContent = "★";
            btn.className = "admin-fab";
            btn.onclick = () => { loadAdmin(); showScreen("adminScreen"); };
            document.body.appendChild(btn);
        }
    } else {
        if (unsubMessages) unsubMessages();
        if (unsubInbox) unsubInbox();
        showScreen("authScreen");
    }
});

// ── ADMIN ──
window.loadAdmin = async () => {
    document.getElementById("statUsers").innerText = (await getDocs(collection(db, "users"))).size;
    document.getElementById("statMsgs").innerText = (await getDocs(collection(db, "chats"))).size;
};

window.sendBroadcast = async () => {
    const t = document.getElementById("broadcastMsg").value.trim();
    if (!t) return;
    const enc = await encrypt("📢 ADMIN: " + t);
    await addDoc(collection(db, "aura_broadcast"), {
        content: enc.c, iv: enc.i, uid: "SYSTEM", time: serverTimestamp()
    });
    document.getElementById("broadcastMsg").value = "";
    alert("Broadcast sent.");
};

// ── MEDIA VIEWER ──
window.openMediaViewer = (url) => {
    document.getElementById("mediaViewerImg").src = url;
    document.getElementById("mediaViewer").style.display = "flex";
};
window.closeMediaViewer = () => { document.getElementById("mediaViewer").style.display = "none"; };

// ── MEDIA GALLERY ──
window.openGallery = async () => {
    const snap = await getDocs(query(collection(db, "chats", currentChatId, "messages"), where("type", "==", "image"), orderBy("time", "desc")));
    const grid = document.getElementById("galleryGrid");
    grid.innerHTML = snap.empty
        ? `<p class="empty-state">No images shared yet.</p>`
        : snap.docs.map(d => `<img src="${d.data().fileUrl}" class="gallery-thumb" onclick="openMediaViewer('${d.data().fileUrl}')">`).join("");
    document.getElementById("galleryModal").style.display = "flex";
};
window.closeGallery = () => { document.getElementById("galleryModal").style.display = "none"; };

// ── MESSAGE SEARCH ──
window.toggleSearch = () => {
    const bar = document.getElementById("searchBar");
    const visible = bar.style.display === "flex";
    bar.style.display = visible ? "none" : "flex";
    if (!visible) document.getElementById("searchInput").focus();
};
window.searchMessages = async () => {
    const q = document.getElementById("searchInput").value.trim().toLowerCase();
    if (!q || !currentChatId) return;
    const snap = await getDocs(query(collection(db, "chats", currentChatId, "messages"), orderBy("time", "asc")));
    for (const msgSnap of snap.docs) {
        const d = msgSnap.data();
        if (d.type !== "text") continue;
        const text = await decrypt(d.content, d.iv);
        if (text.toLowerCase().includes(q)) {
            const el = document.querySelector(`[data-id="${msgSnap.id}"]`);
            if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
        }
    }
    showToast("No results found");
};

// ── BLOCK / REPORT ──
window.blockUser = async () => {
    if (!currentPeer || !confirm(`Block ${currentPeer.name}?`)) return;
    await setDoc(doc(db, "users", auth.currentUser.uid), { blocked: { [currentPeer.uid]: true } }, { merge: true });
    showToast(`${currentPeer.name} blocked.`);
    showScreen("inboxScreen");
};
window.reportUser = async () => {
    if (!currentPeer) return;
    const reason = prompt("Reason for report:") || "No reason given";
    await addDoc(collection(db, "reports"), { reportedBy: auth.currentUser.uid, reportedUser: currentPeer.uid, reason, time: serverTimestamp() });
    showToast("Report submitted.");
};

// ── MISC ──
window.shareAura = () => navigator.share?.({ title: "Aura", text: "Join me on Aura!", url: window.location.href });

// ── GROUP CHATS ──
let currentGroupId = null;
let currentGroup = null;
let unsubGroupMessages = null;
let groupReplyTo = null;
let selectedMembers = {}; // { uid: { name, avatar } }

window.searchGroupMembers = async (q) => {
    const me = auth.currentUser.uid;
    const snap = await getDocs(collection(db, "users"));
    const results = snap.docs.filter(d => d.id !== me && d.data().name?.toLowerCase().includes(q.toLowerCase()));
    document.getElementById("groupMemberResults").innerHTML = results.map(d => {
        const u = d.data();
        return `<div class="inbox-row" onclick="toggleMember('${d.id}','${escapeHtml(u.name)}','${u.avatar||""}')"
            style="padding:10px 6px;">
            <div class="avatar avatar-placeholder">${(u.name||"?")[0].toUpperCase()}</div>
            <span style="margin-left:10px;">${escapeHtml(u.name)}</span>
            <span id="chk_${d.id}" style="margin-left:auto;">${selectedMembers[d.id] ? "✓" : ""}</span>
        </div>`;
    }).join("");
};

window.toggleMember = (uid, name, avatar) => {
    if (selectedMembers[uid]) {
        delete selectedMembers[uid];
    } else {
        selectedMembers[uid] = { name, avatar };
    }
    renderSelectedMembers();
    const chk = document.getElementById(`chk_${uid}`);
    if (chk) chk.textContent = selectedMembers[uid] ? "✓" : "";
};

function renderSelectedMembers() {
    const bar = document.getElementById("selectedMembersBar");
    bar.innerHTML = Object.entries(selectedMembers).map(([uid, u]) =>
        `<div class="selected-chip">${escapeHtml(u.name)}<span onclick="toggleMember('${uid}','${u.name}','${u.avatar}')">✕</span></div>`
    ).join("");
}

window.createGroup = async () => {
    const name = document.getElementById("groupNameInput").value.trim();
    if (!name) return showToast("Enter a group name.");
    const memberIds = Object.keys(selectedMembers);
    if (memberIds.length < 1) return showToast("Add at least 1 member.");
    const me = auth.currentUser.uid;
    const members = [me, ...memberIds];
    const groupRef = await addDoc(collection(db, "groups"), {
        name, members, admins: [me],
        createdBy: me, createdAt: serverTimestamp(),
        lastMessageTime: serverTimestamp()
    });
    selectedMembers = {};
    document.getElementById("groupNameInput").value = "";
    document.getElementById("groupMemberResults").innerHTML = "";
    renderSelectedMembers();
    openGroupChat(groupRef.id);
};

window.openGroupChat = async (groupId) => {
    currentGroupId = groupId;
    const snap = await getDoc(doc(db, "groups", groupId));
    currentGroup = { id: groupId, ...snap.data() };

    document.getElementById("groupChatName").textContent = currentGroup.name;
    document.getElementById("groupChatMembers").textContent = `${currentGroup.members.length} members`;
    document.getElementById("groupInfoName").textContent = currentGroup.name;
    document.getElementById("groupInfoCount").textContent = `${currentGroup.members.length} members`;

    // Load member list for info screen
    const memberSnaps = await Promise.all(currentGroup.members.map(uid => getDoc(doc(db, "users", uid))));
    document.getElementById("groupMemberList").innerHTML = memberSnaps.map(s => {
        const u = s.data() || {};
        const isAdmin = currentGroup.admins?.includes(s.id);
        return `<div class="inbox-row" style="padding:10px 6px;">
            <div class="avatar avatar-placeholder">${(u.name||"?")[0].toUpperCase()}</div>
            <span style="margin-left:10px;flex:1;">${escapeHtml(u.name||"Unknown")}</span>
            ${isAdmin ? `<span style="font-size:11px;opacity:0.5;">admin</span>` : ""}
        </div>`;
    }).join("");

    showScreen("groupChatScreen");
    listenGroupMessages(groupId);
    listenGroupTyping(groupId);
};

function listenGroupMessages(groupId) {
    if (unsubGroupMessages) unsubGroupMessages();
    const me = auth.currentUser.uid;
    const cont = document.getElementById("groupMsgContainer");
    cont.innerHTML = "";

    unsubGroupMessages = onSnapshot(
        query(collection(db, "groups", groupId, "messages"), orderBy("time", "asc"), limit(PAGE_SIZE)),
        async snap => {
            const fragments = [];
            for (const msgSnap of snap.docs) {
                const d = msgSnap.data();
                const isMe = d.uid === me;
                let content = "";
                if (d.type === "image") {
                    content = `<img src="${d.fileUrl}" class="msg-image" onclick="openMediaViewer('${d.fileUrl}')">`;
                } else if (d.type === "file") {
                    content = `<a href="${d.fileUrl}" target="_blank" class="msg-file">📎 ${escapeHtml(d.fileName)}</a>`;
                } else {
                    content = escapeHtml(await decrypt(d.content, d.iv));
                }
                const replyHtml = d.replyTo ? `<div class="reply-preview">${escapeHtml(d.replyTo.text)}</div>` : "";
                const senderHtml = !isMe ? `<div class="group-sender">${escapeHtml(d.senderName || "?")}</div>` : "";
                const div = document.createElement("div");
                div.className = `msg ${isMe ? "sent" : "received"}`;
                div.dataset.id = msgSnap.id;
                div.innerHTML = `${senderHtml}${replyHtml}${content}<div class="msg-meta"><span class="msg-time">${formatTime(d.time)}</span></div>`;
                div.addEventListener("contextmenu", e => { e.preventDefault(); showGroupMsgActions(msgSnap.id, isMe, content, d.storagePath, e.clientX, e.clientY); });
                let pt;
                div.addEventListener("touchstart", e => { pt = setTimeout(() => showGroupMsgActions(msgSnap.id, isMe, content, d.storagePath, e.touches[0].clientX, e.touches[0].clientY), 500); });
                div.addEventListener("touchend", () => clearTimeout(pt));
                fragments.push(div);
            }
            cont.replaceChildren(...fragments);
            cont.scrollTop = cont.scrollHeight;
        }
    );
}

function showGroupMsgActions(msgId, isMe, text, storagePath, x, y) {
    const menu = document.getElementById("msgActionMenu");
    menu.style.display = "flex";
    menu.style.left = Math.min(x, window.innerWidth - 180) + "px";
    menu.style.top = Math.min(y, window.innerHeight - 160) + "px";
    document.getElementById("actionReply").onclick = () => {
        groupReplyTo = { id: msgId, text: text.replace(/<[^>]+>/g, "") };
        document.getElementById("groupReplyText").textContent = groupReplyTo.text.slice(0, 60);
        document.getElementById("groupReplyBar").style.display = "flex";
        document.getElementById("groupMsgInput").focus();
        menu.style.display = "none";
    };
    document.getElementById("actionReact").onclick = () => { menu.style.display = "none"; showReactionPicker(msgId, x, y); };
    document.getElementById("actionDelete").style.display = isMe ? "block" : "none";
    document.getElementById("actionDelete").onclick = async () => {
        menu.style.display = "none";
        if (!confirm("Delete?")) return;
        await deleteDoc(doc(db, "groups", currentGroupId, "messages", msgId));
        if (storagePath) try { await deleteObject(ref(storage, storagePath)); } catch {}
    };
    document.getElementById("actionCopy").onclick = () => { navigator.clipboard?.writeText(text.replace(/<[^>]+>/g, "")); menu.style.display = "none"; };
}

window.clearGroupReply = () => {
    groupReplyTo = null;
    document.getElementById("groupReplyBar").style.display = "none";
};

window.sendGroupMessage = async () => {
    const t = document.getElementById("groupMsgInput").value.trim();
    if (!t || !currentGroupId) return;
    const me = auth.currentUser.uid;
    const meSnap = await getDoc(doc(db, "users", me));
    const senderName = meSnap.data()?.name || "?";
    const encrypted = await encrypt(t);
    const msgData = { content: encrypted.c, iv: encrypted.i, type: "text", uid: me, senderName, time: serverTimestamp() };
    if (groupReplyTo) msgData.replyTo = { id: groupReplyTo.id, text: groupReplyTo.text.slice(0, 80) };
    await addDoc(collection(db, "groups", currentGroupId, "messages"), msgData);
    await updateDoc(doc(db, "groups", currentGroupId), { lastMessageTime: serverTimestamp() });
    document.getElementById("groupMsgInput").value = "";
    clearGroupReply();
    setDoc(doc(db, "aura_presence", me), { groupTyping: null }, { merge: true });
};

document.getElementById("groupMsgInput").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); window.sendGroupMessage(); }
});

window.sendGroupFile = async (input) => {
    const file = input.files[0];
    if (!file || !currentGroupId) return;
    const isImage = file.type.startsWith("image/");
    const path = `groups/${currentGroupId}/${Date.now()}_${file.name}`;
    const storageRef = ref(storage, path);
    const snap = await uploadBytes(storageRef, file);
    const url = await getDownloadURL(snap.ref);
    const meSnap = await getDoc(doc(db, "users", auth.currentUser.uid));
    await addDoc(collection(db, "groups", currentGroupId, "messages"), {
        fileUrl: url, storagePath: path, fileName: file.name,
        type: isImage ? "image" : "file",
        uid: auth.currentUser.uid, senderName: meSnap.data()?.name || "?",
        time: serverTimestamp()
    });
    await updateDoc(doc(db, "groups", currentGroupId), { lastMessageTime: serverTimestamp() });
    input.value = "";
};

window.handleGroupTyping = () => {
    if (!currentGroupId) return;
    const me = auth.currentUser.uid;
    setDoc(doc(db, "aura_presence", me), { groupTyping: currentGroupId }, { merge: true });
    clearTimeout(window.gTypingOut);
    window.gTypingOut = setTimeout(() =>
        setDoc(doc(db, "aura_presence", me), { groupTyping: null }, { merge: true }), 2000);
};

function listenGroupTyping(groupId) {
    onSnapshot(collection(db, "aura_presence"), snap => {
        const me = auth.currentUser.uid;
        const typing = snap.docs.some(d => d.id !== me && d.data().groupTyping === groupId);
        document.getElementById("groupTypingIndicator").style.display = typing ? "block" : "none";
    });
}

window.leaveGroup = async () => {
    if (!confirm("Leave this group?")) return;
    const me = auth.currentUser.uid;
    const members = currentGroup.members.filter(id => id !== me);
    await updateDoc(doc(db, "groups", currentGroupId), { members });
    showScreen("inboxScreen");
};

// Load groups in inbox
function loadGroupsInInbox(list) {
    const me = auth.currentUser.uid;
    onSnapshot(
        query(collection(db, "groups"), where("members", "array-contains", me), orderBy("lastMessageTime", "desc")),
        snap => {
            snap.docs.forEach(groupDoc => {
                const g = groupDoc.data();
                const div = document.createElement("div");
                div.className = "inbox-row";
                div.innerHTML = `
                    <div class="avatar avatar-placeholder" style="font-size:20px;">👥</div>
                    <div class="inbox-info">
                        <div class="inbox-top"><span class="inbox-name">${escapeHtml(g.name)}</span>
                        <span class="inbox-time">${formatTime(g.lastMessageTime)}</span></div>
                        <div class="inbox-bottom"><span class="inbox-preview">${g.members.length} members</span></div>
                    </div>`;
                div.onclick = () => openGroupChat(groupDoc.id);
                list.appendChild(div);
            });
        }
    );
}

window.onload = () => {
    window.filterCountries("");
    // Initialise recaptcha only when user clicks Verify Number
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
};

function initRecaptcha() {
    if (window.recaptchaVerifier) return;
    window.recaptchaVerifier = new RecaptchaVerifier(auth, "sendCodeBtn", {
        size: "invisible",
        callback: () => {}
    });
}

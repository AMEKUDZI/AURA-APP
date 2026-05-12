const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

// ── Notify on new private message ──
exports.onNewMessage = onDocumentCreated(
    "chats/{chatId}/messages/{msgId}",
    async (event) => {
        const msg = event.data.data();
        const { chatId } = event.params;

        // Get chat members
        const chatSnap = await db.doc(`chats/${chatId}`).get();
        if (!chatSnap.exists) return;
        const { members } = chatSnap.data();

        // Recipient is the other member
        const recipientId = members.find(id => id !== msg.uid);
        if (!recipientId) return;

        // Get sender name + recipient FCM token
        const [senderSnap, recipientSnap] = await Promise.all([
            db.doc(`users/${msg.uid}`).get(),
            db.doc(`users/${recipientId}`).get()
        ]);

        const fcmToken = recipientSnap.data()?.fcmToken;
        if (!fcmToken) return;

        const senderName = senderSnap.data()?.name || "Someone";
        const body = msg.type === "text" ? "Sent you a message" :
                     msg.type === "image" ? "📷 Sent a photo" :
                     msg.type === "voice" ? "🎤 Sent a voice message" : "📎 Sent a file";

        await getMessaging().send({
            token: fcmToken,
            notification: { title: senderName, body },
            data: { chatId, senderId: msg.uid },
            android: { priority: "high", notification: { sound: "default", channelId: "messages" } },
            apns: { payload: { aps: { sound: "default", badge: 1 } } }
        });
    }
);

// ── Notify on new group message ──
exports.onNewGroupMessage = onDocumentCreated(
    "groups/{groupId}/messages/{msgId}",
    async (event) => {
        const msg = event.data.data();
        const { groupId } = event.params;

        const groupSnap = await db.doc(`groups/${groupId}`).get();
        if (!groupSnap.exists) return;
        const { members, name: groupName } = groupSnap.data();

        const senderSnap = await db.doc(`users/${msg.uid}`).get();
        const senderName = senderSnap.data()?.name || "Someone";

        const recipients = members.filter(id => id !== msg.uid);
        const tokenSnaps = await Promise.all(recipients.map(id => db.doc(`users/${id}`).get()));
        const tokens = tokenSnaps.map(s => s.data()?.fcmToken).filter(Boolean);
        if (!tokens.length) return;

        const body = msg.type === "text" ? "Sent a message" : "Sent a file";

        await getMessaging().sendEachForMulticast({
            tokens,
            notification: { title: `${senderName} in ${groupName}`, body },
            data: { groupId, senderId: msg.uid },
            android: { priority: "high", notification: { sound: "default", channelId: "messages" } },
            apns: { payload: { aps: { sound: "default", badge: 1 } } }
        });
    }
);

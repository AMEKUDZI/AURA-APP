# Aura Messenger - Security Setup Guide

## Completed Security Improvements

### Implemented
- ✅ Per-user encryption keys (no hardcoded SECRET)
- ✅ Admin verification via Firestore
- ✅ Rate limiting (3 OTP requests/minute)
- ✅ Input validation (phone, OTP)
- ✅ CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy
- ✅ Error logging to Firestore `errors` collection
- ✅ Voice message size limit (5MB)
- ✅ Sender phone tracking for decryption
- ✅ Enhanced SSRF protection in Service Worker

---

## Required Setup

### 1. Firebase Console - Enable App Check (Recommended)
1. Go to Firebase Console → Your Project → App Check
2. Register your domain under "Domains"
3. Enable reCAPTCHA v3 for authentication protection

### 2. Deploy Cloud Functions
```bash
cd functions
npm install
firebase deploy --only functions
```

This enables:
- Auto-delete messages older than 7 days
- Hourly rate limit cleanup

### 3. Set Up Admin Users
In Firestore, create documents for each admin:

```
Collection: admins
Document: <user UID from Firebase Auth>
Fields: { role: "admin" }
```

Or add UIDs directly to `ADMIN_IDS` array in index.html.

### 4. Security Rules (Firestore)
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Users can only read/write their own data
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    // Anyone can read messages, only auth users can write
    match /aura_chat/{msgId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null 
        && request.resource.data.uid == request.auth.uid;
    }
    // Only admins can access admin collection
    match /admins/{uid} {
      allow read: if request.auth != null && uid in get(/databases/$(database)/documents/admins/$(request.auth.uid)).data.role == 'admin';
    }
    // Rate limits - self-service
    match /rate_limits/{phone} {
      allow read, write: if request.auth != null;
    }
    // Errors - write only
    match /errors/{docId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null;
    }
  }
}
```

### 5. Storage Rules
```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /voice/{userId}/{allPaths=**} {
      allow read: if request.auth != null;
      allow write: if request.auth != null 
        && request.auth.uid == userId
        && request.resource.size < 5 * 1024 * 1024
        && request.resource.contentType.hasPrefix('audio/');
    }
  }
}
```

---

## Environment Variables
Create `.env` file in project root:
```
FIREBASE_API_KEY=your_api_key
FIREBASE_PROJECT_ID=your_project_id
```

---

## Testing
1. Deploy to Firebase Hosting: `firebase deploy`
2. Test OTP rate limiting (try 4+ requests)
3. Verify admin button only appears for admin users
4. Check `errors` collection for logged issues
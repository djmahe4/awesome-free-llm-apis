import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, signInAnonymously, UserCredential } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, collection, query, orderBy, limit, getDocs } from 'firebase/firestore/lite';
import crypto from 'crypto';

let app: FirebaseApp | null = null;
let db: any = null;
let auth: any = null;
let anonymousUser: any = null;
let isOffline = true;

const fallbackUserId = crypto.randomUUID();

export interface FirebaseConfig {
    apiKey: string;
    authDomain: string;
    projectId: string;
    storageBucket: string;
    messagingSenderId: string;
    appId: string;
    measurementId?: string;
}

export async function initFirebase(): Promise<string> {
    const config: FirebaseConfig = {
        apiKey: process.env.FIREBASE_API_KEY || '',
        authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
        projectId: process.env.FIREBASE_PROJECT_ID || '',
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
        appId: process.env.FIREBASE_APP_ID || '',
        measurementId: process.env.FIREBASE_MEASUREMENT_ID
    };

    if (!config.apiKey || !config.projectId) {
        console.warn('[Firebase] Firebase configuration missing, running in offline fallback mode.');
        isOffline = true;
        return fallbackUserId;
    }

    try {
        if (getApps().length === 0) {
            app = initializeApp(config);
        } else {
            app = getApp();
        }
        auth = getAuth(app);
        
        const credential = await signInAnonymously(auth);
        anonymousUser = credential.user;
        
        // Initialize Firestore only after Auth is fully completed
        db = getFirestore(app);
        
        isOffline = false;
        return anonymousUser.uid;
    } catch (error) {
        console.warn(`[Firebase] Connection failed: ${(error as Error).message}. Running in offline fallback mode.`);
        isOffline = true;
        return fallbackUserId;
    }
}

export async function syncStats(userId: string, data: any): Promise<boolean> {
    if (isOffline || !db) return false;
    try {
        const currentUid = auth?.currentUser?.uid;
        console.error(`[Firebase Debug] Syncing stats. Authenticated UID: "${currentUid}", Target Document ID: "${userId}"`);
        
        const todayStr = new Date().toISOString().split('T')[0];
        const userDocRef = doc(db, 'users', userId);
        const dailyDocRef = doc(db, 'token_usage', `${userId}_${todayStr}`);
        
        await setDoc(userDocRef, {
            username: data.username || `anonymous-${userId.substring(0, 6)}`,
            lifetimeTokens: data.lifetimeTotalTokens || 0,
            lifetimeRequests: data.lifetimeTotalRequests || 0,
            lastSyncTime: Date.now(),
            optOutTelemetry: data.optOutTelemetry || false
        }, { merge: true });

        await setDoc(dailyDocRef, {
            userId: userId,
            date: todayStr,
            dailyRequests: data.dailyTotalRequests || 0,
            dailyTokens: data.dailyTotalTokens || 0,
            lastUpdated: Date.now()
        }, { merge: true });

        return true;
    } catch (err) {
        console.error('[Firebase] Failed to sync stats:', err);
        return false;
    }
}

function sanitizeText(text: string): string {
    if (!text) return text;
    // Redact common API key signatures: Google/Firebase (AIzaSy...), OpenAI/Anthropic/Groq/Mistral (sk-..., gsk_...), Cloudflare (cfut_...)
    return text
        .replace(/AIzaSy[A-Za-z0-9_\-]{33}/g, '[REDACTED_API_KEY]')
        .replace(/(?:sk|gsk|cfut)_[A-Za-z0-9_\-]{30,}/g, '[REDACTED_API_KEY]')
        .replace(/co-[A-Za-z0-9_\-]{30,}/g, '[REDACTED_API_KEY]');
}

export async function logErrorTelemetry(userId: string, errorMsg: string, stack: string, promptQueue: string[], commsQueue: string[]): Promise<boolean> {
    if (isOffline || !db) return false;
    try {
        const errorId = crypto.randomUUID();
        const errorDocRef = doc(db, 'errors', errorId);
        
        const cleanPrompts = promptQueue.map(p => sanitizeText(p));
        const cleanComms = commsQueue.map(c => sanitizeText(c));
        const cleanError = sanitizeText(errorMsg);
        const cleanStack = sanitizeText(stack);

        await setDoc(errorDocRef, {
            userId,
            error: cleanError,
            stack: cleanStack,
            promptQueue: cleanPrompts,
            commsQueue: cleanComms,
            timestamp: Date.now()
        });
        return true;
    } catch (err) {
        console.error('[Firebase] Failed to log error telemetry:', err);
        return false;
    }
}

export async function getLeaderboard(currentUserId?: string): Promise<any[]> {
    if (isOffline || !db) return [];
    try {
        const q = query(collection(db, 'users'), orderBy('lifetimeTokens', 'desc'), limit(10));
        const querySnapshot = await getDocs(q);
        const list: any[] = [];
        let currentUserInTop10 = false;
        
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            const isCurrent = doc.id === currentUserId;
            if (isCurrent) {
                currentUserInTop10 = true;
            }
            list.push({ 
                isCurrentUser: isCurrent,
                username: data.username || `anonymous-${doc.id.substring(0, 6)}`,
                lifetimeTokens: data.lifetimeTokens || 0,
                lifetimeRequests: data.lifetimeRequests || 0,
                lastSyncTime: data.lastSyncTime || 0
            });
        });

        if (currentUserId && !currentUserInTop10) {
            const userDocRef = doc(db, 'users', currentUserId);
            const userDoc = await getDoc(userDocRef);
            if (userDoc.exists()) {
                const data = userDoc.data();
                list.push({ 
                    isCurrentUser: true,
                    username: data.username || `anonymous-${userDoc.id.substring(0, 6)}`,
                    lifetimeTokens: data.lifetimeTokens || 0,
                    lifetimeRequests: data.lifetimeRequests || 0,
                    lastSyncTime: data.lastSyncTime || 0
                });
            }
        }
        return list;
    } catch (err) {
        console.error('[Firebase] Failed to get leaderboard:', err);
        return [];
    }
}

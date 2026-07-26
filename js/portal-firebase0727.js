/**
 * CRE Portal - Firebase 설정
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getDatabase, ref, get, set, push, update, remove } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-database.js";
import { getStorage, ref as storageRef, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyDTEJnDQzgY6FQABVBcvNsKvwDLJkmj26s",
    authDomain: "cre-unified.firebaseapp.com",
    databaseURL: "https://cre-unified-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "cre-unified",
    storageBucket: "cre-unified.firebasestorage.app",
    messagingSenderId: "161207314802",
    appId: "1:161207314802:web:777e72ae0e190e73ebd5eb"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const storage = getStorage(app);

// Firebase 함수들 re-export
export { ref, get, set, push, update, remove };

// Storage 함수들 export
export { storageRef, getDownloadURL };

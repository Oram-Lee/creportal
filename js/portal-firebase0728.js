/**
 * CRE Portal - Firebase 설정 (REST 어댑터 버전)
 *
 * 사내망 URL 필터가 RTDB 샤드 호스트(s-gke-*.firebasedatabase.app)를 차단하여
 * WebSocket/롱폴링 연결이 불가한 문제 대응.
 * 네임스페이스 원본 호스트로만 통신하는 REST API로 전환한다.
 *
 * - export 시그니처는 기존과 100% 동일 → 호출부 수정 불필요
 * - getDatabase()를 호출하지 않으므로 wss:// 연결 자체가 발생하지 않음
 * - Storage는 별도 도메인(firebasestorage.googleapis.com)이므로 기존 SDK 유지
 * - 롤백: portal-firebase-sdk.js(원본 백업)를 이 파일 이름으로 되돌리면 됨
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
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

// Storage는 기존 그대로 (RTDB와 무관한 도메인)
export const storage = getStorage(app);
export { storageRef, getDownloadURL };

// ─────────────────────────────────────────────────────────────
// RTDB REST 어댑터
// ─────────────────────────────────────────────────────────────

export const db = { url: firebaseConfig.databaseURL };

/**
 * 인증 토큰 훅.
 * 현재 보안 규칙이 공개 상태라 토큰 없이 동작한다.
 * 추후 커스텀 토큰 인증 도입 시 이 함수만 교체하면 전체 경로에 적용된다.
 */
async function getToken() {
    return window.__creIdToken || null;
}

export function ref(dbObj, path = '') {
    const segs = String(path).split('/').filter(s => s !== '');
    return {
        _isRef: true,
        _db: dbObj || db,
        _segs: segs,
        key: segs.length ? segs[segs.length - 1] : null,
        toString() { return `${(dbObj || db).url}/${segs.join('/')}`; }
    };
}

async function request(r, method, body, silent) {
    if (!r || !r._isRef) throw new Error('[RTDB] 유효하지 않은 ref');

    const params = [];
    const token = await getToken();
    if (token) params.push('auth=' + encodeURIComponent(token));
    if (silent) params.push('print=silent');

    const path = r._segs.map(encodeURIComponent).join('/');
    const url = `${r._db.url}/${path}.json` + (params.length ? '?' + params.join('&') : '');

    const init = { method, cache: 'no-store' };
    if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`[RTDB ${method} /${r._segs.join('/')}] ${res.status} ${detail.slice(0, 200)}`);
    }
    if (silent || res.status === 204) return null;

    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

export async function get(r) {
    const value = await request(r, 'GET');
    return {
        key: r.key,
        val: () => value,
        exists: () => value !== null && value !== undefined
    };
}

export async function set(r, value) {
    await request(r, 'PUT', value === undefined ? null : value, true);
}

export async function update(r, values) {
    await request(r, 'PATCH', values, true);
}

export async function remove(r) {
    await request(r, 'DELETE', undefined, true);
}

// Firebase push ID 생성 (SDK와 동일 알고리즘 — 키 형식·시간순 정렬 보장)
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let lastPushTime = 0;
const lastRandChars = [];

function generatePushID() {
    let now = Date.now();
    const duplicateTime = (now === lastPushTime);
    lastPushTime = now;

    const timeChars = new Array(8);
    for (let i = 7; i >= 0; i--) {
        timeChars[i] = PUSH_CHARS.charAt(now % 64);
        now = Math.floor(now / 64);
    }
    let id = timeChars.join('');

    if (!duplicateTime) {
        for (let i = 0; i < 12; i++) lastRandChars[i] = Math.floor(Math.random() * 64);
    } else {
        let i = 11;
        for (; i >= 0 && lastRandChars[i] === 63; i--) lastRandChars[i] = 0;
        lastRandChars[i]++;
    }
    for (let i = 0; i < 12; i++) id += PUSH_CHARS.charAt(lastRandChars[i]);
    return id;
}

/**
 * push(ref)        → 키만 즉시 생성해 ref 반환 (동기, set()에 그대로 전달 가능)
 * push(ref, value) → 위와 동일하되 쓰기까지 수행하는 thenable 반환
 */
export function push(r, value) {
    const child = ref(r._db, [...r._segs, generatePushID()].join('/'));
    if (value === undefined) return child;

    // await 시 순환 참조를 피하기 위해 thenable이 아닌 사본으로 resolve
    const plain = { _isRef: true, _db: child._db, _segs: child._segs, key: child.key };
    const p = set(child, value).then(() => plain);
    child.then = p.then.bind(p);
    child.catch = p.catch.bind(p);
    child.finally = p.finally.bind(p);
    return child;
}

// 검증용 표식 (콘솔에서 어느 버전이 로드됐는지 확인)
window.__creDbMode = 'rest';
console.log('[portal-firebase] REST 어댑터 모드 —', db.url);

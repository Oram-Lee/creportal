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
import { getStorage, ref as storageRef, getDownloadURL, uploadString } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-storage.js";

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
export { storageRef, getDownloadURL, uploadString };

// ─────────────────────────────────────────────────────────────
// RTDB REST 어댑터
// ─────────────────────────────────────────────────────────────

export const db = { url: firebaseConfig.databaseURL };

// ─────────────────────────────────────────────────────────────
// ★ v4.2: 중량 필드 분리 계층
//
// buildings 레코드 안에 들어 있던 이미지·층별단가는 목록/지도에서 쓰이지 않으면서
// 노드 용량의 대부분을 차지한다. 이를 형제 노드로 옮겨 목록 조회에서 제외한다.
//
//   buildings/{id}/images…         → buildingImages/{id}/images…
//   buildings/{id}/exteriorImages… → buildingImages/{id}/exteriorImages…
//   buildings/{id}/floorPricing…   → buildingPricing/{id}/floorPricing…
//
// 호출부는 기존 경로를 그대로 쓰고, 여기서 실제 경로로 바꿔 보낸다.
// update() 본문에 중량 필드가 섞여 오는 경우도 여기서 분리해 각 노드로 나눠 보낸다.
// 따라서 26곳의 호출부를 수정할 필요가 없다.
// ─────────────────────────────────────────────────────────────

const HEAVY_FIELD_TARGET = {
    images: 'buildingImages',
    exteriorImages: 'buildingImages',
    exteriorImage: 'buildingImages',
    floorPlanImages: 'buildingImages',
    thumbnails: 'buildingImages',
    photos: 'buildingImages',
    floorPricing: 'buildingPricing'
};

export const HEAVY_NODES = ['buildingImages', 'buildingPricing'];

function heavyTargetOf(field) {
    return Object.prototype.hasOwnProperty.call(HEAVY_FIELD_TARGET, field)
        ? HEAVY_FIELD_TARGET[field]
        : null;
}

// buildings/{id}/{heavyField}/... → {target}/{id}/{heavyField}/...
function rewriteSegs(segs) {
    if (segs.length >= 3 && segs[0] === 'buildings') {
        const target = heavyTargetOf(segs[2]);
        if (target) return [target, segs[1], ...segs.slice(2)];
    }
    return segs;
}

// update/set 본문에서 중량 필드를 분리
function splitHeavyValues(values) {
    const main = {};
    const extra = {};
    let hasHeavy = false;
    for (const [k, v] of Object.entries(values || {})) {
        const target = heavyTargetOf(k);
        if (target) {
            if (!extra[target]) extra[target] = {};
            extra[target][k] = v;
            hasHeavy = true;
        } else {
            main[k] = v;
        }
    }
    return { main, extra, hasHeavy };
}

/**
 * 인증 토큰 훅.
 * 현재 보안 규칙이 공개 상태라 토큰 없이 동작한다.
 * 추후 커스텀 토큰 인증 도입 시 이 함수만 교체하면 전체 경로에 적용된다.
 */
async function getToken() {
    return window.__creIdToken || null;
}

export function ref(dbObj, path = '') {
    const raw = String(path).split('/').filter(s => s !== '');
    const segs = rewriteSegs(raw);
    return {
        _isRef: true,
        _db: dbObj || db,
        _segs: segs,
        _rawSegs: raw,   // 재작성 전 경로 (본문 분리 판정용)
        key: segs.length ? segs[segs.length - 1] : null,
        toString() { return `${(dbObj || db).url}/${segs.join('/')}`; }
    };
}

async function request(r, method, body, silent, extraParams) {
    if (!r || !r._isRef) throw new Error('[RTDB] 유효하지 않은 ref');

    const params = [];
    const token = await getToken();
    if (token) params.push('auth=' + encodeURIComponent(token));
    if (silent) params.push('print=silent');
    if (extraParams && extraParams.length) params.push(...extraParams);

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

/**
 * SDK DataSnapshot 호환 스냅샷 생성 (재귀).
 * portal-auth.js의 usersSnap.forEach 등 SDK API를 그대로 지원한다.
 * - forEach: 자식 스냅샷을 키 순서대로 순회, 콜백이 true 반환 시 중단 (SDK 동일)
 * - child(path): 하위 경로 스냅샷 반환 ('a/b/c' 형태 지원)
 * - hasChild / hasChildren / numChildren / size / toJSON 지원
 * - RTDB가 정수 키를 배열로 반환하는 경우도 처리
 */
function makeSnapshot(key, value) {
    const childEntries = () => {
        if (value === null || value === undefined || typeof value !== 'object') return [];
        return Array.isArray(value)
            ? value.map((v, i) => [String(i), v]).filter(([, v]) => v !== null && v !== undefined)
            : Object.entries(value).filter(([, v]) => v !== null && v !== undefined);
    };
    return {
        key,
        val: () => (value === undefined ? null : value),
        exists: () => value !== null && value !== undefined,
        toJSON: () => (value === undefined ? null : value),
        forEach: (action) => {
            for (const [k, v] of childEntries()) {
                if (action(makeSnapshot(k, v)) === true) return true;
            }
            return false;
        },
        child: (path) => {
            const segs = String(path).split('/').filter(s => s !== '');
            let cur = value;
            for (const s of segs) {
                cur = (cur !== null && cur !== undefined && typeof cur === 'object') ? cur[s] : undefined;
            }
            return makeSnapshot(segs.length ? segs[segs.length - 1] : key, cur === undefined ? null : cur);
        },
        hasChild: (path) => {
            const segs = String(path).split('/').filter(s => s !== '');
            let cur = value;
            for (const s of segs) {
                if (cur === null || cur === undefined || typeof cur !== 'object') return false;
                cur = cur[s];
            }
            return cur !== null && cur !== undefined;
        },
        hasChildren: () => childEntries().length > 0,
        numChildren: () => childEntries().length,
        get size() { return childEntries().length; }
    };
}

export async function get(r) {
    const value = await request(r, 'GET');
    return makeSnapshot(r.key, value);
}

/**
 * shallow 조회 — 하위 트리를 내려받지 않고 한 단계만 확인한다.
 *
 * RTDB REST의 ?shallow=true 응답 규약
 *   - 자식이 객체/배열인 필드 → 값 대신 true
 *   - 자식이 스칼라(문자열·숫자·불린)인 필드 → 값 그대로
 *
 * 대용량 노드에서 "키 목록"과 "스칼라 메타"만 필요한 경우에 사용한다.
 * 반환은 get()과 동일한 스냅샷 형태.
 */
export async function getShallow(r) {
    const value = await request(r, 'GET', undefined, false, ['shallow=true']);
    return makeSnapshot(r.key, value);
}

export async function set(r, value) {
    // buildings/{id} 통째 쓰기에 중량 필드가 섞인 경우 분리
    if (r._rawSegs && r._rawSegs.length === 2 && r._rawSegs[0] === 'buildings'
        && value && typeof value === 'object' && !Array.isArray(value)) {
        const { main, extra, hasHeavy } = splitHeavyValues(value);
        if (hasHeavy) {
            const id = r._rawSegs[1];
            await Promise.all([
                request(r, 'PUT', main, true),
                ...Object.entries(extra).map(([node, vals]) =>
                    request(ref(r._db, `${node}/${id}`), 'PATCH', vals, true))
            ]);
            return;
        }
    }
    await request(r, 'PUT', value === undefined ? null : value, true);
}

export async function update(r, values) {
    if (r._rawSegs && r._rawSegs.length === 2 && r._rawSegs[0] === 'buildings'
        && values && typeof values === 'object') {
        const { main, extra, hasHeavy } = splitHeavyValues(values);
        if (hasHeavy) {
            const id = r._rawSegs[1];
            const jobs = Object.entries(extra).map(([node, vals]) =>
                request(ref(r._db, `${node}/${id}`), 'PATCH', vals, true));
            if (Object.keys(main).length) jobs.push(request(r, 'PATCH', main, true));
            await Promise.all(jobs);
            return;
        }
    }
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
window.__creDbRev = '260906b';
console.log('[portal-firebase] REST 어댑터 모드 rev 260906b (중량필드 분리) —', db.url);

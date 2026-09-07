/**
 * CRE Portal - 상세 패널 모듈
 * 빌딩 상세 정보 패널 렌더링
 * 
 * v3.6: 층 표기 정규화 함수 추가 (FF 중복 방지)
 * v3.10: 담당자 수정/삭제 기능 연동 (portal.html의 전역 함수 사용)
 * v3.12: 공실 이관 후 새로고침 개선 (대상 빌딩 로컬 상태 업데이트, 빈 공실 시 신규입력 UI)
 * v3.13: 공실없음(만실) 처리 - _meta.noVacancy 플래그로 만실 구분, 원문보기 지원
 * v3.14: 공실없음 표시 개선 + 이관 시 기준가 매칭 로직 수정 (sourceCompany/effectiveDate 정규화)
 */

import { state } from './portal-state.js';
import { formatNumber, showToast } from './portal-utils.js';
import { panToBuilding } from './portal-map.js';
import { toggleStar } from './portal-ui.js';
import { db, ref, update, remove, set, get, push } from './portal-firebase.js';
import { processBuildings } from './portal-data.js'; // ★ Bug2 fix: 새로고침 시 안내문 병합 보존용

// ★ v3.10: state를 전역으로 노출 (portal.html의 담당자 CRUD 함수에서 사용)
window.state = state;

// ★ v3.6: 층 표기 정규화 함수 (FF 중복 방지)
function formatFloorDisplay(floor) {
    if (!floor || floor === '-') return '-';
    
    let str = String(floor).trim().toUpperCase();
    
    // 이미 정규화된 형식인지 확인
    // "B1", "B2" 등 지하층 형식
    if (/^B\d+$/.test(str)) return str;
    
    // "12F", "3F" 등 이미 F가 붙은 형식 → 그대로 반환 (FF 방지)
    if (/^\d+F$/.test(str)) return str;
    
    // "B1F" → "B1" (지하층에 F가 붙은 경우 제거)
    if (/^B\d+F$/.test(str)) return str.replace('F', '');
    
    // "12층", "3층" 등 한글 층 → "12F", "3F"
    if (/^\d+층$/.test(str)) return str.replace('층', 'F');
    
    // "지하1층", "지하2층" → "B1", "B2"
    const basementMatch = str.match(/지하\s*(\d+)\s*층?/);
    if (basementMatch) return 'B' + basementMatch[1];
    
    // 숫자만 있는 경우 → "12F"
    if (/^\d+$/.test(str)) return str + 'F';
    
    // 그 외의 경우 그대로 반환
    return str;
}

// ===== ★ v2.0: 소숫점 표기 토글 =====
// 기본값: 소숫점 숨김 (정수 표시)
if (typeof state.showDecimalArea === 'undefined') {
    state.showDecimalArea = false;
}
if (typeof state.showWeightedAvg === 'undefined') {
    state.showWeightedAvg = false;
}

// ===== ★ v3.11: 공실 리스트 정렬 상태 =====
// 기본값: 오름차순 (asc), 내림차순 (desc)
if (typeof state.vacancySortOrder === 'undefined') {
    state.vacancySortOrder = 'asc';
}
// 정렬 기준 컬럼 (floor/tower/rentArea/exclusiveArea/depositPy/rentPy/maintenancePy/moveInDate)
if (typeof state.vacancySortColumn === 'undefined') {
    state.vacancySortColumn = 'floor';
}

// ★ Sprint3-NEW2: 주차정보 포맷 함수
function formatParkingDisplay(b) {
    // 건축물대장 데이터 우선
    if (b.parking?.total) {
        let display = b.parking.total + '대';
        if (b.parking.ratio) display += ` (${b.parking.ratio})`;
        return display;
    }
    // OCR 추출 데이터
    if (b.parkingTotal) {
        let parts = [b.parkingTotal + '대'];
        if (b.parkingFree) parts.push(`무료 ${b.parkingFree}`);
        if (b.parkingPaid) parts.push(`유료 ${b.parkingPaid}`);
        if (b.parkingNote) parts.push(b.parkingNote);
        return parts.length > 1 ? `${b.parkingTotal}대 (${parts.slice(1).join(', ')})` : parts[0];
    }
    if (b.parking?.display) return b.parking.display;
    // 무료/유료만 있는 경우
    if (b.parkingFree || b.parkingPaid) {
        const parts = [];
        if (b.parkingFree) parts.push(`무료 ${b.parkingFree}`);
        if (b.parkingPaid) parts.push(`유료 ${b.parkingPaid}`);
        return parts.join(', ');
    }
    return '-';
}

// ★ S2: 빌딩 데이터 출처 판정 (저장된 source 필드 + 신호로 확정, 복수 가능)
function deriveBuildingOrigins(b) {
    const raw = b._raw || {};
    const src = raw.source ?? b.source ?? '';
    const tags = [];
    if (src === 'OCR') tags.push('ocr');
    else if (src === 'admin-research') tags.push('research');
    else if (!src) {
        // source 없음: 앱 생성(createdAt 있음) vs 구 시스템 마이그레이션(표식 없음)
        if (raw.createdAt || raw.createdBy) tags.push('manual');
        else tags.push('legacy');
    } else tags.push('other');
    // 보강 출처 (중첩 가능 — 예: 구 시스템 + 대장 보강)
    if (Object.keys(b.buildingInfo || raw.buildingInfo || {}).length > 0) tags.push('ledger');
    if (b.leasingGuideInfo) tags.push('guide');
    return tags;
}

const _ORIGIN_META = {
    legacy:   { label: '🗄️ 구 시스템', bg: '#f1f5f9', fg: '#475569', bd: '#cbd5e1' },
    ocr:      { label: '📷 OCR',        bg: '#fff7ed', fg: '#c2410c', bd: '#fdba74' },
    research: { label: '🔬 리서치',     bg: '#eff6ff', fg: '#1d4ed8', bd: '#bfdbfe' },
    ledger:   { label: '🏛️ 대장',       bg: '#ecfdf5', fg: '#047857', bd: '#6ee7b7' },
    guide:    { label: '📄 안내문',     bg: '#fefce8', fg: '#a16207', bd: '#fde68a' },
    manual:   { label: '✍️ 직접입력',   bg: '#f5f3ff', fg: '#6d28d9', bd: '#ddd6fe' },
    other:    { label: '❔ 기타',        bg: '#f1f5f9', fg: '#64748b', bd: '#cbd5e1' },
};

function renderOriginBadges(b) {
    const tags = deriveBuildingOrigins(b);
    if (!tags.length) return '';
    const chips = tags.map(t => {
        const m = _ORIGIN_META[t] || _ORIGIN_META.other;
        return `<span style="background:${m.bg};color:${m.fg};border:1px solid ${m.bd};border-radius:5px;padding:2px 8px;font-size:11px;font-weight:700;white-space:nowrap;">${m.label}</span>`;
    }).join('');
    return `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px;padding:8px 10px;background:#fafafa;border:1px solid #e5e7eb;border-radius:8px;">
            <span style="font-size:11px;color:#94a3b8;font-weight:600;">데이터 출처</span>${chips}
        </div>`;
}

// ★ S2: 주차 구성(자주/기계/혼합) — parking 객체 또는 건축물대장 숫자에서
function formatParkingComposition(b) {
    const bi = b.buildingInfo || (b._raw && b._raw.buildingInfo) || {};
    const self = parseInt(b.parking?.selfPark ?? bi.indrAutoUtcnt ?? 0, 10) || 0;
    const mech = parseInt(b.parking?.mechanical ?? bi.indrMechUtcnt ?? 0, 10) || 0;
    if (!self && !mech) return '';
    const parts = [];
    if (self) parts.push(`자주식 ${self.toLocaleString()}대`);
    if (mech) parts.push(`기계식 ${mech.toLocaleString()}대`);
    const kind = (self && mech) ? ' (혼합)' : '';
    return ` <span style="color:#64748b;font-size:11px;">· ${parts.join(' · ')}${kind}</span>`;
}

/**
 * 면적 포맷 (소숫점 토글 반영)
 * @param {number|string} value - 면적 값
 * @param {boolean} forceDecimal - 강제 소숫점 표시 (편집 모드용)
 * @returns {string} - 포맷된 문자열
 */
function formatArea(value, forceDecimal = false) {
    if (!value && value !== 0) return '-';
    const num = parseFloat(String(value).replace(/,/g, ''));
    if (isNaN(num)) return '-';
    
    // 강제 소숫점 또는 토글 ON인 경우 소숫점 2자리까지
    if (forceDecimal || state.showDecimalArea) {
        return num.toFixed(2) + '평';
    }
    // 토글 OFF인 경우 정수로 표시
    return Math.round(num).toLocaleString() + '평';
}

/**
 * 금액(보증금/임대료/관리비) 표시용 포맷.
 * OCR/수기 입력값이 "1,010,000"처럼 콤마 포함 문자열로 저장될 수 있어
 * formatNumber로는 NaN이 된다 → 콤마/공백 제거 후 숫자로 파싱하여 천단위 콤마로 재포맷.
 * 숫자가 아니면(예: "협의") 원문 유지, 빈 값이면 '-'.
 */
function formatMoney(value) {
    if (value === undefined || value === null || value === '') return '-';
    const num = parseFloat(String(value).replace(/[, ]/g, ''));
    if (isNaN(num)) return String(value);
    return num.toLocaleString('en-US');
}

/**
 * 숫자 입력칸용 천단위 콤마 포맷 (소수점 허용). 순수 문자열 변환 — prefill/라이브 공용.
 *  "520000" → "520,000", "2119.45" → "2,119.45", "" → ""
 */
function commaFormat(raw) {
    let s = String(raw == null ? '' : raw).replace(/[^\d.]/g, '');
    const firstDot = s.indexOf('.');
    let intPart, decPart;
    if (firstDot === -1) { intPart = s; decPart = ''; }
    else {
        intPart = s.slice(0, firstDot);
        decPart = '.' + s.slice(firstDot + 1).replace(/\./g, ''); // 두 번째 점 이후 제거
    }
    intPart = intPart.replace(/^0+(?=\d)/, ''); // 선행 0 제거
    const intF = intPart ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart;
    return (intF || (decPart ? '0' : '')) + decPart;
}

/**
 * 숫자 입력칸 oninput 핸들러 — 입력 즉시 콤마 적용 + 커서 위치 보존.
 *  사용: <input type="text" inputmode="decimal" oninput="formatNumberInputLive(this)">
 */
function formatNumberInputLive(el) {
    if (!el) return;
    const old = el.value;
    const sel = (el.selectionStart != null) ? el.selectionStart : old.length;
    const digitsBefore = old.slice(0, sel).replace(/[^\d]/g, '').length; // 커서 앞 숫자 개수
    const formatted = commaFormat(old);
    if (formatted === old) return;
    el.value = formatted;
    if (digitsBefore <= 0) { try { el.setSelectionRange(0, 0); } catch (e) {} return; }
    let pos = formatted.length, cnt = 0;
    for (let i = 0; i < formatted.length; i++) {
        if (/\d/.test(formatted[i])) cnt++;
        if (cnt >= digitsBefore) { pos = i + 1; break; }
    }
    try { el.setSelectionRange(pos, pos); } catch (e) {}
}

/**
 * 단위가 섞인 자유 텍스트(예: "12500000원/㎡", "500억원")에서
 * 선행 숫자부에만 천단위 콤마를 적용하고 단위는 그대로 둔다. (blur 시 호출)
 */
function formatBondNumberOnBlur(el) {
    if (!el) return;
    const raw = el.value || '';
    const m = raw.match(/^(\s*)([\d,]+(?:\.\d+)?)(.*)$/);
    if (!m) return;
    const cleanNum = m[2].replace(/,/g, '');
    if (!cleanNum || cleanNum === '.') return;
    const [intP, decP] = cleanNum.split('.');
    if (!intP) return;
    const intF = intP.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    el.value = m[1] + (decP !== undefined ? intF + '.' + decP : intF) + m[3];
}

/**
 * 소숫점 표기 토글
 */
export function toggleDecimalArea() {
    state.showDecimalArea = !state.showDecimalArea;
    
    // 공실 테이블 다시 렌더링
    if (state.selectedBuilding) {
        renderDocumentSection();
    }
    
    showToast(state.showDecimalArea ? '소숫점 표기 ON' : '소숫점 표기 OFF', 'info');
}

/**
 * ★ v3.11: 층 문자열을 숫자로 파싱 (정렬용)
 * "10F" → 10, "B1" → -1, "B2F" → -2, "지하3층" → -3
 */
function parseFloorNumber(floorStr) {
    if (!floorStr || floorStr === '-') return 999; // 정보 없으면 맨 뒤로
    
    const str = String(floorStr).trim().toUpperCase();
    
    // 지하층: B1, B2, B1F, B2F, 지하1층, 지하2 등
    const basementMatch = str.match(/^B(\d+)F?$/) || str.match(/지하\s*(\d+)/);
    if (basementMatch) {
        return -parseInt(basementMatch[1], 10);
    }
    
    // 지상층: 10F, 10층, 10 등
    const floorMatch = str.match(/^(\d+)F?층?$/);
    if (floorMatch) {
        return parseInt(floorMatch[1], 10);
    }
    
    // 숫자만 추출 시도
    const numOnly = str.replace(/[^\d-]/g, '');
    if (numOnly) {
        return parseInt(numOnly, 10);
    }
    
    return 998; // 파싱 실패 시 거의 맨 뒤로
}

/**
 * ★ v3.11: 공실 리스트 정렬 토글 (오름차순 ↔ 내림차순)
 */
export function toggleVacancySortOrder() {
    // 하위 호환: 층 기준 정렬 토글
    setVacancySort('floor');
}

// ★ 컬럼 클릭 정렬: 같은 컬럼이면 asc↔desc 토글, 다른 컬럼이면 그 컬럼 asc로 시작
export function setVacancySort(col) {
    if (state.vacancySortColumn === col) {
        state.vacancySortOrder = state.vacancySortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        state.vacancySortColumn = col;
        state.vacancySortOrder = 'asc';
    }
    if (state.selectedBuilding) {
        renderDocumentSection();
    }
}

// 컬럼별 정렬 비교값 (숫자 컬럼은 콤마 제거 후 숫자, 그 외는 문자열)
function vacancySortValue(v, col) {
    switch (col) {
        case 'floor': return parseFloorNumber(v.floor);
        case 'tower': return String(v.tower || '').toLowerCase();
        case 'rentArea': return parseFloat(String(v.rentArea ?? '').replace(/[, ]/g, '')) || 0;
        case 'exclusiveArea': return parseFloat(String(v.exclusiveArea ?? '').replace(/[, ]/g, '')) || 0;
        case 'depositPy': return parseFloat(String(v.depositPy ?? '').replace(/[, ]/g, '')) || 0;
        case 'rentPy': return parseFloat(String(v.rentPy ?? '').replace(/[, ]/g, '')) || 0;
        case 'maintenancePy': return parseFloat(String(v.maintenancePy ?? '').replace(/[, ]/g, '')) || 0;
        case 'moveInDate': return String(v.moveInDate || '');
        default: return parseFloorNumber(v.floor);
    }
}

// 헤더 정렬 화살표 (활성 컬럼에만 표시)
function vacancySortArrow(col) {
    if (state.vacancySortColumn !== col) return '';
    return state.vacancySortOrder === 'asc'
        ? ' <span style="font-size:10px; opacity:0.8;">↑</span>'
        : ' <span style="font-size:10px; opacity:0.8;">↓</span>';
}

// 전역으로 노출 (onclick에서 사용)
window.toggleVacancySortOrder = toggleVacancySortOrder;
window.setVacancySort = setVacancySort;

// ===== 단위 변환 헬퍼 함수 (마이그레이션 호환) =====
/**
 * 가격 값을 원 단위로 정규화
 * - 마이그레이션 후 데이터: 이미 원 단위 (예: 119500)
 * - 기존/OCR 데이터: 만원 단위일 수 있음 (예: 11.95)
 */
function toWon(value) {
    const num = parseFloat(String(value || '').replace(/[^\d.]/g, '')) || 0;
    if (num === 0) return 0;
    // 1000 미만이면 만원 단위로 간주 (×10000)
    return num < 1000 ? num * 10000 : num;
}

// ===== 상세 패널 열기/닫기 =====

// ============================================================
// ★ v4.2: 중량 필드 지연 로드
//
// 이미지와 층별단가는 buildings 레코드에서 분리되어 형제 노드에 있다.
// 목록·지도는 이 값을 쓰지 않으므로 초기 로드에서 제외되고,
// 상세를 여는 시점에 해당 빌딩 것만 가져온다.
//
// 상세 패널은 기다리지 않고 즉시 뜬다. 값이 도착하면 다시 그린다.
// ============================================================

function _normalizeImageList(arr) {
    return (arr || []).map(img => (typeof img === 'string' ? { url: img } : img));
}

/**
 * 중량 필드(이미지·기준가)가 아직 도착하지 않은 상태인지 판정.
 *
 * 새로고침 직후에는 processBuildings()가 빌딩 객체를 새로 만들면서
 * 이미지·기준가가 빈 상태가 된다. 상세를 열면 hydrateBuildingHeavy()가
 * 받아오지만 렌더가 먼저 일어나므로, 이 구간에 "없음"이 아니라
 * "불러오는 중"을 보여줘야 한다.
 */
export function isHeavyPending(b) {
    return !!b && !b._heavyLoaded;
}

// 로딩 자리표시자 (portal.html CSS에 의존하지 않도록 인라인 스타일 사용)
function _heavyLoadingBlock(label) {
    return `
        <div class="image-empty-area heavy-loading" style="cursor:default;">
            <div class="empty-icon" style="animation:creSpin 1s linear infinite;display:inline-block;">⏳</div>
            <div class="empty-text">${label} 불러오는 중…</div>
        </div>
        <style>@keyframes creSpin{to{transform:rotate(360deg)}}</style>
    `;
}

async function hydrateBuildingHeavy(b) {
    if (b._heavyLoaded || b._heavyLoading) return false;
    b._heavyLoading = true;
    try {        const [imgSnap, prcSnap] = await Promise.all([
            get(ref(db, `buildingImages/${b.id}`)),
            get(ref(db, `buildingPricing/${b.id}`))
        ]);
        const img = imgSnap.val() || {};
        const prc = prcSnap.val() || {};

        b.images = img.images || b.images ||
            { exterior: [], floorPlan: [], lobby: [], facilities: [], etc: [] };
        b.exteriorImages = _normalizeImageList(
            img.exteriorImages || img.images?.exterior || b.exteriorImages
        );
        b.floorPlanImages = _normalizeImageList(
            img.floorPlanImages || img.images?.floorPlan || b.floorPlanImages
        );
        if (img.exteriorImage) b.exteriorImage = img.exteriorImage;
        if (Array.isArray(prc.floorPricing)) b.floorPricing = prc.floorPricing;

        b._heavyLoaded = true;
        return true;
    } catch (e) {
        console.warn(`[buildingHeavy/${b.id}] 지연 로드 실패 — 기존 값으로 표시`, e);
        return false;
    } finally {
        b._heavyLoading = false;
    }
}

// ============================================================
// ★ v4.5: 기준층 면적 필드 해석 일원화
//
// 필드 의미 규약 (portal-detail.js 편집 모달 및 admin-research 와 동일)
//   기준층 임대면적 : typicalFloorPy
//                     alias — typicalFloorLeasePy, typicalFloorRent
//   기준층 전용면적 : exclusiveFloorPy
//                     alias — typicalFloorExclusive
//   전용률          : exclusiveRate (%)
//
// 과거에 '기준층 전용' 표시가 값이 없을 때 typicalFloorPy 로 폴백했는데,
// 이 필드는 임대면적이므로 전용 자리에 임대값이 그대로 찍혔다.
// 그 상태에서 빌딩정보수정으로 전용면적을 넣어도 표시가 임대값을 먼저 읽어
// 계속 같은 값이 보였다. 아래 헬퍼로 두 값을 분리해 해석한다.
// ============================================================

function _areaNum(...cands) {
    for (const v of cands) {
        if (v === null || v === undefined || v === '') continue;
        const n = parseFloat(String(v).replace(/,/g, ''));
        if (!isNaN(n) && n > 0) return n;
    }
    return null;
}

/** 기준층 임대면적 */
export function resolveLeaseFloorPy(b) {
    if (!b) return null;
    const r = b._raw || {};
    return _areaNum(
        b.typicalFloorRent, b.area?.typicalFloorRent,
        b.typicalFloorLeasePy, b.area?.typicalFloorLeasePy,
        b.typicalFloorPy, b.area?.typicalFloorPy,
        r.typicalFloorLeasePy, r.area?.typicalFloorLeasePy,
        r.typicalFloorPy, r.area?.typicalFloorPy
    );
}

/** 기준층 전용면적. 저장값이 없으면 임대면적 × 전용률로 계산한다. */
export function resolveExclusiveFloorPy(b) {
    if (!b) return null;
    const r = b._raw || {};
    const stored = _areaNum(
        b.typicalFloorExclusive, b.area?.typicalFloorExclusive,
        b.exclusiveFloorPy, b.area?.exclusiveFloorPy,
        r.exclusiveFloorPy, r.area?.exclusiveFloorPy
    );
    if (stored != null) return stored;

    const lease = resolveLeaseFloorPy(b);
    const rate = _areaNum(b.exclusiveRate, b.area?.exclusiveRate, r.exclusiveRate, r.area?.exclusiveRate);
    if (lease != null && rate != null) return Math.round(lease * rate / 100 * 100) / 100;
    return null;
}

/** 전용률(%). 두 면적이 모두 있으면 계산값, 아니면 저장된 전용률. */
export function resolveExclusiveRate(b) {
    if (!b) return null;
    const r = b._raw || {};
    const stored = _areaNum(b.exclusiveRate, b.area?.exclusiveRate, r.exclusiveRate, r.area?.exclusiveRate);
    const lease = resolveLeaseFloorPy(b);
    const exc = _areaNum(
        b.typicalFloorExclusive, b.area?.typicalFloorExclusive,
        b.exclusiveFloorPy, b.area?.exclusiveFloorPy,
        r.exclusiveFloorPy, r.area?.exclusiveFloorPy
    );
    if (lease != null && exc != null) return Math.round(exc / lease * 1000) / 10;
    return stored;
}

export function openDetail(id) {
    const target = state.allBuildings.find(b => b.id === id);
    // 아직 중량 필드를 안 받았으면 백그라운드로 받아온 뒤 한 번 더 그린다
    if (target && !target._heavyLoaded && !target._heavyLoading) {
        hydrateBuildingHeavy(target).then(changed => {
            if (changed && state.selectedBuilding && state.selectedBuilding.id === id) {
                _openDetailInternal(id);
            }
        });
    }

    return _openDetailInternal(id);
}

/**
 * 중량 필드 캐시를 무효화한다.
 * 이미지·기준가를 저장한 뒤 호출하면 다음에 상세를 열 때 새로 받아온다.
 * id 생략 시 현재 선택된 빌딩이 대상.
 */
export function invalidateBuildingHeavy(id) {    const bid = id || state.selectedBuilding?.id;
    if (!bid) return;
    const b = state.allBuildings.find(x => x.id === bid);
    if (b) b._heavyLoaded = false;
}
window.invalidateBuildingHeavy = invalidateBuildingHeavy;

/**
 * 기준가·이미지를 조작하기 전에 중량 필드가 도착했는지 보장한다. *
 * processBuildings()가 빌딩 객체를 다시 만들면 중량 필드가 비므로,
 * 그 직후에 기준가 버튼을 누르면 findIndex 가 -1 이 되어 실패한다.
 * portal-data.js 의 이월 처리로 대부분 방지되지만, 어떤 경로로든
 * 비어 있는 상태로 들어오면 여기서 한 번 더 받아온다.
 */
async function ensureHeavyLoaded(b) {
    if (!b || b._heavyLoaded) return;
    if (b._heavyLoading) {
        // 진행 중이면 끝날 때까지 짧게 대기 (최대 약 3초)
        for (let i = 0; i < 30 && b._heavyLoading; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        return;
    }
    await hydrateBuildingHeavy(b);
}

// ============================================================
// ★ v4.4: 이미지 저장 경로 일원화
//
// 외관·평면도 이미지는 역사적으로 두 곳에 저장되어 왔다.
//   buildings/{id}/images/exterior   (중첩)
//   buildings/{id}/exteriorImages    (최상위)
// 실측 기준 최상위만 50건, 중첩만 68건, 둘 다 가진 것이 10건이다.
//
// 표시는 최상위를 우선하는데 추가·삭제는 중첩만 갱신해 왔다.
// 그래서 둘 다 가진 빌딩에서는 지워도 다시 나타나고, 추가해도 반영이 어긋났다.
// 아래 헬퍼로 읽기와 쓰기를 한 곳으로 모은다.
// ============================================================

const IMG_FIELD = {
    exterior:  { nested: 'exterior',  top: 'exteriorImages' },
    floorPlan: { nested: 'floorPlan', top: 'floorPlanImages' }
};

/** 화면에 실제로 쓰이는 이미지 목록을 URL 문자열 배열로 돌려준다. */
function getImageUrls(b, kind) {
    const f = IMG_FIELD[kind];
    const src = (Array.isArray(b[f.top]) && b[f.top].length)
        ? b[f.top]
        : (b.images?.[f.nested] || []);
    return src.map(img => (img && typeof img === 'object' && 'url' in img) ? img.url : img)
              .filter(Boolean);
}

/**
 * 이미지 목록을 두 경로에 함께 기록하고 로컬 상태도 맞춘다.
 *
 * 두 경로를 모두 유지하는 이유:
 *   최상위 exteriorImages — 상단 '빌딩 이미지' 패널(구분 태그 보관)
 *   중첩 images.exterior  — 임대안내문 출력(leasing-guide-print), 컴프리스트
 * 두 소비처가 서로 다른 필드만 읽으므로 한쪽만 남길 수 없다.
 * 같은 이미지가 두 번 저장되지만, 이 노드는 상세를 열 때만 조회되므로
 * 목록·지도 트래픽에는 영향이 없다.
 */
async function persistImageUrls(b, kind, urls) {
    const f = IMG_FIELD[kind];

    // 상단 패널이 붙여 둔 부가 정보(usage 구분 등)를 URL 기준으로 보존한다
    const metaByUrl = new Map();
    for (const img of (b[f.top] || [])) {
        if (img && typeof img === 'object' && img.url) metaByUrl.set(img.url, img);
    }
    const topList = urls.map(u => metaByUrl.get(u) || { url: u });

    // 두 경로를 항상 함께 기록한다. 한쪽만 갱신하면 다른 쪽에 남은 옛 값이
    // 되살아나거나(삭제 후 재등장) 목록이 어긋난다.
    await update(ref(db, `buildings/${b.id}/images`), { [f.nested]: urls });
    await update(ref(db, `buildings/${b.id}`), { [f.top]: topList });

    if (!b.images) b.images = {};
    b.images[f.nested] = urls;
    b[f.top] = topList;
}

function _openDetailInternal(id) {
    state.selectedBuilding = state.allBuildings.find(b => b.id === id);
    if (!state.selectedBuilding) return;
    
    // 필터 상태 초기화 (새 빌딩 열 때마다)
    state.selectedRentrollDate = null; // 최신 월로 자동 선택되도록
    state.selectedPricingDate = 'all'; // ★ 기준가 필터 초기화
    state.selectedDocSource = 'all';
    state.selectedDocPeriod = 'all';
    
    // 공실 선택 상태 초기화
    state.selectedVacancyIds = new Set();
    state.currentDisplayedVacancies = [];
    
    const b = state.selectedBuilding;
    
    // ★ v4.2: memos 배열 null 필터링 (Firebase에서 null 항목 유입 방지)
    if (b.memos) {
        b.memos = b.memos.filter(m => m != null && typeof m === 'object');
    }
    
    document.getElementById('detailTitle').textContent = b.name || '이름 없음';
    document.getElementById('detailSubtitle').textContent = b.address || '-';
    document.getElementById('rentrollCount').textContent = b.rentrollCount || 0;
    // ★ v4.2: null 필터링 후 카운트
    document.getElementById('memoCount').textContent = (b.memos || []).length;
    document.getElementById('documentCount').textContent = (b.documents || []).length;
    document.getElementById('pricingCount').textContent =
        (isHeavyPending(b) && !(b.floorPricing || []).length) ? '…' : (b.floorPricing || []).length;
    document.getElementById('contactCount').textContent = (b.contactPoints || []).length;
    
    // 즐겨찾기 별 상태 업데이트
    updateDetailStarBtn();
    
    // 삭제/복원 버튼 상태 업데이트
    updateDeleteButtons();
    
    renderInfoSection();
    renderPricingSection();
    renderRentrollSection();
    renderMemoSection();
    renderIncentiveSection();
    renderDocumentSection();
    renderContactSection();
    renderStatsSection();
    
    document.getElementById('detailOverlay').classList.add('show');
    document.getElementById('detailPanel').classList.add('open');
    
    // 리스트/테이블 선택 상태 업데이트
    document.querySelectorAll('.list-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
    document.querySelectorAll('.data-grid tbody tr').forEach(el => el.classList.remove('selected'));
    
    if (state.currentViewMode === 'map') panToBuilding(state.selectedBuilding);
}

export function closeDetail() {
    document.getElementById('detailOverlay').classList.remove('show');
    document.getElementById('detailPanel').classList.remove('open');
    state.selectedBuilding = null;
}

// 상세 패널 별 버튼 상태 업데이트
export function updateDetailStarBtn() {
    const btn = document.getElementById('detailStarBtn');
    if (!btn || !state.selectedBuilding) return;
    const isStarred = state.starredBuildings.has(state.selectedBuilding.id);
    btn.textContent = isStarred ? '★' : '☆';
    btn.classList.toggle('starred', isStarred);
}

// 상세 패널에서 즐겨찾기 토글
export function toggleDetailStar() {
    if (!state.selectedBuilding) return;
    toggleStar(state.selectedBuilding.id);
    updateDetailStarBtn();
}

// 삭제/숨기기/복원 버튼 상태 업데이트
export function updateDeleteButtons() {
    const b = state.selectedBuilding;
    if (!b) return;
    
    const hideBtn = document.getElementById('detailHideBtn');
    const deleteBtn = document.getElementById('detailDeleteBtn');
    const restoreBtn = document.getElementById('detailRestoreBtn');
    
    const isHidden = b.isHidden || b._raw?.isHidden || b.status === 'hidden';
    
    // 관리자 여부 확인
    const adminEmails = ['admin@snimgt.com', 'system@snimgt.com', 'oramlee@sni.co.kr'];
    const isAdminUser = adminEmails.includes(state.currentUser?.email);
    
    if (hideBtn) {
        // 숨기기 버튼: 숨겨지지 않은 빌딩에서만 표시
        hideBtn.style.display = isHidden ? 'none' : 'inline-flex';
    }
    
    if (deleteBtn) {
        // 완전삭제 버튼: 관리자이고 숨겨지지 않은 빌딩에서만 표시
        deleteBtn.style.display = (isAdminUser && !isHidden) ? 'inline-flex' : 'none';
    }
    
    if (restoreBtn) {
        // 복원 버튼: 숨겨진 빌딩에서만 표시
        restoreBtn.style.display = isHidden ? 'inline-flex' : 'none';
    }
}

// ===== 기본 정보 섹션 =====

export function renderInfoSection() {
    const b = state.selectedBuilding;
    // ★ 마이그레이션 호환: toWon()으로 원 단위 정규화, * 10000 제거
    // F-NOC = (임대료 + 관리비) ÷ 전용률 — 셋 중 하나라도 누락되면 계산하지 않음
    const _fnocPresent = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    const _fnocEffRaw = parseFloat(String(b.exclusiveRate ?? '').replace(/[^\d.]/g, ''));
    const _fnocMissing = [];
    if (!_fnocPresent(b.rentPy)) _fnocMissing.push('임대료');
    if (!_fnocPresent(b.maintenancePy)) _fnocMissing.push('관리비');
    if (!_fnocPresent(b.exclusiveRate) || !(_fnocEffRaw > 0)) _fnocMissing.push('전용률');
    const _fnocOk = _fnocMissing.length === 0;
    const rentVal = toWon(b.rentPy);
    const mgmtVal = toWon(b.maintenancePy);
    const eff = _fnocEffRaw / 100;
    const fnoc = _fnocOk ? (rentVal + mgmtVal) / eff : null;
    
    // 복수 기준가 정보
    const floorPricing = b.floorPricing || [];
    const pricingCount = floorPricing.length;
    
    // 노트 정보
    const buildingNotes = b.notes || '';
    
    // ★ v3.2: 권역 자동 감지 함수
    function detectRegionFromAddress(address) {
        if (!address) return 'ETC';
        // GBD: 강남, 서초, 삼성
        if (address.includes('강남') || address.includes('서초') || address.includes('삼성') || address.includes('역삼') || address.includes('테헤란')) return 'GBD';
        // YBD: 여의도, 영등포, 마포, 공덕
        if (address.includes('여의도') || address.includes('영등포') || address.includes('마포') || address.includes('공덕')) return 'YBD';
        // CBD: 종로, 중구, 을지로, 광화문, 시청
        if (address.includes('종로') || address.includes('중구') || address.includes('을지로') || address.includes('광화문') || address.includes('시청')) return 'CBD';
        // BBD: 분당, 판교, 성남
        if (address.includes('분당') || address.includes('판교') || address.includes('성남')) return 'BBD';
        return 'ETC';
    }
    
    // 권역 정보 (자동 감지 여부 확인)
    const rawBuilding = b._raw || {};
    const hasStoredRegion = rawBuilding.region || rawBuilding.regionId || b.region;
    // ★ 저장된 권역이 없으면 주소 기반 자동 감지
    const currentRegion = hasStoredRegion ? (b.region || 'ETC') : detectRegionFromAddress(b.address);
    const isAutoDetected = !hasStoredRegion;
    
    const regionLabels = { GBD: '강남권역', CBD: '도심권역', YBD: '여의도권역', BBD: '분당권역', ETC: '기타' };
    const regionColors = { GBD: '#16a34a', CBD: '#0284c7', YBD: '#7c3aed', BBD: '#ea580c', ETC: '#6b7280' };
    
    // 이미지 데이터
    const exteriorImages = b.exteriorImages || [];
    const floorPlanImages = b.floorPlanImages || [];
    // ★ v4.4: 중량 필드가 아직 도착하지 않았으면 "없음" 대신 "불러오는 중"을 표시
    const heavyPending = isHeavyPending(b);
    const cntLabel = (n) => (heavyPending && n === 0 ? '…' : `${n}장`);
    
    // ★ 2컬럼 이미지 갤러리 (외관 5:5 평면도)
    const imageGalleryHtml = `
        <div class="image-gallery-dual">
            <!-- 외관 이미지 영역 -->
            <div class="image-column" id="exteriorColumn">
                <div class="column-header">
                    <span class="column-title">🏢 외관</span>
                    <div class="column-header-right">
                        <button class="btn-paste-image" onclick="pasteImageFromClipboard('exterior')" title="클립보드 이미지 붙여넣기">📋 붙여넣기</button>
                        <span class="column-count">${cntLabel(exteriorImages.length)}</span>
                    </div>
                </div>
                ${exteriorImages.length > 0 ? `
                    <div class="image-main-area" onclick="openImageViewer('exterior', window._exteriorIdx || 0)">
                        <img id="exteriorMainImg" src="${exteriorImages[0].url}" alt="외관">
                        <div class="image-overlay">
                            <span>🔍 크게 보기</span>
                        </div>
                        ${exteriorImages.length > 1 ? `
                            <button class="carousel-btn prev" onclick="event.stopPropagation(); carouselNav('exterior', -1)">‹</button>
                            <button class="carousel-btn next" onclick="event.stopPropagation(); carouselNav('exterior', 1)">›</button>
                            <span class="image-counter" id="exteriorCounter">1 / ${exteriorImages.length}</span>
                        ` : ''}
                    </div>
                    ${exteriorImages.length > 1 ? `
                        <div class="image-thumbs-row" id="exteriorThumbsRow">
                            ${exteriorImages.map((img, i) => `
                                <div class="thumb-item ${i === 0 ? 'active' : ''}" onclick="selectImage('exterior', ${i})">
                                    <img src="${img.url}" alt="외관 ${i+1}">
                                    <button class="thumb-delete-btn" onclick="event.stopPropagation(); confirmDeleteImage('exterior', ${i})" title="삭제">✕</button>
                                </div>
                            `).join('')}
                        </div>
                    ` : `
                        ${exteriorImages.length === 1 ? `
                            <div class="image-thumbs-row" id="exteriorThumbsRow">
                                <div class="thumb-item active" onclick="selectImage('exterior', 0)">
                                    <img src="${exteriorImages[0].url}" alt="외관 1">
                                    <button class="thumb-delete-btn" onclick="event.stopPropagation(); confirmDeleteImage('exterior', 0)" title="삭제">✕</button>
                                </div>
                            </div>
                        ` : ''}
                    `}
                    <button class="btn-add-image" onclick="addExteriorImage()">➕ 외관 사진 추가</button>
                ` : (heavyPending ? _heavyLoadingBlock('외관 사진') : `
                    <div class="image-empty-area" onclick="addExteriorImage()">
                        <div class="empty-icon">🏢</div>
                        <div class="empty-text">외관 사진 없음</div>
                        <button class="btn-add-empty">➕ 사진 추가</button>
                    </div>
                `)}
            </div>
            
            <!-- 평면도 이미지 영역 -->
            <div class="image-column" id="floorplanColumn">
                <div class="column-header">
                    <span class="column-title">📐 평면도</span>
                    <div class="column-header-right">
                        <button class="btn-paste-image" onclick="pasteImageFromClipboard('floorplan')" title="클립보드 이미지 붙여넣기">📋 붙여넣기</button>
                        <span class="column-count">${cntLabel(floorPlanImages.length)}</span>
                    </div>
                </div>
                ${floorPlanImages.length > 0 ? `
                    <div class="image-main-area" onclick="openImageViewer('floorplan', window._floorplanIdx || 0)">
                        <img id="floorplanMainImg" src="${floorPlanImages[0].url}" alt="평면도">
                        <div class="image-overlay">
                            <span>🔍 크게 보기</span>
                        </div>
                        ${floorPlanImages.length > 1 ? `
                            <button class="carousel-btn prev" onclick="event.stopPropagation(); carouselNav('floorplan', -1)">‹</button>
                            <button class="carousel-btn next" onclick="event.stopPropagation(); carouselNav('floorplan', 1)">›</button>
                            <span class="image-counter" id="floorplanCounter">1 / ${floorPlanImages.length}</span>
                        ` : ''}
                    </div>
                    ${floorPlanImages.length > 1 ? `
                        <div class="image-thumbs-row" id="floorplanThumbsRow">
                            ${floorPlanImages.map((img, i) => `
                                <div class="thumb-item ${i === 0 ? 'active' : ''}" onclick="selectImage('floorplan', ${i})">
                                    <img src="${img.url}" alt="평면도 ${i+1}">
                                    <button class="thumb-delete-btn" onclick="event.stopPropagation(); confirmDeleteImage('floorplan', ${i})" title="삭제">✕</button>
                                </div>
                            `).join('')}
                        </div>
                    ` : `
                        ${floorPlanImages.length === 1 ? `
                            <div class="image-thumbs-row" id="floorplanThumbsRow">
                                <div class="thumb-item active" onclick="selectImage('floorplan', 0)">
                                    <img src="${floorPlanImages[0].url}" alt="평면도 1">
                                    <button class="thumb-delete-btn" onclick="event.stopPropagation(); confirmDeleteImage('floorplan', 0)" title="삭제">✕</button>
                                </div>
                            </div>
                        ` : ''}
                    `}
                    <button class="btn-add-image" onclick="addFloorPlanImage()">➕ 평면도 추가</button>
                ` : (heavyPending ? _heavyLoadingBlock('평면도') : `
                    <div class="image-empty-area" onclick="addFloorPlanImage()">
                        <div class="empty-icon">📐</div>
                        <div class="empty-text">평면도 없음</div>
                        <button class="btn-add-empty">➕ 평면도 추가</button>
                    </div>
                `)}
            </div>
        </div>
    `;
    
    // 캐러셀 인덱스 초기화
    window._exteriorIdx = 0;
    window._floorplanIdx = 0;

    document.getElementById('sectionInfo').innerHTML = `
        <!-- ★ 기본정보 헤더 (새로고침 버튼) -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border-color);">
            <span style="font-size: 14px; font-weight: 600; color: var(--text-primary);">📋 기본정보</span>
            <button onclick="refreshInfoSection()" style="padding: 4px 10px; font-size: 11px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                🔄 새로고침
            </button>
        </div>
        
        <!-- 이미지 갤러리 -->
        ${imageGalleryHtml}
        
        ${buildingNotes ? `
        <div class="building-note-card" style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; border-left: 4px solid #f59e0b;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div>
                    <div style="font-size: 11px; font-weight: 600; color: #92400e; margin-bottom: 4px;">📝 빌딩 노트</div>
                    <div style="font-size: 13px; color: #78350f; line-height: 1.5; white-space: pre-wrap;">${buildingNotes}</div>
                </div>
                <button onclick="openBuildingNoteModal()" style="background: none; border: none; cursor: pointer; font-size: 14px; color: #92400e;" title="편집">✏️</button>
            </div>
        </div>
        ` : `
        <div style="margin-bottom: 16px;">
            <button onclick="openBuildingNoteModal()" style="width: 100%; padding: 10px; border: 1px dashed var(--border-color); border-radius: 8px; background: var(--bg-secondary); color: var(--text-muted); cursor: pointer; font-size: 13px;">
                📝 빌딩 노트 추가하기
            </button>
        </div>
        `}
        
        <!-- 임대안내문 포함 표시 -->
        ${state.leasingGuideBuildings.has(b.id) ? `
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px; padding: 12px 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; color: white;">
            <span style="font-size: 18px;">📄</span>
            <div style="flex: 1;">
                <div style="font-size: 13px; font-weight: 600;">우리 임대안내문 포함</div>
                <div style="font-size: 11px; opacity: 0.9;">이 빌딩은 현재 임대안내문에 포함되어 있습니다</div>
            </div>
            <a href="leasing-guide.html" style="padding: 6px 12px; background: rgba(255,255,255,0.2); border-radius: 6px; color: white; text-decoration: none; font-size: 12px; font-weight: 500;">안내문 관리 →</a>
        </div>
        ` : ''}
        
        <!-- 권역 정보 -->
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px; padding: 10px 14px; background: var(--bg-secondary); border-radius: 8px; border-left: 4px solid ${regionColors[currentRegion] || '#6b7280'};">
            <span style="font-size: 13px; color: var(--text-secondary);">📍 권역:</span>
            <span style="font-size: 14px; font-weight: 600; color: ${regionColors[currentRegion] || '#6b7280'};">${currentRegion}</span>
            <span style="font-size: 12px; color: var(--text-muted);">(${regionLabels[currentRegion] || '기타'})</span>
            ${isAutoDetected ? `
                <span style="font-size: 10px; padding: 2px 6px; background: #fef3c7; color: #92400e; border-radius: 4px; margin-left: auto;">자동감지</span>
                <button onclick="saveAutoDetectedRegion('${currentRegion}')" style="font-size: 11px; padding: 4px 10px; background: var(--accent-color); color: white; border: none; border-radius: 4px; cursor: pointer;">저장</button>
            ` : ''}
        </div>
        
        <!-- ★ #13: 빌딩 별칭 표시 -->
        ${typeof renderAliasesSection === 'function' ? renderAliasesSection(b) : ((b.aliases && b.aliases.length > 0) ? `
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 12px; padding: 8px 12px; background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 8px;">
            <span style="font-size: 11px; color: #7c3aed; font-weight: 600; white-space: nowrap;">🏷️ 별칭:</span>
            <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                ${b.aliases.map(al => '<span style="padding: 2px 8px; background: #ede9fe; color: #6d28d9; border-radius: 4px; font-size: 11px;">' + al + '</span>').join('')}
            </div>
        </div>
        ` : '')}
        
        <!-- 빌딩 설명 (있을 경우만 표시) -->
        ${b.description ? `
        <div style="margin-bottom: 16px; padding: 14px 16px; background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); border-radius: 10px; border: 1px solid #e2e8f0;">
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 8px;">
                <span style="font-size: 13px;">📝</span>
                <span style="font-size: 12px; font-weight: 600; color: var(--text-secondary);">빌딩 설명</span>
                <button onclick="openBuildingEditModal()" style="margin-left: auto; padding: 2px 8px; font-size: 11px; background: none; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-muted); cursor: pointer;">편집</button>
            </div>
            <div style="font-size: 13px; color: var(--text-primary); line-height: 1.6; white-space: pre-wrap;">${b.description}</div>
        </div>
        ` : ''}
        
        ${renderOriginBadges(b)}

        <!-- 면적 정보 (평 크게 + ㎡ 괄호 표시) -->
        <div class="info-grid" style="grid-template-columns: repeat(3, 1fr);">
            <div class="info-card">
                <div class="label">연면적</div>
                <div class="value">${formatNumber(b.area?.grossFloorPy || b.grossFloorPy)}<span class="unit">평</span></div>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">(${formatNumber(b.area?.grossFloorSqm || b.grossFloorSqm)}㎡)</div>
            </div>
            <div class="info-card">
                <div class="label">대지면적</div>
                <div class="value">${formatNumber(Math.round((b.area?.landArea || b.landArea || 0) / 3.3058))}<span class="unit">평</span></div>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">(${formatNumber(b.area?.landArea || b.landArea)}㎡)</div>
            </div>
            <div class="info-card">
                <div class="label">건축면적</div>
                <div class="value">${formatNumber(Math.round((b.area?.buildingArea || b.buildingArea || 0) / 3.3058))}<span class="unit">평</span></div>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">(${formatNumber(b.area?.buildingArea || b.buildingArea)}㎡)</div>
            </div>
        </div>
        
        ${(() => {
            // ★ S1: 건축물대장 면적 — 미조회 안내 / 현재값(=안내문 표기값) vs 대장 불일치 경고
            const bi = b.buildingInfo || (b._raw && b._raw.buildingInfo) || {};
            const hasBi = Object.keys(bi).length > 0;

            // 대장 미조회 → 조회 안내 (비교 대상 자체가 없음)
            if (!hasBi) {
                return `<div style="margin-top:8px;padding:8px 12px;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;display:flex;align-items:center;justify-content:space-between;gap:8px;">
                    <span style="font-size:11px;color:#94a3b8;">🏛️ 건축물대장 미조회 — 조회하면 면적을 비교할 수 있습니다</span>
                    <button onclick="refreshBuildingLedger()" style="padding:3px 10px;font-size:11px;background:#fff;color:#3b82f6;border:1px solid #bfdbfe;border-radius:5px;cursor:pointer;white-space:nowrap;">🔄 대장 조회</button>
                </div>`;
            }

            // 대장 보유 → 면적 불일치 검사
            const toPy = (sqm) => Math.round(parseFloat(sqm || 0) / 3.3058);
            const rows = [];
            const cmp = (label, curSqm, biSqm) => {
                const c = parseFloat(curSqm || 0), q = parseFloat(biSqm || 0);
                if (!(c > 0 && q > 0)) return;
                const diff = Math.abs(c - q) / q;
                if (diff < 0.01) return; // 1% 미만은 일치로 간주(반올림 흡수)
                rows.push(`<div>⚠️ <strong>${label}</strong>&nbsp; 현재 ${toPy(c).toLocaleString()}평 &nbsp;·&nbsp; 대장 ${toPy(q).toLocaleString()}평 <span style="color:#dc2626;font-weight:700;">(${(diff*100).toFixed(0)}% 차이)</span></div>`);
            };
            const curGrossSqm = (b.area?.grossFloorSqm || b.grossFloorSqm || ((b.area?.grossFloorPy || b.grossFloorPy || 0) * 3.30579));
            cmp('연면적',   curGrossSqm,                            bi.totArea  || bi.totalArea);
            cmp('대지면적', b.area?.landArea     || b.landArea,     bi.platArea || bi.landArea);
            cmp('건축면적', b.area?.buildingArea || b.buildingArea, bi.archArea || bi.buildingArea);
            if (rows.length === 0) return ''; // 보유 + 일치 → 표시 없음
            return `<div style="margin-top:8px;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
                    <span style="font-size:12px;font-weight:700;color:#b45309;">🏛️ 건축물대장과 다른 면적</span>
                    <button onclick="refreshBuildingLedger()" style="padding:3px 10px;font-size:11px;background:#f59e0b;color:#fff;border:none;border-radius:5px;cursor:pointer;white-space:nowrap;">대장 비교·반영</button>
                </div>
                <div style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#92400e;">${rows.join('')}</div>
            </div>`;
        })()}

        <!-- 기준층/전용률 정보 -->
        <div class="info-grid" style="grid-template-columns: repeat(3, 1fr); margin-top: 8px;">
            <div class="info-card"><div class="label">기준층 전용</div><div class="value">${(() => { const v = resolveExclusiveFloorPy(b); return v ? formatNumber(v) : '-'; })()}<span class="unit">평</span></div></div>
            <div class="info-card"><div class="label">기준층 임대</div><div class="value">${(() => { const v = resolveLeaseFloorPy(b); return v ? formatNumber(v) : '-'; })()}<span class="unit">평</span></div></div>
            <div class="info-card"><div class="label">전용률</div><div class="value">${resolveExclusiveRate(b) ?? '-'}<span class="unit">%</span></div></div>
        </div>
        
        <!-- 건물 기본정보 -->
        <div class="info-grid" style="grid-template-columns: repeat(3, 1fr); margin-top: 8px;">
            <div class="info-card">
                <div class="label">준공년도</div>
                <div class="value">${b.completionYear || '-'}</div>
                ${b.remodelNote ? `<div style="font-size:10px; color:#be185d; margin-top:2px; padding:2px 6px; background:#fce7f3; border-radius:3px; display:inline-block;">${b.remodelNote}</div>` : ''}
            </div>
            <div class="info-card"><div class="label">등급</div><div class="value">${b.grade || '-'}</div></div>
            <div class="info-card"><div class="label">주용도</div><div class="value" style="font-size: 13px;">${b.specs?.buildingUse || b.buildingUse || b.mainPurpose || '-'}</div></div>
        </div>
        
        <!-- 용적률/건폐율 -->
        <div class="info-grid" style="grid-template-columns: repeat(2, 1fr); margin-top: 8px;">
            <div class="info-card"><div class="label">용적률</div><div class="value">${b.vlRat || b.floorAreaRatio || '-'}<span class="unit">${b.vlRat || b.floorAreaRatio ? '%' : ''}</span></div></div>
            <div class="info-card"><div class="label">건폐율</div><div class="value">${b.bcRat || b.buildingCoverageRatio || '-'}<span class="unit">${b.bcRat || b.buildingCoverageRatio ? '%' : ''}</span></div></div>
        </div>
        
        <!-- 📊 공실/임대가 통계 바로가기 -->
        <div onclick="switchToTab('stats')" style="display: flex; align-items: center; gap: 10px; margin-top: 12px; margin-bottom: 4px; padding: 10px 14px; background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%); border: 1px solid #bae6fd; border-radius: 8px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='linear-gradient(135deg,#e0f2fe 0%,#bae6fd 100%)'" onmouseout="this.style.background='linear-gradient(135deg,#f0f9ff 0%,#e0f2fe 100%)'">
            <span style="font-size: 16px;">📊</span>
            <div style="flex: 1;">
                <div style="font-size: 12px; font-weight: 600; color: #0369a1;">공실/임대가 통계 보기</div>
                <div style="font-size: 11px; color: #0284c7;">회사별 공실률 · 평균 임대가 비교</div>
            </div>
            <span style="color: #0284c7; font-size: 14px;">→</span>
        </div>
        
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center;">
            <span>💰 임대조건</span>
            ${pricingCount > 0 ? `<span style="font-size: 11px; padding: 2px 8px; background: var(--accent-light); color: var(--accent-color); border-radius: 10px;">층별 ${pricingCount}개 기준가</span>` : ''}
        </div>
        
        ${pricingCount > 0 ? `
        <div style="background: var(--bg-secondary); border-radius: 8px; padding: 12px; margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <div style="font-size: 11px; color: var(--text-muted);">📊 층별 기준가 (최신 ${Math.min(pricingCount, 5)}개)</div>
                <button onclick="document.querySelector('[data-section=pricing]').click()" style="font-size: 11px; color: var(--accent-color); background: none; border: none; cursor: pointer; text-decoration: underline;">
                    전체보기 →
                </button>
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px;">
                ${floorPricing.slice(0, 5).map(fp => {
                    // 날짜 포맷팅
                    const d = fp.effectiveDate || fp.createdAt || '';
                    let displayDate = '-';
                    if (d.includes('-')) {
                        const [y, m] = d.split('-');
                        displayDate = y.slice(-2) + '.' + m;
                    } else if (d) {
                        displayDate = d.slice(0, 5);
                    }
                    
                    return `
                    <div style="padding: 10px 12px; background: var(--bg-primary); border: 1px solid ${fp.isOfficial ? '#7c3aed' : 'var(--border-color)'}; border-radius: 6px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px;">
                            <div style="min-width: 0;">
                                <div style="font-size: 13px; font-weight: 600; color: var(--text-primary);">${fp.label || fp.floorRange || '기준가'}${fp.isOfficial ? ' <span style="color:#7c3aed; font-size:10px; font-weight:700;">⭐공식</span>' : ''}</div>
                                <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">📅 ${displayDate}${fp.sourceCompany ? ' · ' + fp.sourceCompany : ''}</div>
                            </div>
                            <button onclick="setOfficialPricing('${fp.id}')" ${fp.isOfficial ? 'disabled' : ''} style="padding: 5px 10px; font-size: 11px; font-weight: 600; background: ${fp.isOfficial ? '#ede9fe' : '#7c3aed'}; color: ${fp.isOfficial ? '#7c3aed' : '#fff'}; border: 1px solid #7c3aed; border-radius: 5px; cursor: ${fp.isOfficial ? 'default' : 'pointer'}; white-space: nowrap; flex-shrink: 0;">${fp.isOfficial ? '✓ 적용됨' : '바로 적용하기'}</button>
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; text-align: center;">
                            <div style="background: var(--bg-secondary); border-radius: 4px; padding: 5px 4px;">
                                <div style="font-size: 10px; color: var(--text-muted);">보증금</div>
                                <div style="font-size: 12px; font-weight: 600; color: #2563eb;">${fp.depositPy ? formatNumber(fp.depositPy) : '-'}</div>
                            </div>
                            <div style="background: var(--bg-secondary); border-radius: 4px; padding: 5px 4px;">
                                <div style="font-size: 10px; color: var(--text-muted);">임대료</div>
                                <div style="font-size: 12px; font-weight: 600; color: var(--accent-color);">${fp.rentPy ? formatNumber(fp.rentPy) : '-'}</div>
                            </div>
                            <div style="background: var(--bg-secondary); border-radius: 4px; padding: 5px 4px;">
                                <div style="font-size: 10px; color: var(--text-muted);">관리비</div>
                                <div style="font-size: 12px; font-weight: 600; color: #16a34a;">${fp.maintenancePy ? formatNumber(fp.maintenancePy) : '-'}</div>
                            </div>
                        </div>
                        <div style="font-size: 9px; color: var(--text-muted); text-align: right; margin-top: 3px;">단위: 원/평</div>
                    </div>
                `}).join('')}
                ${pricingCount > 5 ? `<div style="text-align: center; font-size: 11px; color: var(--text-muted); padding: 6px;">+${pricingCount - 5}개 더 있음</div>` : ''}
            </div>
        </div>
        ` : ''}
        
        <div class="price-table">
            <div class="price-row"><span class="label">보증금</span><span class="value">${b.depositPy ? formatNumber(b.depositPy) + '원' : '-'}/평</span></div>
            <div class="price-row"><span class="label">임대료</span><span class="value">${b.rentPy ? formatNumber(b.rentPy) + '원' : '-'}/평</span></div>
            <div class="price-row"><span class="label">관리비</span><span class="value">${b.maintenancePy ? formatNumber(b.maintenancePy) + '원' : '-'}/평</span></div>
        </div>
        <div class="noc-card">
            <div class="title">NOC (Net Occupancy Cost)</div>
            <div class="noc-row"><span>F-NOC (전용면적 기준)</span><span class="value">${_fnocOk ? formatNumber(fnoc) + '원/평' : '-'}</span></div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px; line-height: 1.5;">공식: (임대료 + 관리비) ÷ 전용률</div>
            ${!_fnocOk ? `<div style="font-size: 11px; color: #dc2626; margin-top: 4px; font-weight: 600;">⚠️ 계산 불가 · 누락: ${_fnocMissing.join(', ')}</div>` : ''}
        </div>
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center;">
            <span>🏢 빌딩 상세</span>
            <button onclick="refreshBuildingLedger()" style="padding: 4px 10px; font-size: 11px; background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                🔄 건축물대장 불러오기
            </button>
        </div>
        <div class="spec-list">
            <div class="spec-item"><span class="label">층수</span><span class="value">${b.floorsDisplay || (typeof b.floors === 'object' ? (b.floors?.display || `지하${b.floors?.below || 0}층/지상${b.floors?.above || 0}층`) : (b.floors || '-'))}</span></div>
            <div class="spec-item"><span class="label">인근역</span><span class="value">${b.nearbyStation || b.nearestStation || '-'}</span></div>
            <div class="spec-item"><span class="label">주차</span><span class="value">${formatParkingDisplay(b)}${formatParkingComposition(b)}</span></div>
            <div class="spec-item"><span class="label">구조</span><span class="value">${b.specs?.structure || b.structure || '-'}</span></div>
            <div class="spec-item"><span class="label">건물용도</span><span class="value">${b.specs?.buildingUse || b.buildingUse || b.usage || '-'}</span></div>
            <div class="spec-item"><span class="label">냉난방</span><span class="value">${b.hvac || '-'}</span></div>
            <div class="spec-item"><span class="label">엘리베이터</span><span class="value">${b.specs?.passengerElevator || b.specs?.freightElevator ? `승객${b.specs?.passengerElevator || 0}/화물${b.specs?.freightElevator || 0}대` : (b.passengerElevator || b.freightElevator ? `승객${b.passengerElevator || 0}/화물${b.freightElevator || 0}대` : (b.specs?.elevator || b.elevator || '-'))}</span></div>
            <div class="spec-item"><span class="label">PM</span><span class="value">${b.pm || '-'}</span></div>
            <div class="spec-item"><span class="label">소유자</span><span class="value">${b.owner || '-'}</span></div>
        </div>
        
        <!-- ★ 건축물대장 전유부/층별개요 조회 버튼 -->
        <div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
            <button onclick="fetchBuildingFloorDetail('floorOutline')" 
                    style="padding: 6px 12px; font-size: 11px; background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                🏗️ 층별개요 조회
            </button>
            <button onclick="fetchBuildingFloorDetail('exposeInfo')" 
                    style="padding: 6px 12px; font-size: 11px; background: linear-gradient(135deg, #059669 0%, #047857 100%); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                📋 전유부 조회
            </button>
            <button onclick="fetchBuildingFloorDetail('exposeAreaInfo')" 
                    style="padding: 6px 12px; font-size: 11px; background: linear-gradient(135deg, #d97706 0%, #b45309 100%); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                📐 전유공용면적 조회
            </button>
        </div>
        <div id="floorDetailContainer" style="margin-top: 8px;"></div>
        
        <!-- 빌딩 정보 편집 버튼 -->
        <div style="margin-top: 16px; text-align: center;">
            <button onclick="openBuildingEditModal()" style="padding: 10px 24px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-primary); cursor: pointer; font-size: 13px;">
                ✏️ 빌딩 정보 편집
            </button>
        </div>
    `;
}

// ★ 기본정보 새로고침 (Firebase에서 최신 데이터 다시 불러오기)
export async function refreshInfoSection() {
    if (!state.selectedBuilding) return;
    
    const buildingId = state.selectedBuilding.id;
    console.log('🔄 기본정보 새로고침:', buildingId);
    
    try {
        // Firebase에서 최신 데이터 가져오기
        const snapshot = await get(ref(db, `buildings/${buildingId}`));
        if (snapshot.exists()) {
            const freshData = snapshot.val();

            // ★ Bug2 fix (안내문 리스트 소실):
            //   기존 코드는 state.selectedBuilding = freshData(raw buildings 문서)로 통째 교체했다.
            //   raw 문서에는 processBuildings()가 병합해주는 leasingGuideVacancies /
            //   leasingGuideInfo / documents 가 없어서, 교체 즉시 안내문 탭의
            //   "등록된 안내문 리스트"가 사라졌다(allBuildings[idx]까지 raw로 오염).
            //   → dataCache.buildings만 최신으로 갱신한 뒤 processBuildings()로 재가공한다.
            //     processBuildings()는 leasingGuides를 다시 병합하고, 끝에서
            //     selectedBuilding을 새 가공 객체로 자동 재연결한다(portal-data.js).
            if (state.dataCache && state.dataCache.buildings) {
                state.dataCache.buildings[buildingId] = freshData;
            }

            // processBuildings()는 filteredBuildings를 allBuildings 전체로 리셋하므로(L473),
            // 기본정보 새로고침이 좌측 리스트의 검색/필터를 풀어버리지 않도록 현재 집합을 보존한다.
            const _prevIds = (state.filteredBuildings || []).map(b => b.id);
            const _wasFiltered = _prevIds.length > 0 && _prevIds.length < (state.allBuildings?.length || 0);

            processBuildings(); // allBuildings 재구축 + selectedBuilding 재연결(병합 필드 보존)

            // 메인 리스트 필터/검색 상태 복원 (새 가공 객체로 매핑)
            if (_wasFiltered) {
                const _idSet = new Set(_prevIds);
                state.filteredBuildings = state.allBuildings.filter(b => _idSet.has(b.id));
            }

            // 화면 다시 렌더링 (정보 섹션 + 메인 리스트 동기화)
            renderInfoSection();
            if (window.renderBuildingList) window.renderBuildingList();

            if (window.showToast) {
                showToast('기본정보가 새로고침 되었습니다', 'success');
            }
        }
    } catch (e) {
        console.error('기본정보 새로고침 실패:', e);
        if (window.showToast) {
            showToast('새로고침 실패', 'error');
        }
    }
}

// ★ 공실(안내문) 새로고침 (vacancies 컬렉션에서 최신 데이터 다시 불러오기)
export async function refreshVacanciesSection() {
    if (!state.selectedBuilding) return;
    
    const buildingId = state.selectedBuilding.id;
    console.log('🔄 공실 데이터 새로고침:', buildingId);
    
    try {
        // vacancies 컬렉션에서 해당 빌딩 데이터 가져오기
        const snapshot = await get(ref(db, `vacancies/${buildingId}`));
        if (snapshot.exists()) {
            const vacancyData = snapshot.val();
            
            // 배열로 변환 (_key 보존)
            const entries = [];
            Object.entries(vacancyData).forEach(([key, val]) => {
                if (val && typeof val === 'object') {
                    entries.push({ _key: key, id: key, ...val });
                }
            });
            
            // ★ documents와 vacancies 모두 업데이트
            state.selectedBuilding.documents = entries;
            state.selectedBuilding.vacancies = entries;
            state.selectedBuilding.vacancyCount = entries.length;
            
            // allBuildings에서도 업데이트
            const buildingInAll = state.allBuildings?.find(b => b.id === buildingId);
            if (buildingInAll) {
                buildingInAll.vacancies = entries;
                buildingInAll.vacancyCount = entries.length;
            }
            
            // 안내문 섹션 다시 렌더링
            renderDocumentSection();
            
            if (window.showToast) {
                showToast(`공실 데이터 새로고침 완료 (${entries.length}건)`, 'success');
            }
        } else {
            state.selectedBuilding.documents = [];
            state.selectedBuilding.vacancies = [];
            state.selectedBuilding.vacancyCount = 0;
            renderDocumentSection();
            showToast('공실 데이터 없음', 'info');
        }
    } catch (e) {
        console.error('공실 새로고침 실패:', e);
        if (window.showToast) {
            showToast('새로고침 실패', 'error');
        }
    }
}

// ===== 기준가 섹션 =====

// 기준가 레코드/빌딩에 면적이 없을 때, 같은 출처·발행월(가능하면 해당 층)의 공실에서 대표 기준면적 추정
function deriveAreaFromVacancies(b, fp) {
    const _num = (v) => { const x = parseFloat(String(v ?? '').replace(/,/g, '')); return isNaN(x) ? null : x; };
    const vacs = (b && b.vacancies) || [];
    if (!vacs.length) return { rentArea: null, exclusiveArea: null, derived: false };
    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    const ymOf = (s) => {
        const d = String(s || '');
        let m = d.match(/(\d{2})[.\-](\d{2})/); if (m) return m[1] + m[2];
        m = d.match(/(\d{4})-(\d{2})/); if (m) return m[1].slice(-2) + m[2];
        return '';
    };
    const floorNum = (f) => {
        const s = String(f || '').toUpperCase().trim();
        const bm = s.match(/^B(\d+)/); if (bm) return -parseInt(bm[1]);
        const fm = s.match(/(\d+)/); return fm ? parseInt(fm[1]) : NaN;
    };
    let cand = vacs.filter(v => _num(v.rentArea) || _num(v.exclusiveArea));
    if (!cand.length) return { rentArea: null, exclusiveArea: null, derived: false };
    // 출처 일치 우선
    const fpSrc = norm(fp.sourceCompany);
    if (fpSrc && fpSrc !== 'manual') { const bySrc = cand.filter(v => norm(v.source) === fpSrc); if (bySrc.length) cand = bySrc; }
    // 발행월 일치 우선
    const fpYM = ymOf(fp.effectiveDate);
    if (fpYM) { const byYM = cand.filter(v => ymOf(v.publishDate) === fpYM); if (byYM.length) cand = byYM; }
    // 해당 층 범위 매칭 우선
    const fs = floorNum(fp.floorStart), fe = floorNum(fp.floorEnd);
    if (!isNaN(fs)) {
        const lo = Math.min(fs, isNaN(fe) ? fs : fe), hi = Math.max(fs, isNaN(fe) ? fs : fe);
        const inRange = cand.filter(v => { const n = floorNum(v.floor); return !isNaN(n) && n >= lo && n <= hi; });
        if (inRange.length) cand = inRange;
    }
    // 대표값: 최빈 임대면적(표준층) + 짝 전용면적
    const r1 = (x) => Math.round(x * 10) / 10;
    const freq = {};
    cand.forEach(v => { const r = _num(v.rentArea); if (r) { const k = r1(r); freq[k] = (freq[k] || 0) + 1; } });
    let ra = null, best = 0;
    Object.keys(freq).forEach(k => { if (freq[k] > best) { best = freq[k]; ra = parseFloat(k); } });
    let ea = null;
    if (ra != null) { const mt = cand.find(v => r1(_num(v.rentArea)) === ra && _num(v.exclusiveArea)); ea = mt ? _num(mt.exclusiveArea) : null; }
    if (ra == null && ea == null) {
        const fe2 = {};
        cand.forEach(v => { const e = _num(v.exclusiveArea); if (e) { const k = r1(e); fe2[k] = (fe2[k] || 0) + 1; } });
        let best2 = 0; Object.keys(fe2).forEach(k => { if (fe2[k] > best2) { best2 = fe2[k]; ea = parseFloat(k); } });
    }
    return { rentArea: ra, exclusiveArea: ea, derived: (ra != null || ea != null) };
}

// ★ 기준가 카드 1개 렌더 (아코디언 그룹 내부에서 사용)
function renderPricingCard(fp, idx, b) {
    const d = fp.effectiveDate || fp.createdAt || '';
    let displayDate = '-';
    if (d.includes('-')) { const [y, m] = d.split('-'); displayDate = `${y.slice(-2)}.${m}`; }
    else if (d) { displayDate = d.slice(0, 5); }
    const isOfficial = fp.isOfficial;
    const isOcr = fp.sourceType === 'ocr';
    return `
                <div class="pricing-card" style="background: ${isOfficial ? 'linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)' : 'var(--bg-secondary)'}; 
                     border-radius: 10px; padding: 16px; 
                     border: 2px solid ${isOfficial ? '#eab308' : (isOcr ? '#3b82f6' : 'var(--border-color)')}; 
                     position: relative;">
                    
                    <div style="position: absolute; top: -10px; right: 12px; display: flex; gap: 4px;">
                        ${isOfficial ? `<span style="padding: 2px 8px; background: linear-gradient(135deg, #eab308 0%, #ca8a04 100%); color: white; font-size: 10px; border-radius: 4px; font-weight: 600;">⭐ 공식</span>` : ''}
                        ${isOcr ? `<span style="padding: 2px 8px; background: #3b82f6; color: white; font-size: 10px; border-radius: 4px;">OCR</span>` : ''}
                    </div>
                    
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
                        <div>
                            <div style="font-size: 15px; font-weight: 600; color: var(--text-primary);">${fp.label || '기준가 ' + (idx + 1)}</div>
                            <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">📍 ${fp.floorRange || '-'}</div>
                        </div>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 10px;">
                        <div style="text-align: center; padding: 6px 8px; background: ${isOfficial ? 'white' : 'var(--bg-primary)'}; border-radius: 6px;">
                            <div style="font-size: 11px; color: var(--text-muted);">보증금</div>
                            <div style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${fp.depositPy ? formatNumber(fp.depositPy) + '원/평' : '-'}</div>
                        </div>
                        <div style="text-align: center; padding: 6px 8px; background: ${isOfficial ? 'white' : 'var(--bg-primary)'}; border-radius: 6px;">
                            <div style="font-size: 11px; color: var(--text-muted);">임대료</div>
                            <div style="font-size: 14px; font-weight: 600; color: ${isOfficial ? '#d97706' : 'var(--accent-color)'};">${fp.rentPy ? formatNumber(fp.rentPy) + '원/평' : '-'}</div>
                        </div>
                        <div style="text-align: center; padding: 6px 8px; background: ${isOfficial ? 'white' : 'var(--bg-primary)'}; border-radius: 6px;">
                            <div style="font-size: 11px; color: var(--text-muted);">관리비</div>
                            <div style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${fp.maintenancePy ? formatNumber(fp.maintenancePy) + '원/평' : '-'}</div>
                        </div>
                    </div>
                    
                    ${(() => {
                        const _num = (v) => { const x = parseFloat(String(v ?? '').replace(/,/g, '')); return isNaN(x) ? null : x; };
                        const fpHasArea = (fp.rentArea != null && fp.rentArea !== '') || (fp.exclusiveArea != null && fp.exclusiveArea !== '');
                        let ra = _num(fp.rentArea) ?? _num(b.typicalFloorRent);
                        let ea = _num(fp.exclusiveArea) ?? _num(b.typicalFloorExclusive);
                        const bldgHasArea = !fpHasArea && (ra != null || ea != null);
                        let derivedFlag = false;
                        if (ra == null && ea == null) {
                            const dd = deriveAreaFromVacancies(b, fp);
                            ra = dd.rentArea; ea = dd.exclusiveArea; derivedFlag = dd.derived;
                        }
                        let rate = _num(fp.exclusiveRate) ?? ((ra && ea) ? Math.round(ea / ra * 1000) / 10 : _num(b.exclusiveRate));
                        if (!ra && !ea && !rate) return '';
                        const tag = derivedFlag ? '안내문 공실 기준' : (bldgHasArea ? '건물 기준층값' : '');
                        const tagTitle = derivedFlag ? '기준가에 면적이 없어 해당 안내문 공실 데이터로 표시' : '기준가에 면적이 없어 건물 기준층 OCR 값으로 표시';
                        const cells = [];
                        if (ra) cells.push({ l: '임대면적', v: formatNumber(ra) + '평', c: 'var(--text-primary)' });
                        if (ea) cells.push({ l: '전용면적', v: formatNumber(ea) + '평', c: 'var(--text-primary)' });
                        if (rate) cells.push({ l: '전용률', v: rate + '%', c: '#2563eb' });
                        return `
                        <div style="margin-bottom: 12px;">
                            ${tag ? `<div style="text-align:right; margin-bottom:4px;"><span style="font-size:10px; color:var(--text-muted); background:var(--bg-tertiary); padding:1px 6px; border-radius:4px;" title="${tagTitle}">${tag}</span></div>` : ''}
                            <div style="display:grid; grid-template-columns:repeat(${cells.length},1fr); gap:8px;">
                                ${cells.map(c => `
                                    <div style="text-align:center; padding:8px 6px; background:${isOfficial ? '#fffdf5' : 'var(--bg-tertiary)'}; border:1px dashed ${isOfficial ? '#fde68a' : 'var(--border-color)'}; border-radius:6px;">
                                        <div style="font-size:11px; color:var(--text-muted); margin-bottom:2px;">${c.l}</div>
                                        <div style="font-size:16px; font-weight:700; color:${c.c};">${c.v}</div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>`;
                    })()}
                    
                    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--text-muted); padding-top: 8px; border-top: 1px solid ${isOfficial ? '#fde68a' : 'var(--border-color)'};">
                        <span>📅 ${displayDate}${fp.sourceCompany ? ' · <strong style="color: var(--text-secondary)">' + fp.sourceCompany + '</strong>' : ''}</span>
                        <span>${fp.notes || ''}</span>
                    </div>
                    
                    <div style="display: flex; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed ${isOfficial ? '#fde68a' : 'var(--border-color)'};">
                        ${!isOfficial ? `
                            <button onclick="setOfficialPricing('${fp.id}')" 
                                    style="flex: 1; padding: 8px 12px; background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%); color: white; border: none; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px;">
                                ⭐ 공식 기준가로 적용
                            </button>
                        ` : `
                            <button onclick="unsetOfficialPricing('${fp.id}')" 
                                    style="flex: 1; padding: 8px 12px; background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer;">
                                ✕ 공식 해제
                            </button>
                        `}
                        <button onclick="editPricing('${fp.id}')" 
                                style="padding: 8px 12px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; font-size: 12px; cursor: pointer;" 
                                title="수정">
                            ✏️
                        </button>
                        <button onclick="deletePricing('${fp.id}')" 
                                style="padding: 8px 12px; background: #fee2e2; border: 1px solid #fca5a5; border-radius: 6px; font-size: 12px; cursor: pointer; color: #dc2626;" 
                                title="삭제">
                            🗑️
                        </button>
                    </div>
                </div>
            `;
}

export function renderPricingSection() {
    const b = state.selectedBuilding;
    const allPricing = b.floorPricing || [];
    
    // 기본 임대조건 확인 (buildings 컬렉션의 최상위 필드)
    const hasBasePricing = b.depositPy || b.rentPy || b.maintenancePy;
    
    // ★ 공식 기준가 (isOfficial: true인 항목들)
    const officialPricing = allPricing.filter(fp => fp.isOfficial);
    
    // ★ 시계열: effectiveDate에서 연월 추출하여 날짜 목록 생성
    const availableDates = [...new Set(allPricing.map(fp => {
        const d = fp.effectiveDate || fp.createdAt || '';
        if (d.includes('-')) {
            const [y, m] = d.split('-');
            return `${y.slice(-2)}.${m}`;
        }
        return d.slice(0, 5);
    }).filter(Boolean))].sort((a, b) => b.localeCompare(a));
    
    // ★ 출처별 목록
    const availableSources = [...new Set(allPricing.map(fp => fp.sourceCompany).filter(Boolean))];
    
    // 날짜별 개수 계산
    const countByDate = {};
    allPricing.forEach(fp => {
        const d = fp.effectiveDate || fp.createdAt || '';
        let dateKey;
        if (d.includes('-')) {
            const [y, m] = d.split('-');
            dateKey = `${y.slice(-2)}.${m}`;
        } else {
            dateKey = d.slice(0, 5);
        }
        if (dateKey) countByDate[dateKey] = (countByDate[dateKey] || 0) + 1;
    });
    
    // 출처별 개수 계산
    const countBySource = {};
    allPricing.forEach(fp => {
        const src = fp.sourceCompany || '직접입력';
        countBySource[src] = (countBySource[src] || 0) + 1;
    });
    
    // 선택된 필터로 필터링
    const selectedDate = state.selectedPricingDate || 'all';
    const selectedSource = state.selectedPricingSource || 'all';
    
    let filteredPricing = allPricing;
    
    // 날짜 필터
    if (selectedDate !== 'all') {
        filteredPricing = filteredPricing.filter(fp => {
            const d = fp.effectiveDate || fp.createdAt || '';
            let dateKey;
            if (d.includes('-')) {
                const [y, m] = d.split('-');
                dateKey = `${y.slice(-2)}.${m}`;
            } else {
                dateKey = d.slice(0, 5);
            }
            return dateKey === selectedDate;
        });
    }
    
    // 출처 필터
    if (selectedSource !== 'all') {
        filteredPricing = filteredPricing.filter(fp => {
            const src = fp.sourceCompany || '직접입력';
            return src === selectedSource;
        });
    }
    
    // 필터된 목록을 최신순으로 정렬 (공식 기준가 우선)
    const sortedPricing = [...filteredPricing].sort((a, b) => {
        // 공식 기준가 우선
        if (a.isOfficial && !b.isOfficial) return -1;
        if (!a.isOfficial && b.isOfficial) return 1;
        // 날짜순
        const dateA = a.effectiveDate || a.createdAt || '';
        const dateB = b.effectiveDate || b.createdAt || '';
        return dateB.localeCompare(dateA);
    });
    
    // 기준가 개수 업데이트
    document.getElementById('pricingCount').textContent =
        (isHeavyPending(b) && !allPricing.length) ? '…' : allPricing.length;
    
    document.getElementById('sectionPricing').innerHTML = `
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px;">
            <span style="flex-shrink: 0;">💰 층별 기준가</span>
            <div style="display: flex; gap: 6px; flex-shrink: 0; align-items: center;">
                <button class="btn btn-secondary btn-sm" style="width: auto; flex: 0 0 auto; padding: 6px 12px; white-space: nowrap;" onclick="refreshPricingSection()" title="새로고침">🔄</button>
                <button class="btn btn-primary btn-sm" style="width: auto; flex: 0 0 auto; padding: 6px 16px; white-space: nowrap;" onclick="openPricingModal()">+ 추가</button>
            </div>
        </div>
        
        ${/* 공식 기준가 요약 */ ''}
        ${officialPricing.length > 0 ? `
        <div style="background: linear-gradient(135deg, #fef9c3 0%, #fde047 100%); border-radius: 10px; padding: 16px; margin-bottom: 16px; border: 2px solid #eab308;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                <span style="font-size: 18px;">⭐</span>
                <span style="font-size: 14px; font-weight: 600; color: #854d0e;">공식 기준가</span>
                <span style="font-size: 11px; color: #a16207;">(${officialPricing.length}개)</span>
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                ${officialPricing.map(fp => `
                    <div style="background: white; border-radius: 8px; padding: 10px 14px; border: 1px solid #fbbf24;">
                        <div style="font-size: 12px; font-weight: 600; color: #78350f;">${fp.label || fp.floorRange || '기준가'}</div>
                        <div style="font-size: 14px; font-weight: 700; color: #d97706; margin-top: 4px;">${fp.rentPy ? formatNumber(fp.rentPy) + '원/평' : '-'}</div>
                        <div style="font-size: 10px; color: #92400e; margin-top: 2px;">
                            ${fp.depositPy ? '보증금 ' + formatNumber(fp.depositPy) : ''} 
                            ${fp.maintenancePy ? '| 관리비 ' + formatNumber(fp.maintenancePy) : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
        ` : ''}
        
        ${/* 필터 UI */ ''}
        ${allPricing.length > 0 ? `
        <div style="background: var(--bg-secondary); border-radius: 8px; padding: 12px; margin-bottom: 16px;">
            ${/* 기준월 필터 */ ''}
            <div style="margin-bottom: ${availableSources.length > 1 ? '12px' : '0'};">
                <span style="font-size: 11px; color: var(--text-muted); margin-right: 8px;">📅 기준월</span>
                <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;">
                    <button onclick="filterPricingByDate('all')"
                            style="padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; border: none;
                                   background: ${selectedDate === 'all' ? 'var(--accent-color)' : 'var(--bg-primary)'}; 
                                   color: ${selectedDate === 'all' ? 'white' : 'var(--text-primary)'};">
                        전체 ${allPricing.length}
                    </button>
                    ${availableDates.map(date => `
                        <button onclick="filterPricingByDate('${date}')"
                                style="padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; border: none;
                                       background: ${selectedDate === date ? 'var(--accent-color)' : 'var(--bg-primary)'}; 
                                       color: ${selectedDate === date ? 'white' : 'var(--text-primary)'};">
                            ${date} ${countByDate[date] || 0}
                        </button>
                    `).join('')}
                </div>
            </div>
            
            ${/* 출처 필터 */ ''}
            ${availableSources.length > 1 ? `
            <div>
                <span style="font-size: 11px; color: var(--text-muted); margin-right: 8px;">🏢 출처</span>
                <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;">
                    <button onclick="filterPricingBySource('all')"
                            style="padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; border: none;
                                   background: ${selectedSource === 'all' ? '#8b5cf6' : 'var(--bg-primary)'}; 
                                   color: ${selectedSource === 'all' ? 'white' : 'var(--text-primary)'};">
                        전체
                    </button>
                    ${availableSources.map(src => `
                        <button onclick="filterPricingBySource('${src.replace(/'/g, "\\'")}')"
                                style="padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; border: none;
                                       background: ${selectedSource === src ? '#8b5cf6' : 'var(--bg-primary)'}; 
                                       color: ${selectedSource === src ? 'white' : 'var(--text-primary)'};">
                            ${src} ${countBySource[src] || 0}
                        </button>
                    `).join('')}
                </div>
            </div>
            ` : ''}
        </div>
        ` : ''}
        
        ${/* 기본 임대조건이 있고 floorPricing이 비어있을 때 */ ''}
        ${hasBasePricing && allPricing.length === 0 ? `
        <div style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 10px; padding: 16px; margin-bottom: 16px; border: 1px solid #fbbf24;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <div>
                    <div style="font-size: 14px; font-weight: 600; color: #92400e;">📋 기본 임대조건</div>
                    <div style="font-size: 11px; color: #a16207; margin-top: 2px;">기본정보에 등록된 임대조건입니다</div>
                </div>
                <button onclick="migrateBasePricingToFloorPricing()" 
                        style="padding: 6px 12px; background: #f59e0b; color: white; border: none; border-radius: 6px; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 4px;"
                        title="기본 임대조건을 층별 기준가로 변환">
                    <span>↗️</span> 기준가로 등록
                </button>
            </div>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;">
                <div style="text-align: center; padding: 10px; background: white; border-radius: 6px;">
                    <div style="font-size: 11px; color: #92400e;">보증금</div>
                    <div style="font-size: 14px; font-weight: 600; color: #78350f;">${b.depositPy ? formatNumber(b.depositPy) + '원/평' : '-'}</div>
                </div>
                <div style="text-align: center; padding: 10px; background: white; border-radius: 6px;">
                    <div style="font-size: 11px; color: #92400e;">임대료</div>
                    <div style="font-size: 14px; font-weight: 600; color: #d97706;">${b.rentPy ? formatNumber(b.rentPy) + '원/평' : '-'}</div>
                </div>
                <div style="text-align: center; padding: 10px; background: white; border-radius: 6px;">
                    <div style="font-size: 11px; color: #92400e;">관리비</div>
                    <div style="font-size: 14px; font-weight: 600; color: #78350f;">${b.maintenancePy ? formatNumber(b.maintenancePy) + '원/평' : '-'}</div>
                </div>
            </div>
        </div>
        ` : ''}
        
        ${sortedPricing.length === 0 && !hasBasePricing ? (isHeavyPending(b) ? `
        <div class="empty-state" style="text-align: center; padding: 40px 20px;">
            <div style="font-size: 48px; margin-bottom: 16px; animation: creSpin 1s linear infinite; display:inline-block;">⏳</div>
            <div style="color: var(--text-muted);">기준가 불러오는 중…</div>
        </div>
        <style>@keyframes creSpin{to{transform:rotate(360deg)}}</style>
        ` : `
        <div class="empty-state" style="text-align: center; padding: 40px 20px;">
            <div style="font-size: 48px; margin-bottom: 16px;">💰</div>
            <div style="color: var(--text-muted); margin-bottom: 16px;">등록된 기준가가 없습니다</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 20px;">
                층별로 다른 임대조건을 관리할 수 있습니다<br>
                (저층부/고층부, 특정 층 프리미엄 등)
            </div>
            <button class="btn btn-primary" onclick="openPricingModal()">+ 첫 기준가 등록</button>
        </div>
        `) : sortedPricing.length === 0 ? `
        <div style="text-align: center; padding: 20px; color: var(--text-muted); font-size: 13px;">
            선택한 필터 조건에 해당하는 기준가가 없습니다.
        </div>
        ` : (() => {
            // 안내문(출처+연월)별 그룹화
            const monthOf = (fp) => { const dd = fp.effectiveDate || fp.createdAt || ''; if (dd.includes('-')) { const [y, m] = dd.split('-'); return `${y.slice(-2)}.${m}`; } return (dd || '').slice(0, 5); };
            const gmap = {};
            sortedPricing.forEach((fp, idx) => {
                const mon = monthOf(fp) || '-';
                const src = fp.sourceCompany || '직접입력';
                const key = src + '||' + mon;
                if (!gmap[key]) gmap[key] = { src, mon, items: [], hasOfficial: false };
                gmap[key].items.push({ fp, idx });
                if (fp.isOfficial) gmap[key].hasOfficial = true;
            });
            let groups = Object.values(gmap);
            groups.sort((a, c) => {
                if (a.hasOfficial !== c.hasOfficial) return a.hasOfficial ? -1 : 1;
                if (a.mon !== c.mon) return c.mon.localeCompare(a.mon);
                return a.src.localeCompare(c.src);
            });
            const latestMon = groups.reduce((mx, g) => (g.mon > mx ? g.mon : mx), '');
            // 그룹이 하나뿐이면 아코디언 헤더 없이 카드만
            if (groups.length <= 1) {
                return `<div style="display:flex; flex-direction:column; gap:12px;">${(groups[0] ? groups[0].items : []).map(({ fp, idx }) => renderPricingCard(fp, idx, b)).join('')}</div>`;
            }
            return `<div style="display:flex; flex-direction:column; gap:10px;">
                ${groups.map((g, gi) => {
                    // 기본 펼침: 최신월 또는 공식 포함 그룹
                    const expanded = (g.mon === latestMon) || g.hasOfficial;
                    const gid = 'pg_' + gi;
                    return `
                    <div class="pricing-group" data-pricing-group="${gid}" style="border:1px solid var(--border-color); border-radius:10px; overflow:hidden;">
                        <button onclick="togglePricingGroup('${gid}')" style="width:100%; display:flex; justify-content:space-between; align-items:center; gap:8px; padding:11px 14px; background:var(--bg-secondary); border:none; cursor:pointer; text-align:left;">
                            <span style="display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; color:var(--text-primary); flex-wrap:wrap;">
                                <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#8b5cf6; flex-shrink:0;"></span>
                                <span>${g.src}</span>
                                <span style="color:var(--text-muted); font-weight:500;">${g.mon}</span>
                                <span style="font-size:11px; color:var(--text-secondary); background:var(--bg-primary); padding:1px 7px; border-radius:8px; font-weight:500;">${g.items.length}개 구간</span>
                                ${g.hasOfficial ? '<span style="font-size:10px; color:#ca8a04; background:#fef3c7; padding:1px 6px; border-radius:4px; font-weight:700;">⭐공식</span>' : ''}
                                ${(g.mon === latestMon) ? '<span style="font-size:10px; color:#2563eb; background:#dbeafe; padding:1px 6px; border-radius:4px; font-weight:600;">최신</span>' : ''}
                            </span>
                            <span class="pricing-group-chevron" style="font-size:11px; color:var(--text-muted); transition:transform 0.15s; transform:rotate(${expanded ? 90 : 0}deg); flex-shrink:0;">▶</span>
                        </button>
                        <div class="pricing-group-body" data-pricing-group-body="${gid}" style="display:${expanded ? 'flex' : 'none'}; flex-direction:column; gap:12px; padding:12px; border-top:1px solid var(--border-color);">
                            ${g.items.map(({ fp, idx }) => renderPricingCard(fp, idx, b)).join('')}
                        </div>
                    </div>`;
                }).join('')}
            </div>`;
        })()}
        
        ${/* 공실 정보에서 기준가 추출 안내 */ ''}
        ${allPricing.length === 0 ? `
        <div style="margin-top: 16px; padding: 12px 16px; background: var(--bg-secondary); border-radius: 8px; font-size: 12px; color: var(--text-muted);">
            <strong>💡 Tip:</strong> 안내문 탭의 공실 정보에서도 기준가를 등록할 수 있습니다.
        </div>
        ` : ''}
    `;
}

// ★ 기준가 날짜 필터
export function filterPricingByDate(date) {
    state.selectedPricingDate = date;
    renderPricingSection();
}

// ★ 기준가 출처 필터
export function filterPricingBySource(source) {
    state.selectedPricingSource = source;
    renderPricingSection();
}

// ★ 공식 기준가로 등록
export async function setOfficialPricing(pricingId) {
    const b = state.selectedBuilding;
    if (!b) return;
    await ensureHeavyLoaded(b);          // ★ v4.4
    if (!b.floorPricing) return;
    
    const pricingIdx = b.floorPricing.findIndex(fp => fp.id === pricingId);
    if (pricingIdx === -1) {
        showToast('기준가를 찾을 수 없습니다', 'error');
        return;
    }
    
    try {
        // 기존 공식 기준가 해제 (같은 층 범위가 아닌 경우에만)
        // 여러 층별로 공식 기준가를 가질 수 있도록 함
        
        // 해당 기준가를 공식으로 설정
        b.floorPricing[pricingIdx].isOfficial = true;
        b.floorPricing[pricingIdx].officialAt = new Date().toISOString();
        
        // 기본 임대조건도 업데이트
        const officialPricing = b.floorPricing[pricingIdx];
        // 가격: 기준가 값 우선, 없으면 빌딩 기존값. 빈값/undefined면 미기록(Firebase undefined 오류 방지)
        const _pick = (a, bb) => {
            const x = (a === undefined || a === null || a === '') ? bb : a;
            return (x === undefined || x === null || x === '') ? null : x;
        };
        const _pd = _pick(officialPricing.depositPy, b.depositPy);
        const _pr = _pick(officialPricing.rentPy, b.rentPy);
        const _pm = _pick(officialPricing.maintenancePy, b.maintenancePy);
        const updateData = { floorPricing: b.floorPricing };
        if (_pd != null) { updateData.depositPy = _pd; updateData['pricing/depositPy'] = _pd; }
        if (_pr != null) { updateData.rentPy = _pr; updateData['pricing/rentPy'] = _pr; }
        if (_pm != null) { updateData.maintenancePy = _pm; updateData['pricing/maintenancePy'] = _pm; }
        
        // ★ 기준면적(전용=typicalFloorPy / 임대=typicalFloorLeasePy)·전용률도 함께 반영
        //    (OCR 기준가에 면적 정보가 있는 경우에만 — 없으면 기존값 유지)
        const _n = (v) => { const x = parseFloat(String(v ?? '').replace(/,/g, '')); return isNaN(x) ? null : x; };
        let _excArea = _n(officialPricing.exclusiveArea);   // 전용면적
        let _leaseArea = _n(officialPricing.rentArea);      // 임대면적
        let _excRate = _n(officialPricing.exclusiveRate);
        // 기준가에 면적이 없으면 같은 안내문 공실에서 추정
        if (_excArea == null && _leaseArea == null) {
            const _d = deriveAreaFromVacancies(b, officialPricing);
            if (_d.derived) { _excArea = _n(_d.exclusiveArea); _leaseArea = _n(_d.rentArea); }
        }
        if (_excRate == null && _excArea && _leaseArea) _excRate = Math.round(_excArea / _leaseArea * 1000) / 10;
        // ★ v4.5: 전용면적을 typicalFloorPy(=임대면적 필드)에 쓰지 않는다.
        // 과거에는 여기에 전용면적을 넣어, 표시부가 전용 자리에 임대값을 읽는 원인이 되었다.
        if (_excArea != null)  {
            updateData.typicalFloorExclusive = _excArea;
            updateData.exclusiveFloorPy = _excArea;
            updateData['area/exclusiveFloorPy'] = _excArea;
        }
        if (_leaseArea != null){
            updateData.typicalFloorRent = _leaseArea;
            updateData.typicalFloorLeasePy = _leaseArea;
            updateData['area/typicalFloorLeasePy'] = _leaseArea;
            updateData.typicalFloorPy = _leaseArea;
            updateData['area/typicalFloorPy'] = _leaseArea;
        }
        if (_excRate != null)  { updateData.exclusiveRate = _excRate;        updateData['area/exclusiveRate'] = _excRate; }
        
        // Firebase는 undefined 값을 거부 — 방어적으로 undefined 키 제거
        Object.keys(updateData).forEach(k => { if (updateData[k] === undefined) delete updateData[k]; });
        await update(ref(db, `buildings/${b.id}`), updateData);
        
        // 로컬 상태 업데이트 (정의된 값만)
        if (_pd != null) state.selectedBuilding.depositPy = _pd;
        if (_pr != null) state.selectedBuilding.rentPy = _pr;
        if (_pm != null) state.selectedBuilding.maintenancePy = _pm;
        
        // _raw도 업데이트
        if (state.selectedBuilding._raw) {
            const _raw = state.selectedBuilding._raw;
            if (_pd != null) _raw.depositPy = _pd;
            if (_pr != null) _raw.rentPy = _pr;
            if (_pm != null) _raw.maintenancePy = _pm;
            _raw.pricing = _raw.pricing || {};
            if (_pd != null) _raw.pricing.depositPy = _pd;
            if (_pr != null) _raw.pricing.rentPy = _pr;
            if (_pm != null) _raw.pricing.maintenancePy = _pm;
        }
        
        // allBuildings에서도 업데이트 (목록 표시용)
        const buildingInAll = state.allBuildings.find(bd => bd.id === b.id);
        if (buildingInAll) {
            if (_pd != null) buildingInAll.depositPy = _pd;
            if (_pr != null) buildingInAll.rentPy = _pr;
            if (_pm != null) buildingInAll.maintenancePy = _pm;
        }
        
        // 면적/전용률 로컬 반영 (루트 + area 둘 다)
        const _applyArea = (obj) => {
            if (!obj) return;
            // ★ v4.5: 전용은 exclusiveFloorPy, 임대는 typicalFloorPy 계열로 분리
            if (_excArea != null) { obj.typicalFloorExclusive = _excArea; obj.exclusiveFloorPy = _excArea; }
            if (_leaseArea != null) {
                obj.typicalFloorRent = _leaseArea;
                obj.typicalFloorLeasePy = _leaseArea;
                obj.typicalFloorPy = _leaseArea;
            }
            if (_excRate != null) obj.exclusiveRate = _excRate;
            if (_excArea != null || _leaseArea != null || _excRate != null) {
                obj.area = obj.area || {};
                if (_excArea != null) obj.area.exclusiveFloorPy = _excArea;
                if (_leaseArea != null) {
                    obj.area.typicalFloorLeasePy = _leaseArea;
                    obj.area.typicalFloorPy = _leaseArea;
                }
                if (_excRate != null) obj.area.exclusiveRate = _excRate;
            }
        };
        _applyArea(state.selectedBuilding);
        _applyArea(state.selectedBuilding?._raw);
        _applyArea(buildingInAll);
        
        showToast(`'${officialPricing.label || '기준가'}'가 공식 기준가로 적용되었습니다`, 'success');
        renderPricingSection();
        renderInfoSection();
        
        // 빌딩 목록도 새로고침
        if (window.renderBuildingList) {
            window.renderBuildingList();
        }
        
    } catch (error) {
        console.error('공식 기준가 등록 오류:', error);
        showToast('등록 중 오류가 발생했습니다', 'error');
    }
}

// ★ 공식 기준가 해제
export async function unsetOfficialPricing(pricingId) {
    const b = state.selectedBuilding;
    if (!b) return;
    await ensureHeavyLoaded(b);          // ★ v4.4
    if (!b.floorPricing) return;
    
    const pricingIdx = b.floorPricing.findIndex(fp => fp.id === pricingId);
    if (pricingIdx === -1) {
        showToast('기준가를 찾을 수 없습니다', 'error');
        return;
    }
    
    try {
        // 공식 해제
        b.floorPricing[pricingIdx].isOfficial = false;
        delete b.floorPricing[pricingIdx].officialAt;
        
        await set(ref(db, `buildings/${b.id}/floorPricing`), b.floorPricing);
        
        showToast('공식 기준가가 해제되었습니다', 'success');
        renderPricingSection();
        
    } catch (error) {
        console.error('공식 기준가 해제 오류:', error);
        showToast('해제 중 오류가 발생했습니다', 'error');
    }
}

// ★ 기준가 수정 모달 열기
export function editPricing(pricingId) {
    const b = state.selectedBuilding;
    if (!b) return;

    const pricing = (b.floorPricing || []).find(fp => fp.id === pricingId);
    if (!pricing) {
        // ★ v4.4: 중량 필드가 아직 안 왔으면 받아온 뒤 한 번 더 시도
        if (!b._heavyLoaded) {
            ensureHeavyLoaded(b).then(() => {
                if (state.selectedBuilding === b) editPricing(pricingId);
            });
            return;
        }
        showToast('기준가를 찾을 수 없습니다', 'error');
        return;
    }
    
    // 모달에 데이터 채우기
    document.getElementById('editPricingId').value = pricingId;
    document.getElementById('editPricingLabel').value = pricing.label || '';
    document.getElementById('editPricingFloorRange').value = pricing.floorRange || '';
    document.getElementById('editPricingDepositPy').value = pricing.depositPy || '';
    document.getElementById('editPricingRentPy').value = pricing.rentPy || '';
    document.getElementById('editPricingMaintenancePy').value = pricing.maintenancePy || '';
    document.getElementById('editPricingDate').value = pricing.effectiveDate || '';
    document.getElementById('editPricingNotes').value = pricing.notes || '';
    
    // 출처 정보 표시
    const sourceInfo = document.getElementById('editPricingSourceInfo');
    if (pricing.sourceType === 'ocr') {
        sourceInfo.innerHTML = `<span style="color: #3b82f6;">📄 OCR 추출 (${pricing.sourceCompany || '알 수 없음'})</span>`;
    } else if (pricing.sourceType === 'migration') {
        sourceInfo.innerHTML = `<span style="color: #8b5cf6;">🔄 마이그레이션</span>`;
    } else {
        sourceInfo.innerHTML = `<span style="color: #6b7280;">✏️ 수동 입력</span>`;
    }
    
    // 공식 여부 표시
    const officialInfo = document.getElementById('editPricingOfficialInfo');
    if (pricing.isOfficial) {
        officialInfo.innerHTML = `<span style="color: #eab308; font-weight: 600;">⭐ 공식 기준가로 지정됨</span>`;
    } else {
        officialInfo.innerHTML = `<span style="color: #9ca3af;">일반 기준가</span>`;
    }
    
    // 모달 표시
    document.getElementById('editPricingModal').style.display = 'block';
    document.getElementById('modalOverlay').style.display = 'block';
}

// ★ 기준가 수정 저장
export async function saveEditPricing() {
    const b = state.selectedBuilding;
    if (!b) return;
    await ensureHeavyLoaded(b);          // ★ v4.4
    
    const pricingId = document.getElementById('editPricingId').value;
    const pricingIdx = b.floorPricing?.findIndex(fp => fp.id === pricingId);
    
    if (pricingIdx === -1 || pricingIdx === undefined) {
        showToast('기준가를 찾을 수 없습니다', 'error');
        return;
    }
    
    // 입력값 수집
    const label = document.getElementById('editPricingLabel').value.trim();
    const floorRange = document.getElementById('editPricingFloorRange').value.trim();
    const depositPy = parseFloat(document.getElementById('editPricingDepositPy').value) || 0;
    const rentPy = parseFloat(document.getElementById('editPricingRentPy').value) || 0;
    const maintenancePy = parseFloat(document.getElementById('editPricingMaintenancePy').value) || 0;
    const effectiveDate = document.getElementById('editPricingDate').value.trim();
    const notes = document.getElementById('editPricingNotes').value.trim();
    
    // 검증
    if (!label) {
        showToast('라벨을 입력해주세요', 'warning');
        return;
    }
    if (!rentPy) {
        showToast('임대료를 입력해주세요', 'warning');
        return;
    }
    
    try {
        // 데이터 업데이트
        const updatedPricing = {
            ...b.floorPricing[pricingIdx],
            label,
            floorRange,
            depositPy,
            rentPy,
            maintenancePy,
            effectiveDate,
            notes,
            updatedAt: new Date().toISOString()
        };
        
        b.floorPricing[pricingIdx] = updatedPricing;
        
        // Firebase 저장
        await update(ref(db, `buildings/${b.id}`), { floorPricing: b.floorPricing });
        
        // 공식 기준가면 기본 임대조건도 업데이트
        if (updatedPricing.isOfficial) {
            await update(ref(db, `buildings/${b.id}`), {
                depositPy: depositPy,
                rentPy: rentPy,
                maintenancePy: maintenancePy
            });
            state.selectedBuilding.depositPy = depositPy;
            state.selectedBuilding.rentPy = rentPy;
            state.selectedBuilding.maintenancePy = maintenancePy;
        }
        
        showToast('기준가가 수정되었습니다', 'success');
        closeEditPricingModal();
        renderPricingSection();
        renderBasicInfo();
        if (window.applyFilters) window.applyFilters();  // ★ v#5: 빌딩 리스트 기준가 stale 방지
        
    } catch (error) {
        console.error('기준가 수정 오류:', error);
        showToast('수정 중 오류가 발생했습니다', 'error');
    }
}

// ★ 기준가 수정 모달 닫기
export function closeEditPricingModal() {
    document.getElementById('editPricingModal').style.display = 'none';
    document.getElementById('modalOverlay').style.display = 'none';
}

// ★ 기준가 삭제
export async function deletePricing(pricingId) {
    const b = state.selectedBuilding;
    if (!b) return;
    await ensureHeavyLoaded(b);          // ★ v4.4
    if (!b.floorPricing) return;
    
    const pricingIdx = b.floorPricing.findIndex(fp => fp.id === pricingId);
    if (pricingIdx === -1) {
        showToast('기준가를 찾을 수 없습니다', 'error');
        return;
    }
    
    const pricing = b.floorPricing[pricingIdx];
    
    // 공식 기준가면 경고
    let confirmMsg = `"${pricing.label || '기준가'}"을(를) 삭제하시겠습니까?`;
    if (pricing.isOfficial) {
        confirmMsg = `⚠️ "${pricing.label}"은(는) 공식 기준가입니다.\n\n삭제하면 기본 임대조건에 영향을 줄 수 있습니다.\n정말 삭제하시겠습니까?`;
    }
    
    if (!confirm(confirmMsg)) return;
    
    try {
        // 배열에서 제거
        b.floorPricing.splice(pricingIdx, 1);
        
        // Firebase 저장
        await set(ref(db, `buildings/${b.id}/floorPricing`), b.floorPricing);
        
        showToast('기준가가 삭제되었습니다', 'success');
        renderPricingSection();
        
    } catch (error) {
        console.error('기준가 삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다', 'error');
    }
}

// ===== 담당자 섹션 =====

export function renderContactSection() {
    const b = state.selectedBuilding;
    const contacts = b.contactPoints || [];
    
    // 담당자 수 업데이트
    document.getElementById('contactCount').textContent = contacts.length;
    
    // 타입별 아이콘 & 라벨
    const typeIcons = { owner: '🏢', manager: '🔧', broker: '🤝', sni: '🏷️', other: '👤' };
    const typeLabels = { owner: '빌딩주/임대팀', manager: '관리사무소', broker: '중개사', sni: 'S&I 담당자', other: '기타' };
    
    // 우리 담당자 / 기타 분리
    const ourManagers = contacts.filter(c => c.isOurManager || c.type === 'sni');
    const otherContacts = contacts.filter(c => !c.isOurManager && c.type !== 'sni');
    
    // 현재 지정된 담당자
    const assignedManager = b.assignedManager || b._raw?.assignedManager;
    const assignedContact = assignedManager ? contacts.find(c => c.id === assignedManager.contactId) : null;
    
    document.getElementById('sectionContact').innerHTML = `
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px;">
            <span style="flex-shrink: 0;">👤 담당자 목록</span>
            <div style="display: flex; gap: 6px; flex-shrink: 0; align-items: center;">
                <button class="btn btn-secondary btn-sm" style="width: auto; flex: 0 0 auto; padding: 6px 12px; white-space: nowrap;" onclick="refreshContactSection()" title="새로고침">🔄</button>
                <button class="btn btn-sm" style="width: auto; flex: 0 0 auto; background: var(--bg-tertiary); color: var(--text-primary); padding: 6px 12px; white-space: nowrap;" onclick="openAssignManagerModal()">📋 담당자 지정</button>
                <button class="btn btn-primary btn-sm" style="width: auto; flex: 0 0 auto; padding: 6px 16px; white-space: nowrap;" onclick="openContactModal()">+ 추가</button>
            </div>
        </div>
        
        <!-- 현재 지정된 임대안내문 담당자 -->
        ${assignedContact ? `
        <div style="background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; border-left: 4px solid #2563eb;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <div style="font-size: 11px; font-weight: 600; color: #1e40af; margin-bottom: 4px;">📋 임대안내문 담당자</div>
                    <div style="font-size: 14px; font-weight: 600; color: #1e3a8a;">${assignedContact.name}</div>
                    <div style="font-size: 12px; color: #3b82f6;">${assignedContact.phone} ${assignedContact.company ? '· ' + assignedContact.company : ''}</div>
                </div>
                <div style="font-size: 11px; color: #6b7280;">
                    ${assignedManager.assignedAt ? new Date(assignedManager.assignedAt).toLocaleDateString('ko-KR') : ''} 지정
                </div>
            </div>
        </div>
        ` : ''}
        
        ${contacts.length === 0 ? `
        <div class="empty-state" style="text-align: center; padding: 40px 20px;">
            <div style="font-size: 48px; margin-bottom: 16px;">👤</div>
            <div style="color: var(--text-muted); margin-bottom: 16px;">등록된 담당자가 없습니다</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 20px;">
                빌딩 임대팀, 관리사무소, 중개사 등<br>
                연락처를 관리할 수 있습니다
            </div>
            <button class="btn btn-primary" onclick="openContactModal()">+ 첫 담당자 등록</button>
        </div>
        ` : `
        
        <!-- 우리 담당자 (S&I) -->
        ${ourManagers.length > 0 ? `
        <div style="margin-bottom: 16px;">
            <div style="font-size: 12px; font-weight: 600; color: #16a34a; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                🏷️ 우리 담당자 (S&I)
                <span style="font-size: 10px; padding: 2px 6px; background: #dcfce7; border-radius: 10px;">${ourManagers.length}</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px;">
                ${ourManagers.map(c => renderContactCard(c, typeIcons, typeLabels, true)).join('')}
            </div>
        </div>
        ` : ''}
        
        <!-- 기타 담당자 -->
        ${otherContacts.length > 0 ? `
        <div>
            <div style="font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                👤 기타 담당자
                <span style="font-size: 10px; padding: 2px 6px; background: var(--bg-tertiary); border-radius: 10px;">${otherContacts.length}</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px;">
                ${otherContacts.sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)).map(c => renderContactCard(c, typeIcons, typeLabels, false)).join('')}
            </div>
        </div>
        ` : ''}
        `}
    `;
}

// ★ v3.10: 담당자 카드 렌더링 헬퍼 (수정/삭제 파라미터 추가)
function renderContactCard(c, typeIcons, typeLabels, isOurManager) {
    const borderColor = c.isPrimary ? 'var(--accent-color)' : (isOurManager ? '#16a34a' : 'var(--border-color)');
    const bgColor = isOurManager ? 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)' : 'var(--bg-secondary)';
    const buildingId = state.selectedBuilding?.id || '';
    const contactName = (c.name || '').replace(/'/g, "\\'");
    
    return `
        <div class="contact-card" style="background: ${bgColor}; border-radius: 10px; padding: 14px 16px; border: 1px solid ${borderColor}; ${c.isPrimary ? 'box-shadow: 0 0 0 1px var(--accent-color);' : ''}">
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div style="display: flex; gap: 12px; align-items: flex-start;">
                    <div style="width: 40px; height: 40px; border-radius: 50%; background: ${isOurManager ? '#bbf7d0' : 'var(--bg-tertiary)'}; display: flex; align-items: center; justify-content: center; font-size: 18px;">
                        ${typeIcons[c.type] || '👤'}
                    </div>
                    <div>
                        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                            <span style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${c.name}</span>
                            ${c.position ? `<span style="font-size: 10px; padding: 2px 6px; background: #e5e7eb; color: #374151; border-radius: 4px;">${c.position}</span>` : ''}
                            ${c.isPrimary ? '<span style="font-size: 10px; padding: 2px 6px; background: var(--accent-color); color: white; border-radius: 4px;">주 담당</span>' : ''}
                            ${isOurManager ? '<span style="font-size: 10px; padding: 2px 6px; background: #16a34a; color: white; border-radius: 4px;">S&I</span>' : ''}
                        </div>
                        <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${typeLabels[c.type] || c.type} ${c.company ? '· ' + c.company : ''}</div>
                        <div style="display: flex; gap: 12px; margin-top: 8px; font-size: 13px;">
                            <a href="tel:${c.phone}" style="color: var(--accent-color); text-decoration: none;">📞 ${c.phone}</a>
                            ${c.email ? `<a href="mailto:${c.email}" style="color: var(--text-secondary); text-decoration: none;">✉️ ${c.email}</a>` : ''}
                        </div>
                        ${c.notes ? `<div style="font-size: 11px; color: var(--text-muted); margin-top: 6px; font-style: italic;">${c.notes}</div>` : ''}
                    </div>
                </div>
                <div class="contact-actions" style="display: flex; gap: 4px; flex-direction: row;">
                    <button class="contact-action-btn edit" onclick="editContact('${c.id}', '${buildingId}')" title="수정">✏️</button>
                    <button class="contact-action-btn delete" onclick="deleteContact('${c.id}', '${buildingId}', '${contactName}')" title="삭제">🗑️</button>
                </div>
            </div>
        </div>
    `;
}

// ===== 렌트롤 섹션 =====

export function renderRentrollSection() {
    const b = state.selectedBuilding;
    const allRentrolls = b.rentrolls || [];
    
    // 사용 가능한 기준월 추출 (다양한 날짜 필드 지원)
    const dateSet = new Set();
    allRentrolls.forEach(r => {
        const dateValue = r.targetDate || r.date || r.recordDate || r.month || r.baseMonth || r.baseDate;
        if (dateValue) {
            dateSet.add(dateValue);
            r._displayDate = dateValue;
        }
    });
    const availableDates = Array.from(dateSet).sort().reverse();
    
    // 기본값: 가장 최신 월
    if (!state.selectedRentrollDate || (state.selectedRentrollDate !== 'all' && !availableDates.includes(state.selectedRentrollDate))) {
        state.selectedRentrollDate = availableDates.length > 0 ? availableDates[0] : 'all';
    }
    
    // 필터링
    let filteredList = allRentrolls;
    if (state.selectedRentrollDate !== 'all' && availableDates.length > 0) {
        filteredList = allRentrolls.filter(r => r._displayDate === state.selectedRentrollDate);
    }
    
    // 층별 정렬 (높은 층 먼저)
    filteredList = [...filteredList].sort((a, b) => (parseInt(b.floor) || 0) - (parseInt(a.floor) || 0));
    
    // 각 월별 건수 계산
    const countByDate = {};
    allRentrolls.forEach(r => {
        const d = r._displayDate || 'unknown';
        countByDate[d] = (countByDate[d] || 0) + 1;
    });
    
    document.getElementById('sectionRentroll').innerHTML = `
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 12px;">
            <span style="flex-shrink: 0;">렌트롤 목록</span>
            <div style="display: flex; gap: 6px; flex-shrink: 0; align-items: center;">
                <button class="btn btn-secondary btn-sm" style="width: auto; flex: 0 0 auto; padding: 6px 12px; white-space: nowrap;" onclick="refreshRentrollSection()" title="새로고침">🔄</button>
                <button class="btn btn-primary btn-sm" style="width: auto; flex: 0 0 auto; padding: 6px 16px; white-space: nowrap;" onclick="openRentrollModal()">+ 추가</button>
            </div>
        </div>
        
        ${availableDates.length > 0 ? `
        <div class="timeline-filter">
            <span class="timeline-label">📅 기준월</span>
            <div class="timeline-tabs">
                <div class="timeline-tab timeline-all ${state.selectedRentrollDate === 'all' ? 'active' : ''}" onclick="filterRentrollByDate('all')">
                    전체<span class="count">${allRentrolls.length}</span>
                </div>
                ${availableDates.slice(0, 6).map(d => `
                    <div class="timeline-tab ${state.selectedRentrollDate === d ? 'active' : ''}" onclick="filterRentrollByDate('${d}')">
                        ${d}<span class="count">${countByDate[d] || 0}</span>
                    </div>
                `).join('')}
                ${availableDates.length > 6 ? `<div class="timeline-tab" style="color: var(--text-muted);">+${availableDates.length - 6}개</div>` : ''}
            </div>
        </div>
        ` : '<div style="padding:8px 12px;background:var(--bg-secondary);border-radius:6px;font-size:12px;color:var(--text-muted);margin-bottom:12px;">⚠️ 기준월(targetDate) 정보가 없어 시계열 필터를 사용할 수 없습니다</div>'}
        
        ${filteredList.length === 0 ? '<div class="empty-state">렌트롤 정보가 없습니다</div>' : `
        <div class="rentroll-summary">
            <div class="rentroll-summary-item"><span class="dot occupied"></span> 입주 ${filteredList.length}건</div>
            ${state.selectedRentrollDate !== 'all' && availableDates.length > 0 ? `<div class="rentroll-summary-item" style="color: var(--accent-color);">📌 ${state.selectedRentrollDate} 기준</div>` : ''}
        </div>
        <table class="rentroll-table">
            <thead><tr><th style="width:60px;">층</th><th>입주사</th><th style="width:120px;">계약기간</th><th>비고</th><th style="width:50px;"></th></tr></thead>
            <tbody>
                ${filteredList.map(r => `
                    <tr>
                        <td><span class="floor-badge">${formatFloorDisplay(r.floor)}</span></td>
                        <td>
                            <div class="tenant-name">${r.tenant?.name || r.tenant || '-'}</div>
                            <div class="meta-info">${(r.author || '-').split('@')[0]} · ${r._displayDate || r.targetDate || '-'}</div>
                        </td>
                        <td><div class="contract-period">${r.contract?.period || (r.contract?.startDate ? r.contract.startDate + '~' + (r.contract.endDate || '') : '-')}</div></td>
                        <td>${r.note ? `<div class="note-text">${r.note}</div>` : '<span style="color:var(--text-muted);">-</span>'}</td>
                        <td>
                            <div class="row-actions">
                                <button class="row-action-btn" onclick="editRentroll('${r.id}')" title="수정">✏️</button>
                                <button class="row-action-btn delete" onclick="deleteRentroll('${r.id}')" title="삭제">×</button>
                            </div>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>`}
    `;
}

// 렌트롤 날짜 필터
export function filterRentrollByDate(date) {
    state.selectedRentrollDate = date;
    renderRentrollSection();
}

// ===== 메모 섹션 =====

// ★ v#5-hotfix5: 렌트롤·기준가·인센티브·담당자 4개 메뉴의 async refresh 함수 신설
//   메모 패턴과 동일 — Firebase 직접 fetch + state 갱신 + render

/** 렌트롤 새로고침 — rentrolls 컬렉션에서 buildingId/Name 매칭 */
export async function refreshRentrollSection() {
    if (!state.selectedBuilding) return;
    const bid = state.selectedBuilding.id;
    const bname = state.selectedBuilding.name;
    try {
        const snap = await get(ref(db, 'rentrolls'));
        const all = snap.val() || {};
        const matched = Object.entries(all)
            .filter(([k, r]) => r && k !== '_schema' && (r.buildingId === bid || r.buildingId === bname || r.buildingName === bname))
            .map(([k, r]) => ({ ...r, id: k }));
        state.selectedBuilding.rentrolls = matched;
        const idx = state.allBuildings.findIndex(b => b.id === bid);
        if (idx >= 0) state.allBuildings[idx].rentrolls = matched;
        renderRentrollSection();
    } catch (e) { console.error('렌트롤 새로고침 실패:', e); }
}

/** 기준가 새로고침 — buildings/{id}/floorPricing 직접 path */
export async function refreshPricingSection() {
    if (!state.selectedBuilding) return;
    const bid = state.selectedBuilding.id;
    try {
        const snap = await get(ref(db, `buildings/${bid}/floorPricing`));
        const val = snap.val() || [];
        const arr = Array.isArray(val) ? val : Object.entries(val).map(([k, v]) => (v && typeof v === 'object' ? { ...v, id: v.id || k } : v));
        state.selectedBuilding.floorPricing = arr;
        const idx = state.allBuildings.findIndex(b => b.id === bid);
        if (idx >= 0) state.allBuildings[idx].floorPricing = arr;
        renderPricingSection();
    } catch (e) { console.error('기준가 새로고침 실패:', e); }
}

/** 인센티브 새로고침 — buildings/{id}/incentives 직접 path */
export async function refreshIncentiveSection() {
    if (!state.selectedBuilding) return;
    const bid = state.selectedBuilding.id;
    try {
        const snap = await get(ref(db, `buildings/${bid}/incentives`));
        const val = snap.val() || [];
        const arr = Array.isArray(val) ? val : Object.values(val).filter(v => v != null);
        state.selectedBuilding.incentives = arr;
        const idx = state.allBuildings.findIndex(b => b.id === bid);
        if (idx >= 0) state.allBuildings[idx].incentives = arr;
        renderIncentiveSection();
    } catch (e) { console.error('인센티브 새로고침 실패:', e); }
}

/** 담당자 새로고침 — buildings/{id}/contactPoints 직접 path */
export async function refreshContactSection() {
    if (!state.selectedBuilding) return;
    const bid = state.selectedBuilding.id;
    console.log('🔄 담당자 새로고침:', bid, state.selectedBuilding.name || '');
    try {
        const snap = await get(ref(db, `buildings/${bid}/contactPoints`));
        const val = snap.val() || [];
        const arr = Array.isArray(val) ? val : Object.entries(val).map(([k, v]) => (v && typeof v === 'object' ? { ...v, id: v.id || k } : v));
        state.selectedBuilding.contactPoints = arr;
        const idx = state.allBuildings.findIndex(b => b.id === bid);
        if (idx >= 0) state.allBuildings[idx].contactPoints = arr;
        renderContactSection();
        showToast(`담당자 ${arr.length}명 새로고침`, 'success');
    } catch (e) { console.error('담당자 새로고침 실패:', e); showToast('담당자 새로고침 실패', 'error'); }
}

// ★ v3.2: 메모 새로고침 (Firebase에서 최신 데이터 다시 불러오기)
export async function refreshMemoSection() {
    if (!state.selectedBuilding) return;
    
    const buildingId = state.selectedBuilding.id;
    const buildingName = state.selectedBuilding.name;
    console.log('🔄 메모 새로고침:', buildingId, buildingName);
    
    try {
        // ★ v4.2: 루트 memos 컬렉션에서 읽기 (portal-data.js와 동일한 경로)
        const snapshot = await get(ref(db, 'memos'));
        const allMemos = snapshot.val() || {};
        
        // buildingId 또는 buildingName으로 매칭 (buildIndex/lookupIndex와 동일 로직)
        const memos = Object.entries(allMemos)
            .filter(([key, m]) => {
                if (!m || key === '_schema') return false;
                return m.buildingId === buildingId || m.buildingName === buildingName;
            })
            .map(([key, m]) => ({ ...m, id: key }));
        
        console.log(`📋 메모 ${memos.length}개 로드 (memos 컬렉션, content 확인: ${memos.every(m => m.content) ? '✅' : '⚠️ content 누락 있음'})`);
        state.selectedBuilding.memos = memos;
        
        // allBuildings에서도 동기화
        const idx = state.allBuildings.findIndex(b => b.id === buildingId);
        if (idx >= 0) {
            state.allBuildings[idx].memos = memos;
            state.allBuildings[idx].memoCount = memos.length;
        }
        
        // 화면 다시 렌더링
        renderMemoSection();
    } catch (e) {
        console.error('메모 새로고침 실패:', e);
    }
}

export function renderMemoSection() {
    const b = state.selectedBuilding;
    if (!b) return;
    
    try {
        // ★ v4.2: null/undefined 항목 필터링 (Firebase 배열 복원 시 null 발생 가능)
        const rawMemos = (b.memos || []).filter(m => m != null && typeof m === 'object');
        const list = rawMemos.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        
        // 메모 개수 배지 업데이트
        const countEl = document.getElementById('memoCount');
        if (countEl) {
            countEl.textContent = list.length;
        }
        
        const headerHtml = `<div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 12px;">
            <span style="flex-shrink: 0;">메모 목록</span>
            <div style="display: flex; gap: 6px; flex-shrink: 0; align-items: center;">
                <button class="btn btn-secondary btn-sm" style="width: auto; flex: 0 0 auto; padding: 6px 12px; white-space: nowrap;" onclick="refreshMemoSection()" title="새로고침">🔄</button>
                <button class="btn btn-primary btn-sm" style="width: auto; flex: 0 0 auto; padding: 6px 16px; white-space: nowrap;" onclick="openMemoModal()">+ 추가</button>
            </div>
        </div>`;
        
        let memosHtml = '';
        if (list.length === 0) {
            memosHtml = '<div class="empty-state">메모가 없습니다</div>';
        } else {
            // ★ v4.2: 각 메모를 개별 생성하여 pre-wrap 내부 여백 문제 방지
            memosHtml = list.map(m => {
                const prefix = (m.pinned ? '📌 ' : '') + (m.showInLeasingGuide ? '<span style="background:#fef3c7; color:#92400e; padding:2px 6px; border-radius:4px; font-size:10px; margin-right:4px; font-weight:500;">안내문</span>' : '');
                const content = m.content || '';
                const author = ((m.author || m.createdBy || '-').split('@')[0]);
                const date = m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '-';
                return '<div class="memo-item ' + (m.pinned ? 'pinned' : '') + '" style="position: relative; padding: 10px 12px !important; background: var(--bg-secondary); border-radius: 8px; margin-bottom: 8px; border: 1px solid var(--border-color); text-align: left !important; display: block !important;">'
                    + '<div class="memo-content" style="font-size: 13px; line-height: 1.5; margin: 0 0 6px 0 !important; padding: 0 !important; text-align: left !important; white-space: pre-wrap; word-break: break-word; display: block !important;">'
                    + prefix + content
                    + '</div>'
                    + '<div class="memo-meta" style="display: flex; justify-content: space-between; align-items: center; padding: 0 !important; margin: 0 !important;">'
                    + '<span style="font-size: 11px; color: var(--text-muted);">' + author + ' · ' + date + '</span>'
                    + '<div style="display: flex !important; gap: 6px; opacity: 1 !important; visibility: visible !important;">'
                    + '<button onclick="editMemo(\'' + m.id + '\')" title="수정" style="padding: 4px 10px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 4px; cursor: pointer; font-size: 12px;">✏️</button>'
                    + '<button onclick="deleteMemo(\'' + m.id + '\')" title="삭제" style="padding: 4px 10px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 4px; cursor: pointer; font-size: 12px; color: #dc2626;">×</button>'
                    + '</div></div></div>';
            }).join('');
        }
        
        document.getElementById('sectionMemo').innerHTML = headerHtml + memosHtml;
    } catch (e) {
        console.error('❌ renderMemoSection 오류:', e);
        document.getElementById('sectionMemo').innerHTML = '<div class="empty-state">메모 로딩 중 오류 발생</div>';
    }
}

// ★ v3.2: 메모 모달 열기
window.openMemoModal = function(memoId = null) {
    if (!state.selectedBuilding) return;
    
    const modal = document.getElementById('memoModal');
    const title = modal.querySelector('.modal-title');
    
    // 폼 초기화
    document.getElementById('memoId').value = '';
    document.getElementById('memoText').value = '';
    document.getElementById('memoPinned').checked = false;
    document.getElementById('memoShowInGuide').checked = false;
    
    if (memoId) {
        // 수정 모드
        const memo = (state.selectedBuilding.memos || []).find(m => m.id === memoId);
        if (memo) {
            title.textContent = '메모 수정';
            document.getElementById('memoId').value = memo.id;
            document.getElementById('memoText').value = memo.content || '';
            document.getElementById('memoPinned').checked = memo.pinned || false;
            document.getElementById('memoShowInGuide').checked = memo.showInLeasingGuide || false;
        }
    } else {
        title.textContent = '메모 추가';
    }
    
    modal.classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
};

// ★ v3.2: 메모 수정
window.editMemo = function(memoId) {
    window.openMemoModal(memoId);
};

// ★ v4.2: 메모 저장 — 루트 memos 컬렉션에 저장 (portal-data.js와 동일 경로)
window.saveMemo = async function() {
    if (!state.selectedBuilding) return;
    
    const memoId = document.getElementById('memoId').value;
    const content = document.getElementById('memoText').value.trim();
    const pinned = document.getElementById('memoPinned').checked;
    const showInLeasingGuide = document.getElementById('memoShowInGuide').checked;
    
    if (!content) {
        showToast('메모 내용을 입력하세요', 'warning');
        return;
    }
    
    try {
        const b = state.selectedBuilding;
        
        // ★ v4.2: 임대안내문 표기 체크 시, 같은 빌딩의 다른 메모들 체크 해제 (라디오 방식)
        if (showInLeasingGuide) {
            const otherGuide = (b.memos || []).filter(m => m.showInLeasingGuide && m.id !== memoId);
            for (const m of otherGuide) {
                await update(ref(db, `memos/${m.id}`), { showInLeasingGuide: false });
            }
        }
        
        if (memoId) {
            // ★ 수정: 루트 memos 컬렉션의 해당 문서 업데이트
            await update(ref(db, `memos/${memoId}`), {
                content,
                pinned,
                showInLeasingGuide,
                updatedAt: new Date().toISOString(),
                updatedBy: state.currentUser?.email
            });
            
            // 로컬 상태 업데이트
            const idx = (b.memos || []).findIndex(m => m.id === memoId);
            if (idx >= 0) {
                b.memos[idx] = { ...b.memos[idx], content, pinned, showInLeasingGuide, updatedAt: new Date().toISOString(), updatedBy: state.currentUser?.email };
            }
            // 임대안내문 해제 반영
            if (showInLeasingGuide) {
                b.memos.forEach(m => { if (m.id !== memoId) m.showInLeasingGuide = false; });
            }
        } else {
            // ★ 추가: 루트 memos 컬렉션에 새 문서 push
            const newRef = push(ref(db, 'memos'));
            const newKey = newRef.key;
            const newMemo = {
                buildingId: b.id,
                buildingName: b.name,
                content,
                pinned,
                showInLeasingGuide,
                createdAt: new Date().toISOString(),
                createdBy: state.currentUser?.email,
                author: state.currentUser?.email
            };
            await set(newRef, newMemo);
            
            // 로컬 상태 업데이트 (id는 Firebase key)
            if (!b.memos) b.memos = [];
            // 임대안내문 해제 반영
            if (showInLeasingGuide) {
                b.memos.forEach(m => { m.showInLeasingGuide = false; });
            }
            b.memos.push({ ...newMemo, id: newKey });
        }
        
        // ★ v4.2: 저장 시간 기록 (탭 전환 시 불필요한 새로고침 방지)
        state.lastMemoActionTime = Date.now();
        
        // allBuildings에서도 동기화
        const allIdx = state.allBuildings.findIndex(building => building.id === b.id);
        if (allIdx >= 0) {
            state.allBuildings[allIdx].memos = b.memos;
            state.allBuildings[allIdx].memoCount = b.memos.length;
        }
        
        // 메모 개수 배지 업데이트
        const countEl = document.getElementById('memoCount');
        if (countEl) {
            countEl.textContent = b.memos.length;
        }
        
        // 모달 닫기
        document.getElementById('memoModal').classList.remove('show');
        document.getElementById('modalOverlay').classList.remove('show');
        
        // 화면 갱신
        renderMemoSection();
        if (window.applyFilters) window.applyFilters();  // ★ v#5: 빌딩 리스트 메모 카운트 stale 방지
        showToast(memoId ? '메모가 수정되었습니다' : '메모가 추가되었습니다', 'success');
    } catch (e) {
        console.error('메모 저장 오류:', e);
        showToast('저장 실패', 'error');
    }
};

// ★ v4.2: 메모 삭제 — 루트 memos 컬렉션에서 삭제
window.deleteMemo = async function(memoId) {
    console.log('🗑️ 메모 삭제 시도:', memoId);
    if (!state.selectedBuilding) {
        console.log('❌ selectedBuilding 없음');
        return;
    }
    if (!confirm('이 메모를 삭제하시겠습니까?')) {
        console.log('❌ 사용자 취소');
        return;
    }
    
    try {
        const b = state.selectedBuilding;
        const beforeCount = (b.memos || []).length;
        
        // ★ v4.2: 루트 memos 컬렉션에서 삭제
        await remove(ref(db, `memos/${memoId}`));
        console.log('✅ Firebase memos/' + memoId + ' 삭제 완료');
        
        // ★ v4.2: 삭제 시간 기록 (탭 전환 시 불필요한 새로고침 방지)
        state.lastMemoActionTime = Date.now();
        
        // 로컬 상태 업데이트
        b.memos = (b.memos || []).filter(m => m.id !== memoId);
        const afterCount = b.memos.length;
        console.log(`📝 메모 개수: ${beforeCount} → ${afterCount}`);
        
        // allBuildings에서도 동기화
        const idx = state.allBuildings.findIndex(building => building.id === b.id);
        if (idx >= 0) {
            state.allBuildings[idx].memos = b.memos;
            state.allBuildings[idx].memoCount = b.memos.length;
        }
        
        // 메모 개수 배지 업데이트
        const countEl = document.getElementById('memoCount');
        if (countEl) {
            countEl.textContent = b.memos.length;
        }
        
        // 화면 갱신 (로컬 데이터로)
        renderMemoSection();
        showToast('메모가 삭제되었습니다', 'success');
    } catch (e) {
        console.error('❌ 메모 삭제 오류:', e);
        showToast('삭제 실패: ' + e.message, 'error');
    }
};

// 메모 폼 제출 이벤트 등록
document.addEventListener('DOMContentLoaded', function() {
    const memoForm = document.getElementById('memoForm');
    if (memoForm) {
        memoForm.addEventListener('submit', function(e) {
            e.preventDefault();
            window.saveMemo();
        });
    }
});

// 전역 함수 등록
window.refreshMemoSection = refreshMemoSection;
// ★ v#5-hotfix5: 4개 메뉴 refresh 함수 window 노출
window.refreshRentrollSection = refreshRentrollSection;
window.refreshPricingSection = refreshPricingSection;
window.refreshIncentiveSection = refreshIncentiveSection;
window.refreshContactSection = refreshContactSection;

// ===== 인센티브 섹션 =====

export function renderIncentiveSection() {
    const b = state.selectedBuilding;
    const list = b.incentives || [];
    
    // 인센티브 개수 배지 업데이트
    const countEl = document.getElementById('incentiveCount');
    if (countEl) {
        countEl.textContent = list.length;
    }
    
    if (list.length === 0) {
        document.getElementById('sectionIncentive').innerHTML = `
            <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px;">
                <span style="flex-shrink: 0;">🎁 인센티브</span>
                <div style="display: flex; gap: 6px; flex-shrink: 0; align-items: center;">
                    <button class="btn btn-secondary btn-sm" style="width: auto; flex: 0 0 auto; padding: 6px 12px; white-space: nowrap;" onclick="refreshIncentiveSection()" title="새로고침">🔄</button>
                    <button class="btn btn-primary btn-sm" style="width: auto; flex: 0 0 auto; padding: 6px 16px; white-space: nowrap;" onclick="openIncentiveModal()">+ 추가</button>
                </div>
            </div>
            <div class="empty-state" style="text-align: center; padding: 40px 20px;">
                <div style="font-size: 48px; margin-bottom: 16px;">🎁</div>
                <div style="color: var(--text-muted); margin-bottom: 16px;">등록된 인센티브가 없습니다</div>
                <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 20px;">
                    Rent Free, Fit-Out, TI 등<br>임차인 혜택 조건을 관리합니다
                </div>
                <button class="btn btn-primary" onclick="openIncentiveModal()">+ 첫 인센티브 등록</button>
            </div>
        `;
        return;
    }
    
    // 최신순 정렬
    const sortedList = [...list].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    
    document.getElementById('sectionIncentive').innerHTML = `
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px;">
            <span style="flex-shrink: 0;">🎁 인센티브</span>
            <div style="display: flex; gap: 6px; flex-shrink: 0; align-items: center;">
                <button class="btn btn-secondary btn-sm" style="width: auto; flex: 0 0 auto; padding: 6px 12px; white-space: nowrap;" onclick="refreshIncentiveSection()" title="새로고침">🔄</button>
                <button class="btn btn-primary btn-sm" style="width: auto; flex: 0 0 auto; padding: 6px 16px; white-space: nowrap;" onclick="openIncentiveModal()">+ 추가</button>
            </div>
        </div>
        
        <div style="display: flex; flex-direction: column; gap: 12px;">
            ${sortedList.map((item, idx) => `
                <div class="incentive-item" style="background: var(--bg-secondary); border-radius: 10px; padding: 16px; border: 1px solid var(--border-color); position: relative;">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
                        <div>
                            <div style="font-size: 12px; color: var(--text-muted);">
                                ${item.startDate || item.createdAt ? (item.startDate || new Date(item.createdAt).toLocaleDateString()) : '-'}
                                ${item.endDate ? ' ~ ' + item.endDate : ''}
                            </div>
                            ${item.condition ? `<div style="font-size: 13px; color: var(--accent-color); margin-top: 4px;">📋 ${item.condition}</div>` : ''}
                        </div>
                        <div class="row-actions" style="display: flex !important; gap: 6px; opacity: 1 !important; visibility: visible !important;">
                            <button onclick="editIncentive('${item.id}')" title="수정" style="padding: 4px 10px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 4px; cursor: pointer; font-size: 12px;">✏️</button>
                            <button onclick="deleteIncentive('${item.id}')" title="삭제" style="padding: 4px 10px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 4px; cursor: pointer; font-size: 12px; color: #dc2626;">×</button>
                        </div>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px;">
                        <div style="text-align: center; padding: 12px; background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 8px;">
                            <div style="font-size: 11px; color: #92400e; margin-bottom: 4px;">Rent Free</div>
                            <div style="font-size: 18px; font-weight: 700; color: #78350f;">${item.rf || item.rentFree || 0}</div>
                            <div style="font-size: 10px; color: #a16207;">개월</div>
                        </div>
                        <div style="text-align: center; padding: 12px; background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%); border-radius: 8px;">
                            <div style="font-size: 11px; color: #1e40af; margin-bottom: 4px;">Fit-Out</div>
                            <div style="font-size: 18px; font-weight: 700; color: #1e3a8a;">${formatNumber(item.fo || item.fitOut || 0)}</div>
                            <div style="font-size: 10px; color: #3b82f6;">원/평</div>
                        </div>
                        <div style="text-align: center; padding: 12px; background: linear-gradient(135deg, #f3e8ff 0%, #e9d5ff 100%); border-radius: 8px;">
                            <div style="font-size: 11px; color: #6b21a8; margin-bottom: 4px;">TI</div>
                            <div style="font-size: 18px; font-weight: 700; color: #581c87;">${formatNumber(item.ti || 0)}</div>
                            <div style="font-size: 10px; color: #8b5cf6;">원/평</div>
                        </div>
                    </div>
                    
                    ${item.note ? `<div style="font-size: 12px; color: var(--text-secondary); padding: 8px; background: var(--bg-primary); border-radius: 6px;">${item.note}</div>` : ''}
                    
                    <div style="font-size: 11px; color: var(--text-muted); margin-top: 8px;">
                        ${(item.author || item.createdBy || '-').split('@')[0]} · ${item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '-'}
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

// ===== 임대안내문(문서) 섹션 =====

// ★ Fix: openTransferVacancyModal — 공실없음(_meta) 안내문 이관 모달 열기
// _noVacTransfer에서 호출되며, metaVac을 공실 1건처럼 래핑하여 openTransferModal()에 위임
window.openTransferVacancyModal = function(buildingId, metaKey, metaVac) {
    // 대상 빌딩을 selectedBuilding으로 임시 설정 (searchTransferBuilding에서 제외 기준으로 사용)
    const bld = window.state?.allBuildings?.find(b => b.id === buildingId);
    if (bld) window.state.selectedBuilding = bld;

    // _meta 레코드를 공실처럼 래핑
    const vacancyItem = {
        _vacancyId: metaKey,
        _key: metaKey,
        floor: metaVac?.floor || '공실없음',
        rentArea: metaVac?.rentArea || null,
        buildingId,
        _isMeta: true,
        ...metaVac,
    };

    state.transferVacancyIndices = [metaKey]; // 인덱스 대신 key 사용 (executeVacancyTransfer에서 fallback 처리)
    openTransferModal([vacancyItem]);
};

// ★ Fix: 공실없음 이관 헬퍼 (onclick에서 객체 직접 전달 불가 문제 우회)
window._noVacTransfer = function(buildingId, metaKey) {
    const cachedMeta = (window._noVacMetaCache || {})[buildingId + '_' + metaKey];
    if (!cachedMeta) {
        // 캐시 miss 시 state에서 직접 조회
        const bld = window.state?.allBuildings?.find(b => b.id === buildingId);
        const metaVac = bld?.vacancies?.find(v => v._key === metaKey);
        if (!metaVac) { alert('이관 데이터를 찾을 수 없습니다'); return; }
        window.openTransferVacancyModal(buildingId, metaKey, metaVac);
        return;
    }
    window.openTransferVacancyModal(buildingId, metaKey, cachedMeta);
};

export function renderDocumentSection() {
    const b = state.selectedBuilding;
    let docs = [...(b.documents || [])];
    let vacancies = [...(b.vacancies || [])];
    const leasingGuideVacancies = b.leasingGuideVacancies || [];
    
    // ★ v3.13: vacancies에서 _meta 정보 분리 (공실없음/만실 판단용)
    const vacancyMetas = {};  // { 'source_publishDate': { noVacancy, pageImageUrl, ... } }
    vacancies = vacancies.filter(v => {
        if (v._key && v._key.endsWith('_meta')) {
            // _meta 정보 저장 (source_publishDate 키로)
            const metaKey = v.source && v.publishDate 
                ? `${v.source}_${v.publishDate}` 
                : v._key.replace('_meta', '');
            vacancyMetas[metaKey] = v;
            return false;  // _meta는 vacancies에서 제외
        }
        return true;  // 실제 공실 데이터만 유지
    });
    
    // ★ v3.8: leasingGuides 컬렉션 데이터를 기존 구조에 합치기
    if (leasingGuideVacancies.length > 0) {
        // vacancies에 합치기 (중복 방지)
        leasingGuideVacancies.forEach(lgv => {
            const exists = vacancies.some(v => 
                v.floor === lgv.floor && 
                v.source === lgv.source && 
                v.publishDate === lgv.publishDate
            );
            if (!exists) {
                vacancies.push(lgv);
            }
        });
        
        // docs에 해당 문서 정보 추가 (중복 방지)
        const lgSource = leasingGuideVacancies[0]?.source || '임대안내문';
        const lgDate = leasingGuideVacancies[0]?.publishDate || '';
        const docExists = docs.some(d => d.source === lgSource && d.publishDate === lgDate);
        if (!docExists && (lgSource || lgDate)) {
            docs.push({
                source: lgSource,
                publishDate: lgDate,
                vacancyCount: leasingGuideVacancies.length,
                floors: leasingGuideVacancies.map(v => v.floor),
                fromLeasingGuide: true
            });
        }
    }
    
    // ★ v3.13: docs가 없을 때만 early return (vacancies 없어도 _meta로 만실 여부 확인 가능)
    // ★ v3.15: vacancies에는 있지만 docs에 없는 출처/기간 조합을 합성 doc으로 추가
    // (직접입력 등 수동 추가된 공실이 출처 탭에 나타나도록)
    const docKeySet = new Set(docs.map(d => `${d.source || '기타'}|${d.publishDate || ''}`));
    const vacancySourceMap = {};
    vacancies.forEach(v => {
        const key = `${v.source || '기타'}|${v.publishDate || ''}`;
        if (!docKeySet.has(key)) {
            if (!vacancySourceMap[key]) {
                vacancySourceMap[key] = { source: v.source || '기타', publishDate: v.publishDate || '', floors: [], count: 0 };
            }
            vacancySourceMap[key].floors.push(v.floor);
            vacancySourceMap[key].count++;
        }
    });
    Object.values(vacancySourceMap).forEach(synth => {
        docs.push({
            source: synth.source,
            publishDate: synth.publishDate,
            vacancyCount: synth.count,
            floors: synth.floors,
            fromManualEntry: true  // 수동 추가 표시
        });
    });
    
    if (docs.length === 0) {
        document.getElementById('sectionDocument').innerHTML = `
            <div class="section-title">📄 임대안내문</div>
            <div style="padding: 20px 0;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <div style="font-size: 13px; color: var(--text-muted);">
                        등록된 임대안내문이 없습니다
                    </div>
                    <div style="display: flex; gap: 6px;">
                        <button onclick="showInlineVacancyForm('manual')" 
                                style="padding: 6px 14px; background: var(--accent-color, #2563eb); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                            <span>➕</span> 공실 직접입력
                        </button>
                        <button onclick="addBuildingOnlyToCompList()" 
                                style="padding: 6px 14px; background: var(--bg-tertiary, #f3f4f6); color: var(--text-primary, #333); border: none; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                            <span>📋</span> 빌딩 정보만 담기
                        </button>
                    </div>
                </div>
                <div id="inlineVacancyForm" style="display: none; margin-top: 12px; padding: 16px; background: #f0f9ff; border: 2px dashed var(--accent-color, #2563eb); border-radius: 8px;"></div>
            </div>
        `;
        return;
    }
    
    // 출처(회사)별 그룹핑
    const sourceGroups = {};
    docs.forEach(d => {
        const source = d.source || '기타';
        if (!sourceGroups[source]) sourceGroups[source] = [];
        sourceGroups[source].push(d);
    });
    
    // 각 그룹 내 최신순 정렬
    Object.keys(sourceGroups).forEach(source => {
        sourceGroups[source].sort((a, b) => (b.publishDate || '').localeCompare(a.publishDate || ''));
    });
    
    // 출처 목록 (문서 수 많은 순)
    const sourceList = Object.keys(sourceGroups).sort((a, b) => sourceGroups[b].length - sourceGroups[a].length);
    
    // 선택된 출처가 없으면 첫 번째 출처 선택
    if (!state.selectedDocSource || state.selectedDocSource === 'all') {
        state.selectedDocSource = sourceList[0];
    }
    
    // 현재 출처의 기간 목록
    const currentSourceDocs = sourceGroups[state.selectedDocSource] || [];
    const periodList = [...new Set(currentSourceDocs.map(d => d.publishDate || '미정'))].sort((a, b) => (b || '').localeCompare(a || ''));
    
    // 선택된 기간이 없으면 최신 기간 선택
    if (!state.selectedDocPeriod || state.selectedDocPeriod === 'all' || !periodList.includes(state.selectedDocPeriod)) {
        state.selectedDocPeriod = periodList[0] || 'all';
    }
    
    // 현재 선택된 문서
    const selectedDoc = currentSourceDocs.find(d => (d.publishDate || '미정') === state.selectedDocPeriod);
    
    // 해당 문서의 공실 정보 가져오기
    const docVacancies = vacancies.filter(v => 
        (v.source || '') === state.selectedDocSource && 
        (v.publishDate || '') === state.selectedDocPeriod
    );
    
    // 이미지 URL 생성
    let imageUrl = '';
    let pageImageUrls = [];  // ★ 멀티페이지 지원
    let pageNum = 1;
    if (selectedDoc) {
        pageNum = parseInt(selectedDoc.pageNum) || selectedDoc.page || 1;
        
        // ★ _meta 레코드에서 pageImageUrls 우선 확인
        const metaKey = `${state.selectedDocSource}_${state.selectedDocPeriod}`;
        const docMeta = vacancyMetas[metaKey];
        if (docMeta?.pageImageUrls?.length > 0) {
            pageImageUrls = docMeta.pageImageUrls;
            imageUrl = pageImageUrls[0];
        } else if (docMeta?.pageImageUrl) {
            imageUrl = docMeta.pageImageUrl;
            pageImageUrls = [imageUrl];
        } else {
            imageUrl = selectedDoc.pageImageUrl || '';
            if (imageUrl) {
                pageImageUrls = [imageUrl];
            } else if (selectedDoc.source && selectedDoc.publishDate) {
                // ★ v3.1 수정: admin-leasing.html 업로드 경로와 일치시킴
                const safeSource  = selectedDoc.source.replace(/[\s\.]+/g, '_').replace(/__+/g, '_');
                const safePubDate = selectedDoc.publishDate.replace(/[\s\.]+/g, '_').replace(/__+/g, '_');
                imageUrl = 'https://firebasestorage.googleapis.com/v0/b/cre-unified.firebasestorage.app/o/'
                    + encodeURIComponent(`leasing-docs/${safeSource}/${safePubDate}/page_${String(pageNum).padStart(3, '0')}.jpg`)
                    + '?alt=media';
                pageImageUrls = [imageUrl];
            }
        }
    }
    
    // 공실 데이터에 고유 ID 부여 (체크박스 선택용) + _key 보존/생성
    const vacanciesWithId = docVacancies.map((v, idx) => {
        // _key가 없으면 source_publishDate_floor로 생성
        let vacancyKey = v._key;
        if (!vacancyKey) {
            const floor = (v.floor || 'UNK').replace(/[\/\s\.]/g, '_');
            const source = (v.source || 'UNKNOWN').replace(/[\/\s\.]/g, '_');
            const publishDate = (v.publishDate || '').replace(/[\/\s\.]/g, '_');
            vacancyKey = `${source}_${publishDate}_${floor}`;
        }
        
        return {
            ...v,
            _key: vacancyKey,
            _vacancyId: `vacancy_${state.selectedBuilding?.id || 'unknown'}_${idx}_${Date.now()}`
        };
    });
    
    // ★ 컬럼별 정렬 적용 (헤더 클릭으로 컬럼/방향 선택)
    const _sortCol = state.vacancySortColumn || 'floor';
    vacanciesWithId.sort((a, b) => {
        const va = vacancySortValue(a, _sortCol);
        const vb = vacancySortValue(b, _sortCol);
        let cmp;
        if (typeof va === 'number' && typeof vb === 'number') {
            cmp = va - vb;
        } else {
            cmp = String(va).localeCompare(String(vb), 'ko');
        }
        return state.vacancySortOrder === 'asc' ? cmp : -cmp;
    });
    
    // 전역 상태에 현재 표시 중인 공실 저장 (선택 시 사용)
    state.currentDisplayedVacancies = vacanciesWithId;
    
    // ★ v3.15: 인라인 입력 폼 컨테이너 (showInlineVacancyForm()이 동적으로 내용 채움)
    const inlineInputFormHtml = `
        <div id="inlineVacancyForm" style="display: none; margin-top: 12px; padding: 16px; background: #f0f9ff; border: 2px dashed var(--accent-color); border-radius: 8px;"></div>
    `;
    
    // 공실 테이블 HTML
    let vacancyTableHtml = '';
    if (vacanciesWithId.length > 0) {
        const selectedCount = state.selectedVacancyIds?.size || 0;
        // ★ '구분'(동/타워) 컬럼: 현재 테이블의 공실 중 tower 값이 하나라도 있을 때만 노출
        const _hasTower = vacanciesWithId.some(v => v.tower && String(v.tower).trim() !== '');
        vacancyTableHtml = `
            <div class="doc-vacancy-table" style="margin-top: 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <div style="font-size: 13px; font-weight: 600; color: var(--text-primary);">
                            📋 추출된 공실 정보 <span style="color: var(--accent-color);">${vacanciesWithId.length}건</span>
                        </div>
                        <!-- ★ v2.0: 소숫점 표기 토글 -->
                        <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-muted); cursor: pointer; user-select: none;">
                            <input type="checkbox" 
                                   id="decimalAreaToggle"
                                   ${state.showDecimalArea ? 'checked' : ''}
                                   onchange="toggleDecimalArea()"
                                   style="width: 14px; height: 14px; cursor: pointer; accent-color: var(--accent-color);">
                            소숫점 표기
                        </label>
                    </div>
                    <div style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center;">
                        <button onclick="showInlineVacancyForm()" 
                                style="padding: 6px 10px; background: white; color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 6px; cursor: pointer; font-size: 11px; display: flex; align-items: center; gap: 4px;">
                            <span>➕</span> 공실 추가
                        </button>
                        <!-- ★ v2.0: 선택 항목 일괄 작업 버튼 (항상 표시) -->
                        <div style="display: flex; gap: 4px; padding: 4px 8px; background: var(--bg-secondary); border-radius: 6px; align-items: center;">
                            <span style="font-size: 11px; color: var(--text-muted);" id="selectedVacancyCount">${selectedCount > 0 ? selectedCount + '개 선택' : '선택없음'}</span>
                            <button onclick="deleteSelectedVacancies()" 
                                    id="deleteSelectedVacanciesBtn"
                                    ${selectedCount === 0 ? 'disabled' : ''}
                                    style="padding: 5px 8px; background: ${selectedCount > 0 ? '#fee2e2' : '#f3f4f6'}; 
                                           color: ${selectedCount > 0 ? '#dc2626' : '#9ca3af'}; 
                                           border: 1px solid ${selectedCount > 0 ? '#fecaca' : '#e5e7eb'}; 
                                           border-radius: 4px; cursor: ${selectedCount > 0 ? 'pointer' : 'not-allowed'}; 
                                           font-size: 11px; display: flex; align-items: center; gap: 3px;"
                                    title="선택한 공실 삭제">
                                <span>🗑️</span> 삭제
                            </button>
                            <button onclick="transferSelectedVacancies()" 
                                    id="transferSelectedVacanciesBtn"
                                    ${selectedCount === 0 ? 'disabled' : ''}
                                    style="padding: 5px 8px; background: ${selectedCount > 0 ? '#fef3c7' : '#f3f4f6'}; 
                                           color: ${selectedCount > 0 ? '#d97706' : '#9ca3af'}; 
                                           border: 1px solid ${selectedCount > 0 ? '#fde68a' : '#e5e7eb'}; 
                                           border-radius: 4px; cursor: ${selectedCount > 0 ? 'pointer' : 'not-allowed'}; 
                                           font-size: 11px; display: flex; align-items: center; gap: 3px;"
                                    title="선택한 공실을 다른 빌딩으로 이관">
                                <span>↗️</span> 이관
                            </button>
                            <button onclick="copySelectedVacancies()" 
                                    id="copySelectedVacanciesBtn"
                                    ${selectedCount === 0 ? 'disabled' : ''}
                                    style="padding: 5px 8px; background: ${selectedCount > 0 ? '#dbeafe' : '#f3f4f6'}; 
                                           color: ${selectedCount > 0 ? '#2563eb' : '#9ca3af'}; 
                                           border: 1px solid ${selectedCount > 0 ? '#bfdbfe' : '#e5e7eb'}; 
                                           border-radius: 4px; cursor: ${selectedCount > 0 ? 'pointer' : 'not-allowed'}; 
                                           font-size: 11px; display: flex; align-items: center; gap: 3px;"
                                    title="선택한 공실을 복사하여 다른 안내문/빌딩에 붙여넣기">
                                <span>📋</span> 복사
                            </button>
                        </div>
                        <button onclick="addSelectedVacanciesToCompList()" 
                                id="addVacanciesToCompListBtn"
                                style="padding: 6px 12px; background: ${selectedCount > 0 ? 'var(--accent-color)' : 'var(--bg-tertiary)'}; 
                                       color: ${selectedCount > 0 ? 'white' : 'var(--text-muted)'}; 
                                       border: none; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 500;
                                       display: flex; align-items: center; gap: 4px; transition: all 0.2s;">
                            <span>📋</span> 
                            <span id="vacancySelectCount">${selectedCount > 0 ? selectedCount + '개 ' : ''}</span>Comp List
                        </button>
                    </div>
                </div>
                <div style="overflow-x: auto;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                        <thead>
                            <tr style="background: var(--bg-tertiary);">
                                <th style="padding: 8px 6px; text-align: center; border-bottom: 1px solid var(--border-color); width: 36px;">
                                    <input type="checkbox" 
                                           id="selectAllVacancies"
                                           onchange="toggleAllVacancySelect(this.checked)"
                                           style="width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent-color);"
                                           title="전체 선택">
                                </th>
                                <th style="padding: 8px 6px; text-align: left; border-bottom: 1px solid var(--border-color); white-space: nowrap; cursor: pointer;" onclick="setVacancySort('floor')" title="클릭하여 정렬 변경">
                                    층${vacancySortArrow('floor')}
                                </th>
                                ${_hasTower ? `<th style="padding: 8px 6px; text-align: center; border-bottom: 1px solid var(--border-color); white-space: nowrap; cursor: pointer;" onclick="setVacancySort('tower')" title="클릭하여 정렬 변경">구분${vacancySortArrow('tower')}</th>` : ''}
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap; cursor: pointer;" onclick="setVacancySort('rentArea')" title="클릭하여 정렬 변경">임대면적${vacancySortArrow('rentArea')}</th>
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap; cursor: pointer;" onclick="setVacancySort('exclusiveArea')" title="클릭하여 정렬 변경">전용면적${vacancySortArrow('exclusiveArea')}</th>
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap; cursor: pointer;" onclick="setVacancySort('depositPy')" title="클릭하여 정렬 변경">보증금/평${vacancySortArrow('depositPy')}</th>
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap; cursor: pointer;" onclick="setVacancySort('rentPy')" title="클릭하여 정렬 변경">임대료/평${vacancySortArrow('rentPy')}</th>
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap; cursor: pointer;" onclick="setVacancySort('maintenancePy')" title="클릭하여 정렬 변경">관리비/평${vacancySortArrow('maintenancePy')}</th>
                                <th style="padding: 8px 6px; text-align: center; border-bottom: 1px solid var(--border-color); white-space: nowrap; cursor: pointer;" onclick="setVacancySort('moveInDate')" title="클릭하여 정렬 변경">입주시기${vacancySortArrow('moveInDate')}</th>
                                <th style="padding: 8px 6px; text-align: center; border-bottom: 1px solid var(--border-color); white-space: nowrap; width: 80px;">액션</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${vacanciesWithId.map((v, idx) => {
                                const isChecked = state.selectedVacancyIds?.has(v._vacancyId) || false;
                                return `
                                <tr style="border-bottom: 1px solid var(--border-color); ${isChecked ? 'background: rgba(37, 99, 235, 0.08);' : ''}" 
                                    data-vacancy-id="${v._vacancyId}"
                                    data-vacancy-key="${v._key || ''}">
                                    <td style="padding: 8px 6px; text-align: center;">
                                        <input type="checkbox" 
                                               class="vacancy-checkbox"
                                               data-vacancy-idx="${idx}"
                                               ${isChecked ? 'checked' : ''}
                                               onchange="toggleVacancySelect('${v._vacancyId}', ${idx}, this.checked)"
                                               style="width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent-color);">
                                    </td>
                                    <td style="padding: 8px 6px; font-weight: 600; color: var(--accent-color);">${v.floor || '-'}</td>
                                    ${_hasTower ? `<td style="padding: 8px 6px; text-align: center; color: var(--text-muted);">${v.tower || '-'}</td>` : ''}
                                    <td style="padding: 8px 6px; text-align: right;">${formatArea(v.rentArea)}</td>
                                    <td style="padding: 8px 6px; text-align: right;">${formatArea(v.exclusiveArea)}</td>
                                    <td style="padding: 8px 6px; text-align: right;">${formatMoney(v.depositPy)}</td>
                                    <td style="padding: 8px 6px; text-align: right; color: var(--accent-color); font-weight: 500;">${formatMoney(v.rentPy)}</td>
                                    <td style="padding: 8px 6px; text-align: right;">${formatMoney(v.maintenancePy)}</td>
                                    <td style="padding: 8px 6px; text-align: center;">${v.moveInDate || '-'}</td>
                                    <td style="padding: 4px 2px; text-align: center;">
                                        <div style="display: flex; gap: 2px; justify-content: center;">
                                            <button onclick="openVacancyEditModal(${idx})" 
                                                    title="편집"
                                                    style="padding: 3px 5px; background: #eff6ff; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;">✏️</button>
                                            <button onclick="deleteVacancyByIdx(${idx})" 
                                                    title="삭제"
                                                    style="padding: 3px 5px; background: #fee2e2; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;">🗑️</button>
                                            <button onclick="openTransferVacancyModalByIdx(${idx})" 
                                                    title="이관"
                                                    style="padding: 3px 5px; background: #fef3c7; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;">↗️</button>
                                            <button onclick="openCopyVacancyModalByIdx(${idx})" 
                                                    title="복사 (다른 안내문/빌딩에 붙여넣기)"
                                                    style="padding: 3px 5px; background: #dbeafe; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;">📋</button>
                                            <button onclick="openPricingFromVacancyModal(${idx})" 
                                                    title="기준가 등록"
                                                    style="padding: 3px 5px; background: #d1fae5; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;">💰</button>
                                        </div>
                                    </td>
                                </tr>
                            `}).join('')}
                        </tbody>
                    </table>
                </div>
                ${inlineInputFormHtml}
            </div>
        `;
    } else {
        // ★ v3.14: 해당 임대안내문에 공실이 없는 경우 "공실 없음" 표시
        // selectedDoc이 존재 = 해당 회사/연월의 문서는 있지만 공실이 0개
        const metaKey = `${state.selectedDocSource}_${state.selectedDocPeriod}`;
        const docMeta = vacancyMetas[metaKey];
        const metaImageUrl = docMeta?.pageImageUrl || imageUrl;
        
        if (selectedDoc) {
            // 문서는 있지만 공실이 없는 경우 → "공실 없음" 표시 + 공실 추가 버튼
            vacancyTableHtml = `
                <div style="margin-top: 16px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding: 16px; background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 8px; border: 1px solid #f59e0b;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span style="font-size: 24px;">🏢</span>
                            <div>
                                <div style="font-size: 14px; font-weight: 600; color: #92400e;">공실 없음</div>
                                <div style="font-size: 12px; color: #b45309; margin-top: 2px;">
                                    ${state.selectedDocSource} · ${state.selectedDocPeriod}
                                </div>
                            </div>
                        </div>
                        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                            ${metaImageUrl ? `
                                <button onclick="window.open('${metaImageUrl}', '_blank')" 
                                        style="padding: 8px 14px; background: white; color: #92400e; border: 1px solid #f59e0b; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                                    <span>📄</span> 원문보기
                                </button>
                            ` : ''}
                            <button onclick="showInlineVacancyForm('current')"
                                    style="padding: 8px 14px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;"
                                    title="이 안내문에 공실을 직접 추가합니다">
                                <span>➕</span> 공실 추가
                            </button>
                            <button onclick="addBuildingOnlyToCompList()" 
                                    style="padding: 8px 14px; background: #92400e; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                                <span>📋</span> 빌딩 정보만 담기
                            </button>
                            <!-- ★ Fix: 공실없음 이관 버튼 -->
                            ${(() => {
                                if (!docMeta?._key) return '';
                                window._noVacMetaCache = window._noVacMetaCache || {};
                                window._noVacMetaCache[b.id + '_' + docMeta._key] = docMeta;
                                return `<button onclick="window._noVacTransfer('${b.id}', '${docMeta._key}')" style="padding: 8px 14px; background: #7c3aed; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;" title="공실없음 안내문을 다른 빌딩으로 이관"><span>↗️</span> 이관</button>`;
                            })()}
                        </div>
                    </div>
                    ${inlineInputFormHtml}
                </div>
            `;
        } else {
            // 문서 자체가 선택되지 않은 경우 (이관됨 또는 데이터 없음)
            vacancyTableHtml = `
                <div style="margin-top: 16px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                        <div style="font-size: 13px; color: var(--text-muted);">
                            추출된 공실 정보가 없습니다
                        </div>
                        <button onclick="addBuildingOnlyToCompList()" 
                                style="padding: 6px 14px; background: var(--bg-tertiary); color: var(--text-primary); border: none; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                            <span>📋</span> 빌딩 정보만 담기
                        </button>
                    </div>
                    ${inlineInputFormHtml.replace('display: none;', 'display: block;')}
                </div>
            `;
        }
    }
    
    // ★ 현재 선택된 출처/기간의 공실없음 상태 확인
    const isSpecificSelected = state.selectedDocSource && state.selectedDocSource !== 'all' 
                            && state.selectedDocPeriod && state.selectedDocPeriod !== 'all';
    const currentMetaKey = isSpecificSelected ? `${state.selectedDocSource}_${state.selectedDocPeriod}` : '';
    const isCurrentNoVacancy = isSpecificSelected && vacancyMetas[currentMetaKey]?.noVacancy;
    
    // 공실없음 처리 버튼 HTML
    const noVacancyBtnHtml = isSpecificSelected ? (isCurrentNoVacancy ? `
        <div style="display: flex; align-items: center; gap: 8px; padding: 8px 14px; background: #dcfce7; border: 1px solid #86efac; border-radius: 8px; margin-bottom: 12px;">
            <span style="font-size: 14px;">🏢</span>
            <div style="flex: 1; font-size: 12px; color: #166534; font-weight: 600;">공실없음 처리됨</div>
            <button onclick="unmarkNoVacancy()" 
                    style="padding: 4px 12px; background: white; color: #dc2626; border: 1px solid #fca5a5; border-radius: 5px; cursor: pointer; font-size: 11px;">
                해제
            </button>
        </div>
    ` : `
        <div style="margin-bottom: 12px;">
            <button onclick="markNoVacancy()" 
                    style="padding: 8px 14px; background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); color: #166534; border: 1px solid #86efac; border-radius: 8px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 6px; width: 100%; justify-content: center; font-weight: 500;"
                    title="이 회사/기간의 안내문에 공실이 없음을 기록합니다">
                🏢 이 안내문을 "공실없음"으로 처리
            </button>
        </div>
    `) : '';
    
    document.getElementById('sectionDocument').innerHTML = `
        <div class="section-title" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
            <span>📄 임대안내문</span>
            <div style="display: flex; align-items: center; gap: 10px;">
                <span style="font-size:12px; color:var(--text-muted);">총 ${docs.length}건</span>
                <button onclick="refreshVacanciesSection()" 
                        style="padding: 4px 10px; font-size: 11px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px;"
                        title="공실 데이터 새로고침">
                    🔄 새로고침
                </button>
                <button onclick="openOcrManageModal()" 
                        style="padding: 5px 10px; background: #f1f5f9; border: 1px solid var(--border-color); border-radius: 6px; cursor: pointer; font-size: 11px; display: flex; align-items: center; gap: 4px;"
                        title="OCR 데이터 관리">
                    ⚙️ 관리
                </button>
                <button onclick="switchToTab('stats')" 
                        style="padding: 5px 10px; background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); border: 1px solid #93c5fd; border-radius: 6px; cursor: pointer; font-size: 11px; display: flex; align-items: center; gap: 4px; color: #1e40af;"
                        title="공실/임대가 통계">
                    📊 통계
                </button>
            </div>
        </div>
        
        <!-- 회사별 탭 -->
        <div class="doc-filter-section" style="margin-bottom: 12px;">
            <div class="doc-filter-label" style="font-size: 12px; color: var(--text-muted); margin-bottom: 6px;">🏢 회사별</div>
            <div class="doc-filter-tabs" style="display: flex; gap: 6px; flex-wrap: wrap;">
                ${sourceList.map(source => {
                    const isManual = source === '직접입력';
                    const icon = isManual ? '✏️ ' : '';
                    return `
                    <button class="doc-source-tab" 
                            onclick="selectDocSource('${source}')"
                            style="padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; border: 1px solid var(--border-color); transition: all 0.2s;
                                   ${state.selectedDocSource === source 
                                       ? 'background: var(--accent-color); color: white; border-color: var(--accent-color);' 
                                       : isManual 
                                           ? 'background: #f0fdf4; color: #166534; border-color: #bbf7d0;' 
                                           : 'background: var(--bg-secondary); color: var(--text-primary);'}">
                        ${icon}${source} <span style="opacity: 0.7;">${sourceGroups[source].length}</span>
                    </button>`;
                }).join('')}
            </div>
        </div>
        
        <!-- 기간별 셀렉트 -->
        <div class="doc-filter-section" style="margin-bottom: 16px;">
            <div class="doc-filter-label" style="font-size: 12px; color: var(--text-muted); margin-bottom: 6px;">📅 발행월</div>
            <select onchange="selectDocPeriod(this.value)" 
                    style="padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 13px; background: var(--bg-primary); color: var(--text-primary); width: 100%; max-width: 200px;">
                ${periodList.map(period => `
                    <option value="${period}" ${state.selectedDocPeriod === period ? 'selected' : ''}>${period}</option>
                `).join('')}
            </select>
        </div>
        
        <!-- ★ 공실없음 처리 버튼 -->
        ${noVacancyBtnHtml}
        
        <!-- 선택된 문서 정보 -->
        ${selectedDoc ? `
        <div class="selected-doc-info" style="background: var(--bg-secondary); border-radius: 10px; padding: 14px; margin-bottom: 12px; border: 1px solid var(--border-color);">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">
                        ${state.selectedDocSource} - ${state.selectedDocPeriod}
                    </div>
                    <div style="font-size: 12px; color: var(--text-muted);">
                        ${pageNum}페이지 | 공실 ${docVacancies.length}건
                    </div>
                </div>
                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                    ${imageUrl ? `
                        ${pageImageUrls.length > 1 ? `
                            <button onclick="showMultiPagePreview(${JSON.stringify(pageImageUrls).replace(/"/g, '&quot;')}, '${state.selectedDocSource.replace(/'/g, "\\'")}', '${state.selectedDocPeriod.replace(/'/g, "\\'")}')"
                                    style="padding: 6px 12px; background: var(--accent-color); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 500; display: flex; align-items: center; gap: 4px;">
                                👁️ 원본 (${pageImageUrls.length}장)
                            </button>
                        ` : `
                            <button onclick="showPagePreview('${imageUrl.replace(/'/g, "\\'")}', '${state.selectedDocSource.replace(/'/g, "\\'")}', '${state.selectedDocPeriod.replace(/'/g, "\\'")}', ${pageNum})"
                                    style="padding: 6px 12px; background: var(--accent-color); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 500; display: flex; align-items: center; gap: 4px;">
                                👁️ 원본
                            </button>
                        `}
                        <button onclick="openPageMappingModal('${state.selectedBuilding?.id || ''}', '${state.selectedDocSource.replace(/'/g, "\\'")}', '${state.selectedDocPeriod.replace(/'/g, "\\'")}', ${pageNum}, '${imageUrl.replace(/'/g, "\\'")}')"
                                style="padding: 6px 12px; background: #fef3c7; color: #92400e; border: none; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 500; display: flex; align-items: center; gap: 4px;"
                                title="페이지 이미지가 일치하지 않을 경우 변경">
                            🔄 변경
                        </button>
                    ` : ''}
                    <button onclick="openPdfUploadModal('${state.selectedBuilding?.id || ''}', '${state.selectedDocSource.replace(/'/g, "\\'")}', '${state.selectedDocPeriod.replace(/'/g, "\\'")}', ${pageNum})"
                            style="padding: 6px 12px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 500; display: flex; align-items: center; gap: 4px;"
                            title="PDF에서 해당 페이지 이미지 업로드">
                        📤 수동 등록
                    </button>
                    <button onclick="deleteOcrData('${state.selectedBuilding?.id || ''}', '${state.selectedDocSource.replace(/'/g, "\\'")}', '${state.selectedDocPeriod.replace(/'/g, "\\'")}')"
                            style="padding: 6px 12px; background: #fee2e2; color: #dc2626; border: none; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 500; display: flex; align-items: center; gap: 4px;"
                            title="이 발간회사/발간일의 공실 데이터 전체 삭제">
                        🗑️ 삭제
                    </button>
                </div>
            </div>
        </div>
        ` : ''}
        
        <!-- 공실 정보 테이블 -->
        ${vacancyTableHtml}
        
        <!-- 다른 문서 목록 (접힌 상태) -->
        ${currentSourceDocs.length > 1 ? `
        <details style="margin-top: 16px;">
            <summary style="cursor: pointer; font-size: 12px; color: var(--text-muted); padding: 8px 0;">
                📚 ${state.selectedDocSource}의 다른 발행호 보기 (${currentSourceDocs.length - 1}건)
            </summary>
            <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 8px;">
                ${currentSourceDocs.filter(d => (d.publishDate || '미정') !== state.selectedDocPeriod).map(d => {
                    const pNum = parseInt(d.pageNum) || d.page || 1;
                    const vCount = vacancies.filter(v => v.source === d.source && v.publishDate === d.publishDate).length;
                    return `
                        <div onclick="selectDocPeriod('${d.publishDate || '미정'}')" 
                             style="padding: 10px 12px; background: var(--bg-secondary); border-radius: 6px; cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-size: 13px;">${d.publishDate || '미정'} (${pNum}페이지)</span>
                            <span style="font-size: 11px; color: var(--text-muted);">공실 ${vCount}건</span>
                        </div>
                    `;
                }).join('')}
            </div>
        </details>
        ` : ''}
    `;
}

// 문서 출처 선택
export function selectDocSource(source) {
    state.selectedDocSource = source;
    state.selectedDocPeriod = 'all'; // 출처 변경 시 기간 초기화
    
    // 공실 선택 상태 초기화
    if (state.selectedVacancyIds) {
        state.selectedVacancyIds.clear();
    }
    
    renderDocumentSection();
}

// 문서 기간 선택
export function selectDocPeriod(period) {
    state.selectedDocPeriod = period;
    
    // 공실 선택 상태 초기화
    if (state.selectedVacancyIds) {
        state.selectedVacancyIds.clear();
    }
    
    renderDocumentSection();
}

// ===== 🏢 공실없음 처리 =====

/**
 * 현재 선택된 출처/기간에 대해 "공실없음" 처리
 * vacancies/{buildingId}/{source}_{publishDate}_meta에 noVacancy: true 저장
 */
export async function markNoVacancy() {
    const b = state.selectedBuilding;
    if (!b) return;
    
    const source = state.selectedDocSource;
    const period = state.selectedDocPeriod;
    
    if (!source || source === 'all' || !period || period === 'all') {
        showToast('회사와 기간을 먼저 선택해 주세요', 'error');
        return;
    }
    
    if (!confirm(`[${source}] ${period}\n이 안내문을 "공실없음"으로 처리하시겠습니까?`)) return;
    
    try {
        const safeSource = source.replace(/[.#$\[\]\/]/g, '_');
        const safePeriod = period.replace(/[.#$\[\]\/]/g, '_');
        const metaKey = `${safeSource}_${safePeriod}_meta`;
        const metaPath = `vacancies/${b.id}/${metaKey}`;
        
        // 기존 _meta가 있으면 병합, 없으면 신규 생성
        const existingSnap = await get(ref(db, metaPath));
        const existingData = existingSnap.val() || {};
        
        await set(ref(db, metaPath), {
            ...existingData,
            source: source,
            publishDate: period,
            buildingId: b.id,
            buildingName: b.name,
            noVacancy: true,
            noVacancySetAt: new Date().toISOString(),
            noVacancySetBy: state.currentUser?.email || 'unknown'
        });
        
        // 로컬 상태 업데이트
        if (!b.vacancies) b.vacancies = [];
        const localIdx = b.vacancies.findIndex(v => v._key === metaKey);
        const metaObj = { _key: metaKey, source, publishDate: period, noVacancy: true };
        if (localIdx >= 0) {
            b.vacancies[localIdx] = { ...b.vacancies[localIdx], ...metaObj };
        } else {
            b.vacancies.push(metaObj);
        }
        
        // 글로벌 빌딩 목록도 업데이트
        const buildingInAll = state.allBuildings.find(x => x.id === b.id);
        if (buildingInAll && buildingInAll !== b) {
            buildingInAll.vacancies = [...b.vacancies];
        }
        
        showToast(`${source} ${period} → 공실없음 처리 완료`, 'success');
        renderDocumentSection();
        renderStatsSection();
    } catch (err) {
        console.error('공실없음 처리 실패:', err);
        showToast('공실없음 처리에 실패했습니다', 'error');
    }
}

/**
 * "공실없음" 해제
 */
export async function unmarkNoVacancy() {
    const b = state.selectedBuilding;
    if (!b) return;
    
    const source = state.selectedDocSource;
    const period = state.selectedDocPeriod;
    
    if (!source || source === 'all' || !period || period === 'all') {
        showToast('회사와 기간을 먼저 선택해 주세요', 'error');
        return;
    }
    
    if (!confirm(`[${source}] ${period}\n"공실없음" 처리를 해제하시겠습니까?`)) return;
    
    try {
        const safeSource = source.replace(/[.#$\[\]\/]/g, '_');
        const safePeriod = period.replace(/[.#$\[\]\/]/g, '_');
        const metaKey = `${safeSource}_${safePeriod}_meta`;
        const metaPath = `vacancies/${b.id}/${metaKey}`;
        
        const existingSnap = await get(ref(db, metaPath));
        const existingData = existingSnap.val();
        
        if (existingData) {
            // noVacancy 관련 필드만 제거
            const { noVacancy, noVacancySetAt, noVacancySetBy, ...rest } = existingData;
            if (Object.keys(rest).length > 0) {
                await set(ref(db, metaPath), rest);
            } else {
                await remove(ref(db, metaPath));
            }
        }
        
        // 로컬 상태 업데이트
        if (b.vacancies) {
            const localIdx = b.vacancies.findIndex(v => v._key === metaKey);
            if (localIdx >= 0) {
                delete b.vacancies[localIdx].noVacancy;
                // 다른 데이터 없으면 제거
                const v = b.vacancies[localIdx];
                if (!v.pageImageUrl && !v.pageImageUrls) {
                    b.vacancies.splice(localIdx, 1);
                }
            }
        }
        
        const buildingInAll = state.allBuildings.find(x => x.id === b.id);
        if (buildingInAll && buildingInAll !== b) {
            buildingInAll.vacancies = [...b.vacancies];
        }
        
        showToast(`${source} ${period} → 공실없음 해제 완료`, 'success');
        renderDocumentSection();
        renderStatsSection();
    } catch (err) {
        console.error('공실없음 해제 실패:', err);
        showToast('공실없음 해제에 실패했습니다', 'error');
    }
}

// ===== 📊 공실/임대가 통계 섹션 =====

export function renderStatsSection() {
    const b = state.selectedBuilding;
    if (!b) return;
    
    const showWeighted     = state.showWeightedAvg     || false;
    const excludeLowFloors = state.excludeLowFloors    || false;
    const grossFloorPy = parseFloat(b.area?.grossFloorPy || b.grossFloorPy || 0);
    let vacancies = [...(b.vacancies || [])];
    const leasingGuideVacancies = b.leasingGuideVacancies || [];
    
    // _meta 분리 (공실없음 판단용)
    const vacancyMetas = {};
    vacancies = vacancies.filter(v => {
        if (v._key && v._key.endsWith('_meta')) {
            const metaKey = v.source && v.publishDate 
                ? `${v.source}_${v.publishDate}` 
                : v._key.replace('_meta', '');
            vacancyMetas[metaKey] = v;
            return false;
        }
        return true;
    });
    
    // leasingGuide 공실 합치기
    if (leasingGuideVacancies.length > 0) {
        leasingGuideVacancies.forEach(lgv => {
            const exists = vacancies.some(v => 
                v.floor === lgv.floor && v.source === lgv.source && v.publishDate === lgv.publishDate
            );
            if (!exists) vacancies.push(lgv);
        });
    }
    
    // --- 회사별 전체 기간 추출 (최신+직전 비교용) ---
    const sourceAllPeriods = {};
    vacancies.forEach(v => {
        const src = v.source || '기타';
        const pd = v.publishDate || '';
        if (!sourceAllPeriods[src]) sourceAllPeriods[src] = {};
        if (!sourceAllPeriods[src][pd]) sourceAllPeriods[src][pd] = [];
        sourceAllPeriods[src][pd].push(v);
    });
    
    const sourceLatest = {};
    Object.entries(sourceAllPeriods).forEach(([src, periods]) => {
        const sorted = Object.keys(periods).sort().reverse();
        const latest = sorted[0] || '';
        const prev = sorted[1] || null;
        sourceLatest[src] = { 
            publishDate: latest, 
            vacancies: periods[latest] || [],
            prevPublishDate: prev,
            prevVacancies: prev ? (periods[prev] || []) : []
        };
    });
    
    // _meta에서 공실없음인데 vacancies에 없는 회사도 추가
    Object.entries(vacancyMetas).forEach(([key, meta]) => {
        const src = meta.source || key.split('_')[0];
        if (meta.noVacancy && !sourceLatest[src]) {
            sourceLatest[src] = { publishDate: meta.publishDate || '', vacancies: [], noVacancy: true, prevVacancies: [] };
        }
    });
    
    // --- 저층(지하·1F) 판정 헬퍼 — 오피스 공실률 산출 시 제외 ---
    // 흡수 패턴: B1, B1F, B-1, B-1F, B01, B01F, 지하1, 지하1층, 지하1F,
    //          1F, 01F, 1층, G, GF
    function isLowFloor(floor) {
        if (!floor) return false;
        const raw = String(floor).trim();
        const f   = raw.toUpperCase().replace(/\s+/g, '');
        if (/^B-?\d+F?$/.test(f))            return true;   // 지하 모든 층
        if (/^지하\d+(층|F)?$/.test(raw))     return true;   // 한국어 지하
        if (/^0?1F$/.test(f))                 return true;   // 1F / 01F
        if (/^1층$/.test(raw))                return true;   // 1층
        if (/^GF?$/.test(f))                  return true;   // G / GF
        return false;
    }
    
    // --- 통계 계산 함수 ---
    function calcStats(vacList) {
        // 옵션 ON 시 저층(지하·1F) 공실 제외 — 분자만 영향, 분모는 연면적 그대로
        const filteredList = excludeLowFloors
            ? vacList.filter(v => !isLowFloor(v.floor))
            : vacList;
        
        const totalRentArea = filteredList.reduce((sum, v) => sum + (parseFloat(v.rentArea) || 0), 0);
        const floorCount = filteredList.length;
        const vacancyRate = grossFloorPy > 0 ? (totalRentArea / grossFloorPy * 100) : null;
        
        const withRent = filteredList.filter(v => {
            const r = parseFloat(String(v.rentPy || '').replace(/[^\d.]/g, ''));
            return r > 0;
        });
        
        let simpleAvgRent = null;
        if (withRent.length > 0) {
            const rentSum = withRent.reduce((sum, v) => sum + parseFloat(String(v.rentPy || '').replace(/[^\d.]/g, '')), 0);
            simpleAvgRent = rentSum / withRent.length;
        }
        
        let weightedAvgRent = null;
        const withRentAndArea = withRent.filter(v => parseFloat(v.rentArea) > 0);
        if (withRentAndArea.length > 0) {
            const weightedSum = withRentAndArea.reduce((sum, v) => {
                return sum + (parseFloat(String(v.rentPy || '').replace(/[^\d.]/g, '')) * parseFloat(v.rentArea));
            }, 0);
            const totalWeightArea = withRentAndArea.reduce((sum, v) => sum + parseFloat(v.rentArea), 0);
            if (totalWeightArea > 0) weightedAvgRent = weightedSum / totalWeightArea;
        }
        
        return { totalRentArea, floorCount, vacancyRate, simpleAvgRent, weightedAvgRent, vacList: filteredList };
    }
    
    // --- 증감 표기 헬퍼 ---
    function renderChange(change) {
        if (change === null || change === undefined) return '';
        const sign = change > 0 ? '+' : '';
        const color = change > 0 ? '#dc2626' : change < 0 ? '#2563eb' : '#6b7280';
        const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '';
        return `<div style="font-size: 10px; color: ${color}; margin-top: 1px;">${arrow} ${sign}${change.toFixed(2)}%p</div>`;
    }
    
    // --- 회사별 통계 ---
    const companyRows = [];
    
    Object.entries(sourceLatest).sort((a, b) => a[0].localeCompare(b[0])).forEach(([src, data]) => {
        if (data.noVacancy) {
            companyRows.push({ source: src, publishDate: data.publishDate, noVacancy: true });
        } else {
            const stats = calcStats(data.vacancies);
            const prevStats = data.prevVacancies.length > 0 ? calcStats(data.prevVacancies) : null;
            let vacancyRateChange = null;
            if (stats.vacancyRate !== null && prevStats && prevStats.vacancyRate !== null) {
                vacancyRateChange = stats.vacancyRate - prevStats.vacancyRate;
            }
            companyRows.push({ source: src, publishDate: data.publishDate, prevPublishDate: data.prevPublishDate, vacancyRateChange, ...stats });
        }
    });
    
    // --- 전체 평균 (회사별 수치의 산술평균) ---
    const dataRows = companyRows.filter(r => !r.noVacancy);
    const avgVacancyRate = dataRows.length > 0 && dataRows.some(r => r.vacancyRate !== null)
        ? dataRows.filter(r => r.vacancyRate !== null).reduce((s, r) => s + r.vacancyRate, 0) / dataRows.filter(r => r.vacancyRate !== null).length : null;
    const avgSimpleRent = dataRows.length > 0 && dataRows.some(r => r.simpleAvgRent !== null)
        ? dataRows.filter(r => r.simpleAvgRent !== null).reduce((s, r) => s + r.simpleAvgRent, 0) / dataRows.filter(r => r.simpleAvgRent !== null).length : null;
    const avgWeightedRent = dataRows.length > 0 && dataRows.some(r => r.weightedAvgRent !== null)
        ? dataRows.filter(r => r.weightedAvgRent !== null).reduce((s, r) => s + r.weightedAvgRent, 0) / dataRows.filter(r => r.weightedAvgRent !== null).length : null;
    
    // --- 연면적 경고 ---
    const areaWarningHtml = grossFloorPy <= 0 ? `
        <div style="display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%); border-radius: 8px; border-left: 4px solid #ef4444; margin-bottom: 12px;">
            <span style="font-size: 20px;">⚠️</span>
            <div style="flex: 1;">
                <div style="font-size: 13px; font-weight: 600; color: #991b1b;">연면적 미등록 — 공실률 계산 불가</div>
                <div style="font-size: 12px; color: #b91c1c; margin-top: 2px;">건축물대장을 조회하여 연면적을 갱신해 주세요</div>
            </div>
            <div style="display: flex; gap: 6px;">
                <button onclick="refreshBuildingLedger()" style="padding: 6px 14px; background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; white-space: nowrap;">🔍 건축물대장 조회</button>
                <button onclick="switchToTab('info')" style="padding: 6px 14px; background: #6b7280; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; white-space: nowrap;">기본정보</button>
            </div>
        </div>
    ` : '';
    
    // --- 가중평균 컬럼 ---
    const weightedColHeader = showWeighted ? `<th style="padding: 10px 6px; text-align: right; border-bottom: 2px solid var(--border-color); font-weight: 600; color: var(--text-secondary); white-space: nowrap; font-size: 12px;">임대가 평균<br><span style="font-size: 10px; font-weight: 400;">(가중평균)</span></th>` : '';
    const colCount = showWeighted ? 4 : 3;
    
    // --- 테이블 행 ---
    const allNoVacancy = companyRows.length > 0 && companyRows.every(r => r.noVacancy);
    const hasAnyData = companyRows.length > 0;
    const docCount = (b.documents || []).length;
    
    const tableRowsHtml = hasAnyData ? companyRows.map(row => {
        if (row.noVacancy) {
            return `<tr style="border-bottom: 1px solid var(--border-color); background: #f0fdf4;">
                <td style="padding: 10px 8px;"><div style="font-weight: 600;">${row.source}</div><div style="font-size: 11px; color: var(--text-muted);">${row.publishDate || '-'}</div></td>
                <td colspan="${colCount}" style="padding: 10px 8px; text-align: center;"><span style="padding: 4px 12px; background: #dcfce7; color: #166534; border-radius: 12px; font-size: 12px; font-weight: 600;">🏢 공실없음</span></td>
            </tr>`;
        }
        return `<tr style="border-bottom: 1px solid var(--border-color);">
            <td style="padding: 10px 8px;"><div style="font-weight: 600;">${row.source}</div><div style="font-size: 11px; color: var(--text-muted);">${row.publishDate || '-'}</div></td>
            <td style="padding: 10px 8px; text-align: center; cursor: pointer; position: relative;" onclick="showStatsVacancyPopup(this, '${row.source.replace(/'/g, "\\'")}', '${row.publishDate}')" title="클릭: 층별 상세">
                <div style="font-weight: 600; color: var(--accent-color); text-decoration: underline; text-decoration-style: dotted;">${row.floorCount}개층</div>
                <div style="font-size: 11px; color: var(--text-muted);">${formatNumber(Math.round(row.totalRentArea))}평</div>
            </td>
            <td style="padding: 10px 8px; text-align: center;">
                ${row.vacancyRate !== null ? `<span style="font-weight: 700; font-size: 15px; color: ${row.vacancyRate > 10 ? '#dc2626' : row.vacancyRate > 5 ? '#d97706' : '#16a34a'};">${row.vacancyRate.toFixed(2)}%</span>${renderChange(row.vacancyRateChange)}` : '<span style="color: var(--text-muted);">-</span>'}
            </td>
            <td style="padding: 10px 8px; text-align: right;">
                ${row.simpleAvgRent !== null ? `<div style="font-weight: 600;">${formatNumber(Math.round(row.simpleAvgRent))}<span style="font-size: 11px; color: var(--text-muted);"> 원/평</span></div>` : '<span style="color: var(--text-muted);">-</span>'}
            </td>
            ${showWeighted ? `<td style="padding: 10px 8px; text-align: right;">
                ${row.weightedAvgRent !== null ? `<div style="font-weight: 600; color: var(--accent-color);">${formatNumber(Math.round(row.weightedAvgRent))}<span style="font-size: 11px; color: var(--text-muted);"> 원/평</span></div>` : '<span style="color: var(--text-muted);">-</span>'}
            </td>` : ''}
        </tr>`;
    }).join('') : (() => {
        if (docCount > 0) {
            return `<tr><td colspan="${colCount + 1}" style="padding: 30px; text-align: center;"><div style="font-size: 24px; margin-bottom: 8px;">📄</div><div style="color: #d97706; font-weight: 600; margin-bottom: 4px;">안내문은 있지만 공실 데이터가 없습니다</div><div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">안내문 탭에서 공실 정보를 확인하거나 "공실없음 처리"를 해주세요</div><button onclick="switchToTab('document')" style="padding: 6px 14px; background: var(--accent-color); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px;">📄 안내문 탭 이동</button></td></tr>`;
        }
        return `<tr><td colspan="${colCount + 1}" style="padding: 30px; text-align: center;"><div style="font-size: 24px; margin-bottom: 8px;">📭</div><div style="color: var(--text-muted); font-weight: 600; margin-bottom: 4px;">수집된 임대안내문이 없습니다</div><div style="font-size: 12px; color: var(--text-muted);">OCR 또는 수동으로 안내문을 등록하면 통계가 자동으로 계산됩니다</div></td></tr>`;
    })();
    
    // --- 전체 평균 행 ---
    const noVacancyCompanyCount = companyRows.filter(r => r.noVacancy).length;
    let avgRowHtml = '';
    if (allNoVacancy && companyRows.length > 0) {
        avgRowHtml = `<tr style="background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border-top: 2px solid #16a34a;">
            <td style="padding: 12px 8px;"><div style="font-weight: 700; color: #166534;">📊 전체 평균</div><div style="font-size: 11px; color: #16a34a;">${companyRows.length}개 회사</div></td>
            <td colspan="${colCount}" style="padding: 12px 8px; text-align: center;"><div style="font-weight: 700; font-size: 16px; color: #166534;">공실률 0%</div><div style="font-size: 11px; color: #16a34a;">전 회사 공실없음</div></td>
        </tr>`;
    } else if (dataRows.length > 0) {
        avgRowHtml = `<tr style="background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); border-top: 2px solid #3b82f6;">
            <td style="padding: 12px 8px;"><div style="font-weight: 700; color: #1e40af;">📊 전체 평균</div><div style="font-size: 11px; color: #3b82f6;">${dataRows.length}개 회사${noVacancyCompanyCount > 0 ? ` (+${noVacancyCompanyCount} 공실없음)` : ''}</div></td>
            <td style="padding: 12px 8px; text-align: center; color: #3b82f6; font-size: 12px;">-</td>
            <td style="padding: 12px 8px; text-align: center;">${avgVacancyRate !== null ? `<span style="font-weight: 700; font-size: 16px; color: ${avgVacancyRate > 10 ? '#dc2626' : avgVacancyRate > 5 ? '#d97706' : '#1e40af'};">${avgVacancyRate.toFixed(2)}%</span>` : '-'}</td>
            <td style="padding: 12px 8px; text-align: right;">${avgSimpleRent !== null ? `<div style="font-weight: 700; color: #1e40af;">${formatNumber(Math.round(avgSimpleRent))}<span style="font-size: 11px; color: #3b82f6;"> 원/평</span></div>` : '-'}</td>
            ${showWeighted ? `<td style="padding: 12px 8px; text-align: right;">${avgWeightedRent !== null ? `<div style="font-weight: 700; color: #1e40af;">${formatNumber(Math.round(avgWeightedRent))}<span style="font-size: 11px; color: #3b82f6;"> 원/평</span></div>` : '-'}</td>` : ''}
        </tr>`;
    }
    
    document.getElementById('sectionStats').innerHTML = `
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <span>📊 공실/임대가 통계</span>
            <button onclick="refreshStatsSection()" style="padding: 4px 10px; font-size: 11px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px;">🔄 새로고침</button>
        </div>
        
        ${areaWarningHtml}
        
        ${grossFloorPy > 0 ? `
        <div style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-secondary); border-radius: 8px; margin-bottom: 12px; flex-wrap: wrap;">
            <span style="font-size: 12px; color: var(--text-muted);">📐 연면적:</span>
            <span style="font-size: 13px; font-weight: 600;">${formatNumber(grossFloorPy)}평</span>
            <span style="font-size: 11px; color: var(--text-muted);">(건축물대장)</span>
            <span style="margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                <span style="font-size: 10px; color: var(--text-muted); display: flex; align-items: center; gap: 3px;"><span style="display: inline-block; width: 7px; height: 7px; background: #16a34a; border-radius: 50%;"></span>~5%</span>
                <span style="font-size: 10px; color: var(--text-muted); display: flex; align-items: center; gap: 3px;"><span style="display: inline-block; width: 7px; height: 7px; background: #d97706; border-radius: 50%;"></span>5~10%</span>
                <span style="font-size: 10px; color: var(--text-muted); display: flex; align-items: center; gap: 3px;"><span style="display: inline-block; width: 7px; height: 7px; background: #dc2626; border-radius: 50%;"></span>10%~</span>
                <span style="font-size: 10px; color: var(--text-muted);">| 최신월</span>
            </span>
        </div>` : ''}
        
        <div style="border: 1px solid var(--border-color); border-radius: 10px; overflow: hidden;">
            <table style="width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed;">
                <thead><tr style="background: var(--bg-secondary);">
                    <th style="padding: 10px 8px; text-align: left; border-bottom: 2px solid var(--border-color); font-weight: 600; color: var(--text-secondary); width: 25%;">출처</th>
                    <th style="padding: 10px 8px; text-align: center; border-bottom: 2px solid var(--border-color); font-weight: 600; color: var(--text-secondary); width: 18%;">공실</th>
                    <th style="padding: 10px 8px; text-align: center; border-bottom: 2px solid var(--border-color); font-weight: 600; color: var(--text-secondary); width: 22%;">공실률</th>
                    <th style="padding: 10px 8px; text-align: right; border-bottom: 2px solid var(--border-color); font-weight: 600; color: var(--text-secondary);">임대가 평균</th>
                    ${weightedColHeader}
                </tr></thead>
                <tbody>${tableRowsHtml}${avgRowHtml}</tbody>
            </table>
        </div>
        
        <div style="margin-top: 10px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
            <label style="display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-muted); cursor: pointer; user-select: none;">
                <input type="checkbox" ${showWeighted ? 'checked' : ''} onchange="toggleWeightedAvg(this.checked)" style="width: 14px; height: 14px; cursor: pointer; accent-color: var(--accent-color);">
                가중평균 임대가 보기
            </label>
            <label style="display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-muted); cursor: pointer; user-select: none;">
                <input type="checkbox" ${excludeLowFloors ? 'checked' : ''} onchange="toggleExcludeLowFloors(this.checked)" style="width: 14px; height: 14px; cursor: pointer; accent-color: var(--accent-color);">
                지하·1F 제외 (오피스 공실률)
            </label>
        </div>
        
        <div style="margin-top: 12px; padding: 10px 14px; background: #fefce8; border-radius: 8px; border: 1px solid #fde68a;">
            <div style="font-size: 11px; font-weight: 600; color: #92400e; margin-bottom: 4px;">📌 산출 기준</div>
            <div style="font-size: 11px; color: #78350f; line-height: 1.6;">
                • <strong>${excludeLowFloors ? '오피스 공실률 (지하·1F 제외)' : '공실률'}</strong> = ${excludeLowFloors ? '(공실 임대면적 합계 − 지하·1F 공실 면적)' : '공실 임대면적 합계'} ÷ 연면적(${grossFloorPy > 0 ? formatNumber(grossFloorPy) + '평' : '미등록'}) × 100<br>
                • <strong>임대가 평균</strong> = 임대료 합계 ÷ 공실 건수 (임대료 있는 건만)<br>
                ${showWeighted ? '• <strong>가중평균 임대가</strong> = Σ(임대료 × 임대면적) ÷ Σ(임대면적)<br>' : ''}
                • <strong>전체 평균</strong> = 각 회사별 수치의 산술 평균<br>
                • 전월 대비 증감은 동일 회사의 직전 발행월 기준
            </div>
        </div>
        
        <div style="margin-top: 12px; padding: 20px; border: 2px dashed var(--border-color); border-radius: 10px; text-align: center; color: var(--text-muted);">
            <div style="font-size: 24px; margin-bottom: 6px;">📈</div>
            <div style="font-size: 13px; font-weight: 500;">추이 그래프 (예정)</div>
            <div style="font-size: 11px; margin-top: 4px;">회사별 공실률 · 임대가 변동 추이</div>
        </div>
        
        <div id="statsVacancyPopup" style="display:none; position:fixed; z-index:10500; background:white; border:1px solid #e2e8f0; border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,0.15); padding:0; max-width:380px; min-width:280px; max-height:60vh; overflow:hidden;"></div>
    `;
}

// 가중평균 토글
export function toggleWeightedAvg(checked) {
    state.showWeightedAvg = checked;
    renderStatsSection();
}

// 지하·1F 제외 토글 (오피스 공실률)
export function toggleExcludeLowFloors(checked) {
    state.excludeLowFloors = checked;
    renderStatsSection();
}

// 공실 상세 팝업
export function showStatsVacancyPopup(el, source, publishDate) {
    const b = state.selectedBuilding;
    if (!b) return;
    
    let vacs = [...(b.vacancies || [])].filter(v => !v._key?.endsWith('_meta'));
    const lgv = b.leasingGuideVacancies || [];
    lgv.forEach(l => {
        if (!vacs.some(v => v.floor === l.floor && v.source === l.source && v.publishDate === l.publishDate)) vacs.push(l);
    });
    
    const filtered = vacs.filter(v => v.source === source && v.publishDate === publishDate);
    if (filtered.length === 0) return;
    
    const popup = document.getElementById('statsVacancyPopup');
    const rows = filtered.map(v => {
        const rentPy = v.rentPy ? formatNumber(parseFloat(String(v.rentPy).replace(/[^\d.]/g, ''))) : '-';
        const rentArea = v.rentArea ? Math.round(parseFloat(v.rentArea)).toLocaleString() + '평' : '-';
        const excArea = v.exclusiveArea ? Math.round(parseFloat(v.exclusiveArea)).toLocaleString() + '평' : '-';
        return `<tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:6px 8px; font-weight:600; color:var(--accent-color);">${v.floor || '-'}</td>
            <td style="padding:6px 8px; text-align:right; font-size:12px;">${rentArea}</td>
            <td style="padding:6px 8px; text-align:right; font-size:12px;">${excArea}</td>
            <td style="padding:6px 8px; text-align:right; font-size:12px; font-weight:500;">${rentPy}</td>
        </tr>`;
    }).join('');
    
    // 원본 이미지 URL 찾기 (pageImageUrl 또는 pdfUrl)
    const sampleVac = filtered[0];
    const pageImageUrl = sampleVac?.pageImageUrl || filtered.find(v => v.pageImageUrl)?.pageImageUrl || '';
    const pdfUrl = sampleVac?.pdfUrl || filtered.find(v => v.pdfUrl)?.pdfUrl || '';
    const originalUrl = pageImageUrl || pdfUrl;
    
    popup.innerHTML = `
        <div style="padding:12px 14px; background:var(--bg-secondary); border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center;">
            <div><div style="font-size:13px; font-weight:600;">${source}</div><div style="font-size:11px; color:var(--text-muted);">${publishDate} · ${filtered.length}개층</div></div>
            <div style="display:flex; align-items:center; gap:6px;">
                ${originalUrl ? `<button onclick="window.open('${originalUrl.replace(/'/g, "\\'")}', '_blank')" style="padding:3px 8px; background:#eff6ff; border:1px solid #bfdbfe; border-radius:4px; cursor:pointer; font-size:11px; color:#2563eb; white-space:nowrap;" title="원본 이미지 보기">📄 원본</button>` : ''}
                <button onclick="document.getElementById('statsVacancyPopup').style.display='none'" style="background:none; border:none; cursor:pointer; font-size:16px; color:var(--text-muted);">✕</button>
            </div>
        </div>
        <div style="overflow-y:auto; max-height:calc(60vh - 50px);">
            <table style="width:100%; border-collapse:collapse; font-size:13px;">
                <thead><tr style="background:#f8fafc;">
                    <th style="padding:6px 8px; text-align:left; font-size:11px; color:var(--text-muted);">층</th>
                    <th style="padding:6px 8px; text-align:right; font-size:11px; color:var(--text-muted);">임대면적</th>
                    <th style="padding:6px 8px; text-align:right; font-size:11px; color:var(--text-muted);">전용면적</th>
                    <th style="padding:6px 8px; text-align:right; font-size:11px; color:var(--text-muted);">임대료/평</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    
    const rect = el.getBoundingClientRect();
    popup.style.display = 'block';
    let left = rect.left, top = rect.bottom + 4;
    const pr = popup.getBoundingClientRect();
    if (left + pr.width > window.innerWidth - 10) left = window.innerWidth - pr.width - 10;
    if (top + pr.height > window.innerHeight - 10) top = rect.top - pr.height - 4;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    
    // 이전 closeHandler 제거 후 새로 등록 (재오픈 버그 수정)
    if (window._statsPopupCloseHandler) {
        document.removeEventListener('click', window._statsPopupCloseHandler);
    }
    const openTime = Date.now();
    window._statsPopupCloseHandler = (e) => {
        if (Date.now() - openTime < 50) return;
        if (!popup.contains(e.target) && !e.target.closest('td[onclick*="showStatsVacancyPopup"]')) {
            popup.style.display = 'none';
            document.removeEventListener('click', window._statsPopupCloseHandler);
            window._statsPopupCloseHandler = null;
        }
    };
    document.addEventListener('click', window._statsPopupCloseHandler);
}


// 통계 섹션 새로고침
export function refreshStatsSection() {
    renderStatsSection();
    showToast('통계가 갱신되었습니다', 'success');
}


// 탭 전환 헬퍼 (바로가기 버튼용)
export function switchToTab(sectionName) {
    document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.detail-section').forEach(s => s.classList.remove('active'));
    
    const tab = document.querySelector(`.detail-tab[data-section="${sectionName}"]`);
    const section = document.getElementById('section' + sectionName.charAt(0).toUpperCase() + sectionName.slice(1));
    
    if (tab) tab.classList.add('active');
    if (section) section.classList.add('active');
    
    // 통계 탭 전환 시 렌더링
    if (sectionName === 'stats') renderStatsSection();
}

// ===== 상세 패널 탭 설정 =====

export function setupDetailTabs() {
    document.querySelectorAll('.detail-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
            document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.detail-section').forEach(s => s.classList.remove('active'));
            tab.classList.add('active');
            const sectionId = 'section' + tab.dataset.section.charAt(0).toUpperCase() + tab.dataset.section.slice(1);
            const section = document.getElementById(sectionId);
            if (section) section.classList.add('active');
            
            // ★ v4.2: 메모 탭 클릭 시 자동 새로고침 (저장/삭제 직후가 아닐 때만)
            if (tab.dataset.section === 'memo' && state.selectedBuilding) {
                // 저장/삭제 직후 3초 이내면 새로고침 스킵 (로컬 데이터가 최신)
                if (state.lastMemoActionTime && (Date.now() - state.lastMemoActionTime < 3000)) {
                    console.log('🚫 메모 변경 직후 새로고침 스킵');
                    return;
                }
                await refreshMemoSection();
            }
        });
    });
}

export function registerDetailGlobals() {
    window.openDetail = openDetail;
    window.closeDetail = closeDetail;
    window.toggleDetailStar = toggleDetailStar;
    window.filterRentrollByDate = filterRentrollByDate;
    window.filterPricingByDate = filterPricingByDate;  // ★ 기준가 날짜 필터
    window.filterPricingBySource = filterPricingBySource;  // ★ 기준가 출처 필터
    window.togglePricingGroup = function (gid) {  // ★ 안내문 아코디언 토글
        const body = document.querySelector(`[data-pricing-group-body="${gid}"]`);
        const chev = document.querySelector(`[data-pricing-group="${gid}"] .pricing-group-chevron`);
        if (!body) return;
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'flex';
        if (chev) chev.style.transform = open ? 'rotate(0deg)' : 'rotate(90deg)';
    };
    window.setOfficialPricing = setOfficialPricing;  // ★ 공식 기준가 등록
    window.unsetOfficialPricing = unsetOfficialPricing;  // ★ 공식 기준가 해제
    window.editPricing = editPricing;  // ★ 기준가 수정 모달
    window.saveEditPricing = saveEditPricing;  // ★ 기준가 수정 저장
    window.closeEditPricingModal = closeEditPricingModal;  // ★ 기준가 수정 모달 닫기
    window.deletePricing = deletePricing;  // ★ 기준가 삭제
    window.selectDocSource = selectDocSource;
    window.selectDocPeriod = selectDocPeriod;
    
    // ★ 페이지 매핑 변경 후 새로고침용
    window.renderDocumentSection = renderDocumentSection;
    
    // ★ 기본정보 새로고침
    window.refreshInfoSection = refreshInfoSection;
    
    // ★ 공실(안내문) 새로고침
    window.refreshVacanciesSection = refreshVacanciesSection;
    
    // 공실 선택 관련 전역 함수
    window.toggleVacancySelect = toggleVacancySelect;
    window.toggleAllVacancySelect = toggleAllVacancySelect;
    window.addSelectedVacanciesToCompList = addSelectedVacanciesToCompList;
    
    // 빌딩만 담기 / 인라인 공실 입력 함수
    window.addBuildingOnlyToCompList = addBuildingOnlyToCompList;
    window.showInlineVacancyForm = showInlineVacancyForm;
    window.hideInlineVacancyForm = hideInlineVacancyForm;
    window.saveInlineVacancy = saveInlineVacancy;
    
    // ★ v2.0: 소숫점 토글 및 공실 편집/삭제/이관 함수
    window.toggleDecimalArea = toggleDecimalArea;
    window.openVacancyEditModal = openVacancyEditModal;
    window.closeVacancyEditModal = closeVacancyEditModal;
    window.saveVacancyEditFromModal = saveVacancyEditFromModal;
    window.bulkUpdateVacancyPricing = bulkUpdateVacancyPricing;
    window.deleteVacancyByIdx = deleteVacancyByIdx;
    window.deleteSelectedVacancies = deleteSelectedVacancies;
    window.openTransferVacancyModalByIdx = openTransferVacancyModalByIdx;
    window.transferSelectedVacancies = transferSelectedVacancies;
    window.searchTransferBuilding = searchTransferBuilding;
    window.selectTransferBuilding = selectTransferBuilding;
    window.executeVacancyTransfer = executeVacancyTransfer;
    window.closeTransferModal = closeTransferModal;
    // 📋 공실 복사 기능
    window.openCopyVacancyModalByIdx = openCopyVacancyModalByIdx;
    window.copySelectedVacancies = copySelectedVacancies;
    window.searchCopyBuilding = searchCopyBuilding;
    window.selectCopyBuilding = selectCopyBuilding;
    window.onCopyGuideChange = onCopyGuideChange;
    window.executeVacancyCopy = executeVacancyCopy;
    window.closeCopyModal = closeCopyModal;
    // 숫자 입력칸 라이브 콤마
    window.formatNumberInputLive = formatNumberInputLive;
    window.commaFormat = commaFormat;
    window.formatBondNumberOnBlur = formatBondNumberOnBlur;
    window.toWon = toWon;
    window.validateExclusiveArea = validateExclusiveArea;
    
    // ★ v2.1: 기준가 통합 기능
    window.migrateBasePricingToFloorPricing = migrateBasePricingToFloorPricing;
    window.openPricingFromVacancyModal = openPricingFromVacancyModal;
    window.savePricingFromVacancy = savePricingFromVacancy;
    window.closePricingFromVacancyModal = closePricingFromVacancyModal;
    
    // ★ PDF 페이지 이미지 수동 등록
    window.openPdfUploadModal = openPdfUploadModal;
    window.closePdfUploadModal = closePdfUploadModal;
    window.handlePdfFileSelect = handlePdfFileSelect;
    window.pdfPrevPage = pdfPrevPage;
    window.pdfNextPage = pdfNextPage;
    window.goToPdfPage = goToPdfPage;
    window.uploadPdfPageImage = uploadPdfPageImage;
    window.showMultiPagePreview = showMultiPagePreview;
    
    // 탭 이벤트 설정
    setupDetailTabs();
    
    // ★ 통계 섹션 관련
    window.renderStatsSection = renderStatsSection;
    window.refreshStatsSection = refreshStatsSection;
    window.switchToTab = switchToTab;
    window.toggleWeightedAvg = toggleWeightedAvg;
    window.toggleExcludeLowFloors = toggleExcludeLowFloors;
    window.showStatsVacancyPopup = showStatsVacancyPopup;
    
    // ★ 공실없음 처리 관련
    window.markNoVacancy = markNoVacancy;
    window.unmarkNoVacancy = unmarkNoVacancy;
}

// ===== 빌딩 정보만 Comp List에 담기 =====

export function addBuildingOnlyToCompList() {
    const building = state.selectedBuilding;
    if (!building) {
        showToast('빌딩 정보가 없습니다', 'error');
        return;
    }
    
    if (typeof window.addBuildingToCompList === 'function') {
        window.addBuildingToCompList(building, []); // 빈 공실 배열로 추가
        showToast(`${building.name}이(가) Comp List에 추가되었습니다`, 'success');
    } else {
        showToast('Comp List 모듈이 로드되지 않았습니다', 'error');
    }
}

// ===== 인라인 공실 입력 폼 =====

export function showInlineVacancyForm(mode) {
    // mode: 'current' = 현재 출처에 추가, 'manual' = 새로 직접입력, undefined = 선택 UI 표시
    
    const form = document.getElementById('inlineVacancyForm');
    if (!form) return;
    
    if (!mode) {
        // ★ 유형 선택 UI 표시
        const currentSource = state.selectedDocSource;
        const currentPeriod = state.selectedDocPeriod;
        const hasCurrentSource = currentSource && currentSource !== 'all' && currentSource !== '직접입력';
        
        form.style.display = 'block';
        form.innerHTML = `
            <div style="font-size: 13px; font-weight: 600; color: var(--accent-color); margin-bottom: 14px;">➕ 공실 추가 유형 선택</div>
            <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                ${hasCurrentSource ? `
                <button onclick="showInlineVacancyForm('current')" 
                        style="flex: 1; min-width: 200px; padding: 16px; background: #eff6ff; border: 2px solid #bfdbfe; border-radius: 10px; cursor: pointer; text-align: left;">
                    <div style="font-size: 13px; font-weight: 700; color: #1e40af; margin-bottom: 6px;">📋 현재 출처에 추가</div>
                    <div style="font-size: 12px; color: #3b82f6; margin-bottom: 8px;">
                        <strong>${currentSource}</strong> ${currentPeriod !== 'all' ? currentPeriod : ''} 리스트에 누락된 공실 추가
                    </div>
                    <div style="font-size: 11px; color: #64748b;">OCR 처리가 누락된 공실을 해당 출처 리스트에 직접 추가합니다</div>
                </button>` : ''}
                <button onclick="showInlineVacancyForm('manual')" 
                        style="flex: 1; min-width: 200px; padding: 16px; background: #f0fdf4; border: 2px solid #bbf7d0; border-radius: 10px; cursor: pointer; text-align: left;">
                    <div style="font-size: 13px; font-weight: 700; color: #166534; margin-bottom: 6px;">✏️ 새로 직접입력</div>
                    <div style="font-size: 12px; color: #16a34a; margin-bottom: 8px;">
                        출처 없이 새로운 공실 정보를 직접 입력
                    </div>
                    <div style="font-size: 11px; color: #64748b;">별도 출처 정보 없이 수동으로 공실을 등록합니다</div>
                </button>
            </div>
            <div style="text-align: right; margin-top: 10px;">
                <button onclick="hideInlineVacancyForm()" style="padding: 6px 14px; border: 1px solid #d1d5db; border-radius: 4px; background: white; cursor: pointer; font-size: 12px; color: #666;">취소</button>
            </div>
        `;
        return;
    }
    
    // ★ 출처 결정
    let sourceLabel, sourceValue, periodValue;
    if (mode === 'current') {
        sourceValue = state.selectedDocSource;
        periodValue = state.selectedDocPeriod !== 'all' ? state.selectedDocPeriod : '';
        sourceLabel = `${sourceValue} ${periodValue}`.trim();
    } else {
        sourceValue = '직접입력';
        const now = new Date();
        periodValue = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        sourceLabel = `직접입력 · ${periodValue}`;
    }
    
    form.style.display = 'block';
    form.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <div style="font-size: 13px; font-weight: 600; color: var(--accent-color);">
                ➕ 공실 정보 입력 
                <span style="font-size: 11px; padding: 2px 8px; background: ${mode === 'current' ? '#dbeafe' : '#dcfce7'}; color: ${mode === 'current' ? '#1e40af' : '#166534'}; border-radius: 10px; margin-left: 6px;">
                    ${mode === 'current' ? '📋 ' + sourceValue : '✏️ 직접입력'}
                </span>
            </div>
            <button onclick="showInlineVacancyForm()" style="font-size: 11px; color: var(--accent-color); background: none; border: none; cursor: pointer; text-decoration: underline;">← 유형 변경</button>
        </div>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px;">
            <div>
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 3px;">공실층 *</label>
                <input type="text" id="inlineVacancyFloor" placeholder="예: 10F" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
            </div>
            <div>
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 3px;">임대면적(평)</label>
                <input type="text" inputmode="decimal" oninput="formatNumberInputLive(this)" id="inlineVacancyRentArea" placeholder="0" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
            </div>
            <div>
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 3px;">전용면적(평)</label>
                <input type="text" inputmode="decimal" oninput="formatNumberInputLive(this)" id="inlineVacancyExclusiveArea" placeholder="0" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
            </div>
            <div>
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 3px;">보증금/평</label>
                <input type="text" inputmode="decimal" oninput="formatNumberInputLive(this)" id="inlineVacancyDepositPy" placeholder="0" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
            </div>
            <div>
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 3px;">임대료/평 *</label>
                <input type="text" inputmode="decimal" oninput="formatNumberInputLive(this)" id="inlineVacancyRentPy" placeholder="0" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
            </div>
            <div>
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 3px;">관리비/평</label>
                <input type="text" inputmode="decimal" oninput="formatNumberInputLive(this)" id="inlineVacancyMaintenancePy" placeholder="0" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
            </div>
            <div>
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 3px;">입주시기</label>
                <input type="text" id="inlineVacancyMoveIn" placeholder="즉시, 25년3월" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
            </div>
        </div>
        <input type="hidden" id="inlineVacancySource" value="${sourceValue}">
        <input type="hidden" id="inlineVacancyPeriod" value="${periodValue}">
        <input type="hidden" id="inlineVacancyMode" value="${mode}">
        <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="font-size: 11px; color: #888;">
                📅 ${sourceLabel}
            </div>
            <div style="display: flex; gap: 8px;">
                <button onclick="hideInlineVacancyForm()" style="padding: 8px 16px; border: 1px solid #d1d5db; border-radius: 4px; background: white; cursor: pointer; font-size: 12px;">취소</button>
                <button onclick="saveInlineVacancy()" style="padding: 8px 16px; border: none; border-radius: 4px; background: var(--accent-color); color: white; cursor: pointer; font-size: 12px; font-weight: 500;">💾 저장</button>
            </div>
        </div>
    `;
    
    // 첫 번째 입력 필드에 포커스
    setTimeout(() => {
        const firstInput = document.getElementById('inlineVacancyFloor');
        if (firstInput) firstInput.focus();
    }, 100);
}

export function hideInlineVacancyForm() {
    const form = document.getElementById('inlineVacancyForm');
    if (form) {
        form.style.display = 'none';
        form.innerHTML = '';  // ★ 동적 컨텐츠 초기화
    }
}

function clearInlineVacancyForm() {
    // 동적 폼이므로 hideInlineVacancyForm에서 처리
    hideInlineVacancyForm();
}

export async function saveInlineVacancy() {
    const building = state.selectedBuilding;
    if (!building) {
        showToast('빌딩 정보가 없습니다', 'error');
        return;
    }
    
    // 입력값 수집
    const floor = document.getElementById('inlineVacancyFloor')?.value?.trim();
    const rentPyStr = (document.getElementById('inlineVacancyRentPy')?.value || '').replace(/,/g, '').trim();
    
    // 필수값 확인 - 공실층
    if (!floor) {
        showToast('공실층을 입력해주세요', 'warning');
        document.getElementById('inlineVacancyFloor')?.focus();
        return;
    }
    
    // 필수값 확인 - 임대료
    if (!rentPyStr || isNaN(parseFloat(rentPyStr))) {
        showToast('임대료를 입력해주세요', 'warning');
        document.getElementById('inlineVacancyRentPy')?.focus();
        return;
    }
    
    const rentPy = parseFloat(rentPyStr);
    const depositPyStr = (document.getElementById('inlineVacancyDepositPy')?.value || '').replace(/,/g, '').trim();
    const maintenancePyStr = (document.getElementById('inlineVacancyMaintenancePy')?.value || '').replace(/,/g, '').trim();
    
    // ★ 출처/기간 정보
    const source = document.getElementById('inlineVacancySource')?.value || '직접입력';
    const publishDate = document.getElementById('inlineVacancyPeriod')?.value || '';
    const mode = document.getElementById('inlineVacancyMode')?.value || 'manual';
    
    const now = new Date();
    const vacancyData = {
        floor: floor,
        rentArea: parseFloat((document.getElementById('inlineVacancyRentArea')?.value || '').replace(/,/g, '')) || 0,
        exclusiveArea: parseFloat((document.getElementById('inlineVacancyExclusiveArea')?.value || '').replace(/,/g, '')) || 0,
        rentPy: formatNumber(rentPy),
        depositPy: depositPyStr && !isNaN(parseFloat(depositPyStr)) ? formatNumber(parseFloat(depositPyStr)) : '',
        maintenancePy: maintenancePyStr && !isNaN(parseFloat(maintenancePyStr)) ? formatNumber(parseFloat(maintenancePyStr)) : '',
        moveInDate: document.getElementById('inlineVacancyMoveIn')?.value?.trim() || '즉시',
        source: source,
        publishDate: publishDate,
        addedManually: true,
        addedBy: state.currentUser?.email || state.currentUser?.name || 'unknown',
        addedAt: now.toISOString()
    };
    
    try {
        // ★ Firebase에 저장
        const newVacancyRef = push(ref(db, `vacancies/${building.id}`));
        await set(newVacancyRef, vacancyData);
        
        console.log('✅ 공실 Firebase 저장 완료:', `vacancies/${building.id}`, vacancyData);
        
        // ★ 로컬 상태 업데이트 (즉시 반영)
        const newEntry = { ...vacancyData, _key: newVacancyRef.key };
        
        if (!building.vacancies) building.vacancies = [];
        building.vacancies.push(newEntry);
        building.vacancyCount = building.vacancies.length;
        
        // allBuildings에서도 업데이트 (같은 객체가 아닌 경우에만)
        const buildingInAll = state.allBuildings?.find(b => b.id === building.id);
        if (buildingInAll && buildingInAll !== building) {
            if (!buildingInAll.vacancies) buildingInAll.vacancies = [];
            buildingInAll.vacancies.push({ ...newEntry });
            buildingInAll.vacancyCount = buildingInAll.vacancies.length;
        }
        
        showToast(`${building.name} ${floor} 공실 추가 완료 (${source})`, 'success');
        
        // ★ 폼 숨기고 안내문 섹션 새로고침
        hideInlineVacancyForm();
        
        // 현재 선택된 출처를 저장된 출처로 설정 (새로 추가한 공실이 바로 보이도록)
        if (mode === 'current') {
            state.selectedDocSource = source;
        } else if (mode === 'manual') {
            state.selectedDocSource = source; // '직접입력'
        }
        
        renderDocumentSection();
        if (window.applyFilters) window.applyFilters();  // ★ v#5: 빌딩 리스트 공실 카운트 stale 방지
        // ★ v#5-hotfix4: 같은 메뉴 안 stale 방지
        setTimeout(() => { if (window.refreshVacanciesSection) window.refreshVacanciesSection(); }, 0);
        
    } catch (error) {
        console.error('공실 저장 오류:', error);
        showToast('저장 중 오류가 발생했습니다: ' + error.message, 'error');
    }
}

// ===== 공실 선택 기능 (Comp List 연동) =====

// 개별 공실 선택 토글
export function toggleVacancySelect(vacancyId, idx, checked) {
    if (!state.selectedVacancyIds) {
        state.selectedVacancyIds = new Set();
    }
    
    if (checked) {
        state.selectedVacancyIds.add(vacancyId);
    } else {
        state.selectedVacancyIds.delete(vacancyId);
    }
    
    updateVacancySelectUI();
    
    // 행 배경색 업데이트
    const row = document.querySelector(`tr[data-vacancy-id="${vacancyId}"]`);
    if (row) {
        row.style.background = checked ? 'rgba(37, 99, 235, 0.08)' : '';
    }
    
    // 전체 선택 체크박스 상태 업데이트
    updateSelectAllCheckbox();
}

// 전체 선택/해제
export function toggleAllVacancySelect(checked) {
    if (!state.selectedVacancyIds) {
        state.selectedVacancyIds = new Set();
    }
    
    const vacancies = state.currentDisplayedVacancies || [];
    
    if (checked) {
        vacancies.forEach(v => state.selectedVacancyIds.add(v._vacancyId));
    } else {
        vacancies.forEach(v => state.selectedVacancyIds.delete(v._vacancyId));
    }
    
    // 모든 체크박스 업데이트
    document.querySelectorAll('.vacancy-checkbox').forEach((cb, idx) => {
        cb.checked = checked;
        const row = cb.closest('tr');
        if (row) {
            row.style.background = checked ? 'rgba(37, 99, 235, 0.08)' : '';
        }
    });
    
    updateVacancySelectUI();
}

// 전체 선택 체크박스 상태 업데이트
function updateSelectAllCheckbox() {
    const selectAllCheckbox = document.getElementById('selectAllVacancies');
    if (!selectAllCheckbox) return;
    
    const vacancies = state.currentDisplayedVacancies || [];
    const selectedCount = state.selectedVacancyIds?.size || 0;
    
    if (selectedCount === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
    } else if (selectedCount === vacancies.length) {
        selectAllCheckbox.checked = true;
        selectAllCheckbox.indeterminate = false;
    } else {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = true;
    }
}

// 선택된 공실 수 및 버튼 UI 업데이트
function updateVacancySelectUI() {
    const count = state.selectedVacancyIds?.size || 0;
    
    // Comp List 버튼 업데이트
    const btn = document.getElementById('addVacanciesToCompListBtn');
    const countSpan = document.getElementById('vacancySelectCount');
    
    if (btn) {
        btn.style.background = count > 0 ? 'var(--accent-color)' : 'var(--bg-tertiary)';
        btn.style.color = count > 0 ? 'white' : 'var(--text-muted)';
    }
    
    if (countSpan) {
        countSpan.textContent = count > 0 ? `${count}개 ` : '';
    }
    
    // ★ v2.0: 선택 개수 표시 및 삭제/이관 버튼 상태 업데이트
    const selectedCountEl = document.getElementById('selectedVacancyCount');
    if (selectedCountEl) {
        selectedCountEl.textContent = count > 0 ? `${count}개 선택` : '선택없음';
        selectedCountEl.style.color = count > 0 ? 'var(--accent-color)' : 'var(--text-muted)';
        selectedCountEl.style.fontWeight = count > 0 ? '600' : '400';
    }
    
    // 삭제 버튼 상태 업데이트
    const deleteBtn = document.getElementById('deleteSelectedVacanciesBtn');
    if (deleteBtn) {
        deleteBtn.disabled = count === 0;
        deleteBtn.style.background = count > 0 ? '#fee2e2' : '#f3f4f6';
        deleteBtn.style.color = count > 0 ? '#dc2626' : '#9ca3af';
        deleteBtn.style.borderColor = count > 0 ? '#fecaca' : '#e5e7eb';
        deleteBtn.style.cursor = count > 0 ? 'pointer' : 'not-allowed';
    }
    
    // 이관 버튼 상태 업데이트
    const transferBtn = document.getElementById('transferSelectedVacanciesBtn');
    if (transferBtn) {
        transferBtn.disabled = count === 0;
        transferBtn.style.background = count > 0 ? '#fef3c7' : '#f3f4f6';
        transferBtn.style.color = count > 0 ? '#d97706' : '#9ca3af';
        transferBtn.style.borderColor = count > 0 ? '#fde68a' : '#e5e7eb';
        transferBtn.style.cursor = count > 0 ? 'pointer' : 'not-allowed';
    }
    
    // 복사 버튼 상태 업데이트
    const copyBtn = document.getElementById('copySelectedVacanciesBtn');
    if (copyBtn) {
        copyBtn.disabled = count === 0;
        copyBtn.style.background = count > 0 ? '#dbeafe' : '#f3f4f6';
        copyBtn.style.color = count > 0 ? '#2563eb' : '#9ca3af';
        copyBtn.style.borderColor = count > 0 ? '#bfdbfe' : '#e5e7eb';
        copyBtn.style.cursor = count > 0 ? 'pointer' : 'not-allowed';
    }
}

// 선택된 공실을 Comp List에 추가
export function addSelectedVacanciesToCompList() {
    const selectedIds = state.selectedVacancyIds;
    
    if (!selectedIds || selectedIds.size === 0) {
        showToast('공실을 먼저 선택해주세요', 'warning');
        return;
    }
    
    const building = state.selectedBuilding;
    if (!building) {
        showToast('빌딩 정보가 없습니다', 'error');
        return;
    }
    
    // 선택된 공실 데이터 수집
    const selectedVacancies = (state.currentDisplayedVacancies || [])
        .filter(v => selectedIds.has(v._vacancyId))
        .map(v => ({
            floor: v.floor || '',
            rentArea: v.rentArea || 0,
            exclusiveArea: v.exclusiveArea || 0,
            rentPy: v.rentPy || '',
            depositPy: v.depositPy || '',
            maintenancePy: v.maintenancePy || '',
            moveInDate: v.moveInDate || '',
            source: v.source || state.selectedDocSource || '',
            publishDate: v.publishDate || state.selectedDocPeriod || ''
        }));
    
    // Comp List에 추가 (window.addBuildingToCompList 사용)
    if (typeof window.addBuildingToCompList === 'function') {
        window.addBuildingToCompList(building, selectedVacancies);
        
        // 선택 초기화
        state.selectedVacancyIds.clear();
        
        // UI 업데이트
        document.querySelectorAll('.vacancy-checkbox').forEach(cb => {
            cb.checked = false;
            const row = cb.closest('tr');
            if (row) row.style.background = '';
        });
        
        const selectAllCheckbox = document.getElementById('selectAllVacancies');
        if (selectAllCheckbox) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
        }
        
        updateVacancySelectUI();
        
        showToast(`${building.name}의 ${selectedVacancies.length}개 공실이 Comp List에 추가되었습니다`, 'success');
    } else {
        showToast('Comp List 모듈이 로드되지 않았습니다', 'error');
    }
}

// ===== 건축물대장 불러오기 =====
// 참고: refreshBuildingLedger 함수는 portal-misc.js에서 전역으로 등록됨

// ===== ★ 건축물대장 전유부/층별개요 조회 =====

/** AbortController: 진행 중인 층별상세 요청 취소용 */
let _floorDetailAbortController = null;

/**
 * 건축물대장 층별상세 로딩 오버레이를 #detailPanel 위에 표시
 * @param {string} label - 조회 유형명 (예: '층별개요')
 * @param {Function} onCancel - 취소 버튼 클릭 콜백
 */
function showFloorDetailOverlay(label, onCancel) {
    removeFloorDetailOverlay();

    const overlay = document.createElement('div');
    overlay.id = 'floorDetailLoadingOverlay';
    overlay.innerHTML = `
        <div id="floorDetailLoadingBox">
            <div id="floorDetailSpinner"></div>
            <p id="floorDetailMsg">건축물대장 <strong>${label}</strong> 조회 중…</p>
            <div id="floorDetailProgressWrap">
                <div id="floorDetailProgressBar"></div>
            </div>
            <button id="floorDetailCancelBtn">✕ 취소</button>
        </div>`;

    const panel = document.getElementById('detailPanel') || document.body;
    if (panel !== document.body) {
        // detailPanel은 relative 포지션이어야 overlay가 정확히 덮임
        const cs = getComputedStyle(panel);
        if (cs.position === 'static') panel.style.position = 'relative';
    }
    panel.appendChild(overlay);

    document.getElementById('floorDetailCancelBtn').addEventListener('click', () => {
        onCancel();
        removeFloorDetailOverlay();
    });

    // 가상 프로그레스바: 최대 90%까지 자동 진행
    let pct = 0;
    const bar = document.getElementById('floorDetailProgressBar');
    const ticker = setInterval(() => {
        pct = Math.min(pct + Math.random() * 5 + 1, 90);
        if (bar) bar.style.width = pct + '%';
    }, 700);
    overlay._ticker = ticker;
}

function removeFloorDetailOverlay() {
    const el = document.getElementById('floorDetailLoadingOverlay');
    if (el) {
        clearInterval(el._ticker);
        el.remove();
    }
}

/**
 * 건축물대장 층별상세 데이터 조회
 * @param {string} viewType - 'floorOutline' | 'exposeInfo' | 'exposeAreaInfo'
 */
export async function fetchBuildingFloorDetail(viewType = 'floorOutline') {
    const building = state.selectedBuilding;
    if (!building) {
        showToast('빌딩을 먼저 선택하세요', 'error');
        return;
    }
    
    const address = building.address || building.addressJibun || building.addressRoad;
    if (!address) {
        showToast('주소 정보가 없습니다', 'error');
        return;
    }
    
    const container = document.getElementById('floorDetailContainer');
    if (!container) return;
    
    const typeLabels = {
        'floorOutline': '층별개요',
        'exposeInfo': '전유부',
        'exposeAreaInfo': '전유공용면적'
    };

    // 이전 요청 취소
    if (_floorDetailAbortController) {
        _floorDetailAbortController.abort();
    }
    _floorDetailAbortController = new AbortController();
    const { signal } = _floorDetailAbortController;

    // 오버레이 표시
    showFloorDetailOverlay(typeLabels[viewType], () => {
        _floorDetailAbortController.abort();
        container.innerHTML = `
            <div style="text-align:center; padding:16px; color:var(--text-muted); font-size:12px;">
                🚫 조회를 취소했습니다.
            </div>`;
    });
    
    try {
        const API_URL = window.API_BASE_URL || 'https://portal-dsyl.onrender.com';
        const response = await fetch(
            `${API_URL}/api/building-register/floor-detail?address=${encodeURIComponent(address)}`,
            { signal }
        );
        const data = await response.json();
        
        if (!data.success || !data.results) {
            throw new Error(data.error || '조회 결과가 없습니다');
        }
        
        const results = data.results;
        const targetData = results[viewType];
        
        if (!targetData || targetData.length === 0) {
            // 다른 데이터 타입에는 있는지 체크
            const available = Object.keys(results).filter(k => results[k] && results[k].length > 0);
            let altMsg = '';
            if (available.length > 0) {
                const altLabels = available.map(k => typeLabels[k] || k).join(', ');
                altMsg = `<div style="margin-top: 8px; font-size: 11px;">사용 가능한 데이터: ${altLabels}</div>`;
            }
            container.innerHTML = `
                <div style="text-align: center; padding: 20px; background: #fef3c7; border-radius: 8px; border: 1px solid #fbbf24;">
                    <div style="font-size: 18px; margin-bottom: 6px;">📭</div>
                    <div style="font-size: 12px; color: #92400e;">
                        ${typeLabels[viewType]} 데이터가 없습니다.<br>
                        <span style="font-size: 11px; color: #a16207;">집합건축물(구분소유)이 아닌 경우 전유부 데이터가 없을 수 있습니다.</span>
                    </div>
                    ${altMsg}
                </div>
            `;
            removeFloorDetailOverlay();
            return;
        }
        
        // 데이터 렌더링
        renderFloorDetailData(container, viewType, targetData, typeLabels[viewType]);
        
        // 캐시 저장 (같은 빌딩 재조회 방지)
        if (!building._floorDetailCache) building._floorDetailCache = {};
        building._floorDetailCache[viewType] = targetData;

        // 프로그레스 100% → 오버레이 제거
        const bar = document.getElementById('floorDetailProgressBar');
        if (bar) bar.style.width = '100%';
        await new Promise(r => setTimeout(r, 250));
        removeFloorDetailOverlay();
        
    } catch (error) {
        removeFloorDetailOverlay();
        if (error.name === 'AbortError') return; // 취소 시 에러 메시지 미표시
        console.error('건축물대장 층별상세 조회 오류:', error);
        container.innerHTML = `
            <div style="text-align: center; padding: 16px; background: #fef2f2; border-radius: 8px; border: 1px solid #fca5a5;">
                <div style="font-size: 12px; color: #dc2626;">❌ 조회 실패: ${error.message}</div>
            </div>
        `;
    }
}

/**
 * 층별상세 데이터 렌더링
 */
function renderFloorDetailData(container, viewType, data, label) {
    if (viewType === 'floorOutline') {
        renderFloorOutline(container, data, label);
    } else if (viewType === 'exposeInfo') {
        renderExposeInfo(container, data, label);
    } else if (viewType === 'exposeAreaInfo') {
        renderExposeAreaInfo(container, data, label);
    }
}

/**
 * 층별개요 렌더링 - 층별 면적/용도 테이블
 */
function renderFloorOutline(container, data, label) {
    // 지상 → 내림차순, 지하 → 오름차순 정렬
    const above = data.filter(d => d.flrGbCdNm === '지상').sort((a, b) => b.flrNo - a.flrNo);
    const below = data.filter(d => d.flrGbCdNm === '지하').sort((a, b) => a.flrNo - b.flrNo);
    const sorted = [...above, ...below];
    
    // 총면적 계산
    const totalArea = data.reduce((sum, d) => sum + (d.area || 0), 0);
    const totalPy = (totalArea / 3.3058).toFixed(1);
    
    let html = `
        <div style="background: white; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden;">
            <div style="padding: 8px 12px; background: linear-gradient(135deg, #8b5cf6, #6d28d9); color: white; display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 12px; font-weight: 600;">🏗️ ${label} (${data.length}개 층)</span>
                <span style="font-size: 11px; opacity: 0.9;">총 ${formatNumber(Math.round(totalArea))}㎡ (${formatNumber(totalPy)}평)</span>
                <button onclick="document.getElementById('floorDetailContainer').innerHTML=''" 
                        style="background: none; border: none; color: white; cursor: pointer; font-size: 14px; padding: 0 4px;">✕</button>
            </div>
            <div style="max-height: 400px; overflow-y: auto;">
                <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
                    <thead style="position: sticky; top: 0; background: #f8f9fa;">
                        <tr>
                            <th style="padding: 6px 8px; text-align: center; border-bottom: 2px solid #e5e7eb; font-weight: 600; width: 60px;">층</th>
                            <th style="padding: 6px 8px; text-align: center; border-bottom: 2px solid #e5e7eb; font-weight: 600;">구조</th>
                            <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #e5e7eb; font-weight: 600;">용도</th>
                            <th style="padding: 6px 8px; text-align: right; border-bottom: 2px solid #e5e7eb; font-weight: 600; width: 80px;">면적(㎡)</th>
                            <th style="padding: 6px 8px; text-align: right; border-bottom: 2px solid #e5e7eb; font-weight: 600; width: 70px;">면적(평)</th>
                        </tr>
                    </thead>
                    <tbody>
    `;
    
    sorted.forEach((item, idx) => {
        const floorLabel = item.flrGbCdNm === '지하' ? `B${item.flrNo}` : `${item.flrNo}F`;
        const areaPy = item.area ? (item.area / 3.3058).toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}) : '-';
        const usage = item.mainPurpsCdNm || item.etcPurps || '-';
        const bgColor = idx % 2 === 0 ? 'white' : '#f9fafb';
        const isBelow = item.flrGbCdNm === '지하';
        
        html += `
            <tr style="background: ${bgColor};">
                <td style="padding: 5px 8px; text-align: center; border-bottom: 1px solid #f0f0f0; font-weight: 600; color: ${isBelow ? '#dc2626' : '#1d4ed8'};">${floorLabel}</td>
                <td style="padding: 5px 8px; text-align: center; border-bottom: 1px solid #f0f0f0; color: #6b7280; font-size: 10px;">${item.strctCdNm || '-'}</td>
                <td style="padding: 5px 8px; text-align: left; border-bottom: 1px solid #f0f0f0;">${usage}</td>
                <td style="padding: 5px 8px; text-align: right; border-bottom: 1px solid #f0f0f0; font-family: monospace;">${item.area ? formatNumber(Math.round(item.area)) : '-'}</td>
                <td style="padding: 5px 8px; text-align: right; border-bottom: 1px solid #f0f0f0; font-family: monospace; color: #6b7280;">${areaPy}</td>
            </tr>
        `;
    });
    
    html += `
                    </tbody>
                </table>
            </div>
        </div>
    `;
    
    container.innerHTML = html;
}

/**
 * 전유부 렌더링 - 호실별 목록 (층별 그룹핑)
 */
function renderExposeInfo(container, data, label) {
    // 층별 그룹핑
    const floorMap = {};
    data.forEach(item => {
        const floorKey = `${item.flrGbCdNm}_${item.flrNo}`;
        if (!floorMap[floorKey]) {
            floorMap[floorKey] = {
                flrGbCdNm: item.flrGbCdNm,
                flrNo: item.flrNo,
                units: []
            };
        }
        floorMap[floorKey].units.push(item);
    });
    
    // 정렬: 지상 내림차순, 지하 오름차순
    const floors = Object.values(floorMap).sort((a, b) => {
        if (a.flrGbCdNm === '지상' && b.flrGbCdNm === '지하') return -1;
        if (a.flrGbCdNm === '지하' && b.flrGbCdNm === '지상') return 1;
        if (a.flrGbCdNm === '지상') return b.flrNo - a.flrNo;
        return a.flrNo - b.flrNo;
    });
    
    // ★ 전유부 데이터를 window에 임시 저장 (상세 모달에서 참조용)
    window._exposeInfoData = data;
    
    let html = `
        <div style="background: white; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden;">
            <div style="padding: 8px 12px; background: linear-gradient(135deg, #059669, #047857); color: white; display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 12px; font-weight: 600;">📋 ${label} (총 ${data.length}개 호실)</span>
                <button onclick="document.getElementById('floorDetailContainer').innerHTML=''" 
                        style="background: none; border: none; color: white; cursor: pointer; font-size: 14px; padding: 0 4px;">✕</button>
            </div>
            <div style="max-height: 400px; overflow-y: auto; padding: 8px;">
    `;
    
    floors.forEach(floor => {
        const floorLabel = floor.flrGbCdNm === '지하' ? `B${floor.flrNo}` : `${floor.flrNo}F`;
        const isBelow = floor.flrGbCdNm === '지하';
        
        html += `
            <div style="margin-bottom: 6px; padding: 6px 10px; background: ${isBelow ? '#fef2f2' : '#eff6ff'}; border-radius: 6px; border-left: 3px solid ${isBelow ? '#dc2626' : '#3b82f6'};">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 12px; font-weight: 700; color: ${isBelow ? '#dc2626' : '#1d4ed8'};">${floorLabel}</span>
                    <span style="font-size: 10px; color: #6b7280;">${floor.units.length}개 호실</span>
                </div>
                <div style="margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px;">
                    ${floor.units.map((unit, idx) => {
                        const unitName = unit.hoNm || '?';
                        // ★ 각 호실에 고유 인덱스를 부여하여 클릭 시 상세 모달 표시
                        const dataIdx = data.indexOf(unit);
                        return `<span onclick="window.showUnitDetailModal(${dataIdx})" 
                            style="padding: 2px 6px; background: white; border-radius: 3px; font-size: 10px; color: #374151; border: 1px solid #e5e7eb; cursor: pointer; transition: all 0.15s;"
                            onmouseover="this.style.background='#dbeafe'; this.style.borderColor='#3b82f6'; this.style.color='#1d4ed8';"
                            onmouseout="this.style.background='white'; this.style.borderColor='#e5e7eb'; this.style.color='#374151';"
                            title="클릭하여 상세정보 보기">${unitName}</span>`;
                    }).join('')}
                </div>
            </div>
        `;
    });
    
    html += `
            </div>
        </div>
    `;
    
    container.innerHTML = html;
}

/**
 * ★ 전유부 호실 상세 모달 표시
 * @param {number} dataIdx - window._exposeInfoData 배열 인덱스
 */
window.showUnitDetailModal = function(dataIdx) {
    const data = window._exposeInfoData;
    if (!data || !data[dataIdx]) {
        console.warn('전유부 데이터 없음:', dataIdx);
        return;
    }
    
    const unit = data[dataIdx];
    const floorLabel = unit.flrGbCdNm === '지하' ? `B${unit.flrNo}` : `${unit.flrNo}F`;
    const isBelow = unit.flrGbCdNm === '지하';
    const floorColor = isBelow ? '#dc2626' : '#1d4ed8';
    
    // 면적 변환 (㎡ → 평)
    const areaSqm = unit.area || 0;
    const areaPy = areaSqm ? (areaSqm / 3.3058).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '-';
    
    // 같은 층의 다른 호실 목록 (네비게이션용)
    const sameFloor = data.filter(d => d.flrGbCdNm === unit.flrGbCdNm && d.flrNo === unit.flrNo);
    const currentIdx = sameFloor.indexOf(unit);
    
    // 기존 모달 제거
    const existingModal = document.getElementById('unitDetailOverlay');
    if (existingModal) existingModal.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'unitDetailOverlay';
    overlay.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.45); z-index:10001; display:flex; justify-content:center; align-items:center; animation: fadeIn 0.15s ease;';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    
    overlay.innerHTML = `
        <div style="background: white; border-radius: 12px; width: 380px; max-width: 90vw; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden; animation: slideUp 0.2s ease;" onclick="event.stopPropagation()">
            <!-- 헤더 -->
            <div style="padding: 14px 18px; background: linear-gradient(135deg, ${isBelow ? '#dc2626' : '#3b82f6'}, ${isBelow ? '#b91c1c' : '#2563eb'}); color: white;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-size: 16px; font-weight: 700;">${floorLabel} - ${unit.hoNm || '호실명 없음'}</div>
                        <div style="font-size: 11px; opacity: 0.85; margin-top: 2px;">전유부 상세정보</div>
                    </div>
                    <button onclick="document.getElementById('unitDetailOverlay').remove()" 
                            style="background: rgba(255,255,255,0.2); border: none; color: white; width: 30px; height: 30px; border-radius: 50%; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center;">✕</button>
                </div>
            </div>
            
            <!-- 상세 정보 -->
            <div style="padding: 16px 18px;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div style="padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
                        <div style="font-size: 10px; color: #64748b; font-weight: 500;">층</div>
                        <div style="font-size: 15px; font-weight: 700; color: ${floorColor}; margin-top: 2px;">${floorLabel}</div>
                    </div>
                    <div style="padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
                        <div style="font-size: 10px; color: #64748b; font-weight: 500;">호실</div>
                        <div style="font-size: 15px; font-weight: 700; color: #1e293b; margin-top: 2px;">${unit.hoNm || '-'}</div>
                    </div>
                </div>
                
                <div style="margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div style="padding: 10px; background: #eff6ff; border-radius: 8px; border: 1px solid #bfdbfe;">
                        <div style="font-size: 10px; color: #3b82f6; font-weight: 500;">면적 (㎡)</div>
                        <div style="font-size: 15px; font-weight: 700; color: #1e40af; margin-top: 2px;">${areaSqm ? areaSqm.toLocaleString() + ' ㎡' : '-'}</div>
                    </div>
                    <div style="padding: 10px; background: #f0fdf4; border-radius: 8px; border: 1px solid #bbf7d0;">
                        <div style="font-size: 10px; color: #059669; font-weight: 500;">면적 (평)</div>
                        <div style="font-size: 15px; font-weight: 700; color: #047857; margin-top: 2px;">${areaPy} 평</div>
                    </div>
                </div>
                
                <!-- 상세 속성 테이블 -->
                <div style="margin-top: 12px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                        ${[
                            ['주용도', unit.mainPurpsCdNm || '-'],
                            ['기타용도', unit.etcPurps || '-'],
                            ['구조', unit.strctCdNm || '-'],
                            ['층구분', `${unit.flrGbCdNm || '-'} ${unit.flrNo || ''}층`],
                            ['전유공용 구분', unit.exposPubuseGbCdNm || '-'],
                        ].map(([label, value], i) => `
                            <tr style="background: ${i % 2 === 0 ? '#f8fafc' : 'white'};">
                                <td style="padding: 7px 10px; color: #64748b; font-weight: 500; width: 100px; border-bottom: 1px solid #f1f5f9;">${label}</td>
                                <td style="padding: 7px 10px; color: #1e293b; border-bottom: 1px solid #f1f5f9;">${value}</td>
                            </tr>
                        `).join('')}
                    </table>
                </div>
                
                <!-- 같은 층 다른 호실 네비게이션 -->
                ${sameFloor.length > 1 ? `
                    <div style="margin-top: 12px; padding: 8px 10px; background: #faf5ff; border-radius: 8px; border: 1px solid #e9d5ff;">
                        <div style="font-size: 10px; color: #7c3aed; font-weight: 600; margin-bottom: 6px;">${floorLabel} 다른 호실 (${sameFloor.length}개)</div>
                        <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                            ${sameFloor.map((u, i) => {
                                const globalIdx = data.indexOf(u);
                                const isCurrent = i === currentIdx;
                                return `<span onclick="${isCurrent ? '' : `document.getElementById('unitDetailOverlay').remove(); window.showUnitDetailModal(${globalIdx})`}" 
                                    style="padding: 3px 8px; border-radius: 4px; font-size: 10px; cursor: ${isCurrent ? 'default' : 'pointer'};
                                    background: ${isCurrent ? '#7c3aed' : 'white'}; color: ${isCurrent ? 'white' : '#6b7280'}; 
                                    border: 1px solid ${isCurrent ? '#7c3aed' : '#d4d4d8'}; font-weight: ${isCurrent ? '600' : '400'};">${u.hoNm || '?'}</span>`;
                            }).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        </div>
    `;
    
    document.body.appendChild(overlay);
};

/**
 * 전유공용면적 렌더링 - 호실별 면적 테이블
 */
function renderExposeAreaInfo(container, data, label) {
    // 전유부만 필터 (공용부 제외하고 보여줄 수도 있음)
    const privateOnly = data.filter(d => d.exposPubuseGbCdNm === '전유');
    const publicOnly = data.filter(d => d.exposPubuseGbCdNm === '공용');
    
    // 층별 그룹핑 (전유 기준)
    const displayData = privateOnly.length > 0 ? privateOnly : data;
    
    // 호실별로 그룹핑 → 같은 호실의 면적 합산
    const unitMap = {};
    displayData.forEach(item => {
        const key = `${item.flrGbCdNm}_${item.flrNo}_${item.hoNm || 'unknown'}`;
        if (!unitMap[key]) {
            unitMap[key] = { ...item, totalArea: 0 };
        }
        unitMap[key].totalArea += item.area || 0;
    });
    
    const units = Object.values(unitMap).sort((a, b) => {
        if (a.flrGbCdNm === '지상' && b.flrGbCdNm === '지하') return -1;
        if (a.flrGbCdNm === '지하' && b.flrGbCdNm === '지상') return 1;
        if (a.flrGbCdNm === '지상') return b.flrNo - a.flrNo || (a.hoNm || '').localeCompare(b.hoNm || '');
        return a.flrNo - b.flrNo || (a.hoNm || '').localeCompare(b.hoNm || '');
    });
    
    const totalArea = displayData.reduce((sum, d) => sum + (d.area || 0), 0);
    const totalPy = (totalArea / 3.3058).toFixed(1);
    
    let html = `
        <div style="background: white; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden;">
            <div style="padding: 8px 12px; background: linear-gradient(135deg, #d97706, #b45309); color: white; display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 12px; font-weight: 600;">📐 ${label} ${privateOnly.length > 0 ? '(전유)' : ''}</span>
                <span style="font-size: 11px; opacity: 0.9;">총 ${formatNumber(Math.round(totalArea))}㎡ (${formatNumber(totalPy)}평)</span>
                <button onclick="document.getElementById('floorDetailContainer').innerHTML=''" 
                        style="background: none; border: none; color: white; cursor: pointer; font-size: 14px; padding: 0 4px;">✕</button>
            </div>
            <div style="max-height: 400px; overflow-y: auto;">
                <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
                    <thead style="position: sticky; top: 0; background: #f8f9fa;">
                        <tr>
                            <th style="padding: 6px 8px; text-align: center; border-bottom: 2px solid #e5e7eb; font-weight: 600; width: 50px;">층</th>
                            <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #e5e7eb; font-weight: 600;">호실</th>
                            <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #e5e7eb; font-weight: 600;">용도</th>
                            <th style="padding: 6px 8px; text-align: right; border-bottom: 2px solid #e5e7eb; font-weight: 600; width: 75px;">면적(㎡)</th>
                            <th style="padding: 6px 8px; text-align: right; border-bottom: 2px solid #e5e7eb; font-weight: 600; width: 65px;">면적(평)</th>
                        </tr>
                    </thead>
                    <tbody>
    `;
    
    units.forEach((item, idx) => {
        const floorLabel = item.flrGbCdNm === '지하' ? `B${item.flrNo}` : `${item.flrNo}F`;
        const areaPy = item.totalArea ? (item.totalArea / 3.3058).toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}) : '-';
        const usage = item.mainPurpsCdNm || item.etcPurps || '-';
        const bgColor = idx % 2 === 0 ? 'white' : '#f9fafb';
        const isBelow = item.flrGbCdNm === '지하';
        
        html += `
            <tr style="background: ${bgColor};">
                <td style="padding: 5px 8px; text-align: center; border-bottom: 1px solid #f0f0f0; font-weight: 600; color: ${isBelow ? '#dc2626' : '#1d4ed8'};">${floorLabel}</td>
                <td style="padding: 5px 8px; text-align: left; border-bottom: 1px solid #f0f0f0; font-weight: 500;">${item.hoNm || '-'}</td>
                <td style="padding: 5px 8px; text-align: left; border-bottom: 1px solid #f0f0f0; color: #6b7280;">${usage}</td>
                <td style="padding: 5px 8px; text-align: right; border-bottom: 1px solid #f0f0f0; font-family: monospace;">${item.totalArea ? formatNumber(Math.round(item.totalArea)) : '-'}</td>
                <td style="padding: 5px 8px; text-align: right; border-bottom: 1px solid #f0f0f0; font-family: monospace; color: #6b7280;">${areaPy}</td>
            </tr>
        `;
    });
    
    // 공용면적 합계 행
    if (publicOnly.length > 0) {
        const publicArea = publicOnly.reduce((sum, d) => sum + (d.area || 0), 0);
        const publicPy = (publicArea / 3.3058).toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1});
        html += `
            <tr style="background: #f0fdf4; font-weight: 600;">
                <td colspan="3" style="padding: 5px 8px; text-align: right; border-top: 2px solid #e5e7eb; font-size: 10px; color: #059669;">공용면적 합계</td>
                <td style="padding: 5px 8px; text-align: right; border-top: 2px solid #e5e7eb; font-family: monospace; color: #059669;">${formatNumber(Math.round(publicArea))}</td>
                <td style="padding: 5px 8px; text-align: right; border-top: 2px solid #e5e7eb; font-family: monospace; color: #059669;">${publicPy}</td>
            </tr>
        `;
    }
    
    html += `
                    </tbody>
                </table>
            </div>
        </div>
    `;
    
    container.innerHTML = html;
}

// 전역 등록
window.fetchBuildingFloorDetail = fetchBuildingFloorDetail;

// ===== 이미지 뷰어 & 갤러리 =====

// 2컬럼 이미지 갤러리 스타일 주입
(function injectImageGalleryStyles() {
    if (document.getElementById('imageGalleryStyles')) return;
    const style = document.createElement('style');
    style.id = 'imageGalleryStyles';
    style.textContent = `
        /* 2컬럼 이미지 갤러리 */
        .image-gallery-dual {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-bottom: 16px;
        }
        .image-column {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .column-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 0;
            border-bottom: 2px solid #e5e7eb;
        }
        .column-title {
            font-size: 13px;
            font-weight: 600;
            color: #374151;
        }
        .column-count {
            font-size: 11px;
            color: #9ca3af;
        }
        /* ★ v4.3: 섹션 헤더 붙여넣기 버튼 */
        .column-header-right {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .btn-paste-image {
            padding: 2px 8px;
            background: #eff6ff;
            border: 1px solid #bfdbfe;
            border-radius: 5px;
            color: #2563eb;
            font-size: 11px;
            font-weight: 600;
            line-height: 1.6;
            cursor: pointer;
            transition: all 0.15s;
        }
        .btn-paste-image:hover {
            background: #2563eb;
            border-color: #2563eb;
            color: #fff;
        }
        
        /* 메인 이미지 영역 */
        .image-main-area {
            position: relative;
            width: 100%;
            height: 140px;
            background: #f8f9fa;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            overflow: hidden;
            cursor: pointer;
        }
        .image-main-area img {
            width: 100%;
            height: 100%;
            object-fit: contain;
        }
        .image-main-area .image-overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.4);
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 13px;
            opacity: 0;
            transition: opacity 0.2s;
        }
        .image-main-area:hover .image-overlay {
            opacity: 1;
        }
        
        /* 캐러셀 버튼 */
        .carousel-btn {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            width: 28px;
            height: 28px;
            background: rgba(255,255,255,0.9);
            border: none;
            border-radius: 50%;
            font-size: 16px;
            color: #374151;
            cursor: pointer;
            z-index: 10;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .carousel-btn:hover {
            background: white;
        }
        .carousel-btn.prev { left: 6px; }
        .carousel-btn.next { right: 6px; }
        .image-counter {
            position: absolute;
            bottom: 6px;
            right: 6px;
            background: rgba(0,0,0,0.6);
            color: white;
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 10px;
        }
        
        /* 썸네일 행 */
        .image-thumbs-row {
            display: flex;
            gap: 6px;
            overflow-x: auto;
            padding: 4px 0;
        }
        .image-thumbs-row::-webkit-scrollbar {
            height: 4px;
        }
        .image-thumbs-row::-webkit-scrollbar-thumb {
            background: #d1d5db;
            border-radius: 2px;
        }
        .thumb-item {
            position: relative;
            flex-shrink: 0;
            width: 48px;
            height: 36px;
            border: 2px solid transparent;
            border-radius: 4px;
            overflow: hidden;
            cursor: pointer;
            transition: border-color 0.2s;
        }
        .thumb-item:hover {
            border-color: #93c5fd;
        }
        .thumb-item.active {
            border-color: #3b82f6;
        }
        .thumb-item img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        /* ★ 썸네일 삭제 버튼 */
        .thumb-delete-btn {
            position: absolute;
            top: -2px;
            right: -2px;
            width: 18px;
            height: 18px;
            background: #ef4444;
            color: white;
            border: 1.5px solid white;
            border-radius: 50%;
            font-size: 11px;
            line-height: 14px;
            text-align: center;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.15s;
            z-index: 5;
            padding: 0;
        }
        .thumb-item:hover .thumb-delete-btn {
            opacity: 1;
        }
        .thumb-delete-btn:hover {
            background: #dc2626;
            transform: scale(1.1);
        }
        
        /* ★ 이미지 삭제 확인 모달 */
        .img-confirm-overlay {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.6);
            z-index: 20000;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: fadeIn 0.15s ease;
        }
        .img-confirm-dialog {
            background: white;
            border-radius: 14px;
            width: 340px;
            max-width: 90vw;
            overflow: hidden;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            animation: slideUp 0.2s ease;
        }
        @keyframes slideUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        .img-confirm-preview {
            width: 100%;
            height: 180px;
            background: #f1f5f9;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }
        .img-confirm-preview img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
        }
        .img-confirm-body {
            padding: 20px;
            text-align: center;
        }
        .img-confirm-body h4 {
            margin: 0 0 6px;
            font-size: 15px;
            color: #1f2937;
        }
        .img-confirm-body p {
            margin: 0 0 18px;
            font-size: 12px;
            color: #6b7280;
        }
        .img-confirm-actions {
            display: flex;
            gap: 10px;
        }
        .img-confirm-actions button {
            flex: 1;
            padding: 10px;
            border: none;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s;
        }
        .img-confirm-cancel {
            background: #f3f4f6;
            color: #374151;
        }
        .img-confirm-cancel:hover { background: #e5e7eb; }
        .img-confirm-delete {
            background: #ef4444;
            color: white;
        }
        .img-confirm-delete:hover { background: #dc2626; }
        /* ★ v4.3: 붙여넣기 미리보기 저장 버튼 */
        .img-confirm-save {
            background: #2563eb;
            color: white;
        }
        .img-confirm-save:hover { background: #1d4ed8; }
        .img-confirm-save:disabled { background: #93c5fd; cursor: default; }
        
        /* 추가 버튼 */
        .btn-add-image {
            width: 100%;
            padding: 6px;
            background: #f8f9fa;
            border: 1px dashed #d1d5db;
            border-radius: 6px;
            color: #6b7280;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .btn-add-image:hover {
            background: #f0f9ff;
            border-color: #3b82f6;
            color: #3b82f6;
        }
        
        /* 빈 상태 영역 */
        .image-empty-area {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 140px;
            background: #f8f9fa;
            border: 2px dashed #d1d5db;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .image-empty-area:hover {
            background: #f0f9ff;
            border-color: #3b82f6;
        }
        .empty-icon {
            font-size: 32px;
            margin-bottom: 8px;
            opacity: 0.5;
        }
        .empty-text {
            font-size: 12px;
            color: #9ca3af;
            margin-bottom: 8px;
        }
        .btn-add-empty {
            padding: 6px 12px;
            background: #3b82f6;
            border: none;
            border-radius: 6px;
            color: white;
            font-size: 12px;
            cursor: pointer;
        }
        .btn-add-empty:hover {
            background: #2563eb;
        }
        
        /* 이미지 뷰어 모달 */
        .image-viewer-modal {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.95);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .viewer-container {
            position: relative;
            width: 90%;
            height: 90%;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .viewer-close {
            position: absolute;
            top: -40px;
            right: 0;
            width: 36px;
            height: 36px;
            background: rgba(255,255,255,0.1);
            border: none;
            border-radius: 50%;
            color: white;
            font-size: 24px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .viewer-close:hover { background: rgba(255,255,255,0.2); }
        .viewer-nav {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            width: 50px;
            height: 50px;
            background: rgba(255,255,255,0.1);
            border: none;
            border-radius: 50%;
            color: white;
            font-size: 28px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .viewer-nav:hover { background: rgba(255,255,255,0.2); }
        .viewer-nav.prev { left: 10px; }
        .viewer-nav.next { right: 10px; }
        .viewer-image-wrapper {
            max-width: calc(100% - 140px);
            max-height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .viewer-image-wrapper img {
            max-width: 100%;
            max-height: 80vh;
            object-fit: contain;
            border-radius: 4px;
        }
        .viewer-info {
            position: absolute;
            bottom: -40px;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            gap: 16px;
            color: rgba(255,255,255,0.8);
            font-size: 14px;
        }
        .viewer-actions {
            position: absolute;
            bottom: -40px;
            right: 0;
            display: flex;
            gap: 8px;
        }
        .viewer-actions button {
            padding: 6px 12px;
            border: none;
            border-radius: 4px;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .btn-add-viewer {
            background: #3b82f6;
            color: white;
        }
        .btn-add-viewer:hover { background: #2563eb; }
        .btn-delete-viewer {
            background: #ef4444;
            color: white;
        }
        .btn-delete-viewer:hover { background: #dc2626; }
    `;
    document.head.appendChild(style);
})();

// 캐러셀 네비게이션
window.carouselNav = function(type, direction) {
    const b = state.selectedBuilding;
    if (!b) return;
    
    const images = type === 'exterior' ? (b.exteriorImages || []) : (b.floorPlanImages || []);
    if (images.length <= 1) return;
    
    const idxKey = type === 'exterior' ? '_exteriorIdx' : '_floorplanIdx';
    let currentIdx = window[idxKey] || 0;
    
    currentIdx += direction;
    if (currentIdx < 0) currentIdx = images.length - 1;
    if (currentIdx >= images.length) currentIdx = 0;
    
    window[idxKey] = currentIdx;
    
    // 메인 이미지 업데이트
    const mainImg = document.getElementById(type === 'exterior' ? 'exteriorMainImg' : 'floorplanMainImg');
    if (mainImg) mainImg.src = images[currentIdx].url;
    
    // 카운터 업데이트
    const counter = document.getElementById(type === 'exterior' ? 'exteriorCounter' : 'floorplanCounter');
    if (counter) counter.textContent = `${currentIdx + 1} / ${images.length}`;
    
    // 썸네일 active 상태 업데이트
    const thumbsRow = document.getElementById(type === 'exterior' ? 'exteriorThumbsRow' : 'floorplanThumbsRow');
    if (thumbsRow) {
        thumbsRow.querySelectorAll('.thumb-item').forEach((thumb, i) => {
            thumb.classList.toggle('active', i === currentIdx);
        });
    }
};

// 썸네일 클릭으로 이미지 선택
window.selectImage = function(type, index) {
    const b = state.selectedBuilding;
    if (!b) return;
    
    const images = type === 'exterior' ? (b.exteriorImages || []) : (b.floorPlanImages || []);
    if (index >= images.length) return;
    
    const idxKey = type === 'exterior' ? '_exteriorIdx' : '_floorplanIdx';
    window[idxKey] = index;
    
    // 메인 이미지 업데이트
    const mainImg = document.getElementById(type === 'exterior' ? 'exteriorMainImg' : 'floorplanMainImg');
    if (mainImg) mainImg.src = images[index].url;
    
    // 카운터 업데이트
    const counter = document.getElementById(type === 'exterior' ? 'exteriorCounter' : 'floorplanCounter');
    if (counter) counter.textContent = `${index + 1} / ${images.length}`;
    
    // 썸네일 active 상태 업데이트
    const thumbsRow = document.getElementById(type === 'exterior' ? 'exteriorThumbsRow' : 'floorplanThumbsRow');
    if (thumbsRow) {
        thumbsRow.querySelectorAll('.thumb-item').forEach((thumb, i) => {
            thumb.classList.toggle('active', i === index);
        });
    }
};

// 이미지 탭 전환 (하위 호환용)
window.switchImageTab = function(tab) {
    const exteriorTab = document.querySelector('.image-tab:first-child');
    const floorplanTab = document.querySelector('.image-tab:last-child');
    const exteriorThumbs = document.getElementById('exteriorThumbnails');
    const floorplanThumbs = document.getElementById('floorplanThumbnails');
    
    if (tab === 'exterior') {
        exteriorTab?.classList.add('active');
        floorplanTab?.classList.remove('active');
        if (exteriorThumbs) exteriorThumbs.style.display = '';
        if (floorplanThumbs) floorplanThumbs.style.display = 'none';
    } else {
        exteriorTab?.classList.remove('active');
        floorplanTab?.classList.add('active');
        if (exteriorThumbs) exteriorThumbs.style.display = 'none';
        if (floorplanThumbs) floorplanThumbs.style.display = '';
    }
};

// 이미지 뷰어 열기
window.openImageViewer = function(type, index) {
    const b = state.selectedBuilding;
    if (!b) return;
    
    const images = type === 'exterior' ? (b.exteriorImages || []) : (b.floorPlanImages || []);
    if (images.length === 0) return;
    
    let currentIndex = index;
    
    const viewerHtml = `
        <div id="imageViewerModal" class="image-viewer-modal" onclick="if(event.target === this) closeImageViewer()">
            <div class="viewer-container">
                <button class="viewer-close" onclick="closeImageViewer()">×</button>
                <button class="viewer-nav prev" onclick="navigateImage(-1)" ${images.length <= 1 ? 'style="display:none"' : ''}>‹</button>
                <div class="viewer-image-wrapper">
                    <img id="viewerMainImage" src="${images[currentIndex]?.url || images[currentIndex]}" alt="">
                </div>
                <button class="viewer-nav next" onclick="navigateImage(1)" ${images.length <= 1 ? 'style="display:none"' : ''}>›</button>
                <div class="viewer-info">
                    <span id="viewerImageCount">${currentIndex + 1} / ${images.length}</span>
                    <span class="viewer-type">${type === 'exterior' ? '🏢 외관' : '📐 평면도'}</span>
                </div>
                <div class="viewer-actions">
                    ${type === 'exterior' ? `
                        <button class="btn-add-viewer" onclick="addExteriorImage()">➕ 외관 추가</button>
                        <button class="btn-delete-viewer" onclick="deleteExteriorImage()">🗑️ 이 이미지 삭제</button>
                    ` : `
                        <button class="btn-add-viewer" onclick="addFloorPlanImage()">➕ 평면도 추가</button>
                        <button class="btn-delete-viewer" onclick="deleteFloorPlanImage()">🗑️ 이 이미지 삭제</button>
                    `}
                </div>
            </div>
        </div>
    `;
    
    // 기존 모달 제거
    const existing = document.getElementById('imageViewerModal');
    if (existing) existing.remove();
    
    document.body.insertAdjacentHTML('beforeend', viewerHtml);
    
    // 전역 상태 저장 (네비게이션용)
    window._imageViewerState = { type, images, currentIndex };
    
    // ESC 키로 닫기
    document.addEventListener('keydown', handleViewerKeydown);
};

function handleViewerKeydown(e) {
    if (e.key === 'Escape') closeImageViewer();
    if (e.key === 'ArrowLeft') navigateImage(-1);
    if (e.key === 'ArrowRight') navigateImage(1);
}

window.closeImageViewer = function() {
    const modal = document.getElementById('imageViewerModal');
    if (modal) modal.remove();
    document.removeEventListener('keydown', handleViewerKeydown);
    window._imageViewerState = null;
};

window.navigateImage = function(direction) {
    const state = window._imageViewerState;
    if (!state) return;
    
    let newIndex = state.currentIndex + direction;
    if (newIndex < 0) newIndex = state.images.length - 1;
    if (newIndex >= state.images.length) newIndex = 0;
    
    state.currentIndex = newIndex;
    
    const img = document.getElementById('viewerMainImage');
    const count = document.getElementById('viewerImageCount');
    
    if (img) img.src = state.images[newIndex]?.url || state.images[newIndex];
    if (count) count.textContent = `${newIndex + 1} / ${state.images.length}`;
};

// 평면도 이미지 추가
window.addFloorPlanImage = function() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        // 파일 크기 체크 (5MB)
        if (file.size > 5 * 1024 * 1024) {
            showToast('파일 크기는 5MB 이하여야 합니다', 'warning');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = async (ev) => {
            const imageData = ev.target.result;
            const b = state.selectedBuilding;
            if (!b) return;
            
            // 현재 평면도 배열 가져오기
            // ★ v4.4: 표시에 쓰이는 목록을 기준으로 이어붙이고 두 경로에 함께 기록
            const floorPlanImages = [...getImageUrls(b, 'floorPlan'), imageData];

            try {
                await persistImageUrls(b, 'floorPlan', floorPlanImages);
                
                // 로컬 상태 업데이트
                if (!b.images) b.images = {};
                b.images.floorPlan = floorPlanImages;
                b.floorPlanImages = floorPlanImages.map(img => typeof img === 'string' ? { url: img } : img);
                
                showToast('평면도가 추가되었습니다', 'success');
                closeImageViewer();
                renderInfoSection();
            } catch (err) {
                console.error('평면도 추가 실패:', err);
                showToast('평면도 추가 실패', 'error');
            }
        };
        reader.readAsDataURL(file);
    };
    input.click();
};

// ★ 이미지 삭제 확인 모달 표시
window.confirmDeleteImage = function(type, index) {
    const b = state.selectedBuilding;
    if (!b) return;
    
    // 뷰어에서 호출된 경우 뷰어 상태의 인덱스 사용
    if (index === undefined || index === null) {
        const viewerState = window._imageViewerState;
        index = viewerState?.currentIndex ?? 0;
    }
    
    const images = type === 'exterior' ? (b.exteriorImages || []) :
                   type === 'floorplan' ? (b.floorPlanImages || []) : [];
    if (index < 0 || index >= images.length) return;
    
    const imageUrl = images[index]?.url || images[index];
    const typeLabel = type === 'exterior' ? '외관 사진' : '평면도';
    
    // 기존 확인 모달 제거
    const existing = document.getElementById('imgConfirmOverlay');
    if (existing) existing.remove();
    
    const html = `
        <div id="imgConfirmOverlay" class="img-confirm-overlay" onclick="if(event.target===this) cancelDeleteImage()">
            <div class="img-confirm-dialog">
                <div class="img-confirm-preview">
                    <img src="${imageUrl}" alt="삭제 대상">
                </div>
                <div class="img-confirm-body">
                    <h4>🗑️ ${typeLabel} 삭제</h4>
                    <p>${typeLabel} ${index + 1}번째 이미지를 삭제하시겠습니까?<br>이 작업은 되돌릴 수 없습니다.</p>
                    <div class="img-confirm-actions">
                        <button class="img-confirm-cancel" onclick="cancelDeleteImage()">취소</button>
                        <button class="img-confirm-delete" onclick="executeDeleteImage('${type}', ${index})">삭제</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', html);
};

// 삭제 확인 모달 닫기
window.cancelDeleteImage = function() {
    const overlay = document.getElementById('imgConfirmOverlay');
    if (overlay) overlay.remove();
};

// 실제 이미지 삭제 실행
window.executeDeleteImage = async function(type, index) {
    // 확인 모달 닫기
    cancelDeleteImage();
    
    const b = state.selectedBuilding;
    if (!b) return;
    
    const isExterior = (type === 'exterior');
    const fieldName = isExterior ? 'exterior' : 'floorPlan';
    const typeLabel = isExterior ? '외관 사진' : '평면도';
    
    // ★ v4.4: 화면에 보이는 목록 기준으로 지우고 두 경로를 함께 갱신
    const images = getImageUrls(b, fieldName).filter((_, i) => i !== index);

    try {
        await persistImageUrls(b, fieldName, images);
        
        if (isExterior) {
            b.exteriorImages = images.map(img => typeof img === 'string' ? { url: img } : img);
        } else {
            b.floorPlanImages = images.map(img => typeof img === 'string' ? { url: img } : img);
        }
        
        showToast(`${typeLabel}이(가) 삭제되었습니다`, 'success');
        
        // 뷰어가 열려있으면 닫기
        closeImageViewer();
        
        // 갤러리 새로고침
        renderInfoSection();
    } catch (err) {
        console.error(`${typeLabel} 삭제 실패:`, err);
        showToast(`${typeLabel} 삭제 실패`, 'error');
    }
};

// 평면도 이미지 삭제 (뷰어에서 호출 - 확인 모달 거침)
window.deleteFloorPlanImage = function() {
    const viewerState = window._imageViewerState;
    const index = viewerState?.currentIndex ?? 0;
    confirmDeleteImage('floorplan', index);
};

// 외관 이미지 추가
window.addExteriorImage = function() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        // 파일 크기 체크 (5MB)
        if (file.size > 5 * 1024 * 1024) {
            showToast('파일 크기는 5MB 이하여야 합니다', 'warning');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = async (ev) => {
            const imageData = ev.target.result;
            const b = state.selectedBuilding;
            if (!b) return;
            
            // 현재 외관 이미지 배열 가져오기
            // ★ v4.4: 표시에 쓰이는 목록을 기준으로 이어붙이고 두 경로에 함께 기록
            const exteriorImages = [...getImageUrls(b, 'exterior'), imageData];

            try {
                await persistImageUrls(b, 'exterior', exteriorImages);
                
                // 로컬 상태 업데이트
                if (!b.images) b.images = {};
                b.images.exterior = exteriorImages;
                b.exteriorImages = exteriorImages.map(img => typeof img === 'string' ? { url: img } : img);
                
                showToast('외관 사진이 추가되었습니다', 'success');
                closeImageViewer();
                renderInfoSection();
            } catch (err) {
                console.error('외관 사진 추가 실패:', err);
                showToast('외관 사진 추가 실패', 'error');
            }
        };
        reader.readAsDataURL(file);
    };
    input.click();
};

// 외관 이미지 삭제 (뷰어에서 호출 - 확인 모달 거침)
window.deleteExteriorImage = function() {
    const viewerState = window._imageViewerState;
    const index = viewerState?.currentIndex ?? 0;
    confirmDeleteImage('exterior', index);
};

// ===== ★ v4.3: 클립보드 이미지 붙여넣기 (섹션 버튼 + 미리보기 확인 후 저장) =====
//   경로 2개 → 동일한 미리보기 모달로 수렴
//   (A) 섹션 헤더 "📋 붙여넣기" 버튼 → pasteImageFromClipboard(type)
//   (B) 기존 Ctrl+V 전역 리스너(portal.html v4.1) → 대상 선택 팝업 → savePastedImage(file, type)

const PASTE_TYPE_LABEL = { exterior: '외관 사진', floorplan: '평면도' };

// (A) 섹션 헤더 버튼 — 클립보드를 직접 읽어 해당 섹션으로 바로 진입
window.pasteImageFromClipboard = async function(type) {
    if (!state.selectedBuilding) {
        showToast('빌딩을 먼저 선택하세요', 'warning');
        return;
    }
    if (!navigator.clipboard?.read) {
        showToast('이 브라우저는 버튼 붙여넣기를 지원하지 않습니다. Ctrl+V를 사용하세요', 'warning');
        return;
    }
    try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
            const mime = item.types.find(t => t.startsWith('image/'));
            if (mime) {
                const blob = await item.getType(mime);
                window.savePastedImage(blob, type);
                return;
            }
        }
        showToast('클립보드에 이미지가 없습니다', 'warning');
    } catch (err) {
        console.error('클립보드 읽기 실패:', err);
        showToast('클립보드 접근이 거부되었습니다. Ctrl+V를 사용하세요', 'warning');
    }
};

// 공통 진입점 — 즉시 저장하지 않고 미리보기 모달을 띄운다
window.savePastedImage = async function(file, type) {
    if (file.size > 5 * 1024 * 1024) {
        showToast('파일 크기는 5MB 이하여야 합니다', 'warning');
        return;
    }
    if (!state.selectedBuilding) return;

    let imageData;
    try {
        imageData = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    } catch (err) {
        console.error('붙여넣기 이미지 읽기 실패:', err);
        showToast('이미지 읽기 실패', 'error');
        return;
    }

    window._pastePendingImage = { imageData, type };
    document.getElementById('pasteConfirmOverlay')?.remove();

    const label = PASTE_TYPE_LABEL[type] || '이미지';
    const sizeKb = Math.round(imageData.length * 0.75 / 1024);

    document.body.insertAdjacentHTML('beforeend', `
        <div id="pasteConfirmOverlay" class="img-confirm-overlay" onclick="if(event.target===this) cancelPastedImage()">
            <div class="img-confirm-dialog">
                <div class="img-confirm-preview">
                    <img src="${imageData}" alt="붙여넣기 미리보기">
                </div>
                <div class="img-confirm-body">
                    <h4>📋 ${label} 추가</h4>
                    <p>클립보드 이미지를 ${label}(으)로 저장할까요?<br>약 ${sizeKb.toLocaleString()}KB</p>
                    <div class="img-confirm-actions">
                        <button class="img-confirm-cancel" onclick="cancelPastedImage()">취소</button>
                        <button class="img-confirm-save" onclick="commitPastedImage()">저장</button>
                    </div>
                </div>
            </div>
        </div>
    `);
};

// 미리보기 취소 — DB 쓰기 없음
window.cancelPastedImage = function() {
    window._pastePendingImage = null;
    document.getElementById('pasteConfirmOverlay')?.remove();
};

// 미리보기 확정 — 실제 저장 (기존 v4.1 저장 로직과 동일한 스키마)
window.commitPastedImage = async function() {
    const pending = window._pastePendingImage;
    if (!pending) return;

    const b = state.selectedBuilding;
    if (!b) { cancelPastedImage(); return; }

    const btn = document.querySelector('#pasteConfirmOverlay .img-confirm-save');
    if (btn) { btn.disabled = true; btn.textContent = '저장 중…'; }

    const isExterior = (pending.type === 'exterior');
    const fieldName = isExterior ? 'exterior' : 'floorPlan';
    const label = PASTE_TYPE_LABEL[pending.type] || '이미지';

    try {
        // ★ v4.4: 표시 목록 기준 + 두 경로 동시 기록
        const imgs = [...getImageUrls(b, fieldName), pending.imageData];
        await persistImageUrls(b, fieldName, imgs);

        const mapped = imgs.map(img => typeof img === 'string' ? { url: img } : img);
        if (isExterior) b.exteriorImages = mapped;
        else b.floorPlanImages = mapped;

        cancelPastedImage();
        showToast(`${label}이(가) 추가되었습니다`, 'success');
        window.closeImageViewer?.();
        renderInfoSection();
    } catch (err) {
        console.error('붙여넣기 이미지 저장 실패:', err);
        showToast('이미지 저장 실패', 'error');
        if (btn) { btn.disabled = false; btn.textContent = '저장'; }
    }
};

// ===== ★ v2.0: 공실 편집/삭제/이관 기능 =====

/**
 * 공실 편집 모달 열기
 * 편집 모드에서는 자동으로 소숫점 표기로 전환
 */
export function openVacancyEditModal(idx) {
    const vacancies = state.currentDisplayedVacancies || [];
    const vacancy = vacancies[idx];
    if (!vacancy) {
        showToast('공실 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    // 편집 모드 진입 시 소숫점 표기 자동 ON
    if (!state.showDecimalArea) {
        state.showDecimalArea = true;
        const toggle = document.getElementById('decimalAreaToggle');
        if (toggle) toggle.checked = true;
    }
    
    state.editingVacancyIdx = idx;
    
    // ★ 같은 출처/발행일 그룹의 공실 목록 (일괄 적용용)
    const sameGroup = vacancies.filter(v => v.source === vacancy.source && v.publishDate === vacancy.publishDate);
    const sameGroupCount = sameGroup.length;
    const sameGroupFloors = sameGroup.map(v => v.floor || '-').sort((a, b) => {
        const numA = parseInt(a.replace(/[^\d-]/g, '')) || 0;
        const numB = parseInt(b.replace(/[^\d-]/g, '')) || 0;
        return numA - numB;
    });
    
    const modalHtml = `
        <div class="modal-overlay show" id="vacancyEditModalOverlay" onclick="if(event.target===this)closeVacancyEditModal()"></div>
        <div class="modal show" id="vacancyEditModal" style="max-width: 480px; z-index: 10001;">
            <div class="modal-header">
                <h3 class="modal-title">✏️ 공실 정보 편집</h3>
                <button class="close-btn" onclick="closeVacancyEditModal()">×</button>
            </div>
            <div style="padding: 20px;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">층 <span style="color:#dc2626">*</span></label>
                        <input type="text" id="editVacFloor" value="${vacancy.floor || ''}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">입주시기</label>
                        <input type="text" id="editVacMoveIn" value="${vacancy.moveInDate || ''}" placeholder="즉시, 25년3월"
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px;">
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">임대면적 (평)</label>
                        <input type="text" inputmode="decimal" id="editVacRentArea" value="${commaFormat(vacancy.rentArea || '')}" 
                               oninput="formatNumberInputLive(this); validateExclusiveArea()"
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">전용면적 (평)</label>
                        <input type="text" inputmode="decimal" id="editVacExclusiveArea" value="${commaFormat(vacancy.exclusiveArea || '')}" 
                               oninput="formatNumberInputLive(this); validateExclusiveArea()"
                               placeholder="임대면적보다 작아야 함"
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                        <div id="exclusiveAreaError" style="display: none; color: #dc2626; font-size: 11px; margin-top: 4px;">
                            ⚠️ 전용면적은 임대면적보다 클 수 없습니다
                        </div>
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-top: 12px;">
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">보증금/평</label>
                        <input type="text" inputmode="decimal" oninput="formatNumberInputLive(this)" id="editVacDeposit" value="${commaFormat(vacancy.depositPy || '')}" placeholder="80"
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">임대료/평 <span style="color:#dc2626">*</span></label>
                        <input type="text" inputmode="decimal" oninput="formatNumberInputLive(this)" id="editVacRent" value="${commaFormat(vacancy.rentPy || '')}" placeholder="8.5"
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">관리비/평</label>
                        <input type="text" inputmode="decimal" oninput="formatNumberInputLive(this)" id="editVacMaintenance" value="${commaFormat(vacancy.maintenancePy || '')}" placeholder="3.5"
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                    </div>
                </div>
                
                <div style="margin-top: 16px; padding: 12px; background: #f8fafc; border-radius: 8px; font-size: 12px; color: #64748b;">
                    <div><strong>출처:</strong> ${vacancy.source || '-'}</div>
                    <div><strong>발행일:</strong> ${vacancy.publishDate || '-'}</div>
                </div>
                
                <!-- ★ 일괄 적용 섹션 -->
                <div style="margin-top: 16px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                    <button onclick="document.getElementById('bulkApplySection').style.display = document.getElementById('bulkApplySection').style.display === 'none' ? 'block' : 'none'"
                            style="width: 100%; padding: 10px 14px; background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: none; cursor: pointer; font-size: 12px; font-weight: 600; color: #92400e; text-align: left; display: flex; align-items: center; gap: 6px;">
                        ⚡ 보증금·임대료·관리비 일괄 적용 (같은 출처/발행일 ${sameGroupCount}개층)
                        <span style="margin-left: auto; font-size: 10px;">▼</span>
                    </button>
                    <div id="bulkApplySection" style="display: none; padding: 14px;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 12px;">
                            <div>
                                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">보증금/평</label>
                                <input type="text" id="bulkDeposit" placeholder="현재값 유지" 
                                       style="width: 100%; padding: 8px; border: 1px solid #fbbf24; border-radius: 6px; font-size: 13px; box-sizing: border-box; background: #fffbeb;">
                            </div>
                            <div>
                                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">임대료/평</label>
                                <input type="text" id="bulkRent" placeholder="현재값 유지"
                                       style="width: 100%; padding: 8px; border: 1px solid #fbbf24; border-radius: 6px; font-size: 13px; box-sizing: border-box; background: #fffbeb;">
                            </div>
                            <div>
                                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">관리비/평</label>
                                <input type="text" id="bulkMaintenance" placeholder="현재값 유지"
                                       style="width: 100%; padding: 8px; border: 1px solid #fbbf24; border-radius: 6px; font-size: 13px; box-sizing: border-box; background: #fffbeb;">
                            </div>
                        </div>
                        
                        <div style="margin-bottom: 12px;">
                            <div style="display: flex; gap: 12px; align-items: center; font-size: 12px;">
                                <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                                    <input type="radio" name="bulkRange" value="all" checked onchange="document.getElementById('bulkFloorRange').style.display='none'"> 
                                    전체 ${sameGroupCount}개층 적용
                                </label>
                                <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
                                    <input type="radio" name="bulkRange" value="range" onchange="document.getElementById('bulkFloorRange').style.display='flex'"> 
                                    층 범위 지정
                                </label>
                            </div>
                            <div id="bulkFloorRange" style="display: none; margin-top: 8px; align-items: center; gap: 6px;">
                                <select id="bulkFloorFrom" style="padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 12px;">
                                    ${sameGroupFloors.map(f => `<option value="${f}">${f}</option>`).join('')}
                                </select>
                                <span style="font-size: 12px; color: #6b7280;">~</span>
                                <select id="bulkFloorTo" style="padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 12px;">
                                    ${sameGroupFloors.map((f, i) => `<option value="${f}" ${i === sameGroupFloors.length - 1 ? 'selected' : ''}>${f}</option>`).join('')}
                                </select>
                            </div>
                        </div>
                        
                        <button onclick="bulkUpdateVacancyPricing('${(vacancy.source || '').replace(/'/g, "\\'")}', '${vacancy.publishDate || ''}')"
                                style="width: 100%; padding: 8px; background: #f59e0b; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600;">
                            ⚡ 일괄 적용
                        </button>
                    </div>
                </div>
            </div>
            <div class="form-actions" style="padding: 16px 20px; border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end; gap: 8px;">
                <button type="button" class="btn btn-secondary" onclick="closeVacancyEditModal()">취소</button>
                <button type="button" class="btn btn-primary" onclick="saveVacancyEditFromModal()">저장</button>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

/**
 * 전용면적 유효성 검사
 */
export function validateExclusiveArea() {
    const rentArea = parseFloat((document.getElementById('editVacRentArea')?.value || '').replace(/,/g, '')) || 0;
    const exclusiveArea = parseFloat((document.getElementById('editVacExclusiveArea')?.value || '').replace(/,/g, '')) || 0;
    const errorDiv = document.getElementById('exclusiveAreaError');
    const exclusiveInput = document.getElementById('editVacExclusiveArea');
    
    if (exclusiveArea > 0 && rentArea > 0 && exclusiveArea > rentArea) {
        if (errorDiv) errorDiv.style.display = 'block';
        if (exclusiveInput) exclusiveInput.style.borderColor = '#dc2626';
        return false;
    } else {
        if (errorDiv) errorDiv.style.display = 'none';
        if (exclusiveInput) exclusiveInput.style.borderColor = 'var(--border-color)';
        return true;
    }
}

/**
 * 공실 편집 모달 닫기
 */
export function closeVacancyEditModal() {
    const modal = document.getElementById('vacancyEditModal');
    const overlay = document.getElementById('vacancyEditModalOverlay');
    if (modal) modal.remove();
    if (overlay) overlay.remove();
    state.editingVacancyIdx = null;
}

/**
 * 공실 편집 저장
 */
export async function saveVacancyEditFromModal() {
    const idx = state.editingVacancyIdx;
    if (idx === null || idx === undefined) {
        console.error('editingVacancyIdx가 없습니다');
        return;
    }
    
    // 유효성 검사
    if (!validateExclusiveArea()) {
        showToast('전용면적은 임대면적보다 클 수 없습니다', 'error');
        return;
    }
    
    const vacancies = state.currentDisplayedVacancies || [];
    const vacancy = vacancies[idx];
    if (!vacancy) {
        console.error('vacancy를 찾을 수 없습니다. idx:', idx);
        return;
    }
    
    const buildingId = state.selectedBuilding?.id;
    let vacancyKey = vacancy._key;
    
    // ★ _key가 없을 경우 source_publishDate_floor로 키 생성
    if (!vacancyKey) {
        const floor = (vacancy.floor || 'UNK').replace(/[\/\s\.]/g, '_');
        const source = (vacancy.source || 'UNKNOWN').replace(/[\/\s\.]/g, '_');
        const publishDate = (vacancy.publishDate || '').replace(/[\/\s\.]/g, '_');
        vacancyKey = `${source}_${publishDate}_${floor}`;
        console.log('_key가 없어서 생성:', vacancyKey);
    }
    
    if (!buildingId || !vacancyKey) {
        console.error('buildingId 또는 vacancyKey가 없습니다:', { buildingId, vacancyKey });
        showToast('공실 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    try {
        const updatedData = {
            floor: document.getElementById('editVacFloor')?.value || '',
            rentArea: (document.getElementById('editVacRentArea')?.value || '').replace(/,/g, ''),
            exclusiveArea: (document.getElementById('editVacExclusiveArea')?.value || '').replace(/,/g, ''),
            depositPy: document.getElementById('editVacDeposit')?.value || '',
            rentPy: document.getElementById('editVacRent')?.value || '',
            maintenancePy: document.getElementById('editVacMaintenance')?.value || '',
            moveInDate: document.getElementById('editVacMoveIn')?.value || '',
            updatedAt: new Date().toISOString()
        };
        
        console.log('Firebase 업데이트 경로:', `vacancies/${buildingId}/${vacancyKey}`);
        console.log('업데이트 데이터:', updatedData);
        
        // Firebase 업데이트
        await update(ref(db, `vacancies/${buildingId}/${vacancyKey}`), updatedData);
        
        // 로컬 상태 업데이트
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (building && building.vacancies) {
            const localVacancy = building.vacancies.find(v => v._key === vacancyKey || 
                (v.source === vacancy.source && v.publishDate === vacancy.publishDate && v.floor === vacancy.floor));
            if (localVacancy) {
                Object.assign(localVacancy, updatedData);
            }
        }
        
        // currentDisplayedVacancies도 업데이트
        if (state.currentDisplayedVacancies && state.currentDisplayedVacancies[idx]) {
            Object.assign(state.currentDisplayedVacancies[idx], updatedData);
        }
        
        showToast('공실 정보가 수정되었습니다', 'success');
        closeVacancyEditModal();
        renderDocumentSection();
        
    } catch (error) {
        console.error('공실 수정 오류:', error);
        showToast('수정 중 오류가 발생했습니다: ' + error.message, 'error');
    }
}

/**
 * ★ 보증금/임대료/관리비 일괄 적용
 */
export async function bulkUpdateVacancyPricing(source, publishDate) {
    const bulkDeposit = document.getElementById('bulkDeposit')?.value?.trim();
    const bulkRent = document.getElementById('bulkRent')?.value?.trim();
    const bulkMaintenance = document.getElementById('bulkMaintenance')?.value?.trim();
    
    if (!bulkDeposit && !bulkRent && !bulkMaintenance) {
        showToast('적용할 값을 1개 이상 입력하세요', 'error');
        return;
    }
    
    const rangeMode = document.querySelector('input[name="bulkRange"]:checked')?.value || 'all';
    const buildingId = state.selectedBuilding?.id;
    if (!buildingId) return;
    
    // 같은 출처/발행일 그룹의 공실 필터
    let targets = (state.currentDisplayedVacancies || []).filter(
        v => v.source === source && v.publishDate === publishDate
    );
    
    // 층 범위 필터
    if (rangeMode === 'range') {
        const fromFloor = document.getElementById('bulkFloorFrom')?.value;
        const toFloor = document.getElementById('bulkFloorTo')?.value;
        
        const allFloors = targets.map(v => v.floor || '-').sort((a, b) => {
            const numA = parseInt(a.replace(/[^\d-]/g, '')) || 0;
            const numB = parseInt(b.replace(/[^\d-]/g, '')) || 0;
            return numA - numB;
        });
        
        const fromIdx = allFloors.indexOf(fromFloor);
        const toIdx = allFloors.indexOf(toFloor);
        const minIdx = Math.min(fromIdx, toIdx);
        const maxIdx = Math.max(fromIdx, toIdx);
        const selectedFloors = new Set(allFloors.slice(minIdx, maxIdx + 1));
        
        targets = targets.filter(v => selectedFloors.has(v.floor || '-'));
    }
    
    if (targets.length === 0) {
        showToast('적용 대상이 없습니다', 'error');
        return;
    }
    
    // 적용할 값 구성
    const updateFields = {};
    if (bulkDeposit) updateFields.depositPy = bulkDeposit;
    if (bulkRent) updateFields.rentPy = bulkRent;
    if (bulkMaintenance) updateFields.maintenancePy = bulkMaintenance;
    updateFields.updatedAt = new Date().toISOString();
    updateFields.bulkUpdated = true;
    
    const fieldNames = [];
    if (bulkDeposit) fieldNames.push(`보증금 ${bulkDeposit}`);
    if (bulkRent) fieldNames.push(`임대료 ${bulkRent}`);
    if (bulkMaintenance) fieldNames.push(`관리비 ${bulkMaintenance}`);
    
    if (!confirm(`${targets.length}개층에 다음 값을 일괄 적용합니다:\n${fieldNames.join(', ')}\n\n대상층: ${targets.map(v => v.floor).join(', ')}\n\n적용하시겠습니까?`)) return;
    
    try {
        const updates = {};
        const building = state.allBuildings.find(b => b.id === buildingId);
        
        for (const vac of targets) {
            let vacKey = vac._key;
            if (!vacKey) {
                const floor = (vac.floor || 'UNK').replace(/[\/\s\.]/g, '_');
                const src = (vac.source || 'UNKNOWN').replace(/[\/\s\.]/g, '_');
                const pd = (vac.publishDate || '').replace(/[\/\s\.]/g, '_');
                vacKey = `${src}_${pd}_${floor}`;
            }
            
            // Firebase 배치 업데이트 경로 구성
            Object.entries(updateFields).forEach(([field, val]) => {
                updates[`vacancies/${buildingId}/${vacKey}/${field}`] = val;
            });
            
            // 로컬 상태도 업데이트
            Object.assign(vac, updateFields);
            if (building?.vacancies) {
                const localV = building.vacancies.find(v => v._key === vacKey ||
                    (v.source === vac.source && v.publishDate === vac.publishDate && v.floor === vac.floor));
                if (localV) Object.assign(localV, updateFields);
            }
        }
        
        // Firebase 일괄 업데이트 (단일 네트워크 호출)
        await update(ref(db), updates);
        
        showToast(`${targets.length}개층 일괄 적용 완료`, 'success');
        closeVacancyEditModal();
        renderDocumentSection();
        
    } catch (error) {
        console.error('일괄 적용 오류:', error);
        showToast('일괄 적용 실패: ' + error.message, 'error');
    }
}

/**
 * 개별 공실 삭제
 */
export async function deleteVacancyByIdx(idx) {
    const vacancies = state.currentDisplayedVacancies || [];
    const vacancy = vacancies[idx];
    if (!vacancy) return;
    
    if (!confirm(`${vacancy.floor || '해당'} 층 공실 정보를 삭제하시겠습니까?`)) return;
    
    const buildingId = state.selectedBuilding?.id;
    let vacancyKey = vacancy._key;
    
    // ★ _key가 없을 경우 source_publishDate_floor로 키 생성
    if (!vacancyKey) {
        const floor = (vacancy.floor || 'UNK').replace(/[\/\s\.]/g, '_');
        const source = (vacancy.source || 'UNKNOWN').replace(/[\/\s\.]/g, '_');
        const publishDate = (vacancy.publishDate || '').replace(/[\/\s\.]/g, '_');
        vacancyKey = `${source}_${publishDate}_${floor}`;
    }
    
    if (!buildingId || !vacancyKey) {
        showToast('공실 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    try {
        await remove(ref(db, `vacancies/${buildingId}/${vacancyKey}`));
        
        // ★ 로컬 상태 업데이트 - selectedBuilding 직접 업데이트
        const filterFn = v => v._key !== vacancyKey && 
            !(v.source === vacancy.source && v.publishDate === vacancy.publishDate && v.floor === vacancy.floor);
        
        if (state.selectedBuilding) {
            if (state.selectedBuilding.vacancies) {
                state.selectedBuilding.vacancies = state.selectedBuilding.vacancies.filter(filterFn);
                state.selectedBuilding.vacancyCount = state.selectedBuilding.vacancies.length;
            }
            if (state.selectedBuilding.documents) {
                state.selectedBuilding.documents = state.selectedBuilding.documents.filter(filterFn);
            }
        }
        
        // allBuildings도 업데이트
        const building = state.allBuildings?.find(b => b.id === buildingId);
        if (building && building !== state.selectedBuilding) {
            if (building.vacancies) {
                building.vacancies = building.vacancies.filter(filterFn);
                building.vacancyCount = building.vacancies.length;
            }
        }
        
        showToast('공실 정보가 삭제되었습니다', 'success');
        renderDocumentSection();
        
    } catch (error) {
        console.error('공실 삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다', 'error');
    }
}

/**
 * 선택된 공실 일괄 삭제
 */
export async function deleteSelectedVacancies() {
    const selectedIds = state.selectedVacancyIds;
    if (!selectedIds || selectedIds.size === 0) {
        showToast('삭제할 공실을 선택하세요', 'error');
        return;
    }
    
    if (!confirm(`선택된 ${selectedIds.size}개 공실을 삭제하시겠습니까?`)) return;
    
    const buildingId = state.selectedBuilding?.id;
    if (!buildingId) return;
    
    const vacancies = state.currentDisplayedVacancies || [];
    const toDelete = vacancies.filter(v => selectedIds.has(v._vacancyId) && v._key);
    
    try {
        // Firebase에서 삭제
        for (const vacancy of toDelete) {
            await remove(ref(db, `vacancies/${buildingId}/${vacancy._key}`));
        }
        
        // ★ 로컬 상태 업데이트 - selectedBuilding 직접 업데이트
        const keysToDelete = new Set(toDelete.map(v => v._key));
        const filterFn = v => !keysToDelete.has(v._key);
        
        if (state.selectedBuilding) {
            if (state.selectedBuilding.vacancies) {
                state.selectedBuilding.vacancies = state.selectedBuilding.vacancies.filter(filterFn);
                state.selectedBuilding.vacancyCount = state.selectedBuilding.vacancies.length;
            }
            if (state.selectedBuilding.documents) {
                state.selectedBuilding.documents = state.selectedBuilding.documents.filter(filterFn);
            }
        }
        
        // allBuildings도 업데이트
        const building = state.allBuildings?.find(b => b.id === buildingId);
        if (building && building !== state.selectedBuilding) {
            if (building.vacancies) {
                building.vacancies = building.vacancies.filter(filterFn);
                building.vacancyCount = building.vacancies.length;
            }
        }
        
        // 선택 상태 초기화
        state.selectedVacancyIds.clear();
        
        showToast(`${toDelete.length}개 공실이 삭제되었습니다`, 'success');
        renderDocumentSection();
        
    } catch (error) {
        console.error('공실 일괄 삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다', 'error');
    }
}

/**
 * 공실 이관 모달 열기 (개별)
 */
export function openTransferVacancyModalByIdx(idx) {
    const vacancies = state.currentDisplayedVacancies || [];
    const vacancy = vacancies[idx];
    if (!vacancy) return;
    
    state.transferVacancyIndices = [idx];
    openTransferModal([vacancy]);
}

/**
 * 선택된 공실 이관
 */
export function transferSelectedVacancies() {
    const selectedIds = state.selectedVacancyIds;
    if (!selectedIds || selectedIds.size === 0) {
        showToast('이관할 공실을 선택하세요', 'error');
        return;
    }
    
    const vacancies = state.currentDisplayedVacancies || [];
    const toTransfer = vacancies.filter(v => selectedIds.has(v._vacancyId));
    
    if (toTransfer.length === 0) return;
    
    state.transferVacancyIndices = toTransfer.map((_, i) => 
        vacancies.findIndex(v => v._vacancyId === toTransfer[i]._vacancyId)
    );
    
    openTransferModal(toTransfer);
}

/**
 * 이관 모달 열기
 */
function openTransferModal(vacanciesToTransfer) {
    state.transferTargetBuilding = null;
    
    const modalHtml = `
        <div class="modal-overlay show" id="transferModalOverlay" onclick="if(event.target===this)closeTransferModal()"></div>
        <div class="modal show" id="transferModal" style="max-width: 500px; z-index: 10001;">
            <div class="modal-header" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white;">
                <h3 class="modal-title">↗️ 공실 이관</h3>
                <button class="close-btn" onclick="closeTransferModal()" style="color: white;">×</button>
            </div>
            <div style="padding: 20px;">
                <div style="padding: 12px; background: #fef3c7; border-radius: 8px; margin-bottom: 16px;">
                    <div style="font-size: 12px; font-weight: 600; color: #92400e; margin-bottom: 8px;">📋 이관할 공실 (${vacanciesToTransfer.length}건)</div>
                    <div style="font-size: 12px; color: #78350f;">
                        ${vacanciesToTransfer.map(v => `• ${v.floor || '-'} (${v.rentArea ? v.rentArea + '평' : '-'})`).join('<br>')}
                    </div>
                    <div style="font-size: 11px; color: #92400e; margin-top: 8px;">
                        <strong>현재 빌딩:</strong> ${state.selectedBuilding?.name || '-'}
                    </div>
                </div>
                
                <div style="margin-bottom: 12px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 6px;">🔍 대상 빌딩 검색</label>
                    <input type="text" id="transferBuildingSearch" 
                           placeholder="빌딩명 또는 주소로 검색 (2글자 이상)"
                           oninput="searchTransferBuilding()"
                           style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                </div>
                
                <div id="transferBuildingResults" style="max-height: 200px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 6px;">
                    <div style="padding: 20px; text-align: center; color: #666; font-size: 13px;">
                        빌딩명 또는 주소로 검색하세요
                    </div>
                </div>
                
                <div id="selectedTransferBuilding" style="display: none; margin-top: 12px; padding: 12px; background: #dbeafe; border-radius: 8px;">
                    <div style="font-size: 12px; color: #1e40af;">
                        <strong>선택된 빌딩:</strong> <span id="selectedBuildingName"></span>
                    </div>
                </div>
            </div>
            <div class="form-actions" style="padding: 16px 20px; border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end; gap: 8px;">
                <button type="button" class="btn btn-secondary" onclick="closeTransferModal()">취소</button>
                <button type="button" class="btn btn-primary" id="executeTransferBtn" onclick="executeVacancyTransfer()" disabled 
                        style="background: #d97706;">이관 실행</button>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

/**
 * 이관 대상 빌딩 검색
 */
export function searchTransferBuilding() {
    // ★ Fix: 동적 모달(#transferModal) 내 요소를 우선 참조 — portal.html 정적 모달과 ID 충돌 방지
    const activeModal = document.getElementById('transferModal') || document.getElementById('vacancyTransferModal');
    const query = (
        activeModal?.querySelector('#transferBuildingSearch')?.value ||
        document.getElementById('transferBuildingSearch')?.value || ''
    ).trim().toLowerCase();
    const resultsDiv =
        activeModal?.querySelector('#transferBuildingResults') ||
        document.getElementById('transferBuildingResults');
    
    if (query.length < 2) {
        resultsDiv.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-size: 13px;">2글자 이상 입력하세요</div>`;
        return;
    }
    
    const currentBuildingId = state.selectedBuilding?.id;
    const results = state.allBuildings.filter(b => 
        b.id !== currentBuildingId &&
        !b.isHidden &&
        (b.name?.toLowerCase().includes(query) || b.address?.toLowerCase().includes(query))
    ).slice(0, 10);
    
    if (results.length === 0) {
        resultsDiv.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-size: 13px;">검색 결과가 없습니다</div>`;
        return;
    }
    
    resultsDiv.innerHTML = results.map(b => `
        <div class="transfer-building-item" 
             onclick="selectTransferBuilding('${b.id}')"
             data-building-id="${b.id}"
             style="padding: 12px; border-bottom: 1px solid #e2e8f0; cursor: pointer; transition: background 0.2s;"
             onmouseenter="this.style.background='#f1f5f9'"
             onmouseleave="this.style.background='${state.transferTargetBuilding?.id === b.id ? '#dbeafe' : ''}'">
            <div style="font-weight: 500; color: var(--text-primary);">${b.name}</div>
            <div style="font-size: 12px; color: #666; margin-top: 4px;">${b.address || '-'}</div>
            <div style="font-size: 11px; color: #999; margin-top: 2px;">현재 공실 ${b.vacancyCount || 0}건</div>
        </div>
    `).join('');
}

/**
 * 이관 대상 빌딩 선택
 */
export function selectTransferBuilding(buildingId) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building) return;
    
    state.transferTargetBuilding = building;
    
    // UI 업데이트
    document.querySelectorAll('.transfer-building-item').forEach(el => {
        el.style.background = el.dataset.buildingId === buildingId ? '#dbeafe' : '';
    });
    
    // ★ Fix: portal-crud.js의 동적 생성 모달 transferBtn 활성화
    const transferBtn = document.getElementById('transferBtn');
    if (transferBtn) {
        transferBtn.disabled = false;
        transferBtn.style.opacity = '1';
        transferBtn.style.cursor = 'pointer';
        transferBtn.style.background = '#2563eb';
    }
    
    // portal-detail.js 자체 이관 모달용 (기존 호환)
    const selectedDiv = document.getElementById('selectedTransferBuilding');
    const nameSpan = document.getElementById('selectedBuildingName');
    const executeBtn = document.getElementById('executeTransferBtn');
    
    if (selectedDiv) selectedDiv.style.display = 'block';
    if (nameSpan) nameSpan.textContent = building.name;
    if (executeBtn) executeBtn.disabled = false;
}

/**
 * 공실 이관 실행 (기준가 포함)
 */
export async function executeVacancyTransfer() {
    const targetBuilding = state.transferTargetBuilding;
    if (!targetBuilding) {
        showToast('이관할 빌딩을 선택하세요', 'error');
        return;
    }
    
    const sourceBuildingId = state.selectedBuilding?.id;
    const targetBuildingId = targetBuilding.id;
    
    if (!sourceBuildingId || sourceBuildingId === targetBuildingId) return;
    
    const vacancies = state.currentDisplayedVacancies || [];
    const indices = state.transferVacancyIndices || [];
    const toTransfer = indices.map(i => vacancies[i]).filter(Boolean);
    
    if (toTransfer.length === 0) return;
    
    // ★ v3.14: 이관할 공실들의 source + publishDate 조합 수집 (월 기준 정규화)
    const sourceKeys = new Set();
    toTransfer.forEach(v => {
        if (v.source && v.publishDate) {
            // publishDate를 YYYY-MM 형식으로 정규화 (예: "25.01" → "2025-01")
            let normalizedMonth = v.publishDate;
            if (/^\d{2}\.\d{2}$/.test(v.publishDate)) {
                // "25.01" → "2025-01"
                const [yy, mm] = v.publishDate.split('.');
                normalizedMonth = `20${yy}-${mm}`;
            } else if (/^\d{4}-\d{2}/.test(v.publishDate)) {
                // "2025-01-01" → "2025-01"
                normalizedMonth = v.publishDate.slice(0, 7);
            }
            sourceKeys.add(`${v.source}|${normalizedMonth}`);
        }
    });
    
    // ★ v3.14: 원본 빌딩의 기준가에서 해당하는 것 필터링 (sourceCompany + effectiveDate 월 기준)
    const sourceBuilding = state.selectedBuilding;
    const sourcePricings = sourceBuilding?.floorPricing || [];
    const pricingsToTransfer = sourcePricings.filter(fp => {
        // sourceCompany 또는 source 필드 확인
        const fpSource = fp.sourceCompany || fp.source || '';
        // effectiveDate에서 월 추출 (예: "2025-01-01" → "2025-01")
        let fpMonth = '';
        if (fp.effectiveDate) {
            fpMonth = fp.effectiveDate.slice(0, 7);  // "2025-01-01" → "2025-01"
        } else if (fp.publishDate) {
            // publishDate가 "25.01" 형식일 경우
            if (/^\d{2}\.\d{2}$/.test(fp.publishDate)) {
                const [yy, mm] = fp.publishDate.split('.');
                fpMonth = `20${yy}-${mm}`;
            } else {
                fpMonth = fp.publishDate.slice(0, 7);
            }
        }
        const fpKey = `${fpSource}|${fpMonth}`;
        return sourceKeys.has(fpKey);
    });
    
    console.log('📋 이관 정보:', {
        공실수: toTransfer.length,
        공실sourceKeys: Array.from(sourceKeys),
        원본빌딩기준가수: sourcePricings.length,
        원본빌딩기준가: sourcePricings.map(fp => ({
            sourceCompany: fp.sourceCompany || fp.source,
            effectiveDate: fp.effectiveDate,
            label: fp.label
        })),
        매칭된기준가수: pricingsToTransfer.length,
        매칭된기준가: pricingsToTransfer.map(fp => ({
            sourceCompany: fp.sourceCompany || fp.source,
            effectiveDate: fp.effectiveDate,
            label: fp.label
        }))
    });
    
    const confirmMsg = pricingsToTransfer.length > 0
        ? `${toTransfer.length}개 공실 + ${pricingsToTransfer.length}개 기준가를\n"${targetBuilding.name}"으로 이관하시겠습니까?`
        : `${toTransfer.length}개 공실을 "${targetBuilding.name}"으로 이관하시겠습니까?`;
    
    if (!confirm(confirmMsg)) return;
    
    try {
        const { push, set, get } = await import('./portal-firebase.js');
        
        // 1. 공실 이관
        for (const vacancy of toTransfer) {
            const oldKey = vacancy._key;
            if (!oldKey) continue;
            
            // 새 빌딩에 추가
            const newVacancyRef = push(ref(db, `vacancies/${targetBuildingId}`));
            const newVacancyData = {
                ...vacancy,
                _key: undefined,
                _vacancyId: undefined,
                // ★ [FIX] 이관 시 buildingName을 대상 빌딩명으로 강제 업데이트
                buildingName: targetBuilding.buildingName || targetBuilding.name || vacancy.buildingName,
                transferredFrom: sourceBuildingId,
                transferredAt: new Date().toISOString()
            };
            delete newVacancyData._key;
            delete newVacancyData._vacancyId;
            
            await set(newVacancyRef, newVacancyData);
            
            // 기존 빌딩에서 삭제
            await remove(ref(db, `vacancies/${sourceBuildingId}/${oldKey}`));
        }
        
        // 2. 기준가 이관 (해당하는 것이 있을 경우)
        if (pricingsToTransfer.length > 0) {
            // 대상 빌딩의 현재 기준가 가져오기
            const targetBuildingSnap = await get(ref(db, `buildings/${targetBuildingId}`));
            const targetBuildingData = targetBuildingSnap.val() || {};
            const existingPricings = targetBuildingData.floorPricing || [];
            
            // ★ v3.14: 중복 체크용 키 생성 (sourceCompany 사용)
            const existingKeys = new Set(existingPricings.map(fp => 
                `${fp.sourceCompany || fp.source || ''}|${fp.effectiveDate || ''}|${fp.label || ''}`
            ));
            
            // 새 기준가 추가 (중복 제외)
            const newPricings = [];
            pricingsToTransfer.forEach(fp => {
                const fpKey = `${fp.sourceCompany || fp.source || ''}|${fp.effectiveDate || ''}|${fp.label || ''}`;
                if (!existingKeys.has(fpKey)) {
                    newPricings.push({
                        ...fp,
                        id: `fp_transfer_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                        transferredFrom: sourceBuildingId,
                        transferredAt: new Date().toISOString()
                    });
                    existingKeys.add(fpKey);
                }
            });
            
            if (newPricings.length > 0) {
                const updatedPricings = [...existingPricings, ...newPricings];
                await set(ref(db, `buildings/${targetBuildingId}/floorPricing`), updatedPricings);
                console.log(`✅ 기준가 ${newPricings.length}개 이관 완료`);
            }
        }
        
        // 로컬 상태 업데이트 - 원본 빌딩
        const sourceBuildingLocal = state.allBuildings.find(b => b.id === sourceBuildingId);
        if (sourceBuildingLocal && sourceBuildingLocal.vacancies) {
            const keysToRemove = new Set(toTransfer.map(v => v._key));
            sourceBuildingLocal.vacancies = sourceBuildingLocal.vacancies.filter(v => !keysToRemove.has(v._key));
            sourceBuildingLocal.vacancyCount = sourceBuildingLocal.vacancies.length;
        }
        
        // ★ v3.12: 로컬 상태 업데이트 - 대상 빌딩 (이관 후 바로 열었을 때 보이도록)
        const targetBuildingLocal = state.allBuildings.find(b => b.id === targetBuildingId);
        if (targetBuildingLocal) {
            // 공실 추가
            if (!targetBuildingLocal.vacancies) targetBuildingLocal.vacancies = [];
            toTransfer.forEach(v => {
                const newVacancy = {
                    ...v,
                    transferredFrom: sourceBuildingId,
                    transferredAt: new Date().toISOString()
                };
                delete newVacancy._key;
                delete newVacancy._vacancyId;
                targetBuildingLocal.vacancies.push(newVacancy);
            });
            targetBuildingLocal.vacancyCount = targetBuildingLocal.vacancies.length;
            
            // ★ v3.14: 기준가도 로컬에 추가
            if (pricingsToTransfer.length > 0) {
                if (!targetBuildingLocal.floorPricing) targetBuildingLocal.floorPricing = [];
                pricingsToTransfer.forEach(fp => {
                    // 중복 체크
                    const fpKey = `${fp.sourceCompany || fp.source || ''}|${fp.effectiveDate || ''}|${fp.label || ''}`;
                    const exists = targetBuildingLocal.floorPricing.some(efp => 
                        `${efp.sourceCompany || efp.source || ''}|${efp.effectiveDate || ''}|${efp.label || ''}` === fpKey
                    );
                    if (!exists) {
                        targetBuildingLocal.floorPricing.push({
                            ...fp,
                            id: `fp_transfer_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                            transferredFrom: sourceBuildingId,
                            transferredAt: new Date().toISOString()
                        });
                    }
                });
            }
            
            // 문서 정보도 추가 (source/publishDate 기준)
            if (!targetBuildingLocal.documents) targetBuildingLocal.documents = [];
            const sourceKeysArray = Array.from(sourceKeys);
            sourceKeysArray.forEach(sk => {
                const [source, publishDate] = sk.split('|');
                const docExists = targetBuildingLocal.documents.some(d => 
                    d.source === source && d.publishDate === publishDate
                );
                if (!docExists) {
                    targetBuildingLocal.documents.push({
                        source,
                        publishDate,
                        transferredFrom: sourceBuildingId,
                        transferredAt: new Date().toISOString()
                    });
                }
            });
        }
        
        // 선택 상태 초기화
        if (state.selectedVacancyIds) {
            state.selectedVacancyIds.clear();
        }
        
        const successMsg = pricingsToTransfer.length > 0
            ? `${toTransfer.length}개 공실 + ${pricingsToTransfer.length}개 기준가 이관 완료`
            : `${toTransfer.length}개 공실이 "${targetBuilding.name}"으로 이관되었습니다`;
        
        showToast(successMsg, 'success');
        closeTransferModal();
        renderDocumentSection();
        
    } catch (error) {
        console.error('공실 이관 오류:', error);
        showToast('이관 중 오류가 발생했습니다', 'error');
    }
}

/**
 * 이관 모달 닫기
 */
export function closeTransferModal() {
    const modal = document.getElementById('transferModal');
    const overlay = document.getElementById('transferModalOverlay');
    if (modal) modal.remove();
    if (overlay) overlay.remove();
    state.transferTargetBuilding = null;
    state.transferVacancyIndices = null;
}

// ===== 📋 공실 복사 (복사 + 붙여넣기) =====
//   이관(잘라내기)과 달리 원본을 남기고 복제한다.
//   대상: 빌딩(기본=현재 빌딩, 자가 복제) + 그 빌딩의 특정 안내문(출처·발행월) 또는 직접 입력(새 안내문).
//   용도: OCR이 놓친 공실 추가/안내문 없는 경우 — 보증금·임대료·관리비가 동일하고 층/면적만 다를 때 입력 절감.

export function openCopyVacancyModalByIdx(idx) {
    const vacancies = state.currentDisplayedVacancies || [];
    const v = vacancies[idx];
    if (!v) return;
    if (String(v._key || '').endsWith('_meta')) {
        showToast('공실없음 항목은 복사할 수 없습니다', 'error');
        return;
    }
    openCopyModal([v]);
}

export function copySelectedVacancies() {
    const selectedIds = state.selectedVacancyIds;
    if (!selectedIds || selectedIds.size === 0) {
        showToast('복사할 공실을 선택하세요', 'error');
        return;
    }
    const vacancies = state.currentDisplayedVacancies || [];
    const toCopy = vacancies.filter(v => selectedIds.has(v._vacancyId) && !String(v._key || '').endsWith('_meta'));
    if (toCopy.length === 0) {
        showToast('복사할 공실이 없습니다', 'error');
        return;
    }
    openCopyModal(toCopy);
}

function openCopyModal(vacanciesToCopy) {
    state.copyVacancies = vacanciesToCopy;
    state.copyTargetBuilding = state.selectedBuilding || null; // 기본: 현재 빌딩(자가 복제)
    const cur = state.selectedBuilding;

    const listHtml = vacanciesToCopy.map(v =>
        `• ${v.floor || '-'}${v.tower ? ' [' + v.tower + ']' : ''} (${v.rentArea ? formatArea(v.rentArea) : '-'} / 보증 ${formatMoney(v.depositPy)} · 임대 ${formatMoney(v.rentPy)} · 관리 ${formatMoney(v.maintenancePy)})`
    ).join('<br>');

    const modalHtml = `
        <div class="modal-overlay show" id="copyModalOverlay" onclick="if(event.target===this)closeCopyModal()"></div>
        <div class="modal show" id="copyModal" style="max-width: 540px; z-index: 10001;">
            <div class="modal-header" style="background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: white;">
                <h3 class="modal-title">📋 공실 복사</h3>
                <button class="close-btn" onclick="closeCopyModal()" style="color: white;">×</button>
            </div>
            <div style="padding: 20px;">
                <div style="padding: 12px; background: #eff6ff; border-radius: 8px; margin-bottom: 16px;">
                    <div style="font-size: 12px; font-weight: 600; color: #1e40af; margin-bottom: 8px;">📋 복사할 공실 (${vacanciesToCopy.length}건)</div>
                    <div style="font-size: 12px; color: #1e3a8a; max-height: 90px; overflow-y: auto; line-height: 1.7;">${listHtml}</div>
                    <div style="font-size: 11px; color: #1e40af; margin-top: 8px;">💡 보증금·임대료·관리비는 그대로 복사됩니다. 붙여넣은 뒤 층·면적만 수정하세요. (원본 유지)</div>
                </div>

                <div style="margin-bottom: 10px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 6px;">🏢 붙여넣을 빌딩 <span style="color:#9ca3af;">(기본: 현재 빌딩 — 자가 복제)</span></label>
                    <input type="text" id="copyBuildingSearch"
                           placeholder="다른 빌딩으로 복사하려면 검색 (2글자 이상)"
                           oninput="searchCopyBuilding()"
                           style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                </div>
                <div id="copyBuildingResults" style="display:none; max-height: 160px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 6px; margin-bottom: 8px;"></div>
                <div id="copySelectedBuilding" style="margin-bottom: 14px; padding: 10px 12px; background: #dbeafe; border-radius: 8px; font-size: 13px; color: #1e40af;">
                    선택된 빌딩: <strong id="copySelectedBuildingName">${cur?.name || '-'}</strong>
                </div>

                <div style="margin-bottom: 10px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 6px;">📄 붙여넣을 안내문 (출처 · 발행월)</label>
                    <select id="copyTargetGuide" onchange="onCopyGuideChange()"
                            style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box; background: #fff;">
                    </select>
                </div>
                <div id="copyManualGuide" style="display: none; gap: 8px; margin-bottom: 6px;">
                    <input type="text" id="copyManualSource" placeholder="출처(회사명) 예: 직접입력"
                           style="flex: 1; padding: 9px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 13px; box-sizing: border-box;">
                    <input type="text" id="copyManualDate" placeholder="발행월 예: 25.03"
                           style="width: 130px; padding: 9px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 13px; box-sizing: border-box;">
                </div>
            </div>
            <div class="form-actions" style="padding: 16px 20px; border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end; gap: 8px;">
                <button type="button" class="btn btn-secondary" onclick="closeCopyModal()">취소</button>
                <button type="button" class="btn btn-primary" id="executeCopyBtn" onclick="executeVacancyCopy()" style="background: #2563eb;">복사 실행</button>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    if (cur) renderCopyGuideOptions(cur);
}

// 대상 빌딩의 안내문(출처+발행월) 목록을 드롭다운에 채움
function renderCopyGuideOptions(building) {
    const sel = document.getElementById('copyTargetGuide');
    if (!sel) return;
    const seen = new Map();
    (building.vacancies || []).forEach(v => {
        if (String(v._key || '').endsWith('_meta')) return;
        if (!v.source && !v.publishDate) return;
        const k = `${v.source || ''}|${v.publishDate || ''}`;
        const e = seen.get(k) || { source: v.source || '', publishDate: v.publishDate || '', count: 0 };
        e.count++;
        seen.set(k, e);
    });
    (building.documents || []).forEach(d => {
        const k = `${d.source || ''}|${d.publishDate || ''}`;
        if (!seen.has(k) && (d.source || d.publishDate)) {
            seen.set(k, { source: d.source || '', publishDate: d.publishDate || '', count: d.vacancyCount || 0 });
        }
    });
    const opts = [...seen.values()].sort((a, b) => String(b.publishDate || '').localeCompare(String(a.publishDate || '')));
    let html = '';
    if (opts.length === 0) {
        html += `<option value="__new__" selected>등록된 안내문 없음 — 직접 입력</option>`;
    } else {
        opts.forEach(o => {
            const label = `${o.source || '(출처없음)'} · ${o.publishDate || '(발행일없음)'}${o.count ? ` (${o.count}건)` : ''}`;
            html += `<option value="${encodeURIComponent(o.source)}|${encodeURIComponent(o.publishDate)}">${label}</option>`;
        });
        html += `<option value="__new__">➕ 새 안내문 / 직접 입력…</option>`;
    }
    sel.innerHTML = html;
    onCopyGuideChange();
}

export function onCopyGuideChange() {
    const sel = document.getElementById('copyTargetGuide');
    const manual = document.getElementById('copyManualGuide');
    if (!sel || !manual) return;
    manual.style.display = sel.value === '__new__' ? 'flex' : 'none';
}

export function searchCopyBuilding() {
    const query = (document.getElementById('copyBuildingSearch')?.value || '').trim().toLowerCase();
    const resultsDiv = document.getElementById('copyBuildingResults');
    if (!resultsDiv) return;
    if (query.length < 2) {
        resultsDiv.style.display = 'none';
        resultsDiv.innerHTML = '';
        return;
    }
    const results = state.allBuildings.filter(b =>
        !b.isHidden &&
        (b.name?.toLowerCase().includes(query) || b.address?.toLowerCase().includes(query))
    ).slice(0, 10);
    resultsDiv.style.display = 'block';
    if (results.length === 0) {
        resultsDiv.innerHTML = `<div style="padding: 16px; text-align: center; color: #666; font-size: 13px;">검색 결과가 없습니다</div>`;
        return;
    }
    resultsDiv.innerHTML = results.map(b => `
        <div class="copy-building-item" onclick="selectCopyBuilding('${b.id}')" data-building-id="${b.id}"
             style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; cursor: pointer;"
             onmouseenter="this.style.background='#f1f5f9'" onmouseleave="this.style.background=''">
            <div style="font-weight: 500; color: var(--text-primary);">${b.name}${b.id === state.selectedBuilding?.id ? ' <span style=\"font-size:10px; color:#2563eb;\">(현재)</span>' : ''}</div>
            <div style="font-size: 12px; color: #666; margin-top: 2px;">${b.address || '-'}</div>
        </div>
    `).join('');
}

export function selectCopyBuilding(buildingId) {
    const b = state.allBuildings.find(x => x.id === buildingId);
    if (!b) return;
    state.copyTargetBuilding = b;
    const nameEl = document.getElementById('copySelectedBuildingName');
    if (nameEl) nameEl.textContent = b.name || buildingId;
    const resultsDiv = document.getElementById('copyBuildingResults');
    if (resultsDiv) { resultsDiv.style.display = 'none'; resultsDiv.innerHTML = ''; }
    const searchEl = document.getElementById('copyBuildingSearch');
    if (searchEl) searchEl.value = '';
    renderCopyGuideOptions(b);
}

export async function executeVacancyCopy() {
    const target = state.copyTargetBuilding;
    const toCopy = state.copyVacancies || [];
    if (!target || toCopy.length === 0) {
        showToast('복사 정보가 올바르지 않습니다', 'error');
        return;
    }
    const sel = document.getElementById('copyTargetGuide');
    let targetSource = '', targetPublishDate = '';
    if (sel && sel.value === '__new__') {
        targetSource = (document.getElementById('copyManualSource')?.value || '').trim();
        targetPublishDate = (document.getElementById('copyManualDate')?.value || '').trim();
        if (!targetSource || !targetPublishDate) {
            showToast('새 안내문의 출처와 발행월을 입력하세요', 'error');
            return;
        }
    } else if (sel && sel.value) {
        const parts = sel.value.split('|');
        targetSource = decodeURIComponent(parts[0] || '');
        targetPublishDate = decodeURIComponent(parts[1] || '');
    } else {
        showToast('붙여넣을 안내문을 선택하세요', 'error');
        return;
    }

    if (!confirm(`${toCopy.length}개 공실을 "${target.name}"의\n[${targetSource} · ${targetPublishDate}] 안내문으로 복사할까요?\n\n원본은 그대로 유지됩니다.`)) return;

    try {
        const { push, set } = await import('./portal-firebase.js');
        const targetId = target.id;
        if (!state.dataCache.vacancies) state.dataCache.vacancies = {};
        if (!state.dataCache.vacancies[targetId]) state.dataCache.vacancies[targetId] = {};
        const targetLocal = state.allBuildings.find(b => b.id === targetId);
        if (targetLocal && !targetLocal.vacancies) targetLocal.vacancies = [];

        for (const v of toCopy) {
            const newData = { ...v };
            delete newData._key;
            delete newData._vacancyId;
            // 페이지 원본 참조는 원본 안내문 기준이라 복사본에서는 제거 (복사본은 수동 입력 성격)
            delete newData.pageImageUrl;
            delete newData.pageNum;
            delete newData.pdfUrl;
            newData.source = targetSource;
            newData.publishDate = targetPublishDate;
            newData.buildingName = target.buildingName || target.name || newData.buildingName || '';
            newData.copiedFrom = state.selectedBuilding?.id || null;
            newData.copiedAt = new Date().toISOString();
            newData.createdAt = newData.createdAt || new Date().toISOString();
            newData.updatedAt = new Date().toISOString();

            const newRef = push(ref(db, `vacancies/${targetId}`));
            const newKey = newRef.key;
            await set(newRef, newData);
            state.dataCache.vacancies[targetId][newKey] = newData;
            if (targetLocal) targetLocal.vacancies.push({ ...newData, _key: newKey });
        }
        if (targetLocal) targetLocal.vacancyCount = targetLocal.vacancies.length;

        if (state.selectedVacancyIds) state.selectedVacancyIds.clear();
        showToast(`${toCopy.length}개 공실을 복사했습니다`, 'success');
        closeCopyModal();
        renderDocumentSection();
        if (window.renderBuildingList) window.renderBuildingList();
    } catch (error) {
        console.error('공실 복사 오류:', error);
        showToast('복사 중 오류가 발생했습니다: ' + (error?.message || ''), 'error');
    }
}

export function closeCopyModal() {
    document.getElementById('copyModal')?.remove();
    document.getElementById('copyModalOverlay')?.remove();
    state.copyVacancies = null;
    state.copyTargetBuilding = null;
}

// ★ 이 빌딩 새로고침: 전체 데이터 재로딩(Firebase) 후 현재 빌딩의 모든 하위 탭 재렌더
export async function handleBuildingRefresh() {
    if (!state.selectedBuilding) {
        showToast('선택된 빌딩이 없습니다', 'error');
        return;
    }
    const id = state.selectedBuilding.id;
    const btn = document.getElementById('detailRefreshBtn');
    const prevHTML = btn ? btn.innerHTML : '';
    const prevStyle = btn ? btn.getAttribute('style') : null;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="refresh-spin">🔄</span> 갱신중…';
        btn.setAttribute('style', 'padding: 5px 12px; border: 1px solid #1e40af; border-radius: 6px; background: #1e40af; color: #fff; font-size: 12px; font-weight: 600; cursor: progress; box-shadow: 0 1px 3px rgba(0,0,0,0.2);');
    }
    try {
        if (window.loadData) {
            await window.loadData(); // Firebase 전체 재로딩 → dataCache → processBuildings → 리스트/지도 갱신
        }
        if (state.allBuildings.find(b => b.id === id)) {
            openDetail(id); // 기준가/렌트롤/메모/인센티브/안내문/담당자/기본정보 전 탭 재렌더
        }
        showToast('새로고침 완료', 'success');
    } catch (e) {
        console.error('빌딩 새로고침 오류:', e);
        showToast('새로고침 실패: ' + (e?.message || ''), 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = prevHTML || '🔄 새로고침'; if (prevStyle != null) btn.setAttribute('style', prevStyle); }
    }
}
window.handleBuildingRefresh = handleBuildingRefresh;

// ===== ★ v2.1: 기준가 통합 기능 =====

/**
 * 기본 임대조건을 층별 기준가(floorPricing)로 이관
 */
export async function migrateBasePricingToFloorPricing() {
    const b = state.selectedBuilding;
    if (!b) {
        showToast('빌딩을 선택해주세요', 'error');
        return;
    }
    
    // 기본 임대조건 확인
    if (!b.depositPy && !b.rentPy && !b.maintenancePy) {
        showToast('이관할 기본 임대조건이 없습니다', 'warning');
        return;
    }
    
    // 이미 floorPricing에 데이터가 있는지 확인
    if (b.floorPricing && b.floorPricing.length > 0) {
        if (!confirm('이미 등록된 기준가가 있습니다. 기본 임대조건을 추가로 등록하시겠습니까?')) {
            return;
        }
    }
    
    const newPricing = {
        id: 'fp_' + Date.now(),
        label: '기준층',
        floorRange: '전체',
        floorStart: '1',
        floorEnd: 'RF',
        depositPy: parseFloat(b.depositPy) || null,
        rentPy: parseFloat(b.rentPy) || null,
        maintenancePy: parseFloat(b.maintenancePy) || null,
        rentArea: b.rentableArea || b.grossArea || null,
        exclusiveArea: b.exclusiveArea || null,
        effectiveDate: new Date().toISOString().split('T')[0],
        notes: '기본 임대조건에서 이관',
        createdAt: new Date().toISOString(),
        createdBy: state.currentUser?.email || 'unknown',
        migratedFromBase: true
    };
    
    try {
        let floorPricing = b.floorPricing || [];
        floorPricing.push(newPricing);
        
        await update(ref(db, `buildings/${b.id}`), { floorPricing });
        state.selectedBuilding.floorPricing = floorPricing;
        
        renderPricingSection();
        renderInfoSection();
        showToast('기본 임대조건이 기준가로 등록되었습니다', 'success');
    } catch (error) {
        console.error('기준가 이관 오류:', error);
        showToast('이관 중 오류가 발생했습니다', 'error');
    }
}

/**
 * 공실 정보에서 기준가 등록 모달 열기
 */
export function openPricingFromVacancyModal(idx) {
    const vacancies = state.currentDisplayedVacancies || [];
    const vacancy = vacancies[idx];
    if (!vacancy) {
        showToast('공실 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    const modalHtml = `
        <div class="modal-overlay show" id="pricingFromVacancyOverlay" onclick="if(event.target===this)closePricingFromVacancyModal()"></div>
        <div class="modal show" id="pricingFromVacancyModal" style="max-width: 480px; z-index: 10001;">
            <div class="modal-header" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white;">
                <h3 class="modal-title">💰 기준가로 등록</h3>
                <button class="close-btn" onclick="closePricingFromVacancyModal()" style="color: white;">×</button>
            </div>
            <div style="padding: 20px;">
                <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                    <div style="font-size: 12px; color: #166534; margin-bottom: 8px;">
                        <strong>${vacancy.floor || '-'}층</strong> 공실 정보를 기준가로 등록합니다
                    </div>
                    <div style="font-size: 11px; color: #15803d;">
                        출처: ${vacancy.source || '-'} (${vacancy.publishDate || '-'})
                    </div>
                </div>
                
                <div class="form-row" style="margin-bottom: 12px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">구분명 <span style="color:#dc2626">*</span></label>
                    <input type="text" id="pfvLabel" value="${vacancy.floor ? vacancy.floor + '층' : '기준층'}" 
                           style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">층 범위 시작</label>
                        <input type="text" id="pfvFloorStart" value="${vacancy.floor || '1'}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">층 범위 종료</label>
                        <input type="text" id="pfvFloorEnd" value="${vacancy.floor || 'RF'}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px;">
                    <div>
                        <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">보증금/평</label>
                        <input type="number" step="0.1" id="pfvDeposit" value="${vacancy.depositPy || ''}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">임대료/평 <span style="color:#dc2626">*</span></label>
                        <input type="number" step="0.1" id="pfvRent" value="${vacancy.rentPy || ''}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box; background: #fef3c7;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">관리비/평</label>
                        <input type="number" step="0.1" id="pfvMaintenance" value="${vacancy.maintenancePy || ''}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                    <div>
                        <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">임대면적 (평)</label>
                        <input type="number" step="0.01" id="pfvRentArea" value="${vacancy.rentArea || ''}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">전용면적 (평)</label>
                        <input type="number" step="0.01" id="pfvExclusiveArea" value="${vacancy.exclusiveArea || ''}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                    </div>
                </div>
                
                <div style="margin-bottom: 12px;">
                    <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">비고</label>
                    <input type="text" id="pfvNotes" value="공실 정보에서 추출 (${vacancy.source || '-'})" 
                           style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                </div>
            </div>
            <div class="form-actions" style="padding: 16px 20px; border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end; gap: 8px;">
                <button type="button" class="btn btn-secondary" onclick="closePricingFromVacancyModal()">취소</button>
                <button type="button" class="btn btn-primary" onclick="savePricingFromVacancy()" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">기준가 등록</button>
            </div>
        </div>
    `;
    
    state.pricingFromVacancyIdx = idx;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

/**
 * 공실에서 기준가 저장
 */
export async function savePricingFromVacancy() {
    const b = state.selectedBuilding;
    if (!b) {
        showToast('빌딩 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    const label = document.getElementById('pfvLabel')?.value?.trim();
    const rentPy = parseFloat(document.getElementById('pfvRent')?.value);
    
    if (!label) {
        showToast('구분명을 입력해주세요', 'warning');
        return;
    }
    
    if (!rentPy || isNaN(rentPy)) {
        showToast('임대료를 입력해주세요', 'warning');
        return;
    }
    
    const floorStart = document.getElementById('pfvFloorStart')?.value?.trim() || '';
    const floorEnd = document.getElementById('pfvFloorEnd')?.value?.trim() || '';
    
    const newPricing = {
        id: 'fp_' + Date.now(),
        label: label,
        floorRange: floorStart && floorEnd ? `${floorStart}-${floorEnd}` : (floorStart || floorEnd || '전체'),
        floorStart: floorStart,
        floorEnd: floorEnd,
        depositPy: parseFloat(document.getElementById('pfvDeposit')?.value) || null,
        rentPy: rentPy,
        maintenancePy: parseFloat(document.getElementById('pfvMaintenance')?.value) || null,
        rentArea: parseFloat(document.getElementById('pfvRentArea')?.value) || null,
        exclusiveArea: parseFloat(document.getElementById('pfvExclusiveArea')?.value) || null,
        notes: document.getElementById('pfvNotes')?.value?.trim() || null,
        effectiveDate: new Date().toISOString().split('T')[0],
        createdAt: new Date().toISOString(),
        createdBy: state.currentUser?.email || 'unknown',
        sourceType: 'vacancy'
    };
    
    try {
        let floorPricing = b.floorPricing || [];
        floorPricing.push(newPricing);
        
        await update(ref(db, `buildings/${b.id}`), { floorPricing });
        state.selectedBuilding.floorPricing = floorPricing;
        
        closePricingFromVacancyModal();
        renderPricingSection();
        renderInfoSection();
        showToast('기준가가 등록되었습니다', 'success');
    } catch (error) {
        console.error('기준가 등록 오류:', error);
        showToast('등록 중 오류가 발생했습니다', 'error');
    }
}

/**
 * 공실→기준가 모달 닫기
 */
export function closePricingFromVacancyModal() {
    const modal = document.getElementById('pricingFromVacancyModal');
    const overlay = document.getElementById('pricingFromVacancyOverlay');
    if (modal) modal.remove();
    if (overlay) overlay.remove();
    state.pricingFromVacancyIdx = null;
}

// ===== PDF 페이지 이미지 수동 등록 =====

// PDF 관련 상태
let pdfState = {
    buildingId: null,
    source: null,
    period: null,
    targetPageNum: null,
    pdfDoc: null,
    currentPage: 1,
    totalPages: 0,
    scale: 1.5,
    uploadMode: 'replace'  // 'replace' | 'append'
};

/**
 * PDF 업로드 모달 열기
 */
export function openPdfUploadModal(buildingId, source, period, pageNum) {
    pdfState.buildingId = buildingId;
    pdfState.source = source;
    pdfState.period = period;
    pdfState.targetPageNum = pageNum;
    pdfState.pdfDoc = null;
    pdfState.currentPage = pageNum || 1;
    pdfState.uploadMode = 'replace';  // 기본값: 교체
    
    // 기존 pageImageUrls 개수 파악 (추가 모드 힌트용)
    const metaKey = `${source}_${period}`;
    const building = state.selectedBuilding;
    const existingMeta = building?.vacancies?.find(v => v._key?.endsWith('_meta') && v.source === source && v.publishDate === period);
    const existingCount = existingMeta?.pageImageUrls?.length || (existingMeta?.pageImageUrl ? 1 : 0);
    
    // UI 업데이트
    document.getElementById('pdfUploadBuildingName').textContent = building?.name || '빌딩명';
    document.getElementById('pdfUploadSource').textContent = source || '-';
    document.getElementById('pdfUploadPeriod').textContent = period || '-';
    document.getElementById('pdfUploadPageNum').textContent = pageNum || '-';
    document.getElementById('pdfUploadInfo').style.display = 'block';
    
    // 교체/추가 모드 UI 업데이트
    const modeAppendDesc = document.getElementById('pdfUploadModeAppendDesc');
    if (modeAppendDesc) {
        modeAppendDesc.textContent = existingCount > 0
            ? `현재 ${existingCount}장 등록됨 — 새 페이지를 추가합니다`
            : '새 페이지로 추가합니다';
    }
    // 기본값으로 교체 선택 + 레이블 스타일 리셋
    const modeReplace = document.getElementById('pdfUploadModeReplace');
    if (modeReplace) modeReplace.checked = true;
    const lblReplace = document.getElementById('pdfUploadModeLabelReplace');
    const lblAppend  = document.getElementById('pdfUploadModeLabelAppend');
    if (lblReplace) { lblReplace.style.borderColor = '#2563eb'; lblReplace.style.background = '#eff6ff'; }
    if (lblAppend)  { lblAppend.style.borderColor  = '#d1d5db'; lblAppend.style.background  = '#f9fafb'; }
    
    // 초기화
    document.getElementById('pdfFileInput').value = '';
    document.getElementById('pdfPageSelector').style.display = 'none';
    document.getElementById('pdfLoadingState').style.display = 'none';
    document.getElementById('pdfUploadProgress').style.display = 'none';
    document.getElementById('pdfUploadBtn').disabled = true;
    
    // 모달 표시
    const modal = document.getElementById('pdfUploadModal');
    const overlay = document.getElementById('modalOverlay');
    if (modal) modal.style.display = 'block';
    if (overlay) overlay.classList.add('show');
}

/**
 * PDF 업로드 모달 닫기
 */
export function closePdfUploadModal() {
    const modal = document.getElementById('pdfUploadModal');
    const overlay = document.getElementById('modalOverlay');
    if (modal) modal.style.display = 'none';
    if (overlay) overlay.classList.remove('show');
    
    // 상태 초기화
    pdfState.pdfDoc = null;
}

/**
 * 멀티페이지 원본보기 뷰어
 * pageImageUrls 배열을 받아 슬라이드 형식으로 보여줌
 */
export function showMultiPagePreview(urls, source, period) {
    if (!urls || urls.length === 0) return;
    
    // 기존 팝업 제거
    document.getElementById('multiPagePreviewOverlay')?.remove();
    
    let currentIdx = 0;
    
    const overlay = document.createElement('div');
    overlay.id = 'multiPagePreviewOverlay';
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.92); z-index: 99999;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
    `;
    
    const render = () => {
        overlay.innerHTML = `
            <div style="position: relative; width: 100%; max-width: 900px; padding: 0 16px; box-sizing: border-box;">
                <!-- 헤더 -->
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; color: white;">
                    <div style="font-size: 14px; font-weight: 600;">
                        📄 ${source} · ${period}
                        <span style="margin-left: 10px; font-size: 12px; opacity: 0.7; font-weight: 400;">
                            ${currentIdx + 1} / ${urls.length}장
                        </span>
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <button id="mpvOpenBtn"
                                style="padding: 6px 14px; background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px;">
                            🔗 새탭 열기
                        </button>
                        <button id="mpvCloseBtn"
                                style="background: none; border: none; color: white; font-size: 28px; cursor: pointer; line-height: 1; padding: 0 4px;">×</button>
                    </div>
                </div>
                
                <!-- 이미지 -->
                <div style="position: relative; text-align: center;">
                    <img id="mpvImage" src="${urls[currentIdx]}" 
                         style="max-width: 100%; max-height: 75vh; border-radius: 8px; box-shadow: 0 4px 30px rgba(0,0,0,0.5); display: block; margin: 0 auto; object-fit: contain;"
                         onerror="this.style.background='#1e293b'; this.style.minHeight='300px'; this.alt='이미지 로드 실패';">
                    
                    <!-- 좌우 네비게이션 (2장 이상일 때) -->
                    ${urls.length > 1 ? `
                        <button id="mpvPrev" 
                                style="position: absolute; left: -48px; top: 50%; transform: translateY(-50%);
                                       width: 40px; height: 40px; border-radius: 50%; background: rgba(255,255,255,0.15);
                                       border: none; color: white; font-size: 20px; cursor: pointer;
                                       display: flex; align-items: center; justify-content: center;
                                       ${currentIdx === 0 ? 'opacity: 0.3; cursor: not-allowed;' : ''}">‹</button>
                        <button id="mpvNext"
                                style="position: absolute; right: -48px; top: 50%; transform: translateY(-50%);
                                       width: 40px; height: 40px; border-radius: 50%; background: rgba(255,255,255,0.15);
                                       border: none; color: white; font-size: 20px; cursor: pointer;
                                       display: flex; align-items: center; justify-content: center;
                                       ${currentIdx === urls.length - 1 ? 'opacity: 0.3; cursor: not-allowed;' : ''}">›</button>
                    ` : ''}
                </div>
                
                <!-- 썸네일 도트 (2장 이상) -->
                ${urls.length > 1 ? `
                <div style="display: flex; justify-content: center; gap: 8px; margin-top: 14px;">
                    ${urls.map((_, i) => `
                        <button data-idx="${i}"
                                style="width: ${i === currentIdx ? '24px' : '8px'}; height: 8px; border-radius: 4px;
                                       background: ${i === currentIdx ? '#3b82f6' : 'rgba(255,255,255,0.4)'};
                                       border: none; cursor: pointer; transition: all 0.2s; padding: 0;"
                                class="mpv-dot"></button>
                    `).join('')}
                </div>
                ` : ''}
            </div>
        `;
        
        // 이벤트 바인딩
        overlay.querySelector('#mpvCloseBtn').onclick = () => overlay.remove();
        overlay.querySelector('#mpvOpenBtn').onclick = () => window.open(urls[currentIdx], '_blank');
        
        if (urls.length > 1) {
            const prevBtn = overlay.querySelector('#mpvPrev');
            const nextBtn = overlay.querySelector('#mpvNext');
            if (prevBtn) prevBtn.onclick = () => { if (currentIdx > 0) { currentIdx--; render(); } };
            if (nextBtn) nextBtn.onclick = () => { if (currentIdx < urls.length - 1) { currentIdx++; render(); } };
            overlay.querySelectorAll('.mpv-dot').forEach(dot => {
                dot.onclick = () => { currentIdx = parseInt(dot.dataset.idx); render(); };
            });
        }
    };
    
    render();
    
    // 배경 클릭 시 닫기
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    // 키보드 좌우 화살표
    const keyHandler = (e) => {
        if (!document.getElementById('multiPagePreviewOverlay')) {
            document.removeEventListener('keydown', keyHandler);
            return;
        }
        if (e.key === 'ArrowLeft' && currentIdx > 0) { currentIdx--; render(); }
        if (e.key === 'ArrowRight' && currentIdx < urls.length - 1) { currentIdx++; render(); }
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', keyHandler); }
    };
    document.addEventListener('keydown', keyHandler);
    
    document.body.appendChild(overlay);
}

/**
 * PDF 파일 선택 핸들러
 */
export async function handlePdfFileSelect(event) {
    const file = event.target.files[0];
    if (!file || file.type !== 'application/pdf') {
        showToast('PDF 파일을 선택해주세요', 'error');
        return;
    }
    
    // 로딩 상태 표시
    document.getElementById('pdfLoadingState').style.display = 'block';
    document.getElementById('pdfPageSelector').style.display = 'none';
    
    try {
        const arrayBuffer = await file.arrayBuffer();
        
        // PDF.js 로드
        if (typeof pdfjsLib === 'undefined') {
            throw new Error('PDF.js 라이브러리를 로드할 수 없습니다');
        }
        
        // PDF 문서 로드
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        pdfState.pdfDoc = await loadingTask.promise;
        pdfState.totalPages = pdfState.pdfDoc.numPages;
        
        // 대상 페이지가 전체 페이지 수보다 크면 1로 설정
        if (pdfState.currentPage > pdfState.totalPages) {
            pdfState.currentPage = 1;
        }
        
        // UI 업데이트
        document.getElementById('pdfTotalPages').textContent = pdfState.totalPages;
        document.getElementById('pdfPageInput').max = pdfState.totalPages;
        document.getElementById('pdfPageInput').value = pdfState.currentPage;
        
        // 페이지 렌더링
        await renderPdfPage(pdfState.currentPage);
        
        // 로딩 숨기고 선택 영역 표시
        document.getElementById('pdfLoadingState').style.display = 'none';
        document.getElementById('pdfPageSelector').style.display = 'block';
        const uploadBtn = document.getElementById('pdfUploadBtn');
        uploadBtn.disabled = false;
        uploadBtn.style.opacity = '1';
        
    } catch (error) {
        console.error('PDF 로드 오류:', error);
        document.getElementById('pdfLoadingState').style.display = 'none';
        showToast('PDF 파일을 불러올 수 없습니다: ' + error.message, 'error');
    }
}

/**
 * PDF 페이지 렌더링
 */
async function renderPdfPage(pageNum) {
    if (!pdfState.pdfDoc) return;
    
    try {
        const page = await pdfState.pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: pdfState.scale });
        
        const canvas = document.getElementById('pdfPreviewCanvas');
        const context = canvas.getContext('2d');
        
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        
        await page.render({
            canvasContext: context,
            viewport: viewport
        }).promise;
        
        // 현재 페이지 업데이트
        pdfState.currentPage = pageNum;
        document.getElementById('pdfCurrentPage').textContent = pageNum;
        document.getElementById('pdfPageInput').value = pageNum;
        
    } catch (error) {
        console.error('페이지 렌더링 오류:', error);
        showToast('페이지를 렌더링할 수 없습니다', 'error');
    }
}

/**
 * 이전 페이지
 */
export function pdfPrevPage() {
    if (pdfState.currentPage > 1) {
        renderPdfPage(pdfState.currentPage - 1);
    }
}

/**
 * 다음 페이지
 */
export function pdfNextPage() {
    if (pdfState.currentPage < pdfState.totalPages) {
        renderPdfPage(pdfState.currentPage + 1);
    }
}

/**
 * 특정 페이지로 이동
 */
export function goToPdfPage(pageNum) {
    const page = parseInt(pageNum);
    if (page >= 1 && page <= pdfState.totalPages) {
        renderPdfPage(page);
    }
}

/**
 * PDF 페이지를 이미지로 변환하여 Firebase Storage에 업로드
 */
export async function uploadPdfPageImage() {
    if (!pdfState.pdfDoc || !pdfState.buildingId) {
        showToast('PDF를 먼저 선택해주세요', 'error');
        return;
    }
    
    // 교체/추가 모드 읽기
    const modeEl = document.querySelector('input[name="pdfUploadMode"]:checked');
    pdfState.uploadMode = modeEl?.value || 'replace';
    
    const uploadBtn = document.getElementById('pdfUploadBtn');
    uploadBtn.disabled = true;
    uploadBtn.textContent = '⏳ 업로드 중...';
    
    // 진행 상태 표시
    document.getElementById('pdfUploadProgress').style.display = 'block';
    const progressBar = document.getElementById('pdfUploadProgressBar');
    progressBar.style.width = '10%';
    
    try {
        // 고해상도 캔버스 생성 (업로드용)
        const page = await pdfState.pdfDoc.getPage(pdfState.currentPage);
        const scale = 2.0; // 고해상도
        const viewport = page.getViewport({ scale });
        
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        
        progressBar.style.width = '30%';
        
        await page.render({
            canvasContext: context,
            viewport: viewport
        }).promise;
        
        progressBar.style.width = '50%';
        
        // Canvas를 Blob으로 변환
        const blob = await new Promise(resolve => {
            canvas.toBlob(resolve, 'image/jpeg', 0.9);
        });
        
        progressBar.style.width = '70%';
        
        // ★ v3.1 수정: admin-leasing.html 업로드 경로와 일치 (2단계 폴더 구조)
        // 경로: leasing-docs/{source}/{publishDate}/page_NNN.jpg
        const source = pdfState.source || 'unknown';
        const period = pdfState.period || 'unknown';
        const safeSource = source.replace(/[\s\.]+/g, '_').replace(/__+/g, '_');
        const safePeriod = period.replace(/[\s\.]+/g, '_').replace(/__+/g, '_');
        
        // ★ 추가 모드일 때 기존 이미지 수를 기준으로 파일명 결정
        let basePageNum;
        if (pdfState.uploadMode === 'append') {
            // 현재 _meta에 등록된 이미지 수 파악 → 다음 번호 사용
            const existingMeta = state.selectedBuilding?.vacancies?.find(
                v => v._key?.endsWith('_meta') && v.source === source && v.publishDate === period
            );
            const existingUrls = existingMeta?.pageImageUrls || (existingMeta?.pageImageUrl ? [existingMeta.pageImageUrl] : []);
            basePageNum = String(pdfState.currentPage).padStart(3, '0');
            // 파일 충돌 방지: 이미 같은 번호가 있으면 suffix 추가
            // (실제로는 Storage가 덮어쓰기하지만 구분 위해 _p2, _p3 suffix)
            const suffix = existingUrls.length > 0 ? `_extra${existingUrls.length}` : '';
            var storagePath = `leasing-docs/${safeSource}/${safePeriod}/page_${basePageNum}${suffix}.jpg`;
        } else {
            basePageNum = String(pdfState.targetPageNum || pdfState.currentPage).padStart(3, '0');
            var storagePath = `leasing-docs/${safeSource}/${safePeriod}/page_${basePageNum}.jpg`;
        }
        
        console.log(`[pdfUpload] 모드: ${pdfState.uploadMode}, 경로: ${storagePath}`);
        
        // Firebase Storage에 업로드 (전역 함수 사용)
        if (typeof window.uploadImageToStorage !== 'function') {
            throw new Error('Firebase Storage 업로드 함수를 찾을 수 없습니다');
        }
        
        const downloadUrl = await window.uploadImageToStorage(blob, storagePath);
        
        progressBar.style.width = '90%';
        
        console.log('업로드 완료:', downloadUrl);
        
        // ★ _meta 레코드에 pageImageUrls 배열로 저장
        const metaKey = `${safeSource}_${safePeriod}_meta`;
        
        // 기존 _meta에서 현재 pageImageUrls 가져오기
        const existingMeta = state.selectedBuilding?.vacancies?.find(
            v => v._key === metaKey
        );
        let pageImageUrls = existingMeta?.pageImageUrls 
            ? [...existingMeta.pageImageUrls]
            : (existingMeta?.pageImageUrl ? [existingMeta.pageImageUrl] : []);
        
        if (pdfState.uploadMode === 'replace') {
            // 교체: 기존 배열 초기화 후 새 URL 하나만
            pageImageUrls = [downloadUrl];
        } else {
            // 추가: 배열에 append (중복 방지)
            if (!pageImageUrls.includes(downloadUrl)) {
                pageImageUrls.push(downloadUrl);
            }
        }
        
        const metaData = {
            source: source,
            publishDate: period,
            pageImageUrl: pageImageUrls[0],      // 첫 번째 (하위 호환)
            pageImageUrls: pageImageUrls,         // ★ 전체 배열
            pageNum: pdfState.targetPageNum || pdfState.currentPage || 1,
            updatedAt: new Date().toISOString(),
            updatedBy: state.currentUser?.email || null
        };
        // undefined/null 제거
        const cleanMeta = Object.fromEntries(
            Object.entries(metaData).filter(([, v]) => v !== undefined && v !== null)
        );
        
        await update(ref(db, `vacancies/${pdfState.buildingId}/${metaKey}`), cleanMeta);
        
        progressBar.style.width = '100%';
        
        // ★ 로컬 상태 동기화
        const buildingObj = state.allBuildings.find(b => b.id === pdfState.buildingId);
        [buildingObj, state.selectedBuilding?.id === pdfState.buildingId ? state.selectedBuilding : null]
            .filter(Boolean)
            .forEach(b => {
                if (!b.vacancies) b.vacancies = [];
                const mIdx = b.vacancies.findIndex(v => v._key === metaKey);
                if (mIdx >= 0) {
                    b.vacancies[mIdx] = { ...b.vacancies[mIdx], ...cleanMeta, _key: metaKey };
                } else {
                    b.vacancies.push({ ...cleanMeta, _key: metaKey });
                }
            });
        
        const modeLabel = pdfState.uploadMode === 'append' ? '추가' : '교체';
        showToast(`페이지 이미지가 ${modeLabel}되었습니다 (총 ${pageImageUrls.length}장)`, 'success');
        closePdfUploadModal();
        
        // 문서 섹션 새로고침
        renderDocumentSection();
        
    } catch (error) {
        console.error('업로드 오류:', error);
        showToast('업로드 중 오류가 발생했습니다: ' + error.message, 'error');
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = '📤 이 페이지 업로드';
        document.getElementById('pdfUploadProgress').style.display = 'none';
    }
}

// ===== 빌딩 노트 CRUD =====

// 빌딩 노트 모달 열기
window.openBuildingNoteModal = function() {
    if (!state.selectedBuilding) return;
    
    const notes = state.selectedBuilding.notes || '';
    document.getElementById('buildingNoteText').value = notes;
    
    document.getElementById('buildingNoteModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
};

// 빌딩 노트 저장
window.saveBuildingNote = async function(noteText) {
    if (!state.selectedBuilding) return;
    
    try {
        const updates = {
            notes: noteText,
            updatedAt: new Date().toISOString(),
            updatedBy: state.currentUser?.email
        };
        
        await update(ref(db, `buildings/${state.selectedBuilding.id}`), updates);
        
        // 로컬 상태 업데이트
        state.selectedBuilding.notes = noteText;
        
        // allBuildings에서도 업데이트
        const idx = state.allBuildings.findIndex(b => b.id === state.selectedBuilding.id);
        if (idx >= 0) {
            state.allBuildings[idx].notes = noteText;
        }
        
        document.getElementById('buildingNoteModal').classList.remove('show');
        document.getElementById('modalOverlay').classList.remove('show');
        
        // 화면 갱신
        renderInfoSection();
        if (window.applyFilters) window.applyFilters();  // ★ v#5: 빌딩 리스트 stale 방지
        // ★ v#5-hotfix4: 같은 메뉴 안 stale 방지 — async fetch가 fresh 보장
        setTimeout(() => { if (window.refreshInfoSection) window.refreshInfoSection(); }, 0);
        showToast('빌딩 노트가 저장되었습니다', 'success');
    } catch (e) {
        console.error('빌딩 노트 저장 오류:', e);
        showToast('저장 실패', 'error');
    }
};

// 빌딩 노트 폼 제출 이벤트 (DOMContentLoaded에서 등록)
document.addEventListener('DOMContentLoaded', function() {
    const noteForm = document.getElementById('buildingNoteForm');
    if (noteForm) {
        noteForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const noteText = document.getElementById('buildingNoteText').value.trim();
            window.saveBuildingNote(noteText);
        });
    }
});

// ============================================================
// ★ v4.1: 빌딩 편집 모달 함수 (portal.html 인라인 캐시 문제 해결)
// portal.html 인라인 스크립트보다 나중에 로드되어 덮어씀
// ============================================================

/* =====================================================
 * ★ v4.2: 소수점 표시 유틸 — 건축물대장 원본의 긴 소수점을
 *   2자리 반올림으로 표시하되, 실제값은 data-actual-value에
 *   보관하여 저장 시 원본값으로 복원한다.
 * ===================================================== */

/**
 * 개별 input 필드에 소수점 2자리 표시 + 실제값 토글 버튼 부착
 * @param {HTMLInputElement} input
 */
function _applyDecimalDisplay(input) {
    const rawVal = input.value;
    if (rawVal === '' || rawVal === null) return;

    const _cf = (v) => (window.commaFormat ? window.commaFormat(v) : String(v));
    const clean = String(rawVal).replace(/,/g, '');
    const num = parseFloat(clean);
    if (isNaN(num)) return;

    const rounded = parseFloat(num.toFixed(2));
    // 소수점 3자리 미만이면 토글 불필요 — 콤마만 적용하고 종료
    if (Math.abs(num - rounded) < 1e-9) {
        input.value = _cf(clean);
        return;
    }

    // 원본값 보존 + step="any" 강제 (브라우저 유효성 차단)
    input.dataset.actualValue = clean;
    input.value = _cf(num.toFixed(2));
    input.setAttribute('step', 'any');

    // 이미 토글 버튼이 붙어있으면 스킵
    if (input.parentNode.querySelector('.decimal-toggle-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'decimal-toggle-btn';
    btn.dataset.mode = 'rounded'; // 'rounded' | 'actual'
    btn.title = '클릭하면 건축물대장 원본 소수점 전체를 표시합니다';
    btn.style.cssText = [
        'display:block',
        'margin-top:3px',
        'font-size:10px',
        'color:#999',
        'background:none',
        'border:1px dashed #ccc',
        'border-radius:3px',
        'padding:1px 7px',
        'cursor:pointer',
        'line-height:1.7',
        'white-space:nowrap',
    ].join(';');
    btn.textContent = `실제값 보기 (원본: ${num})`;

    btn.addEventListener('click', function () {
        if (this.dataset.mode === 'rounded') {
            input.value = _cf(input.dataset.actualValue);
            this.textContent = `반올림 보기 (2자리: ${rounded.toFixed(2)})`;
            this.dataset.mode = 'actual';
        } else {
            input.value = _cf(rounded.toFixed(2));
            this.textContent = `실제값 보기 (원본: ${num})`;
            this.dataset.mode = 'rounded';
        }
    });

    // 사용자가 직접 타이핑하면 바인딩 해제 (한 번만)
    input.addEventListener('input', function onUserInput() {
        delete this.dataset.actualValue;
        const existBtn = this.parentNode.querySelector('.decimal-toggle-btn');
        if (existBtn) existBtn.remove();
        this.removeEventListener('input', onUserInput);
    });

    input.parentNode.appendChild(btn);
}

/**
 * 모달 내 모든 숫자 입력 필드에 소수점 처리 일괄 적용
 * @param {HTMLElement} modalEl
 */
function _applyDecimalDisplayToModal(modalEl) {
    if (!modalEl) return;
    // step="any" 일괄 선제 적용 (브라우저 유효성 오류 완전 차단)
    modalEl.querySelectorAll('input[type="number"]').forEach(input => {
        input.setAttribute('step', 'any');
    });
    // 소수점 3자리 이상인 필드 탐색 (number + 숫자형 text 모두)
    modalEl.querySelectorAll('input[type="number"], input[type="text"]').forEach(input => {
        const val = (input.value || '').trim();
        if (/^[\d,]+\.\d{3,}$/.test(val)) {
            _applyDecimalDisplay(input);
        }
    });
}

/**
 * 저장 직전 — 반올림 표시 중인 필드의 DOM 값을 원본으로 복원
 * formData를 portal.html에서 수집하기 전에 DOM을 원상복구해야 하므로
 * saveBuildingEdit 진입 시점에 직접 DOM을 읽어 처리한다.
 * @param {HTMLElement} modalEl
 */
function _restoreActualValues(modalEl) {
    if (!modalEl) return;
    modalEl.querySelectorAll('[data-actual-value]').forEach(input => {
        const actual = input.dataset.actualValue;
        if (!actual) return;
        const displayed = parseFloat(String(input.value).replace(/,/g, ''));
        const rounded   = parseFloat(parseFloat(actual).toFixed(2));
        // 표시값이 반올림값과 같은 경우(=사용자가 건드리지 않음) → 원본 복원
        if (Math.abs(displayed - rounded) < 0.005) {
            input.value = actual;
        }
        // 이후 불필요하므로 attribute 정리
        delete input.dataset.actualValue;
    });
}

window.openBuildingEditModal = function() {
    const building = window.state?.selectedBuilding;
    if (!building) {
        if (typeof showToast === 'function') showToast('빌딩을 먼저 선택해주세요', 'error');
        return;
    }
    
    // ★ _raw에서도 fallback 시도
    const raw = building._raw || {};
    
    console.log('📝 [v4.1] 빌딩 편집 모달 열기:', building.name || raw.name);
    
    // 다중 경로에서 유효한 값 추출 (0은 유효)
    const getVal = (...paths) => {
        for (const p of paths) {
            if (p !== undefined && p !== null && p !== '') return p;
        }
        return '';
    };
    
    // 숫자 전용 (0도 유효)
    const getNum = (...paths) => {
        for (const p of paths) {
            if (p !== undefined && p !== null && p !== '') {
                const n = parseFloat(p);
                if (!isNaN(n)) return n;
            }
        }
        return '';
    };
    
    const setVal = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = (value !== undefined && value !== null) ? value : '';
    };
    
    // ★ 모달 타이틀에 빌딩명 표시
    const modalTitle = document.querySelector('#buildingEditModal .modal-title');
    const bName = getVal(building.name, raw.name, raw.buildingName);
    if (modalTitle) {
        modalTitle.textContent = bName ? `✏️ ${bName} 편집` : '✏️ 빌딩 정보 편집';
    }
    
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 건축물대장 원본 데이터 참조
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const bi = building.buildingInfo || raw.buildingInfo || {};
    const hasBi = Object.keys(bi).length > 0;

    // ─ 건축물대장 수신날짜 badge
    const fetchedAt = building.ledgerFetchedAt || raw.ledgerFetchedAt || bi._fetchedAt || '';
    const badgeEl = document.getElementById('ledgerFetchedBadge');
    if (badgeEl) {
        if (fetchedAt) {
            const d = new Date(fetchedAt);
            const label = `${String(d.getFullYear()).slice(2)}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} 수신`;
            badgeEl.textContent = label;
            badgeEl.style.background = '#10b981';
        } else if (hasBi) {
            badgeEl.textContent = '대장 보유 (수신일 미기록)';
            badgeEl.style.background = '#f59e0b';
        } else {
            badgeEl.textContent = '대장 미수신';
            badgeEl.style.background = '#ef4444';
        }
    }

    // ─ 건축물대장 원본값 힌트 헬퍼
    const setBiHint = (id, biVal) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (biVal !== null && biVal !== undefined && biVal !== '') {
            el.textContent = `건대 원본: ${biVal}`;
            el.style.color = '#3b82f6';
        } else {
            el.textContent = hasBi ? '건대 미기재' : '건대 미수신';
            el.style.color = '#94a3b8';
        }
    };

    // ─ 건축물대장에서 각 원본값 추출
    const bi_compYear  = bi.useAprDay ? bi.useAprDay.substring(0,4) : '';
    const bi_floors    = (bi.grndFlrCnt || bi.groundFloor)
                           ? `지하${bi.ugrndFlrCnt||0}층/지상${bi.grndFlrCnt||0}층` : '';
    const bi_grossSqm  = parseFloat(bi.totArea || bi.totalArea || 0);
    const bi_grossPy   = bi_grossSqm > 0 ? parseFloat((bi_grossSqm/3.30579).toFixed(1)) : '';
    const bi_landSqm   = parseFloat(bi.platArea  || bi.landArea     || 0);
    const bi_archSqm   = parseFloat(bi.archArea  || bi.buildingArea  || 0);
    const bi_vlRat     = bi.vlRat  || bi.floorAreaRatio || '';
    const bi_bcRat     = bi.bcRat  || bi.buildingCoverageRatio || '';
    const bi_struct    = bi.strctCdNm  || bi.structure || '';
    const bi_use       = bi.mainPurpsCdNm || bi.mainPurpose || bi.buildingUse || '';
    const bi_pkngTotal = bi.totPkngCnt || '';
    const bi_pkngSelf  = bi.indrAutoUtcnt  || '';
    const bi_pkngMech  = bi.indrMechUtcnt  || '';
    const bi_elvPassenger = bi.rideUseElvtCnt  || '';
    const bi_elvFreight   = bi.emgenUseElvtCnt || '';

    // ─ 건축물대장 원본 패널 렌더링 (readonly)
    const readonlyInfo = document.getElementById('buildingReadonlyInfo');
    if (readonlyInfo) {
        if (hasBi) {
            const _comp  = bi_compYear ? bi_compYear+'년' : '-';
            const _floor = bi_floors || '-';
            const _gPy   = bi_grossPy  ? Number(bi_grossPy).toLocaleString()+'평' : '-';
            const _gSqm  = bi_grossSqm ? '('+Number(bi_grossSqm.toFixed(1)).toLocaleString()+'㎡)' : '';
            const _land  = bi_landSqm  ? Number(bi_landSqm.toFixed(1)).toLocaleString()+'㎡' : '-';
            const _arch  = bi_archSqm  ? Number(bi_archSqm.toFixed(1)).toLocaleString()+'㎡' : '-';
            const _pkng  = bi_pkngTotal
                ? `${bi_pkngTotal}대${bi_pkngSelf ? ' (자주'+bi_pkngSelf+'/' : ''}${bi_pkngMech ? '기계'+bi_pkngMech+')' : (bi_pkngSelf?')':'')}`
                : '-';
            const _elv   = (bi_elvPassenger || bi_elvFreight)
                ? `승용${bi_elvPassenger||0}대/비상${bi_elvFreight||0}대` : '-';
            readonlyInfo.innerHTML = `
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:3px 14px; font-size:11px; color:#475569;">
                    <div>📅 <strong>준공:</strong> ${_comp}</div>
                    <div>🏗️ <strong>층수:</strong> ${_floor}</div>
                    <div>📐 <strong>연면적:</strong> ${_gPy} ${_gSqm}</div>
                    <div>🌍 <strong>대지면적:</strong> ${_land}</div>
                    <div>🏛️ <strong>건축면적:</strong> ${_arch}</div>
                    <div>📊 <strong>용적/건폐율:</strong> ${bi_vlRat||'-'}%/${bi_bcRat||'-'}%</div>
                    <div>🧱 <strong>구조:</strong> ${bi_struct||'-'}</div>
                    <div>🏢 <strong>용도:</strong> ${bi_use||'-'}</div>
                    <div>🅿️ <strong>주차:</strong> ${_pkng}</div>
                    <div>🛗 <strong>승강기:</strong> ${_elv}</div>
                </div>`;
        } else {
            readonlyInfo.innerHTML = '<span style="color:#ef4444;font-size:11px;">건축물대장 미수신 — 🔄 갱신 버튼으로 불러오세요</span>';
        }
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 건물 개요 — 각 필드에 건대 원본 힌트 표시 + 현재 저장값 세팅
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    // 준공연도
    setBiHint('bi_completionYear', bi_compYear ? bi_compYear+'년' : '');
    setVal('editCompletionYear', getVal(building.completionYear, raw.completionYear, bi_compYear));

    // 리모델링 표기 (마케팅용 — 건축물대장에 없음)
    setVal('editRemodelNote', getVal(building.remodelNote, raw.remodelNote));

    // 층수 표시
    setBiHint('bi_floors', bi_floors);
    const _currentFloors = typeof building.floors === 'object'
        ? (building.floors?.display || `지하${building.floors?.below||0}층/지상${building.floors?.above||0}층`)
        : (building.floors || '');
    setVal('editFloors', getVal(building.floorsDisplay, raw.floorsDisplay, _currentFloors));

    // 연면적 (평)
    setBiHint('bi_grossFloorPy', bi_grossPy ? `${Number(bi_grossPy).toLocaleString()}평 (${Number(bi_grossSqm.toFixed(1)).toLocaleString()}㎡)` : '');
    setVal('editGrossFloorPy', (window.commaFormat||(x=>x))(getNum(building.area?.grossFloorPy, building.grossFloorPy, raw.area?.grossFloorPy, raw.grossFloorPy, bi_grossPy||'')));

    // 대지면적 (㎡)
    setBiHint('bi_landAreaSqm', bi_landSqm ? `${Number(bi_landSqm.toFixed(1)).toLocaleString()}㎡` : '');
    setVal('editLandAreaSqm', (window.commaFormat||(x=>x))(getNum(building.area?.landArea, building.landArea, raw.area?.landArea, raw.landArea, bi_landSqm||'')));

    // 건축면적 (㎡)
    setBiHint('bi_buildingAreaSqm', bi_archSqm ? `${Number(bi_archSqm.toFixed(1)).toLocaleString()}㎡` : '');
    setVal('editBuildingAreaSqm', (window.commaFormat||(x=>x))(getNum(building.area?.buildingArea, building.buildingArea, raw.area?.buildingArea, raw.buildingArea, bi_archSqm||'')));

    // 용적률
    setBiHint('bi_vlRat', bi_vlRat ? `${bi_vlRat}%` : '');
    setVal('editVlRat', getNum(building.vlRat, building.floorAreaRatio, raw.vlRat, raw.floorAreaRatio, bi_vlRat||''));

    // 건폐율
    setBiHint('bi_bcRat', bi_bcRat ? `${bi_bcRat}%` : '');
    setVal('editBcRat', getNum(building.bcRat, building.buildingCoverageRatio, raw.bcRat, raw.buildingCoverageRatio, bi_bcRat||''));

    // 구조
    setBiHint('bi_structure', bi_struct);
    setVal('editStructure', getVal(building.specs?.structure, building.structure, raw.specs?.structure, raw.structure, bi_struct));

    // 건물용도
    setBiHint('bi_buildingUse', bi_use);
    setVal('editBuildingUse', getVal(building.specs?.buildingUse, building.buildingUse, building.mainPurpose, raw.specs?.buildingUse, raw.buildingUse, raw.mainPurpose, bi_use));

    // 주차 (건대 원본 힌트: 총대수/자주/기계)
    const _pkngHint = bi_pkngTotal
        ? `${bi_pkngTotal}대${bi_pkngSelf ? ' · 자주'+bi_pkngSelf : ''}${bi_pkngMech ? ' · 기계'+bi_pkngMech : ''}`
        : '';
    setBiHint('bi_parkingDisplay', _pkngHint);

    // 승강기 (건대 원본 힌트)
    const _elvHint = (bi_elvPassenger || bi_elvFreight)
        ? `승용${bi_elvPassenger||0}대/비상${bi_elvFreight||0}대` : '';
    setBiHint('bi_elevator', _elvHint);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 기본 정보
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    setVal('editBuildingName', getVal(building.name, raw.name, raw.buildingName));
    setVal('editGrade', getVal(building.grade, raw.grade));
    
    // 별칭
    const aliases = building.aliases || raw.aliases || [];
    setVal('editAliases', (Array.isArray(aliases) ? aliases : []).join(', '));
    
    // ★ v4.2: 기준층 정보 — 필드 의미 정리
    //   DB 구조: typicalFloorPy = 기준층 임대면적 (display에서 그대로 사용)
    //            exclusiveFloorPy = 기준층 전용면적 (없으면 임대×전용률 계산)
    //            typicalFloorLeasePy = typicalFloorPy의 alias (중복 저장용)
    //
    //   편집 모달 필드:
    //     editTypicalFloorPy    → 레이블 "기준층 면적(전용)" → 전용면적
    //     editTypicalFloorLeasePy → 레이블 "기준층 임대면적"   → 임대면적
    
    // 기준층 임대면적: typicalFloorPy 가 실제 저장 필드
    const _leasePy = getNum(
        building.area?.typicalFloorPy, building.typicalFloorPy,
        building.area?.typicalFloorLeasePy, building.typicalFloorLeasePy,
        raw.area?.typicalFloorPy, raw.typicalFloorPy,
        raw.area?.typicalFloorLeasePy, raw.typicalFloorLeasePy
    );
    setVal('editTypicalFloorLeasePy', _leasePy);

    // 기준층 전용면적: 별도 저장값 우선, 없으면 임대면적 × 전용률 계산
    const _excRate = getNum(building.area?.exclusiveRate, building.exclusiveRate, raw.area?.exclusiveRate, raw.exclusiveRate);
    const _storedExclPy = getNum(
        building.area?.exclusiveFloorPy, building.exclusiveFloorPy,
        raw.area?.exclusiveFloorPy, raw.exclusiveFloorPy
    );
    const _calcExclPy = (_leasePy && _excRate)
        ? parseFloat((_leasePy * _excRate / 100).toFixed(2))
        : '';
    setVal('editTypicalFloorPy', _storedExclPy || _calcExclPy);

    setVal('editExclusiveRate', _excRate);
    
    // ★ 임대조건 - 원 단위 그대로 표시 (변환 없음)
    setVal('editDepositPy', getNum(building.depositPy, building.pricing?.depositPy, raw.depositPy, raw.pricing?.depositPy));
    setVal('editRentPy', getNum(building.rentPy, building.pricing?.rentPy, raw.rentPy, raw.pricing?.rentPy));
    setVal('editMaintenancePy', getNum(building.maintenancePy, building.pricing?.maintenancePy, raw.maintenancePy, raw.pricing?.maintenancePy));
    
    // 시설 정보
    setVal('editHvac', getVal(building.hvac, raw.hvac, raw.specs?.hvac));
    setVal('editCeilingHeight', getNum(building.ceilingHeight, building.specs?.ceilingHeight, raw.ceilingHeight, raw.specs?.ceilingHeight));
    setVal('editFloorLoad', getNum(building.floorLoad, building.specs?.floorLoad, raw.floorLoad, raw.specs?.floorLoad));
    
    // 주차/승강기 - ★ v4.1: 텍스트 없으면 숫자 데이터에서 자동 생성
    const parkingDisplayVal = getVal(building.parking?.display, building.parkingDisplay, raw.parking?.display, raw.parkingDisplay)
        || (() => {
            const total = getNum(building.parking?.total, raw.parking?.total, building.buildingInfo?.totPkngCnt, raw.buildingInfo?.totPkngCnt);
            const self = getNum(building.parking?.selfPark, raw.parking?.selfPark, building.buildingInfo?.indrAutoUtcnt, raw.buildingInfo?.indrAutoUtcnt);
            const mech = getNum(building.parking?.mechanical, raw.parking?.mechanical, building.buildingInfo?.indrMechUtcnt, raw.buildingInfo?.indrMechUtcnt);
            if (!total) return '';
            let detail = [];
            if (self) detail.push(`자주식 ${self}대`);
            if (mech) detail.push(`기계식 ${mech}대`);
            return detail.length ? `총 ${total}대(${detail.join(', ')})` : `총 ${total}대`;
        })();
    setVal('editParkingDisplay', parkingDisplayVal);
    
    const elevatorVal = getVal(building.specs?.elevator, building.elevator, raw.specs?.elevator, raw.elevator)
        || (() => {
            const bi = building.buildingInfo || raw.buildingInfo || {};
            const p = getNum(bi.rideUseElvtCnt, building.specs?.passengerElevator, raw.specs?.passengerElevator);
            const f = getNum(bi.emgenUseElvtCnt, building.specs?.freightElevator, raw.specs?.freightElevator);
            if (!p && !f) return '';
            let parts = [];
            if (p) parts.push(`승용 ${p}대`);
            if (f) parts.push(`비상 ${f}대`);
            const total = (p || 0) + (f || 0);
            return `총 ${total}대(${parts.join(' ')})`;
        })();
    setVal('editElevator', elevatorVal);
    
    setVal('editParkingRatio', getVal(building.parking?.ratio, building.parkingRatio, raw.parking?.ratio, raw.parkingRatio));
    setVal('editNearbyStation', getVal(building.nearbyStation, building.nearestStation, raw.nearbyStation));
    
    // 관리 정보
    setVal('editPm', getVal(building.pm, raw.pm));
    setVal('editOwner', getVal(building.owner, raw.owner));
    
    // 채권분석 정보
    setVal('editBondStatus', getVal(building.bondStatus, raw.bondStatus));
    setVal('editJointCollateral', getVal(building.jointCollateral, raw.jointCollateral));
    setVal('editSeniorLien', getVal(building.seniorLien, raw.seniorLien));
    setVal('editCollateralRatio', getVal(building.collateralRatio, raw.collateralRatio));
    setVal('editOfficialLandPrice', getVal(building.officialLandPrice, raw.officialLandPrice));
    setVal('editLandPriceApplied', getVal(building.landPriceApplied, raw.landPriceApplied));
    
    // 기타
    setVal('editDescription', getVal(building.description, raw.description));
    setVal('editUrl', getVal(building.url, building.homepage, raw.url, raw.homepage));
    
    // 모달 표시 (closeModal과 호환되도록 openModal 사용)
    if (typeof openModal === 'function') {
        openModal('buildingEditModal');
    } else {
        const modal = document.getElementById('buildingEditModal');
        const overlay = document.getElementById('modalOverlay');
        if (modal) modal.classList.add('show');
        if (overlay) overlay.classList.add('show');
    }

    // ★ v4.2: 모달 DOM이 visible 상태가 된 후 소수점 표시 처리
    // (openModal이 동기라면 즉시, 비동기 애니메이션 고려해 한 틱 지연)
    requestAnimationFrame(() => {
        const editModal = document.getElementById('buildingEditModal');
        _applyDecimalDisplayToModal(editModal);
    });
};

// ============================================================
// ★ v4.2: 빌딩 정보 저장 (기준층 임대/전용면적 필드 분리 저장)
// ============================================================

window.saveBuildingEdit = async function(formData) {
    const building = window.state?.selectedBuilding;
    if (!building) {
        if (typeof showToast === 'function') showToast('빌딩을 먼저 선택해주세요', 'error');
        return;
    }

    // ★ v4.2: 반올림 표시 중인 필드의 원본값을 DOM에 복원 후
    //   formData를 재수집한다. (portal.html에서 이미 수집된 formData는
    //   반올림값이 들어있을 수 있으므로, DOM에서 직접 다시 읽는다.)
    const editModal = document.getElementById('buildingEditModal');
    _restoreActualValues(editModal);

    // DOM에서 최신값으로 formData 재구성 (원본값 복원 반영)
    const getFieldVal = (id) => {
        const el = editModal ? editModal.querySelector(`#${id}`) : null;
        return el ? el.value : (formData[id.replace(/^edit/, '').replace(/^(.)/, c => c.toLowerCase())] ?? '');
    };

    // 재수집: 원본값이 복원된 DOM에서 읽기
    const refreshedFormData = {
        name:            getFieldVal('editBuildingName'),
        grade:           getFieldVal('editGrade'),
        aliases:         getFieldVal('editAliases').split(',').map(s => s.trim()).filter(Boolean),
        // ★ 건물 개요 (건대 override)
        completionYear:   getFieldVal('editCompletionYear'),
        remodelNote:      getFieldVal('editRemodelNote'),
        floorsDisplay:    getFieldVal('editFloors'),
        grossFloorPy:     getFieldVal('editGrossFloorPy'),
        landAreaSqm:      getFieldVal('editLandAreaSqm'),
        buildingAreaSqm:  getFieldVal('editBuildingAreaSqm'),
        vlRat:            getFieldVal('editVlRat'),
        bcRat:            getFieldVal('editBcRat'),
        structure:        getFieldVal('editStructure'),
        buildingUse:      getFieldVal('editBuildingUse'),
        // 기준층
        typicalFloorPy:  getFieldVal('editTypicalFloorPy'),
        typicalFloorLeasePy: getFieldVal('editTypicalFloorLeasePy'),
        exclusiveRate:   getFieldVal('editExclusiveRate'),
        depositPy:       getFieldVal('editDepositPy'),
        rentPy:          getFieldVal('editRentPy'),
        maintenancePy:   getFieldVal('editMaintenancePy'),
        hvac:            getFieldVal('editHvac'),
        ceilingHeight:   getFieldVal('editCeilingHeight'),
        floorLoad:       getFieldVal('editFloorLoad'),
        parkingDisplay:  getFieldVal('editParkingDisplay'),
        elevator:        getFieldVal('editElevator'),
        parkingRatio:    getFieldVal('editParkingRatio'),
        nearbyStation:   getFieldVal('editNearbyStation'),
        pm:              getFieldVal('editPm'),
        owner:           getFieldVal('editOwner'),
        bondStatus:      getFieldVal('editBondStatus'),
        jointCollateral: getFieldVal('editJointCollateral'),
        seniorLien:      getFieldVal('editSeniorLien'),
        collateralRatio: getFieldVal('editCollateralRatio'),
        officialLandPrice: getFieldVal('editOfficialLandPrice'),
        landPriceApplied:  getFieldVal('editLandPriceApplied'),
        description:     getFieldVal('editDescription'),
        url:             getFieldVal('editUrl'),
    };
    // editModal이 없는 환경(구형 portal.html fallback)을 위해 전달된 formData도 병합
    formData = Object.assign({}, formData, refreshedFormData);

    // ★ 핵심 수정: 프리필 시 붙은 천단위 콤마 제거.
    //   getFieldVal은 콤마 포함 원문("25,208")을 반환하므로 parseFloat("25,208")=25 가 되어
    //   수정하지 않은 숫자 필드까지 엉뚱한 값(25 등)으로 저장되던 문제를 막는다.
    ['grossFloorPy', 'landAreaSqm', 'buildingAreaSqm', 'vlRat', 'bcRat',
     'typicalFloorLeasePy', 'typicalFloorPy', 'exclusiveRate',
     'depositPy', 'rentPy', 'maintenancePy', 'ceilingHeight', 'floorLoad'
    ].forEach(k => { if (typeof formData[k] === 'string') formData[k] = formData[k].replace(/,/g, '').trim(); });

    console.log('💾 [v4.2] 빌딩 정보 저장 (소수점 복원 포함):', formData);
    
    try {
        const { db, ref, update } = await import('./portal-firebase.js');
        
        const updates = {
            updatedAt: new Date().toISOString(),
            updatedBy: window.state?.currentUser?.email || 'unknown'
        };
        
        // 기본 정보
        if (formData.name) updates.name = formData.name;
        updates.grade = formData.grade || '';
        updates.aliases = formData.aliases || [];

        // ★ 건물 개요 — 건축물대장 override 값 저장
        // 준공연도: completionYear 에 저장 (renderInfoSection이 이 필드 우선 참조)
        if (formData.completionYear) updates.completionYear = String(formData.completionYear);
        // 리모델링 표기: 마케팅용 별도 필드
        updates.remodelNote = formData.remodelNote || '';
        // 층수 표시: floorsDisplay에 저장 (floors 객체의 display와 별개로 override 가능)
        if (formData.floorsDisplay) updates.floorsDisplay = formData.floorsDisplay;
        // 연면적 (평): area/grossFloorPy override
        if (formData.grossFloorPy) {
            const gPy = parseFloat(formData.grossFloorPy);
            if (!isNaN(gPy)) {
                updates['area/grossFloorPy'] = gPy;
                updates.grossFloorPy = gPy;
                // ㎡는 평이 실제로 변경된 경우에만 역산 저장 (건축물대장 원본 ㎡ 보존)
                const _storedPy = parseFloat(String(building.area?.grossFloorPy ?? building.grossFloorPy ?? '').replace(/,/g, ''));
                if (isNaN(_storedPy) || Math.abs(_storedPy - gPy) > 0.5) {
                    updates['area/grossFloorSqm'] = parseFloat((gPy * 3.30579).toFixed(2));
                    updates.grossFloorSqm = parseFloat((gPy * 3.30579).toFixed(2));
                }
            }
        }
        // 대지면적 (㎡)
        if (formData.landAreaSqm) {
            const la = parseFloat(formData.landAreaSqm);
            if (!isNaN(la)) { updates['area/landArea'] = la; updates.landArea = la; }
        }
        // 건축면적 (㎡)
        if (formData.buildingAreaSqm) {
            const ba = parseFloat(formData.buildingAreaSqm);
            if (!isNaN(ba)) { updates['area/buildingArea'] = ba; updates.buildingArea = ba; }
        }
        // 용적률 / 건폐율
        if (formData.vlRat !== '' && formData.vlRat !== undefined) updates.vlRat = formData.vlRat ? parseFloat(formData.vlRat) : null;
        if (formData.bcRat !== '' && formData.bcRat !== undefined) updates.bcRat = formData.bcRat ? parseFloat(formData.bcRat) : null;
        // 구조
        updates['specs/structure'] = formData.structure || '';
        updates.structure = formData.structure || '';
        // 건물용도
        updates['specs/buildingUse'] = formData.buildingUse || '';
        updates.buildingUse = formData.buildingUse || '';
        updates.mainPurpose = formData.buildingUse || '';   // 호환 필드

        // ★ v4.2: 기준층 정보 저장 — 필드 의미 재정렬
        //   formData.typicalFloorLeasePy (editTypicalFloorLeasePy, 기준층 임대면적)
        //     → display가 읽는 area/typicalFloorPy 에 저장 (기존 동작 유지)
        //   formData.typicalFloorPy (editTypicalFloorPy, 기준층 전용면적)
        //     → area/exclusiveFloorPy 에 저장 (신규 전용 필드)
        const parsedLeasePy    = formData.typicalFloorLeasePy ? parseFloat(formData.typicalFloorLeasePy) : null;
        const parsedExclPy     = formData.typicalFloorPy      ? parseFloat(formData.typicalFloorPy)      : null;
        const parsedExclRate   = formData.exclusiveRate        ? parseFloat(formData.exclusiveRate)       : null;

        // 임대면적 → 기존 display 필드에 그대로 기록
        updates['area/typicalFloorPy']     = parsedLeasePy;
        updates.typicalFloorPy             = parsedLeasePy;
        // alias 필드도 동기화
        updates['area/typicalFloorLeasePy'] = parsedLeasePy;
        updates.typicalFloorLeasePy        = parsedLeasePy;

        // 전용면적 → 신규 전용 필드에 저장
        updates['area/exclusiveFloorPy']   = parsedExclPy;
        updates.exclusiveFloorPy           = parsedExclPy;

        // 전용률
        updates['area/exclusiveRate']      = parsedExclRate;
        updates.exclusiveRate              = parsedExclRate;
        
        // ★ 임대조건 (원 단위 그대로 저장)
        const parseWon = (val) => {
            if (!val || val === '') return null;
            return Math.round(parseFloat(val));
        };
        const depositWon = parseWon(formData.depositPy);
        const rentWon = parseWon(formData.rentPy);
        const maintenanceWon = parseWon(formData.maintenancePy);
        
        updates.depositPy = depositWon;
        updates.rentPy = rentWon;
        updates.maintenancePy = maintenanceWon;
        updates['pricing/depositPy'] = depositWon;
        updates['pricing/rentPy'] = rentWon;
        updates['pricing/maintenancePy'] = maintenanceWon;
        
        // 시설 정보
        updates.hvac = formData.hvac || '';
        updates.ceilingHeight = formData.ceilingHeight ? parseInt(formData.ceilingHeight) : null;
        updates.floorLoad = formData.floorLoad ? parseInt(formData.floorLoad) : null;
        
        // 주차/승강기
        updates['parking/display'] = formData.parkingDisplay || '';
        updates.parkingDisplay = formData.parkingDisplay || '';
        updates['specs/elevator'] = formData.elevator || '';
        updates.elevator = formData.elevator || '';
        updates['parking/ratio'] = formData.parkingRatio || '';
        updates.parkingRatio = formData.parkingRatio || '';
        updates.nearbyStation = formData.nearbyStation || '';
        
        // 관리 정보
        updates.pm = formData.pm || '';
        updates.owner = formData.owner || '';
        
        // 채권분석 정보
        updates.bondStatus = formData.bondStatus || '';
        updates.jointCollateral = formData.jointCollateral || '';
        updates.seniorLien = formData.seniorLien || '';
        updates.collateralRatio = formData.collateralRatio || '';
        updates.officialLandPrice = formData.officialLandPrice || '';
        updates.landPriceApplied = formData.landPriceApplied || '';
        
        // 기타
        updates.description = formData.description || '';
        updates.url = formData.url || '';
        
        console.log('📤 Firebase 업데이트:', updates);
        
        await update(ref(db, `buildings/${building.id}`), updates);
        
        // 로컬 state 업데이트
        Object.keys(updates).forEach(key => {
            if (!key.includes('/')) {
                building[key] = updates[key];
            } else {
                const [parent, child] = key.split('/');
                if (!building[parent]) building[parent] = {};
                building[parent][child] = updates[key];
            }
        });
        
        // dataCache.buildings 동기화
        if (window.state.dataCache?.buildings?.[building.id]) {
            Object.keys(updates).forEach(key => {
                if (!key.includes('/')) {
                    window.state.dataCache.buildings[building.id][key] = updates[key];
                } else {
                    const [parent, child] = key.split('/');
                    if (!window.state.dataCache.buildings[building.id][parent]) {
                        window.state.dataCache.buildings[building.id][parent] = {};
                    }
                    window.state.dataCache.buildings[building.id][parent][child] = updates[key];
                }
            });
        }
        
        // allBuildings 업데이트
        const idx = window.state.allBuildings.findIndex(b => b.id === building.id);
        if (idx >= 0) {
            window.state.allBuildings[idx] = { ...window.state.allBuildings[idx], ...building };
        }
        
        // 모달 닫기
        if (typeof closeModal === 'function') {
            closeModal('buildingEditModal');
        } else {
            const m = document.getElementById('buildingEditModal');
            const o = document.getElementById('modalOverlay');
            if (m) m.classList.remove('show');
            if (o) o.classList.remove('show');
        }
        
        // 화면 갱신
        if (typeof refreshAfterCrud === 'function') {
            refreshAfterCrud(() => {
                if (typeof renderInfoSection === 'function') renderInfoSection();
                else if (window.renderInfoSection) window.renderInfoSection();
            });
        } else {
            if (typeof renderInfoSection === 'function') renderInfoSection();
            else if (window.renderInfoSection) window.renderInfoSection();
            if (typeof renderBuildingList === 'function') renderBuildingList();
            if (typeof renderTableView === 'function' && window.state?.currentViewMode === 'list') renderTableView();
        }
        // ★ v#5-hotfix4: 같은 메뉴 안 stale 방지 — async fetch가 fresh 보장
        setTimeout(() => { if (window.refreshInfoSection) window.refreshInfoSection(); }, 0);
        
        if (typeof showToast === 'function') {
            showToast('빌딩 정보가 저장되었습니다', 'success');
        }
        
    } catch (error) {
        console.error('빌딩 정보 저장 오류:', error);
        if (typeof showToast === 'function') {
            showToast('저장 실패: ' + error.message, 'error');
        }
    }
};

console.log('✅ [v4.2] openBuildingEditModal + saveBuildingEdit 모듈 로드 완료 (소수점 표시 개선)');

// ★ 안전망: registerDetailGlobals() 호출 시점에 의존하지 않고
//   module 로드 즉시 window에 noexcludeLowFloors 토글 함수 노출
//   (브라우저 캐시·import 순서 이슈 방어)
if (typeof window !== 'undefined') {
    window.toggleExcludeLowFloors = toggleExcludeLowFloors;
}

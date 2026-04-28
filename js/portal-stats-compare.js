/**
 * portal-stats-compare.js  v1.0  (Step 1: 골격)
 * ═══════════════════════════════════════════════════════════════
 * 두 시점(월 단위) 공실률·평균임대가·평균보증금·평균관리비 비교 모듈
 *
 * 진입점:
 *   window.openCompareModal()   — 모달 오픈
 *   window.closeCompareModal()  — 모달 닫기
 *
 * 의존성:
 *   - portal-stats.js (srLib)         — 정규화·필터·날짜 유틸 import
 *   - window.state.allBuildings        — 빌딩 마스터
 *   - window.state.currentUser         — 사용자 (Step 6 Firebase 저장 시)
 *
 * 결정사항 (2026-04 합의):
 *   · 시점 단위:                       월 단위 (YYYY-MM)
 *   · 두 시점 다른 회사 자료:           제한 없음
 *   · 평균 계산:                        연면적 가중평균
 *   · 한쪽만 자료 있는 빌딩:            경고만 + 사용자 수동 제외
 *   · Firebase 저장:                    /statsCompare/{compareId}
 *
 * 작업 단계:
 *   Step 1 (현재): 골격 — 모달, 두 시점 month 셀렉트, 필터 UI
 *   Step 2: 빌딩 리스트 (시점별 OCR 매칭)
 *   Step 3: 빌딩별 회사·공실 선택
 *   Step 4: 공통 빌딩 셋 검출
 *   Step 5: 계산 + 결과 카드
 *   Step 6: Firebase 저장 + 엑셀
 *
 * 자료구조 / Firebase 스키마는 STATS_COMPARE_HANDOFF.md 참조.
 * ═══════════════════════════════════════════════════════════════
 */

import {
    srGetNormBuildings,
    srGetAllPublishDates,
    srNormalizeDate,
    SR_REGIONS,
    SR_GRADES,
    SR_REGION_COLOR,
    SR_GRADE_COLOR,
} from './portal-stats.js';

// ═══════════════════════════════════════════════════════════════
// 1. 전역 상태
// ═══════════════════════════════════════════════════════════════

const _scState = {
    // 시점 A·B 각각 독립 (월 단위 YYYY-MM)
    pointA: {
        yyyymm:     '',
        filters:    { grades: [], regions: [], sizeBands: [], subRegions: [] },
        // Map<buildingId, { chosenSource, selectedVacKeys: Set<string> }>
        selections: new Map(),
    },
    pointB: {
        yyyymm:     '',
        filters:    { grades: [], regions: [], sizeBands: [], subRegions: [] },
        selections: new Map(),
    },

    // UI 상태
    selectedBuildingId: null,   // Step 3에서 사용

    // Firebase
    compareId: '',              // 새 세션이면 ''
    version:   0,
    title:     '',
    dirty:     false,
};

// 규모 구간 (필터용 — portal-stats.js srSizeBand 와 동일 정의)
const SR_SIZE_BANDS = ['대형', '중대형', '중형', '소형'];

// ═══════════════════════════════════════════════════════════════
// 2. 유틸리티
// ═══════════════════════════════════════════════════════════════

/** 안전한 querySelector */
function _scQS(id) { return document.getElementById(id); }

/** 시점 A/B 식별자 정규화 */
function _scSide(s) { return (s === 'B' || s === 'b') ? 'B' : 'A'; }

/** 사용 가능한 모든 발행월(YYYY-MM) 목록 — 내림차순 (최신 우선) */
function _scGetAllMonths() {
    const buildings = window.state?.allBuildings || [];
    const dates = srGetAllPublishDates(buildings);  // 오름차순 ['YYYY-MM', ...]
    return [...dates].sort().reverse();
}

// ═══════════════════════════════════════════════════════════════
// 3. 모달 동적 생성 / 주입
// ═══════════════════════════════════════════════════════════════

/**
 * 모달 DOM을 동적으로 body 에 주입 (portal.html 수정 최소화).
 * 이미 있으면 재주입하지 않음.
 */
function _scInjectModal() {
    if (_scQS('sc-modal')) return;

    const wrap = document.createElement('div');
    wrap.id = 'sc-modal';
    wrap.style.cssText = `
        display:none; position:fixed; top:50%; left:50%;
        transform:translate(-50%,-50%); background:var(--bg-card);
        border-radius:14px; padding:0; width:97%; max-width:1280px;
        z-index:1020; box-shadow:0 16px 56px rgba(0,0,0,0.35);
        max-height:93vh; overflow:hidden; flex-direction:column;
    `;

    wrap.innerHTML = `
        <!-- 헤더 -->
        <div style="padding:16px 24px; background:linear-gradient(135deg,#0f4c81,#1a73e8);
                    border-radius:14px 14px 0 0; display:flex;
                    justify-content:space-between; align-items:center; flex-shrink:0;">
            <div>
                <div style="font-size:16px; font-weight:700; color:#fff;">
                    📊 공실률 계산 및 비교
                </div>
                <div id="sc-subtitle"
                     style="font-size:12px; color:rgba(255,255,255,0.8); margin-top:2px;">
                    두 시점의 동일 빌딩 셋 기반 공실률·임대가·보증금·관리비 비교
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
                <button id="sc-btn-load" onclick="window._scOpenLoadList && window._scOpenLoadList()"
                    style="padding:6px 12px; background:rgba(255,255,255,0.18);
                           border:1px solid rgba(255,255,255,0.35); color:#fff;
                           border-radius:7px; cursor:pointer; font-size:12px; font-weight:600;"
                    title="저장된 비교 세션 불러오기 (Step 6)">
                    📂 불러오기
                </button>
                <button id="sc-btn-save" onclick="window._scSaveCompare && window._scSaveCompare()"
                    disabled
                    style="padding:6px 12px; background:rgba(255,255,255,0.12);
                           border:1px solid rgba(255,255,255,0.20); color:rgba(255,255,255,0.6);
                           border-radius:7px; cursor:not-allowed; font-size:12px; font-weight:600;"
                    title="현재 비교 세션 저장 (Step 6)">
                    💾 저장
                </button>
                <button onclick="window.closeCompareModal()"
                    style="background:rgba(255,255,255,0.15); border:none; color:#fff;
                           font-size:20px; width:34px; height:34px;
                           border-radius:8px; cursor:pointer;">×</button>
            </div>
        </div>

        <!-- 본체 (스크롤) -->
        <div style="overflow-y:auto; flex:1; min-height:0;">

            <!-- 시점 선택 섹션 -->
            <div style="padding:18px 24px 12px; border-bottom:1px solid var(--border-color);
                        background:var(--bg-secondary);">
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:18px;">
                    <!-- 시점 A -->
                    <div style="border-left:4px solid #0284c7; padding-left:12px;">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                            <span style="font-size:13px; font-weight:700; color:#0284c7;">
                                시점 A (기준)
                            </span>
                            <select id="sc-month-A"
                                onchange="window._scOnMonthChange('A', this.value)"
                                style="padding:5px 10px; border:1px solid var(--border-color);
                                       border-radius:6px; background:var(--bg-primary);
                                       color:var(--text-primary); font-size:12px; cursor:pointer;
                                       min-width:140px;">
                                <option value="">-- 월 선택 --</option>
                            </select>
                            <span id="sc-count-A"
                                style="font-size:11px; color:var(--text-muted);"></span>
                        </div>
                        <div id="sc-filters-A"
                             style="display:flex; flex-wrap:wrap; gap:6px;
                                    font-size:11px; color:var(--text-muted);">
                            <span>필터: 모듈 로드 중…</span>
                        </div>
                    </div>

                    <!-- 시점 B -->
                    <div style="border-left:4px solid #ea580c; padding-left:12px;">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                            <span style="font-size:13px; font-weight:700; color:#ea580c;">
                                시점 B (비교)
                            </span>
                            <select id="sc-month-B"
                                onchange="window._scOnMonthChange('B', this.value)"
                                style="padding:5px 10px; border:1px solid var(--border-color);
                                       border-radius:6px; background:var(--bg-primary);
                                       color:var(--text-primary); font-size:12px; cursor:pointer;
                                       min-width:140px;">
                                <option value="">-- 월 선택 --</option>
                            </select>
                            <span id="sc-count-B"
                                style="font-size:11px; color:var(--text-muted);"></span>
                        </div>
                        <div id="sc-filters-B"
                             style="display:flex; flex-wrap:wrap; gap:6px;
                                    font-size:11px; color:var(--text-muted);">
                            <span>필터: 모듈 로드 중…</span>
                        </div>
                    </div>
                </div>

                <!-- 진행 상태 안내 -->
                <div id="sc-progress-banner"
                     style="margin-top:12px; padding:8px 12px;
                            background:var(--bg-card); border-radius:6px;
                            font-size:11px; color:var(--text-muted);
                            border:1px dashed var(--border-color);">
                    💡 두 시점을 모두 선택하면 빌딩 리스트가 표시됩니다.
                    <span style="color:#9ca3af;">(Step 2 진행 중)</span>
                </div>
            </div>

            <!-- 빌딩 리스트 + 상세 영역 (Step 2-4) -->
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:0;
                        min-height:380px; border-bottom:1px solid var(--border-color);">
                <div id="sc-pane-list"
                     style="padding:16px 20px; border-right:1px solid var(--border-color);">
                    <div style="font-size:13px; font-weight:700; color:var(--text-primary);
                                margin-bottom:8px;">
                        🏢 대상 빌딩 리스트
                    </div>
                    <div id="sc-building-list"
                         style="font-size:12px; color:var(--text-muted); padding:30px 0;
                                text-align:center;">
                        시점을 먼저 선택해주세요.
                    </div>
                </div>
                <div id="sc-pane-detail"
                     style="padding:16px 20px;">
                    <div style="font-size:13px; font-weight:700; color:var(--text-primary);
                                margin-bottom:8px;">
                        📑 빌딩 상세 — 회사·공실 선택
                    </div>
                    <div id="sc-building-detail"
                         style="font-size:12px; color:var(--text-muted); padding:30px 0;
                                text-align:center;">
                        좌측에서 빌딩을 선택해주세요.
                    </div>
                </div>
            </div>

            <!-- 결과 영역 (Step 5) -->
            <div style="padding:16px 24px;">
                <div style="display:flex; justify-content:space-between; align-items:center;
                            margin-bottom:10px;">
                    <div style="font-size:13px; font-weight:700; color:var(--text-primary);">
                        📈 비교 결과
                    </div>
                    <button id="sc-btn-calc"
                        onclick="window._scCalculate && window._scCalculate()"
                        disabled
                        style="padding:8px 18px; background:var(--bg-secondary);
                               color:var(--text-muted); border:1px solid var(--border-color);
                               border-radius:7px; cursor:not-allowed; font-size:13px;
                               font-weight:700;">
                        📐 공실률 계산하기
                    </button>
                </div>
                <div id="sc-result-area"
                     style="background:var(--bg-secondary); border-radius:8px;
                            padding:24px; text-align:center; color:var(--text-muted);
                            font-size:12px; min-height:120px;
                            display:flex; align-items:center; justify-content:center;">
                    양 시점 모두 빌딩·회사·공실을 선택하면 [공실률 계산하기] 버튼이 활성화됩니다.
                </div>
            </div>

        </div>
    `;

    document.body.appendChild(wrap);
}

// ═══════════════════════════════════════════════════════════════
// 4. 초기화 / 셀렉트박스 채우기 / 필터 UI
// ═══════════════════════════════════════════════════════════════

/** 두 시점 month 셀렉트 박스 옵션 채우기 */
function _scPopulateMonthSelects() {
    const months = _scGetAllMonths();
    ['A', 'B'].forEach(side => {
        const sel = _scQS(`sc-month-${side}`);
        if (!sel) return;
        const cur = _scState[`point${side}`].yyyymm;
        sel.innerHTML = `<option value="">-- 월 선택 --</option>` +
            months.map(m => {
                const isSel = (m === cur) ? 'selected' : '';
                return `<option value="${m}" ${isSel}>${m}</option>`;
            }).join('');
    });
}

/**
 * 필터 영역 UI 렌더 — Step 1 에서는 placeholder 만 표시.
 * Step 2 에서 실제 권역/등급/규모 칩 멀티픽커로 교체 예정.
 */
function _scRenderFilters(side) {
    side = _scSide(side);
    const el = _scQS(`sc-filters-${side}`);
    if (!el) return;
    const f = _scState[`point${side}`].filters;
    const summary = [];
    if (f.grades.length)     summary.push(`등급: ${f.grades.join(',')}`);
    if (f.regions.length)    summary.push(`권역: ${f.regions.join(',')}`);
    if (f.sizeBands.length)  summary.push(`규모: ${f.sizeBands.join(',')}`);
    const txt = summary.length ? summary.join(' | ') : '필터: 전체';
    el.innerHTML = `
        <span style="opacity:0.7;">${txt}</span>
        <button onclick="window._scOpenFilterPicker && window._scOpenFilterPicker('${side}')"
            style="padding:2px 8px; border:1px solid var(--border-color); border-radius:10px;
                   background:var(--bg-card); color:var(--text-primary); font-size:11px;
                   cursor:pointer;">
            필터 변경
        </button>
    `;
}

/** 카운트 표시 — Step 2 에서 매칭 빌딩 수로 채워짐 */
function _scUpdateCount(side, n) {
    side = _scSide(side);
    const el = _scQS(`sc-count-${side}`);
    if (el) el.textContent = (n != null) ? `(${n}개 빌딩)` : '';
}

// ═══════════════════════════════════════════════════════════════
// 5. 진입점 / 이벤트 핸들러 (window 노출)
// ═══════════════════════════════════════════════════════════════

/** 모달 열기 — Top 메뉴 nav-item 에서 호출 */
window.openCompareModal = function() {
    _scInjectModal();
    _scPopulateMonthSelects();
    _scRenderFilters('A');
    _scRenderFilters('B');
    _scUpdateCount('A', null);
    _scUpdateCount('B', null);
    const modal = _scQS('sc-modal');
    if (modal) modal.style.display = 'flex';
    console.log('[stats-compare] modal opened');
};

/** 모달 닫기 */
window.closeCompareModal = function() {
    const modal = _scQS('sc-modal');
    if (modal) modal.style.display = 'none';
};

/** 시점 month 변경 핸들러 */
window._scOnMonthChange = function(side, yyyymm) {
    side = _scSide(side);
    _scState[`point${side}`].yyyymm = yyyymm || '';
    _scState.dirty = true;
    // Step 2 에서 _scRenderBuildingList(side) 호출 자리
    _scUpdateProgressBanner();
    _scUpdateCalcButton();
};

/** 진행 상태 배너 업데이트 */
function _scUpdateProgressBanner() {
    const el = _scQS('sc-progress-banner');
    if (!el) return;
    const a = _scState.pointA.yyyymm;
    const b = _scState.pointB.yyyymm;
    let msg, color;
    if (!a && !b) {
        msg   = '💡 두 시점을 모두 선택하면 빌딩 리스트가 표시됩니다.';
        color = 'var(--text-muted)';
    } else if (!a || !b) {
        msg   = '⏳ 아직 한쪽 시점이 선택되지 않았습니다.';
        color = '#ea580c';
    } else if (a === b) {
        msg   = '⚠️ 두 시점이 같습니다. 비교를 위해 서로 다른 월을 선택하세요.';
        color = '#dc2626';
    } else {
        msg   = `✅ ${a} ↔ ${b} 비교 준비 완료. 빌딩 리스트는 Step 2 에서 구현됩니다.`;
        color = '#16a34a';
    }
    el.innerHTML = `<span style="color:${color};">${msg}</span>`;
}

/** [계산하기] 버튼 활성화 조건 — Step 4 에서 공통 빌딩 수로 보강 */
function _scUpdateCalcButton() {
    const btn = _scQS('sc-btn-calc');
    if (!btn) return;
    const a = _scState.pointA.yyyymm;
    const b = _scState.pointB.yyyymm;
    // Step 1: month 만 두 시점 다르면 일단 활성화 X (계산 미구현)
    // Step 4 에서: 공통 빌딩 ≥ 1 추가 조건
    const ok = false;  // Step 5 에서 실제 활성화 로직 작성
    btn.disabled = !ok;
    btn.style.cursor = ok ? 'pointer' : 'not-allowed';
    btn.style.background = ok ? '#1a73e8' : 'var(--bg-secondary)';
    btn.style.color = ok ? '#fff' : 'var(--text-muted)';
}

/** 필터 멀티픽커 모달 — Step 2 에서 구현 */
window._scOpenFilterPicker = function(side) {
    alert(`필터 멀티픽커는 Step 2 에서 구현 예정 (요청 시점: ${_scSide(side)})`);
};

/** 비교 세션 불러오기 — Step 6 에서 구현 */
window._scOpenLoadList = function() {
    alert('저장된 비교 세션 불러오기는 Step 6 에서 구현 예정');
};

/** 비교 세션 저장 — Step 6 에서 구현 */
window._scSaveCompare = function() {
    alert('비교 세션 저장은 Step 6 에서 구현 예정');
};

/** 계산 — Step 5 에서 구현 */
window._scCalculate = function() {
    alert('공실률 계산은 Step 5 에서 구현 예정');
};

// ═══════════════════════════════════════════════════════════════
// 6. ESC 키 닫기
// ═══════════════════════════════════════════════════════════════

if (!window._scEscRegistered) {
    window._scEscRegistered = true;
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        const modal = _scQS('sc-modal');
        if (modal && modal.style.display !== 'none' && modal.style.display !== '') {
            // 다른 모달이 위에 떠 있으면 양보 (편집 모달 등)
            const editor = document.getElementById('stats-editor-modal');
            if (editor && editor.style.display !== 'none' && editor.style.display !== '') return;
            const stat = document.getElementById('statResearchModal');
            if (stat && stat.style.display !== 'none' && stat.style.display !== '') return;
            window.closeCompareModal();
        }
    });
}

// ═══════════════════════════════════════════════════════════════
// 7. 로드 완료 로그
// ═══════════════════════════════════════════════════════════════

console.log('[portal-stats-compare] v1.0 (Step 1: 골격) 로드 완료');

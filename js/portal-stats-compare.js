/**
 * portal-stats-compare.js  v1.1  (Step 2A: RAW 엑셀 업로드 + 모집단 매칭)
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
 *   - window.XLSX (SheetJS)            — RAW 엑셀 파싱 (portal.html 에 이미 로드됨)
 *
 * 결정사항 (2026-04 합의):
 *   · 시점 단위:                       월 단위 (YYYY-MM)
 *   · 두 시점 다른 회사 자료:           제한 없음
 *   · 평균 계산:                        연면적 가중평균
 *   · 한쪽만 자료 있는 빌딩:            경고만 + 사용자 수동 제외
 *   · Firebase 저장:                    /statsCompare/{compareId}
 *   · 모집단:                           RAW 엑셀 매번 업로드 (옵션 B)
 *
 * 작업 단계:
 *   Step 1  : 골격 — 모달, 두 시점 month 셀렉트, 필터 UI                       ✅ 완료
 *   Step 2A (현재): RAW 엑셀 업로드 + portal 빌딩 매칭 + 모집단 정의
 *   Step 2B : 권역/등급/규모 필터 멀티픽커 + 시점별 OCR 매칭 빌딩 리스트
 *   Step 3  : 빌딩별 회사·공실 선택
 *   Step 4  : 공통 빌딩 셋 검출
 *   Step 5  : 계산 + 결과 카드
 *   Step 6  : Firebase 저장 + 엑셀
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
    // ── 모집단 (RAW 엑셀 업로드 결과) ─────────────────────────
    // Step 2A: RAW 엑셀의 빌딩 리스트 + portal 빌딩 매칭 결과
    researchMaster: {
        loaded:      false,                 // 업로드 완료 여부
        fileName:    '',                    // 업로드한 파일명
        rawRows:     [],                    // RAW 엑셀 원본 행 배열
        matched:     [],                    // [{ raw, building, matchedBy }] 매칭 성공
        unmatched:   [],                    // [{ raw, reason }] 매칭 실패
        showUnmatch: false,                 // 미매칭 목록 펼침 토글
    },

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

            <!-- ━━━ STEP 2A: RAW 엑셀 업로드 / 모집단 정의 ━━━ -->
            <div id="sc-raw-section"
                 style="padding:16px 24px; border-bottom:1px solid var(--border-color);
                        background:linear-gradient(90deg, #fef3c7 0%, #fef9e7 100%);">
                <div style="display:flex; align-items:center; justify-content:space-between;
                            gap:12px; flex-wrap:wrap;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span style="font-size:13px; font-weight:700; color:#92400e;">
                            📁 1단계 — 모집단(RAW 엑셀) 업로드
                        </span>
                        <span style="font-size:11px; color:#92400e; opacity:0.75;">
                            조사 대상 빌딩 마스터 리스트
                        </span>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <input type="file" id="sc-raw-file" accept=".xlsx,.xls"
                            onchange="window._scOnRawUpload(this)"
                            style="display:none;">
                        <button onclick="document.getElementById('sc-raw-file').click()"
                            style="padding:7px 14px; background:#f59e0b; color:#fff;
                                   border:none; border-radius:7px; cursor:pointer;
                                   font-size:12px; font-weight:700; white-space:nowrap;">
                            📂 RAW 엑셀 선택
                        </button>
                        <button id="sc-raw-clear"
                            onclick="window._scClearRaw()"
                            disabled
                            style="padding:7px 12px; background:transparent;
                                   color:#92400e; border:1px solid #f59e0b;
                                   border-radius:7px; cursor:not-allowed; opacity:0.4;
                                   font-size:11px; font-weight:600;">
                            초기화
                        </button>
                    </div>
                </div>
                <div id="sc-raw-status"
                     style="margin-top:10px; padding:10px 14px; background:#fff;
                            border-radius:6px; border:1px dashed #f59e0b;
                            font-size:12px; color:#92400e;">
                    아직 RAW 엑셀이 업로드되지 않았습니다. 위 버튼을 눌러 파일을 선택하세요.
                </div>
                <div id="sc-raw-unmatch-area" style="display:none; margin-top:8px;"></div>
            </div>

            <!-- ━━━ STEP 1: 시점 선택 섹션 (모집단 로드 전엔 비활성화) ━━━ -->
            <div id="sc-point-section"
                 style="padding:18px 24px 12px; border-bottom:1px solid var(--border-color);
                        background:var(--bg-secondary); position:relative;">
                <div id="sc-point-overlay"
                     style="position:absolute; top:0; left:0; right:0; bottom:0;
                            background:rgba(248,250,252,0.85); z-index:1;
                            display:flex; align-items:center; justify-content:center;
                            font-size:12px; color:var(--text-muted);
                            backdrop-filter:blur(1px);">
                    🔒 먼저 RAW 엑셀을 업로드해야 시점 선택이 활성화됩니다.
                </div>
                <div style="font-size:11px; font-weight:700; color:var(--text-muted);
                            margin-bottom:8px; text-transform:uppercase; letter-spacing:0.5px;">
                    📅 2단계 — 비교 시점 선택
                </div>
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
                    <span style="color:#9ca3af;">(Step 2B 진행 예정)</span>
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
// 4. RAW 엑셀 업로드 / 모집단 매칭 (Step 2A)
// ═══════════════════════════════════════════════════════════════

/**
 * RAW 엑셀의 행과 portal 빌딩을 매칭한다.
 * 3단계 매칭:
 *   1차: ID번호 정확 매칭 (b.id === row['ID번호'])
 *   2차: 빌딩명 + 도로명+건물번호 부분 매칭
 *   3차: 빌딩명 정확 매칭 (단독)
 *
 * @param {Object} rawRow  엑셀 한 행 (객체 키 = 헤더명)
 * @param {Array}  portalBuildings  window.state.allBuildings
 * @returns {{building, matchedBy}|null}
 */
function _scMatchRawRow(rawRow, portalBuildings) {
    const norm  = v => String(v == null ? '' : v).trim();
    const rawId = norm(rawRow['ID번호']);

    // 1차: ID번호
    if (rawId && rawId !== 'New' && rawId !== 'NaN' && !isNaN(parseInt(rawId, 10))) {
        const hit = portalBuildings.find(b => norm(b.id) === rawId);
        if (hit) return { building: hit, matchedBy: 'id' };
    }

    const rawName = norm(rawRow['빌딩명']);
    const rawRoad = norm(rawRow['도로명']);
    const rawNum  = norm(rawRow['건물번호']);

    // 2차: 빌딩명 + 도로명+건물번호
    if (rawName && rawRoad && rawNum) {
        const addrKey = `${rawRoad} ${rawNum}`;
        const hit = portalBuildings.find(b => {
            const bName = norm(b.name || b.buildingName);
            const bAddr = norm(b.address);
            return bName === rawName && bAddr.includes(addrKey);
        });
        if (hit) return { building: hit, matchedBy: 'name+addr' };
    }

    // 3차: 빌딩명 단독
    if (rawName) {
        const candidates = portalBuildings.filter(b =>
            norm(b.name || b.buildingName) === rawName);
        if (candidates.length === 1) {
            return { building: candidates[0], matchedBy: 'name' };
        } else if (candidates.length > 1) {
            return null;  // 동명이 빌딩 다수 → 매칭 보류 (안전)
        }
    }

    return null;
}

/** RAW 매칭 실패 사유 분류 */
function _scUnmatchReason(rawRow, portalBuildings) {
    const norm  = v => String(v == null ? '' : v).trim();
    const rawName = norm(rawRow['빌딩명']);
    if (!rawName) return '빌딩명 없음';
    const sameName = portalBuildings.filter(b =>
        norm(b.name || b.buildingName) === rawName);
    if (sameName.length > 1) return `동명 빌딩 ${sameName.length}개 — 주소 불일치`;
    return 'portal 에 등록되지 않음';
}

/** RAW 엑셀 업로드 핸들러 — 파일 input 의 onchange 에서 호출 */
window._scOnRawUpload = function(input) {
    const file = input?.files?.[0];
    if (!file) return;
    if (!window.XLSX) {
        _scShowRawStatus('error', 'SheetJS(XLSX) 가 로드되지 않았습니다. portal.html line 11 의 SheetJS 로드 확인 필요');
        return;
    }
    _scShowRawStatus('loading', `📥 ${file.name} 읽는 중…`);

    const reader = new FileReader();
    reader.onload = e => {
        try {
            const wb    = window.XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            const rows  = window.XLSX.utils.sheet_to_json(sheet, { defval: '' });
            _scProcessRawRows(file.name, rows);
        } catch (err) {
            console.error('[stats-compare] RAW 엑셀 파싱 실패:', err);
            _scShowRawStatus('error', `❌ 엑셀 파싱 실패: ${err.message}`);
        }
    };
    reader.onerror = () => _scShowRawStatus('error', '❌ 파일 읽기 실패');
    reader.readAsArrayBuffer(file);

    // 같은 파일 재선택 가능하도록 input 값 리셋
    input.value = '';
};

/** 파싱된 행들을 portal 빌딩과 매칭하여 _scState.researchMaster 에 저장 */
function _scProcessRawRows(fileName, rows) {
    const portalBuildings = window.state?.allBuildings || [];
    if (portalBuildings.length === 0) {
        _scShowRawStatus('error', '❌ portal 빌딩 데이터가 아직 로드되지 않았습니다. 페이지 새로고침 후 다시 시도하세요.');
        return;
    }

    const matched   = [];
    const unmatched = [];

    rows.forEach(raw => {
        // 빌딩명 없는 행은 헤더 잔재 또는 빈 줄 → 무시
        if (!raw['빌딩명'] || String(raw['빌딩명']).trim() === '') return;
        const m = _scMatchRawRow(raw, portalBuildings);
        if (m) matched.push({ raw, building: m.building, matchedBy: m.matchedBy });
        else   unmatched.push({ raw, reason: _scUnmatchReason(raw, portalBuildings) });
    });

    _scState.researchMaster = {
        loaded:      true,
        fileName,
        rawRows:     rows,
        matched,
        unmatched,
        showUnmatch: false,
    };

    _scRenderRawStatus();
    _scLockUnlockPointSection(true);
};

/** RAW 매칭 결과 표시 */
function _scRenderRawStatus() {
    const rm = _scState.researchMaster;
    if (!rm.loaded) {
        _scShowRawStatus('idle', '아직 RAW 엑셀이 업로드되지 않았습니다. 위 버튼을 눌러 파일을 선택하세요.');
        return;
    }

    const totalRaw = rm.matched.length + rm.unmatched.length;
    const matchPct = totalRaw > 0 ? (rm.matched.length / totalRaw * 100).toFixed(1) : '0.0';

    // 매칭 방식별 카운트
    const byId    = rm.matched.filter(m => m.matchedBy === 'id').length;
    const byAddr  = rm.matched.filter(m => m.matchedBy === 'name+addr').length;
    const byName  = rm.matched.filter(m => m.matchedBy === 'name').length;

    const statusEl = _scQS('sc-raw-status');
    if (statusEl) {
        statusEl.style.background    = '#fff';
        statusEl.style.borderStyle   = 'solid';
        statusEl.style.borderColor   = '#16a34a';
        statusEl.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
                <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
                    <span style="font-weight:700; color:#15803d;">
                        ✅ ${rm.fileName}
                    </span>
                    <span style="color:#374151;">
                        RAW <strong>${totalRaw.toLocaleString()}</strong>개 ·
                        매칭 <strong style="color:#16a34a;">${rm.matched.length.toLocaleString()}</strong>개 (${matchPct}%) ·
                        미매칭 <strong style="color:#dc2626;">${rm.unmatched.length.toLocaleString()}</strong>개
                    </span>
                </div>
                ${rm.unmatched.length > 0 ? `
                    <button onclick="window._scToggleUnmatch()"
                        style="padding:4px 10px; background:#fef2f2; color:#991b1b;
                               border:1px solid #fca5a5; border-radius:5px;
                               font-size:11px; font-weight:600; cursor:pointer;">
                        ${rm.showUnmatch ? '미매칭 접기' : '미매칭 보기'}
                    </button>
                ` : ''}
            </div>
            <div style="margin-top:6px; font-size:11px; color:#6b7280;">
                매칭 내역: ID번호 ${byId}개 · 빌딩명+주소 ${byAddr}개 · 빌딩명단독 ${byName}개
            </div>
        `;
    }

    // 미매칭 영역
    const unmatchEl = _scQS('sc-raw-unmatch-area');
    if (unmatchEl) {
        if (rm.showUnmatch && rm.unmatched.length > 0) {
            unmatchEl.style.display = 'block';
            unmatchEl.innerHTML = `
                <div style="background:#fff; border:1px solid #fca5a5; border-radius:6px;
                            padding:10px 14px; max-height:220px; overflow-y:auto;">
                    <div style="font-size:11px; font-weight:700; color:#991b1b; margin-bottom:6px;">
                        ⚠️ 미매칭 ${rm.unmatched.length}개 (분모에서 제외됩니다)
                    </div>
                    <table style="width:100%; font-size:11px; border-collapse:collapse;">
                        <thead>
                            <tr style="color:#6b7280; text-align:left;">
                                <th style="padding:3px 6px; width:50px;">ID</th>
                                <th style="padding:3px 6px;">빌딩명</th>
                                <th style="padding:3px 6px;">주소</th>
                                <th style="padding:3px 6px; width:140px;">사유</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rm.unmatched.slice(0, 200).map(u => `
                                <tr style="border-top:1px solid #fee2e2;">
                                    <td style="padding:3px 6px; color:#9ca3af;">${u.raw['ID번호'] || '-'}</td>
                                    <td style="padding:3px 6px; font-weight:600;">${u.raw['빌딩명'] || '-'}</td>
                                    <td style="padding:3px 6px; color:#6b7280;">
                                        ${(u.raw['도로명'] || '') + ' ' + (u.raw['건물번호'] || '')}
                                    </td>
                                    <td style="padding:3px 6px; color:#dc2626;">${u.reason}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                    ${rm.unmatched.length > 200
                        ? `<div style="font-size:10px; color:#9ca3af; margin-top:6px; text-align:center;">
                             ※ 처음 200개만 표시 — 전체는 미매칭 ${rm.unmatched.length}개</div>`
                        : ''}
                </div>
            `;
        } else {
            unmatchEl.style.display = 'none';
            unmatchEl.innerHTML = '';
        }
    }

    // 초기화 버튼 활성화
    const clearBtn = _scQS('sc-raw-clear');
    if (clearBtn) {
        clearBtn.disabled = false;
        clearBtn.style.cursor = 'pointer';
        clearBtn.style.opacity = '1';
    }
}

/** 상태 메시지 표시 (idle / loading / error / success) */
function _scShowRawStatus(kind, msg) {
    const el = _scQS('sc-raw-status');
    if (!el) return;
    const palette = {
        idle:    { bg: '#fff',    border: '#f59e0b', color: '#92400e' },
        loading: { bg: '#eff6ff', border: '#3b82f6', color: '#1e40af' },
        error:   { bg: '#fef2f2', border: '#dc2626', color: '#991b1b' },
        success: { bg: '#f0fdf4', border: '#16a34a', color: '#15803d' },
    };
    const p = palette[kind] || palette.idle;
    el.style.background  = p.bg;
    el.style.borderColor = p.border;
    el.style.borderStyle = (kind === 'idle') ? 'dashed' : 'solid';
    el.style.color       = p.color;
    el.innerHTML         = msg;
}

/** 미매칭 목록 펼침/접기 */
window._scToggleUnmatch = function() {
    _scState.researchMaster.showUnmatch = !_scState.researchMaster.showUnmatch;
    _scRenderRawStatus();
};

/** RAW 엑셀 초기화 (재업로드 준비) */
window._scClearRaw = function() {
    if (!confirm('RAW 엑셀을 초기화하시겠습니까? 진행 중인 시점·필터·선택이 모두 사라집니다.')) return;
    _scState.researchMaster = {
        loaded: false, fileName: '', rawRows: [], matched: [], unmatched: [], showUnmatch: false,
    };
    // 시점·선택 상태도 함께 리셋 (모집단 변경 = 모든 후속 단계 무효)
    _scState.pointA.yyyymm = '';
    _scState.pointB.yyyymm = '';
    _scState.pointA.selections.clear();
    _scState.pointB.selections.clear();
    const sa = _scQS('sc-month-A'); if (sa) sa.value = '';
    const sb = _scQS('sc-month-B'); if (sb) sb.value = '';
    _scRenderRawStatus();
    _scLockUnlockPointSection(false);
    _scUpdateProgressBanner();
    const clearBtn = _scQS('sc-raw-clear');
    if (clearBtn) {
        clearBtn.disabled = true;
        clearBtn.style.cursor = 'not-allowed';
        clearBtn.style.opacity = '0.4';
    }
};

/** 시점 선택 섹션 락/언락 (모집단 로드 전엔 잠금) */
function _scLockUnlockPointSection(unlocked) {
    const overlay = _scQS('sc-point-overlay');
    if (overlay) overlay.style.display = unlocked ? 'none' : 'flex';
}

// ═══════════════════════════════════════════════════════════════
// 5. 초기화 / 셀렉트박스 채우기 / 필터 UI
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
// 6. 진입점 / 이벤트 핸들러 (window 노출)
// ═══════════════════════════════════════════════════════════════

/** 모달 열기 — Top 메뉴 nav-item 에서 호출 */
window.openCompareModal = function() {
    _scInjectModal();
    _scPopulateMonthSelects();
    _scRenderFilters('A');
    _scRenderFilters('B');
    _scUpdateCount('A', null);
    _scUpdateCount('B', null);
    // 모집단(RAW) 상태 반영 — 이전 세션에서 업로드한 게 메모리에 남아있으면 그대로
    _scRenderRawStatus();
    _scLockUnlockPointSection(_scState.researchMaster.loaded);
    _scUpdateProgressBanner();
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
// 7. ESC 키 닫기
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
// 8. 로드 완료 로그
// ═══════════════════════════════════════════════════════════════

console.log('[portal-stats-compare] v1.1 (Step 2A: RAW 엑셀 업로드 + 모집단 매칭) 로드 완료');

/**
 * portal-stats-editor.js
 * ═══════════════════════════════════════════════════════════════
 * 통계 대상 편집 UI (Phase 1)
 *
 * 목적:
 *   - 사용자가 통계 산출 대상(빌딩/vacancy)을 개별 선택/제외 가능
 *   - Firebase /statsFilter/{quarter} 에 분기별 독립 저장
 *   - Firebase /statsFilterLogs 에 편집 이력 기록 (감사 추적)
 *   - 낙관적 락(version)으로 충돌 감지
 *
 * 데이터 파이프라인:
 *   1차: RAW 엑셀 빌딩 (isResearchTarget=true 또는 researchMatchStatus)
 *     ↓
 *   2차: 등급/권역/세부권역 필터
 *     ↓
 *   3차: 공실정보 매칭 토글 (기본 ON)
 *     ↓
 *   4차: 빌딩 단위 체크박스 제외
 *     ↓
 *   5차: vacancy 단위 체크박스 제외
 *     ↓
 *   📊 통계 산출
 *
 * 의존성:
 *   - window.state.allBuildings — 빌딩 전체
 *   - window.state.currentUser — 사용자 정보
 *   - srGetNormBuildings() — 정규화 빌딩 (portal-stats.js)
 *   - srActiveVacancies() — 활성 공실 (portal-stats.js)
 *   - Firebase DB (./portal-firebase.js)
 *
 * Firebase 스키마:
 *   /statsFilter/{quarter}
 *       version           : number (낙관적 락)
 *       updatedAt         : ISO timestamp
 *       updatedBy         : email
 *       filters           : { grades, regions, subRegions, vacOnly }
 *       excludedBuildings : { [buildingId]: { memo, excludedAt, excludedBy } }
 *       excludedVacancies : { [bid__vkey]:  { buildingId, vacancyKey, memo, excludedAt, excludedBy } }
 *   /statsFilterLogs/{autoKey}
 *       quarter, action, targetId, memo, user, ts, prevVersion
 * ═══════════════════════════════════════════════════════════════
 */

import {
    srGetNormBuildings,
    srActiveVacancies,
    srVacancyAreaPy,
    srNormalizeDate,
    srGetQuarter,
} from './portal-stats.js';

// ═══════════════════════════════════════════════════════════════
// 1. 전역 상태
// ═══════════════════════════════════════════════════════════════

/** 현재 편집 중인 분기 및 필터/제외 상태 */
const _seState = {
    quarter:  '',             // "2024Q4" 같은 분기 키
    version:  0,              // 모달 열 때 스냅샷. 저장 시 충돌 감지용
    loaded:   false,          // Firebase 로드 완료?

    // 2차 필터 상태
    filters: {
        grades:     [],        // 비어있으면 전체
        regions:    [],
        subRegions: [],
        vacOnly:    true,      // 3차 토글: 공실정보 매칭 (기본 ON)
    },

    // 4차 선택: 빌딩 단위 제외
    excludedBuildings: new Map(),   // buildingId → { memo, excludedAt, excludedBy }

    // 5차 선택: vacancy 단위 제외
    excludedVacancies: new Map(),   // `${bid}__${vkey}` → { buildingId, vacancyKey, memo, excludedAt, excludedBy }

    // UI 상태
    selectedBuildingId: null,       // 좌측에서 선택된 빌딩 (우측 vacancy 리스트 표시 대상)
    searchQuery:        '',

    // Phase 3: 미저장 변경 추적
    dirty:              false,      // 마지막 적용 후 변경 있었는지
};

/** 편집 이력 UI 상태 (접기/펴기) */
let _seLogExpanded = false;

// ═══════════════════════════════════════════════════════════════
// 2. 유틸리티
// ═══════════════════════════════════════════════════════════════

/**
 * Firebase 키 제약 회피: :: → __
 *
 * ⚠️ 주의 (Phase 2): Firebase auto-key (vacId) 는 영숫자 + '-' 구성이므로 '__' 포함 위험 없음.
 * 그러나 buildingId 가 향후 수동 부여 형태로 바뀌면 파싱 충돌 가능.
 * 현재는 excludedVacancies 의 value 에 buildingId/vacancyKey 가 명시 저장되므로
 * _seParseVacKey 는 사용하지 않음. (방어용 보관)
 */
function _seMakeVacKey(buildingId, vacancyKey) {
    return `${buildingId}__${vacancyKey}`;
}
/** @deprecated Phase 2 기준 사용처 없음. 필요 시 excludedVacancies 의 value 에서 직접 참조 권장. */
function _seParseVacKey(combinedKey) {
    const idx = combinedKey.indexOf('__');
    if (idx < 0) return { buildingId: combinedKey, vacancyKey: '' };
    return {
        buildingId: combinedKey.slice(0, idx),
        vacancyKey: combinedKey.slice(idx + 2),
    };
}

/** 현재 로그인 사용자 식별자 */
function _seGetCurrentUser() {
    const u = window.state?.currentUser;
    return u?.email || u?.displayName || 'unknown';
}

/** ISO timestamp */
function _seNow() { return new Date().toISOString(); }

/** HTML escape */
function _seEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, m =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

/** 사용 가능한 분기 목록 (현재+최근 8분기) */
function _seGetAvailableQuarters() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const curQ = Math.ceil(m / 3);

    const out = [];
    for (let i = 0; i < 8; i++) {
        let yy = y, qq = curQ - i;
        while (qq <= 0) { qq += 4; yy--; }
        out.push(`${yy}Q${qq}`);
    }
    return out;
}

/** 메모 없으면 자동 기본값 */
function _seDefaultMemo(user) {
    return `사유 미입력 — ${user}`;
}

// ═══════════════════════════════════════════════════════════════
// 3. Firebase 로드/저장
// ═══════════════════════════════════════════════════════════════

/**
 * 분기 필터 로드 (없으면 빈 상태로 초기화)
 * @returns {Promise<{version: number}>}
 */
async function _seLoadStatsFilter(quarter) {
    const { db, ref, get } = await import('./portal-firebase.js');
    const snap = await get(ref(db, `statsFilter/${quarter}`));
    if (!snap.exists()) {
        // 신규 분기 — 빈 상태
        _seState.filters = { grades: [], regions: [], subRegions: [], vacOnly: true };
        _seState.excludedBuildings.clear();
        _seState.excludedVacancies.clear();
        return { version: 0 };
    }
    const data = snap.val() || {};

    _seState.filters = {
        grades:     Array.isArray(data.filters?.grades)     ? data.filters.grades     : [],
        regions:    Array.isArray(data.filters?.regions)    ? data.filters.regions    : [],
        subRegions: Array.isArray(data.filters?.subRegions) ? data.filters.subRegions : [],
        vacOnly:    data.filters?.vacOnly !== false,  // undefined 는 true 로
    };

    _seState.excludedBuildings.clear();
    Object.entries(data.excludedBuildings || {}).forEach(([bid, v]) => {
        _seState.excludedBuildings.set(bid, v || {});
    });

    _seState.excludedVacancies.clear();
    Object.entries(data.excludedVacancies || {}).forEach(([combinedKey, v]) => {
        _seState.excludedVacancies.set(combinedKey, v || {});
    });

    return { version: typeof data.version === 'number' ? data.version : 0 };
}

/**
 * 저장 (충돌 감지 포함)
 * @returns {Promise<{ok: boolean, reason?: string, newVersion?: number}>}
 */
async function _seSaveStatsFilter() {
    const { db, ref, get, update, push, set } = await import('./portal-firebase.js');
    const quarter = _seState.quarter;
    if (!quarter) return { ok: false, reason: '분기가 선택되지 않았습니다.' };

    // 1. 최신 version 조회 → 충돌 감지
    const latestSnap = await get(ref(db, `statsFilter/${quarter}/version`));
    const latestVersion = latestSnap.exists() ? (latestSnap.val() || 0) : 0;
    if (latestVersion !== _seState.version) {
        return {
            ok: false,
            reason: `다른 사용자가 먼저 저장했습니다 (현재 v${latestVersion}, 내 스냅샷 v${_seState.version}). 새로고침 후 다시 시도해주세요.`,
        };
    }

    const newVersion = latestVersion + 1;
    const user  = _seGetCurrentUser();
    const now   = _seNow();

    // 2. 저장 페이로드 구성
    const excludedBuildingsObj = {};
    for (const [bid, v] of _seState.excludedBuildings.entries()) {
        excludedBuildingsObj[bid] = v;
    }
    const excludedVacanciesObj = {};
    for (const [ck, v] of _seState.excludedVacancies.entries()) {
        excludedVacanciesObj[ck] = v;
    }

    const payload = {
        version:           newVersion,
        updatedAt:         now,
        updatedBy:         user,
        filters:           _seState.filters,
        excludedBuildings: excludedBuildingsObj,
        excludedVacancies: excludedVacanciesObj,
    };

    // 3. /statsFilter/{quarter} 덮어쓰기
    await set(ref(db, `statsFilter/${quarter}`), payload);

    // 4. /statsFilterLogs 에 이력 추가
    const logEntry = {
        quarter,
        action:      'bulk_apply',
        targetId:    '',
        memo:        `v${_seState.version} → v${newVersion} 적용 (건물 제외 ${_seState.excludedBuildings.size}건, vacancy 제외 ${_seState.excludedVacancies.size}건)`,
        user,
        ts:          now,
        prevVersion: _seState.version,
        newVersion,
    };
    await push(ref(db, 'statsFilterLogs'), logEntry);

    _seState.version = newVersion;
    return { ok: true, newVersion };
}

/**
 * 최근 편집 이력 로드 (해당 분기 최근 20건)
 */
async function _seLoadRecentLogs(quarter, limit = 20) {
    const { db, ref, get } = await import('./portal-firebase.js');
    const snap = await get(ref(db, 'statsFilterLogs'));
    if (!snap.exists()) return [];
    const all = snap.val() || {};
    const filtered = Object.entries(all)
        .map(([k, v]) => ({ _id: k, ...v }))
        .filter(l => l.quarter === quarter)
        .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
        .slice(0, limit);
    return filtered;
}

/**
 * Phase 3: 개별 액션 로그 즉시 Firebase push.
 * 실패해도 UI 는 진행 (낙관적). 에러는 콘솔에만.
 *
 * @param {string} action     'add_building' | 'remove_building' | 'add_vacancy' | 'remove_vacancy' | 'filter_change'
 * @param {string} targetId   빌딩 id 또는 "bid__vkey" 또는 filter 키
 * @param {string} targetLabel 빌딩명 또는 "YYYY-MM source floor" 등 사람이 보는 라벨
 * @param {string} memo       사용자 메모 or 기본값
 */
async function _sePushActionLog(action, targetId, targetLabel, memo) {
    try {
        const { db, ref, push } = await import('./portal-firebase.js');
        await push(ref(db, 'statsFilterLogs'), {
            quarter:     _seState.quarter,
            action,
            targetId:    targetId    || '',
            targetLabel: targetLabel || '',
            memo:        memo        || '',
            user:        _seGetCurrentUser(),
            ts:          _seNow(),
            prevVersion: _seState.version,
        });
    } catch (err) {
        console.warn('[StatsEditor] action log push failed:', err, { action, targetId });
    }
}

/**
 * Phase 3: 편집 이력 패널이 열려있다면 재로드 (실시간 반영).
 */
async function _seReloadLogPanelIfOpen() {
    if (!_seLogExpanded) return;
    const body = document.getElementById('se-log-body');
    if (!body) return;
    // 현재 분기 로드
    try {
        const logs = await _seLoadRecentLogs(_seState.quarter, 20);
        if (logs.length === 0) {
            body.innerHTML = `<div style="padding:10px; color:var(--text-muted); font-size:12px;">편집 이력 없음</div>`;
        } else {
            body.innerHTML = logs.map(l => {
                const act = l.action || '-';
                const label = (typeof _SE_ACTION_LABEL !== 'undefined' && _SE_ACTION_LABEL[act]) || act;
                const color = (typeof _SE_ACTION_COLOR !== 'undefined' && _SE_ACTION_COLOR[act]) || '#64748b';
                const ts = (l.ts || '').slice(0, 16).replace('T', ' ');
                return `
                <div class="se-log-row">
                    <span class="se-log-ts">${_seEsc(ts)}</span>
                    <span class="se-log-user">${_seEsc(l.user || '-')}</span>
                    <span class="se-log-action" style="color:${color};">${_seEsc(label)}</span>
                    <span class="se-log-memo">${_seEsc(l.targetLabel ? `${l.targetLabel} — ` : '')}${_seEsc(l.memo || '')}</span>
                </div>`;
            }).join('');
        }
        body.dataset.loadedQuarter = _seState.quarter;
    } catch (err) {
        console.warn('[StatsEditor] log panel reload failed:', err);
    }
}

/**
 * Phase 3: dirty 플래그 설정 및 beforeunload 핸들러 등록/해제 관리.
 * dirty=true 로 전환 시 beforeunload 리스너 부착, false 로 전환 시 해제.
 */
function _seBeforeUnloadHandler(e) {
    if (!_seState.dirty) return;
    // 크롬 최신 정책: 커스텀 메시지는 표시 안 되지만 네이티브 확인창은 뜸
    e.preventDefault();
    e.returnValue = '저장되지 않은 변경 사항이 있습니다. 정말 나가시겠습니까?';
    return e.returnValue;
}
function _seSetDirty(v) {
    const was = _seState.dirty;
    _seState.dirty = !!v;
    if (was === _seState.dirty) return;  // 변화 없으면 skip

    if (_seState.dirty) {
        window.addEventListener('beforeunload', _seBeforeUnloadHandler);
    } else {
        window.removeEventListener('beforeunload', _seBeforeUnloadHandler);
    }
    // 적용 버튼에 dirty 상태 표시 (시각적 피드백)
    const btn = document.getElementById('se-apply-btn');
    if (btn) {
        if (_seState.dirty) {
            btn.textContent = '✓ 적용 (변경 있음)';
            btn.style.boxShadow = '0 0 0 3px rgba(251, 191, 36, 0.5)';
        } else {
            btn.textContent = '✓ 적용';
            btn.style.boxShadow = '';
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// 4. 파이프라인 — 현재 필터 상태로 빌딩 리스트 계산
// ═══════════════════════════════════════════════════════════════

/**
 * 각 단계별 건수 계산 (화면 상단 표시용)
 * @returns {{raw, afterFilter, afterVacOnly, afterExclude, buildings}}
 */
function _seRunPipeline() {
    const norm = srGetNormBuildings();

    // 1차: RAW 엑셀 빌딩 (isResearchTarget=true 또는 researchMatchStatus 보유)
    // portal.html 7132 패턴과 정합 — admin-research 에서 매칭된 빌딩도 포함
    const raw = norm.filter(b => b.isResearchTarget === true || b.researchMatchStatus);

    // 2차: 등급/권역/세부권역 필터
    const f = _seState.filters;
    const match = (arr, val) => !arr || arr.length === 0 || arr.includes(val);
    const afterFilter = raw.filter(b => {
        if (!match(f.grades,     b._gradeAuto))  return false;
        if (!match(f.regions,    b._region))     return false;
        if (f.subRegions.length > 0 && !f.subRegions.includes(b.subRegion || '')) return false;
        return true;
    });

    // 3차: vacOnly 토글
    const afterVacOnly = f.vacOnly
        ? afterFilter.filter(b => (b._activeVacs || []).length > 0)
        : afterFilter;

    // 4차: 빌딩 단위 제외 적용 (UI 노출은 유지 — 체크 해제 상태로 표시)
    // 여기서는 건수 계산용으로만 사용
    const afterExclude = afterVacOnly.filter(b => !_seState.excludedBuildings.has(b.id));

    // 검색 필터 (UI 전용 — 건수엔 영향 X, 반환 리스트에만 적용)
    const query = _seState.searchQuery.trim().toLowerCase();
    const displayBuildings = query
        ? afterVacOnly.filter(b => {
            const nm = (b.name || b.buildingName || '').toLowerCase();
            const ad = (b.address || '').toLowerCase();
            return nm.includes(query) || ad.includes(query);
        })
        : afterVacOnly;

    return {
        raw:          raw.length,
        afterFilter:  afterFilter.length,
        afterVacOnly: afterVacOnly.length,
        afterExclude: afterExclude.length,
        buildings:    displayBuildings,
    };
}

// ═══════════════════════════════════════════════════════════════
// 5. 모달 오픈/클로즈
// ═══════════════════════════════════════════════════════════════

window.openStatsEditorModal = async function() {
    const modal = document.getElementById('stats-editor-modal');
    if (!modal) return;

    // 기본 분기: 현재 분기
    const now = new Date();
    const curQ = `${now.getFullYear()}Q${Math.ceil((now.getMonth() + 1) / 3)}`;
    _seState.quarter = curQ;
    _seState.loaded  = false;
    _seState.searchQuery = '';
    _seState.selectedBuildingId = null;
    _seSetDirty(false);  // Phase 3: 모달 열 때 dirty 리셋

    // 모달 표시
    modal.style.display = 'flex';

    // 분기 셀렉트 초기화
    _seRenderQuarterSelect();

    // Firebase 로드 + 렌더
    await _seReloadAndRender();
};

window.closeStatsEditorModal = function() {
    // Phase 3: 미저장 변경 있으면 경고
    if (_seState.dirty) {
        const ok = confirm('저장되지 않은 변경 사항이 있습니다.\n' +
                           '이대로 닫으면 변경이 메모리에서 사라집니다.\n' +
                           '(편집 이력 로그는 이미 Firebase 에 기록되었습니다.)\n\n' +
                           '정말 닫으시겠습니까?');
        if (!ok) return;
    }
    _seSetDirty(false);  // beforeunload 해제
    const modal = document.getElementById('stats-editor-modal');
    if (modal) modal.style.display = 'none';
};

async function _seReloadAndRender() {
    const ind = document.getElementById('se-loading');
    if (ind) ind.style.display = 'block';
    try {
        const { version } = await _seLoadStatsFilter(_seState.quarter);
        _seState.version = version;
        _seState.loaded  = true;
        _seRenderAll();
    } catch (err) {
        console.error('[StatsEditor] load failed:', err);
        alert(`분기 데이터 로드 실패: ${err.message}`);
    } finally {
        if (ind) ind.style.display = 'none';
    }
}

// ═══════════════════════════════════════════════════════════════
// 6. 렌더링
// ═══════════════════════════════════════════════════════════════

function _seRenderAll() {
    _seRenderHeaderInfo();
    _seRenderFilters();
    _seRenderPipelineSummary();
    _seRenderBuildingList();
    _seRenderVacancyList();
    _seRenderSelectionSummary();
}

function _seRenderQuarterSelect() {
    const sel = document.getElementById('se-quarter');
    if (!sel) return;
    const qs = _seGetAvailableQuarters();
    sel.innerHTML = qs.map(q => `<option value="${q}"${q === _seState.quarter ? ' selected' : ''}>${q}</option>`).join('');
}

function _seRenderHeaderInfo() {
    const ver = document.getElementById('se-version-label');
    if (ver) ver.textContent = `v${_seState.version}`;
    const user = document.getElementById('se-user-label');
    if (user) user.textContent = _seGetCurrentUser();
}

function _seRenderFilters() {
    const f = _seState.filters;

    // 등급 체크박스
    const GRADES = ['Prime', 'A', 'B', 'C', 'D', 'E'];
    const gradeWrap = document.getElementById('se-filter-grades');
    if (gradeWrap) {
        gradeWrap.innerHTML = GRADES.map(g => `
            <label class="se-chip${f.grades.includes(g) ? ' se-chip-on' : ''}">
                <input type="checkbox" ${f.grades.includes(g) ? 'checked' : ''}
                    onchange="_seToggleFilter('grades', '${g}', this.checked)">
                ${g}
            </label>
        `).join('');
    }

    // 권역 체크박스
    const REGIONS = ['CBD', 'GBD', 'YBD', 'BBD', 'Others'];
    const regWrap = document.getElementById('se-filter-regions');
    if (regWrap) {
        regWrap.innerHTML = REGIONS.map(r => `
            <label class="se-chip${f.regions.includes(r) ? ' se-chip-on' : ''}">
                <input type="checkbox" ${f.regions.includes(r) ? 'checked' : ''}
                    onchange="_seToggleFilter('regions', '${r}', this.checked)">
                ${r}
            </label>
        `).join('');
    }

    // 세부권역: 현재 2차 필터 통과 빌딩에서 동적 추출
    // 1차 RAW 필터는 _seRunPipeline 과 동일한 조건 사용
    const raw = srGetNormBuildings().filter(b => b.isResearchTarget === true || b.researchMatchStatus);
    const match = (arr, val) => !arr || arr.length === 0 || arr.includes(val);
    const candidatePool = raw.filter(b =>
        match(f.grades, b._gradeAuto) && match(f.regions, b._region));
    const subRegionSet = new Set();
    candidatePool.forEach(b => { if (b.subRegion) subRegionSet.add(b.subRegion); });
    const subRegions = [...subRegionSet].sort();
    const subWrap = document.getElementById('se-filter-subregions');
    if (subWrap) {
        if (subRegions.length === 0) {
            subWrap.innerHTML = `<span style="color:var(--text-muted); font-size:11px;">세부권역 정보 없음</span>`;
        } else {
            subWrap.innerHTML = subRegions.map(sr => `
                <label class="se-chip${f.subRegions.includes(sr) ? ' se-chip-on' : ''}">
                    <input type="checkbox" ${f.subRegions.includes(sr) ? 'checked' : ''}
                        onchange="_seToggleFilter('subRegions', '${_seEsc(sr)}', this.checked)">
                    ${_seEsc(sr)}
                </label>
            `).join('');
        }
    }

    // vacOnly 토글
    const vacCb = document.getElementById('se-vac-only');
    if (vacCb) vacCb.checked = !!f.vacOnly;
}

function _seRenderPipelineSummary() {
    const pipeline = _seRunPipeline();
    const el = document.getElementById('se-pipeline-summary');
    if (!el) return;
    el.innerHTML = `
        <div class="se-pipe-step">RAW: <b>${pipeline.raw}</b></div>
        <span class="se-pipe-arrow">→</span>
        <div class="se-pipe-step">2차 필터 후: <b>${pipeline.afterFilter}</b></div>
        <span class="se-pipe-arrow">→</span>
        <div class="se-pipe-step">공실 매칭 후: <b>${pipeline.afterVacOnly}</b></div>
        <span class="se-pipe-arrow">→</span>
        <div class="se-pipe-step se-pipe-final">최종 통계: <b>${pipeline.afterExclude}</b></div>
    `;
}

function _seRenderBuildingList() {
    const el = document.getElementById('se-building-list');
    if (!el) return;

    const pipeline = _seRunPipeline();
    const buildings = pipeline.buildings;

    if (buildings.length === 0) {
        el.innerHTML = `<div style="padding:40px 20px; text-align:center; color:var(--text-muted); font-size:13px;">
            필터 조건에 맞는 빌딩이 없습니다.
        </div>`;
        return;
    }

    // 등급 순 정렬 (Prime → A → ... → E), 같은 등급 내에서 이름순
    const GRADE_ORDER = { 'Prime':0, 'A':1, 'B':2, 'C':3, 'D':4, 'E':5 };
    const sorted = [...buildings].sort((a, b) => {
        const ga = GRADE_ORDER[a._gradeAuto] ?? 99;
        const gb = GRADE_ORDER[b._gradeAuto] ?? 99;
        if (ga !== gb) return ga - gb;
        const an = a.name || a.buildingName || '';
        const bn = b.name || b.buildingName || '';
        return an.localeCompare(bn, 'ko');
    });

    el.innerHTML = sorted.map(b => {
        const isExcluded = _seState.excludedBuildings.has(b.id);
        const isSelected = _seState.selectedBuildingId === b.id;
        const vacCount = (b._activeVacs || []).length;
        const memo = isExcluded ? _seState.excludedBuildings.get(b.id).memo || '' : '';

        return `<div class="se-bldg-row${isSelected ? ' se-bldg-selected' : ''}${isExcluded ? ' se-bldg-excluded' : ''}"
                     onclick="_seSelectBuilding('${_seEsc(b.id)}')">
            <input type="checkbox" class="se-bldg-cb"
                ${!isExcluded ? 'checked' : ''}
                onclick="event.stopPropagation()"
                onchange="_seToggleBuilding('${_seEsc(b.id)}', this.checked)">
            <div class="se-bldg-info">
                <div class="se-bldg-name">${_seEsc(b.name || b.buildingName || '(이름 없음)')}</div>
                <div class="se-bldg-meta">
                    <span class="se-badge se-badge-grade">${_seEsc(b._gradeAuto || '-')}</span>
                    <span class="se-badge se-badge-region">${_seEsc(b._region || '-')}</span>
                    <span style="color:var(--text-muted);">vacancy ${vacCount}건</span>
                </div>
                ${memo ? `<div class="se-memo">📝 ${_seEsc(memo)}</div>` : ''}
            </div>
        </div>`;
    }).join('');
}

function _seRenderVacancyList() {
    const el = document.getElementById('se-vacancy-list');
    if (!el) return;

    const bid = _seState.selectedBuildingId;
    if (!bid) {
        el.innerHTML = `<div style="padding:40px 20px; text-align:center; color:var(--text-muted); font-size:13px;">
            좌측에서 빌딩을 선택하면<br>해당 빌딩의 임대안내문이 표시됩니다.
        </div>`;
        return;
    }

    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    if (!b) {
        el.innerHTML = `<div style="padding:40px 20px; text-align:center; color:var(--danger);">빌딩을 찾을 수 없습니다.</div>`;
        return;
    }

    const vacancies = srActiveVacancies(b);
    if (vacancies.length === 0) {
        el.innerHTML = `<div style="padding:40px 20px; text-align:center; color:var(--text-muted); font-size:13px;">
            이 빌딩의 활성 임대안내문이 없습니다.
        </div>`;
        return;
    }

    // publishDate 내림차순
    const sorted = [...vacancies].sort((a, v2) => {
        const da = srNormalizeDate(a.publishDate || '');
        const db = srNormalizeDate(v2.publishDate || '');
        return (db || '').localeCompare(da || '');
    });

    const bldgName = _seEsc(b.name || b.buildingName || '');

    el.innerHTML = `
        <div style="padding:10px 14px; background:var(--bg-secondary); border-radius:6px;
                    font-size:12px; font-weight:600; color:var(--text-primary); margin-bottom:8px;">
            🏢 ${bldgName}
            <span style="font-size:11px; font-weight:400; color:var(--text-muted); margin-left:6px;">
                임대안내문 ${vacancies.length}건
            </span>
        </div>
        ${sorted.map(v => {
            const vkey = v._key || '';
            const combinedKey = _seMakeVacKey(bid, vkey);
            const isExcluded = _seState.excludedVacancies.has(combinedKey);
            const memo = isExcluded ? _seState.excludedVacancies.get(combinedKey).memo || '' : '';
            const areaPy = srVacancyAreaPy(v);
            // FIX (Phase 2): vacancy 필드명 확정 — portal.html 3615~3617 라인 기준
            //   source (기업명), publishDate (YYYY-MM), floor
            const date   = v.publishDate || '-';
            const source = v.source || v.sourceCompany || '-';
            const floor  = v.floor || v.floors || '-';

            return `<div class="se-vac-row${isExcluded ? ' se-vac-excluded' : ''}">
                <input type="checkbox" class="se-vac-cb"
                    ${!isExcluded ? 'checked' : ''}
                    onchange="_seToggleVacancy('${_seEsc(bid)}', '${_seEsc(vkey)}', this.checked)">
                <div class="se-vac-info">
                    <div class="se-vac-top">
                        <span class="se-badge se-badge-date">${_seEsc(date)}</span>
                        <span style="color:var(--text-primary); font-weight:600;">${_seEsc(source)}</span>
                        <span style="color:var(--text-muted);">${_seEsc(floor)}층</span>
                    </div>
                    <div class="se-vac-meta">면적: ${areaPy.toFixed(1)}평</div>
                    ${memo ? `<div class="se-memo">📝 ${_seEsc(memo)}</div>` : ''}
                </div>
            </div>`;
        }).join('')}
    `;
}

function _seRenderSelectionSummary() {
    const el = document.getElementById('se-selection-summary');
    if (!el) return;
    const nb = _seState.excludedBuildings.size;
    const nv = _seState.excludedVacancies.size;
    el.innerHTML = `
        제외된 빌딩: <b style="color:var(--danger);">${nb}</b>건 ·
        제외된 임대안내문: <b style="color:var(--danger);">${nv}</b>건
    `;
}

// ═══════════════════════════════════════════════════════════════
// 7. 사용자 인터랙션 핸들러 (window 노출)
// ═══════════════════════════════════════════════════════════════

window._seOnQuarterChange = async function() {
    const sel = document.getElementById('se-quarter');
    if (!sel) return;

    // Phase 3: 미저장 변경 있으면 경고
    if (_seState.dirty) {
        const ok = confirm(`저장되지 않은 변경 사항이 있습니다 (${_seState.quarter}).\n` +
                           `다른 분기로 전환하면 변경이 사라집니다.\n\n계속하시겠습니까?`);
        if (!ok) {
            // 셀렉트 원복
            sel.value = _seState.quarter;
            return;
        }
    }

    _seState.quarter = sel.value;
    _seState.selectedBuildingId = null;
    _seSetDirty(false);  // 새 분기 로드하므로 dirty 리셋
    await _seReloadAndRender();
};

window._seToggleFilter = function(type, value, checked) {
    const arr = _seState.filters[type];
    if (!Array.isArray(arr)) return;
    const idx = arr.indexOf(value);
    if (checked && idx < 0) arr.push(value);
    else if (!checked && idx >= 0) arr.splice(idx, 1);
    // Phase 3: 필터 변경 로그 + dirty
    _sePushActionLog('filter_change', `${type}:${value}`, value,
        `${type} ${checked ? '추가' : '제거'}: ${value}`);
    _seSetDirty(true);
    _seReloadLogPanelIfOpen();
    // 상위 필터가 바뀌면 세부권역 재계산 필요
    _seRenderFilters();
    _seRenderPipelineSummary();
    _seRenderBuildingList();
    _seRenderVacancyList();  // 선택 빌딩이 필터에서 빠지면 리스트 갱신
};

window._seToggleVacOnly = function(checked) {
    _seState.filters.vacOnly = !!checked;
    // Phase 3
    _sePushActionLog('filter_change', 'vacOnly', 'vacOnly',
        `공실정보 필터 ${checked ? 'ON' : 'OFF'}`);
    _seSetDirty(true);
    _seReloadLogPanelIfOpen();
    _seRenderPipelineSummary();
    _seRenderBuildingList();
    _seRenderVacancyList();
};

window._seOnSearch = function(val) {
    _seState.searchQuery = val || '';
    _seRenderBuildingList();
};

window._seSelectBuilding = function(bid) {
    _seState.selectedBuildingId = bid;
    _seRenderBuildingList();
    _seRenderVacancyList();
};

/** 빌딩 포함/제외 토글 */
window._seToggleBuilding = function(bid, includeChecked) {
    const user = _seGetCurrentUser();
    // 라벨용 빌딩명 추출
    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    const bName = (b && (b.name || b.buildingName)) || bid;

    if (includeChecked) {
        // 포함 → excludedBuildings 에서 제거
        _seState.excludedBuildings.delete(bid);
        // Phase 3: 개별 로그
        _sePushActionLog('add_building', bid, bName, '제외 해제');
    } else {
        // 제외 → 메모 프롬프트 (선택, ESC/취소 시 기본 메모)
        const memoIn = prompt('제외 사유 (선택, Enter로 건너뛰기):', '');
        const memo = (memoIn === null || memoIn.trim() === '')
            ? _seDefaultMemo(user)
            : memoIn.trim();
        _seState.excludedBuildings.set(bid, {
            memo,
            excludedAt: _seNow(),
            excludedBy: user,
        });
        // Phase 3: 개별 로그
        _sePushActionLog('remove_building', bid, bName, memo);
    }
    _seSetDirty(true);
    _seReloadLogPanelIfOpen();
    _seRenderPipelineSummary();
    _seRenderBuildingList();
    _seRenderSelectionSummary();
};

/** vacancy 포함/제외 토글 */
window._seToggleVacancy = function(bid, vkey, includeChecked) {
    const user = _seGetCurrentUser();
    const ck = _seMakeVacKey(bid, vkey);
    // 라벨용 vacancy 정보 추출
    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    const bName = (b && (b.name || b.buildingName)) || bid;
    let vLabel = `${bName} / ${vkey}`;
    if (b) {
        const v = (b.vacancies || []).find(x => x && x._key === vkey);
        if (v) {
            const src  = v.source || v.sourceCompany || '-';
            const date = v.publishDate || '-';
            const fl   = v.floor || v.floors || '-';
            vLabel = `${bName} / ${date} ${src} ${fl}층`;
        }
    }

    if (includeChecked) {
        _seState.excludedVacancies.delete(ck);
        _sePushActionLog('add_vacancy', ck, vLabel, '제외 해제');
    } else {
        const memoIn = prompt('제외 사유 (선택, Enter로 건너뛰기):', '');
        const memo = (memoIn === null || memoIn.trim() === '')
            ? _seDefaultMemo(user)
            : memoIn.trim();
        _seState.excludedVacancies.set(ck, {
            buildingId: bid,
            vacancyKey: vkey,
            memo,
            excludedAt: _seNow(),
            excludedBy: user,
        });
        _sePushActionLog('remove_vacancy', ck, vLabel, memo);
    }
    _seSetDirty(true);
    _seReloadLogPanelIfOpen();
    _seRenderVacancyList();
    _seRenderSelectionSummary();
};

/** 적용 버튼 */
window._seApply = async function() {
    const btn = document.getElementById('se-apply-btn');

    // Phase 2: 필터 설정이 있으면 전체 통계 영향 확인 프롬프트
    const f = _seState.filters;
    const hasFilter =
        (f.grades && f.grades.length > 0)
        || (f.regions && f.regions.length > 0)
        || (f.subRegions && f.subRegions.length > 0)
        || !f.vacOnly;  // 기본값 true 에서 벗어났으면
    const hasExclusion = _seState.excludedBuildings.size > 0 || _seState.excludedVacancies.size > 0;

    if (hasFilter) {
        const filterSummary = [
            (f.grades && f.grades.length > 0) ? `등급: ${f.grades.join(', ')}` : null,
            (f.regions && f.regions.length > 0) ? `권역: ${f.regions.join(', ')}` : null,
            (f.subRegions && f.subRegions.length > 0) ? `세부권역 ${f.subRegions.length}개` : null,
            !f.vacOnly ? '공실정보 없는 빌딩 포함' : null,
        ].filter(Boolean).join('\n  · ');
        const ok = confirm(
            `⚠️ 필터가 설정되어 있습니다:\n\n  · ${filterSummary}\n\n` +
            `이 필터는 통계 모달 전체 탭에 영구 적용됩니다.\n` +
            `(모든 사용자가 볼 때 동일한 필터 적용)\n\n계속하시겠습니까?`
        );
        if (!ok) return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = '저장 중...';
    }
    try {
        const res = await _seSaveStatsFilter();
        if (!res.ok) {
            alert(`❌ 저장 실패\n\n${res.reason}`);
            return;
        }
        // 통계 페이지에 즉시 반영
        if (typeof window._srApplyPersistentExclusions === 'function') {
            window._srApplyPersistentExclusions(
                new Set(_seState.excludedBuildings.keys()),
                new Set(_seState.excludedVacancies.keys()),
                _seState.filters
            );
        }
        const summary = `빌딩 ${_seState.excludedBuildings.size}건, 임대안내문 ${_seState.excludedVacancies.size}건 제외`;
        // Phase 3: 저장 성공 시 dirty 리셋 (closeStatsEditorModal 의 confirm 우회)
        _seSetDirty(false);
        alert(`✅ 적용 완료 (v${res.newVersion})\n\n${summary}`);
        // dirty=false 상태로 모달 닫기
        const modal = document.getElementById('stats-editor-modal');
        if (modal) modal.style.display = 'none';
        if (typeof window.refreshStatResearch === 'function') {
            window.refreshStatResearch();
        }
    } catch (err) {
        console.error('[StatsEditor] apply failed:', err);
        alert(`❌ 저장 중 오류: ${err.message}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            // dirty 상태면 적용 버튼 텍스트 유지
            if (_seState.dirty) {
                btn.textContent = '✓ 적용 (변경 있음)';
            } else {
                btn.textContent = '✓ 적용';
            }
        }
    }
};

/** 편집 이력 토글 */
const _SE_ACTION_LABEL = {
    'add_building':    '빌딩 포함',
    'remove_building': '빌딩 제외',
    'add_vacancy':     '공실 포함',
    'remove_vacancy':  '공실 제외',
    'filter_change':   '필터 변경',
    'bulk_apply':      '일괄 적용',
};
const _SE_ACTION_COLOR = {
    'add_building':    '#16a34a',
    'remove_building': '#dc2626',
    'add_vacancy':     '#16a34a',
    'remove_vacancy':  '#dc2626',
    'filter_change':   '#7c3aed',
    'bulk_apply':      '#1a73e8',
};

window._seToggleLog = async function() {
    const wrap = document.getElementById('se-log-wrap');
    const body = document.getElementById('se-log-body');
    if (!wrap || !body) return;
    _seLogExpanded = !_seLogExpanded;
    wrap.classList.toggle('se-log-open', _seLogExpanded);

    // Phase 3: 열 때마다 최신 로그 로드 (즉시 기록 정책이므로 캐시 무효)
    if (_seLogExpanded) {
        body.innerHTML = `<div style="padding:10px; color:var(--text-muted); font-size:12px;">로딩 중...</div>`;
        try {
            const logs = await _seLoadRecentLogs(_seState.quarter, 20);
            if (logs.length === 0) {
                body.innerHTML = `<div style="padding:10px; color:var(--text-muted); font-size:12px;">편집 이력 없음</div>`;
            } else {
                body.innerHTML = logs.map(l => {
                    const act = l.action || '-';
                    const label = _SE_ACTION_LABEL[act] || act;
                    const color = _SE_ACTION_COLOR[act] || '#64748b';
                    const ts = (l.ts || '').slice(0, 16).replace('T', ' ');
                    return `
                    <div class="se-log-row">
                        <span class="se-log-ts">${_seEsc(ts)}</span>
                        <span class="se-log-user">${_seEsc(l.user || '-')}</span>
                        <span class="se-log-action" style="color:${color};">${_seEsc(label)}</span>
                        <span class="se-log-memo">${_seEsc(l.targetLabel ? `${l.targetLabel} — ` : '')}${_seEsc(l.memo || '')}</span>
                    </div>`;
                }).join('');
            }
            body.dataset.loadedQuarter = _seState.quarter;
        } catch (err) {
            body.innerHTML = `<div style="padding:10px; color:var(--danger); font-size:12px;">이력 로드 실패: ${_seEsc(err.message)}</div>`;
        }
    }
};

// ═══════════════════════════════════════════════════════════════
// 8. portal-stats.js 와의 연동 인터페이스
// ═══════════════════════════════════════════════════════════════

/**
 * 통계 모달이 열릴 때(refreshStatResearch 등) 자동으로 현재 분기의 영구 제외를 로드.
 * portal-stats.js 의 openStatResearchModal 에서 호출.
 */
window._seAutoLoadForStats = async function() {
    const now = new Date();
    const curQ = `${now.getFullYear()}Q${Math.ceil((now.getMonth() + 1) / 3)}`;
    try {
        const { db, ref, get } = await import('./portal-firebase.js');
        const snap = await get(ref(db, `statsFilter/${curQ}`));
        const data = snap.exists() ? (snap.val() || {}) : {};
        // FIX (Phase 2): 데이터 없어도 상태 리셋 목적으로 호출 (이전 세션 잔존 제거)
        const excludedBuildings = new Set(Object.keys(data.excludedBuildings || {}));
        const excludedVacancies = new Set(Object.keys(data.excludedVacancies || {}));
        if (typeof window._srApplyPersistentExclusions === 'function') {
            window._srApplyPersistentExclusions(
                excludedBuildings,
                excludedVacancies,
                data.filters || null
            );
        }
    } catch (err) {
        console.warn('[StatsEditor] auto-load failed:', err);
    }
};

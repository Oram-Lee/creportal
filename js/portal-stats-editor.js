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
 *   1차: 전체 빌딩 (현재 admin-research 플래그 미주입 상태라 필터 걷어냄 — Line 372 참조)
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

    // Phase 4 (2026-04): 임대안내문 그룹(회사+발행월) 검증마크
    // key: `${bid}__${source}__${publishDate}` → { verifiedAt, verifiedBy }
    verifiedGuides: new Map(),

    // UI 상태
    selectedBuildingId:  null,       // 좌측에서 선택된 빌딩 (우측 vacancy 리스트 표시 대상)
    selectedSource:      null,       // Phase 4: 우측 회사 탭 선택 (null=첫번째 자동)
    selectedPublishDate: null,       // Phase 4: 우측 발행월 선택 (null=해당 source의 최신 자동)
    searchQuery:         '',

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

/**
 * Phase 4: 임대안내문 그룹 키 — buildingId + source + publishDate 조합.
 * Firebase 키 제약(공백/슬래시/따옴표) 회피용 sanitize 포함.
 */
function _seSanitizeKeyPart(s) {
    return String(s ?? '').replace(/[.#$\[\]\/\s'"`]/g, '_');
}
function _seMakeGuideKey(buildingId, source, publishDate) {
    return `${buildingId}__${_seSanitizeKeyPart(source)}__${_seSanitizeKeyPart(publishDate)}`;
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
        _seState.verifiedGuides.clear();  // Phase 4
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

    // Phase 4: 검증된 임대안내문
    _seState.verifiedGuides.clear();
    Object.entries(data.verifiedGuides || {}).forEach(([guideKey, v]) => {
        _seState.verifiedGuides.set(guideKey, v || {});
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
    // Phase 4: 검증된 임대안내문 그룹
    const verifiedGuidesObj = {};
    for (const [gk, v] of _seState.verifiedGuides.entries()) {
        verifiedGuidesObj[gk] = v;
    }

    const payload = {
        version:           newVersion,
        updatedAt:         now,
        updatedBy:         user,
        filters:           _seState.filters,
        excludedBuildings: excludedBuildingsObj,
        excludedVacancies: excludedVacanciesObj,
        verifiedGuides:    verifiedGuidesObj,  // Phase 4
    };

    // 3. /statsFilter/{quarter} 덮어쓰기
    await set(ref(db, `statsFilter/${quarter}`), payload);

    // 4. /statsFilterLogs 에 이력 추가
    const logEntry = {
        quarter,
        action:      'bulk_apply',
        targetId:    '',
        memo:        `v${_seState.version} → v${newVersion} 적용 (건물 제외 ${_seState.excludedBuildings.size}건, vacancy 제외 ${_seState.excludedVacancies.size}건, 검증 안내문 ${_seState.verifiedGuides.size}건)`,
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

    // 1차: 전체 빌딩 허용
    // ⚠️ 2026-04 현재 admin-research 파이프라인이 isResearchTarget / researchMatchStatus
    //    플래그를 데이터에 주입하기 전이라, 엄격 조건을 걸면 RAW=0 으로 막혀버림.
    //    admin-research 가 안정 주입하게 되면 아래 한 줄로 복원:
    //    const raw = norm.filter(b => b.isResearchTarget === true || b.researchMatchStatus);
    const raw = norm;

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
    // 1차 RAW 필터는 _seRunPipeline 과 동일 — 현재는 전체 허용
    const raw = srGetNormBuildings();
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

/**
 * Phase 4: 선택된 빌딩의 vacancy 를 (source, publishDate) 로 그룹핑하여 정리된 구조 반환.
 * @returns {{
 *   sourceStats: Array<{source:string, count:number, pdCount:number}>,  // 회사별 탭용
 *   pdsBySource: Map<string, string[]>,  // source → 발행월 내림차순 목록
 *   groups: Map<string, Array<vacancy>>, // `${source}__${pd}` → vacancy 목록
 * }}
 */
function _seBuildGuideIndex(building) {
    const vacs = srActiveVacancies(building);
    const bySrcPd  = new Map();   // "src__pd" → vacancy[]
    const pdsBySrc = new Map();   // src → Set<pd>
    const srcCount = new Map();   // src → count

    vacs.forEach(v => {
        const src = v.source || v.sourceCompany || '(미지정)';
        const pd  = v.publishDate || '(미기재)';
        const gk  = `${src}__${pd}`;
        if (!bySrcPd.has(gk))    bySrcPd.set(gk, []);
        bySrcPd.get(gk).push(v);
        if (!pdsBySrc.has(src))  pdsBySrc.set(src, new Set());
        pdsBySrc.get(src).add(pd);
        srcCount.set(src, (srcCount.get(src) || 0) + 1);
    });

    // 정렬: source 는 vacancy 많은 순, 발행월은 최신 내림차순
    const sourceStats = [...srcCount.entries()]
        .map(([source, count]) => ({
            source,
            count,
            pdCount: pdsBySrc.get(source)?.size || 0,
        }))
        .sort((a, b) => b.count - a.count);

    const pdsBySource = new Map();
    for (const [src, pdSet] of pdsBySrc.entries()) {
        const sorted = [...pdSet].sort((a, b) => {
            const da = srNormalizeDate(a === '(미기재)' ? '' : a);
            const db = srNormalizeDate(b === '(미기재)' ? '' : b);
            return (db || '').localeCompare(da || '');
        });
        pdsBySource.set(src, sorted);
    }

    return { sourceStats, pdsBySource, groups: bySrcPd };
}

/**
 * Phase 4: 그룹(source+publishDate)의 체크 상태 계산.
 * @returns {'all'|'partial'|'none'}
 */
function _seGroupCheckState(bid, vacs) {
    let inc = 0, exc = 0;
    vacs.forEach(v => {
        const ck = _seMakeVacKey(bid, v._key || '');
        if (_seState.excludedVacancies.has(ck)) exc++;
        else inc++;
    });
    if (exc === 0)               return 'all';
    if (inc === 0)               return 'none';
    return 'partial';
}

/** 숫자 천단위 포맷 (문자열/숫자 모두 허용) */
function _seFmtNum(v) {
    const n = parseFloat(String(v ?? '').replace(/,/g, ''));
    if (!Number.isFinite(n) || n === 0) return '-';
    return n.toLocaleString('ko-KR');
}

function _seRenderVacancyList() {
    const el = document.getElementById('se-vacancy-list');
    if (!el) return;

    const bid = _seState.selectedBuildingId;
    if (!bid) {
        el.innerHTML = `<div class="se-empty">
            좌측에서 빌딩을 선택하면<br>해당 빌딩의 임대안내문이 표시됩니다.
        </div>`;
        return;
    }

    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    if (!b) {
        el.innerHTML = `<div class="se-empty" style="color:var(--danger);">빌딩을 찾을 수 없습니다.</div>`;
        return;
    }

    const idx = _seBuildGuideIndex(b);
    if (idx.sourceStats.length === 0) {
        el.innerHTML = `<div class="se-empty">이 빌딩의 활성 임대안내문이 없습니다.</div>`;
        return;
    }

    // selectedSource 기본값: 첫 번째 (vacancy 가장 많은 회사)
    let curSrc = _seState.selectedSource;
    if (!curSrc || !idx.sourceStats.find(s => s.source === curSrc)) {
        curSrc = idx.sourceStats[0].source;
        _seState.selectedSource = curSrc;
    }
    const pds = idx.pdsBySource.get(curSrc) || [];

    // selectedPublishDate 기본값: 해당 source의 최신
    let curPd = _seState.selectedPublishDate;
    if (!curPd || !pds.includes(curPd)) {
        curPd = pds[0] || null;
        _seState.selectedPublishDate = curPd;
    }

    const bldgName  = _seEsc(b.name || b.buildingName || '');
    const totalVacs = idx.sourceStats.reduce((s, x) => s + x.count, 0);

    // ── 1. 헤더 (빌딩명 + 총 건수) ────────────────────
    const headerHtml = `
        <div class="se-bldg-title">
            <span>🏢 ${bldgName}</span>
            <span style="font-size:11px; font-weight:400; color:var(--text-muted);">
                총 임대안내문 ${totalVacs}건 · 회사 ${idx.sourceStats.length}곳
            </span>
        </div>`;

    // ── 2. 회사별 탭 ──────────────────────────────────
    const tabsHtml = `
        <div class="se-src-tabs">
            ${idx.sourceStats.map(s => `
                <button class="se-src-tab${s.source === curSrc ? ' se-src-tab-on' : ''}"
                        onclick="_seSelectSource('${_seEsc(s.source)}')">
                    ${_seEsc(s.source)}
                    <span class="se-src-tab-count">${s.count}</span>
                </button>
            `).join('')}
        </div>`;

    // ── 3. 발행월 셀렉트 ─────────────────────────────
    const pdSelectHtml = `
        <div class="se-pd-wrap">
            <span>📅 발행월</span>
            <select class="se-pd-select" onchange="_seSelectPublishDate(this.value)">
                ${pds.map(pd => `
                    <option value="${_seEsc(pd)}"${pd === curPd ? ' selected' : ''}>
                        ${_seEsc(pd)}
                    </option>
                `).join('')}
            </select>
            <span style="color:var(--text-muted); font-size:11px;">
                — ${_seEsc(curSrc)} 의 발행호 ${pds.length}건
            </span>
        </div>`;

    // ── 4. 현재 (source, pd) 그룹 카드 ────────────────
    const groupKey = `${curSrc}__${curPd}`;
    const groupVacs = idx.groups.get(groupKey) || [];
    const guideFbKey = _seMakeGuideKey(bid, curSrc, curPd);
    const isVerified = _seState.verifiedGuides.has(guideFbKey);
    const verInfo    = isVerified ? _seState.verifiedGuides.get(guideFbKey) : null;

    // 층 번호 기준 정렬 (숫자 추출 후 오름차순)
    const sortedVacs = [...groupVacs].sort((a, b) => {
        const na = parseInt(String(a.floor || a.floors || '').replace(/[^0-9-]/g, ''), 10) || 0;
        const nb = parseInt(String(b.floor || b.floors || '').replace(/[^0-9-]/g, ''), 10) || 0;
        return na - nb;
    });

    // 헤더 체크박스 3상태
    const groupState = _seGroupCheckState(bid, sortedVacs);

    const groupCardHtml = `
        <div class="se-guide-card${isVerified ? ' se-guide-verified' : ''}">
            <div class="se-guide-header">
                <input type="checkbox" class="se-group-cb"
                    ${groupState === 'all' ? 'checked' : ''}
                    ${groupState === 'partial' ? 'data-indeterminate="true"' : ''}
                    onchange="_seToggleGroupExclude('${_seEsc(bid)}', '${_seEsc(curSrc)}', '${_seEsc(curPd)}', this.checked)"
                    title="그룹 전체 체크/해제">
                <div class="se-guide-title">
                    <span>${_seEsc(curSrc)} · ${_seEsc(curPd)}</span>
                    <span style="font-size:11px; font-weight:400; color:var(--text-muted);">
                        공실 ${sortedVacs.length}건
                    </span>
                    ${isVerified ? `
                        <span class="se-guide-verify-badge" title="${_seEsc((verInfo?.verifiedAt || '').slice(0,10))} · ${_seEsc(verInfo?.verifiedBy || '')}">
                            ✓ 검증됨
                        </span>
                    ` : ''}
                </div>
                <div class="se-guide-actions">
                    <button class="se-guide-btn se-guide-btn-orig"
                            onclick="_seOpenGuidePreview('${_seEsc(bid)}', '${_seEsc(curSrc)}', '${_seEsc(curPd)}')"
                            title="OCR 추출 원본 이미지 (PDF→이미지)를 보며 검증">
                        🖼 원본보기
                    </button>
                    <button class="se-guide-btn se-guide-btn-verify${isVerified ? ' se-verified' : ''}"
                            onclick="_seToggleVerifyGuide('${_seEsc(bid)}', '${_seEsc(curSrc)}', '${_seEsc(curPd)}')"
                            title="원본과 대조 후 검증 완료 표시">
                        ${isVerified ? '✓ 검증됨' : '✓ 검증마크'}
                    </button>
                </div>
            </div>
            <table class="se-guide-table">
                <thead>
                    <tr>
                        <th style="width:32px;"></th>
                        <th>층</th>
                        <th>임대면적</th>
                        <th>전용면적</th>
                        <th>보증금/평</th>
                        <th>임대료/평</th>
                        <th>관리비/평</th>
                        <th>입주</th>
                    </tr>
                </thead>
                <tbody>
                    ${sortedVacs.map(v => {
                        const vkey = v._key || '';
                        const ck   = _seMakeVacKey(bid, vkey);
                        const exc  = _seState.excludedVacancies.has(ck);
                        const floor = v.floor || v.floors || '-';
                        const rA = v.rentArea || v.rentAreaPy || '';
                        const eA = v.exclusiveArea || v.exclusiveAreaPy || '';
                        return `<tr class="${exc ? 'se-vac-row-excluded' : ''}">
                            <td>
                                <input type="checkbox" class="se-vac-cell-cb"
                                    ${!exc ? 'checked' : ''}
                                    onchange="_seToggleVacancy('${_seEsc(bid)}', '${_seEsc(vkey)}', this.checked)">
                            </td>
                            <td>${_seEsc(floor)}${String(floor).match(/^\d+$/) ? 'F' : ''}</td>
                            <td>${_seFmtNum(rA)}${rA ? '평' : ''}</td>
                            <td>${_seFmtNum(eA)}${eA ? '평' : ''}</td>
                            <td>${_seFmtNum(v.depositPy)}</td>
                            <td>${_seFmtNum(v.rentPy)}</td>
                            <td>${_seFmtNum(v.maintenancePy)}</td>
                            <td>${_seEsc(v.moveInDate || '-')}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>`;

    el.innerHTML = headerHtml + tabsHtml + pdSelectHtml + groupCardHtml;

    // HTML attribute로는 indeterminate 직접 설정 불가 — DOM property로 후처리
    const grpCb = el.querySelector('.se-group-cb[data-indeterminate="true"]');
    if (grpCb) grpCb.indeterminate = true;
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
    // Phase 4: 빌딩 바뀔 때 탭/발행월 선택 리셋 — 첫번째 자동 선택되도록
    _seState.selectedSource      = null;
    _seState.selectedPublishDate = null;
    _seRenderBuildingList();
    _seRenderVacancyList();
};

// ─ Phase 4: 임대안내문 그룹 핸들러 ──────────────────────────

/** 회사 탭 전환 */
window._seSelectSource = function(source) {
    _seState.selectedSource      = source;
    _seState.selectedPublishDate = null;  // 회사 바뀌면 발행월도 리셋 (최신 자동)
    _seRenderVacancyList();
};

/** 발행월 전환 */
window._seSelectPublishDate = function(pd) {
    _seState.selectedPublishDate = pd;
    _seRenderVacancyList();
};

/**
 * 그룹(회사+발행월) 전체 체크/해제.
 * 개별 vacancy 로그 폭발 방지 위해 bulk_toggle_guide 단일 로그로 기록.
 */
window._seToggleGroupExclude = function(bid, source, pd, includeChecked) {
    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    if (!b) return;
    const vacs = srActiveVacancies(b).filter(v => {
        const vs = v.source || v.sourceCompany || '(미지정)';
        const vp = v.publishDate || '(미기재)';
        return vs === source && vp === pd;
    });
    if (vacs.length === 0) return;

    const user = _seGetCurrentUser();
    const now  = _seNow();
    const bName = (b.name || b.buildingName) || bid;
    const memo  = `${source} · ${pd} 그룹 ${includeChecked ? '전체 포함' : '전체 제외'} (${vacs.length}건)`;

    vacs.forEach(v => {
        const ck = _seMakeVacKey(bid, v._key || '');
        if (includeChecked) {
            _seState.excludedVacancies.delete(ck);
        } else {
            _seState.excludedVacancies.set(ck, {
                buildingId: bid,
                vacancyKey: v._key || '',
                memo,
                excludedAt: now,
                excludedBy: user,
            });
        }
    });

    _sePushActionLog('bulk_toggle_guide',
        _seMakeGuideKey(bid, source, pd),
        `${bName} / ${source} · ${pd}`,
        memo);
    _seSetDirty(true);
    _seReloadLogPanelIfOpen();
    _seRenderPipelineSummary();
    _seRenderVacancyList();
    _seRenderSelectionSummary();
};

/** 그룹 검증마크 토글 */
window._seToggleVerifyGuide = function(bid, source, pd) {
    const gk = _seMakeGuideKey(bid, source, pd);
    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    const bName = (b && (b.name || b.buildingName)) || bid;
    const label = `${bName} / ${source} · ${pd}`;

    if (_seState.verifiedGuides.has(gk)) {
        _seState.verifiedGuides.delete(gk);
        _sePushActionLog('unverify_guide', gk, label, '검증 해제');
    } else {
        _seState.verifiedGuides.set(gk, {
            verifiedAt: _seNow(),
            verifiedBy: _seGetCurrentUser(),
        });
        _sePushActionLog('verify_guide', gk, label, '원본 대조 후 검증 완료');
    }
    _seSetDirty(true);
    _seReloadLogPanelIfOpen();
    _seRenderVacancyList();
};

/**
 * Phase 4: 원본 OCR 이미지 프리뷰 모달 오픈.
 * vacancy 필드 `pageImageUrl` + `pageNum` 을 그대로 활용 (Firebase Storage 재호출 불필요).
 *
 * 데이터 흐름:
 *   해당 (bid, source, pd) 그룹의 vacancy → pageNum/pageImageUrl 중복 제거 + 오름차순 정렬
 *   → 좌측 페이지 리스트, 중앙 큰 이미지, 우측 해당 페이지의 vacancy 정보
 */
window._seOpenGuidePreview = function(bid, source, pd) {
    const modal = document.getElementById('se-guide-preview-modal');
    if (!modal) { console.warn('[StatsEditor] preview modal not found'); return; }
    // 상태 저장 (렌더 & 핸들러에서 사용)
    _sePreviewState.bid         = bid;
    _sePreviewState.source      = source;
    _sePreviewState.publishDate = pd;
    _sePreviewState.activePage  = null;  // 첫 페이지 자동선택
    _seRenderGuidePreview();
    modal.classList.add('show');
};

window._seCloseGuidePreview = function() {
    const modal = document.getElementById('se-guide-preview-modal');
    if (modal) modal.classList.remove('show');
};

/** 프리뷰 모달 전역 상태 */
const _sePreviewState = {
    bid:         null,
    source:      null,
    publishDate: null,
    activePage:  null,  // 현재 표시 중인 pageNum (또는 'unknown' — 페이지번호 없는 경우)
};

/**
 * Phase 4: 현재 그룹의 vacancy 들에서 고유 페이지 목록 추출.
 * @returns {Array<{pageNum:(number|'unknown'), pageImageUrl:string, vacancies:Array}>}
 */
function _seGetGroupPages(bid, source, pd) {
    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    if (!b) return [];
    const vacs = srActiveVacancies(b).filter(v => {
        const vs = v.source || v.sourceCompany || '(미지정)';
        const vp = v.publishDate || '(미기재)';
        return vs === source && vp === pd;
    });
    // pageNum 별 그룹핑 (같은 페이지에 여러 층 정보가 있을 수 있음)
    const byPage = new Map();
    vacs.forEach(v => {
        const pn  = (v.pageNum != null && v.pageNum !== '') ? v.pageNum : 'unknown';
        const url = v.pageImageUrl || '';
        if (!byPage.has(pn)) {
            byPage.set(pn, { pageNum: pn, pageImageUrl: url, vacancies: [] });
        }
        // 같은 페이지인데 URL 다를 수 있으면 첫 번째 non-empty 유지
        const entry = byPage.get(pn);
        if (!entry.pageImageUrl && url) entry.pageImageUrl = url;
        entry.vacancies.push(v);
    });
    // 오름차순 (unknown 은 맨 끝)
    const pages = [...byPage.values()].sort((a, b) => {
        if (a.pageNum === 'unknown') return 1;
        if (b.pageNum === 'unknown') return -1;
        return (parseInt(a.pageNum, 10) || 0) - (parseInt(b.pageNum, 10) || 0);
    });
    return pages;
}

/** 프리뷰 모달 전체 렌더 (페이지 리스트 + 중앙 이미지 + 우측 정보) */
function _seRenderGuidePreview() {
    const { bid, source, publishDate } = _sePreviewState;
    if (!bid || !source || !publishDate) return;

    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    const bldgName = (b && (b.name || b.buildingName)) || bid;
    const titleEl  = document.getElementById('se-gp-title');
    const subEl    = document.getElementById('se-gp-subtitle');
    if (titleEl) titleEl.textContent = `🖼 ${source} · ${publishDate} — ${bldgName}`;

    const pages = _seGetGroupPages(bid, source, publishDate);
    if (subEl) {
        subEl.textContent = pages.length > 0
            ? `${pages.length}개 페이지 · 공실 ${pages.reduce((s,p)=>s+p.vacancies.length,0)}건`
            : '이 그룹의 페이지 정보가 없습니다.';
    }

    // activePage 미설정이면 첫 페이지
    if (_sePreviewState.activePage == null && pages.length > 0) {
        _sePreviewState.activePage = pages[0].pageNum;
    }

    // 좌: 페이지 리스트
    const listEl = document.getElementById('se-gp-pagelist');
    if (listEl) {
        if (pages.length === 0) {
            listEl.innerHTML = `<div class="se-empty" style="padding:20px 8px;">페이지 정보 없음</div>`;
        } else {
            listEl.innerHTML = pages.map(p => {
                const on = (String(p.pageNum) === String(_sePreviewState.activePage)) ? ' se-gp-page-on' : '';
                const label = (p.pageNum === 'unknown') ? '페이지?' : `p.${p.pageNum}`;
                return `<button class="se-gp-page-btn${on}"
                    onclick="_seSelectPreviewPage('${_seEsc(p.pageNum)}')">
                    ${_seEsc(label)}
                    <div class="se-gp-page-btn-meta">공실 ${p.vacancies.length}건</div>
                </button>`;
            }).join('');
        }
    }

    // 현재 활성 페이지 정보
    const cur = pages.find(p => String(p.pageNum) === String(_sePreviewState.activePage))
             || pages[0];

    // 중: 이미지
    const imgSlot = document.getElementById('se-gp-imgslot');
    if (imgSlot) {
        if (!cur) {
            imgSlot.innerHTML = `<div style="color:#cbd5e1; font-size:13px;">표시할 페이지가 없습니다.</div>`;
        } else if (!cur.pageImageUrl) {
            imgSlot.innerHTML = `
                <div style="color:#fbbf24; text-align:center; padding:40px;">
                    ⚠️ 이 페이지의 이미지 URL이 없습니다.<br>
                    <span style="font-size:11px; opacity:0.7;">pageImageUrl 필드가 비어있어요.</span>
                </div>`;
        } else {
            imgSlot.innerHTML = `<img src="${_seEsc(cur.pageImageUrl)}" alt="page ${_seEsc(cur.pageNum)}"
                class="se-gp-img"
                onerror="this.outerHTML='<div style=&quot;color:#ef4444;padding:40px;text-align:center;&quot;>❌ 이미지 로드 실패<br><span style=&quot;font-size:11px;opacity:0.8;&quot;>URL은 있지만 Storage 권한이나 경로 오류</span></div>'">`;
        }
    }

    // 우: 해당 페이지의 vacancy 정보 + 검증 버튼
    const sideEl = document.getElementById('se-gp-sidebar');
    if (sideEl) {
        const gk = _seMakeGuideKey(bid, source, publishDate);
        const isVerified = _seState.verifiedGuides.has(gk);
        const verInfo    = isVerified ? _seState.verifiedGuides.get(gk) : null;

        const vacsHtml = cur ? cur.vacancies.map(v => {
            const ck = _seMakeVacKey(bid, v._key || '');
            const exc = _seState.excludedVacancies.has(ck);
            return `<div class="se-gp-vac-card${exc ? ' se-gp-vac-excluded' : ''}">
                <div class="se-gp-vac-head">${_seEsc(v.floor || v.floors || '?')}${String(v.floor||'').match(/^\d+$/) ? 'F' : ''} ${exc ? '· 제외됨' : ''}</div>
                <div class="se-gp-vac-row"><span>임대면적</span><span>${_seFmtNum(v.rentArea)}${v.rentArea ? '평' : ''}</span></div>
                <div class="se-gp-vac-row"><span>전용면적</span><span>${_seFmtNum(v.exclusiveArea)}${v.exclusiveArea ? '평' : ''}</span></div>
                <div class="se-gp-vac-row"><span>보증금/평</span><span>${_seFmtNum(v.depositPy)}</span></div>
                <div class="se-gp-vac-row"><span>임대료/평</span><span>${_seFmtNum(v.rentPy)}</span></div>
                <div class="se-gp-vac-row"><span>관리비/평</span><span>${_seFmtNum(v.maintenancePy)}</span></div>
                <div class="se-gp-vac-row"><span>입주</span><span>${_seEsc(v.moveInDate || '-')}</span></div>
            </div>`;
        }).join('') : '';

        sideEl.innerHTML = `
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">
                📋 현재 페이지에 매핑된 공실
            </div>
            ${vacsHtml || '<div class="se-empty" style="padding:20px 8px;">없음</div>'}
            <div class="se-gp-verify-wrap">
                ${isVerified ? `
                    <div style="font-size:11px; color:#16a34a; margin-bottom:6px;">
                        ✓ ${_seEsc((verInfo?.verifiedAt || '').slice(0,10))} · ${_seEsc(verInfo?.verifiedBy || '')}
                    </div>
                ` : `
                    <div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">
                        원본과 대조 후 아래 버튼을 누르세요
                    </div>
                `}
                <button class="se-gp-verify-btn${isVerified ? ' se-verified' : ''}"
                        onclick="_seToggleVerifyGuide('${_seEsc(bid)}', '${_seEsc(source)}', '${_seEsc(publishDate)}'); _seRenderGuidePreview();">
                    ${isVerified ? '✓ 검증됨 (해제)' : '✓ 검증마크 찍기'}
                </button>
            </div>
        `;
    }
}

window._seSelectPreviewPage = function(pageNum) {
    _sePreviewState.activePage = pageNum;
    _seRenderGuidePreview();
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
    'add_building':      '빌딩 포함',
    'remove_building':   '빌딩 제외',
    'add_vacancy':       '공실 포함',
    'remove_vacancy':    '공실 제외',
    'filter_change':     '필터 변경',
    'bulk_apply':        '일괄 적용',
    // Phase 4: 임대안내문 그룹
    'verify_guide':      '안내문 검증',
    'unverify_guide':    '검증 해제',
    'bulk_toggle_guide': '그룹 일괄',
};
const _SE_ACTION_COLOR = {
    'add_building':      '#16a34a',
    'remove_building':   '#dc2626',
    'add_vacancy':       '#16a34a',
    'remove_vacancy':    '#dc2626',
    'filter_change':     '#7c3aed',
    'bulk_apply':        '#1a73e8',
    'verify_guide':      '#16a34a',
    'unverify_guide':    '#64748b',
    'bulk_toggle_guide': '#0891b2',
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

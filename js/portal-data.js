/**
 * CRE Portal - 데이터 로딩 및 처리
 * 
 * v2.1 수정사항 (2026-01-14):
 * - ★ 이미지 로드 경로 수정: b.exteriorImages || b.images?.exterior 모두 확인
 * - leasing-guide.html에서 저장한 이미지도 portal.html에서 표시 가능
 * 
 * v4.0 성능 최적화 (2026-02-04):
 * - ★ processBuildings() 인덱싱 최적화: O(n×m) → O(n+m)
 *   - 전체 컬렉션 반복 순회 제거, 사전 인덱스 기반 O(1) 룩업
 *   - 빌딩 300개 + 렌트롤 1000개 기준: 65만회 반복 → ~3000회로 축소
 * - ★ leasingGuides 인덱싱: 빌딩별 가이드 정보 사전 매핑
 * - ★ 성능 타이머 추가 (console에서 병목 확인 가능)
 *
 * v4.1 트래픽 최적화 (2026-09-06):
 * - leasingGuides 전량 로드(약 125MB) 제거 → 필요한 하위 경로만 조회(약 23MB)
 *   백업 실측 기준 노드 125.0MB 중 endingSettings가 101.3MB를 차지하나
 *   포털 코드는 이 필드를 한 번도 참조하지 않음. coverSettings도 동일.
 *   실제 사용 필드는 items(빌딩 매핑) 및 가이드 제목뿐임.
 * - 화면 동작·표시 결과는 기존과 동일. 내려받는 양만 줄인다.
 * - 조회 실패 시 기존 전량 로드로 자동 폴백하므로 기능 중단 위험 없음.
 */

import { state } from './portal-state.js';
import { db, ref, get, getShallow } from './portal-firebase.js';
import { showToast, detectRegion } from './portal-utils.js';

// ============================================================
// ★ v4.1: leasingGuides 경량 로더
//
// 포털이 leasingGuides에서 실제로 쓰는 값
//   processLeasingGuideBuildings() : tocItems[].buildingId / buildings[].buildingId
//   buildLeasingGuideIndex()       : items[].buildingId / .type
//                                    items[].selectedExternalVacancies
//                                    guide.name || guide.title
//   저장 여부 판정                  : status / savedAt / publishedAt / createdAt
//
// 반면 endingSettings·coverSettings는 임대안내문 편집·출력 화면 전용이며
// 포털 코드에서 참조되지 않는다. 두 필드가 노드 용량의 대부분을 차지한다.
//
// 따라서 루트 전량 조회 대신
//   1) shallow 조회로 가이드 키 목록 확보
//   2) 가이드별 shallow 조회로 스칼라 메타 확보 + 객체 필드 존재 여부 판별
//   3) 필요한 객체 필드(items / tocItems / buildings)만 개별 조회
// 순으로 받는다. 반환 형태는 기존 전량 조회 결과와 동일한 { guideId: guide } 맵이므로
// 호출부 이후 로직은 수정할 필요가 없다.
// ============================================================

// 포털이 필요로 하는 객체형 필드. 여기에 없는 객체 필드는 내려받지 않는다.
const LG_OBJECT_FIELDS = ['items', 'tocItems', 'buildings'];

async function loadOneGuideLite(guideId) {
    try {
        const metaSnap = await getShallow(ref(db, `leasingGuides/${guideId}`));
        const meta = metaSnap.val();

        // shallow 응답이 객체가 아니면 판별 불가 → 해당 건만 전량 조회
        if (!meta || typeof meta !== 'object') {
            const full = await get(ref(db, `leasingGuides/${guideId}`));
            return [guideId, full.val()];
        }

        const guide = {};

        // shallow는 스칼라 필드를 값 그대로 돌려준다 (객체·배열 필드는 true).
        // status·title·createdAt 등 메타는 추가 요청 없이 여기서 확보된다.
        Object.entries(meta).forEach(([k, v]) => {
            if (v !== true) guide[k] = v;
        });

        // 객체 필드는 실제 존재하는 것만 골라서 조회
        const need = LG_OBJECT_FIELDS.filter(f => meta[f] === true);
        if (need.length) {
            const got = await Promise.all(
                need.map(f => get(ref(db, `leasingGuides/${guideId}/${f}`)))
            );
            need.forEach((f, i) => { guide[f] = got[i].val(); });
        }

        return [guideId, guide];
    } catch (e) {
        console.warn(`[leasingGuides/${guideId}] 경량 조회 실패 → 단건 전량 조회`, e);
        try {
            const full = await get(ref(db, `leasingGuides/${guideId}`));
            return [guideId, full.val()];
        } catch (e2) {
            console.error(`[leasingGuides/${guideId}] 단건 조회도 실패`, e2);
            return [guideId, null];
        }
    }
}

async function loadLeasingGuidesLite() {
    const t0 = performance.now();
    try {
        const keysSnap = await getShallow(ref(db, 'leasingGuides'));
        const keysVal = keysSnap.val();
        if (!keysVal || typeof keysVal !== 'object') return {};

        const keys = Object.keys(keysVal);
        if (!keys.length) return {};

        const entries = await Promise.all(keys.map(k => loadOneGuideLite(k)));
        const out = {};
        entries.forEach(([k, v]) => { if (v) out[k] = v; });

        console.log(
            `  🪶 leasingGuides 경량 로드: ${Object.keys(out).length}/${keys.length}건 · ` +
            `${Math.round(performance.now() - t0)}ms`
        );
        return out;
    } catch (e) {
        console.warn('[leasingGuides] 경량 로드 실패 → 전량 로드로 폴백', e);
        const snap = await get(ref(db, 'leasingGuides'));
        return snap.val() || {};
    }
}

// 데이터 로드
export async function loadData() {
    try {
        const t0 = performance.now();
        
        // ★ 마이그레이션 후: vacancies 독립 컬렉션 추가 로드
        const [b, r, m, i, mg, docs, u, lg, vac] = await Promise.all([
            get(ref(db, 'buildings')),
            get(ref(db, 'rentrolls')),
            get(ref(db, 'memos')),
            get(ref(db, 'incentives')),
            get(ref(db, 'managements')),
            get(ref(db, 'documents')),
            get(ref(db, 'users')),
            loadLeasingGuidesLite(),   // ★ v4.1: 전량 조회 → 필요한 하위 경로만
            get(ref(db, 'vacancies'))  // ★ 독립 컬렉션
        ]);
        
        const t1 = performance.now();
        console.log(`  📡 Firebase 9개 컬렉션 다운로드: ${Math.round(t1 - t0)}ms`);
        
        state.dataCache = {
            buildings: b.val() || {},
            rentrolls: r.val() || {},
            memos: m.val() || {},
            incentives: i.val() || {},
            managements: mg.val() || {},
            documents: docs.val() || {},
            users: u.val() || {},
            leasingGuides: lg || {},   // ★ v4.1: 경량 로더는 스냅샷이 아닌 맵을 반환
            vacancies: vac.val() || {}  // ★ 독립 컬렉션
        };
        
        console.log(`vacancies 컬렉션: ${Object.keys(state.dataCache.vacancies).length}개 빌딩`);
        
        const t2 = performance.now();
        processBuildings();
        const t3 = performance.now();
        console.log(`  ⚙️ processBuildings(): ${Math.round(t3 - t2)}ms (${state.allBuildings.length}개 빌딩)`);
        
        processLeasingGuideBuildings();
        
        // 렌더링 함수들은 별도 모듈에서 import해서 호출
        if (window.renderBuildingList) window.renderBuildingList();
        if (state.currentViewMode === 'list' && window.renderTableView) {
            window.renderTableView();
        }
        
        // 지도 마커 업데이트
        if (state.kakaoMap && state.clusterer) {
            if (window.updateMapMarkers) window.updateMapMarkers();
        } else {
            setTimeout(() => {
                if (state.kakaoMap && state.clusterer && window.updateMapMarkers) {
                    window.updateMapMarkers();
                }
            }, 500);
        }
        
        const t4 = performance.now();
        console.log(`  🎨 렌더링 완료: ${Math.round(t4 - t3)}ms`);
        console.log(`  📊 총 loadData(): ${Math.round(t4 - t0)}ms`);
        
        showToast(`${state.allBuildings.length}개 빌딩 로드 완료`, 'success');
    } catch (e) {
        console.error(e);
        showToast('데이터 로드 실패', 'error');
    }
}

// ============================================================
// ★ 단계 로딩 (첫 화면 빠르게)
//   1단계: buildings + users 만 받아 리스트/클러스터 즉시 렌더
//   2단계: 나머지 7개 컬렉션(공실/렌트롤/메모/인센티브/관리/문서/안내문)을
//          백그라운드로 받아 재렌더 — 공실 배지·필터 등이 잠시 뒤 채워짐
// ============================================================
export async function loadDataProgressive() {
    try {
        const t0 = performance.now();
        // 1단계: 위치/리스트/클러스터에 필요한 최소 데이터만
        const [b, u] = await Promise.all([
            get(ref(db, 'buildings')),
            get(ref(db, 'users'))
        ]);
        state.dataCache = {
            buildings: b.val() || {},
            users: u.val() || {},
            // 나머지는 빈 객체로 채워 processBuildings가 안전하게 동작 (2단계에서 교체)
            rentrolls: {}, memos: {}, incentives: {}, managements: {},
            documents: {}, leasingGuides: {}, vacancies: {}
        };
        processBuildings();
        processLeasingGuideBuildings();
        if (window.renderBuildingList) window.renderBuildingList();
        if (state.currentViewMode === 'list' && window.renderTableView) window.renderTableView();
        if (state.kakaoMap && state.clusterer) {
            if (window.updateMapMarkers) window.updateMapMarkers();
        } else {
            setTimeout(() => {
                if (state.kakaoMap && state.clusterer && window.updateMapMarkers) window.updateMapMarkers();
            }, 500);
        }
        const t1 = performance.now();
        console.log(`  ⚡ 1단계(빌딩 ${state.allBuildings.length}개) 첫 렌더: ${Math.round(t1 - t0)}ms`);
        showToast(`빌딩 ${state.allBuildings.length}개 로드 · 상세 데이터 불러오는 중…`, 'info');

        // 2단계: 나머지 컬렉션 백그라운드 로딩 (await 안 함)
        loadRemainingData();
    } catch (e) {
        console.error('1단계 로드 실패 → 전체 로드로 폴백:', e);
        return loadData();
    }
}

// 2단계: 나머지 컬렉션을 받아 dataCache 채우고 재렌더
async function loadRemainingData() {
    try {
        const t0 = performance.now();
        const [r, m, i, mg, docs, lg, vac] = await Promise.all([
            get(ref(db, 'rentrolls')),
            get(ref(db, 'memos')),
            get(ref(db, 'incentives')),
            get(ref(db, 'managements')),
            get(ref(db, 'documents')),
            loadLeasingGuidesLite(),   // ★ v4.1: 전량 조회 → 필요한 하위 경로만
            get(ref(db, 'vacancies'))
        ]);
        state.dataCache.rentrolls = r.val() || {};
        state.dataCache.memos = m.val() || {};
        state.dataCache.incentives = i.val() || {};
        state.dataCache.managements = mg.val() || {};
        state.dataCache.documents = docs.val() || {};
        state.dataCache.leasingGuides = lg || {};   // ★ v4.1: 경량 로더 반환값
        state.dataCache.vacancies = vac.val() || {};

        processBuildings();
        processLeasingGuideBuildings();

        // ★ v4.3: processBuildings()가 allBuildings를 새 객체로 다시 만들므로
        // viewport 탭이 들고 있던 1단계 객체 참조는 낡은 상태가 된다.
        // 지도영역 탭이면 viewport를 재계산해서 갱신한다.
        if (state.currentListTab === 'viewport' && window.updateViewportBuildings) {
            window.updateViewportBuildings();
        } else {
            if (window.renderBuildingList) window.renderBuildingList();
            if (state.currentViewMode === 'list' && window.renderTableView) window.renderTableView();
            if (state.kakaoMap && state.clusterer && window.updateMapMarkers) window.updateMapMarkers();
        }

        // 1단계 도중 상세를 이미 연 경우, 최신 데이터로 다시 렌더
        if (state.selectedBuilding && window.openDetail) {
            window.openDetail(state.selectedBuilding.id);
        }
        const t1 = performance.now();
        console.log(`  📦 2단계(나머지 7개 컬렉션) 로드+재렌더: ${Math.round(t1 - t0)}ms`);
        showToast('전체 데이터 로드 완료', 'success');
    } catch (e) {
        console.error('2단계(나머지) 로드 실패:', e);
        showToast('상세 데이터 로드 실패 — 새로고침 해주세요', 'error');
    }
}

// 임대안내문 포함 빌딩 목록 처리
// ★ 정식 프로세스: leasingGuides 컬렉션에 최종 저장된 임대안내문의 빌딩만 포함
export function processLeasingGuideBuildings() {
    state.leasingGuideBuildings = new Set();
    
    // ★ leasingGuides 컬렉션에서 최종 저장된 임대안내문의 빌딩만 추출
    const guides = state.dataCache.leasingGuides || {};
    
    Object.values(guides).forEach(guide => {
        // 최종 저장된 임대안내문만 (status가 'published' 또는 'saved', 또는 savedAt이 있는 경우)
        const isSaved = guide.status === 'published' || 
                        guide.status === 'saved' || 
                        guide.savedAt || 
                        guide.publishedAt ||
                        guide.createdAt;  // createdAt이 있으면 저장된 것으로 간주
        
        if (!isSaved) return;
        
        // tocItems에서 빌딩 ID 추출
        if (guide.tocItems && Array.isArray(guide.tocItems)) {
            guide.tocItems.forEach(item => {
                if (item.type === 'building' && item.buildingId) {
                    state.leasingGuideBuildings.add(item.buildingId);
                }
            });
        }
        
        // buildings 배열에서도 추출 (다른 구조일 경우)
        if (guide.buildings && Array.isArray(guide.buildings)) {
            guide.buildings.forEach(b => {
                if (b.buildingId) {
                    state.leasingGuideBuildings.add(b.buildingId);
                } else if (b.id) {
                    state.leasingGuideBuildings.add(b.id);
                }
            });
        }
    });
    
    console.log(`임대안내문 포함 빌딩: ${state.leasingGuideBuildings.size}개 (leasingGuides 기반)`);
}

// ============================================================
// ★ v4.0: 인덱스 빌더 — 컬렉션을 키별로 사전 인덱싱
// buildingId / buildingName 두 키로 모두 인덱싱하여 O(1) 룩업 지원
// ============================================================

/**
 * 컬렉션 항목들을 buildingId와 buildingName 기준으로 인덱싱
 * @param {Object} collection - Firebase에서 가져온 raw 컬렉션 { key: item, ... }
 * @returns {{ byId: Map, byName: Map }}
 *   byId: buildingId → [{ ...item, id: key }, ...]
 *   byName: buildingName → [{ ...item, id: key }, ...]
 */
function buildIndex(collection) {
    const byId = new Map();
    const byName = new Map();
    
    Object.entries(collection).forEach(([key, item]) => {
        if (key === '_schema') return;
        const entry = { ...item, id: key };
        
        // buildingId 기준 인덱싱
        if (item.buildingId) {
            const bid = String(item.buildingId);
            if (!byId.has(bid)) byId.set(bid, []);
            byId.get(bid).push(entry);
        }
        
        // buildingName 기준 인덱싱 (buildingId와 다른 경우만)
        if (item.buildingName && item.buildingName !== item.buildingId) {
            const bname = item.buildingName;
            if (!byName.has(bname)) byName.set(bname, []);
            byName.get(bname).push(entry);
        }
    });
    
    return { byId, byName };
}

/**
 * 인덱스에서 특정 빌딩에 해당하는 항목들을 조회
 * 중복 제거를 위해 id 기준 Set 사용
 * @param {{ byId: Map, byName: Map }} index
 * @param {string} id - 빌딩 ID
 * @param {string} name - 빌딩 이름
 * @param {string} [originalId] - 원본 ID (렌트롤 매칭용)
 * @returns {Array}
 */
function lookupIndex(index, id, name, originalId) {
    const seen = new Set();
    const results = [];
    
    // 조회 키 목록: id, name, originalId (존재하는 경우)
    const keys = [id, name];
    if (originalId && String(originalId) !== id) {
        keys.push(String(originalId));
    }
    
    for (const key of keys) {
        if (!key) continue;
        
        // byId에서 검색
        const byIdItems = index.byId.get(key);
        if (byIdItems) {
            for (const item of byIdItems) {
                if (!seen.has(item.id)) {
                    seen.add(item.id);
                    results.push(item);
                }
            }
        }
        
        // byName에서 검색
        const byNameItems = index.byName.get(key);
        if (byNameItems) {
            for (const item of byNameItems) {
                if (!seen.has(item.id)) {
                    seen.add(item.id);
                    results.push(item);
                }
            }
        }
    }
    
    return results;
}

/**
 * 인덱스에서 첫 번째 매칭 항목 조회 (managements용 - find 패턴)
 */
function lookupFirst(index, id, name) {
    const keys = [id, name];
    for (const key of keys) {
        if (!key) continue;
        const byIdItems = index.byId.get(key);
        if (byIdItems && byIdItems.length > 0) return byIdItems[0];
        const byNameItems = index.byName.get(key);
        if (byNameItems && byNameItems.length > 0) return byNameItems[0];
    }
    return undefined;
}

// ============================================================
// ★ v4.0: leasingGuides 빌딩별 인덱스 빌드
// ============================================================
function buildLeasingGuideIndex(leasingGuides) {
    // buildingId → { guideId, guideName, item, vacancies }
    const index = new Map();
    
    Object.entries(leasingGuides || {}).forEach(([guideId, guide]) => {
        const items = guide.items || guide.tocItems || [];
        items.forEach(item => {
            if (item.buildingId && item.type === 'building') {
                // 마지막 매칭이 우선 (기존 로직과 동일 — forEach 마지막 값이 남음)
                const info = {
                    guideId,
                    guideName: guide.name || guide.title,
                    ...item
                };
                let vacancies = [];
                if (item.selectedExternalVacancies && Array.isArray(item.selectedExternalVacancies)) {
                    vacancies = item.selectedExternalVacancies;
                }
                index.set(item.buildingId, { info, vacancies });
            }
        });
    });
    
    return index;
}

// ============================================================
// 빌딩 데이터 처리 (★ v4.0 인덱싱 최적화 버전)
// ============================================================
export function processBuildings() {
    const { dataCache, currentUser } = state;
    
    // ★ v4.0: 사전 인덱스 구축 (1회, O(m))
    const rentrollIdx = buildIndex(dataCache.rentrolls);
    const memoIdx = buildIndex(dataCache.memos);
    const incentiveIdx = buildIndex(dataCache.incentives);
    const mgmtIdx = buildIndex(dataCache.managements);
    const docIdx = buildIndex(dataCache.documents);
    const lgIdx = buildLeasingGuideIndex(dataCache.leasingGuides);
    
    state.allBuildings = Object.entries(dataCache.buildings)
        .filter(([k]) => k !== '_schema')
        .map(([id, b]) => {
            // ★ v4.0: 인덱스 기반 O(1) 룩업 — 기존 O(m) 전체 순회 제거
            const rentrolls = lookupIndex(rentrollIdx, id, b.name, b.originalId);
            const memos = lookupIndex(memoIdx, id, b.name);
            const incentives = lookupIndex(incentiveIdx, id, b.name);
            const mgmt = lookupFirst(mgmtIdx, id, b.name);
            const docs = lookupIndex(docIdx, id, b.name);
            
            // ★ v4.0: leasingGuides 인덱스 기반 룩업
            const lgData = lgIdx.get(id);
            const leasingGuideVacancies = lgData ? lgData.vacancies : [];
            const leasingGuideInfo = lgData ? lgData.info : null;

            // ★ 공실 목록 - 마이그레이션 후 변경
            // 우선순위 1: 독립 vacancies 컬렉션 (vacancies/{buildingId}/{vacancyId})
            // 우선순위 2: 기존 buildings 내부 (하위호환)
            let vacancies = [];
            const vacanciesForBuilding = dataCache.vacancies?.[id];
            if (vacanciesForBuilding && typeof vacanciesForBuilding === 'object') {
                vacancies = Object.entries(vacanciesForBuilding).map(([key, v]) => ({ ...v, _key: key }));
            } else if (b.vacancies) {
                vacancies = Object.entries(b.vacancies).map(([key, v]) => ({ ...v, _key: key }));
            }
            
            // 문서 그룹핑 (출처+발행일)
            const documents = buildDocuments(vacancies, docs);

            return {
                id,
                name: b.name || b.buildingName || b.bldNm || '',
                address: b.address,
                addressJibun: b.addressJibun,
                region: b.region || b.regionId || detectRegion(b.address),
                lat: b.coordinates?.lat,
                lng: b.coordinates?.lng,
                
                // ★ area 객체 전체 (건축물대장 갱신용)
                area: b.area,
                // 면적 (개별 필드 - 하위 호환)
                grossFloorPy: b.area?.grossFloorPy || b.grossFloorPy,
                grossFloorSqm: b.area?.grossFloorSqm || b.grossFloorSqm,
                typicalFloorPy: b.area?.typicalFloorPy || b.typicalFloorPy,
                typicalFloorSqm: b.area?.typicalFloorSqm || b.typicalFloorSqm,
                typicalFloorLeasePy: b.area?.typicalFloorLeasePy || b.typicalFloorLeasePy,
                typicalExclusivePy: b.area?.typicalExclusivePy || b.typicalExclusivePy,
                exclusiveRate: b.area?.exclusiveRate || b.exclusiveRate,
                landArea: b.area?.landArea || b.landArea,
                buildingArea: b.area?.buildingArea || b.buildingArea,
                
                // ★ pricing 객체 전체 (편집 모달용)
                pricing: b.pricing,
                // 가격 (개별 필드 - 하위 호환, nested + flat fallback, ?? 사용으로 0 보존)
                rent: b.pricing?.rent ?? b.rent,
                rentPy: b.pricing?.rentPy ?? b.rentPy,
                maintenance: b.pricing?.maintenance ?? b.maintenance,
                maintenancePy: b.pricing?.maintenancePy ?? b.maintenancePy,
                deposit: b.pricing?.deposit ?? b.deposit,
                depositPy: b.pricing?.depositPy ?? b.depositPy,
                
                // ★ specs 객체 전체 (건축물대장 갱신용)
                specs: b.specs,
                // 스펙 (개별 필드 - 하위 호환, 루트 레벨 우선)
                completionYear: b.completionYear || b.specs?.completionYear,
                completionDate: b.completionDate || b.specs?.completionDate,
                structure: b.specs?.structure || b.structure,
                elevator: b.specs?.elevator || b.elevator,
                passengerElevator: b.specs?.passengerElevator || b.passengerElevator,
                freightElevator: b.specs?.freightElevator || b.freightElevator,
                hvac: b.specs?.hvac || b.hvac,
                ceilingHeight: b.specs?.ceilingHeight || b.ceilingHeight,
                floorLoad: b.specs?.floorLoad || b.floorLoad,
                buildingUse: b.specs?.buildingUse || b.buildingUse,
                
                // ★ floors 객체 전체 (건축물대장 갱신용)
                floors: b.floors,
                // 층수 (개별 필드 - 하위 호환)
                floorsAbove: b.floors?.above || b.floorsAbove,
                floorsBelow: b.floors?.below || b.floorsBelow,
                floorAbove: b.floors?.above || b.floorsAbove,
                floorBelow: b.floors?.below || b.floorsBelow,
                
                // 위치
                nearbyStation: b.nearbyStation,
                nearestStation: b.nearbyStation,
                stationDistance: b.stationDistance,
                
                // ★ parking 객체 전체
                parking: b.parking,
                // 주차 (개별 필드 - 하위 호환)
                parkingTotal: b.parking?.total || b.parkingTotal,
                parkingRatio: b.parking?.ratio || b.parkingRatio,
                
                // ★ 건축물대장 추가 필드 (루트 레벨)
                vlRat: b.vlRat,
                bcRat: b.bcRat,
                mainPurpose: b.mainPurpose || b.specs?.buildingUse || b.buildingUse,
                
                // ★ 주차 표시 (편집 모달용)
                parkingDisplay: b.parking?.display || b.parkingDisplay || '',
                
                // 기타
                buildingType: b.buildingType,
                grade: b.grade,
                owner: b.owner,
                developer: b.developer,
                pm: b.pm,
                description: b.description,
                url: b.url,
                homepage: b.homepage || b.url || '',
                
                // ★ 편집 모달용 추가 필드
                aliases: b.aliases || [],
                buildingInfo: b.buildingInfo || {},
                strctCdNm: b.strctCdNm || b.buildingInfo?.strctCdNm || '',
                
                // ★ 채권분석 필드
                bondStatus: b.bondStatus || '',
                jointCollateral: b.jointCollateral || '',
                seniorLien: b.seniorLien || '',
                collateralRatio: b.collateralRatio || '',
                officialLandPrice: b.officialLandPrice || '',
                landPriceApplied: b.landPriceApplied || '',
                
                // 신규 필드
                notes: b.notes || '',
                contactPoints: b.contactPoints || [],
                floorPricing: b.floorPricing || [],
                images: b.images || { exterior: [], floorPlan: [], lobby: [], facilities: [], etc: [] },
                
                // ★ 이미지 배열 변환 (portal-detail.js에서 {url: '...'} 형식 기대)
                // ★ v2.1: 두 경로 모두 확인 (b.exteriorImages || b.images.exterior)
                exteriorImages: (() => {
                    const imgs = b.exteriorImages || b.images?.exterior || [];
                    return imgs.map(img => typeof img === 'string' ? { url: img } : img);
                })(),
                floorPlanImages: (() => {
                    const imgs = b.floorPlanImages || b.images?.floorPlan || [];
                    return imgs.map(img => typeof img === 'string' ? { url: img } : img);
                })(),
                mainImageIndex: b.mainImageIndex || 0,
                
                // 빌딩 상태
                status: b.status || 'active',
                hiddenBy: b.hiddenBy || null,
                hiddenAt: b.hiddenAt || null,
                // 임대안내문 담당자
                assignedManager: b.assignedManager || null,
                managerHistory: b.managerHistory || [],
                // 원본 데이터
                _raw: b,
                // 관계 데이터
                vacancies,
                hasVacancy: vacancies.length > 0,
                rentrolls,
                rentrollCount: rentrolls.length,
                memos,
                memoCount: memos.length,
                incentives,
                hasIncentive: incentives.length > 0,
                management: mgmt,
                documents,
                // ★ v3.7: leasingGuides 컬렉션에서 가져온 임대안내문 데이터
                leasingGuideVacancies,
                leasingGuideInfo,
                hasLeasingGuide: leasingGuideVacancies.length > 0,
                hasDocument: documents.length > 0 || leasingGuideVacancies.length > 0,
                hasData: rentrolls.length > 0 || memos.length > 0 || incentives.length > 0 || vacancies.length > 0,
                // ★ 신규 빌딩 체크 — 등록 후 3일간 NEW 표시
                isNew: (() => {
                    const regAt = b.registeredAt || b.createdAt;
                    if (!regAt) return false;
                    const diff = Date.now() - new Date(regAt).getTime();
                    return diff < 3 * 24 * 60 * 60 * 1000; // 3일
                })(),
                registeredAt: b.registeredAt
            };
        })
        .filter(b => {
            if (b.status === 'deleted') return false;
            if (b.status === 'hidden') {
                return currentUser?.role === 'admin';
            }
            return true;
        })
        .sort((a, b) => {
            if (a.status === 'hidden' && b.status !== 'hidden') return 1;
            if (a.status !== 'hidden' && b.status === 'hidden') return -1;
            if (a.isNew && !b.isNew) return -1;
            if (!a.isNew && b.isNew) return 1;
            // ★ 기본 정렬: 면적(연면적) 내림차순
            const areaA = parseFloat(a.grossFloorPy) || 0;
            const areaB = parseFloat(b.grossFloorPy) || 0;
            return areaB - areaA || (a.name || '').localeCompare(b.name || '');
        });
    
    state.filteredBuildings = [...state.allBuildings];
    
    // ★ v4.0: processBuildings 후 selectedBuilding 자동 재연결
    // CRUD 후 processBuildings()가 새 객체 배열을 생성하면
    // selectedBuilding이 이전 객체를 가리키는 문제를 해결
    if (state.selectedBuilding) {
        const updatedBuilding = state.allBuildings.find(b => b.id === state.selectedBuilding.id);
        if (updatedBuilding) {
            state.selectedBuilding = updatedBuilding;
        }
    }
}

// 문서 그룹핑 헬퍼
function buildDocuments(vacancies, externalDocs) {
    const docMap = {};
    
    vacancies.forEach(v => {
        const source = v.source || '';
        const publishDate = v.publishDate || '';
        if (!source && !publishDate) return;
        
        const key = `${source}_${publishDate}`;
        if (!docMap[key]) {
            docMap[key] = {
                source,
                publishDate,
                pageNum: v.pageNum || v.page || 0,
                pageImageUrl: v.pageImageUrl || '',
                pdfUrl: v.pdfUrl || '',
                vacancyCount: 0,
                floors: []
            };
        }
        docMap[key].vacancyCount++;
        if (v.floor) docMap[key].floors.push(v.floor);
        if (v.pageImageUrl && !docMap[key].pageImageUrl) {
            docMap[key].pageImageUrl = v.pageImageUrl;
        }
        if (v.pageNum && !docMap[key].pageNum) {
            docMap[key].pageNum = v.pageNum;
        }
    });
    
    externalDocs.forEach(d => {
        const key = `${d.source || ''}_${d.publishDate || ''}`;
        if (!docMap[key]) {
            docMap[key] = {
                source: d.source || '',
                publishDate: d.publishDate || '',
                pageNum: d.pageNum || d.page || 0,
                pageImageUrl: d.pageImageUrl || '',
                pdfUrl: d.pdfUrl || '',
                vacancyCount: 0,
                floors: []
            };
        } else {
            if (d.pageImageUrl) docMap[key].pageImageUrl = d.pageImageUrl;
            if (d.pdfUrl) docMap[key].pdfUrl = d.pdfUrl;
            if (d.pageNum) docMap[key].pageNum = d.pageNum;
        }
    });
    
    return Object.values(docMap).sort((a, b) => 
        (b.publishDate || '').localeCompare(a.publishDate || '')
    );
}

// window에 등록
window.loadData = loadData;
window.loadDataProgressive = loadDataProgressive;

/**
 * portal-merge.js — #13 동일주소 빌딩 통합 + 태그화
 * 
 * 기능:
 * 1. 중복 빌딩 탐지 (주소 기반 + 이름 유사도)
 * 2. 통합(병합) UI — 필드별 선택, 데이터 이관
 * 3. aliases 관리 — OCR 매칭 정확도 향상
 * 
 * v1.1 수정사항 (2026-02-10):
 * - ★ Firebase Modular SDK 호환: firebase.database() → portal-firebase.js 동적 import
 */

// ============================================================
// Firebase 참조 헬퍼 (Modular SDK 대응)
// ============================================================
async function getMergeFirebaseRefs() {
    const mod = await import('./portal-firebase.js');
    return {
        db: mod.db,
        ref: mod.ref,
        get: mod.get,
        set: mod.set,
        update: mod.update,
        remove: mod.remove,
        push: mod.push
    };
}

// ============================================================
// 주소 정규화 유틸 (admin-leasing.html과 동일 로직 공유)
// ============================================================

function mergeNormalizeAddress(address) {
    if (!address) return '';
    let n = address.trim();
    n = n.replace(/서울특별시/g, '서울').replace(/서울시/g, '서울');
    n = n.replace(/경기도\s*/g, '').replace(/인천광역시/g, '인천');
    n = n.replace(/\s*\([^)]*\)/g, '');
    n = n.replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim();
    return n;
}

/**
 * ★ v1.2: 주소에서 "구 + 도로명/동 + 번지"까지 포함한 정밀 키 추출
 * 번지 번호까지 포함해야 같은 도로 위의 다른 빌딩을 구분 가능
 * 반환 예: "강남구 논현로85길 22", "강남구 역삼동 737-7"
 */
function mergeExtractAddressKey(address) {
    if (!address || address.trim().length < 4) return '';
    const normalized = mergeNormalizeAddress(address);

    const guMatch = normalized.match(/([가-힣]+구)/);
    const gu = guMatch ? guMatch[1] : '';

    // ① 도로명 + 본번(-부번): "테헤란로 504", "논현로85길 22"
    const roadNumMatch = normalized.match(/([가-힣]+(?:로|길)\d*)\s+(\d+(?:-\d+)?)/);
    if (roadNumMatch) {
        return (gu + ' ' + roadNumMatch[1] + ' ' + roadNumMatch[2]).trim();
    }

    // ② 지번: "역삼동 737-7", "논현동 70-5"
    const jibunMatch = normalized.match(/([가-힣]+동)\s+(\d+(?:-\d+)?)/);
    if (jibunMatch) {
        return (gu + ' ' + jibunMatch[1] + ' ' + jibunMatch[2]).trim();
    }

    // ③ 동만 있는 경우 — 신뢰도 낮음
    const dongMatch = normalized.match(/([가-힣]+동)/);
    if (dongMatch) return (gu + ' ' + dongMatch[1]).trim();

    return gu || normalized.slice(0, 20);
}

/**
 * ★ v1.2: 문자열 유사도 — 포함 관계 보너스 제거, Dice bigram만 사용
 * 기존: shorter가 longer에 포함되면 +0.3 보너스 → "강남구"="강남구 테헤란로 504" 높은 유사도
 * 수정: 실제 bigram 겹침만 계산, 짧은 문자열의 과도한 매칭 방지
 */
function mergeStringSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    if (s1 === s2) return 1;
    if (s1.length < 2 || s2.length < 2) return 0;

    // bigram 집합 (중복 허용 — multiset)
    const bigrams = (s) => {
        const bg = [];
        for (let i = 0; i < s.length - 1; i++) bg.push(s.slice(i, i + 2));
        return bg;
    };
    const bg1 = bigrams(s1);
    const bg2 = bigrams(s2);
    const set2 = [...bg2];
    let intersection = 0;
    bg1.forEach(b => {
        const idx = set2.indexOf(b);
        if (idx >= 0) { intersection++; set2.splice(idx, 1); }
    });
    return (2 * intersection) / (bg1.length + bg2.length) || 0;
}

/**
 * ★ v1.2: 빌딩명 정규화 — suffix만 제거, 숫자/한자는 유지
 * 기존: "빌딩","타워","센터" 모두 제거 → "해성1빌딩"→"해성1", "해성2빌딩"→"해성2" 유사도 과도
 * 수정: B/D, BD, Bldg 영문 표기만 제거. 한글 suffix는 유지하여 구분력 보존
 */
function normalizeBuildingName(name) {
    if (!name) return '';
    return name
        .replace(/\s*B\/D\s*$/i, '').replace(/\s*BD\s*$/i, '').replace(/\s*Bldg\.?\s*$/i, '')
        .replace(/\s+/g, ' ').trim().toLowerCase();
}

// ============================================================
// ★ v1.3: Kakao Geocoder 기반 주소 양방향 보강
// ============================================================

/**
 * Kakao Maps Services Geocoder로 주소 하나를 검색해
 * 도로명 주소(road)와 지번 주소(jibun) 양쪽을 반환
 * @param {string} address
 * @returns {Promise<{road: string, jibun: string}|null>}
 */
function kakaoGeocodeAddress(address) {
    return new Promise((resolve) => {
        if (!address || !window.kakao?.maps?.services) {
            resolve(null);
            return;
        }
        const geocoder = new kakao.maps.services.Geocoder();
        geocoder.addressSearch(address, (result, status) => {
            if (status !== kakao.maps.services.Status.OK || !result.length) {
                resolve(null);
                return;
            }
            const r = result[0];
            resolve({
                road:  r.road_address?.address_name  || '',
                jibun: r.address?.address_name        || r.address_name || ''
            });
        });
    });
}

/**
 * ★ v1.3: 빌딩 entries 중 address/addressJibun 중 하나가 비어있는 빌딩만
 * Kakao Geocoder로 보강 (캐시: localStorage 24시간)
 *
 * 처리 흐름:
 *   1. 캐시 확인 → 있으면 즉시 반영
 *   2. 없으면 Kakao API 호출 → 캐시 저장 → 반영
 *   3. Kakao SDK 미로드 / 실패 시 원본 그대로 유지 (graceful degradation)
 *
 * @param {Array} entries  — detectDuplicateBuildings의 entries 배열 (참조 수정)
 */
async function enrichBuildingAddresses(entries) {
    const CACHE_KEY = 'cre_addr_cache_v1';
    const CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간

    // 캐시 로드
    let cache = {};
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            const now = Date.now();
            // TTL 지난 항목 제거
            Object.keys(parsed).forEach(k => {
                if (now - parsed[k].ts < CACHE_TTL) cache[k] = parsed[k];
            });
        }
    } catch (_) {}

    const saveCache = () => {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) {}
    };

    // Kakao SDK 사용 가능 여부 확인
    const kakaoAvailable = !!window.kakao?.maps?.services;
    if (!kakaoAvailable) {
        console.warn('⚠️ [merge] Kakao SDK 미로드 — 주소 보강 스킵');
        return;
    }

    // 보강이 필요한 빌딩만 추출
    //   도로명만 있고 지번 없음, 또는 지번만 있고 도로명 없음
    const needEnrich = entries.filter(e => {
        const hasRoad  = e.address && e.addrKey;
        const hasJibun = e.addressJibun && e.addrKeyJibun;
        return (hasRoad && !hasJibun) || (!hasRoad && hasJibun);
    });

    if (!needEnrich.length) {
        console.log('ℹ️ [merge] 주소 보강 대상 없음');
        return;
    }

    console.log(`🗺️ [merge] 주소 보강 대상: ${needEnrich.length}개 빌딩`);

    let enriched = 0;
    let fromCache = 0;

    for (const e of needEnrich) {
        const queryAddr = e.address || e.addressJibun;
        const cacheKey  = queryAddr.trim();

        let resolved = null;

        if (cache[cacheKey]) {
            resolved = cache[cacheKey].data;
            fromCache++;
        } else {
            // API 호출 (과호출 방지: 100ms 간격)
            await new Promise(r => setTimeout(r, 100));
            resolved = await kakaoGeocodeAddress(queryAddr);
            if (resolved) {
                cache[cacheKey] = { ts: Date.now(), data: resolved };
                enriched++;
            }
        }

        if (!resolved) continue;

        // addrKey / addrKeyJibun 보강 (address 원본은 수정하지 않음)
        if (!e.address && resolved.road) {
            e.addressResolved  = resolved.road;
            e.addrKey          = mergeExtractAddressKey(resolved.road);
        }
        if (!e.addressJibun && resolved.jibun) {
            e.addressJibunResolved = resolved.jibun;
            e.addrKeyJibun         = mergeExtractAddressKey(resolved.jibun);
        }
    }

    saveCache();
    console.log(`✅ [merge] 주소 보강 완료 — API: ${enriched}개, 캐시: ${fromCache}개`);
}

// ============================================================
// 중복 탐지 엔진
// ============================================================

/**
 * Firebase buildings 전체를 스캔하여 중복 후보 그룹을 반환
 * @returns {Array<{groupId, buildings: [{id, name, address, ...}], matchType, similarity}>}
 */
async function detectDuplicateBuildings() {
    const { db, ref, get } = await getMergeFirebaseRefs();
    const snap = await get(ref(db, 'buildings'));
    const buildings = snap.val() || {};
    
    const entries = Object.entries(buildings)
        .filter(([id, b]) => b && typeof b === 'object' && b.name)
        .map(([id, b]) => ({
            id,
            name: b.name || '',
            address: b.address || '',
            addressJibun: b.addressJibun || '',
            aliases: b.aliases || [],
            addrKey: mergeExtractAddressKey(b.address || ''),
            addrKeyJibun: mergeExtractAddressKey(b.addressJibun || ''),
            nameNorm: normalizeBuildingName(b.name),
            data: b
        }));
    
    console.log(`🔍 중복 탐지 시작: ${entries.length}개 빌딩`);

    // ★ v1.3: Kakao Geocoder로 단방향 주소(도로명만/지번만) 빌딩 보강
    //   API 호출은 필요한 빌딩에만 → 결과는 localStorage 캐시(24h)
    await enrichBuildingAddresses(entries);
    
    // Step 1: 주소키 기반 그룹핑
    const addrGroups = {};
    entries.forEach(e => {
        const keys = [e.addrKey, e.addrKeyJibun].filter(k => k && k.length > 3);
        keys.forEach(key => {
            if (!addrGroups[key]) addrGroups[key] = [];
            if (!addrGroups[key].find(x => x.id === e.id)) {
                addrGroups[key].push(e);
            }
        });
    });
    
    // ★ v1.2: Step 2 — 엄격한 주소 일치 기준으로 후보 쌍 선별
    //
    // 변경 이유:
    //   기존 Level 2 (주소유사 0.7 + 이름 0.3)가 너무 느슨해서
    //   같은 도로 위의 완전히 다른 빌딩들이 한 그룹으로 묶였음.
    //   → 주소키에 번지번호까지 포함(mergeExtractAddressKey v1.2)하여
    //     "거의 동일한 주소"만 허용하고, Level 2/3/4 임계값 대폭 상향.
    //
    // 판단 기준:
    //   Level 1 (주소 완전 일치):
    //     - 도로명키 완전 일치 OR 도로명↔지번 교차 완전 일치
    //     - 즉 "강남구 테헤란로 504" === "강남구 테헤란로 504" 또는
    //          "강남구 테헤란로 504" ≈ "강남구 역삼동 737-7" (동일 부지)
    //     - 이 경우만 주소 일치 중복으로 판단
    //   Level 2 (주소 고유사 + 이름 동일에 가까움):
    //     - 도로명 + 번지가 거의 같고(0.92↑) 이름도 매우 유사(0.75↑)
    //     - "한 글자 오기" 수준의 오타 허용
    //   Level 3 (alias 직접 일치):
    //     - 한쪽 alias가 다른 쪽 빌딩명과 완전 일치 + 같은 구
    const candidateGroups = [];
    const processedPairs = new Set();

    Object.entries(addrGroups).forEach(([key, group]) => {
        if (group.length < 2) return;

        for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
                const a = group[i];
                const b = group[j];
                const pairKey = [a.id, b.id].sort().join('|');
                if (processedPairs.has(pairKey)) continue;
                processedPairs.add(pairKey);

                // 주소키 유효성 체크: 번지 없는 짧은 키는 신뢰도 낮음
                const keyHasNumber = (k) => /\d/.test(k);
                const aKeyValid = keyHasNumber(a.addrKey) || keyHasNumber(a.addrKeyJibun);
                const bKeyValid = keyHasNumber(b.addrKey) || keyHasNumber(b.addrKeyJibun);

                // 4가지 교차 조합 유사도
                const addrSims = [
                    mergeStringSimilarity(a.addrKey, b.addrKey),
                    mergeStringSimilarity(a.addrKey, b.addrKeyJibun),
                    mergeStringSimilarity(a.addrKeyJibun, b.addrKey),
                    mergeStringSimilarity(a.addrKeyJibun, b.addrKeyJibun)
                ];
                const bestAddrSim = Math.max(...addrSims);

                // 이름 유사도 (정규화 후)
                const nameSim = mergeStringSimilarity(a.nameNorm, b.nameNorm);

                // alias 완전 일치 체크 (contains가 아닌 normalize 후 exact match)
                const aliasExactMatch = (a.aliases || []).some(al =>
                    normalizeBuildingName(al) === b.nameNorm && b.nameNorm.length > 1
                ) || (b.aliases || []).some(al =>
                    normalizeBuildingName(al) === a.nameNorm && a.nameNorm.length > 1
                );

                let matchType = null;
                let similarity = 0;

                // ★ Level 1: 주소 완전 일치 (번지까지 동일)
                //   두 키 모두 번지를 포함하고 유사도 0.97 이상
                if (aKeyValid && bKeyValid && bestAddrSim >= 0.97) {
                    matchType = 'address_exact';
                    similarity = bestAddrSim;
                }
                // ★ Level 2: 주소 고유사(번지 포함) + 이름 매우 유사
                //   오타/띄어쓰기 차이 수준의 허용
                else if (aKeyValid && bKeyValid && bestAddrSim >= 0.92 && nameSim >= 0.75) {
                    matchType = 'address_similar';
                    similarity = bestAddrSim * 0.6 + nameSim * 0.4;
                }
                // ★ Level 3: alias 완전 일치 + 같은 구 + 주소 어느 정도 유사
                else if (aliasExactMatch
                    && a.addrKey.split(' ')[0] === b.addrKey.split(' ')[0]
                    && bestAddrSim >= 0.7) {
                    matchType = 'alias_match';
                    similarity = 0.90;
                }

                if (matchType) {
                    candidateGroups.push({
                        buildings: [a, b],
                        matchType,
                        similarity: Math.round(similarity * 100) / 100,
                        addrKey: key
                    });
                }
            }
        }
    });
    
    // Step 3: 쌍을 그룹으로 병합 (A-B, B-C → A-B-C)
    const mergedGroups = mergePairsToGroups(candidateGroups);
    
    console.log(`✅ 중복 후보 그룹: ${mergedGroups.length}개`);
    return mergedGroups;
}

/**
 * ★ v1.2: 쌍(pair)을 그룹으로 병합
 *
 * 전이적 병합(A-B, B-C → A,B,C 한 그룹) 제한:
 *   - address_exact 쌍만 전이 허용
 *   - address_similar / alias_match 쌍은 전이 없이 쌍 자체만 그룹화
 *
 * 이유: 기존 Union-Find가 모든 쌍을 무조건 전이적으로 병합하여
 *   A-B(낮은 유사도), B-C(낮은 유사도) → A,B,C 46개 거대 그룹 발생
 */
function mergePairsToGroups(pairs) {
    const parent = {};
    const find = (x) => parent[x] === x ? x : (parent[x] = find(parent[x]));
    const union = (a, b) => { parent[find(a)] = find(b); };
    const buildingMap = {};

    // 모든 빌딩 ID 초기화
    pairs.forEach(p => {
        p.buildings.forEach(b => {
            buildingMap[b.id] = b;
            if (!parent[b.id]) parent[b.id] = b.id;
        });
    });

    // ★ address_exact만 전이적 병합 허용
    pairs.forEach(p => {
        if (p.matchType === 'address_exact' && p.buildings.length >= 2) {
            union(p.buildings[0].id, p.buildings[1].id);
        }
    });

    // address_exact 그룹 수집
    const groups = {};
    Object.keys(parent).forEach(id => {
        const root = find(id);
        if (!groups[root]) groups[root] = {
            buildings: [],
            matchType: 'address_exact',
            similarity: 0,
            matchTypes: new Set()
        };
        if (!groups[root].buildings.find(b => b.id === id)) {
            groups[root].buildings.push(buildingMap[id]);
        }
    });

    // address_exact 유사도 집계
    pairs.filter(p => p.matchType === 'address_exact').forEach(p => {
        const root = find(p.buildings[0].id);
        if (groups[root]) {
            groups[root].matchTypes.add(p.matchType);
            groups[root].similarity = Math.max(groups[root].similarity, p.similarity);
        }
    });

    // ★ address_similar / alias_match는 전이 없이 독립 쌍 그룹으로 추가
    //   단, 이미 address_exact 그룹에 포함된 빌딩은 추가하지 않음
    const exactGrouped = new Set(Object.keys(parent));
    pairs.filter(p => p.matchType !== 'address_exact').forEach((p, idx) => {
        const [ba, bb] = p.buildings;
        // 두 빌딩이 이미 같은 address_exact 그룹에 있으면 스킵
        if (exactGrouped.has(ba.id) && exactGrouped.has(bb.id)
            && find(ba.id) === find(bb.id)) return;
        // 별도 쌍 그룹 생성
        const gKey = `pair_${idx}`;
        groups[gKey] = {
            buildings: [ba, bb],
            matchType: p.matchType,
            similarity: p.similarity,
            matchTypes: new Set([p.matchType])
        };
    });

    return Object.values(groups)
        .filter(g => g.buildings.length >= 2)
        .map((g, idx) => ({
            groupId: `dup_${idx}`,
            buildings: g.buildings,
            matchType: g.matchTypes.size === 1 ? [...g.matchTypes][0] : 'mixed',
            similarity: g.similarity,
            count: g.buildings.length
        }))
        .sort((a, b) => b.similarity - a.similarity);
}

// ============================================================
// 중복 관리 UI
// ============================================================

let _duplicateGroups = [];
let _currentMergeGroup = null;

async function openDuplicateManager() {
    const overlay = document.getElementById('duplicateManagerOverlay');
    if (!overlay) {
        console.error('duplicateManagerOverlay 없음');
        return;
    }
    
    overlay.style.display = 'flex';
    document.getElementById('dupManagerContent').innerHTML = `
        <div style="text-align: center; padding: 60px;">
            <div style="font-size: 32px; margin-bottom: 12px;">🔍</div>
            <div style="font-size: 14px; color: #64748b;">중복 빌딩을 탐지하고 있습니다...</div>
            <div style="margin-top: 12px; font-size: 12px; color: #94a3b8;">Firebase에서 모든 빌딩을 로드 중</div>
        </div>
    `;
    
    try {
        _duplicateGroups = await detectDuplicateBuildings();
        renderDuplicateList();
    } catch (err) {
        console.error('중복 탐지 오류:', err);
        document.getElementById('dupManagerContent').innerHTML = `
            <div style="text-align: center; padding: 60px; color: #ef4444;">
                <div style="font-size: 32px; margin-bottom: 12px;">❌</div>
                <div>중복 탐지 중 오류가 발생했습니다</div>
                <div style="font-size: 12px; margin-top: 8px;">${err.message}</div>
            </div>
        `;
    }
}

function closeDuplicateManager() {
    const overlay = document.getElementById('duplicateManagerOverlay');
    if (overlay) overlay.style.display = 'none';
}

function renderDuplicateList() {
    const container = document.getElementById('dupManagerContent');
    
    if (_duplicateGroups.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 60px;">
                <div style="font-size: 48px; margin-bottom: 16px;">✅</div>
                <div style="font-size: 16px; font-weight: 600; color: #10b981;">중복 빌딩이 없습니다</div>
                <div style="font-size: 13px; color: #64748b; margin-top: 8px;">모든 빌딩이 고유하게 관리되고 있습니다</div>
            </div>
        `;
        return;
    }
    
    const matchTypeLabels = {
        'address_exact': { label: '주소 일치', color: '#ef4444', bg: '#fef2f2' },
        'address_similar': { label: '주소 유사', color: '#f59e0b', bg: '#fffbeb' },
        'name_similar': { label: '이름 유사', color: '#3b82f6', bg: '#eff6ff' },
        'alias_match': { label: '별칭 매칭', color: '#8b5cf6', bg: '#f5f3ff' },
        'mixed': { label: '복합', color: '#6b7280', bg: '#f9fafb' }
    };
    
    let html = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <div>
                <span style="font-size: 14px; font-weight: 600;">발견된 중복 후보</span>
                <span style="margin-left: 8px; padding: 2px 8px; background: #fef2f2; color: #ef4444; border-radius: 10px; font-size: 12px; font-weight: 600;">${_duplicateGroups.length}그룹</span>
            </div>
            <div style="font-size: 11px; color: #94a3b8;">유사도 높은 순</div>
        </div>
    `;
    
    _duplicateGroups.forEach((group, idx) => {
        const mt = matchTypeLabels[group.matchType] || matchTypeLabels['mixed'];
        const buildingNames = group.buildings.map(b => b.name).join(' / ');
        const addresses = [...new Set(group.buildings.map(b => b.address).filter(Boolean))];
        
        html += `
        <div style="border: 1px solid #e2e8f0; border-radius: 10px; margin-bottom: 10px; overflow: hidden; cursor: pointer; transition: all 0.2s;"
             onmouseover="this.style.borderColor='#3b82f6'; this.style.boxShadow='0 2px 8px rgba(59,130,246,0.15)'"
             onmouseout="this.style.borderColor='#e2e8f0'; this.style.boxShadow='none'"
             onclick="openMergeView(${idx})">
            <div style="padding: 14px 16px;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                    <div style="flex: 1;">
                        <div style="font-size: 14px; font-weight: 600; color: #1e293b; margin-bottom: 4px;">
                            ${buildingNames}
                        </div>
                        <div style="font-size: 12px; color: #64748b;">
                            ${addresses.slice(0, 2).join(' | ')}
                        </div>
                    </div>
                    <div style="display: flex; gap: 6px; align-items: center; flex-shrink: 0;">
                        <span style="padding: 3px 8px; background: ${mt.bg}; color: ${mt.color}; border-radius: 6px; font-size: 11px; font-weight: 600;">
                            ${mt.label}
                        </span>
                        <span style="padding: 3px 8px; background: #f1f5f9; color: #475569; border-radius: 6px; font-size: 11px;">
                            ${Math.round(group.similarity * 100)}%
                        </span>
                        <span style="padding: 3px 8px; background: #f1f5f9; color: #64748b; border-radius: 6px; font-size: 11px;">
                            ${group.count}개
                        </span>
                    </div>
                </div>
                <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                    ${group.buildings.map(b => `
                        <span style="padding: 2px 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 11px; color: #475569;">
                            ${b.name}${b.aliases?.length ? ` (+${b.aliases.length} 별칭)` : ''}
                        </span>
                    `).join('')}
                </div>
            </div>
        </div>
        `;
    });
    
    container.innerHTML = html;
}

// ============================================================
// 병합 뷰
// ============================================================

async function openMergeView(groupIdx) {
    const group = _duplicateGroups[groupIdx];
    if (!group) return;
    
    _currentMergeGroup = group;
    
    const container = document.getElementById('dupManagerContent');
    
    // Firebase에서 최신 데이터 로드
    const { db, ref, get } = await getMergeFirebaseRefs();
    const freshBuildings = [];
    for (const b of group.buildings) {
        const snap = await get(ref(db, `buildings/${b.id}`));
        const data = snap.val();
        if (data) freshBuildings.push({ id: b.id, ...data });
    }
    
    if (freshBuildings.length < 2) {
        if (typeof showToast === 'function') showToast('병합할 빌딩이 부족합니다', 'warning');
        renderDuplicateList();
        return;
    }
    
    // 데이터 풍부도 점수로 Master 추천
    const compareFields = [
        { key: 'name', label: '빌딩명' },
        { key: 'address', label: '도로명주소' },
        { key: 'addressJibun', label: '지번주소' },
        { key: 'nearbyStation', label: '인근역' },
        { key: 'grade', label: '등급' },
        { key: 'completionYear', label: '준공년도' },
        { key: 'totalFloors', label: '지상층수' },
        { key: 'basementFloors', label: '지하층수' },
        { key: 'grossFloorSqm', label: '연면적(㎡)' },
        { key: 'typicalFloorPy', label: '기준층전용(평)' },
        { key: 'typicalFloorLeasePy', label: '기준층임대(평)' },
        { key: 'exclusiveRate', label: '전용률(%)' },
        { key: 'depositPy', label: '보증금(만원/평)' },
        { key: 'rentPy', label: '임대료(만원/평)' },
        { key: 'maintenancePy', label: '관리비(만원/평)' },
        { key: 'hvac', label: '냉난방' },
        { key: 'parkingTotal', label: '총주차' },
        { key: 'parkingFree', label: '무료주차' },
        { key: 'parkingPaid', label: '유료주차' },
        { key: 'parkingNote', label: '주차비고' },
        { key: 'pm', label: 'PM' },
        { key: 'owner', label: '소유자' },
        { key: 'description', label: '설명' },
    ];
    
    const richness = freshBuildings.map(b => {
        let score = 0;
        compareFields.forEach(f => { if (b[f.key]) score++; });
        return score;
    });
    const recommendedMasterIdx = richness.indexOf(Math.max(...richness));
    
    // 전역 저장
    window._mergeFreshBuildings = freshBuildings;
    window._mergeCompareFields = compareFields;
    
    // 열 너비 계산 (label열 + 빌딩열 + 직접입력열)
    const colCount = freshBuildings.length + 1; // +1 for 직접입력
    
    let html = `
        <div style="margin-bottom: 16px;">
            <button onclick="renderDuplicateList()" style="padding: 6px 14px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; font-size: 12px; color: #475569;">
                ← 목록으로
            </button>
        </div>
        
        <div style="font-size: 12px; color: #64748b; margin-bottom: 12px; line-height: 1.6;">
            ☑️ 체크 해제 = 병합에서 제외 &nbsp;|&nbsp; ◉ Master = 기준 빌딩 &nbsp;|&nbsp; 값이 다른 필드는 클릭하여 선택
        </div>
        
        <div style="overflow-x: auto; border: 1px solid #e2e8f0; border-radius: 10px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed;">
    `;
    
    // ===== 테이블 헤더: 체크박스 + Master 라디오 + 빌딩명 =====
    html += `<thead><tr style="background: #eff6ff; border-bottom: 2px solid #bfdbfe;">`;
    html += `<th style="padding: 10px 12px; text-align: left; font-weight: 600; color: #1e40af; width: 110px; position: sticky; left: 0; background: #eff6ff; z-index: 1;">필드</th>`;
    
    freshBuildings.forEach((b, idx) => {
        const isRec = idx === recommendedMasterIdx;
        html += `
            <th id="mergeColHeader_${idx}" style="padding: 10px 8px; text-align: center; min-width: 140px; vertical-align: top;">
                <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <input type="checkbox" class="mergeIncludeCheck" data-idx="${idx}" value="${b.id}" checked
                               onchange="onMergeInclusionChange(this)"
                               style="width: 14px; height: 14px; accent-color: #3b82f6; cursor: pointer;"
                               title="병합 포함/제외">
                        <input type="radio" name="masterBuilding" value="${b.id}" data-idx="${idx}"
                               ${isRec ? 'checked' : ''} onchange="onMasterChange()"
                               style="cursor: pointer;" title="Master 지정">
                    </div>
                    <div style="font-size: 12px; font-weight: 600; color: #1e293b; line-height: 1.3;">${b.name}</div>
                    <div style="font-size: 10px; color: #64748b;">${richness[idx]}/${compareFields.length} 채움</div>
                    ${isRec ? '<div style="font-size: 10px; color: #3b82f6; font-weight: 600;">⭐ 추천</div>' : ''}
                </div>
            </th>`;
    });
    
    html += `<th style="padding: 10px 8px; text-align: center; min-width: 120px; font-weight: 500; color: #94a3b8;">직접 입력</th>`;
    html += `</tr></thead>`;
    
    // ===== 테이블 바디: 필드별 행 =====
    html += `<tbody>`;
    
    compareFields.forEach((field, fIdx) => {
        const values = freshBuildings.map(b => {
            const v = b[field.key];
            return v != null && v !== '' ? String(v) : '';
        });
        
        const uniqueVals = [...new Set(values.filter(v => v))];
        const isConflict = uniqueVals.length > 1;
        const hasValue = uniqueVals.length > 0;
        
        if (!hasValue) return; // 모든 빌딩에 값 없으면 스킵
        
        const rowBg = isConflict ? '#fffbeb' : (fIdx % 2 === 0 ? '#ffffff' : '#f8fafc');
        
        html += `<tr style="background: ${rowBg}; border-bottom: 1px solid #f1f5f9;">`;
        
        // 필드 라벨
        html += `<td style="padding: 8px 12px; font-weight: 600; color: #334155; position: sticky; left: 0; background: ${rowBg}; z-index: 1; border-right: 1px solid #e2e8f0;">
            ${field.label}
            ${isConflict ? ' <span style="font-size: 9px; padding: 1px 4px; background: #fef3c7; color: #92400e; border-radius: 3px;">⚠️</span>' : ''}
        </td>`;
        
        // 각 빌딩 값
        freshBuildings.forEach((b, bIdx) => {
            const val = values[bIdx];
            const isMasterDefault = bIdx === recommendedMasterIdx;
            
            if (isConflict && val) {
                // 충돌 필드: 라디오 선택 가능한 셀
                html += `<td class="mergeCell" style="padding: 6px 8px; cursor: pointer;" 
                             onclick="selectMergeValue('${field.key}', ${bIdx})">
                    <label style="display: flex; align-items: flex-start; gap: 4px; cursor: pointer;">
                        <input type="radio" name="merge_${field.key}" value="${bIdx}"
                               ${isMasterDefault ? 'checked' : ''}
                               data-field="${field.key}" data-val="${val.replace(/"/g, '&quot;')}"
                               style="margin-top: 2px; flex-shrink: 0;">
                        <span style="color: #1e293b; word-break: break-all; line-height: 1.4;">${val}</span>
                    </label>
                </td>`;
            } else if (val) {
                // 동일값 또는 유일값: 표시만
                html += `<td style="padding: 6px 8px; color: #475569;">${val}</td>`;
            } else {
                html += `<td style="padding: 6px 8px; color: #cbd5e1;">—</td>`;
            }
        });
        
        // 직접 입력 열
        if (isConflict) {
            html += `<td style="padding: 6px 8px;">
                <label style="display: flex; align-items: flex-start; gap: 4px; cursor: pointer;">
                    <input type="radio" name="merge_${field.key}" value="custom"
                           data-field="${field.key}" style="margin-top: 2px; flex-shrink: 0;">
                    <input type="text" id="mergeCustom_${field.key}" placeholder="입력" 
                           style="width: 100%; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 11px; padding: 3px 6px; outline: none;"
                           onfocus="document.querySelector('input[name=merge_${field.key}][value=custom]').checked=true">
                </label>
            </td>`;
        } else {
            html += `<td style="padding: 6px 8px; color: #cbd5e1;">—</td>`;
        }
        
        html += `</tr>`;
    });
    
    html += `</tbody></table></div>`;
    
    // 데이터 이관 안내 + 실행 버튼
    html += `
        <div style="margin-top: 20px; padding: 14px 16px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px;">
            <div style="font-size: 13px; font-weight: 600; color: #166534; margin-bottom: 8px;">📦 병합 시 자동 이관되는 데이터</div>
            <div style="font-size: 12px; color: #15803d; line-height: 1.8;">
                • <strong>공실 정보 (vacancies)</strong>: 흡수 빌딩의 모든 공실이 Master로 이관<br>
                • <strong>렌트롤 (rentrolls)</strong>: 흡수 빌딩의 렌트롤이 Master로 이관<br>
                • <strong>메모 (memos)</strong>: 흡수 빌딩의 메모가 Master로 이관<br>
                • <strong>기준가 (floorPricing)</strong>: 흡수 빌딩의 기준가가 Master로 이관<br>
                • <strong>담당자 (contactPoints)</strong>: 흡수 빌딩의 담당자가 Master로 이관<br>
                • <strong>인센티브 (incentives)</strong>: 흡수 빌딩의 인센티브가 Master로 이관<br>
                • <strong>별칭 (aliases)</strong>: 흡수 빌딩의 빌딩명이 Master의 aliases에 추가
            </div>
        </div>
        
        <!-- 실행 버튼 -->
        <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; padding-top: 16px; border-top: 1px solid #e2e8f0;">
            <button onclick="renderDuplicateList()" 
                    style="padding: 12px 24px; background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer; font-size: 13px;">
                취소
            </button>
            <button onclick="executeMerge()" 
                    style="padding: 12px 24px; background: linear-gradient(135deg, #ef4444, #dc2626); color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600;">
                🔗 병합 실행
            </button>
        </div>
    `;
    
    container.innerHTML = html;
}

// ============================================================
// 병합 실행
// ============================================================

async function executeMerge() {
    const freshBuildings = window._mergeFreshBuildings;
    if (!freshBuildings || freshBuildings.length < 2) return;
    
    // Master 선택
    const masterRadio = document.querySelector('input[name="masterBuilding"]:checked');
    if (!masterRadio) {
        if (typeof showToast === 'function') showToast('Master 빌딩을 선택해주세요', 'warning');
        return;
    }
    const masterId = masterRadio.value;
    const masterData = freshBuildings.find(b => b.id === masterId);
    
    // ★ v4.2: 체크된 빌딩만 병합 대상 (Master 제외)
    const includedIds = new Set();
    document.querySelectorAll('.mergeIncludeCheck:checked').forEach(cb => {
        includedIds.add(cb.value);
    });
    const absorbedBuildings = freshBuildings.filter(b => b.id !== masterId && includedIds.has(b.id));
    
    if (absorbedBuildings.length === 0) {
        if (typeof showToast === 'function') showToast('병합할 대상 빌딩을 1개 이상 체크해주세요', 'warning');
        return;
    }
    
    const absorbedNames = absorbedBuildings.map(b => b.name).join(', ');
    if (!confirm(`⚠️ 병합을 실행합니다.\n\nMaster: ${masterData.name}\n흡수: ${absorbedNames}\n\n흡수된 빌딩은 삭제됩니다. 계속하시겠습니까?`)) {
        return;
    }
    
    const { db, ref, get, set, update, remove, push } = await getMergeFirebaseRefs();
    
    try {
        // 1. 필드별 선택값 수집
        const mergedFields = {};
        document.querySelectorAll('input[type="radio"][name^="merge_"]:checked').forEach(radio => {
            const field = radio.dataset.field;
            if (radio.value === 'custom') {
                const customInput = document.getElementById(`mergeCustom_${field}`);
                if (customInput && customInput.value.trim()) {
                    mergedFields[field] = customInput.value.trim();
                }
            } else {
                const val = radio.dataset.val;
                if (val) mergedFields[field] = val;
            }
        });
        
        // 2. aliases 구성
        const existingAliases = masterData.aliases || [];
        const newAliases = [...existingAliases];
        absorbedBuildings.forEach(ab => {
            // 흡수 빌딩의 이름 추가
            if (ab.name && !newAliases.includes(ab.name) && ab.name !== masterData.name) {
                newAliases.push(ab.name);
            }
            // 흡수 빌딩의 기존 aliases도 추가
            (ab.aliases || []).forEach(al => {
                if (al && !newAliases.includes(al) && al !== masterData.name) {
                    newAliases.push(al);
                }
            });
        });
        mergedFields.aliases = newAliases;
        
        // 3. Master 빌딩 업데이트
        mergedFields.updatedAt = new Date().toISOString();
        mergedFields.mergeHistory = [
            ...(masterData.mergeHistory || []),
            {
                date: new Date().toISOString(),
                absorbed: absorbedBuildings.map(b => ({ id: b.id, name: b.name })),
                fieldsUpdated: Object.keys(mergedFields)
            }
        ];
        
        await update(ref(db, `buildings/${masterId}`), mergedFields);
        console.log(`✅ Master ${masterId} 업데이트 완료`, mergedFields);
        
        // 4. 하위 데이터 이관
        const collections = ['vacancies', 'rentrolls', 'memos', 'floorPricing', 'contactPoints', 'incentives'];
        
        for (const ab of absorbedBuildings) {
            for (const col of collections) {
                try {
                    const colSnap = await get(ref(db, `${col}/${ab.id}`));
                    const colData = colSnap.val();
                    if (colData && typeof colData === 'object') {
                        // Master에 데이터 복사 (기존 키와 충돌 방지)
                        for (const [key, val] of Object.entries(colData)) {
                            const newKey = key.startsWith(`${ab.id}_`) ? key : `merged_${ab.id}_${key}`;
                            // Master에 같은 키가 있으면 merged_ 접두사
                            const existSnap = await get(ref(db, `${col}/${masterId}/${key}`));
                            const targetKey = existSnap.exists() ? newKey : key;
                            await set(ref(db, `${col}/${masterId}/${targetKey}`), val);
                        }
                        console.log(`📦 ${col}/${ab.id} → ${masterId} 이관 완료`);
                    }
                } catch (e) {
                    console.warn(`${col}/${ab.id} 이관 실패:`, e);
                }
            }
            
            // 5. 흡수 빌딩 삭제
            await remove(ref(db, `buildings/${ab.id}`));
            // 흡수 빌딩의 원본 하위 데이터도 삭제
            for (const col of collections) {
                await remove(ref(db, `${col}/${ab.id}`));
            }
            console.log(`🗑️ 흡수 빌딩 ${ab.id} (${ab.name}) 삭제 완료`);
            
            // 6. buildingEditLogs에 병합 기록
            await push(ref(db, `buildingEditLogs/${masterId}`), {
                action: 'merge',
                absorbed: { id: ab.id, name: ab.name },
                timestamp: new Date().toISOString(),
                user: 'portal-merge'
            });
        }
        
        if (typeof showToast === 'function') {
            showToast(`✅ 병합 완료! ${masterData.name}에 ${absorbedBuildings.length}개 빌딩 통합`, 'success');
        }
        
        // 목록에서 해당 그룹 제거 후 새로고침
        _duplicateGroups = _duplicateGroups.filter(g => g !== _currentMergeGroup);
        _currentMergeGroup = null;
        window._mergeFreshBuildings = null;
        renderDuplicateList();
        
    } catch (err) {
        console.error('병합 실행 오류:', err);
        if (typeof showToast === 'function') showToast('병합 중 오류 발생: ' + err.message, 'error');
    }
}

// ============================================================
// 개별 빌딩 aliases 관리 (빌딩 상세에서 사용)
// ============================================================

function renderAliasesSection(building) {
    const aliases = building.aliases || [];
    if (aliases.length === 0) return '';
    
    return `
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 12px; padding: 8px 12px; background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 8px;">
            <span style="font-size: 11px; color: #7c3aed; font-weight: 600; white-space: nowrap;">🏷️ 별칭:</span>
            <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                ${aliases.map(al => `
                    <span style="padding: 2px 8px; background: #ede9fe; color: #6d28d9; border-radius: 4px; font-size: 11px;">${al}</span>
                `).join('')}
            </div>
        </div>
    `;
}

// ============================================================
// Global 등록
// ============================================================

window.openDuplicateManager = openDuplicateManager;
window.closeDuplicateManager = closeDuplicateManager;
window.openMergeView = openMergeView;
window.executeMerge = executeMerge;
window.renderDuplicateList = renderDuplicateList;
window.renderAliasesSection = renderAliasesSection;
window.mergeExtractAddressKey = mergeExtractAddressKey;
window.mergeStringSimilarity = mergeStringSimilarity;
window.normalizeBuildingName = normalizeBuildingName;

// ★ v4.2: 셀 클릭으로 라디오 선택
function selectMergeValue(fieldKey, bIdx) {
    const radio = document.querySelector(`input[name="merge_${fieldKey}"][value="${bIdx}"]`);
    if (radio) radio.checked = true;
}

// ★ v4.2: 체크박스 변경 — 병합 포함/제외
function onMergeInclusionChange(checkbox) {
    const idx = checkbox.dataset.idx;
    const masterRadio = document.querySelector('input[name="masterBuilding"]:checked');
    const masterIdx = masterRadio ? masterRadio.dataset.idx : null;
    
    // Master는 해제 불가
    if (idx === masterIdx) {
        checkbox.checked = true;
        if (typeof showToast === 'function') showToast('Master 빌딩은 제외할 수 없습니다', 'warning');
        return;
    }
    
    // 최소 2개 체크
    const checkedCount = document.querySelectorAll('.mergeIncludeCheck:checked').length;
    if (checkedCount < 2) {
        checkbox.checked = true;
        if (typeof showToast === 'function') showToast('최소 2개 빌딩이 필요합니다', 'warning');
        return;
    }
    
    // 열 전체 비활성화 스타일
    const header = document.getElementById(`mergeColHeader_${idx}`);
    if (header) header.style.opacity = checkbox.checked ? '1' : '0.3';
    
    // 해당 열의 셀들 비활성화
    document.querySelectorAll(`td.mergeCell`).forEach(td => {
        // 셀 내부 라디오의 value가 해당 idx인지 확인
    });
}

// ★ v4.2: Master 변경 시
function onMasterChange() {
    const masterRadio = document.querySelector('input[name="masterBuilding"]:checked');
    if (!masterRadio) return;
    const masterIdx = masterRadio.dataset.idx;
    
    // Master는 반드시 체크
    const masterCb = document.querySelector(`.mergeIncludeCheck[data-idx="${masterIdx}"]`);
    if (masterCb && !masterCb.checked) {
        masterCb.checked = true;
        const header = document.getElementById(`mergeColHeader_${masterIdx}`);
        if (header) header.style.opacity = '1';
    }
    
    // 충돌 필드의 기본 선택을 새 Master로 변경
    document.querySelectorAll('#dupManagerContent input[type="radio"][name^="merge_"]').forEach(radio => {
        if (radio.value === masterIdx) {
            radio.checked = true;
        }
    });
}

window.selectMergeValue = selectMergeValue;
window.onMergeInclusionChange = onMergeInclusionChange;
window.onMasterChange = onMasterChange;

/**
 * CRE Portal - 데이터 로딩 및 처리
 */

import { state } from './portal-state.js';
import { db, ref, get } from './portal-firebase.js';
import { showToast, detectRegion } from './portal-utils.js';

// 데이터 로드
export async function loadData() {
    try {
        const [b, r, m, i, mg, docs, u, lg] = await Promise.all([
            get(ref(db, 'buildings')),
            get(ref(db, 'rentrolls')),
            get(ref(db, 'memos')),
            get(ref(db, 'incentives')),
            get(ref(db, 'managements')),
            get(ref(db, 'documents')),
            get(ref(db, 'users')),
            get(ref(db, 'leasingGuides'))
        ]);
        
        state.dataCache = {
            buildings: b.val() || {},
            rentrolls: r.val() || {},
            memos: m.val() || {},
            incentives: i.val() || {},
            managements: mg.val() || {},
            documents: docs.val() || {},
            users: u.val() || {},
            leasingGuides: lg.val() || {}
        };
        
        processBuildings();
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
        
        showToast(`${state.allBuildings.length}개 빌딩 로드 완료`, 'success');
    } catch (e) {
        console.error(e);
        showToast('데이터 로드 실패', 'error');
    }
}

// 임대안내문 포함 빌딩 목록 처리
export function processLeasingGuideBuildings() {
    state.leasingGuideBuildings = new Set();
    
    const guides = state.dataCache.leasingGuides || {};
    Object.values(guides).forEach(guide => {
        if (guide.tocItems && Array.isArray(guide.tocItems)) {
            guide.tocItems.forEach(item => {
                if (item.type === 'building' && item.buildingId) {
                    state.leasingGuideBuildings.add(item.buildingId);
                }
            });
        }
    });
    
    console.log(`임대안내문 포함 빌딩: ${state.leasingGuideBuildings.size}개`);
}

// 빌딩 데이터 처리
export function processBuildings() {
    const { dataCache, currentUser } = state;
    
    state.allBuildings = Object.entries(dataCache.buildings)
        .filter(([k]) => k !== '_schema')
        .map(([id, b]) => {
            // 렌트롤 매칭
            const rentrolls = Object.entries(dataCache.rentrolls)
                .map(([key, r]) => ({ ...r, id: key }))
                .filter(r => r.buildingId === id || r.buildingId === b.name || 
                            r.buildingName === b.name || String(r.buildingId) === String(b.originalId));
            
            // 메모 매칭
            const memos = Object.entries(dataCache.memos)
                .map(([key, m]) => ({ ...m, id: key }))
                .filter(m => m.buildingId === id || m.buildingId === b.name || m.buildingName === b.name);
            
            // 인센티브 매칭
            const incentives = Object.entries(dataCache.incentives)
                .map(([key, i]) => ({ ...i, id: key }))
                .filter(i => i.buildingId === id || i.buildingId === b.name || i.buildingName === b.name);
            
            // 관리사무소
            const mgmt = Object.values(dataCache.managements).find(m =>
                m.buildingId === id || m.buildingId === b.name || m.buildingName === b.name
            );
            
            // 임대안내문
            const docs = Object.values(dataCache.documents).filter(d =>
                d.buildingId === id || d.buildingId === b.name || d.buildingName === b.name
            );

            // 공실 목록
            const vacancies = b.vacancies ? 
                Object.entries(b.vacancies).map(([key, v]) => ({ ...v, _key: key })) : [];
            
            // 문서 그룹핑 (출처+발행일)
            const documents = buildDocuments(vacancies, docs);

            return {
                id,
                name: b.name,
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
                
                // 가격
                rent: b.pricing?.rent,
                rentPy: b.pricing?.rentPy,
                maintenance: b.pricing?.maintenance,
                maintenancePy: b.pricing?.maintenancePy,
                deposit: b.pricing?.deposit,
                depositPy: b.pricing?.depositPy,
                
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
                
                // 기타
                buildingType: b.buildingType,
                grade: b.grade,
                owner: b.owner,
                developer: b.developer,
                pm: b.pm,
                description: b.description,
                url: b.url,
                // 신규 필드
                notes: b.notes || '',
                contactPoints: b.contactPoints || [],
                floorPricing: b.floorPricing || [],
                images: b.images || { exterior: [], floorPlan: [], lobby: [], facilities: [], etc: [] },
                
                // ★ 이미지 배열 변환 (portal-detail.js에서 {url: '...'} 형식 기대)
                exteriorImages: (() => {
                    const imgs = b.images?.exterior || [];
                    return imgs.map(img => typeof img === 'string' ? { url: img } : img);
                })(),
                floorPlanImages: (() => {
                    const imgs = b.images?.floorPlan || [];
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
                hasDocument: documents.length > 0,
                hasData: rentrolls.length > 0 || memos.length > 0 || incentives.length > 0 || vacancies.length > 0,
                // 신규 빌딩 체크
                isNew: b.isNew && b.newUntil && new Date(b.newUntil) > new Date(),
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
            return b.hasData - a.hasData || (a.name || '').localeCompare(b.name || '');
        });
    
    state.filteredBuildings = [...state.allBuildings];
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

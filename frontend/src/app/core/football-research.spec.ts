import { TestBed } from '@angular/core/testing';
import { convertToParamMap } from '@angular/router';
import { Api } from './api.service';
import { FootballResearchStore, researchFilters, researchMetric } from './football-research';

describe('football research display and requests',()=>{
  it('keeps missing scoring statistics distinct from a verified zero',()=>{
    expect(researchMetric(null,2)).toBe('—');expect(researchMetric(undefined,0,'%')).toBe('—');
    expect(researchMetric(0,0,'%')).toBe('0%');expect(researchMetric(2.345,2)).toBe('2.35');
  });
  it('restores valid matchup filters from a shared URL and rejects a same-team matchup',()=>{
    expect(researchFilters(convertToParamMap({teamA:'1',teamB:'2',venue:'away',competitionId:'3',dateFrom:'2025-01-01'}))).toEqual({teamA:1,teamB:2,venue:'away',competitionId:3,dateFrom:'2025-01-01'});
    expect(researchFilters(convertToParamMap({teamA:'1',teamB:'1'}))).toBeNull();
    expect(researchFilters(convertToParamMap({teamA:'NaN',teamB:'2'}))).toBeNull();
  });
  it('coalesces simultaneous history requests and reuses successful display data',async()=>{
    let resolve!:(value:unknown)=>void;const get=vi.fn().mockReturnValue(new Promise(done=>resolve=done));
    TestBed.configureTestingModule({providers:[{provide:Api,useValue:{get}}]});const store=TestBed.inject(FootballResearchStore);
    const filters={teamA:1,teamB:2,venue:'all' as const};const first=store.research(filters),second=store.research(filters);
    expect(get).toHaveBeenCalledOnce();resolve({metadata:{source:'SYNCED'}});expect(await first).toEqual(await second);
    await store.research(filters);expect(get).toHaveBeenCalledOnce();
  });
  it('does not cache a failure and bounds successful search cache entries',async()=>{
    const get=vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue({teams:[],total:0});
    TestBed.configureTestingModule({providers:[{provide:Api,useValue:{get}}]});const store=TestBed.inject(FootballResearchStore);
    await expect(store.teams('Liverpool')).rejects.toThrow('Unavailable');await store.teams('Liverpool');expect(get).toHaveBeenCalledTimes(2);
    for(let i=0;i<110;++i)await store.teams('team'+i);
    expect((store as any).cache.size).toBeLessThanOrEqual(100);
  });
});

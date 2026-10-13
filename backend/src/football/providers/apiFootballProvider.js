import { FootballDataProvider } from './provider.js';

export const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';
export class ApiFootballProvider extends FootballDataProvider {
  constructor({apiKey, fetcher=fetch, reserveRequest=async()=>{}, intervalMs=6500}) {
    super(); this.apiKey=apiKey;this.fetcher=fetcher;this.reserveRequest=reserveRequest;this.intervalMs=intervalMs;this.lastRequest=0;
  }
  get name(){return 'api-football';}
  capabilities(){return {historical:true,statistics:true,events:false};}
  async get(path,params={}) {
    if(!this.apiKey)throw new Error('API_FOOTBALL_KEY is not configured.');
    if(this.remainingDaily!=null&&this.remainingDaily<=10)throw new Error('API-Football daily research request budget reached (provider reserve).');
    const url=new URL(path,API_FOOTBALL_BASE);if(url.origin!==API_FOOTBALL_BASE)throw new Error('Invalid API-Football origin.');
    for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
    const delay=this.lastRequest+this.intervalMs-Date.now();if(delay>0)await new Promise(r=>setTimeout(r,delay));
    await this.reserveRequest();this.lastRequest=Date.now();
    const response=await this.fetcher(url,{headers:{'x-apisports-key':this.apiKey},redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`API-Football HTTP ${response.status}; retry on the next scheduled import.`);
    const remaining=response.headers.get('x-ratelimit-requests-remaining');
    if(remaining!==null&&Number.isFinite(Number(remaining)))this.remainingDaily=Number(remaining);
    let size=0;const chunks=[];
    for await(const chunk of response.body){size+=chunk.length;if(size>2_000_000)throw new Error('API-Football response exceeds the size limit.');chunks.push(chunk);}
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(data.errors && Object.keys(data.errors).length)throw new Error('API-Football rejected this request (quota, subscription or parameters).');
    if(!Array.isArray(data.response)||Number(data.paging?.total||1)>1)throw new Error('API-Football returned incomplete or invalid history.');
    return data.response;
  }
  teams(name){return this.get('/teams',{search:name});}
  headToHead(a,b){return this.get('/fixtures/headtohead',{h2h:`${a}-${b}`});}
  statistics(id){return this.get('/fixtures/statistics',{fixture:id});}
}

const number=v=>v!=null&&v!==''&&Number.isFinite(Number(String(v).replace('%','')))&&Number(String(v).replace('%',''))>=0?Number(String(v).replace('%','')):null;
export function normalizeApiFootballStatistics(rows,home,away){
  const keys={shots:'Total Shots',shotsOnTarget:'Shots on Goal',possession:'Ball Possession',corners:'Corner Kicks',fouls:'Fouls',yellowCards:'Yellow Cards',redCards:'Red Cards'};
  const side=id=>rows.find(r=>r.team?.id===id)?.statistics||[];
  return Object.fromEntries(Object.entries(keys).map(([k,label])=>[k,[home,away].map(id=>number(side(id).find(s=>s.type===label)?.value))]));
}
export function normalizeApiFootballMeeting(raw,a,b){
  const ids=[raw.teams?.home?.id,raw.teams?.away?.id];const score=raw.score?.fulltime;
  if(!Number.isSafeInteger(raw.fixture?.id)||!ids.includes(a)||!ids.includes(b)||a===b)throw new Error('API-Football returned a different team pairing.');
  const date=new Date(raw.fixture.date);if(!Number.isFinite(date.getTime()))throw new Error('Invalid API-Football match date.');
  // AET/PEN/awarded scores are not regulation-time evidence for this analysis.
  if(raw.fixture.status?.short!=='FT'||date.getTime()>Date.now()||![score?.home,score?.away].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=99))return null;
  if(!Number.isSafeInteger(raw.league?.id)||!Number.isSafeInteger(raw.league.season))throw new Error('Invalid API-Football competition.');
  return {raw,date:date.toISOString().slice(0,10),homeProviderId:ids[0],awayProviderId:ids[1],homeScore:score.home,awayScore:score.away,halfTime:[raw.score.halftime?.home??null,raw.score.halftime?.away??null]};
}

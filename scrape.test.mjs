import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the exact pure helpers shipped in the standalone scraper.
const source=fs.readFileSync(new URL('./scrape.mjs',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('const STATION_ID'),source.indexOf('const today=torontoDate();'));
const h=vm.runInNewContext(helpers+'\n({validateDate,torontoDate,shiftDate,parsePageDate,parseDailyResponse,dailySummaryUrl,latestRecord,parsePrecipitation})',{URL,URLSearchParams,Intl,Date});
const observed='https://api.weather.com/v2/pws/history/all?stationId=IVAUGH20&date=20261002&units=e&format=json&apiKey=fake-test-key';
const daily=h.dailySummaryUrl(observed,'2026-10-01');
const body=()=>({observations:[{stationID:'IVAUGH20',tz:'America/Toronto',obsTimeLocal:'2026-10-01 23:59:59',imperial:{precipTotal:0.06}}]});

test('history/all request produces an explicit exact-day daily query',()=>{
  const u=new URL(daily);
  assert.equal(u.origin,'https://api.weather.com');
  assert.equal(u.pathname,'/v2/pws/history/daily');
  assert.equal(u.searchParams.get('date'),'20261001');
  assert.equal(u.searchParams.get('stationId'),'IVAUGH20');
  assert.equal(u.searchParams.get('units'),'e');
  assert.equal(u.searchParams.get('apiKey'),'fake-test-key');
  assert.equal(u.searchParams.get('startDate'),null);
  assert.equal(h.parseDailyResponse(observed,body()),null);
});
test('fallback rejects unrelated hosts, stations, endpoints and missing keys or units',()=>{
  for (const url of [observed.replace('api.weather.com','example.com'),observed.replace('IVAUGH20','OTHER'),observed.replace('/history/all','/other'),observed.replace('&apiKey=fake-test-key',''),observed.replace('units=e','units=x')]) assert.equal(h.dailySummaryUrl(url,'2026-10-01'),null);
  assert.throws(()=>h.dailySummaryUrl(observed,'2026-02-30'));
});
test('daily query cannot inherit a wrong day or multi-day range',()=>{
  const u=new URL(h.dailySummaryUrl(observed+'&startDate=20260901&endDate=20261002','2026-10-01'));
  assert.equal(u.searchParams.get('date'),'20261001');
  assert.equal(u.searchParams.get('startDate'),null);
  assert.equal(u.searchParams.get('endDate'),null);
});
test('fallback uses consistent inch precision regardless of site display units',()=>{
  assert.equal(new URL(h.dailySummaryUrl(observed.replace('units=e','units=m'),'2026-10-01')).searchParams.get('units'),'e');
});
test('official imperial daily total converts correctly',()=>{
  assert.equal(h.parseDailyResponse(daily,body()).precipitationMm,1.524);
  assert.equal(h.parseDailyResponse(daily,body()).precipitationIn,0.06);
});
test('official metric data and genuine zero',()=>{
  const b=body();b.observations[0].metric={precipTotal:1.5};
  assert.equal(h.parseDailyResponse(daily.replace('units=e','units=m'),b).precipitationMm,1.5);
  b.observations[0].imperial.precipTotal=0;
  assert.equal(h.parseDailyResponse(daily,b).precipitationMm,0);
});
test('wrong dates, stations and timezone cannot be saved',()=>{
  for (const change of [o=>o.obsTimeLocal='2026-10-02 00:00:00',o=>o.stationID='OTHER',o=>o.tz='UTC']) {
    const b=body();change(b.observations[0]);assert.throws(()=>h.parseDailyResponse(daily,b));
  }
});
test('missing, negative and non-finite precipitation is rejected',()=>{
  for (const value of [null,-1,NaN,Infinity,'0.06']) {
    const b=body();b.observations[0].imperial.precipTotal=value;assert.throws(()=>h.parseDailyResponse(daily,b));
  }
  assert.throws(()=>h.parseDailyResponse(daily,{observations:[]}));
  assert.throws(()=>h.parseDailyResponse(daily,{observations:[body().observations[0],body().observations[0]]}));
});
test('date ranges and current observations are not daily summaries',()=>{
  assert.equal(h.parseDailyResponse(daily.replace('/history/daily','/observations/current'),body()),null);
  assert.equal(h.parseDailyResponse('https://api.weather.com/v2/pws/history/daily?stationId=IVAUGH20&startDate=20261001&endDate=20261002&units=e',body()),null);
});
test('Toronto dates remain correct across DST and UTC midnight',()=>{
  assert.equal(h.torontoDate(new Date('2026-10-02T02:00:00Z')),'2026-10-01');
  assert.equal(h.shiftDate('2026-03-09',-1),'2026-03-08');
  assert.equal(h.shiftDate('2026-11-02',-1),'2026-11-01');
  assert.equal(h.parsePageDate('Oct 1, 2026'),'2026-10-01');
});
test('legacy precipitation cells reject missing data and rates',()=>{
  assert.equal(h.parsePrecipitation('0.06 in').precipitationMm,1.524);
  for(const value of ['--','—','','0 in/hr','-1 mm']) assert.throws(()=>h.parsePrecipitation(value));
});
test('older backfill preserves latest date',()=>{
  assert.equal(h.latestRecord({'2026-10-01':{date:'2026-10-01'},'2026-09-30':{date:'2026-09-30'}}).date,'2026-10-01');
});

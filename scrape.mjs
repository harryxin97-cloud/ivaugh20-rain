import { chromium } from 'playwright';
import fs from 'node:fs';
const STATION_ID = 'IVAUGH20';
const TIMEZONE = 'America/Toronto';
function validateDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)!==s) throw new Error(`Invalid date: ${s}`);
  return s;
}
function torontoDate(date = new Date()) {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(p=>[p.type,p.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function shiftDate(s, days) {
  validateDate(s); const d=new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10);
}
function formatPageDate(s) {
  return new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(new Date(`${s}T12:00:00Z`));
}
function parsePageDate(s) {
  const m=s.trim().match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  const month=m && ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(m[1])+1;
  if (!m || !month) throw new Error(`Unrecognized page date: ${s}`);
  return validateDate(`${m[3]}-${String(month).padStart(2,'0')}-${m[2].padStart(2,'0')}`);
}
// Never substitute current observations, another station or a multi-day range.
function parseDailyResponse(rawUrl, body) {
  const u=new URL(rawUrl), p=u.searchParams;
  if (u.hostname!=='api.weather.com' || u.pathname!=='/v2/pws/history/daily' || p.get('stationId')!==STATION_ID) return null;
  const start=p.get('startDate') || p.get('date');
  const end=p.get('endDate') || p.get('date');
  if (!/^\d{8}$/.test(start||'') || start!==end) return null;
  const date=validateDate(`${start.slice(0,4)}-${start.slice(4,6)}-${start.slice(6,8)}`);
  if (!Array.isArray(body.observations) || body.observations.length!==1) throw new Error(`Expected one daily summary for ${date}`);
  const o=body.observations[0];
  if (o.stationID!==STATION_ID || o.tz!==TIMEZONE || o.obsTimeLocal?.slice(0,10)!==date) throw new Error(`Daily summary station/timezone/date mismatch for ${date}`);
  const units=p.get('units');
  if (!['m','e'].includes(units)) throw new Error(`Unsupported units: ${units}`);
  const total=o[units==='m'?'metric':'imperial']?.precipTotal;
  if (typeof total!=='number' || !Number.isFinite(total) || total<0) throw new Error(`Invalid daily precipitation for ${date}`);
  return {date,precipitationMm:units==='m'?total:Number((total*25.4).toFixed(3)),precipitationIn:units==='e'?total:Number((total/25.4).toFixed(3))};
}
function latestRecord(records) {
  const dates=Object.keys(records).sort();
  if (!dates.length) throw new Error('No history records');
  return records[dates.at(-1)];
}
function parsePrecipitation(raw) {
  const m=raw.replace(/\s+/g,' ').trim().match(/^(\d+(?:\.\d+)?)\s*(mm|in)$/i);
  if (!m) throw new Error(`Invalid precipitation cell: ${raw}`);
  const value=Number(m[1]);
  if (!Number.isFinite(value)) throw new Error('Non-finite precipitation');
  return {precipitationMm:m[2].toLowerCase()==='mm'?value:Number((value*25.4).toFixed(3)),precipitationIn:m[2].toLowerCase()==='in'?value:Number((value/25.4).toFixed(3))};
}

const today=torontoDate();
const targetDate=validateDate(process.env.TARGET_DATE?.trim() || shiftDate(today,-1));
if (targetDate>=today) throw new Error(`Only completed local days are supported: ${targetDate}`);
const url=`https://www.wunderground.com/dashboard/pws/${STATION_ID}/graph/${targetDate}/${targetDate}/daily`;
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let result;
try {
  for (let attempt=1;attempt<=3;attempt++) {
    const context=await browser.newContext({locale:'en-US',timezoneId:TIMEZONE});
    const page=await context.newPage();
    page.setDefaultTimeout(30000);
    const summaries=new Map(), diagnostics=[];
    page.on('response',async response=>{
      const endpoint=new URL(response.url());
      if (endpoint.hostname!=='api.weather.com' || endpoint.pathname!=='/v2/pws/history/daily') return;
      // Only record non-secret diagnostics, never the site's API key.
      diagnostics.push({status:response.status(),startDate:endpoint.searchParams.get('startDate'),endDate:endpoint.searchParams.get('endDate'),units:endpoint.searchParams.get('units')});
      try {
        if (!response.ok()) return;
        const summary=parseDailyResponse(response.url(),await response.json());
        if (summary) summaries.set(summary.date,summary);
      } catch(error) {diagnostics.push({error:error.message});}
    });
    try {
      console.log(`Attempt ${attempt}: Toronto today=${today}; target=${targetDate}`);
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
      await page.getByRole('heading',{name:new RegExp(STATION_ID),level:1}).waitFor();
      const label=page.locator('.date-nav-group .date-label');
      const legacyDate=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'long',day:'numeric',year:'numeric'}).format(new Date(`${targetDate}T12:00:00Z`));
      const legacyLabel=page.getByText(legacyDate,{exact:true}).first();
      await label.or(legacyLabel).first().waitFor({state:'visible',timeout:60000});
      const isNewSite=await label.isVisible();
      if (isNewSite) {
        let displayed=parsePageDate(await label.innerText());
        console.log(`Initial displayed date: ${displayed}`);
        // New WU can ignore the URL date. Navigate from the actual displayed day.
        for (let step=0;displayed!==targetDate;step++) {
          if (step>=90) throw new Error('Date navigation exceeded 90 days');
          const direction=displayed<targetDate?1:-1;
          const expected=shiftDate(displayed,direction);
          await page.getByRole('button',{name:direction===1?'Forward':'Back',exact:true}).click();
          await page.waitForFunction(({selector,previous})=>{
            const text=document.querySelector(selector)?.textContent?.trim();
            return text && text!==previous;
          },{selector:'.date-nav-group .date-label',previous:formatPageDate(displayed)});
          displayed=parsePageDate(await label.innerText());
          if (displayed!==expected) throw new Error(`Unexpected navigation: expected ${expected}, got ${displayed}`);
          console.log(`Displayed date: ${displayed}`);
        }
      } else {
        console.log(`Legacy site displayed target date: ${legacyDate}`);
        // Legacy summaries are server-rendered; validate the dated heading.
        const summaryHeading=page.getByRole('heading').filter({hasText:'Summary'}).filter({hasText:legacyDate});
        await summaryHeading.waitFor();
        if (await page.locator('#modeSelect').inputValue()!=='daily') throw new Error('Legacy page is not in daily mode');
        const row=page.getByRole('row').filter({has:page.getByText('Precipitation',{exact:true})});
        await row.waitFor();
        const cells=await row.locator('th, td').allInnerTexts();
        if (cells.length!==4 || cells[0].trim()!=='Precipitation') throw new Error('Unexpected legacy precipitation row');
        summaries.set(targetDate,{date:targetDate,...parsePrecipitation(cells[1])});
      }
      // A changed title alone is insufficient on the new site. Require the
      // exact day's validated response so a stale table cannot be saved.
      const deadline=Date.now()+60000;
      while (!summaries.has(targetDate) && Date.now()<deadline) await sleep(250);
      if (!summaries.has(targetDate)) throw new Error(`No valid daily response for ${targetDate}`);
      if (isNewSite ? parsePageDate(await label.innerText())!==targetDate : !(await legacyLabel.isVisible())) throw new Error('Displayed date changed during capture');
      result=summaries.get(targetDate);
      console.log(`Verified daily precipitation (${isNewSite?'new-site response':'legacy dated summary'}): ${result.date} = ${result.precipitationMm} mm`);
      break;
    } catch(error) {
      fs.mkdirSync('diagnostics',{recursive:true});
      const prefix=`diagnostics/${targetDate}-attempt-${attempt}`;
      fs.writeFileSync(`${prefix}.json`,JSON.stringify({targetDate,pageUrl:page.url(),error:error.message,responses:diagnostics},null,2));
      await page.screenshot({path:`${prefix}.png`,fullPage:true}).catch(()=>{});
      fs.writeFileSync(`${prefix}.txt`,await page.locator('body').innerText({timeout:5000}).catch(()=>''));
      console.error(`Attempt ${attempt} failed: ${error.message}`);
      if (attempt===3) throw error;
    } finally {await context.close();}
    await sleep(3000*attempt);
  }
} finally {await browser.close();}

if (!result) throw new Error('No verified result');
const record={date:targetDate,stationId:STATION_ID,precipitationIn:result.precipitationIn,precipitationMm:result.precipitationMm,sourceUrl:url,capturedAt:new Date().toISOString()};
fs.mkdirSync('data',{recursive:true});
const history=fs.existsSync('data/history.json')?JSON.parse(fs.readFileSync('data/history.json','utf8')):{stationId:STATION_ID,timezone:TIMEZONE,records:{}};
if (history.stationId!==STATION_ID || history.timezone!==TIMEZONE || !history.records) throw new Error('Invalid history metadata');
history.records[targetDate]=record;
// Backfilling an older day must not move latest.json backwards.
for (const [name,value] of [['history',history],['latest',latestRecord(history.records)]]) {
  const file=`data/${name}.json`;
  fs.writeFileSync(`${file}.tmp`,JSON.stringify(value,null,2)+'\n');
  fs.renameSync(`${file}.tmp`,file);
}
const saved=JSON.parse(fs.readFileSync('data/history.json','utf8')).records[targetDate];
if (saved.date!==targetDate || saved.precipitationMm!==result.precipitationMm) throw new Error('Written data verification failed');
console.log(`SUCCESS: ${targetDate} = ${record.precipitationIn} in = ${record.precipitationMm} mm`);

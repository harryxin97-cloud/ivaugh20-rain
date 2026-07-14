import { chromium } from "playwright";
import fs from "node:fs";

const STATION_ID = "IVAUGH20";
const TIMEZONE = "America/Toronto";
const HISTORY_FILE = "data/history.json";

function getTorontoDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter(p => p.type !== "literal")
      .map(p => [p.type, p.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

// 手动测试时使用 TARGET_DATE。
// 自动运行时默认抓“昨天”的完整 Daily Summary。
const targetDate =
  process.env.TARGET_DATE ||
  getTorontoDate(new Date(Date.now() - 12 * 60 * 60 * 1000));

const url =
  `https://www.wunderground.com/dashboard/pws/` +
  `${STATION_ID}/graph/${targetDate}/${targetDate}/daily`;

console.log(`Target date: ${targetDate}`);
console.log(`URL: ${url}`);

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: TIMEZONE
  });

  const page = await context.newPage();

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 90000
  });

  await page.waitForTimeout(10000);

  const bodyText = await page.locator("body").innerText();

  if (!bodyText.includes(STATION_ID)) {
    throw new Error(`没有确认到目标气象站 ${STATION_ID}`);
  }

  const match = bodyText.match(
    /Summary[\s\S]{0,8000}?Precipitation\s+([0-9]+(?:\.[0-9]+)?)\s*(?:°\s*)?in\b/i
  );

  if (!match) {
    throw new Error(
      "没有读取到明确的 Daily Summary Precipitation 数字，不记录为 0"
    );
  }

  const precipitationIn = Number(match[1]);

  if (!Number.isFinite(precipitationIn) || precipitationIn < 0) {
    throw new Error(`异常降水值：${match[1]}`);
  }

  const precipitationMm =
    Number((precipitationIn * 25.4).toFixed(3));

  const record = {
    date: targetDate,
    stationId: STATION_ID,
    precipitationIn,
    precipitationMm,
    sourceUrl: url,
    capturedAt: new Date().toISOString()
  };

  fs.mkdirSync("data", { recursive: true });

  let history = {
    stationId: STATION_ID,
    timezone: TIMEZONE,
    records: {}
  };

  if (fs.existsSync(HISTORY_FILE)) {
    history = JSON.parse(
      fs.readFileSync(HISTORY_FILE, "utf8")
    );
  }

  history.records[targetDate] = record;

  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(history, null, 2) + "\n"
  );

  fs.writeFileSync(
    "data/latest.json",
    JSON.stringify(record, null, 2) + "\n"
  );

  console.log(
    `SUCCESS: ${targetDate} = ${precipitationIn} in = ${precipitationMm} mm`
  );
} finally {
  await browser.close();
}

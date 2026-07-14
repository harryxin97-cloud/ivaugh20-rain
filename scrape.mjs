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
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function shiftCalendarDate(isoDate, days) {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    throw new Error(`日期格式错误：${isoDate}`);
  }

  const [, year, month, day] = match;

  const date = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );

  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

function validateDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new Error(
      `TARGET_DATE 必须是 YYYY-MM-DD，当前值：${isoDate}`,
    );
  }

  const normalized = new Date(
    `${isoDate}T00:00:00Z`,
  ).toISOString().slice(0, 10);

  if (normalized !== isoDate) {
    throw new Error(`无效日期：${isoDate}`);
  }
}

// 手动运行：使用 TARGET_DATE。
// 自动运行：严格取 America/Toronto 的“前一个自然日”。
const manualTargetDate = process.env.TARGET_DATE?.trim();

const torontoToday = getTorontoDate(new Date());

const targetDate =
  manualTargetDate ||
  shiftCalendarDate(torontoToday, -1);

validateDate(targetDate);

const url =
  `https://www.wunderground.com/dashboard/pws/` +
  `${STATION_ID}/graph/${targetDate}/${targetDate}/daily`;

console.log(`Toronto today: ${torontoToday}`);
console.log(`Target date: ${targetDate}`);
console.log(`URL: ${url}`);

const browser = await chromium.launch({
  headless: true,
});

try {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: TIMEZONE,
  });

  const page = await context.newPage();

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  await page.waitForTimeout(10000);

  const bodyText =
    await page.locator("body").innerText();

  if (!bodyText.includes(STATION_ID)) {
    throw new Error(
      `没有确认到目标气象站 ${STATION_ID}`,
    );
  }

  const match = bodyText.match(
    /Summary[\s\S]{0,8000}?Precipitation\s+([0-9]+(?:\.[0-9]+)?)\s*(?:°\s*)?in\b/i,
  );

  if (!match) {
    throw new Error(
      "没有读取到明确的 Daily Summary Precipitation 数字，不记录为 0",
    );
  }

  const precipitationIn = Number(match[1]);

  if (
    !Number.isFinite(precipitationIn) ||
    precipitationIn < 0
  ) {
    throw new Error(
      `异常降水值：${match[1]}`,
    );
  }

  const precipitationMm = Number(
    (precipitationIn * 25.4).toFixed(3),
  );

  const record = {
    date: targetDate,
    stationId: STATION_ID,
    precipitationIn,
    precipitationMm,
    sourceUrl: url,
    capturedAt: new Date().toISOString(),
  };

  fs.mkdirSync("data", {
    recursive: true,
  });

  let history = {
    stationId: STATION_ID,
    timezone: TIMEZONE,
    records: {},
  };

  if (fs.existsSync(HISTORY_FILE)) {
    history = JSON.parse(
      fs.readFileSync(HISTORY_FILE, "utf8"),
    );
  }

  history.records[targetDate] = record;

  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(history, null, 2) + "\n",
  );

  fs.writeFileSync(
    "data/latest.json",
    JSON.stringify(record, null, 2) + "\n",
  );

  // 写入后立即自检。
  // 目标日期不存在或字段异常时，让 GitHub Action 直接失败。
  const savedHistory = JSON.parse(
    fs.readFileSync(HISTORY_FILE, "utf8"),
  );

  const savedRecord =
    savedHistory.records?.[targetDate];

  if (
    !savedRecord ||
    savedRecord.stationId !== STATION_ID ||
    savedRecord.date !== targetDate ||
    !Number.isFinite(
      savedRecord.precipitationMm,
    )
  ) {
    throw new Error(
      `写入后验证失败：${targetDate}`,
    );
  }

  console.log(
    `SUCCESS: ${targetDate} = ${precipitationIn} in = ${precipitationMm} mm`,
  );
} finally {
  await browser.close();
}

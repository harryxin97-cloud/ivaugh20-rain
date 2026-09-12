import { chromium } from "playwright";
import fs from "node:fs";

const STATION_ID = "IVAUGH20";
const TIMEZONE = "America/Toronto";
const HISTORY_FILE = "data/history.json";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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

function calendarDayDifference(laterIsoDate, earlierIsoDate) {
  const later = Date.parse(`${laterIsoDate}T00:00:00Z`);
  const earlier = Date.parse(`${earlierIsoDate}T00:00:00Z`);
  return Math.round((later - earlier) / ONE_DAY_MS);
}

function formatPageDate(isoDate) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function parsePrecipitationTotal(rawValue) {
  const normalized = rawValue.replace(/\*/g, "").trim();
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*(in|mm)$/i);
  if (!match) {
    throw new Error(`无法解析降水总量：${rawValue}`);
  }

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`异常降水值：${rawValue}`);
  }

  if (unit === "in") {
    return {
      precipitationIn: value,
      precipitationMm: Number((value * 25.4).toFixed(3)),
    };
  }

  return {
    precipitationIn: Number((value / 25.4).toFixed(3)),
    precipitationMm: value,
  };
}

// 手动运行：使用 TARGET_DATE。
// 自动运行：严格取 America/Toronto 的“前一个自然日”。
const manualTargetDate = process.env.TARGET_DATE?.trim();
const torontoToday = getTorontoDate(new Date());
const targetDate = manualTargetDate || shiftCalendarDate(torontoToday, -1);
validateDate(targetDate);

const daysBack = calendarDayDifference(torontoToday, targetDate);
if (daysBack < 0) {
  throw new Error(`不能抓取未来日期：${targetDate}`);
}

const url =
  `https://www.wunderground.com/dashboard/pws/` +
  `${STATION_ID}/graph/${targetDate}/${targetDate}/daily`;
const targetPageDate = formatPageDate(targetDate);

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

  const bodyText = await page.locator("body").innerText();
  if (!bodyText.includes(STATION_ID)) {
    throw new Error(`没有确认到目标气象站 ${STATION_ID}`);
  }

  // Weather Underground 目前会忽略 URL 中的历史日期并先显示今天。
  // 兼容旧行为：如果目标日期已经显示，则不进行额外导航。
  const targetDateLocator = page.getByText(targetPageDate, { exact: true });
  if (!(await targetDateLocator.isVisible())) {
    const todayPageDate = formatPageDate(torontoToday);
    const todayDateLocator = page.getByText(todayPageDate, { exact: true });
    if (!(await todayDateLocator.isVisible())) {
      throw new Error(
        `页面既未显示目标日期 ${targetPageDate}，也未显示今天 ${todayPageDate}`,
      );
    }

    const backButton = page.getByRole("button", {
      name: "Back",
      exact: true,
    });
    for (let offset = 1; offset <= daysBack; offset += 1) {
      const expectedDate = shiftCalendarDate(torontoToday, -offset);
      const expectedPageDate = formatPageDate(expectedDate);
      await backButton.click();
      await page
        .getByText(expectedPageDate, { exact: true })
        .waitFor({ state: "visible", timeout: 30000 });
    }
  }

  await targetDateLocator.waitFor({ state: "visible", timeout: 30000 });
  console.log(`Displayed date: ${targetPageDate}`);

  const precipitationRows = page
    .getByRole("row")
    .filter({ hasText: /Precipitation Accumulation/i });
  const rowCount = await precipitationRows.count();
  if (rowCount !== 1) {
    throw new Error(
      `预期找到 1 个 Precipitation Accumulation 表格行，实际找到 ${rowCount} 个`,
    );
  }

  const cells = (
    await precipitationRows.locator("th, td").allTextContents()
  ).map((cell) => cell.replace(/\s+/g, " ").trim());
  if (cells.length < 2) {
    throw new Error(`降水表格行结构异常：${cells.join(" | ")}`);
  }

  console.log(`Precipitation row: ${cells.join(" | ")}`);
  const { precipitationIn, precipitationMm } = parsePrecipitationTotal(
    cells.at(-1),
  );

  const record = {
    date: targetDate,
    stationId: STATION_ID,
    precipitationIn,
    precipitationMm,
    sourceUrl: url,
    capturedAt: new Date().toISOString(),
  };

  fs.mkdirSync("data", { recursive: true });

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
  const savedRecord = savedHistory.records?.[targetDate];
  if (
    !savedRecord ||
    savedRecord.stationId !== STATION_ID ||
    savedRecord.date !== targetDate ||
    !Number.isFinite(savedRecord.precipitationMm)
  ) {
    throw new Error(`写入后验证失败：${targetDate}`);
  }

  console.log(
    `SUCCESS: ${targetDate} = ${precipitationIn} in = ${precipitationMm} mm`,
  );
} finally {
  await browser.close();
}

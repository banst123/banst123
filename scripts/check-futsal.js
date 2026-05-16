import puppeteer from "puppeteer";

// ===== 설정 영역 =====

// 풋살 1~4구장 (part는 모두 05, placeId는 안드로이드 기준)
const placeNames = ["풋살1구장", "풋살2구장", "풋살3구장", "풋살4구장"];
const placeParts = ["05", "05", "05", "05"];
const placeIds   = ["6",  "7",  "8",  "9"]; // 1~4구장 place id

// 모니터링 대상 요일: 월(1), 목(4), 금(5)
const TARGET_WEEKDAYS = [1, 4, 5]; // 월, 목, 금
const WEEKS_AHEAD = 4;

// 연속 조건 대상 회차/시간
const TARGET_SESSIONS = ["14회", "15회", "16회"]; // 14·15·16회 (19~21시)
const TARGET_START_HOURS = [19, 20, 21];          // 19, 20, 21시 시작

// ===== 날짜 유틸 =====

function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function formatDatePretty(dateStr) {
  try {
    const yyyy = parseInt(dateStr.slice(0, 4), 10);
    const mm = parseInt(dateStr.slice(4, 6), 10) - 1;
    const dd = parseInt(dateStr.slice(6, 8), 10);
    const d = new Date(yyyy, mm, dd);
    const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
    const day = dayNames[d.getDay()];
    const mmStr = String(mm + 1).padStart(2, "0");
    const ddStr = String(dd).padStart(2, "0");
    return `${mmStr}/${ddStr}(${day})`;
  } catch {
    return dateStr;
  }
}

// 오늘 기준: 내일~4주 뒤까지 중에서 월·목·금만 추출
function getTargetDates() {
  const dates = [];
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() + 1); // 내일부터

  const end = new Date(start);
  end.setDate(end.getDate() + WEEKS_AHEAD * 7); // 4주간

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay(); // 0=일, 1=월, ..., 6=토
    if (TARGET_WEEKDAYS.includes(dow)) {
      dates.push(formatDate(d));
    }
  }
  return dates;
}

// 예약 페이지 URL 생성
function buildUrl(date, placeIndex) {
  const part = placeParts[placeIndex];
  const place = placeIds[placeIndex];
  return `https://www.bnfmc.or.kr/reservation/www/9?facilities_type=T&base_date=${date}&rent_type=1001&center=NAMGUSPORTS02&part=${part}&place=${place}#regist_list`;
}

// ===== Puppeteer 설정 유틸 =====

async function preparePage(browser) {
  const page = await browser.newPage();

  // 불필요 리소스 차단 (이미지, CSS, 폰트, 미디어)
  await page.setRequestInterception(true);
  const blockedTypes = new Set(["image", "stylesheet", "font", "media"]);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (blockedTypes.has(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36"
  );

  return page;
}

// ===== Puppeteer에서 한 날짜+구장 처리 (원시 데이터 수집) =====
//
// 실제 DOM 구조:
//   <td><label>14회</label></td>
//   <td><label>19:00~20:00</label></td>
//   <td>예약가능</td>
//
// → cells[0] = "14회"
//   cells[1] = "19:00~20:00"
//   cells[2] = "예약가능"

async function collectSlotsForPage(page, url) {
  console.log(`    [브라우저] 페이지 로딩: ${url}`);

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // 예약 테이블이 렌더될 때까지 대기 (최대 10초)
  await page.waitForSelector("table", { timeout: 10000 }).catch(() => {});

  const rawSlots = await page.evaluate(
    (TARGET_SESSIONS, TARGET_START_HOURS) => {
      const result = [];

      const tables = Array.from(document.querySelectorAll("table"));
      let targetTable = null;
      for (const tbl of tables) {
        const headerText = tbl.innerText || "";
        if (
          headerText.includes("회차") &&
          headerText.includes("시간") &&
          headerText.includes("예약상태")
        ) {
          targetTable = tbl;
          break;
        }
      }

      if (!targetTable) {
        console.log("[eval] 예약 테이블을 찾지 못함");
        return result;
      }

      const rows = Array.from(targetTable.querySelectorAll("tr"));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("th,td")).map((c) =>
          (c.innerText || "").trim()
        );
        if (cells.length < 3) continue;

        // 헤더 행 건너뛰기
        const joined = cells.join(" ");
        if (joined.includes("회차") && joined.includes("시간")) {
          continue;
        }

        // 현재 구조 가정:
        // cells[0] = "14회"
        // cells[1] = "19:00~20:00"
        // cells[2] = "예약가능" 또는 "예약완료"
        const sessionText = cells[0];
        const timeText = cells[1];
        const statusText = cells[2];

        // 회차: 공백 제거 후 14·15·16회만
        const normalizedSession = sessionText.replace(/\s/g, "");
        if (!TARGET_SESSIONS.includes(normalizedSession)) {
          continue;
        }

        // 시간에서 시작 시각 추출
        const m = timeText.match(/^(\d{2}):\d{2}/);
        if (!m) continue;
        const startHour = parseInt(m[1], 10);
        if (!TARGET_START_HOURS.includes(startHour)) {
          continue;
        }

        // 상태: 공백 제거 후 "예약가능"만
        const normalizedStatus = statusText.replace(/\s/g, "");
        if (normalizedStatus !== "예약가능") {
          continue;
        }

        result.push({
          session: normalizedSession, // "14회", "15회", "16회"
          time: timeText,
          status: "예약가능",
        });
      }

      return result;
    },
    TARGET_SESSIONS,
    TARGET_START_HOURS
  );

  console.log(
    `    [브라우저] 14·15·16회(19~21시) 예약가능 슬롯 수(단일): ${rawSlots.length}`
  );

  return rawSlots;
}

// ===== 연속 2시간 이상 조건 후처리 =====

// rawAlerts: [{ date, placeIndex, placeName, slots: [ {session,time,status}, ... ] }, ...]
function applyTwoHourRule(rawAlerts) {
  const sessionOrder = { "14회": 14, "15회": 15, "16회": 16 };
  const finalAlerts = [];

  for (const alert of rawAlerts) {
    if (!alert.slots || alert.slots.length === 0) continue;

    const sorted = alert.slots
      .slice()
      .sort((a, b) => sessionOrder[a.session] - sessionOrder[b.session]);

    const used = new Set();
    const selected = [];

    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i];
      const next = sorted[i + 1];
      const curNo = sessionOrder[cur.session];
      const nextNo = sessionOrder[next.session];

      // 회차 번호가 1 차이날 때 (14-15, 15-16)
      if (nextNo === curNo + 1) {
        if (!used.has(cur.session)) {
          selected.push(cur);
          used.add(cur.session);
        }
        if (!used.has(next.session)) {
          selected.push(next);
          used.add(next.session);
        }
      }
    }

    if (selected.length > 0) {
      finalAlerts.push({
        ...alert,
        slots: selected, // 연속 2시간 이상 조건을 만족하는 슬롯만
      });
    }
  }

  return finalAlerts;
}

// ===== 메인 =====

async function main() {
  const dates = getTargetDates(); // 내일부터 4주간, 월·목·금만
  console.log("=== Puppeteer 기반 풋살1~4 예약 체크 시작 (월/목/금, 14~16회 연속 2시간 이상, 예약가능만) ===");
  console.log(`대상 날짜 수: ${dates.length}일`);
  console.log(`구장: ${placeNames.join(", ")}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--mute-audio",
    ],
  });

  const rawAlerts = [];

  try {
    for (const date of dates) {
      console.log(`\n[날짜] ${date} (${formatDatePretty(date)}) 처리 시작`);

      // 이 날짜에 대해 1~4구장을 동시에 처리
      const tasks = placeNames.map(async (_name, pIdx) => {
        const page = await preparePage(browser);
        try {
          const url = buildUrl(date, pIdx);
          console.log(`  [구장] ${placeNames[pIdx]} URL: ${url}`);

          const slots = await collectSlotsForPage(page, url);
          if (slots.length > 0) {
            rawAlerts.push({
              date,
              placeIndex: pIdx,
              placeName: placeNames[pIdx],
              slots,
            });
          }
        } catch (e) {
          console.error(
            `  ! Puppeteer 에러 (${date} ${placeNames[pIdx]}):`,
            e.message
          );
        } finally {
          await page.close();
        }
      });

      await Promise.all(tasks);
    }
  } finally {
    await browser.close();
  }

  // 연속 2시간 이상 조건 한 번만 적용
  const alerts = applyTwoHourRule(rawAlerts);

  let available = false;
  let message = "";

  if (alerts.length > 0) {
    available = true;
    const lines = [];
    lines.push("▣ 백운포 풋살1~4구장 예약 가능 알림 (월·목·금, 14~16회 중 연속 2시간 이상) ▣");
    lines.push("");

    for (const alert of alerts) {
      const dateTitle = formatDatePretty(alert.date);
      lines.push(`▶️ ${dateTitle} ${alert.placeName}`);
      for (const s of alert.slots) {
        lines.push(`- ${s.session} ${s.time}: ${s.status}`);
      }
      lines.push("");
    }

    message = lines.join("\n");
  } else {
    available = false;
    message =
      "현재(풋살1~4구장, 내일부터 4주간 월·목·금, 14~16회/19~21시 중 연속 2시간 이상)에 예약 가능 슬롯이 없습니다.";
  }

  console.log("\n=== 결과 요약 ===");
  console.log(message);

  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const fs = await import("fs");
    fs.appendFileSync(ghOutput, `available=${available}\n`);
    fs.appendFileSync(ghOutput, `message<<EOF\n${message}\nEOF\n`);
  }
}

main().catch((e) => {
  console.error("check-futsal.js failed:", e);
  process.exit(1);
});

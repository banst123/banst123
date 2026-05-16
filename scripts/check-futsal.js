import puppeteer from "puppeteer";

// ==========================
// 설정
// ==========================

// 풋살 1~4구장
const placeNames = ["풋살1구장", "풋살2구장", "풋살3구장", "풋살4구장"];
const placeIds   = ["6", "7", "8", "9"]; // place 파라미터 값

// 모니터링: 내일부터 4주간, 월(1)·목(4)·금(5)
const TARGET_WEEKDAYS    = [1, 4, 5];
const WEEKS_AHEAD        = 4;

// 14·15·16회 (19~21시)
const TARGET_SESSIONS    = ["14회", "15회", "16회"];
const TARGET_START_HOURS = [19, 20, 21];

// ==========================
// 날짜 유틸
// ==========================

function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const dd   = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function formatDatePretty(dateStr) {
  try {
    const yyyy = parseInt(dateStr.slice(0, 4), 10);
    const mm   = parseInt(dateStr.slice(4, 6), 10) - 1;
    const dd   = parseInt(dateStr.slice(6, 8), 10);
    const d    = new Date(yyyy, mm, dd);
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    return `${String(mm + 1).padStart(2, "0")}/${String(dd).padStart(2, "0")}(${days[d.getDay()]})`;
  } catch {
    return dateStr;
  }
}

function getTargetDates() {
  const out = [];
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() + 1); // 내일부터

  const end = new Date(start);
  end.setDate(end.getDate() + WEEKS_AHEAD * 7);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (TARGET_WEEKDAYS.includes(d.getDay())) {
      out.push(formatDate(d));
    }
  }
  return out;
}

// 예약 페이지 URL
function buildUrl(date, placeIndex) {
  const place = placeIds[placeIndex];
  // center=NAMGUSPORTS02, part=05, rent_type=1001 고정
  return `https://www.bnfmc.or.kr/reservation/www/9?facilities_type=T&base_date=${date}&rent_type=1001&center=NAMGUSPORTS02&part=05&place=${place}#regist_list`;
}

// ==========================
// Puppeteer 준비
// ==========================

async function preparePage(browser) {
  const page = await browser.newPage();

  // 성공했을 때와 유사한 일반 PC UA
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  );

  // 불필요한 차단은 하지 않음 (JS/CSS/이미지 그대로)
  return page;
}

// ==========================
// 한 페이지에서 슬롯 수집
// ==========================
// DOM 구조(PC 기준):
// <td>
//   <input type="checkbox" id="checkbox_time_13" ... >
//   <label for="checkbox_time_13">14회</label>
// </td>
// <td>
//   <label for="checkbox_time_13">19:00~20:00</label>
// </td>
// <td>예약가능</td>
// ...

async function collectSlotsForPage(page, url) {
  console.log(`    [브라우저] 페이지 로딩: ${url}`);

  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  // 리스트가 JS로 렌더링되므로, 살짝 대기
  await page.waitForTimeout(1000);

  const rawSlots = await page.evaluate(
    (TARGET_SESSIONS, TARGET_START_HOURS) => {
      const result = [];

      // "회차 / 시간 / 예약상태" 헤더를 가진 테이블 찾기
      const tables = Array.from(document.querySelectorAll("table"));
      let targetTable = null;
      for (const tbl of tables) {
        const txt = tbl.innerText || "";
        if (txt.includes("회차") && txt.includes("시간") && txt.includes("예약상태")) {
          targetTable = tbl;
          break;
        }
      }
      if (!targetTable) {
        console.log("[eval] 예약 테이블 없음");
        return result;
      }

      const rows = Array.from(targetTable.querySelectorAll("tr"));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("th,td")).map((c) =>
          (c.innerText || "").trim()
        );
        if (cells.length < 3) continue;

        const joined = cells.join(" ");
        if (joined.includes("회차") && joined.includes("시간")) {
          // 헤더 행
          continue;
        }

        // 구조 가정:
        // cells[0] = "14회"
        // cells[1] = "19:00~20:00"
        // cells[2] = "예약가능" / "예약완료"
        const sessionText = cells[0];
        const timeText    = cells[1];
        const statusText  = cells[2];

        const normalizedSession = sessionText.replace(/\s/g, "");
        if (!TARGET_SESSIONS.includes(normalizedSession)) continue;

        const m = timeText.match(/^(\d{2}):\d{2}/);
        if (!m) continue;
        const startHour = parseInt(m[1], 10);
        if (!TARGET_START_HOURS.includes(startHour)) continue;

        const normalizedStatus = statusText.replace(/\s/g, "");
        if (normalizedStatus !== "예약가능") continue;

        result.push({
          session: normalizedSession,
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

// ==========================
// 연속 2시간 이상 필터링
// ==========================

function applyTwoHourRule(rawAlerts) {
  const order = { "14회": 14, "15회": 15, "16회": 16 };
  const finalAlerts = [];

  for (const alert of rawAlerts) {
    if (!alert.slots || alert.slots.length === 0) continue;

    const sorted = alert.slots
      .slice()
      .sort((a, b) => order[a.session] - order[b.session]);

    const used = new Set();
    const selected = [];

    for (let i = 0; i < sorted.length - 1; i++) {
      const cur  = sorted[i];
      const next = sorted[i + 1];
      if (order[next.session] === order[cur.session] + 1) {
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
        slots: selected,
      });
    }
  }

  return finalAlerts;
}

// ==========================
// 메인
// ==========================

async function main() {
  const dates = getTargetDates();

  console.log("=== Puppeteer 기반 풋살1~4 예약 체크 시작 (월/목/금, 14~16회 연속 2시간 이상, 예약가능만) ===");
  console.log(`대상 날짜 수: ${dates.length}일`);
  console.log(`구장: ${placeNames.join(", ")}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const rawAlerts = [];

  try {
    for (const date of dates) {
      console.log(`\n[날짜] ${date} (${formatDatePretty(date)}) 처리 시작`);

      const tasks = placeNames.map(async (_name, idx) => {
        const page = await preparePage(browser);
        try {
          const url = buildUrl(date, idx);
          console.log(`  [구장] ${placeNames[idx]} URL: ${url}`);

          const slots = await collectSlotsForPage(page, url);
          if (slots.length > 0) {
            rawAlerts.push({
              date,
              placeIndex: idx,
              placeName: placeNames[idx],
              slots,
            });
          }
        } catch (e) {
          console.error(`  ! 에러 (${date} ${placeNames[idx]}):`, e.message);
        } finally {
          await page.close();
        }
      });

      await Promise.all(tasks);
    }
  } finally {
    await browser.close();
  }

  const alerts = applyTwoHourRule(rawAlerts);

  let available = false;
  let message   = "";

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

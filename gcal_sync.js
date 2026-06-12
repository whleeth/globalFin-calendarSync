/**
 * ====================================================================
 * 國際金融財經日曆 - Google 日曆雲端自動同步腳本
 * ====================================================================
 * 功能特點：
 * 1. 雲端自動執行：免開電腦，可設定每天/每小時自動同步。
 * 2. 簡轉繁中文：呼叫 zhconvert.org API 進行轉換，任何字都能正確處理，不依賴字典。
 * 3. 變更偵測與警示 (Alert)：自動偵測未來日程的時間或預測值變更，
 *    並將事件變更為「橘色」，標題加上 ⚠️，並在描述中詳細記錄變更內容。
 * 4. 防重複寫入：自動識別事件 ID，只做更新不重複建立。
 * 5. 速率控制：每次寫入後微停頓，避免觸發 Google Calendar API 速率限制。
 */

// === 客製化設定區 ===
var CONFIG = {
  CALENDAR_NAME: "國際金融財經日曆", // 寫入的日曆名稱（若不存在會自動建立）
  MIN_IMPORTANCE: 2,               // 最低重要度 (2 星及以上)
  DAYS_BACK: 7,                    // 同步過去幾天的數據 (便於更新公佈值)
  DAYS_FORWARD: 14,                // 同步未來幾天的數據

  // 篩選關心的國家/地區
  COUNTRIES: [
    "美国", "中国", "欧元区", "日本", "英国", "德国", "法国", "意大利", "加拿大", "澳大利亚", "新西兰", "瑞士", "中国台湾", "中国香港"
  ],

  // 事件類型：FD = 總經數據發布，FE = 央行會議、財報電話會、重要事件
  CALENDAR_TYPES: ["FD", "FE"]
};

// === 國旗 Emoji 對照表（key 維持簡體，因為 API 回傳簡體國家名）===
var FLAG_MAP = {
  "美国": "🇺🇸", "中国": "🇨🇳", "日本": "🇯🇵", "英国": "🇬🇧", "德国": "🇩🇪", "法国": "🇫🇷", "欧元区": "🇪🇺",
  "加拿大": "🇨🇦", "澳大利亚": "🇦🇺", "新西兰": "🇳🇿", "瑞士": "🇨🇭", "中国台湾": "🇹🇼", "台湾": "🇹🇼",
  "中国香港": "🇭🇰", "香港": "🇭🇰", "意大利": "🇮🇹", "韩国": "🇰🇷", "比利时": "🇧🇪"
};

/**
 * 簡體轉繁體中文
 * 使用 zhconvert.org API，任何字都能正確轉換，不依賴手工字典。
 * API 失敗時自動 fallback 回傳原文，不會造成程式中斷。
 */
function toTraditional(text) {
  if (!text) return "";

  try {
    var url = "https://api.zhconvert.org/convert?converter=Traditional&text=" + encodeURIComponent(text);
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

    if (response.getResponseCode() === 200) {
      var result = JSON.parse(response.getContentText());
      if (result.code === 0 && result.data && result.data.text) {
        return result.data.text;
      }
    }
    Logger.log("zhconvert API 回應異常，使用原文: " + text);
  } catch (e) {
    Logger.log("zhconvert API 呼叫失敗，使用原文: " + e);
  }

  // fallback：API 失敗時直接回傳原文，不會轉錯也不會當掉
  return text;
}

/**
 * 主進入點：同步日曆函數。
 * 可以在 Apps Script 中設定「時間驅動觸發器」每天/每小時自動執行此函數。
 */
function syncFinancialCalendar() {
  Logger.log("=== 開始同步國際金融財經日曆 ===");

  // 1. 取得或建立日曆
  var calendar = getOrCreateCalendar();

  // 2. 計算同步的時間範圍
  var now = new Date();
  var startDate = new Date(now.getTime() - CONFIG.DAYS_BACK * 24 * 3600 * 1000);
  var endDate = new Date(now.getTime() + CONFIG.DAYS_FORWARD * 24 * 3600 * 1000);

  var startTs = Math.floor(startDate.getTime() / 1000);
  var endTs = Math.floor(endDate.getTime() / 1000);

  Logger.log("時間範圍: " + formatDate(startDate) + " 至 " + formatDate(endDate));

  // 3. 從 API 抓取數據 (7 天為一小段抓取以防 API 限制)
  var rawEvents = fetchEventsChunked(startTs, endTs);
  Logger.log("從 API 下載原始事件共: " + rawEvents.length + " 筆");

  // 4. 抓取日曆中現有的事件，建立 ID 映射表，避免重複寫入
  var existingEvents = calendar.getEvents(startDate, endDate);
  var existingEventMap = {};

  existingEvents.forEach(function(event) {
    var wscnId = getEventWscnId(event);
    if (wscnId) {
      existingEventMap[wscnId] = event;
    }
  });
  Logger.log("日曆現有對應事件: " + Object.keys(existingEventMap).length + " 筆");

  // 5. 轉換與寫入日曆
  var countriesSet = new Set(CONFIG.COUNTRIES);
  var typesSet = new Set(CONFIG.CALENDAR_TYPES);

  var createdCount = 0;
  var updatedCount = 0;
  var alertCount = 0;
  var skippedCount = 0;

  rawEvents.forEach(function(item) {
    var country = item.country || "";
    var importance = item.importance || 1;
    var calendarType = item.calendar_type || "FD";

    // 過濾國家、重要性與類型
    if (CONFIG.COUNTRIES.length > 0 && !countriesSet.has(country)) { skippedCount++; return; }
    if (importance < CONFIG.MIN_IMPORTANCE) { skippedCount++; return; }
    if (!typesSet.has(calendarType)) { skippedCount++; return; }

    var eventId = item.id;
    var publicDate = item.public_date;
    if (!publicDate) return;

    // 事件時間
    var startTime = new Date(publicDate * 1000);
    var endTime = new Date(publicDate * 1000 + 30 * 60 * 1000); // 預設 30 分鐘

    // 繁體中文轉換與標題組裝
    var titleRaw = item.title || item.event || "";
    var titleTrad = toTraditional(titleRaw);
    var countryTrad = toTraditional(country);
    var flag = FLAG_MAP[country] || "🌐";

    var summary = flag + " [" + countryTrad + "] " + titleTrad;

    // 組裝描述內容
    var forecast = item.forecast || "";
    var previous = item.previous || "";
    var actual = item.actual || "";
    var unit = item.unit || "";
    var period = item.period || "";
    var foresight = item.foresight || "";
    var uri = item.uri || "";

    var description = generateDescription(importance, calendarType, period, previous, forecast, actual, unit, foresight, uri, eventId);

    // 檢查日曆中是否已存在該事件
    var existingEvent = existingEventMap[eventId];

    if (!existingEvent) {
      // 1. 不存在 -> 建立新事件
      var newEvent = calendar.createEvent(summary, startTime, endTime, {
        description: description
      });
      newEvent.setColor(CalendarApp.EventColor.BLUE);
      createdCount++;
      Utilities.sleep(500); // 速率控制
    } else {
      // 2. 已存在 -> 檢查是否發生變更
      var changed = false;
      var changeLog = [];

      // 比較時間變更
      if (existingEvent.getStartTime().getTime() !== startTime.getTime()) {
        changed = true;
        var oldTimeStr = formatDate(existingEvent.getStartTime());
        var newTimeStr = formatDate(startTime);
        changeLog.push("發布時間由 " + oldTimeStr + " 變更為 " + newTimeStr);
      }

      // 比較預測值變更
      var oldForecastStr = extractForecastFromDescription(existingEvent.getDescription());
      var newForecastStr = forecast ? forecast + unit : "--";
      if (oldForecastStr !== null && forecast !== "" && oldForecastStr !== newForecastStr) {
        changed = true;
        changeLog.push("預測值由 " + oldForecastStr + " 變更為 " + newForecastStr);
      }

      // 比較標題/事件名變更
      var cleanExistingTitle = existingEvent.getTitle().replace(/⚠️\s*\[.*?\]\s*/, "");
      if (cleanExistingTitle !== summary) {
        changed = true;
        changeLog.push("標題由 '" + cleanExistingTitle + "' 變更為 '" + summary + "'");
      }

      if (changed) {
        // A. 發生日程時間或數值變更 -> 警示 Alert 更新
        var updatedSummary = "⚠️ [日程變更] " + summary;
        existingEvent.setTitle(updatedSummary);
        existingEvent.setTime(startTime, endTime);

        var alertHeader = "⚠️【日程變更警示】偵測到此日程已變更（於 " + formatDate(new Date()) + " 同步時偵測）：\n" +
                           changeLog.map(function(log) { return "• " + log; }).join("\n") +
                           "\n-----------------------------------------------\n\n";

        existingEvent.setDescription(alertHeader + description);
        existingEvent.setColor(CalendarApp.EventColor.ORANGE);
        existingEvent.removeAllReminders();
        existingEvent.addPopupReminder(15);

        alertCount++;
        Logger.log("⚠️ 偵測到日程變更: " + summary + " (" + changeLog.join("; ") + ")");
        Utilities.sleep(500); // 速率控制
      } else {
        // B. 無關鍵日程變更 -> 僅安靜更新內容
        var currentDesc = existingEvent.getDescription() || "";
        var warningMatch = currentDesc.match(/^(⚠️【日程變更警示】[\s\S]*?-----------------------------------------------\n\n)/);
        var warningHeader = warningMatch ? warningMatch[1] : "";
        var cleanExistingDesc = currentDesc.replace(warningHeader, "");

        if (cleanExistingDesc !== description) {
          existingEvent.setDescription(warningHeader + description);
          if (actual !== "" && existingEvent.getColor() !== CalendarApp.EventColor.ORANGE) {
            existingEvent.setColor(CalendarApp.EventColor.GRAY);
          }
          updatedCount++;
          Utilities.sleep(500); // 速率控制
        }
      }
    }
  });

  Logger.log("同步完成！成果統計：");
  Logger.log("- 建立新日程: " + createdCount + " 筆");
  Logger.log("- 偵測並警示變更日程: " + alertCount + " 筆");
  Logger.log("- 安靜更新日程 (如公布數值): " + updatedCount + " 筆");
  Logger.log("- 過濾/跳過日程: " + skippedCount + " 筆");
  Logger.log("=== 同步結束 ===");
}

/**
 * 分段抓取 API 數據，防止超過 20 天的 API 限制
 */
function fetchEventsChunked(startTs, endTs) {
  var chunkSeconds = 7 * 24 * 3600; // 7 天
  var currentStart = startTs;
  var allItems = [];
  var seenIds = new Set();

  var headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  };

  while (currentStart < endTs) {
    var currentEnd = Math.min(currentStart + chunkSeconds, endTs);
    var url = "https://api-one-wscn.awtmt.com/apiv1/finance/macrodatas?start=" + currentStart + "&end=" + currentEnd;

    try {
      var options = {
        "method": "get",
        "headers": headers,
        "muteHttpExceptions": true
      };
      var response = UrlFetchApp.fetch(url, options);
      if (response.getResponseCode() === 200) {
        var resData = JSON.parse(response.getContentText());
        var items = resData.data && resData.data.items ? resData.data.items : [];

        items.forEach(function(item) {
          if (item.id && !seenIds.has(item.id)) {
            seenIds.add(item.id);
            allItems.push(item);
          }
        });
      }
    } catch (e) {
      Logger.log("下載分段數據出錯 (" + currentStart + "): " + e);
    }

    currentStart = currentEnd;
    Utilities.sleep(200); // 微休眠
  }

  return allItems;
}

/**
 * 獲取或建立 Google 日曆
 */
function getOrCreateCalendar() {
  var calendars = CalendarApp.getCalendarsByName(CONFIG.CALENDAR_NAME);
  if (calendars.length > 0) {
    return calendars[0];
  } else {
    Logger.log("未找到名為 '" + CONFIG.CALENDAR_NAME + "' 的日曆，正在建立新日曆...");
    var newCal = CalendarApp.createCalendar(CONFIG.CALENDAR_NAME, {
      summary: "全球重要總體經濟指標與重大金融事件日程表",
      timeZone: "Asia/Taipei"
    });
    Logger.log("日曆建立成功！");
    return newCal;
  }
}

/**
 * 從日曆事件描述中提取事件唯一的 Wscn ID
 */
function getEventWscnId(event) {
  var desc = event.getDescription();
  if (!desc) return null;
  var match = desc.match(/ID:\s*wscn_(\d+)/);
  return match ? parseInt(match[1]) : null;
}

/**
 * 從事件描述中提取先前儲存的預測值 (用於變更比對)
 */
function extractForecastFromDescription(desc) {
  if (!desc) return null;
  var match = desc.match(/預測值:\s*(.*?)(?:\n|$)/);
  return match ? match[1].trim() : null;
}

/**
 * 產生標準化的描述文字
 */
function generateDescription(importance, type, period, previous, forecast, actual, unit, foresight, uri, eventId) {
  var lines = [];
  lines.push("重要度: " + formatImportance(importance));

  if (type === "FD") {
    lines.push("統計週期: " + toTraditional(period));
    lines.push("前值: " + (previous ? previous + unit : "--"));
    lines.push("預測值: " + (forecast ? forecast + unit : "--"));
    lines.push("公佈值: " + (actual ? actual + unit : "--"));
  } else {
    if (foresight) {
      lines.push("前瞻說明: " + toTraditional(foresight));
    }
  }

  if (uri) {
    lines.push("數據來源連結: " + uri);
  }

  lines.push("\n[ID: wscn_" + eventId + "]");
  return lines.join("\n");
}

function formatImportance(importance) {
  if (importance === 1) return "⭐";
  if (importance === 2) return "⭐⭐";
  if (importance === 3) return "⭐⭐⭐";
  if (importance === 4) return "🔥 ⭐⭐⭐⭐";
  return "⭐";
}

function formatDate(date) {
  return Utilities.formatDate(date, "GMT+8", "yyyy-MM-dd HH:mm:ss");
}
/**
 * Google Apps Script — Единый бэкенд веб-приложения «Эксперт»
 * Поддерживает:
 *  - Авторизацию, ПИН-код, кодовое слово и подсказку (лист «Профили»)
 *  - Модуль «Автоотчёт» (листы «Профили», «Месяцы», «Кэш_расстояний», «Справочник_адресов»)
 *  - Корпоративный чат (лист «Чат_Эксперт»)
 *  - Справочник сотрудников (лист «Контакты_Эксперт»)
 *  - Задел под склад («Все заказы», «Пользователи_Склад»)
 *
 * Все сетевые запросы принимаются методом POST с Content-Type: text/plain;charset=utf-8
 */

var PRIMARY_ADMIN_PHONE = "79037244714";

/* =========================================================================
   СЕРВЕРНЫЙ КЭШ (CacheService)
   TTL: контакты — 180 с, список чата — 30 с, список пользователей — 60 с
   Инвалидируется при любом изменении соответствующих данных.
   ========================================================================= */
var GAS_CACHE_CONTACTS_KEY     = "expert_contacts_v1";
var GAS_CACHE_CHAT_KEY         = "expert_chat_v1";
var GAS_CACHE_PROFILES_KEY     = "expert_profiles_v1";
var GAS_CACHE_LAST_SEEN_KEY    = "expert_last_seen_v1";
var GAS_CACHE_POPUPS_KEY       = "expert_popups_v1";
var GAS_CACHE_ALERTS_KEY       = "expert_alerts_v1";
var GAS_CACHE_DIST_KEY         = "expert_dist_cache_v1";
var GAS_CACHE_SHEETS_READY_KEY = "expert_sheets_ready_v2";
var GAS_CACHE_SKLAD_PREFIX     = "expert_sklad_v1_";
var GAS_CACHE_ADDR_PREFIX      = "expert_addr_v1_";

var _memSheetsCache = {};
var _memProfilesList = null;

function gasCacheGet(key) {
  try {
    var c = CacheService.getScriptCache();
    var raw = c.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function gasCachePut(key, value, ttlSeconds) {
  try {
    var c = CacheService.getScriptCache();
    var str = JSON.stringify(value);
    if (str.length > 98000) return; // лимит CacheService ~100КБ
    c.put(key, str, ttlSeconds || 180);
  } catch (e) {
    // Если кэш недоступен — не падаем, просто работаем без кэша
  }
}

function gasCacheRemove(key) {
  try {
    CacheService.getScriptCache().remove(key);
  } catch (e) {}
}

function gasCacheRemoveMulti(keys) {
  try {
    CacheService.getScriptCache().removeAll(keys);
  } catch (e) {}
}

function getCachedProfilesRows(forceFresh) {
  if (!forceFresh && _memProfilesList) {
    return _memProfilesList;
  }
  if (!forceFresh) {
    var cached = gasCacheGet(GAS_CACHE_PROFILES_KEY);
    if (Array.isArray(cached)) {
      _memProfilesList = cached;
      return cached;
    }
  }
  var sheet = getOrCreateSheet("Профили");
  var list = sheetToObjects(sheet);
  _memProfilesList = list;
  gasCachePut(GAS_CACHE_PROFILES_KEY, list, 180);
  return list;
}

function invalidateProfilesCache() {
  _memProfilesList = null;
  gasCacheRemove(GAS_CACHE_PROFILES_KEY);
}

function getLastSeenMap() {
  var m = gasCacheGet(GAS_CACHE_LAST_SEEN_KEY);
  return (m && typeof m === "object") ? m : {};
}

function touchLastSeenInCache(phone, isoNow) {
  try {
    var m = getLastSeenMap();
    m[phone] = isoNow;
    gasCachePut(GAS_CACHE_LAST_SEEN_KEY, m, 300);
  } catch (e) {}
}

const SHEET_SCHEMAS = {
  "Профили": [
    "userId", "pin", "secretWord", "secretHint", "fullName", "position",
    "organization", "normSummer", "normWinter", "carBrand", "carPlate",
    "driverLicense", "fuelType", "startPoint", "updatedAt", "role", "chatAllowed",
    "lastSeenAt", "chatWelcomePending", "theme", "telegramTarget", "speedDial"
  ],
  "Месяцы": [
    "userId", "yearMonth", "odometerStart", "fuelStart", "odometerEnd",
    "fuelEnd", "dataJson", "updatedAt"
  ],
  "Кэш_расстояний": [
    "fromAddress", "toAddress", "km", "updatedAt"
  ],
  "Справочник_адресов": [
    "userId", "address", "note", "updatedAt"
  ],
  "Все заказы": [
    "Дата и время", "Заказ №", "ФИО инженера", "Телефон",
    "Способ получения", "Адрес ПВЗ", "Состав заказа"
  ],
  "Пользователи_Склад": [
    "phone", "pin", "fullName", "address", "updatedAt",
    "flag1", "flag2", "flag3", "stateJson"
  ],
  "Чат_Эксперт": [
    "id", "date", "time", "userName", "userPhone", "message", "createdAt"
  ],
  "Контакты_Эксперт": [
    "id", "fullName", "phone", "note", "updatedAt"
  ],
  "Маршруты_Эксперт": [
    "userId", "pin", "stateJson", "updatedAt"
  ],
  "Сообщения_Админа": [
    "id", "targetPhone", "message", "senderPhone", "createdAt", "readAt"
  ],
  "Алерты_Чат": [
    "id", "userPhone", "userName", "eventType", "details", "createdAt", "seenByAdmin"
  ]
};

function normalizePhone(phone) {
  var digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return "7" + digits;
  if (digits.length === 11 && digits.indexOf("8") === 0) return "7" + digits.slice(1);
  if (digits.length >= 11) return digits.slice(0, 11);
  return digits;
}

function normalizePin(pin) {
  return String(pin || "").replace(/\D/g, "").slice(0, 4);
}

function normalizeYearMonth(val) {
  if (val instanceof Date || Object.prototype.toString.call(val) === "[object Date]") {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), "yyyy-MM");
  }
  return String(val || "").replace(/^'/, "").trim();
}

function cleanAddressKey(addr) {
  return String(addr || "").trim().toLowerCase().replace(/[\s\u00A0.,/\\-]/g, " ");
}

function makeDistanceCacheKey(addr1, addr2) {
  var n1 = cleanAddressKey(addr1);
  var n2 = cleanAddressKey(addr2);
  return n1 < n2 ? (n1 + "|||" + n2) : (n2 + "|||" + n1);
}

function getOrCreateSheet(sheetName) {
  if (_memSheetsCache[sheetName]) {
    return _memSheetsCache[sheetName];
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  var schema = SHEET_SCHEMAS[sheetName];

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (schema && schema.length > 0) {
      sheet.getRange(1, 1, 1, schema.length).setValues([schema]);
      sheet.setFrozenRows(1);
    }
  } else if (!gasCacheGet(GAS_CACHE_SHEETS_READY_KEY)) {
    if (schema && sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, schema.length).setValues([schema]);
      sheet.setFrozenRows(1);
    } else if (schema && schema.length > 0) {
      var lastCol = sheet.getLastColumn();
      if (lastCol < schema.length) {
        var existingHeaders = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
        var missing = [];
        for (var i = lastCol; i < schema.length; i++) {
          if (existingHeaders.indexOf(schema[i]) === -1) {
            missing.push(schema[i]);
          }
        }
        if (missing.length > 0) {
          sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
        }
      }
    }
  }
  _memSheetsCache[sheetName] = sheet;
  return sheet;
}

function parseBoolFlag(val) {
  if (val === true || val === 1) return true;
  var s = String(val || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "да";
}

function isRowAdmin(row, phone) {
  var p = normalizePhone(phone || (row && row.userId));
  var roleStr = String((row && row.role) || "").trim().toLowerCase();
  return p === PRIMARY_ADMIN_PHONE || roleStr === "admin";
}

function isRowChatAllowed(row, phone) {
  if (row && row.chatAllowed !== undefined && String(row.chatAllowed).trim() !== "") {
    return parseBoolFlag(row.chatAllowed);
  }
  return isRowAdmin(row, phone);
}

function verifyAdminAccess(payload) {
  var adminPhone = normalizePhone(payload.adminPhone || payload.phone || payload.userId);
  var adminPin = normalizePin(payload.adminPin || payload.pin);
  if (!adminPhone || adminPin.length !== 4) {
    return { ok: false, error: "Укажите телефон и 4-значный ПИН-код администратора." };
  }
  var auth = checkUserAuth(adminPhone, adminPin);
  if (!auth.exists || !auth.ok) {
    return { ok: false, error: "Ошибка авторизации администратора: неверный телефон или ПИН-код." };
  }
  if (!isRowAdmin(auth.row, adminPhone)) {
    return { ok: false, error: "Доступ запрещён: требуются права администратора." };
  }
  return { ok: true, adminPhone: adminPhone, row: auth.row };
}

function initAllSheets() {
  if (gasCacheGet(GAS_CACHE_SHEETS_READY_KEY)) {
    return;
  }
  for (var name in SHEET_SCHEMAS) {
    getOrCreateSheet(name);
  }
  gasCachePut(GAS_CACHE_SHEETS_READY_KEY, 1, 600);
}

function sheetToObjects(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var result = [];

  for (var i = 0; i < rows.length; i++) {
    var obj = { _rowIndex: i + 2 };
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = rows[i][j];
    }
    result.push(obj);
  }
  return result;
}

function checkUserAuth(phone, pin) {
  var list = getCachedProfilesRows(false);
  for (var i = 0; i < list.length; i++) {
    if (normalizePhone(list[i].userId) === phone) {
      if (normalizePin(list[i].pin) === pin) {
        return { ok: true, exists: true, row: list[i] };
      } else {
        return { ok: false, exists: true, error: "wrong_pin", status: "wrong_pin" };
      }
    }
  }
  return { ok: true, exists: false, isNewUser: true };
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    service: "Эксперт API",
    status: "active",
    time: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: "Сервер занят, повторите попытку через секунду."
    })).setMimeType(ContentService.MimeType.JSON);
  }
  try {
    var raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    var data = JSON.parse(raw);
    var action = String(data.action || "").trim();
    var nestedPayload = (data.payload && typeof data.payload === "object" && !Array.isArray(data.payload))
      ? data.payload
      : {};
    var payload = Object.assign({}, nestedPayload, data);

    initAllSheets();

    var result = { ok: false };

    switch (action) {
      // ── Авторизация и профили в каркасе ──
      case "authLogin":
        result = handleAuthLogin(payload);
        break;
      case "authSetupPin":
        result = handleAuthSetupPin(payload);
        break;
      case "authGetHint":
        result = handleAuthGetHint(payload);
        break;
      case "authResetPin":
        result = handleAuthResetPin(payload);
        break;
      case "getProfile":
        result = handleGetProfile(payload);
        break;
      case "saveUserTheme":
        result = handleSaveUserTheme(payload);
        break;
      case "saveUserTelegramTarget":
        result = handleSaveUserTelegramTarget(payload);
        break;
      case "saveUserSpeedDial":
        result = handleSaveUserSpeedDial(payload);
        break;
      case "loadFullAccountState":
        result = handleLoadFullAccountState(payload);
        break;

      // ── Чат и Контакты ──
      case "chatList":
        result = handleChatList(payload);
        break;
      case "chatSend":
        result = handleChatSend(payload);
        break;
      case "chatClean":
        result = handleChatClean(payload);
        break;
      case "contactsList":
        result = handleContactsList(payload);
        break;
      case "seedContacts":
        result = seedExpertContacts();
        break;

      // ── Администрирование и статусы активности ──
      case "adminUsersList":
      case "adminListUsers":
        result = handleAdminUsersList(payload);
        break;
      case "adminUserDetails":
        result = handleAdminUserDetails(payload);
        break;
      case "adminUserUpdate":
        result = handleAdminUserUpdate(payload);
        break;
      case "adminToggleChat":
        result = handleAdminToggleChat(payload);
        break;
      case "adminUserDelete":
        result = handleAdminUserDelete(payload);
        break;
      case "userHeartbeat":
        result = handleUserHeartbeat(payload);
        break;
      case "userAckChatWelcome":
        result = handleUserAckChatWelcome(payload);
        break;
      case "adminSendPopup":
        result = handleAdminSendPopup(payload);
        break;
      case "userMarkPopupRead":
        result = handleUserMarkPopupRead(payload);
        break;
      case "logChatSecurityAlert":
        result = handleLogChatSecurityAlert(payload);
        break;
      case "adminMarkAlertsSeen":
        result = handleAdminMarkAlertsSeen(payload);
        break;

      // ── Модуль «Автоотчёт» ──
      case "loadUserData":
        result = handleLoadUserData(payload);
        break;
      case "saveProfile":
        result = handleSaveProfile(payload);
        break;
      case "saveMonth":
        result = handleSaveMonth(payload);
        break;
      case "saveAddresses":
        result = handleSaveAddresses(payload);
        break;
      case "saveDistance":
      case "saveDistanceCache":
        result = handleSaveDistance(payload);
        break;

      // ── Модуль «Маршруты» ──
      case "routesSave":
      case "saveRoutes":
        result = handleRoutesSave(payload);
        break;
      case "routesLoad":
      case "loadRoutes":
        result = handleRoutesLoad(payload);
        break;

      // ── Модуль «Заявка на склад» ──
      case "skladSave":
      case "saveSklad":
        result = handleSkladSave(payload);
        break;
      case "skladLoad":
      case "loadSklad":
        result = handleSkladLoad(payload);
        break;

      default:
        result = { ok: false, error: "Неизвестное действие: " + action };
        break;
    }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: "Исключение на сервере GAS: " + err.message
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

/* =========================================================================
   ОБРАБОТЧИКИ КАРКАСА («ЭКСПЕРТ»)
   ========================================================================= */

function normalizeSpeedDialSlots_(raw) {
  if (raw === undefined || raw === null) return null;
  var arr = null;
  if (Array.isArray(raw)) {
    arr = raw;
  } else {
    var str = String(raw).trim();
    if (!str) return null;
    try {
      arr = JSON.parse(str);
    } catch (e) {
      return null;
    }
  }
  if (!Array.isArray(arr)) return null;
  var res = [];
  for (var i = 0; i < 6; i++) {
    var item = arr[i];
    if (!item || typeof item !== "object") {
      res.push(null);
      continue;
    }
    var p11 = normalizePhone(item.phone);
    if (p11.length < 10) {
      res.push(null);
      continue;
    }
    var nm = String(item.name || "Контакт").trim().slice(0, 40) || "Контакт";
    res.push({ name: nm, phone: formatPhoneMask_(p11) });
  }
  return res;
}

function parseTelegramTarget_(raw) {
  if (raw === undefined || raw === null) return null;
  var obj = null;
  if (typeof raw === "object") {
    obj = raw;
  } else {
    var str = String(raw).trim();
    if (!str) return null;
    try {
      obj = JSON.parse(str);
    } catch (e) {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  var mode = String(obj.mode || "").trim();
  if (mode !== "sales" && mode !== "bot_gos" && mode !== "saved" && mode !== "custom") return null;
  var customUrl = mode === "custom" ? String(obj.customUrl || "").trim() : "";
  if (mode === "custom" && !customUrl) return null;
  return { mode: mode, customUrl: customUrl };
}

function buildUserProfileObject(row, phone) {
  var r = row || {};
  var p = normalizePhone(r.userId || phone);
  var adm = isRowAdmin(r, p);
  return {
    userId: p,
    fullName: r.fullName || "",
    position: r.position || "",
    organization: r.organization || "",
    normSummer: r.normSummer || "",
    normWinter: r.normWinter || "",
    carBrand: r.carBrand || "",
    carPlate: r.carPlate || "",
    driverLicense: r.driverLicense || "",
    fuelType: r.fuelType || "",
    startPoint: r.startPoint || "",
    theme: r.theme || "",
    telegramTarget: parseTelegramTarget_(r.telegramTarget),
    speedDial: normalizeSpeedDialSlots_(r.speedDial),
    role: adm ? "admin" : "user",
    isAdmin: adm,
    chatAllowed: isRowChatAllowed(r, p),
    chatWelcomePending: parseBoolFlag(r.chatWelcomePending),
    updatedAt: r.updatedAt || ""
  };
}

function getUserAddressesList(phone) {
  var p = normalizePhone(phone);
  if (!p) return [];
  var cacheKey = GAS_CACHE_ADDR_PREFIX + p;
  var cached = gasCacheGet(cacheKey);
  if (Array.isArray(cached)) {
    return cached;
  }
  var addrSheet = getOrCreateSheet("Справочник_адресов");
  var addrList = sheetToObjects(addrSheet);
  var userAddresses = [];
  for (var a = 0; a < addrList.length; a++) {
    var aRow = addrList[a];
    if (normalizePhone(aRow.userId) === p && aRow.address) {
      userAddresses.push({
        address: String(aRow.address),
        note: String(aRow.note || "")
      });
    }
  }
  gasCachePut(cacheKey, userAddresses, 180);
  return userAddresses;
}

function handleAuthLogin(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  var pin = normalizePin(payload.pin);

  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите номер телефона и 4-значный ПИН-код." };
  }

  var auth = checkUserAuth(phone, pin);
  if (!auth.exists) {
    return { ok: false, notFound: true, error: "Пользователь не найден. Необходимо зарегистрироваться." };
  }
  if (!auth.ok) {
    return { ok: false, error: "Неверный ПИН-код." };
  }

  var userIsAdmin = isRowAdmin(auth.row, phone);
  var userChatAllowed = isRowChatAllowed(auth.row, phone);
  var userChatWelcomePending = parseBoolFlag(auth.row.chatWelcomePending);
  var profileObj = buildUserProfileObject(auth.row, phone);
  var userAddresses = getUserAddressesList(phone);

  return {
    ok: true,
    userId: auth.row.userId,
    fullName: auth.row.fullName || "",
    position: auth.row.position || "",
    theme: profileObj.theme,
    telegramTarget: profileObj.telegramTarget,
    speedDial: profileObj.speedDial,
    phone: phone,
    role: userIsAdmin ? "admin" : "user",
    isAdmin: userIsAdmin,
    chatAllowed: userChatAllowed,
    chatWelcomePending: userChatWelcomePending,
    profile: profileObj,
    addresses: userAddresses
  };
}

function handleGetProfile(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  var pin = normalizePin(payload.pin);

  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите номер телефона и 4-значный ПИН-код." };
  }

  var auth = checkUserAuth(phone, pin);
  if (!auth.exists || !auth.ok || !auth.row) {
    return { ok: false, error: "Ошибка авторизации." };
  }

  return {
    ok: true,
    phone: phone,
    profile: buildUserProfileObject(auth.row, phone),
    addresses: getUserAddressesList(phone)
  };
}

function handleSaveUserTheme(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  var pin = normalizePin(payload.pin);
  var nextTheme = String(payload.theme || "").trim();

  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите телефон и ПИН-код." };
  }
  if (!nextTheme) {
    return { ok: false, error: "Не указана тема оформления." };
  }

  var auth = checkUserAuth(phone, pin);
  if (!auth.exists || !auth.ok || !auth.row) {
    return { ok: false, error: "Ошибка авторизации." };
  }

  var sheet = getOrCreateSheet("Профили");
  var headers = SHEET_SCHEMAS["Профили"];
  var now = new Date().toISOString();
  var rowValues = [];
  for (var h = 0; h < headers.length; h++) {
    var col = headers[h];
    if (col === "theme") rowValues.push(nextTheme);
    else if (col === "updatedAt") rowValues.push(now);
    else rowValues.push(auth.row[col] !== undefined ? auth.row[col] : "");
  }

  sheet.getRange(auth.row._rowIndex, 1, 1, headers.length).setValues([rowValues]);
  invalidateProfilesCache();

  return { ok: true, theme: nextTheme, updatedAt: now };
}

function handleSaveUserTelegramTarget(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  var pin = normalizePin(payload.pin);
  var mode = String(payload.mode || "").trim();
  var customUrl = String(payload.customUrl || "").trim();

  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите телефон и ПИН-код." };
  }
  if (mode !== "sales" && mode !== "bot_gos" && mode !== "saved" && mode !== "custom") {
    return { ok: false, error: "Недопустимый вариант кнопки Telegram." };
  }
  if (mode === "custom" && !customUrl) {
    return { ok: false, error: "Укажите ссылку или @username для кнопки Telegram." };
  }
  if (mode !== "custom") {
    customUrl = "";
  }

  var auth = checkUserAuth(phone, pin);
  if (!auth.exists || !auth.ok || !auth.row) {
    return { ok: false, error: "Ошибка авторизации." };
  }

  var sheet = getOrCreateSheet("Профили");
  var headers = SHEET_SCHEMAS["Профили"];
  var now = new Date().toISOString();
  var targetObj = { mode: mode, customUrl: customUrl };
  var targetJson = JSON.stringify(targetObj);
  var rowValues = [];
  for (var h = 0; h < headers.length; h++) {
    var col = headers[h];
    if (col === "telegramTarget") rowValues.push(targetJson);
    else if (col === "updatedAt") rowValues.push(now);
    else rowValues.push(auth.row[col] !== undefined ? auth.row[col] : "");
  }

  sheet.getRange(auth.row._rowIndex, 1, 1, headers.length).setValues([rowValues]);
  invalidateProfilesCache();

  return { ok: true, telegramTarget: targetObj, updatedAt: now };
}

function handleSaveUserSpeedDial(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  var pin = normalizePin(payload.pin);
  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите телефон и ПИН-код." };
  }
  var auth = checkUserAuth(phone, pin);
  if (!auth.exists || !auth.ok || !auth.row) {
    return { ok: false, error: "Ошибка авторизации." };
  }
  var rawSlots = Array.isArray(payload.slots) ? payload.slots : [];
  var slots = [];
  for (var i = 0; i < 6; i++) {
    var item = rawSlots[i];
    if (!item || typeof item !== "object") {
      slots.push(null);
      continue;
    }
    var p11 = normalizePhone(item.phone);
    if (p11.length < 10) {
      slots.push(null);
      continue;
    }
    var nm = String(item.name || "Контакт").trim().slice(0, 40) || "Контакт";
    slots.push({ name: nm, phone: formatPhoneMask_(p11) });
  }

  var sheet = getOrCreateSheet("Профили");
  var headers = SHEET_SCHEMAS["Профили"];
  var now = new Date().toISOString();
  var slotsJson = JSON.stringify(slots);
  var rowValues = [];
  for (var h = 0; h < headers.length; h++) {
    var col = headers[h];
    if (col === "speedDial") rowValues.push(slotsJson);
    else if (col === "updatedAt") rowValues.push(now);
    else rowValues.push(auth.row[col] !== undefined ? auth.row[col] : "");
  }
  sheet.getRange(auth.row._rowIndex, 1, 1, headers.length).setValues([rowValues]);
  invalidateProfilesCache();
  return { ok: true, speedDial: slots, updatedAt: now };
}

function handleAuthSetupPin(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  var pin = normalizePin(payload.pin);
  var fullName = String(payload.fullName || "").trim();
  var secretHint = String(payload.secretHint || "").trim();
  var secretWord = String(payload.secretWord || "").trim();

  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите корректный телефон и 4-значный ПИН-код." };
  }
  if (!secretHint || !secretWord) {
    return { ok: false, error: "Укажите вопрос-подсказку и кодовое слово." };
  }

  var sheet = getOrCreateSheet("Профили");
  var list = getCachedProfilesRows(true);
  var now = new Date().toISOString();
  var foundRowIndex = -1;
  var existingRow = null;

  for (var i = 0; i < list.length; i++) {
    if (normalizePhone(list[i].userId) === phone) {
      foundRowIndex = list[i]._rowIndex;
      existingRow = list[i];
      break;
    }
  }

  var assignedRole = existingRow && existingRow.role ? existingRow.role : (phone === PRIMARY_ADMIN_PHONE ? "admin" : "user");
  var assignedChatAllowed = (existingRow && existingRow.chatAllowed !== undefined && String(existingRow.chatAllowed).trim() !== "")
    ? String(existingRow.chatAllowed)
    : (phone === PRIMARY_ADMIN_PHONE ? "true" : "false");

  var assignedTheme = (payload.theme && String(payload.theme).trim())
    ? String(payload.theme).trim()
    : (existingRow && existingRow.theme ? String(existingRow.theme) : "");

  var headers = SHEET_SCHEMAS["Профили"];
  var rowValues = [];
  for (var h = 0; h < headers.length; h++) {
    var col = headers[h];
    if (col === "userId") rowValues.push(phone);
    else if (col === "pin") rowValues.push(pin);
    else if (col === "secretWord") rowValues.push(secretWord);
    else if (col === "secretHint") rowValues.push(secretHint);
    else if (col === "fullName") rowValues.push(fullName);
    else if (col === "updatedAt") rowValues.push(now);
    else if (col === "role") rowValues.push(assignedRole);
    else if (col === "chatAllowed") rowValues.push(assignedChatAllowed);
    else if (col === "theme") rowValues.push(assignedTheme);
    else rowValues.push(existingRow && existingRow[col] !== undefined ? existingRow[col] : "");
  }

  if (foundRowIndex > 0) {
    sheet.getRange(foundRowIndex, 1, 1, headers.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
  invalidateProfilesCache();

  try {
    addRegisteredUserToContacts_(SpreadsheetApp.getActiveSpreadsheet(), fullName, phone);
  } catch (e) {}

  var isAdm = isRowAdmin({ userId: phone, role: assignedRole }, phone);
  var setupProfile = buildUserProfileObject({
    userId: phone,
    fullName: fullName,
    position: existingRow ? existingRow.position : "",
    organization: existingRow ? existingRow.organization : "",
    normSummer: existingRow ? existingRow.normSummer : "",
    normWinter: existingRow ? existingRow.normWinter : "",
    carBrand: existingRow ? existingRow.carBrand : "",
    carPlate: existingRow ? existingRow.carPlate : "",
    driverLicense: existingRow ? existingRow.driverLicense : "",
    fuelType: existingRow ? existingRow.fuelType : "",
    startPoint: existingRow ? existingRow.startPoint : "",
    theme: assignedTheme,
    updatedAt: now
  }, phone);
  return {
    ok: true,
    phone: phone,
    fullName: fullName,
    theme: assignedTheme,
    role: isAdm ? "admin" : "user",
    isAdmin: isAdm,
    chatAllowed: parseBoolFlag(assignedChatAllowed),
    profile: setupProfile,
    addresses: getUserAddressesList(phone)
  };
}

function handleAuthGetHint(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  if (!phone) {
    return { ok: false, error: "Укажите номер телефона." };
  }

  var list = getCachedProfilesRows(false);

  for (var i = 0; i < list.length; i++) {
    if (normalizePhone(list[i].userId) === phone) {
      var hint = list[i].secretHint;
      if (!hint) {
        return { ok: false, error: "Для данного пользователя вопрос-подсказка не был задан." };
      }
      return { ok: true, secretHint: hint };
    }
  }

  return { ok: false, error: "Пользователь с таким номером не найден в базе профилей." };
}

function handleAuthResetPin(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  var secretWord = String(payload.secretWord || "").trim().toLowerCase();
  var newPin = normalizePin(payload.newPin || payload.pin);

  if (!phone || !secretWord || newPin.length !== 4) {
    return { ok: false, error: "Укажите телефон, кодовое слово и новый 4-значный ПИН-код." };
  }

  var sheet = getOrCreateSheet("Профили");
  var list = getCachedProfilesRows(false);

  for (var i = 0; i < list.length; i++) {
    if (normalizePhone(list[i].userId) === phone) {
      var realSecret = String(list[i].secretWord || "").trim().toLowerCase();
      if (realSecret !== secretWord) {
        return { ok: false, error: "Неверное кодовое слово." };
      }

      var rowIndex = list[i]._rowIndex;
      var headers = SHEET_SCHEMAS["Профили"];

      // Пакетная запись в одном вызове setValues
      var now = new Date().toISOString();
      var rowArr = [];
      for (var c = 0; c < headers.length; c++) {
        var h = headers[c];
        if (h === "pin") rowArr.push(newPin);
        else if (h === "updatedAt") rowArr.push(now);
        else rowArr.push(list[i][h] !== undefined ? list[i][h] : "");
      }
      sheet.getRange(rowIndex, 1, 1, headers.length).setValues([rowArr]);
      invalidateProfilesCache();

      return { ok: true, message: "ПИН-код успешно обновлён." };
    }
  }

  return { ok: false, error: "Пользователь с таким номером не найден." };
}

function formatChatMoscowFields_(rawDate, rawTime, rawCreatedAt) {
  var dt = null;
  if (rawCreatedAt !== undefined && rawCreatedAt !== null && String(rawCreatedAt).trim() !== "") {
    if (Object.prototype.toString.call(rawCreatedAt) === "[object Date]" && !isNaN(rawCreatedAt.getTime())) {
      dt = rawCreatedAt;
    } else {
      var parsedCreated = new Date(String(rawCreatedAt).trim());
      if (!isNaN(parsedCreated.getTime()) && parsedCreated.getFullYear() >= 2000) {
        dt = parsedCreated;
      }
    }
  }
  if (dt) {
    return {
      date: Utilities.formatDate(dt, "Europe/Moscow", "dd.MM.yyyy"),
      time: Utilities.formatDate(dt, "Europe/Moscow", "HH:mm"),
      createdAt: dt.toISOString()
    };
  }

  var cleanDate = "";
  if (Object.prototype.toString.call(rawDate) === "[object Date]" && !isNaN(rawDate.getTime())) {
    if (rawDate.getFullYear() >= 2000) {
      cleanDate = Utilities.formatDate(rawDate, "Europe/Moscow", "dd.MM.yyyy");
    }
  } else {
    var strDate = String(rawDate || "").replace(/^'/, "").trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(strDate)) {
      var parsedD = new Date(strDate);
      if (!isNaN(parsedD.getTime()) && parsedD.getFullYear() >= 2000) {
        cleanDate = Utilities.formatDate(parsedD, "Europe/Moscow", "dd.MM.yyyy");
      }
    } else if (strDate.indexOf("1899-") === -1) {
      cleanDate = strDate;
    }
  }

  var cleanTime = "";
  if (Object.prototype.toString.call(rawTime) === "[object Date]" && !isNaN(rawTime.getTime())) {
    cleanTime = Utilities.formatDate(rawTime, "Europe/Moscow", "HH:mm");
  } else {
    var strTime = String(rawTime || "").replace(/^'/, "").trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(strTime)) {
      var parsedT = new Date(strTime);
      if (!isNaN(parsedT.getTime())) {
        cleanTime = Utilities.formatDate(parsedT, "Europe/Moscow", "HH:mm");
      }
    } else {
      var mTime = strTime.match(/(\d{2}:\d{2})/);
      cleanTime = mTime ? mTime[1] : strTime;
    }
  }

  return { date: cleanDate, time: cleanTime, createdAt: "" };
}

function getCachedRecentChatMessages() {
  var cached = gasCacheGet(GAS_CACHE_CHAT_KEY);
  if (cached && Array.isArray(cached.messages)) {
    return cached.messages;
  }
  var sheet = getOrCreateSheet("Чат_Эксперт");
  var list = sheetToObjects(sheet);
  var recent = list.slice(-50);
  var formatted = recent.map(function(r) {
    var msk = formatChatMoscowFields_(r.date, r.time, r.createdAt);
    return {
      id: r.id || ("msg-" + r._rowIndex),
      date: msk.date,
      time: msk.time,
      createdAt: msk.createdAt,
      userName: r.userName || "",
      userPhone: r.userPhone || "",
      message: r.message || ""
    };
  });
  gasCachePut(GAS_CACHE_CHAT_KEY, { messages: formatted }, 180);
  return formatted;
}

function handleChatList(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  var pin = normalizePin(payload.pin);

  if (!phone || pin.length !== 4) {
    return { ok: false, chatDenied: true, chatAllowed: false, error: "Требуется авторизация." };
  }

  var auth = checkUserAuth(phone, pin);
  if (!auth.exists || !auth.ok) {
    return { ok: false, chatDenied: true, chatAllowed: false, error: "Ошибка авторизации." };
  }

  var userIsAdmin = isRowAdmin(auth.row, phone);
  var allowed = isRowChatAllowed(auth.row, phone);
  if (!allowed) {
    return {
      ok: false,
      chatDenied: true,
      chatAllowed: false,
      isAdmin: userIsAdmin,
      error: "Доступ к чату не выдан администратором.",
      messages: []
    };
  }

  var formatted = getCachedRecentChatMessages();
  return { ok: true, chatAllowed: true, isAdmin: userIsAdmin, messages: formatted };
}

function handleChatSend(payload) {
  var text = String(payload.message || "").trim();
  if (!text) {
    return { ok: false, error: "Пустое сообщение." };
  }

  var phone = normalizePhone(payload.phone || payload.userPhone || payload.userId);
  var pin = normalizePin(payload.pin);
  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Требуется авторизация для отправки в чат." };
  }

  var auth = checkUserAuth(phone, pin);
  if (!auth.exists || !auth.ok) {
    return { ok: false, error: "Ошибка авторизации." };
  }

  // Скрытая команда администратора /adminclean
  if (text.toLowerCase() === "/adminclean") {
    return handleChatClean({ adminPhone: phone, adminPin: pin });
  }

  if (!isRowChatAllowed(auth.row, phone)) {
    return { ok: false, chatDenied: true, chatAllowed: false, error: "Доступ к чату не выдан администратором." };
  }

  var sheet = getOrCreateSheet("Чат_Эксперт");
  var id = "msg-" + Date.now();
  var now = new Date();
  var createdAtIso = now.toISOString();
  var mskDate = Utilities.formatDate(now, "Europe/Moscow", "dd.MM.yyyy");
  var mskTime = Utilities.formatDate(now, "Europe/Moscow", "HH:mm");
  var userName = payload.userName || auth.row.fullName || "Сотрудник";

  sheet.appendRow([id, "'" + mskDate, "'" + mskTime, userName, phone, text, createdAtIso]);
  // Инвалидируем кэш чата после отправки нового сообщения
  gasCacheRemove(GAS_CACHE_CHAT_KEY);
  return { ok: true, id: id, date: mskDate, time: mskTime, createdAt: createdAtIso };
}

function handleChatClean(payload) {
  var check = verifyAdminAccess(payload);
  if (!check.ok) {
    return check;
  }

  var sheet = getOrCreateSheet("Чат_Эксперт");
  var lastRow = sheet.getLastRow();
  var deletedCount = 0;
  if (lastRow > 1) {
    deletedCount = lastRow - 1;
    try {
      sheet.deleteRows(2, deletedCount);
    } catch (e) {
      var lastCol = Math.max(1, sheet.getLastColumn());
      sheet.getRange(2, 1, deletedCount, lastCol).clearContent();
    }
  }
  gasCacheRemove(GAS_CACHE_CHAT_KEY);

  return {
    ok: true,
    cleared: true,
    deletedCount: deletedCount,
    messages: []
  };
}

var EXPERT_DEFAULT_CONTACTS = [
  { id: "c-01", fullName: "Абрамов Сергей", phone: "+7 985 510 42 03", note: "Эксперт" },
  { id: "c-02", fullName: "Амбарян Эдгар", phone: "+7 917 583 28 69", note: "Эксперт" },
  { id: "c-03", fullName: "Анфалов Артем", phone: "+7 985 929 47 40", note: "Эксперт" },
  { id: "c-04", fullName: "Баранов Александр", phone: "+7 916 921 56 69", note: "Продажи" },
  { id: "c-05", fullName: "Бац Вячеслав", phone: "+7 916 921 59 63", note: "Диспетчер" },
  { id: "c-06", fullName: "Беляев Дмитрий", phone: "+7 915 261 34 61", note: "Эксперт" },
  { id: "c-07", fullName: "Беляев Михаил", phone: "+7 903 724 47 14", note: "Эксперт" },
  { id: "c-08", fullName: "Босс Александр", phone: "+7 917 582 71 99", note: "Эксперт" },
  { id: "c-09", fullName: "Великевич Егор", phone: "+7 915 450 45 24", note: "Эксперт" },
  { id: "c-10", fullName: "Вещиков Вячеслав", phone: "+7 925 000 92 74", note: "Эксперт" },
  { id: "c-11", fullName: "Герасименко Артём Михайлович", phone: "+7 999 483 13 50", note: "Эксперт" },
  { id: "c-12", fullName: "Гремякин Дмитрий Анатольевич", phone: "+7 926 166 76 66", note: "Эксперт" },
  { id: "c-13", fullName: "Гунт Матвей", phone: "+7 963 636 63 36", note: "Диспетчер" },
  { id: "c-14", fullName: "Дубасов Анатолий", phone: "+7 963 755 55 01", note: "Эксперт" },
  { id: "c-15", fullName: "Еремин Михаил", phone: "+7 916 489 76 62", note: "Эксперт" },
  { id: "c-16", fullName: "Жердев Алексей", phone: "+7 925 711 12 77", note: "Эксперт" },
  { id: "c-17", fullName: "Жук Сергей Сергеевич", phone: "+7 917 583 00 91", note: "ТЛ" },
  { id: "c-18", fullName: "Зубарев Евгений", phone: "+7 985 004 72 41", note: "Эксперт" },
  { id: "c-19", fullName: "Зудин Ян", phone: "+7 966 222 26 78", note: "Эксперт" },
  { id: "c-20", fullName: "Карпов Александр", phone: "+7 903 214 60 31", note: "Эксперт" },
  { id: "c-21", fullName: "Клещ Александр", phone: "+7 916 160 98 69", note: "Эксперт" },
  { id: "c-22", fullName: "Козлов Александр", phone: "+7 926 700 76 99", note: "Продажи" },
  { id: "c-23", fullName: "Корнеев Павел", phone: "+7 915 321 82 30", note: "Эксперт" },
  { id: "c-24", fullName: "Корнеев Павел", phone: "+7 916 712 89 37", note: "Эксперт" },
  { id: "c-25", fullName: "Кувшинов Антон", phone: "+7 925 079 84 60", note: "Эксперт" },
  { id: "c-26", fullName: "Кудряшов Михаил", phone: "+7 904 350 44 80", note: "Эксперт" },
  { id: "c-27", fullName: "Кузнецов Сергей", phone: "+7 926 281 70 47", note: "Эксперт" },
  { id: "c-28", fullName: "Лемешев Роман", phone: "+7 916 497 66 25", note: "Эксперт" },
  { id: "c-29", fullName: "Мосин Андрей", phone: "+7 915 488 68 88", note: "Эксперт" },
  { id: "c-30", fullName: "Моторо Александр", phone: "+7 977 262 68 51", note: "Продажи" },
  { id: "c-31", fullName: "Мхеян Максим", phone: "+7 915 031 88 46", note: "Эксперт" },
  { id: "c-32", fullName: "Оленин Алексей Григорьевич", phone: "+7 916 161 14 55", note: "Эксперт" },
  { id: "c-33", fullName: "Орлов Андрей", phone: "+7 977 142 65 00", note: "Эксперт" },
  { id: "c-34", fullName: "Прошкин Кирилл", phone: "+7 985 912 90 20", note: "Эксперт" },
  { id: "c-35", fullName: "Самарин Виталий", phone: "+7 916 681 79 75", note: "Эксперт" },
  { id: "c-36", fullName: "Сандин Павел", phone: "+7 967 041 54 77", note: "Эксперт" },
  { id: "c-37", fullName: "Смирнов Алексей", phone: "+7 916 060 68 95", note: "Эксперт" },
  { id: "c-38", fullName: "Тюнин Денис", phone: "+7 916 571 27 07", note: "ТЛ" },
  { id: "c-39", fullName: "Умяров Ильдар Ренадович", phone: "+7 917 975 33 80", note: "Эксперт" },
  { id: "c-40", fullName: "Фолимагин Александр", phone: "+7 977 446 46 81", note: "Эксперт" },
  { id: "c-41", fullName: "Шаров Алексей", phone: "+7 929 977 77 48", note: "Эксперт" },
  { id: "c-42", fullName: "Шестаков Владислав", phone: "+7 917 582 11 59", note: "Эксперт" },
  { id: "c-43", fullName: "Шунков Эльдар", phone: "+7 929 928 81 50", note: "Эксперт" },
  { id: "c-44", fullName: "Склад", phone: "+7 919 960 39 48", note: "Склад" }
];

var CONTACTS_SEED_VERSION = "v44_sklad";

function formatPhoneMask_(raw) {
  var p = normalizePhone(raw);
  if (p.length === 11) {
    return "+7 " + p.slice(1, 4) + " " + p.slice(4, 7) + " " + p.slice(7, 9) + " " + p.slice(9, 11);
  }
  return String(raw || "").replace(/^'/, "").trim();
}

function addRegisteredUserToContacts_(ss, fullName, phone11) {
  var p11 = normalizePhone(phone11);
  if (p11.length !== 11) return;
  var cleanFullName = String(fullName || "").trim();
  var sheet = getOrCreateSheet("Контакты_Эксперт");
  try {
    sheet.getRange("C:C").setNumberFormat("@");
  } catch (e) {}
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var vals = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (normalizePhone(vals[i][2]) === p11) {
        if (String(vals[i][1] || "").trim() === "" && cleanFullName) {
          sheet.getRange(i + 2, 2).setValue(cleanFullName);
          gasCacheRemove(GAS_CACHE_CONTACTS_KEY);
        }
        return;
      }
    }
  }
  var formattedPhone = formatPhoneMask_(p11);
  var id = "c-reg-" + Date.now();
  var nowIso = new Date().toISOString();
  sheet.appendRow([id, cleanFullName, "'" + formattedPhone, "", nowIso]);
  gasCacheRemove(GAS_CACHE_CONTACTS_KEY);
}

function seedExpertContacts() {
  var sheet = getOrCreateSheet("Контакты_Эксперт");
  try {
    sheet.getRange("C:C").setNumberFormat("@");
  } catch (e) {}
  var lastRow = sheet.getLastRow();
  var existingPhones = {};
  var existingCount = 0;
  if (lastRow > 1) {
    var existingVals = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
    existingCount = existingVals.length;
    for (var i = 0; i < existingVals.length; i++) {
      var p11 = normalizePhone(existingVals[i][2]);
      if (p11.length === 11) {
        existingPhones[p11] = true;
      }
    }
  }
  var nowIso = new Date().toISOString();
  var rowsToAppend = [];
  for (var j = 0; j < EXPERT_DEFAULT_CONTACTS.length; j++) {
    var c = EXPERT_DEFAULT_CONTACTS[j];
    var cPhone11 = normalizePhone(c.phone);
    if (!cPhone11 || existingPhones[cPhone11]) {
      continue;
    }
    existingPhones[cPhone11] = true;
    rowsToAppend.push([c.id, c.fullName, "'" + formatPhoneMask_(c.phone), c.note || "", nowIso]);
  }
  if (rowsToAppend.length > 0) {
    var startRow = Math.max(2, lastRow + 1);
    sheet.getRange(startRow, 1, rowsToAppend.length, 5).setValues(rowsToAppend);
  }
  try {
    PropertiesService.getScriptProperties().setProperty("CONTACTS_SEED_VERSION", CONTACTS_SEED_VERSION);
  } catch (e) {}
  gasCacheRemove(GAS_CACHE_CONTACTS_KEY);
  return { ok: true, added: rowsToAppend.length, total: existingCount + rowsToAppend.length };
}

function setupExpertDatabase() {
  var sheets = Object.keys(SHEET_SCHEMAS);
  for (var i = 0; i < sheets.length; i++) {
    getOrCreateSheet(sheets[i]);
  }
  return seedExpertContacts();
}

function handleContactsList(payload) {
  var savedSeedVersion = "";
  try {
    savedSeedVersion = PropertiesService.getScriptProperties().getProperty("CONTACTS_SEED_VERSION") || "";
  } catch (e) {}
  var needReseed = savedSeedVersion !== CONTACTS_SEED_VERSION;

  if (!needReseed) {
    // Кэш на 180 секунд — контакты меняются редко
    var cached = gasCacheGet(GAS_CACHE_CONTACTS_KEY);
    if (cached && Array.isArray(cached.contacts)) {
      return cached;
    }
  }

  var sheet = getOrCreateSheet("Контакты_Эксперт");
  var list = sheetToObjects(sheet);

  if (needReseed || list.length === 0) {
    seedExpertContacts();
    list = sheetToObjects(sheet);
  }

  var seenPhones = {};
  var formatted = [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var rawPhone = String(c.phone || "").replace(/^'/, "").trim();
    var p11 = normalizePhone(rawPhone);
    if (p11.length === 11) {
      if (seenPhones[p11]) continue;
      seenPhones[p11] = true;
    }
    formatted.push({
      id: c.id || ("c-" + c._rowIndex),
      fullName: String(c.fullName || "").trim(),
      phone: formatPhoneMask_(rawPhone),
      note: String(c.note || "").trim()
    });
  }

  formatted.sort(function(a, b) {
    return String(a.fullName || "").localeCompare(String(b.fullName || ""), "ru");
  });

  var result = { ok: true, contacts: formatted };
  gasCachePut(GAS_CACHE_CONTACTS_KEY, result, 180);
  return result;
}

/* =========================================================================
   ОБРАБОТЧИКИ МОДУЛЯ «АВТООТЧЁТ»
   ========================================================================= */

function getUserMonthsMap(phone) {
  var p = normalizePhone(phone);
  var monthsSheet = getOrCreateSheet("Месяцы");
  var monthsList = sheetToObjects(monthsSheet);
  var userMonths = {};

  for (var m = 0; m < monthsList.length; m++) {
    var mRow = monthsList[m];
    var ymKey = normalizeYearMonth(mRow.yearMonth);
    if (normalizePhone(mRow.userId) === p && ymKey) {
      var parsedData = null;
      if (mRow.dataJson) {
        try {
          parsedData = JSON.parse(mRow.dataJson);
        } catch (e) {
          parsedData = null;
        }
      }
      if (!parsedData || typeof parsedData !== "object") {
        var ymParts = ymKey.split("-");
        parsedData = {
          year: Number(ymParts[0]) || 2026,
          month: Number(ymParts[1]) || 1,
          odometerStart: Number(mRow.odometerStart) || 0,
          fuelStart: Number(mRow.fuelStart) || 0,
          odometerEnd: Number(mRow.odometerEnd) || 0,
          fuelEnd: Number(mRow.fuelEnd) || 0,
          refuels: [],
          workdays: {}
        };
      }
      userMonths[ymKey] = parsedData;
    }
  }
  return userMonths;
}

function getCachedDistanceCacheMap() {
  var distanceCache = gasCacheGet(GAS_CACHE_DIST_KEY);
  if (!distanceCache || typeof distanceCache !== "object") {
    var distSheet = getOrCreateSheet("Кэш_расстояний");
    var distList = sheetToObjects(distSheet);
    distanceCache = {};
    for (var d = 0; d < distList.length; d++) {
      var dRow = distList[d];
      if (dRow.fromAddress && dRow.toAddress && dRow.km !== undefined && dRow.km !== "") {
        var cKey = makeDistanceCacheKey(dRow.fromAddress, dRow.toAddress);
        distanceCache[cKey] = Number(dRow.km) || 0;
      }
    }
    gasCachePut(GAS_CACHE_DIST_KEY, distanceCache, 300);
  }
  return distanceCache;
}

function handleLoadUserData(payload) {
  var phone = normalizePhone(payload.userId || payload.phone);
  var pin = normalizePin(payload.pin);

  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите номер телефона (11 цифр) и 4-значный ПИН-код." };
  }

  var auth = checkUserAuth(phone, pin);
  if (auth.exists && !auth.ok) {
    return { ok: false, status: "wrong_pin", error: "wrong_pin" };
  }

  var profileObj = (auth.exists && auth.row) ? buildUserProfileObject(auth.row, phone) : {};
  var userMonths = getUserMonthsMap(phone);
  var userAddresses = getUserAddressesList(phone);
  var distanceCache = getCachedDistanceCacheMap();

  return {
    ok: true,
    status: auth.exists ? "success" : "not_found",
    isNewUser: !auth.exists,
    userId: phone,
    profile: profileObj,
    months: userMonths,
    addresses: userAddresses,
    distanceCache: distanceCache
  };
}

function handleLoadFullAccountState(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  var pin = normalizePin(payload.pin);

  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите номер телефона (11 цифр) и 4-значный ПИН-код." };
  }

  var auth = checkUserAuth(phone, pin);
  if (!auth.exists) {
    return { ok: false, notFound: true, error: "Пользователь не найден." };
  }
  if (!auth.ok || !auth.row) {
    return { ok: false, status: "wrong_pin", error: "Неверный ПИН-код." };
  }

  var profileObj = buildUserProfileObject(auth.row, phone);
  var userIsAdmin = profileObj.isAdmin;
  var userChatAllowed = profileObj.chatAllowed;

  var monthsMap = getUserMonthsMap(phone);
  var addressesList = getUserAddressesList(phone);
  var distanceCacheMap = getCachedDistanceCacheMap();

  var routesRes = handleRoutesLoad({ userId: phone, pin: pin });
  var routesState = (routesRes && routesRes.ok) ? (routesRes.state || null) : null;

  var skladRes = handleSkladLoad({ phone: phone, pin: pin });
  var skladState = null;
  if (skladRes && skladRes.ok) {
    skladState = {
      fullName: skladRes.fullName || profileObj.fullName || "",
      address: skladRes.address || profileObj.startPoint || "",
      stateJson: skladRes.payload || null
    };
  }

  var contactsRes = handleContactsList({});
  var contactsList = (contactsRes && contactsRes.ok && Array.isArray(contactsRes.contacts)) ? contactsRes.contacts : [];

  var chatMessages = userChatAllowed ? getCachedRecentChatMessages() : [];

  var allPendingPopups = getCachedPendingPopups();
  var adminPopups = [];
  for (var i = 0; i < allPendingPopups.length; i++) {
    if (allPendingPopups[i].targetPhone === phone) {
      adminPopups.push(allPendingPopups[i]);
    }
  }

  var adminAlerts = [];
  if (userIsAdmin) {
    var allAlerts = getSecurityAlertsList(100);
    for (var a = 0; a < allAlerts.length; a++) {
      if (!allAlerts[a].seenByAdmin) {
        adminAlerts.push(allAlerts[a]);
      }
    }
  }

  return {
    ok: true,
    phone: phone,
    profile: profileObj,
    months: monthsMap,
    addresses: addressesList,
    distanceCache: distanceCacheMap,
    routesState: routesState,
    skladState: skladState,
    contacts: contactsList,
    chatMessages: chatMessages,
    adminPopups: adminPopups,
    adminAlerts: adminAlerts
  };
}

function handleSaveProfile(payload) {
  var phone = normalizePhone(payload.userId || payload.phone);
  var pin = normalizePin(payload.pin);
  var profile = payload.profile || {};

  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите номер телефона и 4-значный ПИН-код." };
  }

  var auth = checkUserAuth(phone, pin);
  if (auth.exists && !auth.ok) {
    return { ok: false, status: "wrong_pin", error: "wrong_pin" };
  }

  var sheet = getOrCreateSheet("Профили");
  var now = new Date().toISOString();
  var foundRowIndex = auth.exists && auth.row ? auth.row._rowIndex : -1;
  var existingSecretWord = auth.exists && auth.row ? (auth.row.secretWord || "") : "";
  var existingSecretHint = auth.exists && auth.row ? (auth.row.secretHint || "") : "";
  var existingRole = auth.exists && auth.row && auth.row.role ? auth.row.role : (phone === PRIMARY_ADMIN_PHONE ? "admin" : "user");
  var existingChatAllowed = (auth.exists && auth.row && auth.row.chatAllowed !== undefined && String(auth.row.chatAllowed).trim() !== "")
    ? String(auth.row.chatAllowed)
    : (phone === PRIMARY_ADMIN_PHONE ? "true" : "false");
  var existingLastSeenAt = auth.exists && auth.row && auth.row.lastSeenAt ? String(auth.row.lastSeenAt) : now;
  var existingChatWelcomePending = auth.exists && auth.row && auth.row.chatWelcomePending !== undefined
    ? String(auth.row.chatWelcomePending)
    : "false";

  var prevRow = auth.exists && auth.row ? auth.row : {};
  var headers = SHEET_SCHEMAS["Профили"];
  var rowValues = [];

  var pickProfileField = function(field) {
    if (profile && profile[field] !== undefined) {
      return String(profile[field] === null ? "" : profile[field]);
    }
    if (payload[field] !== undefined) {
      return String(payload[field] === null ? "" : payload[field]);
    }
    return prevRow[field] !== undefined && prevRow[field] !== null ? String(prevRow[field]) : "";
  };

  for (var h = 0; h < headers.length; h++) {
    var col = headers[h];
    if (col === "userId") rowValues.push(phone);
    else if (col === "pin") rowValues.push(pin);
    else if (col === "secretWord") rowValues.push(existingSecretWord);
    else if (col === "secretHint") rowValues.push(existingSecretHint);
    else if (col === "fullName" || col === "position" || col === "organization" ||
             col === "normSummer" || col === "normWinter" || col === "carBrand" ||
             col === "carPlate" || col === "driverLicense" || col === "fuelType" ||
             col === "startPoint" || col === "theme") {
      rowValues.push(pickProfileField(col));
    }
    else if (col === "updatedAt") rowValues.push(now);
    else if (col === "role") rowValues.push(existingRole);
    else if (col === "chatAllowed") rowValues.push(existingChatAllowed);
    else if (col === "lastSeenAt") rowValues.push(existingLastSeenAt);
    else if (col === "chatWelcomePending") rowValues.push(existingChatWelcomePending);
    else if (col === "telegramTarget") {
      var incomingTg = (profile && profile.telegramTarget !== undefined) ? profile.telegramTarget : payload.telegramTarget;
      if (incomingTg !== undefined) {
        var parsedTg = parseTelegramTarget_(incomingTg);
        rowValues.push(parsedTg ? JSON.stringify(parsedTg) : "");
      } else {
        rowValues.push(prevRow.telegramTarget !== undefined && prevRow.telegramTarget !== null ? String(prevRow.telegramTarget) : "");
      }
    }
    else if (col === "speedDial") {
      var incomingSd = (profile && profile.speedDial !== undefined) ? profile.speedDial : payload.speedDial;
      if (incomingSd !== undefined) {
        var parsedSd = normalizeSpeedDialSlots_(incomingSd);
        rowValues.push(parsedSd ? JSON.stringify(parsedSd) : "");
      } else {
        rowValues.push(prevRow.speedDial !== undefined && prevRow.speedDial !== null ? String(prevRow.speedDial) : "");
      }
    }
    else rowValues.push("");
  }

  if (foundRowIndex > 0) {
    sheet.getRange(foundRowIndex, 1, 1, headers.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
  invalidateProfilesCache();

  var savedObj = {};
  for (var idx = 0; idx < headers.length; idx++) {
    savedObj[headers[idx]] = rowValues[idx];
  }
  return { ok: true, status: "saved", profile: buildUserProfileObject(savedObj, phone) };
}

function handleSaveMonth(payload) {
  var phone = normalizePhone(payload.userId || payload.phone);
  var pin = normalizePin(payload.pin);
  var yearMonth = normalizeYearMonth(payload.yearMonth);
  var monthData = payload.monthData || {};
  var summary = payload.summary || monthData._cloudSummary || {};

  if (!phone || pin.length !== 4 || !yearMonth) {
    return { ok: false, error: "Укажите телефон, ПИН-код и ключ месяца (ГГГГ-ММ)." };
  }

  var auth = checkUserAuth(phone, pin);
  if (auth.exists && !auth.ok) {
    return { ok: false, status: "wrong_pin", error: "wrong_pin" };
  }

  var sheet = getOrCreateSheet("Месяцы");
  var list = sheetToObjects(sheet);
  var now = new Date().toISOString();

  var odomStart = Number(summary.odometerStart !== undefined ? summary.odometerStart : monthData.odometerStart) || 0;
  var fuelStart = Number(summary.fuelStart !== undefined ? summary.fuelStart : monthData.fuelStart) || 0;
  var odomEnd = Number(summary.odometerEnd !== undefined ? summary.odometerEnd : monthData.odometerEnd) || odomStart;
  var fuelEnd = Number(summary.fuelEnd !== undefined ? summary.fuelEnd : monthData.fuelEnd) || fuelStart;

  var fullData = Object.assign({}, monthData, { _cloudSummary: summary });
  var jsonStr = JSON.stringify(fullData);

  var foundRowIndex = -1;
  for (var i = 0; i < list.length; i++) {
    if (normalizePhone(list[i].userId) === phone && normalizeYearMonth(list[i].yearMonth) === yearMonth) {
      foundRowIndex = list[i]._rowIndex;
      break;
    }
  }

  var headers = SHEET_SCHEMAS["Месяцы"];
  var rowValues = [];
  for (var h = 0; h < headers.length; h++) {
    var col = headers[h];
    if (col === "userId") rowValues.push(phone);
    else if (col === "yearMonth") rowValues.push("'" + yearMonth);
    else if (col === "odometerStart") rowValues.push(odomStart);
    else if (col === "fuelStart") rowValues.push(fuelStart);
    else if (col === "odometerEnd") rowValues.push(odomEnd);
    else if (col === "fuelEnd") rowValues.push(fuelEnd);
    else if (col === "dataJson") rowValues.push(jsonStr);
    else if (col === "updatedAt") rowValues.push(now);
    else rowValues.push("");
  }

  if (foundRowIndex > 0) {
    sheet.getRange(foundRowIndex, 1, 1, headers.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }

  return { ok: true, status: "saved" };
}

function handleSaveAddresses(payload) {
  var phone = normalizePhone(payload.userId || payload.phone);
  var pin = normalizePin(payload.pin);
  var addresses = Array.isArray(payload.addresses) ? payload.addresses : [];

  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите телефон и ПИН-код." };
  }

  var auth = checkUserAuth(phone, pin);
  if (auth.exists && !auth.ok) {
    return { ok: false, status: "wrong_pin", error: "wrong_pin" };
  }

  var sheet = getOrCreateSheet("Справочник_адресов");
  var list = sheetToObjects(sheet);
  var now = new Date().toISOString();

  // Удаляем старые записи этого пользователя снизу вверх
  for (var i = list.length - 1; i >= 0; i--) {
    if (normalizePhone(list[i].userId) === phone) {
      sheet.deleteRow(list[i]._rowIndex);
    }
  }

  // Добавляем обновлённый список пакетно через setValues
  var newRows = [];
  for (var a = 0; a < addresses.length; a++) {
    var addrItem = addresses[a];
    if (addrItem && addrItem.address) {
      newRows.push([phone, String(addrItem.address).trim(), String(addrItem.note || "").trim(), now]);
    }
  }
  if (newRows.length > 0) {
    var startRow = Math.max(2, sheet.getLastRow() + 1);
    sheet.getRange(startRow, 1, newRows.length, 4).setValues(newRows);
  }
  gasCacheRemove(GAS_CACHE_ADDR_PREFIX + phone);

  return { ok: true, status: "saved", count: addresses.length };
}

function handleSaveDistance(payload) {
  var sheet = getOrCreateSheet("Кэш_расстояний");
  var now = new Date().toISOString();

  if (payload.fromAddress && payload.toAddress && payload.km !== undefined) {
    var f = String(payload.fromAddress).trim();
    var t = String(payload.toAddress).trim();
    var km = Number(payload.km) || 0;
    var targetKey = makeDistanceCacheKey(f, t);

    var list = sheetToObjects(sheet);
    var foundIndex = -1;
    for (var i = 0; i < list.length; i++) {
      if (makeDistanceCacheKey(list[i].fromAddress, list[i].toAddress) === targetKey) {
        foundIndex = list[i]._rowIndex;
        break;
      }
    }

    if (foundIndex > 0) {
      sheet.getRange(foundIndex, 3, 1, 2).setValues([[km, now]]);
    } else {
      sheet.appendRow([f, t, km, now]);
    }
    gasCacheRemove(GAS_CACHE_DIST_KEY);
    return { ok: true, status: "saved" };
  }

  if (payload.entries && typeof payload.entries === "object") {
    var entries = payload.entries;
    var distRows = [];
    for (var k in entries) {
      var parts = k.split("|||");
      if (parts.length === 2) {
        distRows.push([parts[0], parts[1], Number(entries[k]) || 0, now]);
      }
    }
    if (distRows.length > 0) {
      var dStartRow = Math.max(2, sheet.getLastRow() + 1);
      sheet.getRange(dStartRow, 1, distRows.length, 4).setValues(distRows);
      gasCacheRemove(GAS_CACHE_DIST_KEY);
    }
    return { ok: true, status: "saved" };
  }

  return { ok: false, error: "Не переданы адреса или расстояния." };
}


/* =========================================================================
   ОБРАБОТЧИКИ МОДУЛЯ «МАРШРУТЫ»
   ========================================================================= */

function handleRoutesSave(payload) {
  var phone = normalizePhone(payload.userId || payload.phone);
  var pin = normalizePin(payload.pin);
  var stateObj = payload.state || {};

  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите телефон и 4-значный ПИН-код." };
  }

  var auth = checkUserAuth(phone, pin);
  if (auth.exists && !auth.ok) {
    return { ok: false, status: "wrong_pin", error: "Неверный ПИН-код." };
  }

  var sheet = getOrCreateSheet("Маршруты_Эксперт");
  var list = sheetToObjects(sheet);
  var now = new Date().toISOString();
  var jsonStr = JSON.stringify(stateObj);
  var foundRowIndex = -1;

  for (var i = 0; i < list.length; i++) {
    if (normalizePhone(list[i].userId) === phone) {
      foundRowIndex = list[i]._rowIndex;
      break;
    }
  }

  var rowValues = [phone, pin, jsonStr, now];
  if (foundRowIndex > 0) {
    sheet.getRange(foundRowIndex, 1, 1, 4).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }

  return { ok: true, status: "saved" };
}

function handleRoutesLoad(payload) {
  var phone = normalizePhone(payload.userId || payload.phone);
  var pin = normalizePin(payload.pin);

  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите телефон и 4-значный ПИН-код." };
  }

  var auth = checkUserAuth(phone, pin);
  if (auth.exists && !auth.ok) {
    return { ok: false, status: "wrong_pin", error: "Неверный ПИН-код." };
  }

  var sheet = getOrCreateSheet("Маршруты_Эксперт");
  var list = sheetToObjects(sheet);
  for (var i = 0; i < list.length; i++) {
    if (normalizePhone(list[i].userId) === phone) {
      var parsed = null;
      if (list[i].stateJson) {
        try {
          parsed = JSON.parse(list[i].stateJson);
        } catch (e) {
          parsed = null;
        }
      }
      return { ok: true, status: "ok", state: parsed };
    }
  }

  return { ok: true, status: "not_found", state: null };
}

/* =========================================================================
   ОБРАБОТЧИКИ МОДУЛЯ «ЗАЯВКА НА СКЛАД»
   ========================================================================= */

function handleSkladSave(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  var pin = normalizePin(payload.pin);
  var statePayload = payload.payload || payload.state || {};
  var newOrder = payload.newOrder || null;

  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите телефон и 4-значный ПИН-код." };
  }

  var auth = checkUserAuth(phone, pin);
  if (auth.exists && !auth.ok) {
    return { ok: false, status: "wrong_pin", error: "wrong_pin" };
  }

  var sheet = getOrCreateSheet("Пользователи_Склад");
  var list = sheetToObjects(sheet);
  var now = new Date().toISOString();
  var foundRowIndex = -1;

  for (var i = 0; i < list.length; i++) {
    if (normalizePhone(list[i].phone) === phone) {
      foundRowIndex = list[i]._rowIndex;
      break;
    }
  }

  var profileObj = statePayload.userProfile || {};
  var fullName = String(profileObj.name || "").trim();
  var address = String(profileObj.address || "").trim();
  var jsonStr = JSON.stringify(statePayload);
  var rowValues = [phone, pin, fullName, address, now, "", "", "", jsonStr];

  if (foundRowIndex > 0) {
    sheet.getRange(foundRowIndex, 1, 1, 9).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
  gasCacheRemove(GAS_CACHE_SKLAD_PREFIX + phone);

  if (newOrder && newOrder.items && newOrder.items.length > 0) {
    var ordersSheet = getOrCreateSheet("Все заказы");
    var itemsSummary = newOrder.items.map(function(it) {
      var name = (it.equipment && it.equipment.name) || it.name || "";
      var id = (it.equipment && it.equipment.id) || it.id || "";
      return "[" + id + "] " + name + " x " + (it.quantity || 1);
    }).join("; ");
    ordersSheet.appendRow([
      newOrder.date || now,
      newOrder.orderNumber || ("#" + Date.now()),
      fullName,
      phone,
      newOrder.method || "",
      address,
      itemsSummary
    ]);
  }

  return { ok: true, status: "saved" };
}

function handleSkladLoad(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  var pin = normalizePin(payload.pin);

  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите телефон и 4-значный ПИН-код." };
  }

  var auth = checkUserAuth(phone, pin);
  if (auth.exists && !auth.ok) {
    return { ok: false, status: "wrong_pin", error: "wrong_pin" };
  }

  var skladCacheKey = GAS_CACHE_SKLAD_PREFIX + phone;
  var cachedSklad = gasCacheGet(skladCacheKey);
  if (cachedSklad && cachedSklad.ok) {
    return cachedSklad;
  }

  var sheet = getOrCreateSheet("Пользователи_Склад");
  var list = sheetToObjects(sheet);

  for (var i = 0; i < list.length; i++) {
    if (normalizePhone(list[i].phone) === phone) {
      if (list[i].pin && normalizePin(list[i].pin) !== pin) {
        return { ok: false, status: "wrong_pin", error: "wrong_pin" };
      }
      var parsed = null;
      if (list[i].stateJson) {
        try {
          parsed = JSON.parse(list[i].stateJson);
        } catch (e) {
          parsed = null;
        }
      }
      var foundRes = {
        ok: true,
        status: "ok",
        fullName: list[i].fullName || "",
        address: list[i].address || "",
        payload: parsed
      };
      gasCachePut(skladCacheKey, foundRes, 180);
      return foundRes;
    }
  }

  var emptyRes = { ok: true, status: "not_found", payload: null };
  gasCachePut(skladCacheKey, emptyRes, 180);
  return emptyRes;
}

/* =========================================================================
   ОБРАБОТЧИКИ АДМИН-МЕНЮ (ПРОВЕРКА ПРАВ АДМИНИСТРАТОРА ОБЯЗАТЕЛЬНА)
   ========================================================================= */

function handleAdminUsersList(payload) {
  var check = verifyAdminAccess(payload);
  if (!check.ok) return check;

  var list = getCachedProfilesRows(false);
  var lastSeenMap = getLastSeenMap();
  var nowMs = Date.now();
  var users = list.map(function(r) {
    var p = normalizePhone(r.userId);
    var tableSeenStr = r.lastSeenAt ? String(r.lastSeenAt) : "";
    var cacheSeenStr = lastSeenMap[p] ? String(lastSeenMap[p]) : "";
    var tableSeenMs = parseIsoTimeMs(tableSeenStr);
    var cacheSeenMs = parseIsoTimeMs(cacheSeenStr);
    var bestSeenMs = Math.max(tableSeenMs, cacheSeenMs);
    var lastSeenAtStr = cacheSeenMs > tableSeenMs ? cacheSeenStr : tableSeenStr;
    var isOnline = bestSeenMs > 0 && (nowMs - bestSeenMs) <= 3 * 60 * 1000;
    return {
      phone: p,
      userId: p,
      pin: normalizePin(r.pin),
      secretWord: r.secretWord || "",
      secretHint: r.secretHint || "",
      fullName: r.fullName || "",
      position: r.position || "",
      organization: r.organization || "",
      normSummer: r.normSummer || "",
      normWinter: r.normWinter || "",
      carBrand: r.carBrand || "",
      carPlate: r.carPlate || "",
      driverLicense: r.driverLicense || "",
      fuelType: r.fuelType || "",
      startPoint: r.startPoint || "",
      updatedAt: r.updatedAt || "",
      lastSeenAt: lastSeenAtStr,
      isOnline: isOnline,
      role: isRowAdmin(r, p) ? "admin" : "user",
      isAdmin: isRowAdmin(r, p),
      chatAllowed: isRowChatAllowed(r, p),
      chatWelcomePending: parseBoolFlag(r.chatWelcomePending)
    };
  });

  var securityAlerts = getSecurityAlertsList(30);
  return { ok: true, users: users, securityAlerts: securityAlerts };
}

function handleAdminUserDetails(payload) {
  var check = verifyAdminAccess(payload);
  if (!check.ok) return check;

  var targetPhone = normalizePhone(payload.targetPhone || payload.userId);
  if (!targetPhone) {
    return { ok: false, error: "Укажите телефон пользователя." };
  }

  var profSheet = getOrCreateSheet("Профили");
  var profList = sheetToObjects(profSheet);
  var profileObj = null;
  for (var i = 0; i < profList.length; i++) {
    if (normalizePhone(profList[i].userId) === targetPhone) {
      var r = profList[i];
      profileObj = {
        userId: targetPhone,
        pin: normalizePin(r.pin),
        secretWord: r.secretWord || "",
        secretHint: r.secretHint || "",
        fullName: r.fullName || "",
        position: r.position || "",
        organization: r.organization || "",
        normSummer: r.normSummer || "",
        normWinter: r.normWinter || "",
        carBrand: r.carBrand || "",
        carPlate: r.carPlate || "",
        driverLicense: r.driverLicense || "",
        fuelType: r.fuelType || "",
        startPoint: r.startPoint || "",
        updatedAt: r.updatedAt || "",
        role: isRowAdmin(r, targetPhone) ? "admin" : "user",
        isAdmin: isRowAdmin(r, targetPhone),
        chatAllowed: isRowChatAllowed(r, targetPhone)
      };
      break;
    }
  }

  // Месяцы (Автоотчёт)
  var monthsSheet = getOrCreateSheet("Месяцы");
  var monthsList = sheetToObjects(monthsSheet);
  var monthsSummary = [];
  for (var m = 0; m < monthsList.length; m++) {
    if (normalizePhone(monthsList[m].userId) === targetPhone) {
      monthsSummary.push({
        yearMonth: normalizeYearMonth(monthsList[m].yearMonth),
        odometerStart: monthsList[m].odometerStart || 0,
        odometerEnd: monthsList[m].odometerEnd || 0,
        fuelStart: monthsList[m].fuelStart || 0,
        fuelEnd: monthsList[m].fuelEnd || 0,
        updatedAt: monthsList[m].updatedAt || ""
      });
    }
  }

  // Адреса
  var addrSheet = getOrCreateSheet("Справочник_адресов");
  var addrList = sheetToObjects(addrSheet);
  var addresses = [];
  for (var a = 0; a < addrList.length; a++) {
    if (normalizePhone(addrList[a].userId) === targetPhone) {
      addresses.push({ address: addrList[a].address || "", note: addrList[a].note || "" });
    }
  }

  // Маршруты
  var routesSheet = getOrCreateSheet("Маршруты_Эксперт");
  var routesList = sheetToObjects(routesSheet);
  var routesData = null;
  for (var rt = 0; rt < routesList.length; rt++) {
    if (normalizePhone(routesList[rt].userId) === targetPhone) {
      try { routesData = routesList[rt].stateJson ? JSON.parse(routesList[rt].stateJson) : null; } catch (e) { routesData = null; }
      break;
    }
  }

  // Склад
  var skladSheet = getOrCreateSheet("Пользователи_Склад");
  var skladList = sheetToObjects(skladSheet);
  var skladData = null;
  for (var sk = 0; sk < skladList.length; sk++) {
    if (normalizePhone(skladList[sk].phone) === targetPhone) {
      try { skladData = skladList[sk].stateJson ? JSON.parse(skladList[sk].stateJson) : null; } catch (e) { skladData = null; }
      break;
    }
  }

  // Заказы
  var ordersSheet = getOrCreateSheet("Все заказы");
  var ordersList = sheetToObjects(ordersSheet);
  var orders = [];
  for (var o = 0; o < ordersList.length; o++) {
    if (normalizePhone(ordersList[o]["Телефон"]) === targetPhone) {
      orders.push({
        date: ordersList[o]["Дата и время"] || "",
        orderNumber: ordersList[o]["Заказ №"] || "",
        method: ordersList[o]["Способ получения"] || "",
        address: ordersList[o]["Адрес ПВЗ"] || "",
        items: ordersList[o]["Состав заказа"] || ""
      });
    }
  }

  return {
    ok: true,
    targetPhone: targetPhone,
    profile: profileObj,
    months: monthsSummary,
    addresses: addresses,
    routes: routesData,
    warehouse: skladData,
    orders: orders
  };
}

function handleAdminUserUpdate(payload) {
  var check = verifyAdminAccess(payload);
  if (!check.ok) return check;

  var targetPhone = normalizePhone(payload.targetPhone || payload.userId);
  var updates = payload.updates || {};
  if (!targetPhone) {
    return { ok: false, error: "Укажите телефон редактируемого пользователя." };
  }

  var sheet = getOrCreateSheet("Профили");
  var list = sheetToObjects(sheet);
  var foundRow = null;
  for (var i = 0; i < list.length; i++) {
    if (normalizePhone(list[i].userId) === targetPhone) {
      foundRow = list[i];
      break;
    }
  }
  if (!foundRow) {
    return { ok: false, error: "Пользователь не найден в таблице «Профили»." };
  }

  var headers = SHEET_SCHEMAS["Профили"];
  var now = new Date().toISOString();
  var nextPhone = updates.userId !== undefined ? normalizePhone(updates.userId) : targetPhone;
  if (!nextPhone || nextPhone.length !== 11) nextPhone = targetPhone;

  var wasChatAllowed = isRowChatAllowed(foundRow, targetPhone);
  var nextChatAllowed = updates.chatAllowed !== undefined ? parseBoolFlag(updates.chatAllowed) : wasChatAllowed;
  var nextChatWelcomePending = foundRow.chatWelcomePending !== undefined ? String(foundRow.chatWelcomePending) : "false";
  if (updates.chatAllowed !== undefined) {
    if (!wasChatAllowed && nextChatAllowed) {
      nextChatWelcomePending = "true";
    } else if (!nextChatAllowed) {
      nextChatWelcomePending = "false";
    }
  }
  if (updates.chatWelcomePending !== undefined) {
    nextChatWelcomePending = parseBoolFlag(updates.chatWelcomePending) ? "true" : "false";
  }

  var rowValues = [];
  for (var h = 0; h < headers.length; h++) {
    var col = headers[h];
    if (col === "userId") {
      rowValues.push(nextPhone);
    } else if (col === "pin") {
      var nextPin = updates.pin !== undefined ? normalizePin(updates.pin) : normalizePin(foundRow.pin);
      rowValues.push(nextPin.length === 4 ? nextPin : normalizePin(foundRow.pin));
    } else if (col === "updatedAt") {
      rowValues.push(now);
    } else if (col === "role") {
      var nextRole = updates.role !== undefined ? String(updates.role).trim().toLowerCase() : (foundRow.role || "user");
      if (nextPhone === PRIMARY_ADMIN_PHONE) nextRole = "admin";
      rowValues.push(nextRole === "admin" ? "admin" : "user");
    } else if (col === "chatAllowed") {
      rowValues.push(nextChatAllowed ? "true" : "false");
    } else if (col === "chatWelcomePending") {
      rowValues.push(nextChatWelcomePending);
    } else if (updates[col] !== undefined) {
      rowValues.push(String(updates[col]));
    } else {
      rowValues.push(foundRow[col] !== undefined ? foundRow[col] : "");
    }
  }

  sheet.getRange(foundRow._rowIndex, 1, 1, headers.length).setValues([rowValues]);
  invalidateProfilesCache();
  return {
    ok: true,
    updated: true,
    targetPhone: nextPhone,
    chatAllowed: nextChatAllowed,
    chatWelcomePending: parseBoolFlag(nextChatWelcomePending)
  };
}

function handleAdminToggleChat(payload) {
  var check = verifyAdminAccess(payload);
  if (!check.ok) return check;

  var targetPhone = normalizePhone(payload.targetPhone || payload.userId);
  if (!targetPhone) {
    return { ok: false, error: "Укажите телефон пользователя." };
  }

  return handleAdminUserUpdate({
    adminPhone: check.adminPhone,
    adminPin: payload.adminPin || payload.pin,
    targetPhone: targetPhone,
    updates: { chatAllowed: parseBoolFlag(payload.chatAllowed) }
  });
}

function handleAdminUserDelete(payload) {
  var check = verifyAdminAccess(payload);
  if (!check.ok) return check;

  var targetPhone = normalizePhone(payload.targetPhone || payload.userId);
  if (!targetPhone) {
    return { ok: false, error: "Укажите телефон удаляемого пользователя." };
  }
  if (targetPhone === check.adminPhone || targetPhone === PRIMARY_ADMIN_PHONE) {
    return { ok: false, error: "Нельзя удалить учётную запись главного администратора." };
  }

  var profSheet = getOrCreateSheet("Профили");
  var profList = sheetToObjects(profSheet);
  var deletedFromProfiles = 0;
  for (var i = profList.length - 1; i >= 0; i--) {
    if (normalizePhone(profList[i].userId) === targetPhone) {
      profSheet.deleteRow(profList[i]._rowIndex);
      deletedFromProfiles++;
    }
  }

  if (deletedFromProfiles === 0) {
    return { ok: false, error: "Пользователь не найден." };
  }
  invalidateProfilesCache();
  gasCacheRemove(GAS_CACHE_SKLAD_PREFIX + targetPhone);
  gasCacheRemove(GAS_CACHE_ADDR_PREFIX + targetPhone);

  var deleteModuleData = payload.deleteModuleData !== false;
  if (deleteModuleData) {
    var targets = [
      { sheet: "Месяцы", col: "userId" },
      { sheet: "Справочник_адресов", col: "userId" },
      { sheet: "Маршруты_Эксперт", col: "userId" },
      { sheet: "Пользователи_Склад", col: "phone" }
    ];
    for (var t = 0; t < targets.length; t++) {
      var sh = getOrCreateSheet(targets[t].sheet);
      var rows = sheetToObjects(sh);
      for (var r = rows.length - 1; r >= 0; r--) {
        if (normalizePhone(rows[r][targets[t].col]) === targetPhone) {
          sh.deleteRow(rows[r]._rowIndex);
        }
      }
    }
  }

  return { ok: true, deleted: true, targetPhone: targetPhone };
}

function parseIsoTimeMs(val) {
  if (!val) return 0;
  if (val instanceof Date) return val.getTime();
  var parsed = Date.parse(String(val));
  return isNaN(parsed) ? 0 : parsed;
}

function updateProfileColumnValue(phone, colName, value) {
  var sheet = getOrCreateSheet("Профили");
  var list = getCachedProfilesRows(false);
  var headers = SHEET_SCHEMAS["Профили"];
  var colIdx = headers.indexOf(colName);
  if (colIdx < 0) return false;

  for (var i = 0; i < list.length; i++) {
    if (normalizePhone(list[i].userId) === phone) {
      sheet.getRange(list[i]._rowIndex, colIdx + 1).setValue(value);
      invalidateProfilesCache();
      return true;
    }
  }
  return false;
}

function getSecurityAlertsList(limitCount) {
  var cachedAll = gasCacheGet(GAS_CACHE_ALERTS_KEY);
  var allList;
  if (Array.isArray(cachedAll)) {
    allList = cachedAll;
  } else {
    var sheet = getOrCreateSheet("Алерты_Чат");
    var rows = sheetToObjects(sheet);
    allList = [];
    for (var i = rows.length - 1; i >= 0; i--) {
      var r = rows[i];
      if (!r.id && !r.userPhone) continue;
      allList.push({
        id: String(r.id || ""),
        userPhone: normalizePhone(r.userPhone),
        userName: String(r.userName || ""),
        eventType: String(r.eventType || ""),
        details: String(r.details || ""),
        createdAt: String(r.createdAt || ""),
        seenByAdmin: parseBoolFlag(r.seenByAdmin)
      });
    }
    gasCachePut(GAS_CACHE_ALERTS_KEY, allList, 180);
  }
  return limitCount ? allList.slice(0, limitCount) : allList;
}

function getCachedPendingPopups() {
  var cached = gasCacheGet(GAS_CACHE_POPUPS_KEY);
  if (Array.isArray(cached)) {
    return cached;
  }
  var msgSheet = getOrCreateSheet("Сообщения_Админа");
  var msgRows = sheetToObjects(msgSheet);
  var pending = [];
  for (var i = 0; i < msgRows.length; i++) {
    var m = msgRows[i];
    if (!String(m.readAt || "").trim() && m.id) {
      pending.push({
        id: String(m.id || ""),
        targetPhone: normalizePhone(m.targetPhone),
        message: String(m.message || ""),
        senderPhone: normalizePhone(m.senderPhone),
        createdAt: String(m.createdAt || "")
      });
    }
  }
  gasCachePut(GAS_CACHE_POPUPS_KEY, pending, 180);
  return pending;
}

function handleUserHeartbeat(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  var pin = normalizePin(payload.pin);
  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите телефон и 4-значный ПИН-код." };
  }

  var auth = checkUserAuth(phone, pin);
  if (!auth.exists || !auth.ok || !auth.row) {
    return { ok: false, error: "Ошибка авторизации." };
  }

  var now = new Date().toISOString();
  var nowMs = Date.now();
  // Мгновенно обновляем онлайн-метку в CacheService, а в таблицу пишем не чаще 1 раза в 120 с
  touchLastSeenInCache(phone, now);
  var prevTableSeenMs = parseIsoTimeMs(auth.row.lastSeenAt);
  if (!prevTableSeenMs || (nowMs - prevTableSeenMs) > 120000) {
    updateProfileColumnValue(phone, "lastSeenAt", now);
  }

  var userIsAdmin = isRowAdmin(auth.row, phone);
  var userChatAllowed = isRowChatAllowed(auth.row, phone);
  var chatWelcomePending = parseBoolFlag(auth.row.chatWelcomePending);

  // Непрочитанные всплывающие сообщения от администратора (из кэша)
  var allPendingPopups = getCachedPendingPopups();
  var popups = [];
  for (var i = 0; i < allPendingPopups.length; i++) {
    if (allPendingPopups[i].targetPhone === phone) {
      popups.push(allPendingPopups[i]);
    }
  }

  // Непросмотренные алерты безопасности для администратора (из кэша)
  var unseenAlerts = [];
  if (userIsAdmin) {
    var allAlerts = getSecurityAlertsList(100);
    for (var a = 0; a < allAlerts.length; a++) {
      if (!allAlerts[a].seenByAdmin) {
        unseenAlerts.push(allAlerts[a]);
      }
    }
  }

  var resp = {
    ok: true,
    phone: phone,
    role: userIsAdmin ? "admin" : "user",
    isAdmin: userIsAdmin,
    chatAllowed: userChatAllowed,
    chatWelcomePending: chatWelcomePending,
    lastSeenAt: now,
    profile: buildUserProfileObject(auth.row, phone),
    popups: popups,
    alerts: unseenAlerts
  };

  // При старте хаба отдаём сообщения чата и адреса в том же запросе, чтобы не слать лишних запросов
  if (payload.includeChat && userChatAllowed) {
    resp.messages = getCachedRecentChatMessages();
  }
  if (payload.includeAddresses || payload.includeChat) {
    resp.addresses = getUserAddressesList(phone);
  }

  return resp;
}

function handleUserAckChatWelcome(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  var pin = normalizePin(payload.pin);
  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите телефон и ПИН-код." };
  }

  var auth = checkUserAuth(phone, pin);
  if (!auth.exists || !auth.ok) {
    return { ok: false, error: "Ошибка авторизации." };
  }

  updateProfileColumnValue(phone, "chatWelcomePending", "false");
  return { ok: true, chatWelcomePending: false };
}

function handleAdminSendPopup(payload) {
  var check = verifyAdminAccess(payload);
  if (!check.ok) return check;

  var targetPhone = normalizePhone(payload.targetPhone || payload.userId);
  var message = String(payload.message || "").trim();
  if (!targetPhone || targetPhone.length !== 11) {
    return { ok: false, error: "Укажите корректный телефон получателя." };
  }
  if (!message) {
    return { ok: false, error: "Введите текст сообщения." };
  }

  var sheet = getOrCreateSheet("Сообщения_Админа");
  var now = new Date().toISOString();
  var id = "pop-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  var headers = SHEET_SCHEMAS["Сообщения_Админа"];
  var rowValues = [];
  for (var h = 0; h < headers.length; h++) {
    var col = headers[h];
    if (col === "id") rowValues.push(id);
    else if (col === "targetPhone") rowValues.push(targetPhone);
    else if (col === "message") rowValues.push(message);
    else if (col === "senderPhone") rowValues.push(check.adminPhone);
    else if (col === "createdAt") rowValues.push(now);
    else if (col === "readAt") rowValues.push("");
    else rowValues.push("");
  }
  sheet.appendRow(rowValues);
  gasCacheRemove(GAS_CACHE_POPUPS_KEY);
  return { ok: true, id: id, targetPhone: targetPhone, createdAt: now };
}

function handleUserMarkPopupRead(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  var pin = normalizePin(payload.pin);
  var popupId = String(payload.popupId || payload.id || "").trim();
  if (!phone || pin.length !== 4 || !popupId) {
    return { ok: false, error: "Недостаточно данных для отметки сообщения." };
  }

  var auth = checkUserAuth(phone, pin);
  if (!auth.exists || !auth.ok) {
    return { ok: false, error: "Ошибка авторизации." };
  }

  var sheet = getOrCreateSheet("Сообщения_Админа");
  var rows = sheetToObjects(sheet);
  var headers = SHEET_SCHEMAS["Сообщения_Админа"];
  var readColIdx = headers.indexOf("readAt") + 1;
  var now = new Date().toISOString();

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id || "") === popupId && normalizePhone(rows[i].targetPhone) === phone) {
      if (readColIdx > 0) {
        sheet.getRange(rows[i]._rowIndex, readColIdx, 1, 1).setValues([[now]]);
        gasCacheRemove(GAS_CACHE_POPUPS_KEY);
      }
      return { ok: true, id: popupId, readAt: now };
    }
  }
  return { ok: true, id: popupId, readAt: now };
}

function handleLogChatSecurityAlert(payload) {
  var phone = normalizePhone(payload.userPhone || payload.phone || payload.userId);
  var pin = normalizePin(payload.pin);
  if (!phone || pin.length !== 4) {
    return { ok: false, error: "Укажите телефон и ПИН-код." };
  }

  var auth = checkUserAuth(phone, pin);
  if (!auth.exists || !auth.ok) {
    return { ok: false, error: "Ошибка авторизации." };
  }

  var userName = String(payload.userName || (auth.row && auth.row.fullName) || "").trim();
  var eventType = String(payload.eventType || "unknown").trim();
  var details = String(payload.details || "").trim();
  var now = new Date().toISOString();
  var id = "alr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);

  var sheet = getOrCreateSheet("Алерты_Чат");
  var headers = SHEET_SCHEMAS["Алерты_Чат"];
  var rowValues = [];
  for (var h = 0; h < headers.length; h++) {
    var col = headers[h];
    if (col === "id") rowValues.push(id);
    else if (col === "userPhone") rowValues.push(phone);
    else if (col === "userName") rowValues.push(userName);
    else if (col === "eventType") rowValues.push(eventType);
    else if (col === "details") rowValues.push(details);
    else if (col === "createdAt") rowValues.push(now);
    else if (col === "seenByAdmin") rowValues.push("false");
    else rowValues.push("");
  }
  sheet.appendRow(rowValues);
  gasCacheRemove(GAS_CACHE_ALERTS_KEY);
  return { ok: true, id: id, createdAt: now };
}

function handleAdminMarkAlertsSeen(payload) {
  var check = verifyAdminAccess(payload);
  if (!check.ok) return check;

  var alertIds = Array.isArray(payload.alertIds) ? payload.alertIds.map(function (x) { return String(x); }) : null;
  var sheet = getOrCreateSheet("Алерты_Чат");
  var lastRow = sheet.getLastRow();
  var headers = SHEET_SCHEMAS["Алерты_Чат"];
  var idColIdx = headers.indexOf("id") + 1;
  var seenColIdx = headers.indexOf("seenByAdmin") + 1;
  var marked = 0;

  if (lastRow >= 2 && idColIdx > 0 && seenColIdx > 0) {
    var numRows = lastRow - 1;
    var idValues = sheet.getRange(2, idColIdx, numRows, 1).getValues();
    var seenValues = sheet.getRange(2, seenColIdx, numRows, 1).getValues();
    var changed = false;

    for (var i = 0; i < numRows; i++) {
      var rId = String(idValues[i][0] || "");
      var isMatch = !alertIds || alertIds.length === 0 || alertIds.indexOf(rId) !== -1;
      if (isMatch && !parseBoolFlag(seenValues[i][0])) {
        seenValues[i][0] = "true";
        marked++;
        changed = true;
      }
    }
    if (changed) {
      sheet.getRange(2, seenColIdx, numRows, 1).setValues(seenValues);
      gasCacheRemove(GAS_CACHE_ALERTS_KEY);
    }
  }
  return { ok: true, marked: marked };
}
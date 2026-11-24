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

const SHEET_SCHEMAS = {
  "Профили": [
    "userId", "pin", "secretWord", "secretHint", "fullName", "position",
    "organization", "normSummer", "normWinter", "carBrand", "carPlate",
    "driverLicense", "fuelType", "startPoint", "updatedAt", "role", "chatAllowed"
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

function cleanAddressKey(addr) {
  return String(addr || "").trim().toLowerCase().replace(/[\s\u00A0.,/\\-]/g, " ");
}

function makeDistanceCacheKey(addr1, addr2) {
  var n1 = cleanAddressKey(addr1);
  var n2 = cleanAddressKey(addr2);
  return n1 < n2 ? (n1 + "|||" + n2) : (n2 + "|||" + n1);
}

function getOrCreateSheet(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  var schema = SHEET_SCHEMAS[sheetName];

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (schema && schema.length > 0) {
      sheet.getRange(1, 1, 1, schema.length).setValues([schema]);
      sheet.setFrozenRows(1);
    }
  } else if (schema && sheet.getLastRow() === 0) {
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
  for (var name in SHEET_SCHEMAS) {
    getOrCreateSheet(name);
  }
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
  var sheet = getOrCreateSheet("Профили");
  var list = sheetToObjects(sheet);
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

      // ── Администрирование ──
      case "adminUsersList":
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
  }
}

/* =========================================================================
   ОБРАБОТЧИКИ КАРКАСА («ЭКСПЕРТ»)
   ========================================================================= */

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

  return {
    ok: true,
    userId: auth.row.userId,
    fullName: auth.row.fullName || "",
    position: auth.row.position || "",
    phone: phone,
    role: userIsAdmin ? "admin" : "user",
    isAdmin: userIsAdmin,
    chatAllowed: userChatAllowed
  };
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
  var list = sheetToObjects(sheet);
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
    else rowValues.push(existingRow && existingRow[col] !== undefined ? existingRow[col] : "");
  }

  if (foundRowIndex > 0) {
    sheet.getRange(foundRowIndex, 1, 1, headers.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }

  var isAdm = isRowAdmin({ userId: phone, role: assignedRole }, phone);
  return {
    ok: true,
    phone: phone,
    fullName: fullName,
    role: isAdm ? "admin" : "user",
    isAdmin: isAdm,
    chatAllowed: parseBoolFlag(assignedChatAllowed)
  };
}

function handleAuthGetHint(payload) {
  var phone = normalizePhone(payload.phone || payload.userId);
  if (!phone) {
    return { ok: false, error: "Укажите номер телефона." };
  }

  var sheet = getOrCreateSheet("Профили");
  var list = sheetToObjects(sheet);

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
  var list = sheetToObjects(sheet);

  for (var i = 0; i < list.length; i++) {
    if (normalizePhone(list[i].userId) === phone) {
      var realSecret = String(list[i].secretWord || "").trim().toLowerCase();
      if (realSecret !== secretWord) {
        return { ok: false, error: "Неверное кодовое слово." };
      }

      var rowIndex = list[i]._rowIndex;
      var headers = SHEET_SCHEMAS["Профили"];
      var pinCol = headers.indexOf("pin") + 1;
      var updatedCol = headers.indexOf("updatedAt") + 1;

      sheet.getRange(rowIndex, pinCol).setValue(newPin);
      sheet.getRange(rowIndex, updatedCol).setValue(new Date().toISOString());

      return { ok: true, message: "ПИН-код успешно обновлён." };
    }
  }

  return { ok: false, error: "Пользователь с таким номером не найден." };
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

  var sheet = getOrCreateSheet("Чат_Эксперт");
  var list = sheetToObjects(sheet);
  var recent = list.slice(-50);

  var formatted = recent.map(function(r) {
    return {
      id: r.id || ("msg-" + r._rowIndex),
      date: r.date || "",
      time: r.time || "",
      userName: r.userName || "",
      userPhone: r.userPhone || "",
      message: r.message || ""
    };
  });

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
  var date = payload.date || "";
  var time = payload.time || "";
  var userName = payload.userName || auth.row.fullName || "Сотрудник";
  var createdAt = new Date().toISOString();

  sheet.appendRow([id, date, time, userName, phone, text, createdAt]);
  return { ok: true, id: id };
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
    sheet.deleteRows(2, deletedCount);
  }

  return {
    ok: true,
    cleared: true,
    deletedCount: deletedCount,
    messages: []
  };
}

function handleContactsList(payload) {
  var sheet = getOrCreateSheet("Контакты_Эксперт");
  var list = sheetToObjects(sheet);

  if (list.length === 0) {
    var defaults = [
      ["c-1", "Беляев Михаил Константинович", "+7 903 724 47 14", "Главный инженер", new Date().toISOString()],
      ["c-2", "Складской комплекс / ПВЗ", "+7 999 123 45 67", "Приёмка и выдача заказов", new Date().toISOString()],
      ["c-3", "Диспетчерская служба", "+7 900 111 22 33", "Маршруты и путевые листы", new Date().toISOString()]
    ];
    for (var d = 0; d < defaults.length; d++) {
      sheet.appendRow(defaults[d]);
    }
    list = sheetToObjects(sheet);
  }

  var formatted = list.map(function(c) {
    return {
      id: c.id || ("c-" + c._rowIndex),
      fullName: c.fullName || "",
      phone: c.phone || "",
      note: c.note || ""
    };
  });

  return { ok: true, contacts: formatted };
}

/* =========================================================================
   ОБРАБОТЧИКИ МОДУЛЯ «АВТООТЧЁТ»
   ========================================================================= */

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

  // 1. Профиль
  var profileObj = {};
  if (auth.exists && auth.row) {
    var r = auth.row;
    profileObj = {
      fullName: r.fullName || "",
      position: r.position || "",
      organization: r.organization || "",
      normSummer: r.normSummer || "",
      normWinter: r.normWinter || "",
      carBrand: r.carBrand || "",
      carPlate: r.carPlate || "",
      driverLicense: r.driverLicense || "",
      fuelType: r.fuelType || "",
      startPoint: r.startPoint || ""
    };
  }

  // 2. Месяцы
  var monthsSheet = getOrCreateSheet("Месяцы");
  var monthsList = sheetToObjects(monthsSheet);
  var userMonths = {};

  for (var m = 0; m < monthsList.length; m++) {
    var mRow = monthsList[m];
    if (normalizePhone(mRow.userId) === phone && mRow.yearMonth) {
      var ymKey = String(mRow.yearMonth).trim();
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

  // 3. Адреса
  var addrSheet = getOrCreateSheet("Справочник_адресов");
  var addrList = sheetToObjects(addrSheet);
  var userAddresses = [];

  for (var a = 0; a < addrList.length; a++) {
    var aRow = addrList[a];
    if (normalizePhone(aRow.userId) === phone && aRow.address) {
      userAddresses.push({
        address: aRow.address,
        note: aRow.note || ""
      });
    }
  }

  // 4. Кэш расстояний (общий для всех)
  var distSheet = getOrCreateSheet("Кэш_расстояний");
  var distList = sheetToObjects(distSheet);
  var distanceCache = {};

  for (var d = 0; d < distList.length; d++) {
    var dRow = distList[d];
    if (dRow.fromAddress && dRow.toAddress && dRow.km !== undefined && dRow.km !== "") {
      var cKey = makeDistanceCacheKey(dRow.fromAddress, dRow.toAddress);
      distanceCache[cKey] = Number(dRow.km) || 0;
    }
  }

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
  var list = sheetToObjects(sheet);
  var now = new Date().toISOString();
  var foundRowIndex = auth.exists && auth.row ? auth.row._rowIndex : -1;
  var existingSecretWord = auth.exists && auth.row ? (auth.row.secretWord || "") : "";
  var existingSecretHint = auth.exists && auth.row ? (auth.row.secretHint || "") : "";
  var existingRole = auth.exists && auth.row && auth.row.role ? auth.row.role : (phone === PRIMARY_ADMIN_PHONE ? "admin" : "user");
  var existingChatAllowed = (auth.exists && auth.row && auth.row.chatAllowed !== undefined && String(auth.row.chatAllowed).trim() !== "")
    ? String(auth.row.chatAllowed)
    : (phone === PRIMARY_ADMIN_PHONE ? "true" : "false");

  var headers = SHEET_SCHEMAS["Профили"];
  var rowValues = [];

  for (var h = 0; h < headers.length; h++) {
    var col = headers[h];
    if (col === "userId") rowValues.push(phone);
    else if (col === "pin") rowValues.push(pin);
    else if (col === "secretWord") rowValues.push(existingSecretWord);
    else if (col === "secretHint") rowValues.push(existingSecretHint);
    else if (col === "fullName") rowValues.push(profile.fullName || "");
    else if (col === "position") rowValues.push(profile.position || "");
    else if (col === "organization") rowValues.push(profile.organization || "");
    else if (col === "normSummer") rowValues.push(profile.normSummer || "");
    else if (col === "normWinter") rowValues.push(profile.normWinter || "");
    else if (col === "carBrand") rowValues.push(profile.carBrand || "");
    else if (col === "carPlate") rowValues.push(profile.carPlate || "");
    else if (col === "driverLicense") rowValues.push(profile.driverLicense || "");
    else if (col === "fuelType") rowValues.push(profile.fuelType || "");
    else if (col === "startPoint") rowValues.push(profile.startPoint || "");
    else if (col === "updatedAt") rowValues.push(now);
    else if (col === "role") rowValues.push(existingRole);
    else if (col === "chatAllowed") rowValues.push(existingChatAllowed);
    else rowValues.push("");
  }

  if (foundRowIndex > 0) {
    sheet.getRange(foundRowIndex, 1, 1, headers.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }

  return { ok: true, status: "saved" };
}

function handleSaveMonth(payload) {
  var phone = normalizePhone(payload.userId || payload.phone);
  var pin = normalizePin(payload.pin);
  var yearMonth = String(payload.yearMonth || "").trim();
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
    if (normalizePhone(list[i].userId) === phone && String(list[i].yearMonth).trim() === yearMonth) {
      foundRowIndex = list[i]._rowIndex;
      break;
    }
  }

  var headers = SHEET_SCHEMAS["Месяцы"];
  var rowValues = [];
  for (var h = 0; h < headers.length; h++) {
    var col = headers[h];
    if (col === "userId") rowValues.push(phone);
    else if (col === "yearMonth") rowValues.push(yearMonth);
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

  // Добавляем обновлённый список
  for (var a = 0; a < addresses.length; a++) {
    var addrItem = addresses[a];
    if (addrItem && addrItem.address) {
      sheet.appendRow([phone, String(addrItem.address).trim(), String(addrItem.note || "").trim(), now]);
    }
  }

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
    return { ok: true, status: "saved" };
  }

  if (payload.entries && typeof payload.entries === "object") {
    var entries = payload.entries;
    for (var k in entries) {
      var parts = k.split("|||");
      if (parts.length === 2) {
        sheet.appendRow([parts[0], parts[1], Number(entries[k]) || 0, now]);
      }
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
      return { ok: true, status: "ok", payload: parsed };
    }
  }

  return { ok: true, status: "not_found", payload: null };
}

/* =========================================================================
   ОБРАБОТЧИКИ АДМИН-МЕНЮ (ПРОВЕРКА ПРАВ АДМИНИСТРАТОРА ОБЯЗАТЕЛЬНА)
   ========================================================================= */

function handleAdminUsersList(payload) {
  var check = verifyAdminAccess(payload);
  if (!check.ok) return check;

  var sheet = getOrCreateSheet("Профили");
  var list = sheetToObjects(sheet);
  var users = list.map(function(r) {
    var p = normalizePhone(r.userId);
    return {
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
      role: isRowAdmin(r, p) ? "admin" : "user",
      isAdmin: isRowAdmin(r, p),
      chatAllowed: isRowChatAllowed(r, p)
    };
  });

  return { ok: true, users: users };
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
        yearMonth: monthsList[m].yearMonth || "",
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
      if (updates.chatAllowed !== undefined) {
        rowValues.push(parseBoolFlag(updates.chatAllowed) ? "true" : "false");
      } else {
        rowValues.push(isRowChatAllowed(foundRow, targetPhone) ? "true" : "false");
      }
    } else if (updates[col] !== undefined) {
      rowValues.push(String(updates[col]));
    } else {
      rowValues.push(foundRow[col] !== undefined ? foundRow[col] : "");
    }
  }

  sheet.getRange(foundRow._rowIndex, 1, 1, headers.length).setValues([rowValues]);
  return { ok: true, updated: true, targetPhone: nextPhone };
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
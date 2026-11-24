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

const SHEET_SCHEMAS = {
  "Профили": [
    "userId", "pin", "secretWord", "secretHint", "fullName", "position",
    "organization", "normSummer", "normWinter", "carBrand", "carPlate",
    "driverLicense", "fuelType", "startPoint", "updatedAt"
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
  }
  return sheet;
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
    var action = data.action;
    var payload = data.payload || data;

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
      case "contactsList":
        result = handleContactsList(payload);
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
    return { ok: false, error: "Пользователь с таким телефоном не найден. Воспользуйтесь первичной настройкой." };
  }
  if (!auth.ok) {
    return { ok: false, error: "Неверный ПИН-код." };
  }

  return {
    ok: true,
    userId: auth.row.userId,
    fullName: auth.row.fullName || "",
    position: auth.row.position || "",
    phone: phone
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

  for (var i = 0; i < list.length; i++) {
    if (normalizePhone(list[i].userId) === phone) {
      foundRowIndex = list[i]._rowIndex;
      break;
    }
  }

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
    else rowValues.push("");
  }

  if (foundRowIndex > 0) {
    sheet.getRange(foundRowIndex, 1, 1, headers.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }

  return { ok: true, phone: phone, fullName: fullName };
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

  return { ok: true, messages: formatted };
}

function handleChatSend(payload) {
  var text = String(payload.message || "").trim();
  if (!text) {
    return { ok: false, error: "Пустое сообщение." };
  }

  var sheet = getOrCreateSheet("Чат_Эксперт");
  var id = "msg-" + Date.now();
  var date = payload.date || "";
  var time = payload.time || "";
  var userName = payload.userName || "Сотрудник";
  var userPhone = normalizePhone(payload.phone || payload.userPhone);
  var createdAt = new Date().toISOString();

  sheet.appendRow([id, date, time, userName, userPhone, text, createdAt]);
  return { ok: true, id: id };
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

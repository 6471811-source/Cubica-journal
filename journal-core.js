/* ============================================================
   CUBICA · Ядро журнала (Универсальный адаптер v1.6 + справочник (номенклатура 1С))
   Подключается на: журнал, i5, калькуляторы
   ============================================================ */
(function (global) {
  'use strict';

  var K_RECORDS  = 'cubica_journal_v2';
  var K_SETTINGS = 'cubica_journal_settings_v1';
  var K_API_CACHE = 'cubica_journal_api_cache_v2';

  var DEFAULTS = {
    mode: 'local',
    apiBase: 'https://cubica-kp-15ab.6471811.workers.dev',
    apiToken: '',
    manager: '',
    vatRate: 0.20,
    currency: 'BYN',
    yearReset: true,
    urls: {
      journal: 'https://6471811-source.github.io/Cubica-journal/',
      calc:    'https://6471811-source.github.io/k6.3/',
      i5:      'https://6471811-source.github.io/Cubica-i5/',
      kp:      'https://6471811-source.github.io/cubica-kp/',
      nomenclature: 'https://6471811-source.github.io/Cubica-nomenclature/nomenclature.xml'
    },
    numberFormat: { invoice: 'СЧ-{YYYY}-{NNNN}', kp: 'КП-{YYYY}-{NNNN}' }
  };

  var COMPANY = { /* ... оставляем как было ... */ };

  var STATUSES = [
    { key: 'draft',    label: 'Черновик',       color: '#8a97a6' },
    { key: 'sent',     label: 'КП отправлено',  color: '#1565c0' },
    { key: 'invoiced', label: 'Счёт выставлен', color: '#b26a00' },
    { key: 'paid',     label: 'Оплачено',       color: '#2e7d32' },
    { key: 'canceled', label: 'Отменено',       color: '#c00000' }
  ];

  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d || 0); }
  function uid(prefix) {
    return (prefix || 'r') + '_' + Date.now().toString(36) + '_' +
           Math.random().toString(36).slice(2, 8);
  }
  function nowISO() { return new Date().toISOString(); }
  function pad(n, len) { var s = String(n); while (s.length < len) s = '0' + s; return s; }
  function statusInfo(key) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].key === key) return STATUSES[i];
    return STATUSES[0];
  }
  function money(v) {
    return (Number(v) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function loadSettings() {
    var s = clone(DEFAULTS);
    try {
      var raw = localStorage.getItem(K_SETTINGS);
      if (raw) {
        var parsed = JSON.parse(raw);
        for (var k in parsed) if (Object.prototype.hasOwnProperty.call(parsed, k)) {
          if (k === 'urls' || k === 'numberFormat') { for (var k2 in parsed[k]) s[k][k2] = parsed[k][k2]; }
          else s[k] = parsed[k];
        }
      }
    } catch (e) {}
    if (!s.manager) s.manager = 'Менеджер';
    return s;
  }
  function saveSettings(patch) {
    var s = loadSettings();
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) {
      if (k === 'urls' || k === 'numberFormat') { for (var k2 in patch[k]) s[k][k2] = patch[k][k2]; }
      else s[k] = patch[k];
    }
    try { localStorage.setItem(K_SETTINGS, JSON.stringify(s)); } catch (e) {}
    return s;
  }

  function isApi() { return loadSettings().mode === 'api'; }

  function loadRecords() {
    var key = isApi() ? K_API_CACHE : K_RECORDS;
    try {
      var raw = localStorage.getItem(key);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function writeRecords(list) {
    var key = isApi() ? K_API_CACHE : K_RECORDS;
    try {
      localStorage.setItem(key, JSON.stringify(list));
      emit('records-changed', { count: list.length });
      return true;
    } catch (e) {
      console.error('[CubicaJournal] не удалось записать журнал:', e);
      return false;
    }
  }

  function apiFetch(path, opts) {
    var s = loadSettings();
    opts = opts || {};
    var headers = {};
    if (opts.body) headers['Content-Type'] = 'application/json';
    if (s.apiToken) headers['Authorization'] = 'Bearer ' + s.apiToken;
    var url = String(s.apiBase || '').replace(/\/+$/, '') + path;
    if (!s.apiBase) return Promise.reject(new Error('не задан адрес сервиса в настройках'));
    return fetch(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var msg = 'HTTP ' + res.status;
          try {
            var j = JSON.parse(t);
            if (j && j.error) msg += ' — ' + j.error;
            else if (t) msg += ' — ' + t.slice(0, 160);
          } catch (e) { if (t) msg += ' — ' + t.slice(0, 160); }
          if (res.status === 401) msg = 'неверный токен доступа (401)';
          var err = new Error(msg); err.status = res.status; throw err;
        });
      }
      if (res.status === 204) return null;
      return res.json();
    });
  }

  function sync() {
    if (!isApi()) return Promise.resolve(loadRecords());
    return apiFetch('/records').then(function (data) {
      var records = (data && data.records) || [];
      try { localStorage.setItem(K_API_CACHE, JSON.stringify(records)); } catch (e) {}
      emit('records-changed', { synced: true, count: records.length });
      return records;
    });
  }

  function pushRecord(rec, opts) {
    opts = opts || {};
    if (!isApi()) return Promise.resolve(null);
    return apiFetch('/records/' + encodeURIComponent(rec.id), {
      method: 'PUT',
      body: JSON.stringify(rec)
    }).catch(function (e) {
      if (e.status === 409 && !opts.retried) {
        emit('number-conflict', { id: rec.id, number: rec.number, error: e });
        return reserveNumber(rec.series).then(function (fresh) {
          rec.number = fresh;
          rec.updatedAt = nowISO();
          rec.history = rec.history || [];
          rec.history.push({ at: nowISO(), by: loadSettings().manager, action: 'number reassigned to ' + fresh });
          var list = loadRecords();
          for (var i = 0; i < list.length; i++) if (list[i].id === rec.id) { list[i] = rec; break; }
          writeRecords(list);
          emit('number-reassigned', { id: rec.id, number: fresh });
          return pushRecord(rec, { retried: true });
        });
      }
      emit('sync-error', { id: rec.id, error: e });
      throw e;
    });
  }
  function pushDelete(id) {
    if (!isApi()) return Promise.resolve(null);
    return apiFetch('/records/' + encodeURIComponent(id), { method: 'DELETE' })
      .catch(function (e) { emit('sync-error', { id: id, error: e }); throw e; });
  }

  function reserveNumber(series) {
    series = series === 'kp' ? 'kp' : 'invoice';
    if (!isApi()) return Promise.resolve(nextNumber(series));
    return apiFetch('/number', {
      method: 'POST',
      body: JSON.stringify({ series: series, year: new Date().getFullYear() })
    }).then(function (r) {
      var year = num(r && r.year, new Date().getFullYear());
      var seq = num(r && r.seq, 1);
      return formatNumber(series, seq, year);
    });
  }
  function createReserved(series, opts) {
    return reserveNumber(series).then(function (number) {
      var rec = emptyRecord({ series: series, manager: opts && opts.manager, number: null });
      rec.number = number;
      return save(rec, { assignNumber: false });
    });
  }

  var listeners = {};
  function on(name, fn) {
    (listeners[name] = listeners[name] || []).push(fn);
    return function off() {
      listeners[name] = listeners[name].filter(function (f) { return f !== fn; });
    };
  }
  function emit(name, data) {
    (listeners[name] || []).forEach(function (fn) {
      try { fn(data); } catch (e) { console.error(e); }
    });
  }

  function parseSeq(number) {
    var m = String(number || '').match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : 0;
  }
  function parseYear(number) {
    var m = String(number || '').match(/(20\d{2})/);
    return m ? parseInt(m[1], 10) : null;
  }
  function formatNumber(series, seq, year) {
    var s = loadSettings();
    var tpl = (s.numberFormat && s.numberFormat[series]) || DEFAULTS.numberFormat[series] || '{NNNN}';
    return tpl
      .replace('{YYYY}', String(year))
      .replace('{YY}', String(year).slice(2))
      .replace('{NNNN}', pad(seq, 4))
      .replace('{NNN}', pad(seq, 3))
      .replace('{NN}', pad(seq, 2));
  }
  function nextNumber(series, opts) {
    opts = opts || {};
    var s = loadSettings();
    var year = new Date().getFullYear();
    var list = loadRecords();
    var max = 0;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (series && r.series !== series) continue;
      if (s.yearReset && parseYear(r.number) !== null && parseYear(r.number) !== year) continue;
      var q = parseSeq(r.number);
      if (q > max) max = q;
    }
    if (typeof opts.reservedMax === 'number' && opts.reservedMax > max) max = opts.reservedMax;
    return formatNumber(series, max + 1, year);
  }

  function emptyRecord(opts) {
    opts = opts || {};
    var s = loadSettings();
    var series = opts.series === 'kp' ? 'kp' : 'invoice';
    var rec = {
      id: uid(series === 'kp' ? 'kp' : 'inv'),
      series: series,
      type: 'cubica', // По умолчанию
      number: '',
      status: 'draft',
      createdAt: nowISO(),
      updatedAt: nowISO(),
      createdBy: opts.manager || s.manager,
      contractor: {
        name: '', full: '', unp: '', addr: '', account: '', bank: '',
        bic: '', position: '', fio: '', basis: '', phone: '', email: ''
      },
      deal: {
        delivery: 'pickup', payment: 100, days: 3,
        deliveryData: { address: '', phone: '', time: '', date: '', weight: 0, volume: 0, maxLen: 0 }
      },
      rows: [],
      totals: { subtotal: 0, vat: 0, total: 0, currency: s.currency },
      comment: '',
      comments: [],
      rooms: [],
      meta: null,
      client: { token: '', url: '', sentAt: '', openedAt: '' },
      history: [{ at: nowISO(), by: opts.manager || s.manager, action: 'created' }]
    };
    if (opts.number !== null) rec.number = opts.number || nextNumber(series);
    return rec;
  }

  function get(id) {
    var list = loadRecords();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  var STORAGE_ERROR = 'Не удалось сохранить журнал: в браузере закончилось место';

  function save(rec, opts) {
    opts = opts || {};
    if (!rec || !rec.id) return null;
    var list = loadRecords();
    rec.updatedAt = nowISO();
    if (!rec.totals) rec.totals = computeTotals(rec.rows, loadSettings().vatRate);
    if (!rec.number && opts.assignNumber !== false) rec.number = nextNumber(rec.series);
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === rec.id) { idx = i; break; }
    if (idx >= 0) list[idx] = rec; else list.push(rec);
    if (!writeRecords(list)) {
      emit('storage-error', { id: rec.id, message: STORAGE_ERROR });
      return null;
    }
    emit('record-saved', rec);
    if (isApi() && !opts.localOnly) pushRecord(rec).catch(function () {});
    return rec;
  }

  function remove(id) {
    var list = loadRecords();
    var out = list.filter(function (r) { return r.id !== id; });
    if (!writeRecords(out)) {
      emit('storage-error', { id: id, message: STORAGE_ERROR });
      return false;
    }
    emit('record-removed', { id: id });
    if (isApi()) pushDelete(id).catch(function () {});
    return out.length !== list.length;
  }

  function duplicate(id, opts) {
    opts = opts || {};
    var src = get(id);
    if (!src) return null;
    var copy = clone(src);
    copy.id = uid(src.series === 'kp' ? 'kp' : 'inv');
    copy.number = opts.number || nextNumber(src.series);
    copy.status = 'draft';
    copy.createdAt = nowISO();
    copy.updatedAt = nowISO();
    copy.createdBy = opts.manager || loadSettings().manager;
    copy.client = { token: '', url: '', sentAt: '', openedAt: '' };
    copy.history = [{ at: nowISO(), by: copy.createdBy, action: 'duplicated from ' + src.number }];
    if (!opts.keepComment) { copy.comment = ''; copy.comments = []; }
    delete copy.demo;
    save(copy, { assignNumber: false });
    return copy;
  }
  function duplicateReserved(id, opts) {
    opts = opts || {};
    var src = get(id);
    if (!src) return Promise.reject(new Error('запись не найдена'));
    return reserveNumber(src.series).then(function (number) {
      return duplicate(id, Object.assign({}, opts, { number: number }));
    });
  }

  function rowQty(r) { return num(r.qtyCalc) + num(r.qtyReserve); }
  // Округление количества как в i5: тыс.шт — до тысячных, шт — до целого, остальное — до сотых
  function qtyRound(v, unit) {
    var n = +num(v, 0).toFixed(6), u = String(unit || '').trim().toLowerCase();
    if (/^шт/.test(u)) return Math.ceil(n);
    var k = /^тыс/.test(u) ? 1000 : 100;
    return Math.round(n * k) / k;
  }
  function rowSum(r) { return rowQty(r) * num(r.price); }
  function computeTotals(rows, vatRate) {
    var rate = typeof vatRate === 'number' ? vatRate : loadSettings().vatRate;
    var sub = 0;
    (rows || []).forEach(function (r) { sub += rowSum(r); });
    var vat = sub * rate;
    return {
      subtotal: Math.round(sub * 100) / 100,
      vat: Math.round(vat * 100) / 100,
      total: Math.round((sub + vat) * 100) / 100,
      currency: loadSettings().currency
    };
  }

  // Спец-функция для Куботы (пересчет в м.п.)
  function rowsFromRoomsCubica(rooms) {
    var map = {}, order = [];
    (rooms || []).forEach(function (room) {
      (room.rows || []).forEach(function (r) {
        var label = String(r.label || '');
        var unit = r.unit || 'шт.';
        var qty = num(r.qty);
        if (/^Рейка Cubica /.test(label)) {
          var m = label.match(/(\d+)\s*мм/i);
          if (m && unit !== 'м.п.') qty = (parseInt(m[1], 10) / 1000) * qty;
          unit = 'м.п.';
          label = label.replace(/\s*\(объединено\)\s*$/i, '').replace(/\s+\d+\s*мм\s*$/i, '').trim();
        }
        var key = label + '|' + unit;
        if (map[key]) { map[key].qtyCalc += qty; }
        else { map[key] = { label: label, qtyCalc: qty, qtyReserve: 0, unit: unit, price: 0 }; order.push(key); }
      });
    });
    return order.map(function (k) {
      var r = map[k];
      r.qtyCalc = Math.round(r.qtyCalc * 100) / 100;
      return r;
    });
  }

  function fromCalcPayload(payload, opts) {
    opts = opts || {};
    var rec = emptyRecord({ series: 'invoice', manager: opts.manager });
    rec.type = payload.type || 'cubica';
    rec.rooms = clone(payload.rooms || []);
    rec.meta = clone(payload.meta || null);
    if (payload.company) rec.company = clone(payload.company);
    
    if (rec.type === 'cubica') {
      rec.rows = rowsFromRoomsCubica(rec.rooms);
    } else {
      rec.rows = (payload.rows || []).map(function (r) {
        return { label: String(r.label || ''), qtyCalc: num(r.qty), qtyReserve: 0, unit: r.unit || 'шт.', price: 0 };
      });
    }
    rec.totals = computeTotals(rec.rows);
    rec.history.push({ at: nowISO(), by: rec.createdBy, action: 'from calculator (' + rec.type + ')' });
    return save(rec, { assignNumber: false });
  }

  // УНИВЕРСАЛЬНЫЙ ПЕРЕДАТЧИК В I5
  function buildClientPayload(rec) {
    var s = loadSettings();
    var totals = rec.totals && rec.totals.total ? rec.totals : computeTotals(rec.rows, s.vatRate);
    
    var rooms = (rec.rooms || []).map(function (room) {
      var roomObj = Object.assign({}, room);
      if (!roomObj.rows) roomObj.rows = [];
      return roomObj;
    });

    var meta = rec.meta || {};
    var first = rooms[0] || {};
    var valid = new Date(); valid.setDate(valid.getDate() + 10);

    // Берем строки из rec.rows. Если их нет, пробуем собрать из rooms.
    var finalRows = (rec.rows || []).map(function (r) {
      return { 
        label: r.label, 
        qty: qtyRound(rowQty(r), r.unit), 
        unit: r.unit || 'шт.', 
        price: num(r.price),
        role: r.role || undefined
      };
    });

    if (!finalRows.length && rooms.length) {
      finalRows = rowsFromRoomsCubica(rooms).map(function(r) {
        return { label: r.label, qty: r.qtyCalc, unit: r.unit, price: r.price };
      });
    }

    return {
      v: 6, 
      type: rec.type || 'cubica', // <--- ПЕРЕДАЕМ ТИП В I5
      brand: (rec.brand === 'armstrong' || rec.brand === 'cubica') ? rec.brand : undefined, // логотип КП/счёта (выбор в i5)
      rooms: rooms, 
      i5_url: s.urls.i5,
      paid: rec.status === 'paid',
      paidAt: rec.status === 'paid' ? rec.updatedAt : null,
      L_in: num(meta.L_in || first.L_in),
      W_in: num(meta.W_in || first.W_in),
      area: num(meta.area) || rooms.reduce(function (a, r) { return a + num(r.areaM2); }, 0),
      color: meta.color || first.colorLabel || '',
      railSpec: (num(meta.railW, first.railW || 50)) + '×' + (num(meta.railH, first.railH || 30)),
      polygon: meta.polygon || first.polygon || null,
      p: {
        railW: num(meta.railW, first.railW || 50),
        railH: num(meta.railH, first.railH || 30),
        gap: num(meta.gap, first.gap || 15),
        caps: (meta.caps !== undefined ? meta.caps : first.caps) ? 1 : 0,
        angle: (meta.angle !== undefined ? meta.angle : first.angle) ? 1 : 0
      },
      r: num(meta.rotation || first.rotation),
      rows: finalRows,
      price: totals.total, subtotal: totals.subtotal, vat: totals.vat,
      currency: s.currency, invoiceNumber: rec.number,
      deal: clone(rec.deal), buyer: clone(rec.contractor),
      company: COMPANY, manager: rec.createdBy || s.manager,
      phone: COMPANY.phone,
      valid: pad(valid.getDate(), 2) + '.' + pad(valid.getMonth() + 1, 2) + '.' + valid.getFullYear()
    };
  }

  function b64enc(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64dec(str) {
    if (!str) return null;
    var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    try {
      var bin = atob(s);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) { return null; }
  }

  function withParam(url, key, value) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + key + '=' + encodeURIComponent(value);
  }
  function i5UrlForRecord(rec, opts) {
    opts = opts || {};
    var s = loadSettings();
    var url = withParam(s.urls.i5, 'jid', rec.id);
    if (opts.autopdf) url = withParam(url, 'autopdf', '1');
    if (opts.blank) url = withParam(url, 'blank', '1');
    return url;
  }
  function calcUrlForRecord(rec) {
    var s = loadSettings();
    // Если запись из Армстронга, ведем в его калькулятор
    if (rec && rec.type === 'grilyato') {
      var grUrl = (s.urls && s.urls.grilyato) || 'https://6471811-source.github.io/Cubica-grilyato/';
      return withParam(grUrl, 'jid', rec.id);
    }
    if (rec && rec.type === 'armstrong') {
      // Берем базовый URL из настроек (по умолчанию это URL Кубота)
      // Но подменяем его на URL Армстронга
      var armstrongUrl = 'https://6471811-source.github.io/Cubica-armstrong/';
      return rec ? withParam(armstrongUrl, 'jid', rec.id) : armstrongUrl;
    }
    // Иначе ведем в Кубота
    return rec ? withParam(s.urls.calc, 'jid', rec.id) : s.urls.calc;
  }
  function kpUrlForToken(token) {
    var s = loadSettings();
    return withParam(s.urls.kp, 's', token);
  }

  function sendKpToClient(rec) {
    var s = loadSettings();
    var payload = buildClientPayload(rec);
    var data = b64enc(JSON.stringify(payload));

    if (rec.client && rec.client.token) {
      return fetch(s.apiBase + '/update/' + encodeURIComponent(rec.client.token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: data })
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function () {
        rec.client.sentAt = nowISO();
        if (rec.status === 'draft') rec.status = 'sent';
        rec.history = rec.history || [];
        rec.history.push({ at: nowISO(), by: loadSettings().manager, action: 'client link updated' });
        save(rec, { assignNumber: false });
        return rec.client.url;
      });
    }

    return fetch(s.apiBase + '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: data, recordId: rec.id })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (j) {
      if (!j || !j.id) throw new Error('Сервис не вернул id');
      rec.client = rec.client || {};
      rec.client.token = j.id;
      rec.client.url = kpUrlForToken(j.id);
      rec.client.sentAt = nowISO();
      if (rec.status === 'draft') rec.status = 'sent';
      rec.history = rec.history || [];
      rec.history.push({ at: nowISO(), by: loadSettings().manager, action: 'client link created' });
      save(rec, { assignNumber: false });
      return rec.client.url;
    });
  }
  function fetchOpens(recordId) {
    if (!recordId || !loadSettings().apiBase) return Promise.resolve(null);
    return apiFetch('/records/' + encodeURIComponent(recordId) + '/opens')
      .catch(function () { return null; });
  }

  function addComment(rec, text) {
    if (!text) return rec;
    rec.comments = rec.comments || [];
    rec.comments.push({ at: nowISO(), by: loadSettings().manager, text: String(text) });
    return save(rec, { assignNumber: false });
  }
  function addHistory(rec, action) {
    rec.history = rec.history || [];
    rec.history.push({ at: nowISO(), by: loadSettings().manager, action: action });
    return rec;
  }

  function exportJSON() {
    var s = loadSettings();
    delete s.apiToken;
    return { version: 2, exported: nowISO(), settings: s, records: loadRecords(), catalog: catalogAll() };
  }
  function importJSON(data, opts) {
    opts = opts || {};
    var incoming = Array.isArray(data) ? data : (data && data.records);
    if (!Array.isArray(incoming)) throw new Error('Неверный формат файла');
    if (data && Array.isArray(data.catalog) && data.catalog.length) { catalogSave(data.catalog).catch(function () {}); }
    var before = loadRecords();
    var list = opts.replace ? [] : before.slice();
    var added = 0, updated = 0;
    var touched = [];
    incoming.forEach(function (rec) {
      if (!rec || !rec.id) return;
      var idx = -1;
      for (var i = 0; i < list.length; i++) if (list[i].id === rec.id) { idx = i; break; }
      if (idx >= 0) { list[idx] = rec; updated++; } else { list.push(rec); added++; }
      touched.push(rec);
    });
    if (!writeRecords(list)) {
      emit('storage-error', { message: STORAGE_ERROR });
      throw new Error(STORAGE_ERROR);
    }
    var removed = 0;
    if (isApi()) {
      if (opts.replace) {
        var keep = {};
        list.forEach(function (r) { keep[r.id] = true; });
        before.forEach(function (r) {
          if (!keep[r.id]) { removed++; pushDelete(r.id).catch(function () {}); }
        });
      }
      touched.forEach(function (rec) { pushRecord(rec).catch(function () {}); });
    }
    return { added: added, updated: updated, removed: removed, pushed: isApi() ? touched.length : 0 };
  }

  function summary() {
    var list = loadRecords();
    var out = { total: 0, sum: 0, sumPaid: 0, sumMonth: 0, byStatus: {} };
    STATUSES.forEach(function (s) { out.byStatus[s.key] = 0; });
    var now = new Date();
    list.forEach(function (r) {
      out.total++;
      var t = r.totals && r.totals.total ? num(r.totals.total) : num(computeTotals(r.rows).total);
      out.sum += t;
      if (r.status === 'paid') out.sumPaid += t;
      var d = r.createdAt ? new Date(r.createdAt) : null;
      if (d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) out.sumMonth += t;
      if (out.byStatus[r.status] === undefined) out.byStatus[r.status] = 0;
      out.byStatus[r.status]++;
    });
    return out;
  }

  /* ============================================================
     СПРАВОЧНИК v2 = номенклатура 1С + наши настройки
     Слой 1 (номенклатура): XML-выгрузка 1С, тот же файл и тот же кэш, что в i5.
     Слой 2 (настройки):    по коду 1С — пачка, кратность, м² в шт., рек. цена (запас % — в i5).
                            Локально 'cubica_catalog_v2', на сервере GET/PUT /catalog.
     Настройки папки действуют на всё внутри, пока у позиции не задано своё.
     ============================================================ */
  var K_CATALOG = 'cubica_catalog_v2';
  var K_NOM_CACHE = 'cubica_nomenclature_v2';
  var NOM_URL_DEFAULT = 'https://6471811-source.github.io/Cubica-nomenclature/nomenclature.xml';
  var CAT_FIELDS = ['packMultiple', 'packQty', 'packUnit', 'm2PerPiece', 'pcsPerUnit', 'price', 'note']; // запас % задаётся в i5, не в справочнике
  var NOM = null, NOM_INDEX = null, nomLoading = null;

  function nomUrl() { var s = loadSettings(); return (s.urls && s.urls.nomenclature) || NOM_URL_DEFAULT; }

  function parseNomenclatureXML(xmlText) {
    var doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    var err = doc.querySelector('parsererror');
    if (err) throw new Error('XML: ' + err.textContent.slice(0, 200));
    var elements = doc.getElementsByTagName('Элемент');
    var map = {}, parentOf = {}, order = [];
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var id = el.getAttribute('Код');
      var name = (el.getAttribute('Наименование') || '').replace(/\s+/g, ' ').trim();
      if (!id || !name) continue;
      var isFolder = el.getAttribute('ЭтоГруппа') === 'Да';
      var node = { id: id, name: name, type: isFolder ? 'folder' : 'item' };
      if (!isFolder) {
        var unit = (el.getAttribute('Единица') || '').trim(); if (unit) node.unit = unit;
        var art = (el.getAttribute('Артикул') || '').trim(); if (art) node.article = art;
        var full = (el.getAttribute('ПолноеНаименование') || '').trim(); if (full) node.fullName = full;
        var w = parseFloat(String(el.getAttribute('ВесБрутто') || '').replace(',', '.')); if (isFinite(w) && w > 0) node.weight = w;
      } else node.children = [];
      map[id] = node; parentOf[id] = el.getAttribute('РодительКод') || null; order.push(id);
    }
    var roots = [];
    order.forEach(function (id) {
      var p = parentOf[id], node = map[id];
      if (p && map[p] && map[p].children) map[p].children.push(node); else roots.push(node);
    });
    var coll = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
    (function sortTree(nodes) {
      nodes.sort(function (a, b) { return a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : coll.compare(a.name, b.name); });
      nodes.forEach(function (n) { if (n.children) sortTree(n.children); });
    })(roots);
    return { version: '2.0', source: '1C XML', generated: nowISO(), tree: roots };
  }

  function buildNomIndex(data) {
    var byId = {}, parent = {}, items = [], folders = [];
    (function walk(nodes, pid) {
      nodes.forEach(function (n) {
        byId[n.id] = n; parent[n.id] = pid;
        if (n.type === 'folder' || (n.children && n.children.length)) { folders.push(n); walk(n.children || [], n.id); }
        else items.push(n);
      });
    })((data && data.tree) || [], null);
    return { byId: byId, parent: parent, items: items, folders: folders };
  }
  function setNom(data) { NOM = data; NOM_INDEX = buildNomIndex(data); emit('nomenclature-changed', { count: NOM_INDEX.items.length }); return NOM; }

  function nomFetch() {
    return fetch(nomUrl(), { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (text) {
      var data = /^\s*</.test(text.replace(/^\uFEFF/, '')) ? parseNomenclatureXML(text.replace(/^\uFEFF/, '')) : JSON.parse(text);
      if (!data || !Array.isArray(data.tree) || !data.tree.length) throw new Error('Выгрузка пустая');
      data.loadedAt = nowISO();
      try { localStorage.setItem(K_NOM_CACHE, JSON.stringify(data)); } catch (e) {}
      return setNom(data);
    });
  }
  // Номенклатура: сначала из кэша (мгновенно), затем обновление из файла в фоне
  function nomLoad(force) {
    if (NOM && !force) return Promise.resolve(NOM);
    if (!force) {
      try {
        var raw = localStorage.getItem(K_NOM_CACHE);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.tree) && parsed.tree.length) {
            setNom(parsed);
            if (!nomLoading) nomLoading = nomFetch().catch(function () {}).then(function (r) { nomLoading = null; return r; });
            return Promise.resolve(NOM);
          }
        }
      } catch (e) {}
    }
    if (nomLoading && !force) return nomLoading;
    nomLoading = nomFetch().then(function (r) { nomLoading = null; return r; }, function (e) { nomLoading = null; throw e; });
    return nomLoading;
  }
  function nomLoadText(text) { // загрузка XML-файла вручную (без GitHub) — только в этом браузере
    var data = parseNomenclatureXML(String(text).replace(/^\uFEFF/, ''));
    data.loadedAt = nowISO(); data.source = '1C XML (файл)';
    try { localStorage.setItem(K_NOM_CACHE, JSON.stringify(data)); } catch (e) {}
    return setNom(data);
  }
  function nomIndex() { return NOM_INDEX; }
  function nomPath(code) {
    var out = []; if (!NOM_INDEX) return out;
    var p = NOM_INDEX.parent[code];
    while (p) { out.unshift(NOM_INDEX.byId[p]); p = NOM_INDEX.parent[p]; }
    return out;
  }

  // ---- Слой настроек ----
  function isRoleCode(c) { return String(c || '').indexOf('role:') === 0; }
  function cleanRole(x) {
    var o = { code: String(x.code), nomCode: String(x.nomCode || '') };
    if (!o.nomCode) return null;
    if (x.name) o.name = String(x.name);
    if (x.unit) o.unit = String(x.unit);
    if (num(x.m2PerPiece, 0) > 0) o.m2PerPiece = num(x.m2PerPiece, 0);
    if (num(x.pcsPerUnit, 0) > 0) o.pcsPerUnit = num(x.pcsPerUnit, 0);
    return o;
  }
  function cleanSetting(x) {
    x = x || {};
    if (isRoleCode(x.code)) return cleanRole(x);
    var o = { code: String(x.code || '') };
    if (!o.code) return null;
    if (x.folder) o.folder = true;
    if (x.packMultiple === true || x.packMultiple === false) o.packMultiple = x.packMultiple;
    if (x.packQty !== undefined && x.packQty !== null && x.packQty !== '' && num(x.packQty, 0) > 0) o.packQty = num(x.packQty, 0);
    if (x.packUnit === 'шт' || x.packUnit === 'unit') o.packUnit = x.packUnit;
    if (x.m2PerPiece !== undefined && x.m2PerPiece !== null && x.m2PerPiece !== '' && num(x.m2PerPiece, 0) > 0) o.m2PerPiece = num(x.m2PerPiece, 0);
    if (x.pcsPerUnit !== undefined && x.pcsPerUnit !== null && x.pcsPerUnit !== '' && num(x.pcsPerUnit, 0) > 0) o.pcsPerUnit = num(x.pcsPerUnit, 0);
    if (x.price !== undefined && x.price !== null && x.price !== '' && num(x.price, 0) > 0) o.price = num(x.price, 0);
    if (x.note) o.note = String(x.note);
    return o;
  }
  function settingIsEmpty(o) { if (o && isRoleCode(o.code)) return !o.nomCode; return !o || CAT_FIELDS.every(function (f) { return o[f] === undefined; }); }
  function catalogMeta() {
    try { var raw = localStorage.getItem(K_CATALOG); if (raw) return JSON.parse(raw); } catch (e) {}
    return null;
  }
  function catalogRaw() { // все записи: настройки позиций + привязки ролей
    var m = catalogMeta();
    return (m && Array.isArray(m.items) ? m.items : []).map(cleanSetting).filter(function (o) { return o && !settingIsEmpty(o); });
  }
  function catalogAll() { // настройки позиций (без ролей)
    return catalogRaw().filter(function (o) { return !isRoleCode(o.code); });
  }
  function catalogMap() { var map = {}; catalogAll().forEach(function (o) { map[o.code] = o; }); return map; }
  function catalogWriteLocal(items, meta) {
    var data = { version: num(meta && meta.version, 0), updatedAt: (meta && meta.updatedAt) || nowISO(), items: items };
    try { localStorage.setItem(K_CATALOG, JSON.stringify(data)); } catch (e) { emit('storage-error', {}); return false; }
    emit('catalog-changed', { count: items.length });
    return true;
  }
  function catalogSave(items, roleItems) {
    items = (items || []).filter(function (o) { return o && !isRoleCode(o.code); });
    if (!roleItems) roleItems = catalogRaw().filter(function (o) { return isRoleCode(o.code); });
    items = items.concat(roleItems).map(cleanSetting).filter(function (o) { return o && !settingIsEmpty(o); });
    var prev = catalogMeta() || {};
    catalogWriteLocal(items, { version: prev.version, updatedAt: nowISO() });
    if (!isApi()) return Promise.resolve({ ok: true, local: true, count: items.length });
    return apiFetch('/catalog', { method: 'PUT', body: JSON.stringify({ schema: 2, items: items }) }).then(function (r) {
      catalogWriteLocal(items, { version: r && r.version, updatedAt: r && r.updatedAt });
      return r;
    }).catch(function (e) { emit('sync-error', { catalog: true, error: e }); throw e; });
  }
  function catalogSync() {
    if (!isApi()) return Promise.resolve(catalogAll());
    return apiFetch('/catalog').then(function (data) {
      // настройки v2 — только записи с кодом 1С (старый ручной список v1 игнорируем)
      var items = (data && Array.isArray(data.items) ? data.items : []).filter(function (x) { return x && x.code; });
      if (!items.length) {
        var local = catalogRaw();
        if (local.length) return catalogSave(catalogAll()).then(function () { return catalogAll(); });
        catalogWriteLocal([], data);
        return [];
      }
      items = items.map(cleanSetting).filter(Boolean);
      catalogWriteLocal(items, data);
      return items;
    });
  }

  function sizeM2(text) {
    var m = String(text || '').match(/(\d{3,4})\s*[xх×*]\s*(\d{3,4})/i);
    if (!m) return 0;
    // плиты 595×595 / 1195×595 продаются как ячейка 600×600 / 1200×600
    var snap = function (v) { v = Number(v); var r = Math.round(v / 600) * 600; return (r > 0 && Math.abs(v - r) <= 10) ? r : v; };
    return +((snap(m[1]) * snap(m[2])) / 1e6).toFixed(4);
  }
  // Сколько штук в одной единице 1С: «тыс.шт» → 1000, «сот.шт» → 100,
  // «упак/пач/кор/компл» → число штук из названия «(100шт/ упак)». Для «шт» — 1.
  function autoPcsPerUnit(unit, name) {
    var u = String(unit || '').toLowerCase().replace(/\s+/g, '');
    if (!u) return 0;
    if (/^шт/.test(u)) return 1;
    if (/^тыс/.test(u)) return 1000;
    if (/^сот/.test(u)) return 100;
    if (/^(упак|уп\.?$|уп$|пач|кор|компл|наб|блок|рул)/.test(u)) {
      var m = String(name || '').match(/(\d+)\s*шт\.?\s*(?:\/|в)\s*(?:упак|уп|пач|кор|компл|наб)/i) || String(name || '').match(/[(]\s*(\d+)\s*шт/i);
      if (m && Number(m[1]) > 0) return Number(m[1]);
    }
    return 0;
  }
  // Итоговые настройки позиции: своё → папка → папка выше … → авто
  function catalogResolve(code, map) {
    map = map || catalogMap();
    var node = NOM_INDEX ? NOM_INDEX.byId[code] : null;
    var eff = {}, from = {};
    var chain = [code];
    if (NOM_INDEX) { var p = NOM_INDEX.parent[code]; while (p) { chain.push(p); p = NOM_INDEX.parent[p]; } }
    CAT_FIELDS.forEach(function (f) {
      for (var i = 0; i < chain.length; i++) {
        var o = map[chain[i]];
        if (o && o[f] !== undefined) { eff[f] = o[f]; from[f] = i === 0 ? 'own' : chain[i]; break; }
      }
    });
    if (eff.m2PerPiece === undefined && node) {
      var auto = sizeM2(node.name);
      if (auto) { eff.m2PerPiece = auto; from.m2PerPiece = 'auto'; }
    }
    if (eff.pcsPerUnit === undefined && node && node.type !== 'folder') {
      var ap = autoPcsPerUnit(node.unit, node.name);
      if (ap > 1) { eff.pcsPerUnit = ap; from.pcsPerUnit = 'auto'; }
    }
    // пачка из названия: «(18 шт.)», «6,48 кв.м./пач», «(11,52 м2)»
    if (eff.packQty === undefined && node && node.type !== 'folder') {
      var nm = node.name, unitIsM2 = /м2|м²/i.test(node.unit || '');
      var mPcs = nm.match(/[(=]\s*(\d+)\s*шт/i);
      var mM2 = nm.match(/(\d+(?:[.,]\d+)?)\s*(?:м2|м²|кв\.?\s*м|м\.?\s*кв)/i);
      var sz = sizeM2(nm);
      if (mM2 && sz && Math.abs(parseFloat(mM2[1].replace(',', '.')) - sz) < 1e-6) mM2 = null; // это не пачка, а площадь плиты
      if (mM2 && unitIsM2) { eff.packQty = parseFloat(mM2[1].replace(',', '.')); if (eff.packUnit === undefined) { eff.packUnit = 'unit'; from.packUnit = 'auto'; } from.packQty = 'auto'; }
      else if (mPcs) { eff.packQty = Number(mPcs[1]); if (eff.packUnit === undefined) { eff.packUnit = 'шт'; from.packUnit = 'auto'; } from.packQty = 'auto'; }
      else if (mM2 && eff.m2PerPiece > 0) { eff.packQty = Math.round(parseFloat(mM2[1].replace(',', '.')) / eff.m2PerPiece); if (eff.packUnit === undefined) { eff.packUnit = 'шт'; from.packUnit = 'auto'; } from.packQty = 'auto'; }
    }
    if (eff.packUnit === undefined) eff.packUnit = 'unit';
    return {
      code: code, node: node, name: node ? node.name : '', unit: node ? (node.unit || '') : '',
      article: node ? (node.article || '') : '', isFolder: !!(node && node.type === 'folder'),
      packMultiple: eff.packMultiple === true, packQty: num(eff.packQty, 0), packUnit: eff.packUnit,
      m2PerPiece: num(eff.m2PerPiece, 0), pcsPerUnit: num(eff.pcsPerUnit, 0),
      price: num(eff.price, 0), note: eff.note || '', from: from, own: map[code] || null
    };
  }
  function catalogFind(idOrName) {
    if (!NOM_INDEX) return null;
    if (NOM_INDEX.byId[idOrName]) return catalogResolve(idOrName);
    var s = String(idOrName || '').trim().toLowerCase();
    if (!s) return null;
    for (var i = 0; i < NOM_INDEX.items.length; i++) if (NOM_INDEX.items[i].name.toLowerCase() === s) return catalogResolve(NOM_INDEX.items[i].id);
    return null;
  }
  // Округление до пачки. qty — количество в единице 1С этой позиции.
  function catalogPackRound(eff, qty) {
    qty = Math.max(0, num(qty, 0));
    var res = { qty: qty, packs: 0, ship: qty, added: 0, perPack: 0, rounded: false };
    if (!eff || !eff.packMultiple || !(eff.packQty > 0)) return res;
    var perPack = eff.packQty;
    if (eff.packUnit === 'шт' && eff.m2PerPiece > 0 && /м2|м²/i.test(eff.unit || '')) perPack = eff.packQty * eff.m2PerPiece; // пачка в штуках, позиция в м²
    else if (eff.packUnit === 'шт' && eff.pcsPerUnit > 1 && unitKind(eff.unit) !== 'pcs') perPack = eff.packQty / eff.pcsPerUnit; // пачка в штуках, позиция в тыс.шт / упак
    res.perPack = +perPack.toFixed(6);
    res.packs = Math.ceil(+(qty / perPack).toFixed(6));
    res.ship = +(res.packs * perPack).toFixed(4);
    res.added = +(res.ship - qty).toFixed(4);
    if (eff.packUnit === 'шт') res.packPcs = eff.packQty;
    res.rounded = res.added > 0;
    return res;
  }

  /* ============================================================
     РОЛИ КАЛЬКУЛЯТОРОВ: строка калькулятора → позиция 1С
     Калькулятор считает по роли (в своих единицах), а какая позиция 1С
     стоит за ролью — задаётся в журнале («Справочник → Роли Армстронга»).
     Хранится в том же списке справочника записями с кодом 'role:<ключ>'.
     ============================================================ */
  var ROLE_DEFS = {
    armstrong: { title: 'Армстронг', roles: [
      { key: 'arm.tile600',   label: 'Плита 600×600',              calcUnit: 'шт', m2: 0.36, def: 'Плита потолочная 600х600х12 мм' },
      { key: 'arm.tile1200',  label: 'Плита 1200×600',             calcUnit: 'шт', m2: 0.72, def: 'Плита потолочная 1200х600х12 мм' },
      { key: 'arm.main3600',  label: 'Т-профиль несущий 3600',      calcUnit: 'шт', lenM: 3.6, def: 'Т-профиль 24х33х3600 Премиум белый' },
      { key: 'arm.cross1200', label: 'Т-профиль поперечный 1200',   calcUnit: 'шт', lenM: 1.2, def: 'Т-профиль 24х26х1200 белый' },
      { key: 'arm.cross600',  label: 'Т-профиль поперечный 600',    calcUnit: 'шт', lenM: 0.6, def: 'Т-профиль 24х20х600 Стандарт белый' },
      { key: 'arm.angle',     label: 'Уголок пристенный 3 м',       calcUnit: 'шт', lenM: 3,   def: 'Уголок пристеночный 19х19 (3м) белый' },
      { key: 'arm.euro500',   label: 'Европодвес 500 мм',           calcUnit: 'шт', def: 'Европодвес 500 мм' },
      { key: 'arm.hook250',   label: 'Тяга-крюк 250 мм',            calcUnit: 'шт', def: 'Тяга-крюк 250 мм d 4,0' },
      { key: 'arm.hook350',   label: 'Тяга-крюк 350 мм',            calcUnit: 'шт', def: 'Тяга-крюк 350 мм d 4,0' },
      { key: 'arm.hook500',   label: 'Тяга-крюк 500 мм',            calcUnit: 'шт', def: 'Тяга-крюк 500 мм d 4,0' },
      { key: 'arm.hook1000',  label: 'Тяга-крюк 1000 мм',           calcUnit: 'шт', def: 'Тяга-крюк 1000 мм d 4,0' },
      { key: 'arm.loop350',   label: 'Тяга-петля 350 мм',           calcUnit: 'шт', def: 'Тяга-петля 350 мм d 4,0' },
      { key: 'arm.loop500',   label: 'Тяга-петля 500 мм',           calcUnit: 'шт', def: 'Тяга-петля 500 мм d 4,0' },
      { key: 'arm.loop1000',  label: 'Тяга-петля 1000 мм',          calcUnit: 'шт', def: 'Тяга-петля 1000 мм d 4,0' },
      { key: 'arm.spring',    label: 'Пружина европодвеса',         calcUnit: 'шт', def: 'Пружина европодвеса d 4,0' },
      { key: 'arm.anchor',    label: 'Анкер с полукольцом М8',      calcUnit: 'шт', def: 'Анкерный болт с полукольцом М8х40 (100 шт.)' },
      { key: 'arm.dowel',     label: 'Дюбель-гвоздь для уголка',    calcUnit: 'шт', def: 'Дюбель-гвоздь SM-G 6x40 (3600/200шт.)' }
    ] }
  };
  // ---- Грильято: роли собираются из системы × ячейки × цвета ----
  // GL15: мама, папа, L-планка (по ячейке и цвету) + Т-профили 15 мм 3600/1200/600 (по цвету).
  // Классический 27 / 40 мм: мама, папа (по ячейке и цвету) + направляющие 2400/1200/600 (по цвету) + соединитель.
  // Уголок — по цвету. Подвесы, анкеры и дюбели — общие с Армстронгом (роли arm.*).
  var GR_CELLS = [50, 75, 100, 120, 150, 200];
  var GR_COLORS = [
    { key: '9003', name: 'RAL 9003 белый' },
    { key: '7004', name: 'RAL 7004 серый' },
    { key: '9005', name: 'RAL 9005 чёрный' },
    { key: 'ral',  name: 'RAL под заказ' }
  ];
  var GR_HEIGHTS = [27, 40];
  function grPerGrid(cell) { cell = Number(cell) || 100; return Math.max(1, Math.round(600 / cell) - 1); } // мам (и пап) в решётке 600×600
  function buildGrilyatoRoles() {
    var out = [];
    GR_CELLS.forEach(function (c) {
      GR_COLORS.forEach(function (col) {
        var cs = c + '×' + c, cn = c + 'х' + c;
        out.push({ key: 'gr.gl.mama.' + c + '.' + col.key, grp: 'gl15', cell: c, color: col.key, calcUnit: 'шт', lenM: 0.6,
          label: 'GL15 · «мама» · ' + cs + ' · ' + col.name, def: 'Грильято GL15 «мама» 600 мм, ячейка ' + cn + ', ' + col.name });
        out.push({ key: 'gr.gl.papa.' + c + '.' + col.key, grp: 'gl15', cell: c, color: col.key, calcUnit: 'шт', lenM: 0.6,
          label: 'GL15 · «папа» · ' + cs + ' · ' + col.name, def: 'Грильято GL15 «папа» 600 мм, ячейка ' + cn + ', ' + col.name });
        out.push({ key: 'gr.gl.l.' + c + '.' + col.key, grp: 'gl15', cell: c, color: col.key, calcUnit: 'шт', lenM: 0.6,
          label: 'GL15 · L-планка · ' + cs + ' · ' + col.name, def: 'Грильято GL15 L-планка 600 мм, ячейка ' + cn + ', ' + col.name });
      });
    });
    GR_COLORS.forEach(function (col) {
      out.push({ key: 'gr.gl.main.' + col.key, grp: 'gl15', color: col.key, calcUnit: 'шт', lenM: 3.6,
        label: 'GL15 · Т-профиль несущий 3600 · ' + col.name, def: 'Т-профиль 15 мм несущий 3600 GL15, ' + col.name });
      out.push({ key: 'gr.gl.c1200.' + col.key, grp: 'gl15', color: col.key, calcUnit: 'шт', lenM: 1.2,
        label: 'GL15 · Т-профиль поперечный 1200 · ' + col.name, def: 'Т-профиль 15 мм поперечный 1200 GL15, ' + col.name });
      out.push({ key: 'gr.gl.c600.' + col.key, grp: 'gl15', color: col.key, calcUnit: 'шт', lenM: 0.6,
        label: 'GL15 · Т-профиль поперечный 600 · ' + col.name, def: 'Т-профиль 15 мм поперечный 600 GL15, ' + col.name });
    });
    GR_HEIGHTS.forEach(function (h) {
      var g = 'cl' + h;
      GR_CELLS.forEach(function (c) {
        GR_COLORS.forEach(function (col) {
          var cs = c + '×' + c, cn = c + 'х' + c;
          out.push({ key: 'gr.' + g + '.mama.' + c + '.' + col.key, grp: g, cell: c, color: col.key, calcUnit: 'шт', lenM: 0.6,
            label: 'Классика ' + h + ' · «мама» · ' + cs + ' · ' + col.name, def: 'Грильято классический ' + h + ' мм «мама» 600 мм, ячейка ' + cn + ', ' + col.name });
          out.push({ key: 'gr.' + g + '.papa.' + c + '.' + col.key, grp: g, cell: c, color: col.key, calcUnit: 'шт', lenM: 0.6,
            label: 'Классика ' + h + ' · «папа» · ' + cs + ' · ' + col.name, def: 'Грильято классический ' + h + ' мм «папа» 600 мм, ячейка ' + cn + ', ' + col.name });
        });
      });
      GR_COLORS.forEach(function (col) {
        out.push({ key: 'gr.' + g + '.g2400.' + col.key, grp: g, color: col.key, calcUnit: 'шт', lenM: 2.4,
          label: 'Классика ' + h + ' · направляющая 2400 · ' + col.name, def: 'Грильято классический ' + h + ' мм направляющая 2400, ' + col.name });
        out.push({ key: 'gr.' + g + '.g1200.' + col.key, grp: g, color: col.key, calcUnit: 'шт', lenM: 1.2,
          label: 'Классика ' + h + ' · направляющая 1200 · ' + col.name, def: 'Грильято классический ' + h + ' мм направляющая 1200, ' + col.name });
        out.push({ key: 'gr.' + g + '.g600.' + col.key, grp: g, color: col.key, calcUnit: 'шт', lenM: 0.6,
          label: 'Классика ' + h + ' · направляющая 600 · ' + col.name, def: 'Грильято классический ' + h + ' мм направляющая 600, ' + col.name });
      });
    });
    out.push({ key: 'gr.conn', grp: 'common', calcUnit: 'шт', label: 'Классика · соединитель направляющих', def: 'Соединитель направляющей грильято' });
    GR_COLORS.forEach(function (col) {
      out.push({ key: 'gr.angle.' + col.key, grp: 'common', color: col.key, calcUnit: 'шт', lenM: 3,
        label: 'Уголок пристенный 3 м · ' + col.name, def: 'Уголок пристенный 19х19 (3 м), ' + col.name });
    });
    return out;
  }
  ROLE_DEFS.grilyato = { title: 'Грильято', roles: buildGrilyatoRoles(), shared: 'armstrong' };

  function roleDefs(calc) { return (ROLE_DEFS[calc] && ROLE_DEFS[calc].roles) || []; }
  var _roleKeyIdx = null;
  function roleDef(key) {
    if (!_roleKeyIdx) { _roleKeyIdx = {}; for (var c in ROLE_DEFS) ROLE_DEFS[c].roles.forEach(function (d) { _roleKeyIdx[d.key] = d; }); }
    return _roleKeyIdx[key] || null;
  }
  var _roleLabelIdx = {};
  function roleByLabel(calc, label) {
    var l = String(label || '').trim();
    if (!_roleLabelIdx[calc]) { var ix = {}; roleDefs(calc).forEach(function (d) { ix[d.def] = d.key; }); _roleLabelIdx[calc] = ix; }
    if (_roleLabelIdx[calc][l]) return _roleLabelIdx[calc][l];
    var sh = ROLE_DEFS[calc] && ROLE_DEFS[calc].shared; // общие роли (подвесы, крепёж) — у Армстронга
    return sh ? roleByLabel(sh, l) : null;
  }
  // привязки: { 'arm.main3600': { code, name, unit, m2PerPiece } }
  function rolesMap() {
    var out = {};
    catalogRaw().forEach(function (o) {
      if (!isRoleCode(o.code)) return;
      out[o.code.slice(5)] = { code: o.nomCode, name: o.name || '', unit: o.unit || '', m2PerPiece: o.m2PerPiece || 0, pcsPerUnit: o.pcsPerUnit || 0 };
    });
    return out;
  }
  function rolesSave(map) { // map: ключ роли → {code,name,unit,m2PerPiece} | null
    var roleItems = [];
    Object.keys(map || {}).forEach(function (k) {
      var b = map[k]; if (!b || !b.code) return;
      roleItems.push({ code: 'role:' + k, nomCode: b.code, name: b.name, unit: b.unit, m2PerPiece: b.m2PerPiece, pcsPerUnit: b.pcsPerUnit });
    });
    return catalogSave(catalogAll(), roleItems);
  }
  // Перевод количества: шт → м² (по площади плиты), шт → м.п. (по длине штуки)
  function unitKind(u) {
    u = String(u || '').toLowerCase().replace(/\s+/g, '');
    if (/^(м2|м²|кв\.?м|м\.?кв)/.test(u)) return 'm2';
    if (/^(м\.?п|пог|мп|м\.?$|метр)/.test(u)) return 'mp';
    if (/^шт/.test(u)) return 'pcs';
    return u || 'pcs';
  }
  function convertQty(qty, fromUnit, toUnit, opt) {
    opt = opt || {}; qty = num(qty, 0);
    var a = unitKind(fromUnit), b = unitKind(toUnit);
    if (a === b) return qty;
    var r2 = function (v) { return Math.round(v * 100) / 100; };
    if (a === 'pcs' && b === 'm2' && opt.m2PerPiece > 0) return r2(qty * opt.m2PerPiece);
    if (a === 'pcs' && b === 'mp' && opt.lenM > 0) return r2(qty * opt.lenM);
    if (a === 'm2' && b === 'pcs' && opt.m2PerPiece > 0) return Math.ceil(+(qty / opt.m2PerPiece).toFixed(6));
    if (a === 'mp' && b === 'pcs' && opt.lenM > 0) return Math.ceil(+(qty / opt.lenM).toFixed(6));
    // штуки ↔ «крупная» единица (тыс.шт, упак …): по полю «шт в единице»
    var r3 = function (v) { return Math.round(v * 1000) / 1000; };
    if (a === 'pcs' && b !== 'm2' && b !== 'mp' && opt.pcsPerUnit > 1) return r3(qty / opt.pcsPerUnit);
    if (b === 'pcs' && a !== 'm2' && a !== 'mp' && opt.fromPcsPerUnit > 1) return Math.ceil(+(qty * opt.fromPcsPerUnit).toFixed(6));
    return qty;
  }
  // шт в единице 1С: справочник (своё/папка/авто) → снимок привязки → по единице и названию
  function pcsFor(code, unit, name, snap) {
    var k = 0;
    if (code && NOM_INDEX && NOM_INDEX.byId[code]) k = catalogResolve(code).pcsPerUnit;
    if (!k && snap) k = num(snap, 0);
    if (!k) k = autoPcsPerUnit(unit, name);
    return k > 1 ? k : 0;
  }
  // параметры пересчёта для позиции 1С по роли
  function unitOpt(code, name, unit, def, snap) {
    snap = snap || {};
    return { m2PerPiece: m2For(code, name, def, snap.m2PerPiece), lenM: def && def.lenM, pcsPerUnit: pcsFor(code, unit, name, snap.pcsPerUnit) };
  }
  // m² одной штуки для позиции 1С: справочник → снимок привязки → по названию → из роли
  function m2For(code, name, def, snap) {
    var m2 = 0;
    if (code && NOM_INDEX && NOM_INDEX.byId[code]) m2 = catalogResolve(code).m2PerPiece;
    if (!m2 && snap) m2 = num(snap, 0);
    if (!m2 && name) m2 = sizeM2(name);
    if (!m2 && def && def.m2) m2 = def.m2;
    return m2;
  }
  // Строка для журнала/i5 по роли: позиция 1С (если привязана) + пересчёт единиц
  function roleRow(roleKey, qty, fallbackLabel, map) {
    var def = roleDef(roleKey);
    var b = (map || rolesMap())[roleKey];
    var calcUnit = (def && def.calcUnit) || 'шт';
    var row = { role: roleKey, calcQty: num(qty, 0), calcUnit: calcUnit, qtyReserve: 0, price: 0 };
    if (b && b.code) {
      row.label = b.name || fallbackLabel || (def && def.def) || '';
      row.unit = b.unit || 'шт.';
      row.nomId = b.code;
      row.qtyCalc = convertQty(qty, calcUnit, row.unit, unitOpt(b.code, b.name, row.unit, def, b));
    } else {
      row.label = fallbackLabel || (def && def.def) || roleKey;
      row.unit = 'шт.';
      row.qtyCalc = num(qty, 0);
    }
    return row;
  }

  var CJ = {
    version: '1.8.1',
    COMPANY: COMPANY,
    STATUSES: STATUSES,
    DEFAULTS: DEFAULTS,
    settings: loadSettings, saveSettings: saveSettings,
    manager: function () { return loadSettings().manager; },
    isApi: isApi,
    sync: sync, reserveNumber: reserveNumber, createReserved: createReserved, apiFetch: apiFetch,
    all: loadRecords, get: get, save: save, remove: remove,
    duplicate: duplicate, duplicateReserved: duplicateReserved,
    create: emptyRecord, fromCalcPayload: fromCalcPayload,
    nextNumber: nextNumber, formatNumber: formatNumber, parseSeq: parseSeq,
    rowQty: rowQty, qtyRound: qtyRound, rowSum: rowSum, computeTotals: computeTotals,
    buildClientPayload: buildClientPayload, sendKpToClient: sendKpToClient, fetchOpens: fetchOpens,
    i5UrlForRecord: i5UrlForRecord, calcUrlForRecord: calcUrlForRecord, kpUrlForToken: kpUrlForToken,
    withParam: withParam,
    addComment: addComment, addHistory: addHistory,
    exportJSON: exportJSON, importJSON: importJSON, summary: summary,
    statusInfo: statusInfo, money: money,
    b64enc: b64enc, b64dec: b64dec,
    uid: uid, num: num, clone: clone, nowISO: nowISO,
    on: on,
    catalog: catalogAll, catalogMap: catalogMap, catalogSave: catalogSave, catalogSync: catalogSync,
    catalogResolve: catalogResolve, catalogFind: catalogFind, catalogPackRound: catalogPackRound,
    nomLoad: nomLoad, nomLoadText: nomLoadText, nomIndex: nomIndex, nomPath: nomPath, nomUrl: nomUrl,
    sizeM2: sizeM2,
    ROLE_DEFS: ROLE_DEFS, roleDefs: roleDefs, roleDef: roleDef, roleByLabel: roleByLabel,
    GR: { cells: GR_CELLS, colors: GR_COLORS, heights: GR_HEIGHTS, perGrid: grPerGrid },
    rolesMap: rolesMap, rolesSave: rolesSave, roleRow: roleRow, convertQty: convertQty, unitKind: unitKind, m2For: m2For, pcsFor: pcsFor, unitOpt: unitOpt, autoPcsPerUnit: autoPcsPerUnit
  };

  global.addEventListener('storage', function (e) {
    if (e.key === K_RECORDS) emit('records-changed', { external: true });
    if (e.key === K_SETTINGS) emit('settings-changed', {});
    if (e.key === K_CATALOG) emit('catalog-changed', { external: true });
  });

  global.CubicaJournal = CJ;
})(window);

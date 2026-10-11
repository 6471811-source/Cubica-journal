/* ============================================================
   CUBICA · Ядро журнала
   Подключается на: журнал (index.html), i5, k6.3 (позже — kp)
   Публичный интерфейс: window.CubicaJournal
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
      kp:      'https://6471811-source.github.io/cubica-kp/'
    },
    numberFormat: { invoice: 'СЧ-{YYYY}-{NNNN}', kp: 'КП-{YYYY}-{NNNN}' }
  };

  var COMPANY = {
    name: 'ООО «ВК ТЕРМ»',
    address: 'РБ, 223051, Минская обл., Минский р-н, аг. Колодищи, ул. Минская, д. 5, пом. 107-4',
    phone: '+375 (44) 752-70-73',
    email: '7527073@armstrong.by',
    site: 'cubica.by',
    site2: 'armstrong.by',
    unp: '191202287',
    account: 'BY79MTBK30120001093300125719',
    bank: 'ЗАО «МТБанк», г. Минск',
    bic: 'MTBKBY22',
    director: 'Креминский И. Ю.',
    directorPosition: 'Директор',
    tagline: 'modern ceiling solutions',
    issueAddress: 'аг. Колодищи, ул. Минская, 5, этаж 5, офис 508',
    pickupAddress: 'аг. Колодищи, территория учебного парка',
    hours: 'Пн–Пт, 09:00–15:00'
  };

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
  function rowsFromRooms(rooms) {
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
    rec.rooms = clone(payload.rooms || []);
    rec.meta = clone(payload.meta || null);
    if (payload.company) rec.company = clone(payload.company);
    rec.rows = rowsFromRooms(rec.rooms);
    if (!rec.rows.length && Array.isArray(payload.rows)) {
      rec.rows = payload.rows.map(function (r) {
        return { label: String(r.label || ''), qtyCalc: num(r.qty), qtyReserve: 0, unit: r.unit || 'шт.', price: 0 };
      });
    }
    rec.totals = computeTotals(rec.rows);
    rec.history.push({ at: nowISO(), by: rec.createdBy, action: 'from calculator' });
    return save(rec, { assignNumber: false });
  }

  function buildClientPayload(rec) {
    var s = loadSettings();
    var totals = rec.totals && rec.totals.total ? rec.totals : computeTotals(rec.rows, s.vatRate);
    var rooms = (rec.rooms || []).map(function (room) {
      return {
        name: room.name || 'Помещение',
        L_in: num(room.L_in), W_in: num(room.W_in),
        railW: num(room.railW, 50), railH: num(room.railH, 30), gap: num(room.gap, 15),
        color: room.color || 'denver',
        colorLabel: room.colorLabel || room.color || 'denver',
        caps: room.caps ? 1 : 0, angle: room.angle ? 1 : 0,
        rotation: num(room.rotationDeg || room.rotation),
        polygon: room.polygon || null,
        areaM2: num(room.areaM2),
        rows: (room.rows || []).map(function (r) {
          return { label: String(r.label || ''), qty: num(r.qty), unit: r.unit || 'шт.' };
        })
      };
    });
    var meta = rec.meta || {};
    var first = rooms[0] || {};
    var valid = new Date(); valid.setDate(valid.getDate() + 10);
    return {
      v: 6, rooms: rooms, i5_url: s.urls.i5,
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
      rows: (rec.rows || []).map(function (r) {
        return { label: r.label, qty: rowQty(r), unit: r.unit || 'шт.', price: num(r.price) };
      }),
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
    return { version: 2, exported: nowISO(), settings: s, records: loadRecords() };
  }
  function importJSON(data, opts) {
    opts = opts || {};
    var incoming = Array.isArray(data) ? data : (data && data.records);
    if (!Array.isArray(incoming)) throw new Error('Неверный формат файла');
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

  var CJ = {
    version: '1.0.0',
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
    rowQty: rowQty, rowSum: rowSum, computeTotals: computeTotals, rowsFromRooms: rowsFromRooms,
    buildClientPayload: buildClientPayload, sendKpToClient: sendKpToClient, fetchOpens: fetchOpens,
    i5UrlForRecord: i5UrlForRecord, calcUrlForRecord: calcUrlForRecord, kpUrlForToken: kpUrlForToken,
    withParam: withParam,
    addComment: addComment, addHistory: addHistory,
    exportJSON: exportJSON, importJSON: importJSON, summary: summary,
    statusInfo: statusInfo, money: money,
    b64enc: b64enc, b64dec: b64dec,
    uid: uid, num: num, clone: clone, nowISO: nowISO,
    on: on
  };

  global.addEventListener('storage', function (e) {
    if (e.key === K_RECORDS) emit('records-changed', { external: true });
    if (e.key === K_SETTINGS) emit('settings-changed', {});
  });

  global.CubicaJournal = CJ;
})(window);

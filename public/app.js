// 輕注音詞庫：單頁網頁。所有資料都透過 /api 取得，登入後依角色顯示不同功能。
// 畫面：① 查詢詞庫 ② 待審新詞 ③ 我的 ④ 審核台 ⑤ 版本 ⑥ 回報處理 ⑦ 分析 ⑧ 管理

// ==================== 小工具 ====================

/** 建立元素。文字一律用 textContent 放進去，不用 innerHTML，避免 XSS */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, code: data.code });
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 5000 : 2500);
}

/** 執行一個動作；失敗就把資料庫給的訊息（例如「名額已滿」）顯示出來 */
async function attempt(fn, success) {
  try {
    const result = await fn();
    if (success) toast(success);
    return result;
  } catch (e) {
    toast(e.message, true);
    if (e.status === 401) login();
    return undefined;
  }
}

const fmt = (n) => Number(n ?? 0).toLocaleString('zh-TW');
const date = (t) => (t ? new Date(t).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' }) : '');
const STATUS = { pending: '待審', approved: '加入', rejected: '不收', blocked: '封鎖', staged: '草稿中', active: '上線', retired: '停用' };
const ACTION = { add: '新增', remove: '停用', reweight: '調詞頻' };

// ==================== 登入與導覽 ====================

let user = null;

const PAGES = [
  { path: 'search', name: '查詢詞庫', view: searchView },
  { path: 'candidates', name: '待審新詞', view: candidatesView },
  { path: 'me', name: '我的', view: meView, login: true },
  { path: 'review', name: '審核台', view: reviewView, editor: true },
  { path: 'releases', name: '版本', view: releasesView, editor: true },
  { path: 'reports', name: '回報處理', view: reportsView, editor: true },
  { path: 'analytics', name: '分析', view: analyticsView, editor: true },
  { path: 'admin', name: '管理', view: adminView, editor: true },
];

function renderChrome(current) {
  const visible = PAGES.filter((p) => (!p.login || user) && (!p.editor || user?.role === 'editor'));
  const links = [];
  visible.forEach((p, i) => {
    if (p.editor && !visible[i - 1]?.editor) links.push(h('span', { class: 'sep' }));
    links.push(h('a', { href: `#/${p.path}`, class: p.path === current ? 'on' : '' }, p.name));
  });
  document.getElementById('nav').replaceChildren(...links);
  document.getElementById('account').replaceChildren(...(user
    ? [h('span', {}, user.display_name, user.role === 'editor' ? '（編輯）' : ''),
       h('button', { class: 'small', onclick: logout }, '登出')]
    : [h('button', { class: 'small primary', onclick: login }, '登入')]));
}

function login() {
  const dialog = document.getElementById('login');
  const form = dialog.querySelector('form');
  const error = form.querySelector('.error');
  error.hidden = true;
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      ({ user } = await api('/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) }));
      dialog.close();
      route();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  };
  form.querySelector('[value=cancel]').onclick = () => dialog.close();
  dialog.showModal();
}

async function logout() {
  await api('/logout', { method: 'POST' });
  user = null;
  location.hash = '#/search';
  route();
}

let cleanup = null;
async function route() {
  cleanup?.();
  cleanup = null;
  const path = location.hash.replace(/^#\//, '').split('?')[0] || 'search';
  const page = PAGES.find((p) => p.path === path) ?? PAGES[0];
  renderChrome(page.path);
  const view = document.getElementById('view');
  if ((page.login && !user) || (page.editor && user?.role !== 'editor')) {
    view.replaceChildren(h('div', { class: 'panel empty' }, page.editor ? '這一頁只有編輯能使用，請用編輯帳號登入。' : '請先登入。'));
    return;
  }
  view.replaceChildren();
  cleanup = (await page.view(view)) ?? null;
}

// ==================== ① 查詢詞庫 ====================

function searchView(root) {
  const modes = { initials: '首字注音', bopomofo: '完整注音', text: '詞' };
  const placeholders = { initials: '例：ㄍㄌㄑ', bopomofo: '例：ㄋㄧˇ ㄏㄠˇ', text: '例：旅' };
  let mode = 'initials';
  const input = h('input', { class: 'grow', autofocus: true });
  const tabs = h('div', { class: 'tabs' });
  const results = h('div');
  const side = h('div', { class: 'side' });

  const drawTabs = () => {
    tabs.replaceChildren(...Object.entries(modes).map(([k, v]) =>
      h('button', { class: k === mode ? 'on' : '', onclick: () => { mode = k; drawTabs(); search(); } }, v)));
    input.placeholder = placeholders[mode];
  };
  let timer;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });

  async function search() {
    const q = input.value.trim();
    if (!q) return results.replaceChildren(h('div', { class: 'empty' }, '輸入注音或詞開始查詢'));
    const { results: rows } = await api(`/lexicon?mode=${mode}&q=${encodeURIComponent(q)}`);
    results.replaceChildren(rows.length === 0 ? h('div', { class: 'empty' }, '詞庫裡沒有符合的詞') : h('table', {},
      h('tr', {}, h('th', {}, '詞'), h('th', {}, '讀音'), h('th', { class: 'num' }, '詞頻'), h('th', {}, '來源')),
      rows.map((r) => h('tr', { class: 'click', onclick: () => showEntry(r.entry_id) },
        h('td', {}, r.text), h('td', { class: 'bopomofo' }, r.bopomofo),
        h('td', { class: 'num' }, fmt(r.frequency)), h('td', { class: 'muted' }, r.source)))));
  }

  async function showEntry(id) {
    const { entry, next, prev, history } = await api(`/lexicon/${id}`);
    const words = (list) => list.length ? list.map((w) => h('span', { class: 'chip' }, w.text)) : h('span', { class: 'muted' }, '無');
    const kind = h('select', {}, h('option', { value: 'wrong_reading' }, '讀音錯誤'),
      h('option', { value: 'not_word' }, '不是一個詞'), h('option', { value: 'offensive' }, '冒犯性內容'));
    const note = h('input', { placeholder: '補充說明（選填）', maxlength: 200 });
    const editor = user?.role === 'editor' && entry.status === 'active';
    const freq = h('input', { type: 'number', min: 0, value: entry.frequency, style: 'width:110px' });
    side.replaceChildren(h('div', { class: 'panel stack' },
      h('div', {}, h('div', { class: 'big' }, entry.text), h('div', { class: 'bopomofo muted' }, entry.bopomofo)),
      h('div', { class: 'row' }, h('span', { class: 'chip ok' }, STATUS[entry.status]),
        h('span', { class: 'chip' }, entry.source), h('span', { class: 'chip' }, `詞頻 ${fmt(entry.frequency)}`),
        h('span', { class: 'chip' }, `語料 ${fmt(entry.corpus_count)} 次`)),
      h('div', {}, h('h2', {}, '常接在後面'), h('div', { class: 'row' }, words(next))),
      h('div', {}, h('h2', {}, '常出現在前面'), h('div', { class: 'row' }, words(prev))),
      history.length > 0 && h('div', {}, h('h2', {}, '版本紀錄'), history.map((c) =>
        h('div', { class: 'muted' }, `${c.version}　${ACTION[c.action]}`,
          c.action === 'reweight' ? `　${c.old_frequency} → ${c.new_frequency}` : '', c.status === 'draft' ? '（草稿）' : ''))),
      editor && h('div', {}, h('h2', {}, '維護（寫進草稿版本）'), h('div', { class: 'row' }, freq,
        h('button', { onclick: () => change('reweight') }, '調詞頻'),
        h('button', { class: 'danger', onclick: () => change('remove') }, '停用'))),
      user && h('div', {}, h('h2', {}, '回報這個詞條'), h('div', { class: 'stack' }, kind, note,
        h('button', { onclick: report }, '送出回報'))),
      !user && h('p', { class: 'muted' }, '登入後可以回報錯誤。')));

    async function report() {
      await attempt(() => api(`/lexicon/${id}/reports`, { method: 'POST', body: { kind: kind.value, note: note.value } }),
        '已送出回報，謝謝！');
    }
    async function change(action) {
      const ok = await attempt(() => api(`/lexicon/${id}/change`, {
        method: 'POST', body: { action, new_frequency: action === 'reweight' ? Number(freq.value) : null, row_version: entry.row_version },
      }), action === 'remove' ? '已排入草稿版本：停用' : '已排入草稿版本：調詞頻');
      if (ok) showEntry(id);
    }
  }

  drawTabs();
  root.append(h('h1', {}, '查詢詞庫'), h('p', { class: 'sub' }, '用首字注音、完整注音或詞的一部分，查正式詞庫裡上線中的詞條。'),
    h('div', { class: 'split' }, h('div', { class: 'stack' },
      h('div', { class: 'panel row' }, tabs, input), h('div', { class: 'panel' }, results)), side));
  search();
}

// ==================== ② 待審新詞 ====================

function candidateTable(rows, { onPick, selected, voting }) {
  return h('table', {},
    h('tr', {}, h('th', {}, '詞'), h('th', { class: 'num' }, '裝置（綁定）'), h('th', { class: 'num' }, '使用次數'),
      h('th', { class: 'num' }, '淨票'), voting && h('th', {}, '投票')),
    rows.map((r) => h('tr', { class: `${onPick ? 'click' : ''} ${selected === r.word_id ? 'sel' : ''}`, onclick: onPick && (() => onPick(r)) },
      h('td', {}, h('strong', {}, r.text)),
      h('td', { class: 'num' }, `${fmt(r.devices)}（${fmt(r.bound_devices)}）`),
      h('td', { class: 'num' }, fmt(r.uses)),
      h('td', { class: 'num' }, r.net_votes > 0 ? `+${fmt(r.net_votes)}` : fmt(r.net_votes)),
      voting && h('td', {}, voteButtons(r)))));
}

function voteButtons(r) {
  const box = h('span', { class: 'vote' });
  const draw = () => box.replaceChildren(
    h('button', { class: r.my_vote === 1 ? 'on' : '', onclick: (e) => { e.stopPropagation(); cast(r.my_vote === 1 ? 0 : 1); } }, '▲ 讚'),
    h('button', { class: r.my_vote === -1 ? 'on down' : '', onclick: (e) => { e.stopPropagation(); cast(r.my_vote === -1 ? 0 : -1); } }, '▼'));
  async function cast(value) {
    if (!user) return login();
    const res = await attempt(() => api(`/candidates/${r.word_id}/vote`, { method: 'POST', body: { value } }));
    if (res) { Object.assign(r, res); draw(); }
  }
  draw();
  return box;
}

function candidatesView(root) {
  const sorts = { devices: '最多裝置', votes: '最多票', uses: '最常用', recent: '最近' };
  let sort = 'devices';
  let rows = [];
  const tabs = h('div', { class: 'tabs' });
  const list = h('div');
  const more = h('button', { onclick: () => load(true) }, '載入更多');

  const drawTabs = () => tabs.replaceChildren(...Object.entries(sorts).map(([k, v]) =>
    h('button', { class: k === sort ? 'on' : '', onclick: () => { sort = k; drawTabs(); load(); } }, v)));

  async function load(append = false) {
    const { candidates } = await api(`/candidates?sort=${sort}&limit=50&offset=${append ? rows.length : 0}`);
    rows = append ? rows.concat(candidates) : candidates;
    list.replaceChildren(candidateTable(rows, { voting: true }));
  }

  drawTabs();
  root.append(h('h1', {}, '待審新詞'), h('p', { class: 'sub' }, '輸入法使用者打出、但詞庫還沒有的詞。投票幫編輯決定哪些詞值得收進下一版。'),
    h('div', { class: 'panel stack' }, tabs, list, h('div', { class: 'row end' }, more)));
  load();
}

// ==================== ④ 審核台 ====================

async function quotaBar() {
  const box = h('div', { class: 'panel quota' });
  async function refresh() {
    const { draft } = await api('/review/draft').catch(() => ({ draft: undefined }));
    if (draft === undefined) return;
    box.replaceChildren(...(draft
      ? [h('div', {}, h('div', { class: 'muted' }, '草稿版本'), h('div', { class: 'big' }, draft.version)),
         h('div', { class: `bar ${draft.used >= draft.max_new_words ? 'full' : ''}` },
           h('div', { style: `width:${(100 * draft.used) / draft.max_new_words}%` })),
         h('div', { class: 'num' }, h('div', { class: 'muted' }, '新詞名額'), h('div', { class: 'big' }, `${draft.used} / ${draft.max_new_words}`))]
      : [h('div', { class: 'grow' }, '目前沒有草稿版本，請到「版本」建立下一版。')]));
  }
  await refresh();
  return { box, refresh };
}

async function reviewView(root) {
  const quota = await quotaBar();
  let rows = [];
  let picked = null;
  const list = h('div');
  const side = h('div', { class: 'side' }, h('div', { class: 'panel empty' }, '從左邊選一個詞開始審核'));

  async function load() {
    ({ candidates: rows } = await api('/candidates?sort=devices&limit=30'));
    list.replaceChildren(candidateTable(rows, { onPick: pick, selected: picked }));
  }

  async function pick(row) {
    picked = row.word_id;
    list.replaceChildren(candidateTable(rows, { onPick: pick, selected: picked }));
    const d = await api(`/review/${row.word_id}`);
    const readings = h('div', { class: 'stack' });
    const addReading = (bopomofo = '') => {
      const line = h('div', { class: 'reading' },
        h('input', { class: 'bopomofo', value: bopomofo, placeholder: '完整讀音，音節以空格分隔' }),
        h('input', { type: 'number', min: 0, value: 1000, title: '詞頻' }),
        h('button', { class: 'ghost small', onclick: () => line.remove() }, '✕'));
      readings.append(line);
    };
    addReading(d.suggestions[0] ?? '');
    const decide = async (status) => {
      if (await attempt(() => api(`/review/${row.word_id}/decide`, { method: 'POST', body: { row_version: d.word.row_version, status } }),
        `已${STATUS[status]}「${d.word.text}」`) !== undefined) done();
    };
    const approve = async () => {
      const chosen = [...readings.querySelectorAll('.reading')].map((l) => {
        const [b, f] = l.querySelectorAll('input');
        return { bopomofo: b.value, frequency: Number(f.value) };
      }).filter((r) => r.bopomofo.trim());
      const res = await attempt(() => api(`/review/${row.word_id}/approve`, { method: 'POST', body: { row_version: d.word.row_version, readings: chosen } }));
      if (res) { toast(`已把「${d.word.text}」加入 ${res.version}`); done(); }
    };
    function done() {
      picked = null;
      side.replaceChildren(h('div', { class: 'panel empty' }, '從左邊選一個詞開始審核'));
      load();
      quota.refresh();
    }
    side.replaceChildren(h('div', { class: 'panel stack' },
      h('div', { class: 'row' }, h('span', { class: 'big grow' }, d.word.text), h('span', { class: 'chip', title: '樂觀鎖用的版本號' }, `row_version ${d.word.row_version}`)),
      h('div', {}, h('h2', {}, '使用者怎麼打'), h('table', {}, d.typed.map((t) =>
        h('tr', {}, h('td', { class: 'bopomofo' }, t.typed), h('td', { class: 'num muted' }, `${fmt(t.devices)} 台`))))),
      h('div', {}, h('h2', {}, '讀音與詞頻'),
        d.suggestions.length > 0 && h('div', { class: 'suggest', style: 'margin-bottom:10px' },
          h('span', { class: 'muted' }, '建議：'), d.suggestions.map((s) => h('button', { onclick: () => addReading(s) }, s))),
        readings,
        h('button', { class: 'ghost small', onclick: () => addReading() }, '＋ 再加一個讀音')),
      d.history.length > 0 && h('div', {}, h('h2', {}, '審核歷程（MongoDB）'), d.history.map((x) =>
        h('div', { class: 'muted' }, `${date(x.ts)}　${STATUS[x.from]} → ${STATUS[x.to]}`))),
      h('div', { class: 'row end' },
        h('button', { class: 'danger', onclick: () => decide('blocked') }, '封鎖'),
        h('button', { class: 'warn', onclick: () => decide('rejected') }, '不收'),
        h('button', { class: 'primary', onclick: approve }, '加入草稿版本'))));
  }

  root.append(h('h1', {}, '審核台'), h('p', { class: 'sub' }, '依綁定帳號的裝置數排序。加入的詞放進草稿版本，發布後使用者才打得到。'),
    h('div', { class: 'stack' }, quota.box, h('div', { class: 'split' }, h('div', { class: 'panel' }, list), side)));
  await load();
  // 每 5 秒更新名額，另一位編輯加了詞這裡也看得到
  const timer = setInterval(quota.refresh, 5000);
  return () => clearInterval(timer);
}

// ==================== ⑤ 版本 ====================

async function releasesView(root) {
  const detail = h('div');
  const { releases } = await api('/releases');
  const draft = releases.find((r) => r.status === 'draft');
  const latest = releases[0];
  const nextVersion = latest ? `${Number(latest.version.split('.')[0]) + 1}.0` : '1.0';

  async function show(version) {
    const { release, changes } = await api(`/releases/${version}`);
    const isDraft = release.status === 'draft';
    detail.replaceChildren(h('div', { class: 'panel stack' },
      h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, `${release.version} 的變更清單`),
        isDraft && h('button', { class: 'primary', onclick: publish }, `發布 ${release.version}`)),
      changes.length === 0 ? h('div', { class: 'empty' }, '沒有變更') : h('table', {},
        h('tr', {}, h('th', {}, '變更'), h('th', {}, '詞'), h('th', {}, '讀音'), h('th', { class: 'num' }, '詞頻'), h('th', {}, '經手'), isDraft && h('th', {})),
        changes.map((c) => h('tr', {},
          h('td', {}, h('span', { class: `chip ${c.action === 'add' ? 'ok' : 'warn'}` }, ACTION[c.action])),
          h('td', {}, c.text), h('td', { class: 'bopomofo muted' }, c.bopomofo),
          h('td', { class: 'num' }, c.action === 'add' ? fmt(c.new_frequency) : c.action === 'remove' ? fmt(c.old_frequency) : `${fmt(c.old_frequency)} → ${fmt(c.new_frequency)}`),
          h('td', { class: 'muted' }, c.editor ?? ''),
          isDraft && h('td', {}, c.action === 'add' && c.review_status === 'approved' &&
            h('button', { class: 'small', onclick: () => withdraw(c) }, '撤回')))))));
  }
  async function withdraw(c) {
    if (await attempt(() => api(`/review/${c.word_id}/withdraw`, { method: 'POST', body: { row_version: c.review_row_version } }),
      `已撤回「${c.text}」，回到待審`) !== undefined) show(draft.version);
  }
  async function publish() {
    if (!confirm(`確定發布 ${draft.version}？發布後就不能再修改。`)) return;
    const res = await attempt(() => api('/releases/publish', { method: 'POST' }));
    if (res) { toast(`已發布 ${res.version}：新增 ${res.added}、停用 ${res.removed}、調詞頻 ${res.reweighted}`); route(); }
  }
  async function create() {
    const version = prompt('新版本號', nextVersion);
    if (version && await attempt(() => api('/releases', { method: 'POST', body: { version } }), `已建立 ${version}`)) route();
  }

  root.append(h('h1', {}, '版本'), h('p', { class: 'sub' }, '每個版本最多 200 個新詞。草稿版本發布前可以撤回；發布後就不能再改。'),
    h('div', { class: 'split' }, detail, h('div', { class: 'side panel' },
      h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, '所有版本'),
        !draft && h('button', { class: 'small primary', onclick: create }, '建立下一版')),
      h('table', {}, releases.map((r) => h('tr', { class: 'click', onclick: () => show(r.version) },
        h('td', {}, h('strong', {}, r.version)),
        h('td', {}, r.status === 'draft' ? h('span', { class: 'chip warn' }, '草稿') : h('span', { class: 'muted' }, date(r.published_at))),
        h('td', { class: 'num muted' }, `+${r.added} −${r.removed}`)))))));
  show((draft ?? latest).version);
}

// ==================== ③ 我的 ====================

function meView(root) {
  const tabs = { devices: '我的裝置', share: '分享新詞', reports: '我的回報', words: '個人詞', packs: '詞庫包', account: '帳號' };
  let tab = 'devices';
  const bar = h('div', { class: 'tabs' });
  const body = h('div', { class: 'panel stack' });
  const KIND = { wrong_reading: '讀音錯誤', not_word: '不是一個詞', offensive: '冒犯性內容' };
  const REPORT = { open: '待處理', resolved: '已修正', dismissed: '駁回' };

  const draw = () => {
    bar.replaceChildren(...Object.entries(tabs).map(([k, v]) =>
      h('button', { class: k === tab ? 'on' : '', onclick: () => { tab = k; draw(); } }, v)));
    ({ devices, share, reports, words, packs, account })[tab]();
  };

  async function devices() {
    const { devices: rows } = await api('/me/devices');
    const id = h('input', { class: 'grow', placeholder: '輸入法「一般」設定裡的裝置代碼（UUID）' });
    body.replaceChildren(
      h('p', { class: 'muted', style: 'margin:0' }, '綁定後，這台裝置分享的新詞會算在你名下，個人詞也會同步到這台裝置。'),
      h('div', { class: 'row' }, id, h('button', { class: 'primary', onclick: async () => {
        if (await attempt(() => api('/me/devices', { method: 'POST', body: { device_id: id.value } }), '已綁定')) devices();
      } }, '綁定裝置')),
      rows.length === 0 ? h('div', { class: 'empty' }, '還沒有綁定的裝置') : h('table', {},
        h('tr', {}, h('th', {}, '平台'), h('th', {}, '版本'), h('th', {}, '最後同步'), h('th', { class: 'num' }, '分享過的詞'), h('th', {})),
        rows.map((d) => h('tr', {}, h('td', {}, { macos: 'macOS', windows: 'Windows', web: '網頁' }[d.platform]),
          h('td', {}, d.app_version ?? ''), h('td', { class: 'muted' }, date(d.last_synced_at)),
          h('td', { class: 'num' }, fmt(d.submissions)),
          h('td', {}, d.platform !== 'web' && h('button', { class: 'small', onclick: async () => {
            if (await attempt(() => api(`/me/devices/${d.device_id}`, { method: 'DELETE' }), '已解除綁定')) devices();
          } }, '解除'))))));
  }

  async function reports() {
    const { reports: rows } = await api('/me/reports');
    body.replaceChildren(rows.length === 0 ? h('div', { class: 'empty' }, '還沒有回報過。到「查詢詞庫」點一個詞條就能回報。') : h('table', {},
      h('tr', {}, h('th', {}, '詞'), h('th', {}, '類型'), h('th', {}, '回報時間'), h('th', {}, '結果')),
      rows.map((r) => h('tr', {}, h('td', {}, r.text, h('div', { class: 'bopomofo muted' }, r.bopomofo)),
        h('td', {}, KIND[r.kind], r.note && h('div', { class: 'muted' }, r.note)), h('td', { class: 'muted' }, date(r.created_at)),
        h('td', {}, h('span', { class: `chip ${r.status === 'resolved' ? 'ok' : r.status === 'open' ? 'warn' : ''}` }, REPORT[r.status]))))));
  }

  async function words() {
    const { words: rows } = await api('/me/personal-words');
    const text = h('input', { placeholder: '詞，例：周緯倫', style: 'width:160px' });
    const reading = h('input', { class: 'grow bopomofo', placeholder: '讀音，例：ㄓㄡ ㄨㄟˇ ㄌㄨㄣˊ' });
    body.replaceChildren(
      h('p', { class: 'muted', style: 'margin:0' }, '只有你自己打得到的詞（人名、暱稱…），會同步到你綁定的每一台裝置。'),
      h('div', { class: 'row' }, text, reading, h('button', { class: 'primary', onclick: async () => {
        if (await attempt(() => api('/me/personal-words', { method: 'POST', body: { text: text.value, bopomofo: reading.value } }), '已加入')) words();
      } }, '加入')),
      h('div', { class: 'muted' }, `共 ${fmt(rows.length)} 個`),
      h('table', {}, rows.slice(0, 200).map((w) => h('tr', {},
        h('td', {}, w.text), h('td', { class: 'bopomofo muted' }, w.bopomofo),
        h('td', {}, w.in_lexicon && h('span', { class: 'chip' }, '詞庫已有')),
        h('td', { class: 'num' }, h('button', { class: 'small', onclick: async () => {
          if (await attempt(() => api(`/me/personal-words/${w.word_id}?bopomofo=${encodeURIComponent(w.bopomofo)}`, { method: 'DELETE' }), '已刪除')) words();
        } }, '刪除'))))));
  }

  async function packs() {
    const { packs: rows } = await api('/me/packs');
    body.replaceChildren(h('p', { class: 'muted', style: 'margin:0' }, '編輯整理的主題詞庫，訂閱後輸入法會一起載入。'),
      h('table', {}, rows.map((p) => h('tr', {},
        h('td', {}, h('strong', {}, p.name), h('div', { class: 'muted' }, p.description)),
        h('td', { class: 'num muted' }, `${fmt(p.entries)} 個詞`),
        h('td', { class: 'num muted' }, `${fmt(p.subscribers)} 人訂閱`),
        h('td', { class: 'num' }, h('button', { class: p.subscribed ? '' : 'primary', onclick: async () => {
          if (await attempt(() => api(`/me/packs/${p.pack_id}`, { method: 'POST', body: { subscribe: !p.subscribed } }),
            p.subscribed ? '已取消訂閱' : '已訂閱')) packs();
        } }, p.subscribed ? '取消訂閱' : '訂閱'))))));
  }

  // 網頁投稿：沒有裝輸入法也能分享詞庫沒有的詞，算成這個帳號的「網頁」裝置
  function share() {
    const text = h('input', { placeholder: '詞，例：國旅券', style: 'width:160px' });
    const typed = h('input', { class: 'grow bopomofo', placeholder: '你怎麼打這個詞，例：ㄍㄌㄑ 或 ㄍㄨㄛˊㄌㄩˇㄑㄩㄢˋ' });
    body.replaceChildren(
      h('p', { class: 'muted', style: 'margin:0' }, '詞庫裡沒有、但你常用的詞。送出後會出現在「待審新詞」，大家投票、編輯審核後收進下一版。'),
      h('div', { class: 'row' }, text, typed, h('button', { class: 'primary', onclick: async () => {
        if (await attempt(() => api('/me/submissions', { method: 'POST', body: { text: text.value, typed: typed.value } }),
          `已分享「${text.value.trim()}」`)) { text.value = ''; typed.value = ''; }
      } }, '分享')));
  }

  // 刪除帳號：清空 email 與名稱，投票與回報紀錄保留但不再計入
  function account() {
    const password = h('input', { type: 'password', placeholder: '輸入密碼確認', autocomplete: 'current-password' });
    body.replaceChildren(
      h('h2', {}, '刪除帳號'),
      h('p', { class: 'muted', style: 'margin:0' },
        '刪除後無法復原：email 與顯示名稱會被清空，你的裝置下次同步時會移除個人詞與詞庫包，之後可以綁定到別的帳號。過去的投票與回報紀錄會保留（不顯示你的名字），但票不再計入排序。'),
      h('div', { class: 'row' }, password, h('button', { class: 'danger', onclick: async () => {
        if (!confirm('確定要刪除帳號？這個動作無法復原。')) return;
        if (await attempt(() => api('/me/delete', { method: 'POST', body: { password: password.value } }), '帳號已刪除')) {
          user = null;
          location.hash = '#/search';
          route();
        }
      } }, '刪除我的帳號')));
  }

  root.append(h('h1', {}, '我的'), h('p', { class: 'sub' }, `${user.display_name}・${user.email}`),
    h('div', { class: 'stack' }, bar, body));
  draw();
}

// ==================== ⑥ 回報處理 ====================

function reportsView(root) {
  const KIND = { wrong_reading: '讀音錯誤', not_word: '不是一個詞', offensive: '冒犯性內容' };
  let status = 'open';
  let rows = [];
  let picked = null;
  const bar = h('div', { class: 'tabs' });
  const list = h('div', { class: 'panel' });
  const side = h('div', { class: 'side' });

  const drawBar = () => bar.replaceChildren(
    h('button', { class: status === 'open' ? 'on' : '', onclick: () => { status = 'open'; drawBar(); load(); } }, '待處理'),
    h('button', { class: status === 'handled' ? 'on' : '', onclick: () => { status = 'handled'; drawBar(); load(); } }, '已處理'));

  function drawList() {
    list.replaceChildren(rows.length === 0 ? h('div', { class: 'empty' }, '沒有回報') : h('table', {},
      h('tr', {}, h('th', {}, '詞條'), h('th', {}, '類型'), h('th', {}, '來源'), h('th', {}, status === 'open' ? '回報時間' : '處理')),
      rows.map((r) => h('tr', { class: `click ${picked === r.report_id ? 'sel' : ''}`, onclick: () => pick(r) },
        h('td', {}, r.text, h('div', { class: 'bopomofo muted' }, r.bopomofo)),
        h('td', { class: 'nowrap' }, KIND[r.kind], r.open_on_entry > 1 && h('span', { class: 'chip warn', style: 'margin-left:6px' }, `${r.open_on_entry} 人回報`)),
        h('td', { class: 'muted nowrap' }, r.source),
        h('td', { class: 'muted nowrap' }, status === 'open' ? date(r.created_at) : `${r.status === 'resolved' ? '修正' : '駁回'}・${r.handler ?? '已刪除的帳號'}`)))));
  }

  async function load() {
    ({ reports: rows } = await api(`/reports?status=${status}`));
    picked = null;
    drawList();
    side.replaceChildren(h('div', { class: 'panel empty' }, status === 'open' ? '選一筆回報來處理' : '已處理的回報不能再修改'));
  }

  function pick(r) {
    if (status !== 'open') return;
    picked = r.report_id;
    drawList();
    const freq = h('input', { type: 'number', min: 0, value: r.frequency, style: 'width:110px' });
    const reading = h('input', { class: 'grow bopomofo', value: r.bopomofo });
    const resolve = async (resolution, extra = {}) => {
      const ok = await attempt(() => api(`/reports/${r.report_id}/resolve`, {
        method: 'POST', body: { resolution, entry_row_version: r.row_version, ...extra },
      }), resolution === 'dismiss' ? '已駁回' : '已處理，變更寫進草稿版本');
      if (ok) load();
    };
    side.replaceChildren(h('div', { class: 'panel stack' },
      h('div', {}, h('div', { class: 'big' }, r.text), h('div', { class: 'bopomofo muted' }, r.bopomofo)),
      h('div', { class: 'row' }, h('span', { class: 'chip warn' }, KIND[r.kind]), h('span', { class: 'chip' }, r.source),
        h('span', { class: 'chip' }, `詞頻 ${fmt(r.frequency)}`)),
      h('div', { class: 'muted' }, `${r.reporter ?? '已刪除的帳號'}・${date(r.created_at)}`),
      r.note && h('div', {}, `「${r.note}」`),
      h('div', {}, h('h2', {}, '回報成立'), h('div', { class: 'stack' },
        h('div', { class: 'row' }, freq, h('button', { onclick: () => resolve('reweight', { new_frequency: Number(freq.value) }) }, '調詞頻')),
        h('div', { class: 'row' }, reading, h('button', { onclick: () => resolve('fix_reading', { new_bopomofo: reading.value }) }, '修正讀音')),
        h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, '修正讀音＝停用舊詞條＋新增正確讀音，會占草稿版本一個新詞名額。'),
        h('button', { class: 'danger', onclick: () => resolve('remove') }, '停用這個詞條'))),
      h('div', { class: 'row end' }, h('button', { onclick: () => resolve('dismiss') }, '駁回（不用改）'))));
  }

  drawBar();
  root.append(h('h1', {}, '回報處理'), h('p', { class: 'sub' }, '使用者回報的錯誤詞條。成立的修改會寫進草稿版本，發布後生效。'),
    h('div', { class: 'stack' }, bar, h('div', { class: 'split' }, list, side)));
  load();
}

// ==================== ⑦ 分析 ====================

function analyticsView(root) {
  const OUTCOME = { approved: '加入', rejected: '不收', blocked: '封鎖' };
  const days = (d) => `${d.toFixed(1)} 天`;
  const pct = (x) => `${(100 * x).toFixed(0)}%`;
  const meter = (value, max) => h('div', { class: 'bar', style: 'min-width:80px' }, h('div', { style: `width:${max ? (100 * value) / max : 0}%` }));

  function section(title, why, sources, path, draw) {
    const body = h('div', { class: 'muted' }, '計算中…');
    const started = performance.now();
    api(`/analytics/${path}`).then((data) => {
      body.replaceChildren(draw(data));
      time.textContent = `${Math.round(performance.now() - started)} ms`;
    }, (e) => { body.replaceChildren(h('div', { class: 'error' }, e.message)); });
    const time = h('span', { class: 'muted', style: 'font-size:12px' });
    return h('section', { class: 'panel stack' },
      h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, title),
        sources.map((s) => h('span', { class: `chip ${s === 'MongoDB' ? 'warn' : 'ok'}` }, s)), time),
      h('p', { class: 'muted', style: 'margin:0' }, why), body);
  }

  const overview = h('div', { class: 'row' });
  api('/analytics/overview').then((o) => overview.replaceChildren(...[
    ['待審新詞', o.pending], ['待處理回報', o.open_reports], ['近 7 天活躍裝置', o.active_devices],
    ['上線詞條', o.active_entries], ['使用者', o.users],
  ].map(([k, v]) => h('div', { class: 'panel grow' }, h('div', { class: 'muted' }, k), h('div', { class: 'big' }, fmt(v))))));

  root.append(h('h1', {}, '分析'), h('p', { class: 'sub' }, '幫編輯決定下一步：先審哪些詞、該調哪些詞頻、審核的眼光準不準。'),
    h('div', { class: 'stack' }, overview,

      section('1. 很多人在用、卻等很久的詞', '超過 100 台裝置在用、第一次出現超過 7 天還沒審。這是審核的待辦清單。',
        ['PostgreSQL'], 'backlog', ({ rows }) => h('table', {},
          h('tr', {}, h('th', {}, '詞'), h('th', { class: 'num' }, '裝置'), h('th', { class: 'num' }, '使用次數'), h('th', { class: 'num' }, '已等待')),
          rows.map((r) => h('tr', {}, h('td', {}, r.text), h('td', { class: 'num' }, fmt(r.devices)),
            h('td', { class: 'num' }, fmt(r.uses)), h('td', { class: 'num' }, `${r.waiting_days} 天`))))),

      section('2. 使用次數與票數落差大的詞', '把使用次數與淨票各自換成百分位再相減。左邊：很多人用卻沒人投票；右邊：票很多卻少人用，可能被灌票。',
        ['PostgreSQL'], 'gap', ({ used, voted }) => h('div', { class: 'split', style: 'grid-template-columns:1fr 1fr' },
          ...[['常用但票少', used], ['票多但少用', voted]].map(([name, list]) => h('div', {}, h('h2', {}, name), h('table', {},
            h('tr', {}, h('th', {}, '詞'), h('th', { class: 'num' }, '使用次數'), h('th', { class: 'num' }, '淨票')),
            list.map((r) => h('tr', {}, h('td', {}, r.text), h('td', { class: 'num' }, fmt(r.uses)), h('td', { class: 'num' }, fmt(r.net_votes))))))))),

      section('3. 各來源被回報的比例', '哪個來源的詞條品質最需要注意：每千筆詞條收到幾筆回報、處理過的回報有多少成立。',
        ['PostgreSQL'], 'sources', ({ rows }) => {
          const max = Math.max(...rows.map((r) => r.per_thousand));
          return h('table', {},
            h('tr', {}, h('th', {}, '來源'), h('th', { class: 'num' }, '詞條'), h('th', { class: 'num' }, '回報'), h('th', {}, '每千筆回報'), h('th', { class: 'num' }, '成立比例')),
            rows.map((r) => h('tr', {}, h('td', {}, r.source), h('td', { class: 'num' }, fmt(r.entries)), h('td', { class: 'num' }, fmt(r.reports)),
              h('td', {}, h('div', { class: 'row' }, meter(r.per_thousand, max), h('span', { class: 'num' }, r.per_thousand))),
              h('td', { class: 'num' }, r.resolved_pct == null ? '—' : `${r.resolved_pct}%`))));
        }),

      section('4. 從第一次投稿到審核完成要幾天', '投稿時間來自 PostgreSQL，第一次審核決定的時間來自 MongoDB 的審核歷程（重審不會蓋掉）。',
        ['MongoDB', 'PostgreSQL'], 'review-time', ({ rows }) => h('table', {},
          h('tr', {}, h('th', {}, '結果'), h('th', { class: 'num' }, '詞數'), h('th', { class: 'num' }, '平均'), h('th', { class: 'num' }, '中位數'), h('th', { class: 'num' }, '90% 在幾天內')),
          rows.map((r) => h('tr', {}, h('td', {}, OUTCOME[r.outcome]), h('td', { class: 'num' }, fmt(r.words)),
            h('td', { class: 'num' }, days(r.avg)), h('td', { class: 'num' }, days(r.median)), h('td', { class: 'num' }, days(r.p90)))))),

      section('5. 常要翻到第 5 名之後才選到的詞', '從 200 萬筆選字紀錄找出常排在後面的詞條：同音詞多、詞頻又偏低，可以考慮調高詞頻。',
        ['MongoDB', 'PostgreSQL'], 'late-picks', ({ rows }) => h('table', {},
          h('tr', {}, h('th', {}, '詞'), h('th', {}, '讀音'), h('th', { class: 'num' }, '目前詞頻'), h('th', { class: 'num' }, '被選次數'), h('th', { class: 'num' }, '第 5 名後'), h('th', { class: 'num' }, '平均名次')),
          rows.map((r) => h('tr', {}, h('td', {}, r.text), h('td', { class: 'bopomofo muted' }, r.bopomofo), h('td', { class: 'num' }, fmt(r.frequency)),
            h('td', { class: 'num' }, fmt(r.picks)), h('td', { class: 'num' }, pct(r.late_ratio)), h('td', { class: 'num' }, r.avg_rank.toFixed(1)))))),

      section('6. 各版新加入的詞，發布後有人用嗎', 'PostgreSQL 列出每一版新增的詞條，MongoDB 數這些詞條被選了幾次。用來檢查審核的眼光。',
        ['MongoDB', 'PostgreSQL'], 'adoption', ({ rows }) => {
          const max = Math.max(...rows.map((r) => r.per_word));
          return h('table', {},
            h('tr', {}, h('th', {}, '版本'), h('th', { class: 'num' }, '新詞'), h('th', { class: 'num' }, '被選次數'), h('th', {}, '每個詞平均'), h('th', { class: 'num' }, '沒人用'), h('th', {}, '最常用')),
            rows.map((r) => h('tr', {}, h('td', {}, h('strong', {}, r.version)), h('td', { class: 'num' }, fmt(r.words)),
              h('td', { class: 'num' }, fmt(r.picks)),
              h('td', {}, h('div', { class: 'row' }, meter(r.per_word, max), h('span', { class: 'num' }, r.per_word.toFixed(1)))),
              h('td', { class: 'num' }, fmt(r.unused)), h('td', { class: 'muted' }, r.top.slice(0, 3).map((t) => t.text).join('、')))));
        })));
}

// ==================== ⑧ 管理 ====================

function adminView(root) {
  const tabs = { packs: '詞庫包', users: '帳號' };
  const PACK = { draft: '草稿', published: '上架中', archived: '已下架' };
  const USER = { active: '正常', suspended: '停權' };
  let tab = 'packs';
  const bar = h('div', { class: 'tabs' });
  const body = h('div');

  const draw = () => {
    bar.replaceChildren(...Object.entries(tabs).map(([k, v]) =>
      h('button', { class: k === tab ? 'on' : '', onclick: () => { tab = k; draw(); } }, v)));
    ({ packs, users })[tab]();
  };

  async function packs(selected = null) {
    const { packs: rows } = await api('/admin/packs');
    const side = h('div', { class: 'side' }, h('div', { class: 'panel empty' }, '選一個詞庫包來編輯內容'));
    const name = h('input', { placeholder: '名稱，例：台灣地名', maxlength: 30, style: 'width:160px' });
    const desc = h('input', { class: 'grow', placeholder: '說明（選填）', maxlength: 200 });
    const setStatus = async (p, status) => {
      if (await attempt(() => api(`/admin/packs/${p.pack_id}/status`, { method: 'POST', body: { status } }),
        status === 'published' ? `已上架「${p.name}」` : `已下架「${p.name}」`)) packs(p.pack_id);
    };
    const remove = async (p) => {
      if (!confirm(`刪除草稿詞庫包「${p.name}」？`)) return;
      if (await attempt(() => api(`/admin/packs/${p.pack_id}`, { method: 'DELETE' }), '已刪除')) packs();
    };
    body.replaceChildren(h('div', { class: 'split' }, h('div', { class: 'panel stack' },
      h('div', { class: 'row' }, name, desc, h('button', { class: 'primary', onclick: async () => {
        const res = await attempt(() => api('/admin/packs', { method: 'POST', body: { name: name.value, description: desc.value } }),
          `已建立「${name.value.trim()}」（草稿）`);
        if (res) packs(res.pack_id);
      } }, '建立詞庫包')),
      h('table', {},
        h('tr', {}, h('th', {}, '詞庫包'), h('th', {}, '狀態'), h('th', { class: 'num' }, '詞條'), h('th', { class: 'num' }, '訂閱'), h('th', {})),
        rows.map((p) => h('tr', { class: `click ${selected === p.pack_id ? 'sel' : ''}`, onclick: () => { selected = p.pack_id; packs(p.pack_id); } },
          h('td', {}, h('strong', {}, p.name), h('div', { class: 'muted' }, p.description ?? '')),
          h('td', {}, h('span', { class: `chip ${p.status === 'published' ? 'ok' : p.status === 'draft' ? 'warn' : ''}` }, PACK[p.status])),
          h('td', { class: 'num' }, fmt(p.entries)), h('td', { class: 'num' }, fmt(p.subscribers)),
          h('td', { class: 'num nowrap', onclick: (e) => e.stopPropagation() },
            p.status !== 'published' && h('button', { class: 'small primary', onclick: () => setStatus(p, 'published') }, '上架'),
            p.status === 'published' && h('button', { class: 'small', onclick: () => setStatus(p, 'archived') }, '下架'),
            p.status === 'draft' && h('button', { class: 'small danger', onclick: () => remove(p) }, '刪除')))))), side));
    const pack = rows.find((p) => p.pack_id === selected);
    if (pack) editPack(pack, side);
  }

  async function editPack(pack, side) {
    const { entries } = await api(`/admin/packs/${pack.pack_id}/entries`);
    const q = h('input', { class: 'grow', placeholder: '找詞條加進來，例：臺北' });
    const found = h('div');
    let timer;
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
    async function search() {
      if (!q.value.trim()) return found.replaceChildren();
      const { results } = await api(`/lexicon?mode=text&q=${encodeURIComponent(q.value.trim())}`);
      const have = new Set(entries.map((e) => e.entry_id));
      found.replaceChildren(h('table', {}, results.slice(0, 10).map((r) => h('tr', {},
        h('td', {}, r.text), h('td', { class: 'bopomofo muted' }, r.bopomofo),
        h('td', { class: 'num' }, have.has(r.entry_id) ? h('span', { class: 'muted' }, '已在包裡')
          : h('button', { class: 'small', onclick: async () => {
            if (await attempt(() => api(`/admin/packs/${pack.pack_id}/entries`, { method: 'POST', body: { entry_id: r.entry_id } }),
              `已加入「${r.text}」`)) packs(pack.pack_id);
          } }, '加入'))))));
    }
    side.replaceChildren(h('div', { class: 'panel stack' },
      h('div', { class: 'row' }, h('span', { class: 'big grow' }, pack.name), h('span', { class: 'chip' }, PACK[pack.status])),
      h('div', { class: 'row' }, q), found,
      h('h2', {}, `內容（${fmt(entries.length)} 個詞條）`),
      entries.length === 0 ? h('div', { class: 'empty' }, '還沒有詞條') : h('table', {}, entries.slice(0, 300).map((e) => h('tr', {},
        h('td', {}, e.text), h('td', { class: 'bopomofo muted' }, e.bopomofo),
        h('td', {}, e.status !== 'active' && h('span', { class: 'chip warn' }, STATUS[e.status])),
        h('td', { class: 'num' }, h('button', { class: 'small ghost', onclick: async () => {
          if (await attempt(() => api(`/admin/packs/${pack.pack_id}/entries/${e.entry_id}`, { method: 'DELETE' }), `已移除「${e.text}」`)) packs(pack.pack_id);
        } }, '移除')))))));
  }

  async function users() {
    const q = h('input', { class: 'grow', placeholder: '依 email 或顯示名稱搜尋；空白顯示投票最多的帳號' });
    const list = h('div');
    let timer;
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
    async function load() {
      const { users: rows } = await api(`/admin/users?q=${encodeURIComponent(q.value.trim())}`);
      list.replaceChildren(h('table', {},
        h('tr', {}, h('th', {}, '帳號'), h('th', {}, '角色'), h('th', {}, '狀態'), h('th', { class: 'num' }, '投票'),
          h('th', { class: 'num' }, '裝置'), h('th', { class: 'num' }, '回報'), h('th', {})),
        rows.map((u) => h('tr', {},
          h('td', {}, h('strong', {}, u.display_name), h('div', { class: 'muted' }, u.email)),
          h('td', {}, u.role === 'editor' ? '編輯' : '使用者'),
          h('td', {}, h('span', { class: `chip ${u.status === 'active' ? 'ok' : 'warn'}` }, USER[u.status])),
          h('td', { class: 'num' }, fmt(u.votes)), h('td', { class: 'num' }, fmt(u.devices)), h('td', { class: 'num' }, fmt(u.reports)),
          h('td', { class: 'num' }, u.user_id !== user.user_id && h('button', {
            class: `small ${u.status === 'active' ? 'danger' : ''}`,
            onclick: async () => {
              const status = u.status === 'active' ? 'suspended' : 'active';
              if (await attempt(() => api(`/admin/users/${u.user_id}/status`, { method: 'POST', body: { status } }),
                status === 'suspended' ? `已停權 ${u.display_name}，他的票不再計入排序` : `已解除 ${u.display_name} 的停權`)) load();
            },
          }, u.status === 'active' ? '停權' : '解除停權'))))));
    }
    body.replaceChildren(h('div', { class: 'panel stack' },
      h('p', { class: 'muted', style: 'margin:0' }, '停權的帳號不能登入、投票與回報，已投的票也不計入待審排序。'),
      h('div', { class: 'row' }, q), list));
    load();
  }

  root.append(h('h1', {}, '管理'), h('p', { class: 'sub' }, '整理主題詞庫包，處理洗票或濫用的帳號。'),
    h('div', { class: 'stack' }, bar, body));
  draw();
}

// ==================== 啟動 ====================

window.addEventListener('hashchange', route);
({ user } = await api('/me'));
route();

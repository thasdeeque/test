// ============================================================
// Dashboard App Script — fetch()-based, talks to the Apps Script
// web app as a JSON API. Fill in WEB_APP_URL below after deploying.
// ============================================================

const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycby-EU4xY05QO26YG1fQuupXdd5qSgfNs9lQFW0fwRKUi8WmYvO9pIXmfCt6RhseVgOiMw/exec'; // <-- paste your deployed Apps Script /exec URL here

// ---- low-level API helpers ----
function apiGet_(action, params) {
  const usp = new URLSearchParams(Object.assign({ action: action }, params || {}));
  return fetch(WEB_APP_URL + '?' + usp.toString())
    .then(r => r.json());
}

// Sent as x-www-form-urlencoded (not JSON) to avoid CORS preflight against
// the Apps Script web app, which does not respond to OPTIONS requests.
function apiPost_(action, params) {
  const body = new URLSearchParams(Object.assign({ action: action }, params || {}));
  return fetch(WEB_APP_URL, { method: 'POST', body: body })
    .then(r => r.json());
}

function apiError_(context, err) {
  console.error(context, err);
  showToast('Connection failed — please try again');
}

if (!WEB_APP_URL) {
  console.warn('WEB_APP_URL is not set. Paste your deployed Apps Script /exec URL into app.js.');
}

// Initialize Lucide icons
if (typeof lucide !== 'undefined') lucide.createIcons();

// ===== APP STATE (populated from the API, no hardcoded data) =====
let DATA = null;              // full bootstrap payload from getAllData()
let lastDataSnapshot = null;  // JSON string of the last DATA we rendered, for change detection
let currentUser = null;       // logged-in username
let currentDeliveryMeal = 'breakfast';
let deliverySubmitted = {};   // { meal: { location: true } } — completed this session
let deliveryUnavailable = {}; // { meal: { location: [names] } } — "not available" this session

const NI = document.querySelectorAll('.nav-item'), P = document.getElementById('pill'), NB = document.getElementById('navBar'),
      SC = document.querySelectorAll('.screen'), T = document.getElementById('toast'),
      CI = document.getElementById('chatInput'), CM = document.getElementById('chatMessages'),
      SB = document.getElementById('sendBtn'), MS = document.getElementById('mainScroll');

// Temp/modal state
let currentStockRow = null;
let currentKitchenInventoryRow = null;   // for generic (non-tiffin/casrol) items
let currentTiffinCasrolKey = null;       // 'tiffin' | 'casrol'
let currentTiffinCasrolLocation = null;
let tempStockAdd = 0;
let tempKitchenValue = 0;
let selectedShoppingItem = null;
let pendingShoppingItem = null, pendingShoppingName = null, pendingShoppingQty = null;
let CL = null, SP = new Set(), UR = {};

// ============================================================
// BOOTSTRAP / LOAD
// ============================================================
function loadAllData() {
  return apiGet_('bootstrap').then(res => {
    if (!res || res.ok === false) throw new Error(res && res.error);
    DATA = res;
    lastDataSnapshot = JSON.stringify(res);
    syncDeliveryStateFromServer_();
    renderEverything();
    return res;
  }).catch(err => { apiError_('bootstrap', err); throw err; });
}

// Used by the background poller: fetches the latest bootstrap data, but
// only touches DATA / re-renders / re-syncs delivery state if the response
// actually differs from what's already on screen. This is what stops the
// periodic check from redoing work (and replaying animations) when nothing
// on the sheet has changed since the last check.
function pollForChanges_() {
  return apiGet_('bootstrap').then(res => {
    if (!res || res.ok === false) return; // fail silently on background poll
    const snapshot = JSON.stringify(res);
    if (snapshot === lastDataSnapshot) return; // nothing changed, skip re-render
    DATA = res;
    lastDataSnapshot = snapshot;
    syncDeliveryStateFromServer_();
    renderEverything();
  }).catch(() => {}); // background poll errors are non-fatal, stay quiet
}

// Pulls today's already-submitted meal+location combos from the server
// (delivery_log sheet) into the local UI state, so a delivery marked done
// on one device shows as done on every other device after its next
// bootstrap — without discarding anything already marked done locally
// this session (e.g. right after a submit, before the next reload).
function syncDeliveryStateFromServer_() {
  const submissions = DATA.deliverySubmissions || {};
  ['breakfast', 'lunch', 'dinner'].forEach(meal => {
    const locs = submissions[meal] || {};
    Object.keys(locs).forEach(locKey => {
      deliverySubmitted[meal] = deliverySubmitted[meal] || {};
      deliverySubmitted[meal][locKey] = true;
      const absent = locs[locKey];
      if (absent && absent.length) {
        deliveryUnavailable[meal] = deliveryUnavailable[meal] || {};
        deliveryUnavailable[meal][locKey] = absent;
      }
    });
  });
}

function renderEverything() {
  renderMenu();
  renderSchedule();
  renderDeliveryScreen();
  renderShoppingGrid();
  renderStockList();
  renderKitchenList();
  uH();
}

// ============================================================
// HOME — Menu card + Schedule ticks, both driven by menu sheet's times
// ============================================================
function parseTimeToMinutes_(t) {
  // Accepts "09:00" or a Date-like time string; returns minutes-since-midnight or null
  if (!t) return null;
  const m = String(t).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function nowMinutes_() {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

// A meal is "current" from 60 minutes before its listed time, until 60
// minutes before the next meal's time (dinner wraps around past midnight
// to breakfast the next day).
function getCurrentMeal_() {
  if (!DATA || !DATA.menu || !DATA.menu.times) return 'breakfast';
  const times = DATA.menu.times;
  const b = parseTimeToMinutes_(times.breakfast);
  const l = parseTimeToMinutes_(times.lunch);
  const d = parseTimeToMinutes_(times.dinner);
  if (b === null || l === null || d === null) return 'breakfast';
  const now = nowMinutes_();
  const bStart = ((b - 60) % 1440 + 1440) % 1440;
  const lStart = ((l - 60) % 1440 + 1440) % 1440;
  const dStart = ((d - 60) % 1440 + 1440) % 1440;
  // Determine which window [start, nextStart) contains `now`
  const windows = [
    { meal: 'breakfast', start: bStart },
    { meal: 'lunch', start: lStart },
    { meal: 'dinner', start: dStart }
  ].sort((a, b2) => a.start - b2.start);
  for (let i = windows.length - 1; i >= 0; i--) {
    if (now >= windows[i].start) return windows[i].meal;
  }
  // now is before the earliest window start today -> we're still in the last window from yesterday
  return windows[windows.length - 1].meal;
}

function renderMenu() {
  if (!DATA || !DATA.menu) return;
  const meal = getCurrentMeal_();
  const items = DATA.menu[meal] || [];
  const title = document.getElementById('menuCardTitle');
  if (title) title.textContent = 'Menu — ' + meal.charAt(0).toUpperCase() + meal.slice(1);
  const list = document.getElementById('menuList');
  if (list) {
    list.innerHTML = items.map(it =>
      '<div class="menu-item"><span class="menu-dot"></span>' + escapeHtml_(it) + '</div>'
    ).join('') || '<div class="menu-item"><span class="menu-dot"></span>No items listed</div>';
  }
}

function renderSchedule() {
  if (!DATA || !DATA.menu || !DATA.menu.times) return;
  const times = DATA.menu.times;
  const now = nowMinutes_();
  ['breakfast', 'lunch', 'dinner'].forEach(meal => {
    const t = parseTimeToMinutes_(times[meal]);
    const el = document.getElementById('tick-' + meal);
    if (!el || t === null) return;
    const done = now >= t;
    el.classList.toggle('done', done);
    el.classList.toggle('pending', !done);
    el.innerHTML = done
      ? '<i data-lucide="check" style="width:12px;height:12px;"></i>'
      : '<i data-lucide="x" style="width:12px;height:12px;"></i>';
  });
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function escapeHtml_(t) {
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

// ============================================================
// DELIVERY SCREEN — meal tabs + dynamic location cards from the sheet
// ============================================================
function switchDeliveryMeal(meal) {
  currentDeliveryMeal = meal;
  document.querySelectorAll('.meal-tab').forEach(t => t.classList.toggle('active', t.dataset.meal === meal));
  renderDeliveryScreen();
}

function renderDeliveryScreen() {
  if (!DATA || !DATA.delivery) return;
  const grid = document.getElementById('deliveryGrid');
  const empty = document.getElementById('deliveryEmpty');
  if (!grid) return;
  const mealData = DATA.delivery[currentDeliveryMeal] || {};
  const locKeys = Object.keys(mealData);

  grid.innerHTML = '';
  let allDone = true;

  locKeys.forEach((locKey, i) => {
    const loc = mealData[locKey];
    const submitted = !!(deliverySubmitted[currentDeliveryMeal] && deliverySubmitted[currentDeliveryMeal][locKey]);
    const unavailable = (deliveryUnavailable[currentDeliveryMeal] && deliveryUnavailable[currentDeliveryMeal][locKey]) || [];
    if (!submitted) allDone = false;
    // Already-submitted locations are simply not rendered at all — this
    // avoids replaying the "removing" fade-out animation from scratch on
    // every periodic refresh, which looked like the card flashing back in.
    if (submitted) return;

    const card = document.createElement('div');
    card.className = 'delivery-card' + (unavailable.length ? ' unavailable-state' : '');
    card.onclick = () => openDeliveryModal(locKey);
    card.innerHTML = `
      <div class="delivery-card-content">
        <div class="delivery-card-number">${String(i + 1).padStart(2, '0')}</div>
        <div class="delivery-card-name">${escapeHtml_(loc.name)}</div>
        <div class="delivery-card-stats">
          <span class="delivery-stat veg-stat"><span class="stat-dot veg-dot"></span>${loc.veg} Veg</span>
          <span class="delivery-stat nonveg-stat"><span class="stat-dot nonveg-dot"></span>${loc.nonveg} Non-Veg</span>
        </div>
        <div class="delivery-card-total">${loc.people.length} People</div>
        <div class="delivery-unavailable-text" style="${unavailable.length ? 'display:flex' : 'display:none'}">
          <i data-lucide="alert-circle" style="width:14px;height:14px"></i>
          <span>${unavailable.join(', ')}${unavailable.length > 1 ? ' are not available' : ' is not available'}</span>
        </div>
        <div class="delivery-card-arrow"><i data-lucide="chevron-right" style="width:18px;height:18px"></i></div>
      </div>
    `;
    grid.appendChild(card);
  });

  if (empty) empty.style.display = (allDone && locKeys.length > 0) ? 'flex' : 'none';
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function openDeliveryModal(locKey) {
  const mealData = DATA.delivery[currentDeliveryMeal] || {};
  const loc = mealData[locKey];
  if (!loc) return;
  CL = locKey; SP = new Set(); UR = {};

  document.getElementById('modalTitle').textContent = loc.name + ' — ' + currentDeliveryMeal.charAt(0).toUpperCase() + currentDeliveryMeal.slice(1);
  document.getElementById('modalSubtitle').textContent = loc.people.length + ' people';
  const l = document.getElementById('modalPeopleList');
  l.innerHTML = '';
  const veg = loc.people.filter(p => p[1]);
  const nonveg = loc.people.filter(p => !p[1]);
  if (veg.length) {
    const h = document.createElement('div');
    h.className = 'person-section-header';
    h.innerHTML = '<span>Veg</span><div class="person-section-line"></div><span>' + veg.length + '</span>';
    l.appendChild(h);
    veg.forEach(p => l.appendChild(personRow_(p)));
  }
  if (nonveg.length) {
    const h = document.createElement('div');
    h.className = 'person-section-header';
    h.innerHTML = '<span>Non-Veg</span><div class="person-section-line"></div><span>' + nonveg.length + '</span>';
    l.appendChild(h);
    nonveg.forEach(p => l.appendChild(personRow_(p)));
  }
  updateSelectAll_();
  updateSelectedCount_();
  const o = document.getElementById('deliveryModalOverlay');
  o.classList.add('active');
  document.body.style.overflow = 'hidden';
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [o] });
}

function personRow_(p) {
  const r = document.createElement('div');
  r.className = 'person-row';
  r.dataset.pid = p[0];
  r.onclick = () => togglePerson_(p[0]);
  const cb = document.createElement('div');
  cb.className = 'person-checkbox';
  cb.id = 'cb-' + p[0];
  cb.innerHTML = '<i data-lucide="check" style="width:12px;height:12px;"></i>';
  if (SP.has(p[0])) cb.classList.add('checked');
  const n = document.createElement('div');
  n.className = 'person-name';
  n.textContent = p[0];
  const b = document.createElement('div');
  b.className = 'person-badge ' + (p[1] ? 'veg' : 'nonveg');
  b.textContent = p[1] ? 'Veg' : 'Non-Veg';
  r.appendChild(cb); r.appendChild(n); r.appendChild(b);
  return r;
}

function togglePerson_(n) {
  const cb = document.getElementById('cb-' + n);
  if (SP.has(n)) { SP.delete(n); cb.classList.remove('checked'); }
  else { SP.add(n); cb.classList.add('checked'); }
  updateSelectAll_(); updateSelectedCount_();
}

function tSA() {
  const loc = DATA.delivery[currentDeliveryMeal][CL];
  const all = loc.people.map(x => x[0]);
  if (SP.size === all.length) {
    SP.clear();
    all.forEach(n => document.getElementById('cb-' + n).classList.remove('checked'));
  } else {
    all.forEach(n => { SP.add(n); document.getElementById('cb-' + n).classList.add('checked'); });
  }
  updateSelectAll_(); updateSelectedCount_();
}

function updateSelectAll_() {
  const loc = DATA.delivery[currentDeliveryMeal][CL];
  const total = loc.people.length;
  const cb = document.getElementById('selectAllCheckbox'), tx = document.getElementById('selectAllText');
  if (SP.size === total && total > 0) { cb.classList.add('checked'); if (tx) tx.textContent = 'Deselect All'; }
  else { cb.classList.remove('checked'); if (tx) tx.textContent = 'Select All'; }
}

function updateSelectedCount_() {
  const loc = DATA.delivery[currentDeliveryMeal][CL];
  document.getElementById('modalSelectedCount').textContent = SP.size + ' of ' + loc.people.length + ' selected';
  document.getElementById('modalSubmitBtn').disabled = SP.size === 0;
}

function cM(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('deliveryModalOverlay').classList.remove('active');
  document.body.style.overflow = '';
  CL = null; SP = new Set();
}

function sD() {
  const loc = DATA.delivery[currentDeliveryMeal][CL];
  const all = loc.people.map(x => x[0]);
  const unselected = all.filter(n => !SP.has(n));
  if (unselected.length === 0) {
    finalizeDelivery_(CL, Array.from(SP), []);
  } else {
    openUnselectedModal_(unselected);
  }
}

function openUnselectedModal_(unselected) {
  const o = document.getElementById('unselectedModalOverlay'), l = document.getElementById('unselectedPeopleList'), de = document.getElementById('unselectedDesc');
  de.textContent = unselected.length + ' person' + (unselected.length > 1 ? 's were' : ' was') + ' not selected.';
  l.innerHTML = ''; UR = {};
  unselected.forEach(n => {
    const r = document.createElement('div');
    r.className = 'unselected-person-row';
    const ne = document.createElement('div');
    ne.className = 'unselected-person-name';
    ne.textContent = n;
    const op = document.createElement('div');
    op.className = 'unselected-person-options';
    const b1 = document.createElement('button');
    b1.className = 'option-btn'; b1.textContent = 'Not available';
    const b2 = document.createElement('button');
    b2.className = 'option-btn'; b2.textContent = 'Accident';
    b1.onclick = () => setUnselectedReason_(n, 'na', b1, b2);
    b2.onclick = () => setUnselectedReason_(n, 'ac', b2, b1);
    op.appendChild(b1); op.appendChild(b2);
    r.appendChild(ne); r.appendChild(op); l.appendChild(r);
  });
  o.classList.add('active');
}

function setUnselectedReason_(n, reason, selBtn, otherBtn) {
  UR[n] = reason;
  selBtn.classList.add('selected');
  otherBtn.classList.remove('selected');
}

function cUM(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('unselectedModalOverlay').classList.remove('active');
}

function cUS() {
  const loc = DATA.delivery[currentDeliveryMeal][CL];
  const all = loc.people.map(x => x[0]);
  const unselected = all.filter(n => !SP.has(n));
  const missingReason = unselected.filter(n => !UR[n]);
  if (missingReason.length > 0) { showToast('Please select a reason for all unselected people'); return; }
  const notAvailable = unselected.filter(n => UR[n] === 'na');
  const accident = unselected.filter(n => UR[n] === 'ac');
  const deliveredTo = [...Array.from(SP), ...accident];
  document.getElementById('unselectedModalOverlay').classList.remove('active');
  finalizeDelivery_(CL, deliveredTo, notAvailable);
}

// Records the delivery locally (for this session's UI state) and tells the
// backend which people were "not available" so it can log absence.
// "Accident" people are treated as delivered and are never sent as absent.
function finalizeDelivery_(locKey, deliveredNames, notAvailableNames) {
  deliverySubmitted[currentDeliveryMeal] = deliverySubmitted[currentDeliveryMeal] || {};
  deliverySubmitted[currentDeliveryMeal][locKey] = true;
  if (notAvailableNames.length) {
    deliveryUnavailable[currentDeliveryMeal] = deliveryUnavailable[currentDeliveryMeal] || {};
    deliveryUnavailable[currentDeliveryMeal][locKey] = notAvailableNames;
  }
  cM();
  const locName = DATA.delivery[currentDeliveryMeal][locKey].name;
  showToast('Delivery completed for ' + locName + '!');
  renderDeliveryScreen();
  uH();

  apiPost_('submitDelivery', {
    data: JSON.stringify({ meal: currentDeliveryMeal, location: locKey, absentNames: notAvailableNames })
  }).catch(err => apiError_('submitDelivery', err));
}

// ============================================================
// HOME — veg/non-veg summary across all locations for the current meal
// ============================================================
function uH() {
  if (!DATA || !DATA.delivery) return;
  const mealData = DATA.delivery[currentDeliveryMeal] || {};
  let totalVeg = 0, totalNonveg = 0, remainingVeg = 0, remainingNonveg = 0, unavailableList = [];

  Object.entries(mealData).forEach(([locKey, loc]) => {
    totalVeg += loc.veg; totalNonveg += loc.nonveg;
    const submitted = deliverySubmitted[currentDeliveryMeal] && deliverySubmitted[currentDeliveryMeal][locKey];
    const una = (deliveryUnavailable[currentDeliveryMeal] && deliveryUnavailable[currentDeliveryMeal][locKey]) || [];
    if (!submitted) { remainingVeg += loc.veg; remainingNonveg += loc.nonveg; }
    una.forEach(n => {
      const p = loc.people.find(x => x[0] === n);
      unavailableList.push({ name: n, loc: loc.name, veg: p ? p[1] : null });
    });
  });

  const vE = document.getElementById('vegCount'), nE = document.getElementById('nonvegCount'),
        vP = document.getElementById('vegPercent'), nP = document.getElementById('nonvegPercent'),
        sV = document.getElementById('stackedVeg'), sN = document.getElementById('stackedNonveg'),
        sB = document.getElementById('statusBadge');
  if (vE) vE.textContent = remainingVeg;
  if (nE) nE.textContent = remainingNonveg;
  const total = remainingVeg + remainingNonveg;
  if (total > 0) {
    const vp = Math.round(remainingVeg / total * 100), np = Math.round(remainingNonveg / total * 100);
    if (vP) vP.textContent = vp + '%'; if (nP) nP.textContent = np + '%';
    if (sV) sV.style.width = vp + '%'; if (sN) sN.style.width = np + '%';
  } else {
    if (vP) vP.textContent = '0%'; if (nP) nP.textContent = '0%';
    if (sV) sV.style.width = '0%'; if (sN) sN.style.width = '0%';
  }
  if (sB) {
    if (total === 0) { sB.textContent = 'Complete'; sB.style.background = 'rgba(52,199,89,.15)'; sB.style.color = '#34c759'; }
    else { sB.textContent = 'On Track'; sB.style.background = 'var(--accent-warm-light)'; sB.style.color = 'var(--accent-warm)'; }
  }
  const b = document.getElementById('unavailableBanner'), bl = document.getElementById('unavailableBannerList');
  if (unavailableList.length > 0 && b) {
    b.classList.add('show');
    if (bl) bl.innerHTML = unavailableList.map(x => x.name + ' (' + x.loc + ') - ' + (x.veg ? 'Veg' : 'Non-Veg')).join('<br>');
  } else if (b) b.classList.remove('show');
}

// ============================================================
// SHOP — navigation between sub-panels
// ============================================================
function openShopSub(subId) {
  const sub = document.getElementById('shop-' + subId);
  const scrollEl = document.getElementById('mainScroll');
  if (scrollEl) scrollEl.scrollTop = 0;
  document.querySelectorAll('.shop-panels > .shop-sub-screen, .shop-panels > #shop-main').forEach(s => s.classList.remove('active'));
  if (sub) {
    sub.classList.add('active');
    if (subId === 'stock') renderStockList();
    if (subId === 'kitchen-items') renderKitchenList();
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function backToShop() {
  const main = document.getElementById('shop-main');
  const scrollEl = document.getElementById('mainScroll');
  if (scrollEl) scrollEl.scrollTop = 0;
  document.querySelectorAll('.shop-panels > .shop-sub-screen, .shop-panels > #shop-main').forEach(s => s.classList.remove('active'));
  main.classList.add('active');
  const shopGrid = main.querySelector('.shop-grid');
  if (shopGrid) { shopGrid.style.display = 'grid'; shopGrid.style.opacity = '1'; shopGrid.style.visibility = 'visible'; }
  main.querySelectorAll('.shop-card').forEach(card => { card.style.display = 'block'; card.style.opacity = '1'; card.style.visibility = 'visible'; });
  void main.offsetWidth;
  document.querySelectorAll('.shopping-card').forEach(c => c.classList.remove('selected'));
  const otherInput = document.getElementById('shoppingOtherInput');
  if (otherInput) { otherInput.classList.remove('show'); otherInput.value = ''; }
  document.getElementById('shoppingConfirmBtn').disabled = true;
  selectedShoppingItem = null;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ============================================================
// MY SHOPPING — item cards come from the sheet's header row
// ============================================================
function renderShoppingGrid() {
  if (!DATA || !DATA.shopping) return;
  const grid = document.getElementById('shoppingGrid');
  if (!grid) return;
  grid.innerHTML = '';
  DATA.shopping.items.forEach(name => {
    const card = document.createElement('div');
    card.className = 'shopping-card';
    card.dataset.item = name;
    card.onclick = () => selectShoppingCard(card);
    card.innerHTML = `
      <div class="shopping-card-icon"><i data-lucide="shopping-bag" style="width:20px;height:20px"></i></div>
      <div class="shopping-card-name">${escapeHtml_(name)}</div>
    `;
    grid.appendChild(card);
  });
  const other = document.createElement('div');
  other.className = 'shopping-card';
  other.dataset.item = 'Other';
  other.onclick = () => selectShoppingOtherCard(other);
  other.innerHTML = `
    <div class="shopping-card-icon"><i data-lucide="plus" style="width:20px;height:20px"></i></div>
    <div class="shopping-card-name">Other</div>
  `;
  grid.appendChild(other);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function selectShoppingCard(el) {
  document.querySelectorAll('.shopping-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('shoppingOtherInput').classList.remove('show');
  selectedShoppingItem = el.dataset.item;
  document.getElementById('shoppingConfirmBtn').disabled = false;
}

function selectShoppingOtherCard(el) {
  document.querySelectorAll('.shopping-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  const input = document.getElementById('shoppingOtherInput');
  input.classList.add('show');
  setTimeout(() => input.focus(), 100);
  selectedShoppingItem = 'Other';
  document.getElementById('shoppingConfirmBtn').disabled = false;
}

function submitShoppingOrder() {
  if (!selectedShoppingItem) return;
  let itemName = selectedShoppingItem;
  if (selectedShoppingItem === 'Other') {
    const val = document.getElementById('shoppingOtherInput').value.trim();
    if (!val) { showToast('Please type what you want to order'); return; }
    itemName = val;
  }
  pendingShoppingItem = itemName;
  document.getElementById('shoppingDetailsSubtitle').textContent = itemName;
  document.getElementById('shoppingNameInput').value = '';
  document.getElementById('shoppingQtyInput').value = '';
  document.getElementById('shoppingDetailsBtn').disabled = true;
  document.getElementById('shoppingDetailsModalOverlay').classList.add('active');
}

function closeShoppingDetailsModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('shoppingDetailsModalOverlay').classList.remove('active');
}

function validateShoppingDetails() {
  const name = document.getElementById('shoppingNameInput').value.trim();
  const qty = document.getElementById('shoppingQtyInput').value.trim();
  document.getElementById('shoppingDetailsBtn').disabled = !(name && qty && Number(qty) > 0);
}

function openShoppingConfirmModal() {
  const name = document.getElementById('shoppingNameInput').value.trim();
  const qty = document.getElementById('shoppingQtyInput').value.trim();
  if (!name || !qty || Number(qty) <= 0) return;
  pendingShoppingName = name;
  pendingShoppingQty = qty;
  document.getElementById('shoppingConfirmSummary').innerHTML =
    'You are <b>' + escapeHtml_(name) + '</b>, ordering <b>' + escapeHtml_(qty) + 'x</b> <b>' + escapeHtml_(pendingShoppingItem) + '</b>. Are you sure you want to purchase this item?';
  document.getElementById('shoppingConfirmModalOverlay').classList.add('active');
}

function cancelShoppingOrder(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('shoppingConfirmModalOverlay').classList.remove('active');
}

function finalizeShoppingOrder() {
  document.getElementById('shoppingConfirmModalOverlay').classList.remove('active');
  document.getElementById('shoppingDetailsModalOverlay').classList.remove('active');
  showToast(pendingShoppingName + ', your order of ' + pendingShoppingQty + ' x ' + pendingShoppingItem + ' has been placed');

  apiPost_('addShoppingOrder', {
    itemName: pendingShoppingItem,
    personName: pendingShoppingName,
    qty: pendingShoppingQty
  }).then(() => loadAllData()).catch(err => apiError_('addShoppingOrder', err));

  document.querySelectorAll('.shopping-card').forEach(c => c.classList.remove('selected'));
  const otherInput = document.getElementById('shoppingOtherInput');
  if (otherInput) { otherInput.classList.remove('show'); otherInput.value = ''; }
  document.getElementById('shoppingConfirmBtn').disabled = true;
  selectedShoppingItem = null; pendingShoppingItem = null; pendingShoppingName = null; pendingShoppingQty = null;
}

// ============================================================
// STOCK — quantity (in stock) + needed, both editable; "add" tops up
// quantity and reduces needed by the same amount (floored at 0)
// ============================================================
function renderStockList() {
  if (!DATA || !DATA.stock) return;
  const list = document.getElementById('stockList');
  if (!list) return;
  list.innerHTML = '';
  DATA.stock.forEach(item => {
    const row = document.createElement('div');
    row.className = 'stock-item';
    row.onclick = () => openStockModal(item.row);
    row.innerHTML = `
      <div class="stock-item-left">
        <div class="stock-item-icon"><i data-lucide="list-checks" style="width:20px;height:20px"></i></div>
        <div class="stock-item-name">${escapeHtml_(item.name)}</div>
      </div>
      <div class="stock-item-kg">${item.quantity.toFixed(1)}<span>${escapeHtml_(item.unit)}</span></div>
    `;
    list.appendChild(row);
  });
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function findStockByRow_(row) {
  return DATA.stock.find(s => s.row === row);
}

function openStockModal(row) {
  currentStockRow = row;
  const item = findStockByRow_(row);
  tempStockAdd = 0;
  document.getElementById('stockDetailName').textContent = item.name;
  document.getElementById('stockDetailCurrent').textContent = item.quantity.toFixed(1) + ' ' + item.unit;
  document.getElementById('stockDetailNeeded').textContent = item.needed.toFixed(1) + ' ' + item.unit;
  document.getElementById('stockAddValue').value = '0.0';
  document.getElementById('stockAddLabel').textContent = 'Add to stock (' + item.unit + ')';
  const overlay = document.getElementById('stockModalOverlay');
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [overlay] });
}

function closeStockModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('stockModalOverlay').classList.remove('active');
  document.body.style.overflow = '';
  currentStockRow = null;
}

function adjustStockAdd(delta) {
  tempStockAdd = Math.max(0, tempStockAdd + delta);
  document.getElementById('stockAddValue').value = tempStockAdd.toFixed(1);
}

function validateStockAddInput() {
  const input = document.getElementById('stockAddValue');
  let val = parseFloat(input.value);
  if (isNaN(val) || val < 0) val = 0;
  tempStockAdd = val;
  input.value = tempStockAdd.toFixed(1);
}

function saveStock() {
  if (!currentStockRow) return;
  const item = findStockByRow_(currentStockRow);
  const newQuantity = item.quantity + tempStockAdd;
  const newNeeded = Math.max(0, item.needed - tempStockAdd);
  item.quantity = newQuantity;
  item.needed = newNeeded;
  showToast(item.name + ' updated: ' + newQuantity.toFixed(1) + ' in stock, ' + newNeeded.toFixed(1) + ' needed');
  renderStockList();
  closeStockModal();

  apiPost_('saveStock', {
    data: JSON.stringify([{ row: currentStockRow, quantity: newQuantity, needed: newNeeded }])
  }).catch(err => apiError_('saveStock', err));
}

// ============================================================
// KITCHEN ITEMS — generic items from `kitchen inventory` sheet, plus
// Tiffin/Casrol expanded per-location from `delivery location` sheet.
// Generic items render with the "list-collapse" icon; tiffin/casrol
// are grouped below with a divider, one row per container type that
// expands into a location list.
// ============================================================
function renderKitchenList() {
  if (!DATA) return;
  const list = document.getElementById('kitchenList');
  if (!list) return;
  list.innerHTML = '';

  (DATA.kitchenInventory || []).forEach(item => {
    const row = document.createElement('div');
    row.className = 'kitchen-item';
    row.onclick = () => openKitchenInventoryModal(item.row);
    row.innerHTML = `
      <div class="kitchen-item-left">
        <div class="kitchen-item-icon"><i data-lucide="list-collapse" style="width:20px;height:20px"></i></div>
        <div class="kitchen-item-name">${escapeHtml_(item.name)}</div>
      </div>
      <div class="kitchen-item-counts">
        <div class="kitchen-count-pill instock">${item.inKitchen} In</div>
        <div class="kitchen-count-pill inuse">${item.outKitchen} Out</div>
      </div>
    `;
    list.appendChild(row);
  });

  const table = DATA.deliveryLocationTable || { locations: [], containers: {} };
  ['tiffin', 'casrol'].forEach((key, idx) => {
    let totalIn = 0, totalOut = 0;
    table.locations.forEach(loc => {
      const c = table.containers[loc] && table.containers[loc][key];
      if (c) { totalIn += c.inCount; totalOut += c.outCount; }
    });
    const row = document.createElement('div');
    row.className = 'kitchen-item location-tracked';
    if (idx > 0) row.classList.remove('location-tracked'); // divider only once, before the first of the pair
    row.onclick = () => openTiffinCasrolLocationList(key);
    row.innerHTML = `
      <div class="kitchen-item-left">
        <div class="kitchen-item-icon"><i data-lucide="${key === 'tiffin' ? 'rows-3' : 'cooking-pot'}" style="width:20px;height:20px"></i></div>
        <div class="kitchen-item-name">${key === 'tiffin' ? 'Tiffin' : 'Casrol'}</div>
      </div>
      <div class="kitchen-item-counts">
        <div class="kitchen-count-pill instock">${totalIn} In</div>
        <div class="kitchen-count-pill inuse">${totalOut} Out</div>
      </div>
    `;
    list.appendChild(row);
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// --- Generic kitchen inventory items (spoon/fork/plate/tray/...) ---
function findKitchenInventoryByRow_(row) {
  return DATA.kitchenInventory.find(i => i.row === row);
}

function openKitchenInventoryModal(row) {
  currentKitchenInventoryRow = row;
  currentTiffinCasrolKey = null;
  const item = findKitchenInventoryByRow_(row);
  tempKitchenValue = item.outKitchen;

  document.getElementById('kitchenDetailName').textContent = item.name;
  document.getElementById('kitchenDetailIcon').innerHTML = '<i data-lucide="list-collapse" style="width:28px;height:28px"></i>';
  document.querySelector('#kitchenModal .kitchen-single-labels').style.display = '';
  document.getElementById('kitchenSublabel').textContent = 'Out of Kitchen';
  document.getElementById('kitchenDetailTotalRow').innerHTML = 'Total: <span>' + item.total + '</span>';
  updateKitchenModalDisplay();

  const overlay = document.getElementById('kitchenModalOverlay');
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [overlay] });
}

function updateKitchenModalDisplay() {
  const maxVal = currentTiffinCasrolKey ? getTiffinCasrolMax_() : findKitchenInventoryByRow_(currentKitchenInventoryRow).total;
  document.getElementById('kitchenSingleValue').value = tempKitchenValue;
  document.getElementById('kitchenOutBtn').disabled = tempKitchenValue <= 0;
  document.getElementById('kitchenInBtn').disabled = tempKitchenValue >= maxVal;
}

function adjustKitchen(delta) {
  const maxVal = currentTiffinCasrolKey ? getTiffinCasrolMax_() : findKitchenInventoryByRow_(currentKitchenInventoryRow).total;
  tempKitchenValue = Math.max(0, Math.min(maxVal, tempKitchenValue + delta));
  updateKitchenModalDisplay();
}

function validateKitchenInput() {
  const input = document.getElementById('kitchenSingleValue');
  let val = parseInt(input.value, 10);
  const maxVal = currentTiffinCasrolKey ? getTiffinCasrolMax_() : findKitchenInventoryByRow_(currentKitchenInventoryRow).total;
  if (isNaN(val) || val < 0) val = 0;
  if (val > maxVal) val = maxVal;
  tempKitchenValue = val;
  updateKitchenModalDisplay();
}

function saveKitchen() {
  if (currentTiffinCasrolKey) {
    saveTiffinCasrol_();
    return;
  }
  if (!currentKitchenInventoryRow) return;
  const item = findKitchenInventoryByRow_(currentKitchenInventoryRow);
  item.outKitchen = tempKitchenValue;
  item.inKitchen = item.total - tempKitchenValue;
  showToast(item.name + ' updated: ' + item.inKitchen + ' In, ' + item.outKitchen + ' Out');
  renderKitchenList();
  closeKitchenModal();

  apiPost_('saveKitchenInventory', {
    data: JSON.stringify([{ row: item.row, inKitchen: item.inKitchen, outKitchen: item.outKitchen, total: item.total }])
  }).catch(err => apiError_('saveKitchenInventory', err));
}

function closeKitchenModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('kitchenModalOverlay').classList.remove('active');
  document.body.style.overflow = '';
  currentKitchenInventoryRow = null;
  currentTiffinCasrolKey = null;
  currentTiffinCasrolLocation = null;
}

// --- Tiffin/Casrol, per-location (from `delivery location` sheet) ---
function openTiffinCasrolLocationList(key) {
  currentTiffinCasrolKey = key;
  const table = DATA.deliveryLocationTable;
  document.getElementById('kitchenLocationListTitle').textContent = (key === 'tiffin' ? 'Tiffin' : 'Casrol') + ' Locations';

  let totalIn = 0, totalOut = 0;
  table.locations.forEach(loc => {
    const c = table.containers[loc] && table.containers[loc][key];
    if (c) { totalIn += c.inCount; totalOut += c.outCount; }
  });
  document.getElementById('kitchenLocationListTotal').textContent = totalOut + ' out, ' + totalIn + ' in';

  const list = document.getElementById('kitchenLocationList');
  list.innerHTML = '';
  table.locations.forEach(loc => {
    const c = table.containers[loc] && table.containers[loc][key];
    if (!c) return;
    const row = document.createElement('div');
    row.className = 'kitchen-item';
    row.onclick = () => { closeKitchenLocationListModal(); openTiffinCasrolModal(key, loc); };
    row.innerHTML = `
      <div class="kitchen-item-left">
        <div class="kitchen-item-icon"><i data-lucide="map-pin" style="width:20px;height:20px"></i></div>
        <div class="kitchen-item-name">${escapeHtml_(loc)}</div>
      </div>
      <div class="kitchen-item-counts">
        <div class="kitchen-count-pill instock">${c.inCount} In</div>
        <div class="kitchen-count-pill inuse">${c.outCount} Out</div>
      </div>
    `;
    list.appendChild(row);
  });

  const overlay = document.getElementById('kitchenLocationListModalOverlay');
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [overlay] });
}

function closeKitchenLocationListModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('kitchenLocationListModalOverlay').classList.remove('active');
  document.body.style.overflow = '';
}

function getTiffinCasrolMax_() {
  // "out" (with the location) can be adjusted up to in+out for that
  // location (i.e. moving between "with location" and "in kitchen" for
  // that specific location's allotment).
  const c = DATA.deliveryLocationTable.containers[currentTiffinCasrolLocation][currentTiffinCasrolKey];
  return c.inCount + c.outCount;
}

function openTiffinCasrolModal(key, location) {
  currentTiffinCasrolKey = key;
  currentTiffinCasrolLocation = location;
  currentKitchenInventoryRow = null;
  const c = DATA.deliveryLocationTable.containers[location][key];
  tempKitchenValue = c.outCount;

  document.getElementById('kitchenDetailName').textContent = (key === 'tiffin' ? 'Tiffin' : 'Casrol') + ' — ' + location;
  document.getElementById('kitchenDetailIcon').innerHTML = '<i data-lucide="' + (key === 'tiffin' ? 'rows-3' : 'cooking-pot') + '" style="width:28px;height:28px"></i>';
  document.querySelector('#kitchenModal .kitchen-single-labels').style.display = 'none';
  document.getElementById('kitchenSublabel').textContent = key === 'tiffin' ? 'Tiffins here' : 'Casrols here';
  document.getElementById('kitchenDetailTotalRow').innerHTML = 'Total for ' + escapeHtml_(location) + ': <span>' + (c.inCount + c.outCount) + '</span>';
  updateKitchenModalDisplay();

  const overlay = document.getElementById('kitchenModalOverlay');
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [overlay] });
}

function saveTiffinCasrol_() {
  const c = DATA.deliveryLocationTable.containers[currentTiffinCasrolLocation][currentTiffinCasrolKey];
  const total = c.inCount + c.outCount;
  c.outCount = tempKitchenValue;
  c.inCount = total - tempKitchenValue;
  showToast((currentTiffinCasrolKey === 'tiffin' ? 'Tiffin' : 'Casrol') + ' updated for ' + currentTiffinCasrolLocation + ': ' + c.outCount + ' out, ' + c.inCount + ' in');
  renderKitchenList();
  closeKitchenModal();

  Promise.all([
    apiPost_('saveDeliveryLocationCount', { location: currentTiffinCasrolLocation, container: currentTiffinCasrolKey, field: 'in', value: c.inCount }),
    apiPost_('saveDeliveryLocationCount', { location: currentTiffinCasrolLocation, container: currentTiffinCasrolKey, field: 'out', value: c.outCount })
  ]).then(() => {
    openTiffinCasrolLocationList(currentTiffinCasrolKey);
  }).catch(err => apiError_('saveDeliveryLocationCount', err));
}

// ============================================================
// LOGIN — create-on-first-use, plaintext check thereafter
// ============================================================
function togglePassword() {
  const input = document.getElementById('passwordDirect');
  const eyeOn = document.getElementById('eyeIcon');
  const eyeOff = document.getElementById('eyeOffIcon');
  if (input.type === 'password') { input.type = 'text'; eyeOn.style.display = 'none'; eyeOff.style.display = 'block'; }
  else { input.type = 'password'; eyeOn.style.display = 'block'; eyeOff.style.display = 'none'; }
}

function handleLoginDirect(event) {
  event.preventDefault();
  const username = document.getElementById('usernameDirect').value.trim();
  const password = document.getElementById('passwordDirect').value;
  if (!username || !password) { showToast('Enter a username and password'); return; }

  const overlay = document.getElementById('loginOverlay');
  const loader = document.getElementById('loadingScreen');
  const bar = document.getElementById('loadingBar');
  const loadText = document.getElementById('loadingText');

  loader.style.display = 'flex';
  setTimeout(() => { loader.style.opacity = '1'; }, 10);
  loadText.textContent = 'Authenticating...';
  bar.style.width = '20%';

  apiPost_('login', { username: username, password: password }).then(res => {
    if (!res || res.ok === false) {
      loader.style.opacity = '0';
      setTimeout(() => { loader.style.display = 'none'; }, 300);
      showToast((res && res.error) || 'Login failed');
      return;
    }
    currentUser = username;
    bar.style.width = '55%'; loadText.textContent = 'Loading data...';

    overlay.style.transition = 'opacity 0.25s ease';
    overlay.style.opacity = '0';
    overlay.style.pointerEvents = 'none';
    setTimeout(() => overlay.classList.add('hidden'), 250);

    loadAllData().then(() => {
      bar.style.width = '100%'; loadText.textContent = 'Welcome!';
      setTimeout(() => {
        loader.style.transition = 'opacity 0.4s ease';
        loader.style.opacity = '0';
        setTimeout(() => { loader.style.display = 'none'; }, 400);
      }, 500);
    }).catch(() => {
      loader.style.opacity = '0';
      setTimeout(() => { loader.style.display = 'none'; }, 300);
    });
  }).catch(err => {
    loader.style.opacity = '0';
    setTimeout(() => { loader.style.display = 'none'; }, 300);
    apiError_('login', err);
  });
}

// ============================================================
// NAVIGATION
// ============================================================
function uPP() {
  const ai = document.querySelector('.nav-item.active');
  if (ai) {
    const cr = NB.getBoundingClientRect(), ar = ai.getBoundingClientRect();
    P.style.left = (ar.left - cr.left) + 'px';
    P.style.width = ar.width + 'px';
  }
}

function sT(tn) {
  SC.forEach(s => s.classList.remove('active'));
  const t = document.getElementById('screen-' + tn);
  if (t) t.classList.add('active');
  if (tn !== 'shop') {
    document.querySelectorAll('.shop-panels > .shop-sub-screen, .shop-panels > #shop-main').forEach(s => s.classList.remove('active'));
    const main = document.getElementById('shop-main');
    if (main) main.classList.add('active');
  }
  if (tn === 'ai') { setTimeout(() => { MS.scrollTo({ top: MS.scrollHeight, behavior: 'smooth' }); CI.focus(); }, 100); }
  else MS.scrollTo({ top: 0, behavior: 'smooth' });
}

NI.forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    if (item.classList.contains('active')) return;
    NI.forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    sT(item.getAttribute('data-tab'));
    let st = performance.now();
    function ap(t) { uPP(); if (t - st < 400) requestAnimationFrame(ap); }
    requestAnimationFrame(ap);
  });
});

function showToast(m) {
  T.textContent = m; T.style.opacity = '1'; T.style.transform = 'translateX(-50%) translateY(0)';
  setTimeout(() => { T.style.opacity = '0'; T.style.transform = 'translateX(-50%) translateY(-60px)'; }, 2500);
}

// ============================================================
// AI CHAT — wired to Code.gs chatWithAI (OpenRouter -> Groq)
// ============================================================
let chatHistory = [];

function gT() { const n = new Date(); return n.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function sCB() { setTimeout(() => MS.scrollTo({ top: MS.scrollHeight, behavior: 'smooth' }), 50); }
function aM(tx, s) {
  const r = document.createElement('div'); r.className = 'message-row ' + s;
  const b = document.createElement('div'); b.className = 'message-bubble ' + s;
  b.innerHTML = escapeHtml_(tx) + '<div class="message-time">' + gT() + '</div>';
  r.appendChild(b); CM.appendChild(r); sCB();
}
function sTy() {
  const r = document.createElement('div'); r.className = 'message-row ai'; r.id = 'typingRow';
  const i = document.createElement('div'); i.className = 'typing-indicator';
  i.innerHTML = '<span></span><span></span><span></span>';
  r.appendChild(i); CM.appendChild(r); sCB();
  return r;
}
function rTy() { const t = document.getElementById('typingRow'); if (t) t.remove(); }

function sM() {
  const t = CI.value.trim();
  if (!t) return;
  aM(t, 'user');
  chatHistory.push({ role: 'user', content: t });
  CI.value = '';
  SB.disabled = true;
  sTy();
  apiPost_('chat', { message: t, history: JSON.stringify(chatHistory.slice(0, -1)) }).then(res => {
    rTy();
    if (res && res.ok) {
      aM(res.reply, 'ai');
      chatHistory.push({ role: 'assistant', content: res.reply });
    } else {
      aM("Sorry, I couldn't reach the AI assistant right now.", 'ai');
    }
  }).catch(err => {
    rTy();
    aM("Sorry, I couldn't reach the AI assistant right now.", 'ai');
    console.error('chat', err);
  });
}

function sendMessage() { sM(); }
function sendQuickMessage(t) {
  CI.value = t; SB.disabled = false; sM();
  const c = document.getElementById('suggestionChips');
  if (c) {
    c.style.opacity = '0'; c.style.transform = 'translateY(-8px)';
    c.style.transition = 'opacity .3s ease,transform .3s ease';
    setTimeout(() => c.style.display = 'none', 300);
  }
}

CI.addEventListener('keypress', e => { if (e.key === 'Enter') sM(); });
CI.addEventListener('input', () => { SB.disabled = !CI.value.trim(); });

// ============================================================
// INIT
// ============================================================
window.addEventListener('load', () => { uPP(); });
window.addEventListener('resize', uPP);

// Keep the menu/schedule ticks in sync with the clock, and pick up
// deliveries / stock / inventory changes submitted from other devices,
// without a manual reload. Skips the refresh while a modal is open so it
// doesn't yank the screen out from under an in-progress action.
function anyModalOpen_() {
  return !!document.querySelector('.modal-overlay.active, [id$="ModalOverlay"].active');
}
setInterval(() => { if (DATA) { renderMenu(); renderSchedule(); } }, 60 * 1000);
setInterval(() => { if (currentUser && !anyModalOpen_()) pollForChanges_(); }, 7 * 1000);

// Add to home screen prompt for iOS
if (window.navigator.standalone === false) {
  document.body.style.paddingTop = '20px';
}

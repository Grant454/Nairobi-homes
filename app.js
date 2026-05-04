/* ═══════════════════════════════════════════════════════════════════
   NairobiHomes — app.js
   Architecture:
   1. Boot → getSession() first (synchronous auth check)
   2. onAuthStateChange → only updates UI, never navigates
   3. All auth actions → explicit try/catch, explicit navigation
   4. Admin guard → checked at navigate() AND at every data loader
═══════════════════════════════════════════════════════════════════ */

/* ── CONFIG — Replace with your real Supabase credentials ──────── */
const SUPABASE_URL  = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON = 'YOUR_SUPABASE_ANON_KEY';

/* ══════════════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════════════ */
let DB              = null;   // Supabase client instance
let authUser        = null;   // Supabase auth user
let authProfile     = null;   // Row from public.profiles
let currentPage     = 'home';
let pendingFilters  = null;   // Filters set by hero search / area click

let galleryImages   = [];
let galleryIndex    = 0;

let allProperties   = [];     // Full listings cache
let filteredProps   = [];
let listPage        = 1;
const PER_PAGE      = 9;

let adminAllProps   = [];
let adminAllUsers   = [];

let addFiles        = [];     // New files for add-property form
let editFiles       = [];     // New files for edit-property form
let editDeleteIds   = [];     // Image IDs marked for deletion
let editExisting    = [];     // Existing images for edit form
let editPropId      = null;

let confirmCb       = null;   // Pending confirm dialog callback

const AREAS = [
  'Kilimani','Westlands','Karen','Ngong Road','Upper Hill',
  'Lavington','Kileleshwa','Parklands','Ruaka','Gigiri',
  'Runda','Muthaiga','Hurlingham','South B','South C',
  "Lang'ata",'Kasarani','Thika Road','Embakasi','Donholm',
];

/* ══════════════════════════════════════════════════════════════════
   BOOT  ← Single entry point, runs once
══════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('footer-year').textContent = new Date().getFullYear();

  /* ── Show setup banner if credentials not replaced ── */
  if (SUPABASE_URL === 'YOUR_SUPABASE_URL') {
    document.getElementById('setup-banner').classList.add('on');
    document.getElementById('navbar').style.top = '50px';
    return; // Stop — nothing works without real credentials
  }

  /* ── Init Supabase client ── */
  DB = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

  /* ── Populate datalists ── */
  _fillAreas();

  /* ── Drag and drop on upload zones ── */
  _initDragDrop();

  /* ── Navbar scroll effect ── */
  window.addEventListener('scroll', () => {
    document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 10);
  });

  /* ── Close menus on outside click ── */
  document.addEventListener('click', e => {
    if (!e.target.closest('#user-btn'))
      document.getElementById('user-menu')?.classList.remove('open');
    if (!e.target.closest('.admin-sidebar') && !e.target.closest('.sb-toggle'))
      document.getElementById('admin-sidebar')?.classList.remove('open');
  });

  /* ── Lightbox keyboard nav ── */
  document.addEventListener('keydown', e => {
    const lb = document.getElementById('lightbox');
    if (!lb?.classList.contains('open')) return;
    if (e.key === 'ArrowLeft')  lbNav(-1);
    if (e.key === 'ArrowRight') lbNav(1);
    if (e.key === 'Escape')     lbClose();
  });

  /* ── STEP 1: Check existing session synchronously ─────────────
     This is the fix for the "stuck on loading" problem.
     We ALWAYS call getSession() first before rendering anything.
     If a session exists, load the profile. Then render the page.
     We do NOT rely solely on onAuthStateChange for the first render.
  ────────────────────────────────────────────────────────────── */
  const { data: { session } } = await DB.auth.getSession();
  if (session?.user) {
    await _loadProfile(session.user);
  }
  _updateNav();
  _loadHomeData();

  /* ── STEP 2: Listen for subsequent auth changes ───────────────
     onAuthStateChange handles: sign-in, sign-out, token refresh.
     It only updates state — it NEVER navigates by itself.
     Navigation is always controlled explicitly by the action that
     triggered the change (doLogin, doRegister, doSignOut).
  ────────────────────────────────────────────────────────────── */
  DB.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session?.user) {
      await _loadProfile(session.user);
      _updateNav();
    }
    if (event === 'SIGNED_OUT') {
      authUser    = null;
      authProfile = null;
      _updateNav();
      /* Redirect away from protected pages if session expired externally */
      if (currentPage === 'favorites' || currentPage.startsWith('admin')) {
        _showPage('home');
      }
    }
    if (event === 'TOKEN_REFRESHED' && session?.user) {
      /* Silently refresh — no UI changes needed */
      authUser = session.user;
    }
  });
});

/* ══════════════════════════════════════════════════════════════════
   PROFILE LOADER
   Called once on boot (from getSession) and on SIGNED_IN event.
   Never inserts into profiles — that is the trigger's job.
══════════════════════════════════════════════════════════════════ */
async function _loadProfile(user) {
  authUser = user;
  try {
    const { data, error } = await DB
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (data && !error) {
      authProfile = data;
    } else {
      /* Profile row not yet created by trigger (can happen on very
         first signup within ms of the trigger running).
         Use a safe in-memory fallback — NEVER write to profiles here.
         A page refresh will pick up the real row once the trigger runs. */
      authProfile = {
        id:    user.id,
        name:  user.user_metadata?.name || user.email.split('@')[0],
        email: user.email,
        role:  'user',
      };
    }
  } catch (_) {
    /* Network failure — safe fallback */
    authProfile = {
      id:    user.id,
      name:  user.user_metadata?.name || user.email.split('@')[0],
      email: user.email,
      role:  'user',
    };
  }
}

/* ══════════════════════════════════════════════════════════════════
   AUTH GUARDS
══════════════════════════════════════════════════════════════════ */
function _isAdmin()  { return authProfile?.role === 'admin'; }
function _isLogged() { return !!authUser; }

function _requireAuth(msg = 'Please sign in to continue.') {
  if (!_isLogged()) { toast(msg, 'info'); navigate('login'); return false; }
  return true;
}

function _requireAdmin() {
  if (!_isLogged()) {
    _showGuard('notLoggedIn');
    return false;
  }
  if (!_isAdmin()) {
    _showGuard('notAdmin');
    return false;
  }
  return true;
}

function _showGuard(reason) {
  const g = document.getElementById('admin-guard');
  g.classList.add('on');
  if (reason === 'notLoggedIn') {
    document.getElementById('guard-icon').textContent  = '🔒';
    document.getElementById('guard-title').textContent = 'Sign In Required';
    document.getElementById('guard-msg').textContent   = 'You must be signed in to access the admin panel.';
    document.getElementById('guard-btn').textContent   = 'Sign In';
    document.getElementById('guard-btn').onclick = () => { g.classList.remove('on'); navigate('login'); };
  } else {
    document.getElementById('guard-icon').textContent  = '⛔';
    document.getElementById('guard-title').textContent = 'Access Denied';
    document.getElementById('guard-msg').textContent   = 'You do not have administrator privileges.';
    document.getElementById('guard-btn').textContent   = 'Go Home';
    document.getElementById('guard-btn').onclick = () => { g.classList.remove('on'); navigate('home'); };
  }
}

/* ══════════════════════════════════════════════════════════════════
   NAV UI UPDATE
══════════════════════════════════════════════════════════════════ */
function _updateNav() {
  const logged = _isLogged();
  const admin  = _isAdmin();

  $('nav-guest').classList.toggle('hidden', logged);
  $('nav-user-area').classList.toggle('hidden', !logged);
  $('mob-guest').classList.toggle('hidden', logged);
  $('mob-user').classList.toggle('hidden', !logged);

  $('admin-nav-link').classList.toggle('hidden', !admin);
  $('mob-admin-link').classList.toggle('hidden', !admin);

  if (logged && authProfile) {
    const name    = authProfile.name || authUser.email;
    const initial = name.charAt(0).toUpperCase();
    $('user-av').textContent         = initial;
    $('user-name-text').textContent  = name.split(' ')[0];
    $('user-name-text2').textContent = name;
    $('user-email-text').textContent = authProfile.email;
    $('sb-user-name').textContent    = name;
    $('sb-av').textContent           = initial;
  }
}

/* ══════════════════════════════════════════════════════════════════
   LOGIN
══════════════════════════════════════════════════════════════════ */
async function doLogin() {
  const email = $('login-email').value.trim();
  const pw    = $('login-pw').value;
  const errEl = $('login-err');
  const btn   = $('login-btn');

  _hideAlert(errEl);

  if (!email || !pw) {
    return _showAlert(errEl, 'Please enter your email and password.', 'err');
  }

  _setBtnLoading(btn, 'Signing in…');

  try {
    const { data, error } = await DB.auth.signInWithPassword({ email, password: pw });

    _resetBtn(btn, 'Sign In');

    if (error) {
      const msg = error.message.toLowerCase().includes('invalid')
        ? 'Incorrect email or password. Please check your details or create an account first.'
        : error.message;
      return _showAlert(errEl, msg, 'err');
    }

    /* Clear form */
    $('login-email').value = '';
    $('login-pw').value    = '';
    _hideAlert(errEl);

    toast('Welcome back! 👋', 'success');
    navigate('home');

  } catch (_) {
    _resetBtn(btn, 'Sign In');
    _showAlert(errEl, 'Connection error. Please check your internet and try again.', 'err');
  }
}

/* ══════════════════════════════════════════════════════════════════
   REGISTER
══════════════════════════════════════════════════════════════════ */
async function doRegister() {
  const name  = $('reg-name').value.trim();
  const email = $('reg-email').value.trim();
  const pw    = $('reg-pw').value;
  const conf  = $('reg-confirm').value;
  const errEl = $('reg-err');
  const btn   = $('reg-btn');

  _hideAlert(errEl);

  /* Client-side validation */
  if (!name || !email || !pw || !conf)
    return _showAlert(errEl, 'Please fill in all fields.', 'err');
  if (name.length < 2)
    return _showAlert(errEl, 'Name must be at least 2 characters.', 'err');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return _showAlert(errEl, 'Please enter a valid email address.', 'err');
  if (pw.length < 8)
    return _showAlert(errEl, 'Password must be at least 8 characters.', 'err');
  if (pw !== conf)
    return _showAlert(errEl, 'Passwords do not match.', 'err');

  _setBtnLoading(btn, 'Creating account…');

  try {
    const { data, error } = await DB.auth.signUp({
      email,
      password: pw,
      options:  { data: { name } },
    });

    _resetBtn(btn, 'Create Account');

    if (error) {
      const msg = error.message.toLowerCase().includes('already registered')
        ? 'An account with this email already exists. Please sign in instead.'
        : error.message;
      return _showAlert(errEl, msg, 'err');
    }

    /* ── IMPORTANT ──────────────────────────────────────────────
       We do NOT manually insert into public.profiles here.
       The SQL trigger handle_new_user() does it automatically
       with security definer permissions.
       A manual insert would be blocked by RLS (no INSERT policy
       for regular users) and would cause the registration to freeze.
    ─────────────────────────────────────────────────────────── */

    /* If email confirmation is still on — data.session will be null */
    if (!data.session) {
      _showAlert(errEl, '✓ Account created! Check your email to confirm, then sign in.', 'ok');
      return;
    }

    /* Clear form */
    ['reg-name','reg-email','reg-pw','reg-confirm']
      .forEach(id => { $(id).value = ''; });

    toast('Account created! Welcome to NairobiHomes 🏠', 'success');
    navigate('home');

  } catch (_) {
    _resetBtn(btn, 'Create Account');
    _showAlert(errEl, 'Connection error. Please check your internet and try again.', 'err');
  }
}

/* ══════════════════════════════════════════════════════════════════
   SIGN OUT
   Clears state explicitly — does NOT rely on onAuthStateChange
   to trigger navigation, preventing double-navigate race condition.
══════════════════════════════════════════════════════════════════ */
async function doSignOut() {
  try { await DB.auth.signOut(); } catch (_) {}
  authUser    = null;
  authProfile = null;
  _updateNav();
  toast('You have been signed out.', 'info');
  navigate('home');
}

/* ══════════════════════════════════════════════════════════════════
   NAVIGATION (SPA router)
══════════════════════════════════════════════════════════════════ */
function navigate(page, id = null) {
  closeMobileNav();
  currentPage = page;

  /* Reset all pages */
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  /* Update nav link active states */
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.classList.toggle('active', el.dataset.nav === page);
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });

  switch (page) {

    case 'home':
      $('page-home').classList.add('active');
      break;

    case 'listings':
      $('page-listings').classList.add('active');
      _loadListings();
      break;

    case 'property':
      $('page-property').classList.add('active');
      if (id) _loadProperty(id);
      break;

    case 'favorites':
      if (!_requireAuth('Please sign in to view your saved properties.')) return;
      $('page-favorites').classList.add('active');
      _loadFavorites();
      break;

    case 'login':
      $('page-login').classList.add('active');
      /* Reset form state */
      _hideAlert($('login-err'));
      _resetBtn($('login-btn'), 'Sign In');
      break;

    case 'register':
      $('page-register').classList.add('active');
      /* Reset form state */
      _hideAlert($('reg-err'));
      _resetBtn($('reg-btn'), 'Create Account');
      break;

    default:
      /* All admin routes */
      if (page.startsWith('admin')) {
        $('page-admin').classList.add('active');
        if (!_requireAdmin()) return;
        const sectionMap = {
          'admin':              'dashboard',
          'admin-dashboard':    'dashboard',
          'admin-props':        'props',
          'admin-add':          'add',
          'admin-users':        'users',
          'admin-reports':      'reports',
        };
        _showAdminSection(sectionMap[page] || 'dashboard');
      }
      break;
  }
}

/* ══════════════════════════════════════════════════════════════════
   HOME PAGE DATA
══════════════════════════════════════════════════════════════════ */
async function _loadHomeData() {
  /* Stats */
  const [{ count: pCount }, { count: uCount }] = await Promise.all([
    DB.from('properties').select('*', { count:'exact', head:true }).eq('status','active'),
    DB.from('profiles').select('*', { count:'exact', head:true }).eq('role','user'),
  ]);
  const se = $('stat-props'); if (se) se.textContent = (pCount || 0) + '+';
  const ue = $('stat-users'); if (ue) ue.textContent = (uCount || 0) + '+';

  /* Featured listings */
  const { data } = await DB
    .from('properties')
    .select('*, images:property_images(*)')
    .eq('status','active')
    .order('created_at', { ascending: false })
    .limit(9);

  _renderGrid('featured-grid', data || []);
}

function heroSearch() {
  pendingFilters = {
    location: $('hs-loc').value,
    min:      $('hs-min').value,
    max:      $('hs-max').value,
    rooms:    $('hs-rooms').value,
  };
  navigate('listings');
}

function goArea(area) {
  pendingFilters = { location: area };
  navigate('listings');
}

/* ══════════════════════════════════════════════════════════════════
   PROPERTY CARD HTML
══════════════════════════════════════════════════════════════════ */
function _propCard(p) {
  const img    = p.images?.find(i => i.is_primary) || p.images?.[0];
  const isFav  = p._fav || false;
  const avgRat = p._rating || 0;
  return `
  <div class="prop-card" onclick="navigate('property','${p.id}')">
    <div class="card-img">
      ${img
        ? `<img src="${_esc(img.image_path)}" alt="${_esc(p.title)}" loading="lazy">`
        : `<div class="card-img-placeholder">🏠</div>`}
      <div class="card-badge-loc">📍 ${_esc(p.location)}</div>
      ${avgRat > 0 ? `<div class="card-badge-rating"><span style="color:#f59e0b">★</span>${avgRat.toFixed(1)}</div>` : ''}
      <button class="fav-btn ${isFav ? 'on' : ''}"
        onclick="event.stopPropagation();_toggleFav('${p.id}',this)"
        title="${isFav ? 'Remove from saved' : 'Save property'}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
      </button>
    </div>
    <div class="card-body">
      <div class="card-price">${_price(p.price)} <sub>/ month</sub></div>
      <div class="card-title">${_esc(p.title)}</div>
      <div class="card-loc">
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
        </svg>
        ${_esc(p.location)}
      </div>
      <p class="card-desc">${_esc(_trunc(p.description, 110))}</p>
      <div class="card-meta">
        <span class="card-meta-item">🛏 ${p.rooms} BR</span>
        <span class="card-meta-sep"></span>
        <span class="card-meta-item ${p.water ? 'good' : ''}">💧 ${p.water ? 'Water' : 'No water'}</span>
        <span class="card-meta-sep"></span>
        <span class="card-meta-item ${p.security ? 'good' : ''}">🔒 ${p.security ? 'Secured' : 'No guard'}</span>
      </div>
    </div>
  </div>`;
}

function _renderGrid(containerId, props, emptyMsg = 'No properties found.') {
  const el = $(containerId);
  if (!el) return;
  if (!props.length) {
    el.innerHTML = `<div class="empty-box" style="grid-column:1/-1">
      <div class="e-icon">🏠</div>
      <h3>Nothing here yet</h3>
      <p>${emptyMsg}</p>
    </div>`;
    return;
  }
  el.innerHTML = props.map(_propCard).join('');
}

/* ══════════════════════════════════════════════════════════════════
   FAVORITES TOGGLE
══════════════════════════════════════════════════════════════════ */
async function _toggleFav(propId, btn) {
  if (!_requireAuth('Please sign in to save properties.')) return;

  const isOn = btn.classList.contains('on');
  const svg  = btn.querySelector('svg');

  if (isOn) {
    const { error } = await DB.from('favorites')
      .delete().eq('user_id', authUser.id).eq('property_id', propId);
    if (error) { toast(error.message, 'error'); return; }
    btn.classList.remove('on');
    if (svg) svg.setAttribute('fill', 'none');
    toast('Removed from saved.');

    /* If on the favorites page, animate-remove the card */
    if (currentPage === 'favorites') {
      const card = btn.closest('.prop-card');
      if (card) {
        card.style.transition = 'opacity .3s, transform .3s';
        card.style.opacity    = '0';
        card.style.transform  = 'scale(.95)';
        setTimeout(() => {
          card.remove();
          /* Show empty state if no cards left */
          const grid = $('fav-grid');
          if (grid && !grid.querySelector('.prop-card'))
            _renderGrid('fav-grid', [], 'Browse listings and save properties you love.');
        }, 300);
      }
    }
  } else {
    const { error } = await DB.from('favorites')
      .insert({ user_id: authUser.id, property_id: propId });
    if (error) { toast(error.message, 'error'); return; }
    btn.classList.add('on');
    if (svg) svg.setAttribute('fill', 'currentColor');
    toast('Property saved! ❤️', 'success');
  }
}

/* ══════════════════════════════════════════════════════════════════
   FAVORITES PAGE
══════════════════════════════════════════════════════════════════ */
async function _loadFavorites() {
  if (!_requireAuth()) return;
  $('fav-grid').innerHTML = '<div class="loading-box"><div class="spinner"></div></div>';

  const { data, error } = await DB
    .from('favorites')
    .select('property:properties(*, images:property_images(*))')
    .eq('user_id', authUser.id)
    .order('created_at', { ascending: false });

  if (error) { toast(error.message, 'error'); return; }

  const props = (data || [])
    .map(f => f.property)
    .filter(Boolean)
    .map(p => ({ ...p, _fav: true }));

  $('fav-count').textContent = `${props.length} saved`;
  $('fav-grid').innerHTML = `<div class="prop-grid">${props.map(_propCard).join('') || ''}</div>`;

  if (!props.length)
    _renderGrid('fav-grid', [], 'Browse listings and tap the heart to save properties you love.');
}

/* ══════════════════════════════════════════════════════════════════
   LISTINGS PAGE
══════════════════════════════════════════════════════════════════ */
async function _loadListings() {
  $('listings-grid').innerHTML = '<div class="loading-box" style="grid-column:1/-1"><div class="spinner"></div></div>';
  $('results-count').textContent = 'Loading…';

  const { data, error } = await DB
    .from('properties')
    .select('*, images:property_images(*)')
    .eq('status', 'active');

  if (error) { toast(error.message, 'error'); return; }

  allProperties = data || [];

  /* Populate location filter from real data */
  const locSel = $('f-loc');
  const saved  = locSel.value;
  locSel.innerHTML = '<option value="">All areas</option>';
  [...new Set(allProperties.map(p => p.location))].sort()
    .forEach(l => locSel.insertAdjacentHTML('beforeend', `<option value="${l}">${l}</option>`));
  if (saved) locSel.value = saved;

  /* Mark favorites */
  if (_isLogged()) {
    const { data: favs } = await DB.from('favorites')
      .select('property_id').eq('user_id', authUser.id);
    const favSet = new Set((favs || []).map(f => f.property_id));
    allProperties = allProperties.map(p => ({ ...p, _fav: favSet.has(p.id) }));
  }

  /* Apply pending filters (from hero search or area click) */
  if (pendingFilters) {
    if (pendingFilters.location) $('f-loc').value   = pendingFilters.location;
    if (pendingFilters.min)      $('f-min').value   = pendingFilters.min;
    if (pendingFilters.max)      $('f-max').value   = pendingFilters.max;
    if (pendingFilters.rooms)    $('f-rooms').value = pendingFilters.rooms;
    pendingFilters = null;
  }

  applyFilters();
}

function applyFilters() {
  const loc    = $('f-loc')?.value || '';
  const min    = parseFloat($('f-min')?.value)  || 0;
  const max    = parseFloat($('f-max')?.value)  || Infinity;
  const rooms  = parseInt($('f-rooms')?.value)  || 0;
  const water  = $('f-water')?.checked;
  const sec    = $('f-sec')?.checked;
  const sort   = $('f-sort')?.value || 'newest';

  filteredProps = allProperties.filter(p => {
    if (loc   && !p.location.toLowerCase().includes(loc.toLowerCase())) return false;
    if (p.price < min || p.price > max)  return false;
    if (rooms && (rooms >= 4 ? p.rooms < 4 : p.rooms !== rooms)) return false;
    if (water && !p.water)   return false;
    if (sec   && !p.security) return false;
    return true;
  });

  filteredProps.sort((a, b) => {
    if (sort === 'price_asc')  return a.price - b.price;
    if (sort === 'price_desc') return b.price - a.price;
    if (sort === 'oldest')     return new Date(a.created_at) - new Date(b.created_at);
    return new Date(b.created_at) - new Date(a.created_at); /* newest */
  });

  listPage = 1;
  _renderListPage();
}

function _renderListPage() {
  const total = filteredProps.length;
  const pages = Math.ceil(total / PER_PAGE);
  const start = (listPage - 1) * PER_PAGE;
  const slice = filteredProps.slice(start, start + PER_PAGE);

  $('results-count').innerHTML = total
    ? `Showing <strong>${start + 1}–${Math.min(start + PER_PAGE, total)}</strong> of <strong>${total}</strong> properties`
    : '0 properties match your filters';

  const grid = $('listings-grid');
  if (slice.length) {
    grid.innerHTML = slice.map(_propCard).join('');
  } else {
    grid.innerHTML = `<div class="empty-box" style="grid-column:1/-1">
      <div class="e-icon">🔍</div>
      <h3>No results</h3>
      <p>Try adjusting or clearing your filters.</p>
      <button class="btn btn-brand" onclick="clearFilters()" style="margin-top:1rem">Clear filters</button>
    </div>`;
  }

  _renderPagination(pages);
}

function _renderPagination(pages) {
  const el = $('listings-pag');
  if (pages <= 1) { el.innerHTML = ''; return; }

  let html = '';
  if (listPage > 1)
    html += `<button class="pag-btn" onclick="_goPage(${listPage-1})">←</button>`;

  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - listPage) <= 1) {
      html += `<button class="pag-btn ${i === listPage ? 'active' : ''}" onclick="_goPage(${i})">${i}</button>`;
    } else if (Math.abs(i - listPage) === 2) {
      html += `<span style="padding:0 .35rem;color:var(--text-4);align-self:center">…</span>`;
    }
  }

  if (listPage < pages)
    html += `<button class="pag-btn" onclick="_goPage(${listPage+1})">→</button>`;

  el.innerHTML = html;
}

function _goPage(p) {
  listPage = p;
  _renderListPage();
  $('listings-grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearFilters() {
  ['f-loc','f-min','f-max','f-rooms'].forEach(id => { const e = $(id); if (e) e.value = ''; });
  ['f-water','f-sec'].forEach(id => { const e = $(id); if (e) e.checked = false; });
  $('f-sort').value = 'newest';
  applyFilters();
}

/* ══════════════════════════════════════════════════════════════════
   PROPERTY DETAIL
══════════════════════════════════════════════════════════════════ */
let _detailFavState = false;

async function _loadProperty(id) {
  const wrap = $('prop-detail-wrap');
  wrap.className = 'detail-wrap';
  wrap.innerHTML = '<div class="loading-box" style="grid-column:1/-1"><div class="spinner"></div></div>';
  $('prop-breadcrumb').innerHTML = '';

  try {
    const [{ data: prop }, { data: reviews }] = await Promise.all([
      DB.from('properties')
        .select('*, images:property_images(*)')
        .eq('id', id).eq('status', 'active').single(),
      DB.from('reviews')
        .select('*, profile:profiles(name)')
        .eq('property_id', id)
        .order('created_at', { ascending: false }),
    ]);

    if (!prop) {
      wrap.innerHTML = `<div class="empty-box" style="grid-column:1/-1">
        <div class="e-icon">🏠</div><h3>Property not found</h3>
        <p>This listing may have been removed.</p>
        <button class="btn btn-brand" onclick="navigate('listings')" style="margin-top:1rem">Browse Listings</button>
      </div>`;
      return;
    }

    galleryImages = prop.images || [];
    galleryIndex  = 0;

    /* Check favorite status */
    _detailFavState = false;
    if (_isLogged()) {
      const { data: fav } = await DB.from('favorites')
        .select('id').eq('user_id', authUser.id).eq('property_id', id).single();
      _detailFavState = !!fav;
    }

    /* Related */
    const { data: related } = await DB.from('properties')
      .select('*, images:property_images(image_path,is_primary)')
      .eq('location', prop.location).eq('status', 'active')
      .neq('id', id).limit(3);

    const avgRat = reviews?.length
      ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
    const mainImg = galleryImages.find(i => i.is_primary) || galleryImages[0];

    /* Breadcrumb */
    $('prop-breadcrumb').innerHTML = `
      <span onclick="navigate('home')">Home</span>
      <span class="bc-sep">›</span>
      <span onclick="navigate('listings')">Listings</span>
      <span class="bc-sep">›</span>
      <span onclick="goArea('${_esc(prop.location)}')">${_esc(prop.location)}</span>
      <span class="bc-sep">›</span>
      <span class="bc-current">${_esc(_trunc(prop.title, 40))}</span>`;

    wrap.innerHTML = `
    <!-- LEFT: Gallery + Info -->
    <div class="fade-up">
      <div class="gallery-hero" onclick="lbOpen(0)">
        ${mainImg
          ? `<img src="${_esc(mainImg.image_path)}" id="gallery-main-img" alt="${_esc(prop.title)}">`
          : `<div class="card-img-placeholder">🏠</div>`}
        ${galleryImages.length > 1
          ? `<div class="gallery-hero-overlay">
               <button class="gallery-count-btn" onclick="event.stopPropagation();lbOpen(0)">
                 🖼 ${galleryImages.length} photos
               </button>
             </div>` : ''}
      </div>

      ${galleryImages.length > 1 ? `
      <div class="gallery-thumbs">
        ${galleryImages.map((img, i) => `
          <div class="g-thumb ${i === 0 ? 'active' : ''}" id="gthumb-${i}" onclick="setGalleryImg(${i})">
            <img src="${_esc(img.image_path)}" alt="">
          </div>`).join('')}
      </div>` : ''}

      <!-- About -->
      <div class="card" style="padding:1.5rem;margin-top:2rem">
        <h3 style="margin-bottom:.85rem;letter-spacing:-.01em">About this property</h3>
        <p style="color:var(--text-2);line-height:1.8;white-space:pre-line">${_esc(prop.description)}</p>
      </div>

      <!-- Features -->
      <div style="margin-top:1.75rem">
        <h3 style="margin-bottom:.85rem">Features & Amenities</h3>
        <div class="detail-chips">
          <div class="detail-chip good">🛏 ${prop.rooms} Bedroom${prop.rooms !== 1 ? 's' : ''}</div>
          <div class="detail-chip ${prop.water ? 'good' : 'bad'}">
            💧 ${prop.water ? 'Water Available' : 'No Water Supply'}
          </div>
          <div class="detail-chip ${prop.security ? 'good' : 'bad'}">
            🔒 ${prop.security ? '24hr Security' : 'No Security'}
          </div>
          <div class="detail-chip">📍 ${_esc(prop.location)}</div>
          <div class="detail-chip">🗓 Listed ${_ago(prop.created_at)}</div>
        </div>
      </div>

      <!-- Reviews -->
      <div class="reviews-section">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:.5rem">
          <h3>Reviews ${reviews?.length ? `<span style="font-weight:400;font-size:.9rem;color:var(--text-4)">(${reviews.length})</span>` : ''}</h3>
          ${avgRat > 0 ? `<div style="display:flex;align-items:center;gap:.4rem">
            <div class="star-row">${_stars(Math.round(avgRat))}</div>
            <span style="font-weight:700;font-size:.9rem">${avgRat.toFixed(1)}</span>
          </div>` : ''}
        </div>

        ${reviews?.length ? reviews.map(r => `
          <div class="review-card">
            <div class="review-meta">
              <span class="reviewer">${_esc(r.profile?.name || 'User')}</span>
              <span class="review-date">${_ago(r.created_at)}</span>
            </div>
            <div class="star-row" style="margin-bottom:.5rem">${_stars(r.rating)}</div>
            ${r.comment ? `<p class="review-text">${_esc(r.comment)}</p>` : ''}
          </div>`).join('')
        : `<p style="color:var(--text-4);font-size:.9rem;padding:1rem 0">No reviews yet — be the first!</p>`}

        ${_isLogged() ? `
        <div class="card" style="padding:1.5rem;margin-top:1rem">
          <h3 style="margin-bottom:1rem">Leave a Review</h3>
          <div style="margin-bottom:1rem">
            <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-4);margin-bottom:.5rem">Your Rating</div>
            <div class="star-picker" id="star-picker">
              ${[1,2,3,4,5].map(s => `<span class="star-pick" data-s="${s}" onclick="pickStar(${s})">★</span>`).join('')}
            </div>
          </div>
          <div class="field">
            <label>Comment <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>
            <textarea class="input" id="review-txt" rows="3" placeholder="Share your experience with this property…"></textarea>
          </div>
          <button class="btn btn-brand" onclick="submitReview('${prop.id}')">Submit Review</button>
        </div>`
        : `<p style="font-size:.875rem;color:var(--text-4);margin-top:1rem">
            <a onclick="navigate('login')" style="color:var(--brand);font-weight:700;cursor:pointer">Sign in</a>
            to leave a review.
           </p>`}
      </div>
    </div>

    <!-- RIGHT: Price Card -->
    <div>
      <div class="price-card">
        <div class="price-amount">${_price(prop.price)}</div>
        <div class="price-period">/ month</div>
        <div class="price-meta">
          <p>${_esc(prop.title)}</p>
        </div>
        <div class="price-features">
          <div class="price-feat"><span>🛏</span> ${prop.rooms} Bedroom${prop.rooms !== 1 ? 's' : ''}</div>
          <div class="price-feat ${prop.water ? 'good' : 'bad'}"><span>💧</span> ${prop.water ? 'Water' : 'No water'}</div>
          <div class="price-feat ${prop.security ? 'good' : 'bad'}"><span>🔒</span> ${prop.security ? 'Secured' : 'No guard'}</div>
          ${avgRat > 0 ? `<div class="price-feat good"><span>⭐</span> ${avgRat.toFixed(1)} rating</div>` : ''}
        </div>
        <div class="price-actions">
          <a href="tel:+254700000000" class="btn btn-brand btn-full" style="text-decoration:none">📞 Contact Agent</a>
          <button class="btn ${_detailFavState ? 'btn-danger' : 'btn-outline'} btn-full"
            id="detail-fav-btn" onclick="toggleDetailFav('${prop.id}')">
            ${_detailFavState ? '❤ Saved' : '🤍 Save Property'}
          </button>
        </div>

        ${_isLogged() ? `
        <details style="margin-top:1.25rem">
          <summary style="font-size:.82rem;color:var(--text-4);cursor:pointer;padding:.35rem 0;list-style:none">
            🚩 Report this listing
          </summary>
          <div style="margin-top:.85rem">
            <select class="input" id="report-reason" style="margin-bottom:.6rem">
              <option value="">Select reason…</option>
              <option>Fake or duplicate listing</option>
              <option>Incorrect information</option>
              <option>Property no longer available</option>
              <option>Suspected scam</option>
              <option>Other</option>
            </select>
            <button class="btn btn-sm"
              style="background:var(--red-bg);color:var(--red);border:1px solid var(--red-border)"
              onclick="submitReport('${prop.id}')">Submit Report</button>
          </div>
        </details>` : ''}
      </div>

      ${related?.length ? `
      <div class="card" style="padding:1.25rem;margin-top:1.25rem">
        <h3 style="font-size:.875rem;margin-bottom:1rem;padding-bottom:.75rem;border-bottom:1px solid var(--border)">
          Similar in ${_esc(prop.location)}
        </h3>
        ${related.map(r => {
          const ri = r.images?.find(i => i.is_primary) || r.images?.[0];
          return `<div onclick="navigate('property','${r.id}')" style="display:flex;gap:.75rem;align-items:center;padding:.65rem 0;border-bottom:1px solid var(--border);cursor:pointer;transition:opacity .15s" onmouseenter="this.style.opacity='.7'" onmouseleave="this.style.opacity='1'">
            <div style="width:56px;height:42px;border-radius:var(--r-sm);overflow:hidden;flex-shrink:0;background:var(--surface-2)">
              ${ri ? `<img src="${_esc(ri.image_path)}" style="width:100%;height:100%;object-fit:cover">` : `<div class="card-img-placeholder" style="font-size:1.25rem">🏠</div>`}
            </div>
            <div>
              <div style="font-size:.82rem;font-weight:600;color:var(--text-1)">${_esc(_trunc(r.title, 36))}</div>
              <div style="font-size:.78rem;color:var(--brand-dark);font-weight:700">${_price(r.price)}/mo</div>
            </div>
          </div>`;
        }).join('')}
      </div>` : ''}
    </div>`;

  } catch (err) {
    wrap.innerHTML = `<div class="empty-box" style="grid-column:1/-1">
      <div class="e-icon">⚠️</div><h3>Something went wrong</h3>
      <p>Could not load this property. Please try again.</p>
      <button class="btn btn-brand" onclick="navigate('listings')" style="margin-top:1rem">Back to Listings</button>
    </div>`;
  }
}

/* Star picker */
let _reviewRating = 0;
function pickStar(n) {
  _reviewRating = n;
  document.querySelectorAll('.star-pick').forEach((s, i) => {
    s.classList.toggle('on', i < n);
  });
}

async function submitReview(propId) {
  if (!_requireAuth('Please sign in to submit a review.')) return;
  if (!_reviewRating) { toast('Please select a star rating first.', 'error'); return; }
  const comment = $('review-txt')?.value.trim() || null;
  const { error } = await DB.from('reviews').upsert(
    { user_id: authUser.id, property_id: propId, rating: _reviewRating, comment },
    { onConflict: 'user_id,property_id' }
  );
  if (error) { toast(error.message, 'error'); return; }
  toast('Review submitted! ⭐', 'success');
  _reviewRating = 0;
  _loadProperty(propId);
}

async function submitReport(propId) {
  if (!_requireAuth()) return;
  const reason = $('report-reason')?.value;
  if (!reason) { toast('Please select a reason.', 'error'); return; }
  const { error } = await DB.from('reports').insert({ user_id: authUser.id, property_id: propId, reason });
  if (error) { toast(error.message, 'error'); return; }
  toast('Report submitted. Thank you.', 'success');
  if ($('report-reason')) $('report-reason').value = '';
}

async function toggleDetailFav(propId) {
  if (!_requireAuth('Please sign in to save properties.')) return;
  const btn = $('detail-fav-btn');
  if (_detailFavState) {
    const { error } = await DB.from('favorites').delete().eq('user_id', authUser.id).eq('property_id', propId);
    if (error) { toast(error.message, 'error'); return; }
    _detailFavState = false;
    btn.className = 'btn btn-outline btn-full';
    btn.textContent = '🤍 Save Property';
    toast('Removed from saved.');
  } else {
    const { error } = await DB.from('favorites').insert({ user_id: authUser.id, property_id: propId });
    if (error) { toast(error.message, 'error'); return; }
    _detailFavState = true;
    btn.className = 'btn btn-danger btn-full';
    btn.textContent = '❤ Saved';
    toast('Property saved! ❤️', 'success');
  }
}

/* Gallery */
function setGalleryImg(idx) {
  galleryIndex = idx;
  const img = galleryImages[idx]; if (!img) return;
  const el  = $('gallery-main-img'); if (el) el.src = img.image_path;
  document.querySelectorAll('.g-thumb').forEach((t, i) => t.classList.toggle('active', i === idx));
}
function lbOpen(idx) {
  if (!galleryImages.length) return;
  galleryIndex = idx;
  $('lightbox').classList.add('open');
  _lbUpdate();
}
function lbClose() { $('lightbox').classList.remove('open'); }
function lbNav(d) { galleryIndex = (galleryIndex + d + galleryImages.length) % galleryImages.length; _lbUpdate(); }
function _lbUpdate() {
  const img = galleryImages[galleryIndex]; if (!img) return;
  $('lb-img').src = img.image_path;
  $('lb-counter').textContent = `${galleryIndex + 1} / ${galleryImages.length}`;
  $('lb-dots').innerHTML = galleryImages.map((_, i) =>
    `<div class="lb-dot ${i === galleryIndex ? 'on' : ''}" onclick="galleryIndex=${i};_lbUpdate()"></div>`
  ).join('');
}

/* ══════════════════════════════════════════════════════════════════
   ADMIN — all functions guard with _requireAdmin() first
══════════════════════════════════════════════════════════════════ */
function _showAdminSection(section) {
  if (!_requireAdmin()) return;

  document.querySelectorAll('.admin-section').forEach(s => s.classList.add('hidden'));
  document.querySelectorAll('.sb-link[data-section]').forEach(l =>
    l.classList.toggle('active', l.dataset.section === section)
  );
  $(`admin-sect-${section}`)?.classList.remove('hidden');

  const titles = { dashboard:'Dashboard', props:'Properties', add:'Add Property', edit:'Edit Property', users:'Users', reports:'Reports' };
  $('admin-title').textContent = titles[section] || 'Admin';
  $('admin-sidebar').classList.remove('open');

  if (section === 'dashboard') _loadDashboard();
  if (section === 'props')     _loadAdminProps();
  if (section === 'users')     _loadAdminUsers();
  if (section === 'reports')   _loadAdminReports();
  if (section === 'add')       _resetAddForm();
}

/* Dashboard */
async function _loadDashboard() {
  if (!_requireAdmin()) return;
  const [
    {count:ap},{count:tu},{count:ti},{count:tf},{count:tr},{count:trp}
  ] = await Promise.all([
    DB.from('properties').select('*',{count:'exact',head:true}).eq('status','active'),
    DB.from('profiles').select('*',{count:'exact',head:true}).eq('role','user'),
    DB.from('property_images').select('*',{count:'exact',head:true}),
    DB.from('favorites').select('*',{count:'exact',head:true}),
    DB.from('reviews').select('*',{count:'exact',head:true}),
    DB.from('reports').select('*',{count:'exact',head:true}),
  ]);
  $('dash-stats').innerHTML = [
    {icon:'🏘',num:ap||0,lbl:'Active Listings',bg:'#ecfdf5',ic:'#059669'},
    {icon:'👥',num:tu||0,lbl:'Users',bg:'#eff6ff',ic:'#3b82f6'},
    {icon:'🖼',num:ti||0,lbl:'Images',bg:'#f5f3ff',ic:'#8b5cf6'},
    {icon:'❤',num:tf||0,lbl:'Saved',bg:'#fef2f2',ic:'#ef4444'},
    {icon:'⭐',num:tr||0,lbl:'Reviews',bg:'#fefce8',ic:'#f59e0b'},
    {icon:'🚩',num:trp||0,lbl:'Reports',bg:'#fef2f2',ic:'#ef4444'},
  ].map(s => `
    <div class="stat-card">
      <div class="stat-icon-wrap" style="background:${s.bg}">
        <span style="font-size:1.3rem">${s.icon}</span>
      </div>
      <div class="stat-num">${s.num}</div>
      <div class="stat-lbl">${s.lbl}</div>
    </div>`).join('');

  const { data: props } = await DB.from('properties')
    .select('*, images:property_images(image_path,is_primary)')
    .order('created_at',{ascending:false}).limit(8);
  _renderAdminPropRows('dash-tbody', props || []);
}

/* Manage Properties */
async function _loadAdminProps() {
  if (!_requireAdmin()) return;
  $('admin-props-tbody').innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem"><div class="spinner" style="margin:0 auto;width:24px;height:24px;border-width:2px"></div></td></tr>`;
  const { data } = await DB.from('properties')
    .select('*, images:property_images(image_path,is_primary)')
    .order('created_at',{ascending:false});
  adminAllProps = data || [];
  _renderAdminProps(adminAllProps);
}

function _renderAdminProps(props) {
  $('admin-props-count').textContent = `${props.length} Properties`;
  _renderAdminPropRows('admin-props-tbody', props);
}

function _renderAdminPropRows(tbodyId, props) {
  const el = $(tbodyId);
  if (!el) return;
  el.innerHTML = props.length ? props.map(p => {
    const img = p.images?.find(i => i.is_primary) || p.images?.[0];
    return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:.75rem">
          ${img ? `<img src="${_esc(img.image_path)}" class="tbl-img" alt="">` : '<div style="width:50px;height:38px;border-radius:var(--r-sm);background:var(--surface-2);display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0">🏠</div>'}
          <div>
            <div class="tbl-title">${_esc(_trunc(p.title, 34))}</div>
            <div class="tbl-sub">#${p.id.slice(0,8)}</div>
          </div>
        </div>
      </td>
      <td>${_esc(p.location)}</td>
      <td style="white-space:nowrap;font-weight:600">${_price(p.price)}</td>
      <td>${p.rooms} BR</td>
      <td>
        <span class="badge ${p.status==='active'?'badge-green':'badge-red'}" style="cursor:pointer"
          onclick="togglePropStatus('${p.id}','${p.status}',this)">${p.status}</span>
      </td>
      <td style="white-space:nowrap;color:var(--text-4)">${_ago(p.created_at)}</td>
      <td>
        <div class="tbl-actions">
          <button class="btn btn-sm btn-outline" onclick="navigate('property','${p.id}')">View</button>
          <button class="btn btn-sm btn-dark" onclick="openEditProp('${p.id}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="_confirmDelete('${p.id}','${_esc(p.title).replace(/'/g,"\\'")}')">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" style="text-align:center;padding:2.5rem;color:var(--text-4)">
    No properties yet.
    <button class="btn btn-sm btn-brand" onclick="_showAdminSection('add')" style="margin-left:.5rem">Add one →</button>
  </td></tr>`;
}

function filterAdminProps() {
  const q = $('admin-props-search')?.value.toLowerCase() || '';
  _renderAdminProps(adminAllProps.filter(p =>
    p.title.toLowerCase().includes(q) || p.location.toLowerCase().includes(q)
  ));
}

async function togglePropStatus(id, cur, badge) {
  if (!_requireAdmin()) return;
  const next = cur === 'active' ? 'inactive' : 'active';
  const { error } = await DB.from('properties').update({status:next}).eq('id',id);
  if (error) { toast(error.message,'error'); return; }
  badge.textContent = next;
  badge.className = `badge ${next==='active'?'badge-green':'badge-red'} cursor-pointer`;
  badge.onclick = () => togglePropStatus(id, next, badge);
  toast(`Property ${next==='active'?'activated':'deactivated'}.`);
}

function _confirmDelete(id, title) {
  openConfirm('Delete Property?', `Permanently delete "${title}" and all its images. This cannot be undone.`, '🗑️',
    () => _deleteProp(id));
}

async function _deleteProp(id) {
  if (!_requireAdmin()) return;
  const { data: imgs } = await DB.from('property_images').select('image_path').eq('property_id', id);
  if (imgs?.length) {
    const paths = imgs.map(i => {
      try { return decodeURIComponent(new URL(i.image_path).pathname.split('/object/public/properties/')[1]); }
      catch { return null; }
    }).filter(Boolean);
    if (paths.length) await DB.storage.from('properties').remove(paths);
  }
  const { error } = await DB.from('properties').delete().eq('id', id);
  if (error) { toast(error.message,'error'); return; }
  toast('Property deleted.', 'success');
  _loadAdminProps();
}

/* Add Property */
function _resetAddForm() {
  ['add-title','add-price','add-rooms','add-loc','add-desc']
    .forEach(id => { const e = $(id); if (e) e.value = ''; });
  ['add-water','add-sec']
    .forEach(id => { const e = $(id); if (e) e.checked = false; });
  addFiles = [];
  $('add-previews').innerHTML = '';
  const dc = $('add-desc-count'); if (dc) dc.textContent = '0';
}

function addDescCount() {
  const dc = $('add-desc-count');
  if (dc) dc.textContent = $('add-desc')?.value.length || 0;
}

function handleAddFiles(files) {
  const valid = Array.from(files).filter(f =>
    ['image/jpeg','image/png','image/webp'].includes(f.type) && f.size <= 5*1024*1024
  );
  if (valid.length !== files.length)
    toast('Some files skipped — must be JPG/PNG/WebP under 5MB.', 'error');
  addFiles = [...addFiles, ...valid];
  _renderAddPreviews();
}

function _renderAddPreviews() {
  $('add-previews').innerHTML = addFiles.map((f, i) => `
    <div class="preview-item">
      <img src="${URL.createObjectURL(f)}" alt="">
      ${i === 0 ? '<div class="cover-tag">Cover</div>' : ''}
      <button class="preview-rm" onclick="removeAddFile(${i})">✕</button>
    </div>`).join('');
}

function removeAddFile(i) { addFiles.splice(i, 1); _renderAddPreviews(); }

async function submitAddProperty() {
  if (!_requireAdmin()) return;
  const title = $('add-title')?.value.trim();
  const price = $('add-price')?.value;
  const rooms = $('add-rooms')?.value;
  const loc   = $('add-loc')?.value.trim();
  const desc  = $('add-desc')?.value.trim();
  const water = $('add-water')?.checked;
  const sec   = $('add-sec')?.checked;
  const btn   = $('add-submit-btn');

  if (!title||!price||!rooms||!loc||!desc)
    return toast('Please fill in all required fields.', 'error');
  if (Number(price) <= 0)
    return toast('Please enter a valid price.', 'error');
  if (desc.length < 20)
    return toast('Description must be at least 20 characters.', 'error');

  _setBtnLoading(btn, 'Saving…');

  try {
    const { data: prop, error: pErr } = await DB.from('properties')
      .insert({ title, price:Number(price), location:loc, rooms:Number(rooms), description:desc, water, security:sec, status:'active' })
      .select().single();

    if (pErr) { _resetBtn(btn,'✓ Save & Publish'); return toast(pErr.message,'error'); }

    for (let i = 0; i < addFiles.length; i++) {
      const f    = addFiles[i];
      const ext  = f.name.split('.').pop();
      const path = `properties/${prop.id}/${Date.now()}_${i}.${ext}`;
      const { data: up } = await DB.storage.from('properties').upload(path, f, {cacheControl:'3600'});
      if (up) {
        const { data:{publicUrl} } = DB.storage.from('properties').getPublicUrl(up.path);
        await DB.from('property_images').insert({property_id:prop.id, image_path:publicUrl, is_primary:i===0});
      }
    }

    _resetBtn(btn, '✓ Save & Publish');
    toast('Property published! 🏠', 'success');
    _resetAddForm();
    _showAdminSection('props');

  } catch (err) {
    _resetBtn(btn, '✓ Save & Publish');
    toast('Something went wrong. Please try again.', 'error');
  }
}

/* Edit Property */
async function openEditProp(id) {
  if (!_requireAdmin()) return;
  editPropId    = id;
  editFiles     = [];
  editDeleteIds = [];
  _showAdminSection('edit');

  const { data: p } = await DB.from('properties')
    .select('*, images:property_images(*)')
    .eq('id', id).single();
  if (!p) { toast('Property not found.','error'); return; }

  $('edit-id').value        = p.id;
  $('edit-title').value     = p.title;
  $('edit-price').value     = p.price;
  $('edit-rooms').value     = p.rooms;
  $('edit-loc').value       = p.location;
  $('edit-desc').value      = p.description;
  $('edit-water').checked   = p.water;
  $('edit-sec').checked     = p.security;
  $('edit-status').value    = p.status;

  editExisting = p.images || [];
  _renderEditExisting();
  $('edit-new-previews').innerHTML = '';
}

function _renderEditExisting() {
  $('edit-existing').innerHTML = editExisting.length
    ? editExisting.map(img => `
        <div class="preview-item" id="eimg-${img.id}">
          <img src="${_esc(img.image_path)}" alt="">
          ${img.is_primary ? '<div class="cover-tag">Cover</div>' : ''}
          <button class="preview-rm" onclick="markEditImgDelete('${img.id}')">✕</button>
        </div>`).join('')
    : '<p style="font-size:.82rem;color:var(--text-4)">No images uploaded yet.</p>';
}

function markEditImgDelete(imgId) {
  editDeleteIds.push(imgId);
  editExisting = editExisting.filter(i => i.id !== imgId);
  document.getElementById(`eimg-${imgId}`)?.remove();
}

function handleEditFiles(files) {
  const valid = Array.from(files).filter(f =>
    ['image/jpeg','image/png','image/webp'].includes(f.type) && f.size <= 5*1024*1024
  );
  editFiles = [...editFiles, ...valid];
  $('edit-new-previews').innerHTML = editFiles.map((f, i) => `
    <div class="preview-item">
      <img src="${URL.createObjectURL(f)}" alt="">
      <button class="preview-rm" onclick="editFiles.splice(${i},1);handleEditFiles([])">✕</button>
    </div>`).join('');
}

async function submitEditProperty() {
  if (!_requireAdmin()) return;
  const id    = $('edit-id')?.value;
  const title = $('edit-title')?.value.trim();
  const price = $('edit-price')?.value;
  const rooms = $('edit-rooms')?.value;
  const loc   = $('edit-loc')?.value.trim();
  const desc  = $('edit-desc')?.value.trim();
  const water = $('edit-water')?.checked;
  const sec   = $('edit-sec')?.checked;
  const status= $('edit-status')?.value;
  const btn   = $('edit-submit-btn');

  if (!title||!price||!rooms||!loc||!desc)
    return toast('Please fill in all required fields.', 'error');

  _setBtnLoading(btn, 'Saving…');

  try {
    /* Delete marked images */
    for (const imgId of editDeleteIds) {
      const row = (await DB.from('property_images').select('image_path').eq('id',imgId).single()).data;
      if (row) {
        try {
          const path = decodeURIComponent(new URL(row.image_path).pathname.split('/object/public/properties/')[1]);
          await DB.storage.from('properties').remove([path]);
        } catch {}
      }
      await DB.from('property_images').delete().eq('id', imgId);
    }

    /* Upload new images */
    for (let i = 0; i < editFiles.length; i++) {
      const f    = editFiles[i];
      const ext  = f.name.split('.').pop();
      const path = `properties/${id}/${Date.now()}_new${i}.${ext}`;
      const { data: up } = await DB.storage.from('properties').upload(path, f);
      if (up) {
        const { data:{publicUrl} } = DB.storage.from('properties').getPublicUrl(up.path);
        await DB.from('property_images').insert({
          property_id: id, image_path: publicUrl,
          is_primary: editExisting.length === 0 && i === 0,
        });
      }
    }

    const { error } = await DB.from('properties')
      .update({ title, price:Number(price), location:loc, rooms:Number(rooms), description:desc, water, security:sec, status })
      .eq('id', id);

    _resetBtn(btn, '✓ Update Property');
    if (error) { toast(error.message,'error'); return; }
    toast('Property updated!', 'success');
    _showAdminSection('props');

  } catch (err) {
    _resetBtn(btn, '✓ Update Property');
    toast('Something went wrong. Please try again.', 'error');
  }
}

function confirmDeleteEditProp() {
  const id    = $('edit-id')?.value;
  const title = $('edit-title')?.value;
  openConfirm('Delete Property?', `Permanently delete "${title}" and all its images.`, '🗑️',
    () => _deleteProp(id));
}

/* Users */
async function _loadAdminUsers() {
  if (!_requireAdmin()) return;
  $('admin-users-tbody').innerHTML = `<tr><td colspan="5" style="text-align:center;padding:2rem"><div class="spinner" style="margin:0 auto;width:24px;height:24px;border-width:2px"></div></td></tr>`;
  const { data } = await DB.from('profiles').select('*').order('created_at',{ascending:false});
  adminAllUsers = data || [];
  _renderAdminUsers(adminAllUsers);
}

function _renderAdminUsers(users) {
  $('admin-users-count').textContent = `${users.length} Users`;
  $('admin-users-tbody').innerHTML = users.length ? users.map(u => `<tr>
    <td>
      <div style="display:flex;align-items:center;gap:.65rem">
        <div style="width:34px;height:34px;border-radius:50%;background:${u.role==='admin'?'linear-gradient(135deg,var(--brand),var(--brand-dark))':'var(--surface-2)'};color:${u.role==='admin'?'#fff':'var(--text-3)'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.82rem;flex-shrink:0;border:1px solid var(--border)">
          ${(u.name||'U').charAt(0).toUpperCase()}
        </div>
        <div>
          <div class="tbl-title">${_esc(u.name||'—')}</div>
          <div class="tbl-sub">#${u.id.slice(0,8)}</div>
        </div>
      </div>
    </td>
    <td style="color:var(--text-3)">${_esc(u.email)}</td>
    <td><span class="badge ${u.role==='admin'?'badge-blue':'badge-slate'}">${u.role}</span></td>
    <td style="color:var(--text-4);white-space:nowrap">${_ago(u.created_at)}</td>
    <td>
      ${u.id !== authUser?.id
        ? `<button class="btn btn-sm ${u.role==='admin'?'btn-outline':'btn-brand'}"
             onclick="toggleUserRole('${u.id}','${u.role}',this)">
             ${u.role==='admin'?'⬇ Demote':'⬆ Promote'}
           </button>`
        : '<span style="font-size:.8rem;color:var(--text-4);font-style:italic">You</span>'}
    </td>
  </tr>`).join('') : `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-4)">No users found.</td></tr>`;
}

function filterAdminUsers() {
  const q = $('admin-users-search')?.value.toLowerCase() || '';
  _renderAdminUsers(adminAllUsers.filter(u =>
    u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q)
  ));
}

async function toggleUserRole(userId, cur, btn) {
  if (!_requireAdmin()) return;
  const next = cur === 'admin' ? 'user' : 'admin';
  const { error } = await DB.from('profiles').update({role:next}).eq('id',userId);
  if (error) { toast(error.message,'error'); return; }
  btn.textContent = next==='admin' ? '⬇ Demote' : '⬆ Promote';
  btn.className   = `btn btn-sm ${next==='admin'?'btn-outline':'btn-brand'}`;
  btn.onclick     = () => toggleUserRole(userId, next, btn);
  toast(`User ${next==='admin'?'promoted to Admin':'demoted to User'}.`, 'success');
  _loadAdminUsers();
}

/* Reports */
async function _loadAdminReports() {
  if (!_requireAdmin()) return;
  $('admin-reports-tbody').innerHTML = `<tr><td colspan="5" style="text-align:center;padding:2rem"><div class="spinner" style="margin:0 auto;width:24px;height:24px;border-width:2px"></div></td></tr>`;
  const { data } = await DB.from('reports')
    .select('*, profile:profiles(name,email), property:properties(id,title,status)')
    .order('created_at',{ascending:false});
  const reports = data || [];
  $('admin-reports-count').textContent = `${reports.length} Open Report${reports.length !== 1 ? 's' : ''}`;
  $('admin-reports-tbody').innerHTML = reports.length ? reports.map(r => `<tr>
    <td>
      <div class="tbl-title" style="cursor:pointer;color:var(--brand)" onclick="navigate('property','${r.property?.id}')">
        ${_esc(_trunc(r.property?.title||'Unknown',34))}
      </div>
      <span class="badge ${r.property?.status==='active'?'badge-green':'badge-red'}" style="margin-top:3px">${r.property?.status||'—'}</span>
    </td>
    <td>
      <div class="tbl-title">${_esc(r.profile?.name||'—')}</div>
      <div class="tbl-sub">${_esc(r.profile?.email||'')}</div>
    </td>
    <td><span class="badge badge-amber">${_esc(r.reason)}</span></td>
    <td style="color:var(--text-4);white-space:nowrap">${_ago(r.created_at)}</td>
    <td>
      <div class="tbl-actions">
        <button class="btn btn-sm btn-dark" onclick="openEditProp('${r.property?.id}')">Review</button>
        <button class="btn btn-sm btn-outline" onclick="dismissReport('${r.id}')">Dismiss</button>
        <button class="btn btn-sm btn-danger" onclick="_confirmDelete('${r.property?.id}','${_esc(r.property?.title||'this listing').replace(/'/g,"\\'")}')">Remove</button>
      </div>
    </td>
  </tr>`).join('') : `<tr><td colspan="5" style="text-align:center;padding:3rem;color:var(--text-4)">🚩 No open reports. All clear!</td></tr>`;
}

async function dismissReport(id) {
  if (!_requireAdmin()) return;
  const { error } = await DB.from('reports').delete().eq('id', id);
  if (error) { toast(error.message,'error'); return; }
  toast('Report dismissed.', 'success');
  _loadAdminReports();
}

/* ══════════════════════════════════════════════════════════════════
   CONFIRM DIALOG
══════════════════════════════════════════════════════════════════ */
function openConfirm(title, msg, icon, cb) {
  confirmCb = cb;
  $('confirm-icon').textContent  = icon;
  $('confirm-title').textContent = title;
  $('confirm-msg').textContent   = msg;
  $('confirm-overlay').classList.add('open');
}
function closeConfirm() { $('confirm-overlay').classList.remove('open'); confirmCb = null; }
function runConfirm()   { closeConfirm(); if (confirmCb) confirmCb(); }

/* ══════════════════════════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════════════════════════ */
function toast(msg, type = 'success') {
  const icons = { success:'✓', error:'✕', info:'ℹ' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]||'•'}</span><span class="toast-msg">${_esc(msg)}</span>`;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity='0'; el.style.transition='opacity .4s'; }, 3600);
  setTimeout(() => el.remove(), 4000);
}

/* ══════════════════════════════════════════════════════════════════
   MOBILE NAV
══════════════════════════════════════════════════════════════════ */
function toggleMobileNav() { $('mobile-nav').classList.toggle('open'); }
function closeMobileNav()  { $('mobile-nav')?.classList.remove('open'); }
function toggleUserBtn()   { $('user-menu')?.classList.toggle('open'); }
function toggleAdminSidebar() { $('admin-sidebar')?.classList.toggle('open'); }

/* ══════════════════════════════════════════════════════════════════
   UTILS
══════════════════════════════════════════════════════════════════ */
function $(id) { return document.getElementById(id); }

function _esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function _price(n) {
  return 'KSh ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits:0 });
}

function _ago(d) {
  const diff  = Date.now() - new Date(d).getTime();
  const mins  = Math.floor(diff/60000);
  const hours = Math.floor(diff/3600000);
  const days  = Math.floor(diff/86400000);
  if (mins  < 1)  return 'Just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days  < 7)  return `${days}d ago`;
  return new Date(d).toLocaleDateString('en-KE',{day:'numeric',month:'short',year:'numeric'});
}

function _trunc(s, n=110) { return s && s.length > n ? s.slice(0,n)+'…' : (s||''); }

function _stars(rating) {
  return [1,2,3,4,5].map(s =>
    `<span class="star ${s<=rating?'on':''}">★</span>`
  ).join('');
}

function _setBtnLoading(btn, txt) {
  if (!btn) return;
  btn.disabled = true;
  btn.dataset.original = btn.textContent;
  btn.innerHTML = `<span class="spinner-sm"></span> ${txt}`;
}

function _resetBtn(btn, txt) {
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = txt;
}

function _showAlert(el, msg, type = 'err') {
  if (!el) return;
  el.textContent = msg;
  el.className   = `alert alert-${type} show`;
}

function _hideAlert(el) {
  if (!el) return;
  el.classList.remove('show');
  el.className = `alert`;
}

function _fillAreas() {
  ['hs-loc','f-loc'].forEach(id => {
    const el = $(id); if (!el) return;
    AREAS.forEach(a => el.insertAdjacentHTML('beforeend',`<option value="${a}">${a}</option>`));
  });
  ['add-loc-list','edit-loc-list'].forEach(id => {
    const el = $(id); if (!el) return;
    AREAS.forEach(a => el.insertAdjacentHTML('beforeend',`<option value="${a}">`));
  });
}

function _initDragDrop() {
  ['add-upload-zone','edit-upload-zone'].forEach(id => {
    const zone = $(id); if (!zone) return;
    const isEdit = id.startsWith('edit');
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    ['dragleave','drop'].forEach(ev => zone.addEventListener(ev, e => {
      zone.classList.remove('drag-over');
      if (ev === 'drop') {
        e.preventDefault();
        isEdit ? handleEditFiles(e.dataTransfer.files) : handleAddFiles(e.dataTransfer.files);
      }
    }));
  });
}

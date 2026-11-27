/**
 * Static regression tests for the async loading/errorstate fixes.
 *
 *   node scripts/test-async-state-fixes.mjs
 *
 * These assertions are deliberately source-precise: they pin the state
 * transitions and the UI branches, not merely the presence of a keyword.
 */
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}
function ok(value, label) { eq(Boolean(value), true, label); }

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  if (from < 0) return '';
  const to = source.indexOf(end, from + start.length);
  return to < 0 ? '' : source.slice(from, to);
}

// ─── [1] auth users load state ───────────────────────────────────────────────
console.log('[1] auth.js users load status');
const auth = read('src/lib/auth.js');
const loadUsers = sliceBetween(auth, 'const loadUsers = useCallback(async () => {', '\n  }, []);');

ok(loadUsers.length > 0, 'loadUsers callback is isolated for assertions');
ok(/const \[usersLoadStatus, setUsersLoadStatus\] = useState\('idle'\);/.test(auth),
  'usersLoadStatus starts as idle');
ok(/const \[usersError, setUsersError\] = useState\(null\);/.test(auth),
  'usersError starts as null');
ok(/setUsersLoadStatus\('loading'\);\s*setUsersError\(null\);\s*try \{\s*const payload = await api\.get\('\/admin\/users'\);/.test(loadUsers),
  'loading is set before the users request, not after it');
ok(/setUsers\(Array\.isArray\(payload\.users\) \? payload\.users : \[\]\);\s*setUsersLoadStatus\('success'\);/.test(loadUsers),
  'success is set only after a successful users response');

const denied = sliceBetween(loadUsers, 'if (err && (err.status === 401 || err.status === 403)) {', 'return;');
ok(denied.length > 0 && /setUsers\(\[\]\);/.test(denied),
  '401/403 still empties the users list as before');
ok(!/setUsersError\(/.test(denied),
  '401/403 does not turn a session problem into a retryable load error');

const failed = sliceBetween(loadUsers, '// Network / 5xx failures', '\n    }');
ok(failed.length > 0 && /setUsersError\(err\?\.message \|\| 'Could not load team members\.'\);/.test(failed),
  'network/5xx failures store a user-visible error message');
ok(/setUsersLoadStatus\('error'\);/.test(failed),
  'network/5xx failures settle on error');
ok(!/setUsers\(\[\]\)/.test(failed),
  'the error branch never wipes the last loaded users');
ok(/users,\s*usersLoadStatus,\s*usersError,\s*loadUsers,\s*addUser/.test(auth),
  'auth context exposes status, error and loadUsers retry action');

// ─── [2] admin users panel ───────────────────────────────────────────────────
console.log('[2] UsersPanel.js async states');
const panel = read('src/components/admin/UsersPanel.js');
const memberCount = sliceBetween(panel, 'const memberCount = usersPending', '\n\n  return (');

ok(/const \{ users, usersLoadStatus, usersError, loadUsers, addUser/.test(panel),
  'panel consumes usersLoadStatus, usersError and loadUsers');
ok(/const usersPending = usersLoadStatus === 'idle' \|\| usersLoadStatus === 'loading';/.test(panel),
  'idle and loading are both treated as pending');
ok(memberCount.length > 0 && /usersPending\s*\? 'Loading team members\.\.\.'/.test(memberCount),
  'the header count is hidden behind the pending label');
ok(/usersLoadStatus === 'error' && storedUsers\.length === 0\s*\? 'Team members unavailable'/.test(memberCount),
  'an error without cached users never reads 0 team members');
ok(/\$\{storedUsers\.length\} team members/.test(memberCount),
  'the settled count keeps the original copy');
ok(/\{usersLoadStatus === 'error' && \(\s*<div role="alert" aria-live="assertive"[\s\S]{0,500}onClick=\{loadUsers\}/.test(panel),
  'an aria-live error banner offers a loadUsers Retry button');
ok(/\{usersPending && \(\s*<tr>[\s\S]{0,250}role="status"[\s\S]{0,250}Loading team members/.test(panel),
  'the table shows a role=status loading row while pending');
ok(/\{usersLoadStatus === 'success' && storedUsers\.length === 0 && \(/.test(panel),
  'the real empty row is gated on settled success');
ok(/\{!usersPending && storedUsers\.map\(user =>/.test(panel),
  'existing user rows stay intact but are withheld while pending');
ok(!/\{storedUsers\.map\(user =>/.test(panel),
  'no ungated user map can render during loading');

// ─── [3] wishlist page ───────────────────────────────────────────────────────
console.log('[3] CartPage.js WishlistPage');
const cart = read('src/pages/CartPage.js');
const wishlist = sliceBetween(cart, 'export function WishlistPage() {', '\nexport default CartPage;');

ok(wishlist.length > 0, 'WishlistPage is isolated for assertions');
ok(/const \{ products = \[\], wishlist = \[\], productsLoadStatus, productsError, refreshProducts, setPage \} = useStore\(\);/.test(wishlist),
  'wishlist consumes the store product load fields');
ok(/const wishlistPending = productsLoadStatus === 'idle' \|\| productsLoadStatus === 'loading';/.test(wishlist),
  'idle and loading are treated as pending');
ok(/\{wishlistPending \? \(\s*<div role="status" aria-live="polite"[\s\S]{0,250}Loading your saved pieces/.test(wishlist),
  'wishlist shows a role=status loading state while idle/loading');
ok(/\{productsLoadStatus === 'error' && \(\s*<div role="alert"[\s\S]{0,800}onClick=\{refreshProducts\}/.test(wishlist),
  'wishlist shows an error banner with a product Retry button');
ok(/aria-live="assertive"/.test(wishlist),
  'wishlist errors are announced assertively');
ok(/\{wished\.length === 0 \? \(\s*productsLoadStatus === 'success' \? \(/.test(wishlist),
  'Nothing saved yet is gated on settled success');
ok(/Nothing saved yet/.test(wishlist), 'the existing empty copy is preserved');
ok(!/\{wished\.length === 0 \? \(\s*<motion\.div/.test(wishlist),
  'the old ungated empty branch is gone');

// ─── [4] order tracking ──────────────────────────────────────────────────────
console.log('[4] TrackOrder.js lookup failures');
const track = read('src/pages/TrackOrder.js');

ok(/const \[lookupError, setLookupError\] = useState\(''\);/.test(track),
  'tracking holds a user-visible lookup error');
ok(/const \[outage, setOutage\] = useState\(false\);/.test(track),
  'tracking distinguishes outages from not-found');
ok(/const \[lookupAttempt, setLookupAttempt\] = useState\(0\);/.test(track),
  'tracking has a retryable lookup attempt counter');
ok(/import \{ isOutageError \} from '..\/lib\/resilience';/.test(track),
  'tracking reuses the shared network/timeout/5xx classifier');
ok(/if \(isOutageError\(status\) \|\| status === 429\) return true;/.test(track),
  'rate limits join 0/408/5xx in the outage classification');
ok(/unavailable\|timeout\|timed \?out\|network\|server\|database\|temporar\|overload\|rate limit/.test(track),
  'an error payload naming an outage is classified as an outage');
ok(/if \(payload && payload\.found === false\) \{[\s\S]{0,220}setNotFound\(true\);/.test(track),
  'only an explicit found:false marks the order as not found');
ok(!/else \{\s*setNotFound\(true\);\s*\}/.test(track),
  'no catch-all success branch can mark an order as not found');
ok(/catch \(err\) \{[\s\S]{0,220}setLookupError\(err\?\.message[\s\S]{0,220}setOutage\(isTrackingOutage\(err\)\);/.test(track),
  'caught API errors show the message and classify the outage');
ok(!/catch \(err\) \{[\s\S]{0,140}setNotFound\(true\);/.test(track),
  'network/timeout failures no longer become not-found');
ok(/role=\{lookupError \? \(outage \? 'alert' : 'status'\) : undefined\}/.test(track),
  'the outage notice has role=alert');
ok(/onClick=\{retryLookup\}/.test(track) && /setLookupAttempt\(\(attempt\) => attempt \+ 1\)/.test(track),
  'the Retry button re-runs the same lookup');
ok(/\[activeOrderId, signedToken, lookupAttempt\]/.test(track),
  'the retry attempt is a lookup effect dependency');
ok(/if \(tk\) setSignedToken\(tk\);\s*stripSensitiveTrackingParams\(\);/.test(track),
  'token stripping from the address bar is preserved');
ok(/const stored = readTrackCredential\(id\);/.test(track),
  'sessionStorage tracking credential handling is preserved');

// ─── [5] shop page ───────────────────────────────────────────────────────────
console.log('[5] ShopPage.js load states and filter reset');
const shop = read('src/pages/ShopPage.js');
const shopStore = sliceBetween(shop, 'const {', '} = useStore();');
const resetFilters = sliceBetween(shop, 'const resetFilters = () => {', '\n  };');

ok(shopStore.length > 0 && /setSearchQuery,/.test(shopStore),
  'shop page consumes the store search setter');
ok(resetFilters.length > 0 && /setSearchQuery\(''\);/.test(resetFilters),
  'resetFilters clears the header search query');
ok(/productsLoadStatus === 'idle' \|\| productsLoadStatus === 'loading' \? \(\s*<div\s+role="status"/.test(shop),
  'idle/loading renders a role=status loading state');
ok(/filtered\.length === 0 && productsLoadStatus === 'success' \? \(/.test(shop),
  'No Products Found is gated on settled success');
ok(!/filtered\.length === 0 \? \(\s*<div[\s\S]{0,320}No Products Found/.test(shop),
  'the old ungated No Products Found branch is gone');
ok(/\) : filtered\.length === 0 \? null : \(/.test(shop),
  'a non-success empty result still renders no empty state');
ok(/\{productsLoadStatus === 'error' && \(\s*<div\s+role="alert"[\s\S]{0,600}onClick=\{refreshProducts\}/.test(shop),
  'the existing product error banner and Retry remain');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

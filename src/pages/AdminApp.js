import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard, Package, ShoppingCart, Tag, BarChart2,
  LogOut, Plus, Search, Edit, Trash2, Eye, Download, TrendingUp,
  AlertCircle, CheckCircle, Clock, Truck, XCircle, Bell, Users,
  Upload, Filter, RefreshCw, ChevronLeft, ChevronRight,
  ArrowUpRight, ArrowDownRight, Package2, Menu, X, MessageSquare
} from 'lucide-react';
import { useStore } from '../store';
import { useAuth } from '../lib/auth';
import { paginate, sanitizeInput, validateProductForm, setPageMeta } from '../lib/security';
import {
  computeSalesOverview,
  RANGE_OPTIONS,
  fmtEGP,
  compactEGP,
  classifyInventory,
  computeAnalyticsReport,
} from '../lib/analytics';
import AdminLogin from '../components/admin/AdminLogin';
import ImageUploader, { storagePathFromUrl } from '../components/admin/ImageUploader';
import CSVImport from '../components/admin/CSVImport';
import UsersPanel from '../components/admin/UsersPanel';
import { deleteStorageFile } from '../lib/api';
import { ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, Legend } from 'recharts';
import Papa from 'papaparse';
import { toast } from '../components/ui/BackToTop';

const STATUS_COLORS = { Pending:'#f39c12', Confirmed:'#3498db', Processing:'#9b59b6', Shipped:'#c9a84c', Delivered:'#27ae60', Cancelled:'#e74c3c' };
const STATUS_FLOW = ['Pending','Confirmed','Processing','Shipped','Delivered'];

// Build a customer tracking link on whatever host is actually serving the app,
// instead of a hard-coded deployment domain.
function trackingLinkFor(id) {
  const origin = (typeof window !== 'undefined' && window.location.origin) ? window.location.origin : '';
  return `${origin}/?track=${encodeURIComponent(id)}`;
}

function StatusBadge({ status, small }) {
  const key = String(status || '').toLowerCase();
  const known = STATUS_COLORS[status];
  return (
    <span
      className={`status-pill ${known ? `status-${key}` : ''}`}
      style={small ? { fontSize: 9, padding: '2px 8px', letterSpacing: 0 } : undefined}
    >
      {status === 'Delivered' ? '✓ Delivered' : (status || 'Pending')}
    </span>
  );
}

function Card({ title, titleEn, actions, children, style }) {
  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, padding:'16px', minWidth:0, ...style }}>
      {(title || actions) && (
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:14, gap:8, flexWrap:'wrap' }}>
          <div>
            {title && <h3 style={{ fontSize:13, fontWeight:600, color:'var(--text)' }}>{title}</h3>}
            {titleEn && <p style={{ fontSize:10, color:'var(--text3)', marginTop:1 }}>{titleEn}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

function DashEmpty({ icon:Icon, title, hint, action }) {
  return (
    <div style={{ textAlign:'center', padding:'30px 16px' }}>
      <div style={{ width:44, height:44, borderRadius:10, background:'var(--bg3)', border:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 10px' }}>
        <Icon size={18} color="var(--text3)" />
      </div>
      <p style={{ fontSize:13, fontWeight:600, color:'var(--text2)' }}>{title}</p>
      {hint && <p style={{ fontSize:11, color:'var(--text3)', marginTop:4 }}>{hint}</p>}
      {action}
    </div>
  );
}

function KpiDelta({ pct }) {
  if (pct === null || pct === undefined) return null;
  const up = pct >= 0;
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:3, fontSize:10, fontWeight:600, padding:'2px 7px', borderRadius:10, background: up ? 'rgba(39,174,96,0.12)' : 'rgba(231,76,60,0.12)', color: up ? '#27ae60' : '#e74c3c' }}>
      {up ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
      {Math.abs(pct)}%
    </span>
  );
}
const SIDEBAR = [
  { id:'dashboard', label:'Dashboard', icon:LayoutDashboard, perm:'dashboard.read' },
  { id:'orders', label:'Orders', icon:ShoppingCart, perm:'orders.read', badge:'pending' },
  { id:'products', label:'Products', icon:Package, perm:'products.read' },
  { id:'discounts', label:'Discounts', icon:Tag, perm:'discounts.read' },
  { id:'analytics', label:'Analytics', icon:BarChart2, perm:'analytics.read' },
  { id:'users', label:'Users', icon:Users, perm:'users.read' },
];

export default function AdminApp() {
  const { session, logout, canAccess, loading: authLoading } = useAuth();
  const { adminPage, setAdminPage, setPage, orders, unreadOrderCount, markNotificationsRead, getNotifications, newOrderNotification, refreshOrders, refreshDiscounts } = useStore();
  const [collapsed, setCollapsed] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [orderToOpen, setOrderToOpen] = useState(null);
  const [productToAdd, setProductToAdd] = useState(false);

  useEffect(() => { setPageMeta({ title: 'Admin Panel', description: 'ZASHM Admin Dashboard' }); }, []);

  // Reset to the dashboard whenever the signed-in identity changes, so a page
  // left open by a previous (more privileged) session is never shown.
  useEffect(() => { setAdminPage('dashboard'); }, [session?.userId, setAdminPage]);

  // Guard: never render a page the current role cannot access. Falls back to the
  // first page the role CAN see (so roles without dashboard.read still land
  // somewhere valid).
  useEffect(() => {
    if (!session) return;
    if (!canAccess(adminPage)) {
      const fallback = SIDEBAR.find((s) => canAccess(s.id));
      setAdminPage(fallback ? fallback.id : 'dashboard');
    }
  }, [session, adminPage, canAccess, setAdminPage]);

  useEffect(() => {
    if (!newOrderNotification) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 1100, 1320].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.1);
        gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + i * 0.1 + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.1 + 0.3);
        osc.start(ctx.currentTime + i * 0.1);
        osc.stop(ctx.currentTime + i * 0.1 + 0.3);
      });
    } catch(e) {}
  }, [newOrderNotification]);

  // Keep orders + coupons fresh without a manual refresh while the console is open.
  useEffect(() => {
    if (!session) return;
    const ordersId = setInterval(() => { refreshOrders(true); }, 10000);
    const discountsId = setInterval(() => { refreshDiscounts(); }, 60000);
    return () => { clearInterval(ordersId); clearInterval(discountsId); };
  }, [session, refreshOrders, refreshDiscounts]);

  if (authLoading) return (
    <div style={{ height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--bg)' }}>
      <motion.div animate={{ rotate:360 }} transition={{ duration:1, repeat:Infinity, ease:'linear' }}
        style={{ width:32, height:32, border:'2px solid var(--border)', borderTopColor:'var(--gold)', borderRadius:'50%' }} />
    </div>
  );

  if (!session) return (
    <AdminLogin 
      onSuccess={() => {}} 
    />
  );

  const accessiblePages = SIDEBAR.filter(s => canAccess(s.id));
  const pendingCount = orders.filter(o => o.status === 'Pending').length;
  const notifications = getNotifications().slice(0, 8);

  const SidebarContent = ({ isMobile = false }) => (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>
      <div style={{ padding:'20px 14px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:10 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, cursor: isMobile ? 'default' : 'pointer' }} onClick={() => !isMobile && setCollapsed(!collapsed)}>
          <div style={{ width:36, height:36, background:'linear-gradient(135deg, var(--gold-dark), var(--gold))', borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <span style={{ fontFamily:'var(--font-display)', fontSize:16, fontWeight:700, color:'var(--bg)' }}>Z</span>
          </div>
          {(!collapsed || isMobile) && <div>
            <span style={{ fontFamily:'var(--font-display)', fontSize:17, fontWeight:600, letterSpacing:3 }} className="shimmer-text">ZASHM</span>
            <p style={{ fontSize:9, color:'var(--text3)', letterSpacing:1, textTransform:'uppercase' }}>Admin Console</p>
          </div>}
        </div>
        {isMobile && (
          <button onClick={() => setMobileMenuOpen(false)} style={{ background:'none', border:'none', color:'var(--text2)', cursor:'pointer' }}>
            <X size={20} />
          </button>
        )}
      </div>

      {(!collapsed || isMobile) && (
        <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--border)', background:'rgba(201,168,76,0.04)' }}>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <div style={{ width:28, height:28, borderRadius:'50%', background:'linear-gradient(135deg, var(--gold-dark), var(--gold))', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700, color:'var(--bg)', flexShrink:0 }}>
              {session.name?.[0] || 'A'}
            </div>
            <div style={{ minWidth:0 }}>
              <p style={{ fontSize:12, fontWeight:500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{session.name}</p>
              <p style={{ fontSize:10, color:'var(--gold)', textTransform:'capitalize' }}>{session.role}</p>
            </div>
          </div>
        </div>
      )}

      <nav style={{ flex:1, padding:'10px 8px', overflowY:'auto' }}>
        {accessiblePages.map(({ id, label, icon:Icon, badge }) => {
          const active = adminPage === id;
          const badgeCount = badge === 'pending' ? pendingCount : 0;
          const showText = !collapsed || isMobile;
          return (
            <motion.button key={id} onClick={() => { setAdminPage(id); if(isMobile) setMobileMenuOpen(false); }}
              style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding: (!showText) ? '10px 14px' : '10px 12px', borderRadius:6, marginBottom:2, background: active ? 'rgba(201,168,76,0.12)' : 'transparent', color: active ? 'var(--gold)' : 'var(--text2)', border: `1px solid ${active ? 'rgba(201,168,76,0.2)' : 'transparent'}`, cursor:'pointer', transition:'all 0.15s', justifyContent: (!showText) ? 'center' : 'flex-start', position:'relative' }}
              whileHover={{ color:'var(--gold)', background:'rgba(201,168,76,0.07)' }}>
              <Icon size={17} style={{ flexShrink:0 }} />
              {showText && <span style={{ fontSize:13, fontWeight:500, whiteSpace:'nowrap' }}>{label}</span>}
              {showText && badgeCount > 0 && <span style={{ marginLeft:'auto', background:'var(--gold)', color:'var(--bg)', borderRadius:10, padding:'1px 7px', fontSize:10, fontWeight:700 }}>{badgeCount}</span>}
              {!showText && badgeCount > 0 && <span style={{ position:'absolute', top:6, right:6, width:8, height:8, background:'var(--gold)', borderRadius:'50%' }} />}
            </motion.button>
          );
        })}
      </nav>

      <div style={{ padding:'10px 8px', borderTop:'1px solid var(--border)' }}>
        <button onClick={() => { setPage('home'); if(isMobile) setMobileMenuOpen(false); }} style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding: (!collapsed || isMobile) ? '10px 12px' : '10px 14px', borderRadius:6, color:'var(--text3)', background:'none', border:'none', cursor:'pointer', justifyContent: (!collapsed || isMobile) ? 'flex-start' : 'center' }}>
          <Package2 size={17} />
          {(!collapsed || isMobile) && <span style={{ fontSize:13 }}>View Store</span>}
        </button>
        <button onClick={logout} style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding: (!collapsed || isMobile) ? '10px 12px' : '10px 14px', borderRadius:6, color:'var(--text3)', background:'none', border:'none', cursor:'pointer', justifyContent: (!collapsed || isMobile) ? 'flex-start' : 'center' }}>
          <LogOut size={17} />
          {(!collapsed || isMobile) && <span style={{ fontSize:13 }}>Sign Out</span>}
        </button>
      </div>
    </div>
  );

  return (
    <div className="admin-container" style={{ display:'flex', minHeight:'100vh', background:'var(--bg)', flexDirection: 'row' }}>
      <motion.aside 
        animate={{ width: collapsed ? 64 : 230 }}
        className="hidden-mobile"
        style={{ background:'var(--bg2)', borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', position:'sticky', top:0, height:'100vh', overflow:'hidden', flexShrink:0 }}
      >
        <SidebarContent isMobile={false} />
      </motion.aside>

      <AnimatePresence>
        {mobileMenuOpen && (
          <>
            <motion.div 
              initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }} onClick={() => setMobileMenuOpen(false)}
              style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:2999, backdropFilter:'blur(4px)' }} 
            />
            <motion.div 
              initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
              transition={{ type:'spring', damping:25, stiffness:200 }}
              style={{ position:'fixed', left:0, top:0, bottom:0, width:260, background:'var(--bg2)', zIndex:3000, borderRight:'1px solid var(--border)', boxShadow:'10px 0 30px rgba(0,0,0,0.5)' }}
            >
              <SidebarContent isMobile={true} />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <main style={{ flex:1, overflow:'hidden', minWidth:0, display:'flex', flexDirection:'column' }}>
        <div style={{ position:'sticky', top:0, zIndex:100, background:'rgba(10,10,10,0.95)', backdropFilter:'blur(12px)', borderBottom:'1px solid var(--border)', padding:'14px 16px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <button 
              className="show-mobile-flex" onClick={() => setMobileMenuOpen(true)}
              style={{ background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--text2)', width:36, height:36, borderRadius:8, alignItems:'center', justifyContent:'center', cursor:'pointer' }}
            >
              <Menu size={18} />
            </button>
            <h1 style={{ fontFamily:'var(--font-display)', fontSize:20, fontWeight:500, textTransform:'capitalize' }}>{adminPage}</h1>
          </div>
          
          <div style={{ display:'flex', gap:10, alignItems:'center' }}>
            <AnimatePresence>
              {newOrderNotification && (
                <motion.div initial={{ opacity:0, scale:0.8, x:20 }} animate={{ opacity:1, scale:1, x:0 }} exit={{ opacity:0, scale:0.8, x:20 }}
                  style={{ background:'rgba(201,168,76,0.1)', border:'1px solid var(--border-gold)', borderRadius:6, padding:'6px 12px', display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}
                  onClick={() => { setAdminPage('orders'); }}>
                  <motion.div animate={{ scale:[1,1.3,1] }} transition={{ repeat:2, duration:0.3 }} style={{ width:8, height:8, borderRadius:'50%', background:'var(--gold)' }} />
                  <span style={{ color:'var(--gold)', fontSize:12, fontWeight:600 }} className="hidden-mobile">New order: {newOrderNotification.order?.id}</span>
                </motion.div>
              )}
            </AnimatePresence>

            <div style={{ position:'relative' }}>
              <motion.button onClick={() => { setNotifOpen(!notifOpen); markNotificationsRead(); }}
                style={{ width:38, height:38, borderRadius:8, background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--text2)', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', position:'relative' }}
                whileHover={{ color:'var(--gold)' }}>
                <Bell size={16} />
                {unreadOrderCount > 0 && (
                  <motion.span initial={{ scale:0 }} animate={{ scale:1 }}
                    style={{ position:'absolute', top:-4, right:-4, width:18, height:18, borderRadius:'50%', background:'var(--gold)', color:'var(--bg)', fontSize:9, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center' }}>
                    {unreadOrderCount > 9 ? '9+' : unreadOrderCount}
                  </motion.span>
                )}
              </motion.button>
              <AnimatePresence>
                {notifOpen && (
                  <>
                    <div onClick={() => setNotifOpen(false)} style={{ position:'fixed', inset:0, zIndex:200 }} />
                    <motion.div initial={{ opacity:0, y:-10, scale:0.95 }} animate={{ opacity:1, y:0, scale:1 }} exit={{ opacity:0, y:-10, scale:0.95 }}
                      style={{ position:'absolute', top:'100%', right:0, marginTop:8, width:290, background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, boxShadow:'0 12px 40px rgba(0,0,0,0.5)', zIndex:300, overflow:'hidden' }}>
                      <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                        <span style={{ fontSize:13, fontWeight:600 }}>Notifications</span>
                        <span style={{ fontSize:11, color:'var(--text3)' }}>{notifications.length} recent</span>
                      </div>
                      <div style={{ maxHeight:320, overflowY:'auto' }}>
                        {notifications.length === 0 ? (
                          <p style={{ padding:20, textAlign:'center', color:'var(--text3)', fontSize:13 }}>No notifications</p>
                        ) : notifications.map(n => (
                          <div key={n.id} style={{ padding:'12px 16px', borderBottom:'1px solid var(--border)', cursor:'pointer' }}
                            onClick={() => { setAdminPage('orders'); setNotifOpen(false); }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
                              <span style={{ fontSize:12, fontWeight:600, color:'var(--gold)' }}>New Order</span>
                              <span style={{ fontSize:10, color:'var(--text3)' }}>{new Date(n.timestamp).toLocaleTimeString()}</span>
                            </div>
                            <p style={{ fontSize:12, color:'var(--text2)' }}>{n.customer} — EGP {n.total?.toLocaleString()}</p>
                            <p style={{ fontSize:11, color:'var(--text3)' }}>{n.orderId}</p>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  </>
                )}
</AnimatePresence>
            </div>
          </div>
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:'16px', WebkitOverflowScrolling:'touch' }}>
          <AnimatePresence mode="wait">
            <motion.div key={adminPage} initial={{ opacity:0, y:12 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-12 }} transition={{ duration:0.25 }}>
              {adminPage === 'dashboard' && canAccess('dashboard') && <Dashboard setAdminPage={setAdminPage} canAccess={canAccess} onOpenOrder={(id) => { setOrderToOpen(id); setAdminPage('orders'); }} onAddProduct={() => { setProductToAdd(true); setAdminPage('products'); }} />}
              {adminPage === 'orders' && canAccess('orders') && <OrdersPanel canEdit={canAccess('orders.write')} preOpenOrderId={orderToOpen} onOrderOpened={() => setOrderToOpen(null)} />}
              {adminPage === 'products' && canAccess('products') && <ProductsPanel canEdit={canAccess('products.write')} preOpenNew={productToAdd} onNewOpened={() => setProductToAdd(false)} />}
              {adminPage === 'discounts' && canAccess('discounts') && <DiscountsPanel canEdit={canAccess('discounts.write')} />}
              {adminPage === 'analytics' && canAccess('analytics') && <AnalyticsPanel />}

              {adminPage === 'users' && canAccess('users') && <UsersPanel />}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function SalesTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background:'#0d0d0d', border:'1px solid var(--border)', borderRadius:6, padding:'8px 10px', fontSize:11, boxShadow:'0 8px 24px rgba(0,0,0,0.5)' }}>
      <p style={{ color:'var(--text3)', marginBottom:4 }}>{label}</p>
      {payload.map((p) => (
        <p key={String(p.dataKey)} style={{ color: p.color || 'var(--text)', display:'flex', justifyContent:'space-between', gap:14 }}>
          <span>{p.name}</span>
          <strong>{String(p.dataKey) === 'value' ? fmtEGP(p.value) : `${p.value} order${p.value === 1 ? '' : 's'}`}</strong>
        </p>
      ))}
    </div>
  );
}

function DashSkeleton() {
  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:12, marginBottom:20 }}>
        {[...Array(8)].map((_, i) => (
          <div key={i} className="admin-skeleton" style={{ height:92, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10 }} />
        ))}
      </div>
      <div className="admin-skeleton" style={{ height:320, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10 }} />
    </div>
  );
}

function Dashboard({ setAdminPage, canAccess, onOpenOrder, onAddProduct }) {
  const { orders, products, refreshOrders, ordersLoading, ordersError } = useStore();

  const [range, setRange] = useState('7d');

  useEffect(() => {
    if (!Array.isArray(orders) || orders.length === 0) refreshOrders();
    // run once on mount to hydrate the dashboard
  }, []);

  const overview = useMemo(() => computeSalesOverview(orders, range), [orders, range]);
  const inventory = useMemo(() => classifyInventory(products), [products]);

  const recentOrders = useMemo(() => {
    const list = Array.isArray(orders) ? [...orders] : [];
    return list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 6);
  }, [orders]);

  const attentionOrders = useMemo(() => (Array.isArray(orders) ? orders : []).filter(o => o.status === 'Pending').slice(0, 4), [orders]);

  const isEmpty = overview.orderCount === 0;
  const loading = ordersLoading && Array.isArray(orders) && orders.length === 0;

  const rangeLabel = RANGE_OPTIONS.find((r) => r.key === range);

  const kpis = [
    { key: 'totalValue', labelAr: 'قيمة الطلبات الإجمالية', labelEn: 'Total Order Value', value: fmtEGP(overview.totalValue), sub: `${overview.orderCount} non-cancelled orders`, color: 'var(--gold)', icon: TrendingUp, delta: overview.totalDeltaPct },
    { key: 'delivered', labelAr: 'مبيعات الطلبات المسلّمة', labelEn: 'Delivered Sales', value: fmtEGP(overview.deliveredSales), sub: `${overview.deliveredCount} delivered`, color: '#27ae60', icon: CheckCircle },
    { key: 'pending', labelAr: 'قيمة بانتظار التأكيد', labelEn: 'Pending Order Value', value: fmtEGP(overview.pendingValue), sub: `${overview.pendingCount} in confirmation/processing`, color: '#f39c12', icon: Clock },
    { key: 'shipped', labelAr: 'قيمة الطلبات المشحونة', labelEn: 'Shipped Order Value', value: fmtEGP(overview.shippedValue), sub: `${overview.shippedCount} shipped`, color: '#3498db', icon: Truck },
    { key: 'orders', labelAr: 'إجمالي الطلبات', labelEn: 'Total Orders', value: String(overview.orderCount), sub: 'all statuses', color: 'var(--text)', icon: ShoppingCart, delta: overview.orderDeltaPct },
    { key: 'deliveredCount', labelAr: 'طلبات مسلّمة', labelEn: 'Delivered Orders', value: String(overview.deliveredCount), sub: `of ${overview.orderCount} total`, color: '#27ae60', icon: Package2 },
    { key: 'aov', labelAr: 'متوسط قيمة الطلب', labelEn: 'Average Order Value', value: fmtEGP(overview.aov), sub: 'per eligible order', color: '#9b59b6', icon: BarChart2 },
    { key: 'cancelled', labelAr: 'الطلبات الملغاة', labelEn: 'Cancelled Orders', value: fmtEGP(overview.cancelledValue), sub: `${overview.cancelledCount} cancelled (excluded everywhere)`, color: '#e74c3c', icon: XCircle },
  ];

  const hasSeriesData = !isEmpty && overview.series.some((p) => p.value > 0 || p.orders > 0);

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-end', marginBottom:16, gap:10, flexWrap:'wrap' }}>
        <div>
          <h2 style={{ fontSize:18, fontWeight:600, marginBottom:2 }}>نظرة عامة</h2>
          <p style={{ fontSize:11, color:'var(--text3)' }}>
            Overview · {rangeLabel ? `${rangeLabel.labelAr} (${rangeLabel.labelEn})` : ''} — up to {overview.orderCount} orders
          </p>
        </div>
        <motion.button onClick={refreshOrders} whileTap={{ scale:0.95 }} disabled={ordersLoading}
          style={{ display:'flex', gap:6, alignItems:'center', padding:'8px 14px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:6, color:'var(--text2)', cursor:'pointer', fontSize:12, opacity: ordersLoading ? 0.7 : 1 }}>
          <motion.span animate={{ rotate: ordersLoading ? 360 : 0 }} transition={{ duration: 0.6, repeat: ordersLoading ? Infinity : 0, ease: 'linear' }} style={{ display:'flex' }}>
            <RefreshCw size={13} />
          </motion.span>
          {ordersLoading ? 'Loading…' : 'Refresh'}
        </motion.button>
      </div>

      {ordersError && !loading && (
        <div style={{ marginBottom:16, border:'1px solid rgba(231,76,60,0.35)', background:'rgba(231,76,60,0.07)', borderRadius:8, padding:'10px 14px', display:'flex', justifyContent:'space-between', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          <p style={{ fontSize:12, color:'#e74c3c', display:'flex', alignItems:'center', gap:6 }}>
            <AlertCircle size={14} /> تعذّر تحميل الطلبات — {ordersError}
          </p>
          <button onClick={refreshOrders} style={{ padding:'5px 12px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, color:'var(--text2)', cursor:'pointer', fontSize:11 }}>
            Retry
          </button>
        </div>
      )}

      {loading ? <DashSkeleton /> : (
        <>
          {/* ── KPIs ── */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(170px, 1fr))', gap:12, marginBottom:18 }}>
            {kpis.map(({ labelAr, labelEn, value, sub, color, icon:Icon, delta }, i) => (
              <motion.div key={labelEn} initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }} transition={{ delay:i*0.04 }}
                style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10, padding:'14px 14px 12px', display:'flex', flexDirection:'column' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                  <div style={{ width:30, height:30, borderRadius:8, background:`${color === 'var(--text)' ? '#2a2a2a' : color}1a`, display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <Icon size={15} color={color === 'var(--text)' ? 'var(--text2)' : color} />
                  </div>
                  {delta !== undefined && <KpiDelta pct={delta} />}
                </div>
                <div dir="ltr" style={{ fontSize:19, fontWeight:600, fontFamily:'var(--font-display)', color, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{value}</div>
                <p style={{ fontSize:12, fontWeight:600, marginTop:3 }}>{labelAr}</p>
                <p style={{ fontSize:10, color:'var(--text3)', marginTop:1 }}>{labelEn} · {sub}</p>
              </motion.div>
            ))}
          </div>

          {/* ── Quick actions ── */}
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:18 }}>
            <button onClick={() => setAdminPage('orders')} style={quickActionStyle}><ShoppingCart size={14} /> عرض كل الطلبات</button>
            {canAccess('products.write') && <button onClick={() => onAddProduct()} style={quickActionStyle}><Plus size={14} /> إضافة منتج</button>}
            {canAccess('products.read') && <button onClick={() => setAdminPage('products')} style={quickActionStyle}><Package size={14} /> إدارة المخزون</button>}
            {canAccess('discounts.read') && <button onClick={() => setAdminPage('discounts')} style={quickActionStyle}><Tag size={14} /> كوبونات الخصم</button>}
          </div>

          {/* ── Sales performance ── */}
          <Card
            title={rangeLabel ? rangeLabel.labelAr : 'أداء المبيعات'}
            titleEn="Sales Performance"
            style={{ marginBottom: 16 }}
            actions={
              <div style={{ display:'flex', gap:2, background:'var(--bg)', padding:2, borderRadius:6, border:'1px solid var(--border)', overflowX:'auto' }}>
                {RANGE_OPTIONS.map((r) => (
                  <button key={r.key} onClick={() => setRange(r.key)}
                    style={{ padding:'4px 10px', borderRadius:4, fontSize:10, fontWeight:600, cursor:'pointer', border:'none', background: range === r.key ? 'var(--gold)' : 'transparent', color: range === r.key ? 'var(--bg)' : 'var(--text3)', whiteSpace:'nowrap' }}>
                    {r.labelEn}
                  </button>
                ))}
              </div>
            }
          >
            <div style={{ width:'100%', height:270 }}>
              {hasSeriesData ? (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={overview.series} margin={{ left: -14, right: 4, top: 8 }}>
                    <defs>
                      <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#c9a84c" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#c9a84c" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fill:'var(--text3)', fontSize:10 }} axisLine={false} tickLine={false} />
                    <YAxis yAxisId="left" orientation="left" tickFormatter={compactEGP} tick={{ fill:'var(--text3)', fontSize:10 }} axisLine={false} tickLine={false} />
                    <YAxis yAxisId="right" orientation="right" allowDecimals={false} tick={{ fill:'var(--text3)', fontSize:10 }} axisLine={false} tickLine={false} />
                    <Tooltip content={<SalesTooltip />} />
                    <Legend wrapperStyle={{ fontSize:11, color:'var(--text2)', marginTop:8 }} iconType="circle" iconSize={7} />
                    <Area yAxisId="left" type="monotone" dataKey="value" name="Sales (EGP)" stroke="#c9a84c" strokeWidth={2} fill="url(#salesGrad)" dot={false} activeDot={{ r: 3 }} />
                    <Bar yAxisId="right" dataKey="orders" name="Orders" fill="#3b82c4" radius={[3,3,0,0]} barSize={Math.max(6, Math.min(30, Math.round(320 / (overview.series.length || 1))))} />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <DashEmpty icon={BarChart2} title="لا توجد طلبات في هذه الفترة"
                  hint="اختر نطاق زمني آخر من الأعلى أو انتظر وصول أول طلب."
                  action={canAccess('orders.read') ? <button onClick={() => setAdminPage('orders')} style={{ marginTop:10, padding:'6px 14px', background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--gold)', borderRadius:6, cursor:'pointer', fontSize:11 }}>عرض الطلبات</button> : null} />
              )}
            </div>

            <div style={{ display:'flex', gap:14, flexWrap:'wrap', marginTop:12, paddingTop:12, borderTop:'1px solid var(--border)', fontSize:11, color:'var(--text3)' }}>
              <span>Sales = Total Order Value (غير الملغي: بانتظار/مؤكد/معالج/شُحن/سلّم). الدفع عند الاستلام (COD) — لا يُعدّ تحصيلاً نقدياً.</span>
              {overview.prevTotalValue === null ? (
                <span style={{ color:'var(--text2)' }}>— لا توجد فترة سابقة للمقارنة {range === 'all' ? '(all-time)' : ''}</span>
              ) : (
                <span style={{ color:'var(--text2)', display:'inline-flex', alignItems:'center', gap:4 }}>
                  مقارنة بـ{overview.prevLabel}: <strong dir="ltr">{fmtEGP(overview.prevTotalValue)}</strong>
                  {overview.totalDeltaPct !== null && <KpiDelta pct={overview.totalDeltaPct} />}
                  {overview.totalDeltaPct === null && overview.prevTotalValue === 0 && <span>— فترة سابقة بلا طلبات</span>}
                </span>
              )}
            </div>
          </Card>

          {/* ── Recent orders + store health ── */}
          <div className="admin-dash-split" style={{ display:'grid', gridTemplateColumns:'minmax(0, 2fr) minmax(280px, 1fr)', gap:16, alignItems:'start' }}>
            <Card title="أحدث الطلبات" titleEn="Recent Orders"
              actions={<button onClick={() => setAdminPage('orders')} style={linkActionStyle}>عرض كل الطلبات ←</button>}
              style={{ overflow:'hidden' }}>
              {recentOrders.length === 0 ? (
                <DashEmpty icon={ShoppingCart} title="لا توجد طلبات بعد"
                  hint={canAccess('orders.read') ? 'اول طلب سيظهر هنا فور وصوله.' : null} />
              ) : (
                <div>
                  <div style={{ display:'none' }}>
                    {/* header kept hidden; compact rows below */}
                  </div>
                  {recentOrders.map((o) => (
                    <motion.div key={o.id} initial={{ opacity:0 }} animate={{ opacity:1 }}
                      style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 4px', borderBottom:'1px solid var(--border)', flexWrap:'wrap' }}>
                      <div style={{ minWidth:0, flex:1, minWidth:150 }}>
                        <p style={{ fontFamily:'monospace', fontSize:11, color:'var(--gold)', fontWeight:700 }}>{o.id}</p>
                        <p style={{ fontSize:11, color:'var(--text2)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:240 }}>{o.customer}</p>
                        <p style={{ fontSize:10, color:'var(--text3)' }}>{o.date}</p>
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <strong dir="ltr" style={{ fontSize:12, color:'var(--text)' }}>{fmtEGP(o.total)}</strong>
                        <StatusBadge status={o.status} small />
                        <button onClick={() => onOpenOrder(o.id)} title="Open order" aria-label="Open order"
                          style={{ width:28, height:28, borderRadius:6, background:'var(--bg4)', border:'1px solid var(--border)', color:'var(--text2)', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
                          <Eye size={12} />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </Card>

            <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
              <Card title="صحة المخزون" titleEn="Store Health">
                {inventory.outOfStock.length === 0 && inventory.lowStock.length === 0 ? (
                  <div style={{ display:'flex', alignItems:'center', gap:8, color:'#27ae60', fontSize:12, padding:'4px 0' }}>
                    <CheckCircle size={15} /> كل المنتجات متاحة بمخزون جيد
                  </div>
                ) : (
                  <div>
                    {inventory.outOfStock.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <p style={{ fontSize:10, color:'var(--red)', fontWeight:600, marginBottom:4, textTransform:'uppercase', letterSpacing:0.5 }}>
                          {inventory.outOfStock.length} نفدت من المخزون (Out of stock)
                        </p>
                        {inventory.outOfStock.slice(0,4).map((p) => (
                          <div key={p.id} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', fontSize:11 }}>
                            <span style={{ color:'var(--text2)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', marginRight:8 }}>{p.name}</span>
                            <span style={{ color:'var(--red)', fontWeight:700 }}>OUT</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {inventory.lowStock.length > 0 && (
                      <div>
                        <p style={{ fontSize:10, color:'#f39c12', fontWeight:600, marginBottom:4, textTransform:'uppercase', letterSpacing:0.5 }}>
                          {inventory.lowStock.length} بكمية منخفضة (≤ 5)
                        </p>
                        {inventory.lowStock.slice(0,4).map((p) => (
                          <div key={p.id} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', fontSize:11 }}>
                            <span style={{ color:'var(--text2)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', marginRight:8 }}>{p.name}</span>
                            <span style={{ color:'#f39c12', fontWeight:700 }}>{p.stock} left</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div style={{ marginTop: 12, paddingTop: 12, borderTop:'1px solid var(--border)' }}>
                  <p style={{ fontSize:10, color:'var(--text3)', fontWeight:600, marginBottom:8, textTransform:'uppercase', letterSpacing:0.5 }}>بانتظار التأكيد</p>
                  {attentionOrders.length === 0 ? (
                    <p style={{ fontSize:12, color:'#27ae60', display:'flex', alignItems:'center', gap:6 }}><CheckCircle size={14} /> لا توجد طلبات معلّقة</p>
                  ) : attentionOrders.map((o) => (
                    <div key={o.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 0', fontSize:11 }}>
                      <span style={{ color:'var(--text2)', fontFamily:'monospace' }}>{o.id}</span>
                      <strong dir="ltr" style={{ color:'var(--gold)' }}>{fmtEGP(o.total)}</strong>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const quickActionStyle = { display:'flex', gap:7, alignItems:'center', padding:'7px 13px', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, color:'var(--text2)', cursor:'pointer', fontSize:12, transition:'all 0.15s' };
const linkActionStyle = { background:'none', border:'none', color:'var(--gold)', cursor:'pointer', fontSize:11, fontWeight:600, padding:0 };

// ─── ORDERS PANEL ─────────────────────────────────────────────────────────────
function OrdersPanel({ canEdit, preOpenOrderId, onOrderOpened }) {
  const { orders, updateOrderStatus } = useStore();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState(1);
  const PER_PAGE = 15;

  // 🎯 الحالات (States) الجديدة الخاصة بسجل العميل المتكرر الـ VIP
  const [selectedCustomerPhone, setSelectedCustomerPhone] = useState(null);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [copied, setCopied] = useState(false); // حالة لإشعار النسخ

  const handleStatusChange = async (id, status) => {
    const res = await updateOrderStatus(id, status);
    if (res && res.success === false) {
      toast.error(res.error || 'تعذر تحديث حالة الطلب، حاول مرة أخرى.');
    }
  };

  useEffect(() => {
    if (!preOpenOrderId) return;
    const target = (orders || []).find(o => o.id === preOpenOrderId);
    if (target) setSelected(target);
    if (onOrderOpened) onOrderOpened();
  }, [preOpenOrderId, orders, onOrderOpened]);

  useEffect(() => {
    if (!selected) return;
    const updated = (orders || []).find(o => o.id === selected.id);
    if (updated) setSelected(updated);
  }, [orders, selected?.id]);

  // 🎯 دوال فحص وتجميع طلبات العميل المتكرر بناءً على رقم التليفون
  const getCustomerOrderCount = useCallback((phone) => {
    if (!phone) return 1;
    return (orders || []).filter(o => o.phone === phone).length;
  }, [orders]);

  const getCustomerPreviousOrders = useCallback((phone) => {
    if (!phone) return [];
    return (orders || []).filter(o => o.phone === phone);
  }, [orders]);

  const handleShowCustomerHistory = (phone) => {
    setSelectedCustomerPhone(phone);
    setShowHistoryModal(true);
  };

  // دالة نسخ الرابط
  const handleCopyLink = (url) => {
    if (!url) return;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const filtered = useMemo(() => {
    let list = [...(orders || [])];
    if (statusFilter !== 'All') list = list.filter(o => o.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(o => {
        return ((o.customer ?? '').toLowerCase().includes(q) || (o.id ?? '').toLowerCase().includes(q) || (o.phone ?? '').toString().includes(q) || (o.phoneAlt ?? '').toString().includes(q));
      });
    }
    return list;
  }, [orders, statusFilter, search]);

  const paginated = paginate(filtered, page, PER_PAGE);

  const exportCSV = () => {
    const rows = [['ID','Customer','Phone','Alternate Phone','Email','Items','Subtotal','Discount','Total','Status','Date','Address'],
      ...filtered.map(o => [o.id, o.customer, o.phone, o.phoneAlt||'', o.email||'', o.items.length, o.subtotal, o.discount||0, o.total, o.status, o.date, o.address])];
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv); a.download = `zashm-orders-${new Date().toISOString().split('T')[0]}.csv`; a.click();
  };

  return (
    <div>
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap', alignItems:'center' }}>
        <div style={{ position:'relative', flex:1, minWidth:200 }}>
          <Search size={13} style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', color:'var(--text3)' }} />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search..." style={{ width:'100%', paddingLeft:34 }} />
        </div>
        <div style={{ display:'flex', gap:4, overflowX:'auto', paddingBottom:4, width:'100%', WebkitOverflowScrolling:'touch' }}>
          {['All','Pending','Confirmed','Processing','Shipped','Delivered','Cancelled'].map(s => (
            <button key={s} onClick={() => { setStatusFilter(s); setPage(1); }}
              style={{ padding:'6px 12px', borderRadius:4, fontSize:11, fontWeight:500, background: statusFilter === s ? (s === 'All' ? 'var(--gold)' : STATUS_COLORS[s]) : 'var(--bg3)', color: statusFilter === s ? (s === 'All' ? 'var(--bg)' : 'white') : 'var(--text2)', border:'none', cursor:'pointer', whiteSpace:'nowrap' }}>
              {s} {s !== 'All' && `(${orders.filter(o => o.status === s).length})`}
            </button>
          ))}
        </div>
        <button onClick={exportCSV}
          style={{ display:'flex', gap:6, alignItems:'center', padding:'8px 14px', background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--text2)', borderRadius:6, cursor:'pointer', fontSize:12, marginLeft:'auto' }}>
          <Download size={13} /> Export CSV
        </button>
      </div>

      <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, overflow:'hidden' }}>
        <div style={{ overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ borderBottom:'1px solid var(--border)', background:'var(--bg3)' }}>
                {['Order ID','Customer','Items','Total','Status','Date','Actions'].map(h => (
                  <th key={h} style={{ padding:'11px 14px', textAlign:'left', fontSize:10, fontWeight:600, color:'var(--text3)', letterSpacing:1, textTransform:'uppercase', whiteSpace:'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginated.items.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: '8px' }}>
                    <DashEmpty
                      icon={ShoppingCart}
                      title={search.trim() || statusFilter !== 'All' ? 'لا توجد طلبات مطابقة' : 'لا توجد طلبات بعد'}
                      hint={search.trim() || statusFilter !== 'All' ? 'جرّب تغيير كلمة البحث أو الفلتر.' : 'ستظهر الطلبات الجديدة هنا تلقائياً.'}
                    />
                  </td>
                </tr>
              )}
              {paginated.items.map(order => {
                const orderCount = getCustomerOrderCount(order.phone);
                return (
                  <motion.tr key={order.id} initial={{ opacity:0 }} animate={{ opacity:1 }}
                    style={{ borderBottom:'1px solid var(--border)', transition:'background 0.1s' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ padding:'11px 14px', fontSize:12, color:'var(--gold)', fontWeight:700, fontFamily:'monospace', verticalAlign: 'top' }}>{order.id}</td>
                    <td style={{ padding:'11px 14px', verticalAlign: 'top', whiteSpace:'nowrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <p style={{ fontSize:12, fontWeight:500 }}>{order.customer}</p>
                        
                        {/* 🎯 الـ Badge الذهبي للعميل المتكرر */}
                        {orderCount > 1 && (
                          <span 
                            onClick={() => handleShowCustomerHistory(order.phone)}
                            style={{
                              padding: '1px 6px',
                              background: 'rgba(212, 175, 55, 0.12)',
                              color: 'var(--gold)',
                              borderRadius: 10,
                              fontSize: 10,
                              fontWeight: 700,
                              cursor: 'pointer',
                              border: '1px solid rgba(201, 168, 76, 0.25)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 2,
                              userSelect: 'none'
                            }}
                            title="اضغط لعرض سجل الأوردرات والتواصل"
                          >
                            🔥 VIP ({orderCount})
                          </span>
                        )}
                      </div>
                      <p style={{ fontSize:10, color:'var(--text3)', marginTop: 4 }}>📞 {order.phone}</p>
                      {order.phoneAlt && <p style={{ fontSize:10, color:'var(--gold)', marginTop:2 }}>📱 {order.phoneAlt} (بديل)</p>}
                    </td>
                    
                    <td style={{ padding:'11px 14px', verticalAlign: 'top', minWidth: '220px' }}>
                      <div style={{ fontSize:11, color:'var(--gold)', fontWeight: 700, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        📦 {order.items?.length || 0} item{order.items?.length > 1 ? 's' : ''}:
                      </div>
                      {order.items && order.items.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {order.items.map((item, idx) => {
                            const details = [];
                            if (item.size) details.push(item.size);
                            if (item.color) details.push(item.color);
                            const specsStr = details.length > 0 ? ` (${details.join(' / ')})` : '';

                            return (
                              <div key={idx} style={{ fontSize:11, lineHeight:'1.4', borderBottom: idx < order.items.length - 1 ? '1px dashed var(--border)' : 'none', paddingBottom: idx < order.items.length - 1 ? '4px' : '0' }}>
                                <span style={{ fontWeight:600, color:'var(--text1)' }}>• {item.name || item.title}</span>
                                <span style={{ color:'var(--text3)', fontSize:10, fontWeight:500 }}>{specsStr}</span>
                                <div style={{ color:'var(--text3)', fontSize:10, paddingLeft: 8, marginTop: 1 }}>
                                  {item.qty} × EGP {(item.unitPrice || 0).toLocaleString()}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </td>

                    <td style={{ padding:'11px 14px', verticalAlign: 'top', whiteSpace:'nowrap' }}>
                      <p style={{ fontSize:12, fontWeight:600 }}>EGP {order.total?.toLocaleString()}</p>
                      {order.discount > 0 && <p style={{ fontSize:10, color:'#27ae60', marginTop: 2 }}>-EGP {order.discount?.toLocaleString()}</p>}
                    </td>
                    <td style={{ padding:'11px 14px', verticalAlign: 'top' }}>
                      {canEdit ? (
                        <select value={order.status} onChange={e => handleStatusChange(order.id, e.target.value)}
                          style={{ padding:'4px 8px', fontSize:11, background:'var(--bg3)', border:`1px solid ${STATUS_COLORS[order.status]}`, color:STATUS_COLORS[order.status], borderRadius:4, cursor:'pointer' }}>
                          {STATUS_FLOW.concat(['Cancelled']).map(s => <option key={s}>{s}</option>)}
                        </select>
                      ) : (
                        <StatusBadge status={order.status} />
                      )}
                    </td>
                    <td style={{ padding:'11px 14px', fontSize:11, color:'var(--text3)', verticalAlign: 'top', whiteSpace:'nowrap' }}>{order.date}</td>
                    <td style={{ padding:'11px 14px', verticalAlign: 'top' }}>
                      <button onClick={() => setSelected(order)}
                        style={{ width:28, height:28, borderRadius:4, background:'var(--bg4)', border:'1px solid var(--border)', color:'var(--text2)', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
                        <Eye size={12} />
                      </button>
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {paginated.totalPages > 1 && (
          <div style={{ padding:'12px 16px', borderTop:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:10 }}>
            <p style={{ color:'var(--text3)', fontSize:12 }}>Showing {(paginated.page-1)*PER_PAGE+1}–{Math.min(paginated.page*PER_PAGE, paginated.total)} of {paginated.total}</p>
            <div style={{ display:'flex', gap:4 }}>
              <button onClick={() => setPage(p => Math.max(1,p-1))} disabled={!paginated.hasPrev}
                style={{ width:30, height:30, borderRadius:4, background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--text2)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', opacity: paginated.hasPrev ? 1 : 0.4 }}>
                <ChevronLeft size={14} />
              </button>
              {(() => {
                const tp = paginated.totalPages;
                const win = 5;
                let start = Math.max(1, paginated.page - Math.floor(win / 2));
                const end = Math.min(tp, start + win - 1);
                start = Math.max(1, end - win + 1);
                const nums = [];
                for (let p = start; p <= end; p++) nums.push(p);
                return nums;
              })().map((p) => (
                <button key={p} onClick={() => setPage(p)}
                  style={{ width:30, height:30, borderRadius:4, background: paginated.page === p ? 'var(--gold)' : 'var(--bg3)', border:'1px solid var(--border)', color: paginated.page === p ? 'var(--bg)' : 'var(--text2)', cursor:'pointer', fontSize:12 }}>{p}</button>
              ))}
              <button onClick={() => setPage(p => Math.min(paginated.totalPages,p+1))} disabled={!paginated.hasNext}
                style={{ width:30, height:30, borderRadius:4, background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--text2)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', opacity: paginated.hasNext ? 1 : 0.4 }}>
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 🎯 النافذة المنبثقة (Modal) الذكية الجديدة لعرض الطلبات المتكررة تحت بعضها */}
      <AnimatePresence>
        {showHistoryModal && (
          <>
            <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }} onClick={() => setShowHistoryModal(false)}
              style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2500, backdropFilter:'blur(4px)' }} />
            <motion.div initial={{ opacity:0, scale:0.95, y: -20 }} animate={{ opacity:1, scale:1, y:0 }} exit={{ opacity:0, scale:0.95, y: -20 }}
              style={{ position:'fixed', top:'10%', left:'50%', transform:'translateX(-50%)', width:'92%', maxWidth:460, background:'var(--bg2)', border:'1px solid var(--border-gold)', borderRadius:12, padding:20, zIndex:2501, boxShadow:'0 20px 50px rgba(0,0,0,0.6)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', borderBottom:'1px solid var(--border)', paddingBottom:12, marginBottom:16 }}>
                <div>
                  <h3 style={{ color:'var(--gold)', fontSize:16, fontWeight:600 }}>📋 سجل الطلبات المتكررة</h3>
                  <p style={{ fontSize:11, color:'var(--text3)', marginTop:2 }}>الرقم: {selectedCustomerPhone}</p>
                </div>
                <button onClick={() => setShowHistoryModal(false)} style={{ background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--text2)', width:28, height:28, borderRadius:6, cursor:'pointer', fontSize:12 }}>✕</button>
              </div>

              <div style={{ maxHeight: '280px', overflowY: 'auto', marginBottom: 20, paddingRight: 4 }} className="custom-scrollbar">
                {getCustomerPreviousOrders(selectedCustomerPhone).map((prevOrder) => (
                  <div key={prevOrder.id} style={{ background:'rgba(255,255,255,0.02)', padding:12, borderRadius:8, marginBottom:10, border:'1px solid var(--border)' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:6 }}>
                      <span style={{ color:'var(--gold)', fontWeight:700, fontFamily:'monospace' }}>{prevOrder.id}</span>
                      <span style={{ color:'var(--text3)' }}>{prevOrder.date}</span>
                    </div>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:4 }}>
                      <span style={{ fontSize:11, padding:'2px 6px', borderRadius:4, background:`${STATUS_COLORS[prevOrder.status]}12`, color:STATUS_COLORS[prevOrder.status], fontWeight:600 }}>{prevOrder.status}</span>
                      <strong style={{ fontSize:12, color:'var(--text1)' }}>EGP {prevOrder.total?.toLocaleString()}</strong>
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display:'flex', gap:10, direction: 'rtl' }}>
  <a 
    href={`https://wa.me/${(() => {
      // 1. تنظيف الرقم من أي رموز أو مسافات
      let cleaned = String(selectedCustomerPhone).replace(/[^0-9]/g, '');
      
      // 2. لو الرقم مصري عادي بيبدأ بـ 01
      if (cleaned.startsWith('01') && cleaned.length === 11) {
        cleaned = '20' + cleaned.slice(1);
      }
      // 3. لو مكتوب بصفرين دوليين زيادة 0020
      else if (cleaned.startsWith('0020')) {
        cleaned = cleaned.slice(2);
      }
      // 4. لو مكتوب من غير الصفر الأولاني خالص 1xxxx
      else if (cleaned.startsWith('1') && cleaned.length === 10) {
        cleaned = '20' + cleaned;
      }
      
      return cleaned;
    })()}?text=${encodeURIComponent('شكراً لثقتك في ZASHM، وبمناسبة طلبك لأكثر من أوردر من عندنا فحابين نهديك كود خصم خاص بيك تستخدمه في أي طلب قادم! 🎉')}`}
    target="_blank"
    rel="noreferrer"
    style={{ flex: 1, background: '#25D366', color: '#fff', textAlign: 'center', padding: '10px', borderRadius: 8, textDecoration: 'none', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
  >
    <MessageSquare size={15} /> تواصل معه بالخصم
  </a>
  <button onClick={() => setShowHistoryModal(false)} style={{ padding: '10px 16px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text1)', cursor: 'pointer', fontSize: 13 }}>إغلاق</button>
</div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ─── SIDEBAR DETAILED VIEW ─────────────────────────────────────────── */}
      <AnimatePresence>
        {selected && (
          <>
            <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }} onClick={() => setSelected(null)}
              style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2000, backdropFilter:'blur(4px)' }} />
            <motion.div initial={{ opacity:0, x:80 }} animate={{ opacity:1, x:0 }} exit={{ opacity:0, x:80 }}
              style={{ position:'fixed', right:0, top:0, bottom:0, width:'100%', maxWidth:440, background:'var(--bg2)', borderLeft:'1px solid var(--border)', zIndex:2001, overflow:'auto' }}>
              <div style={{ padding:'20px', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div>
                  <p style={{ fontSize:10, color:'var(--text3)', letterSpacing:2, textTransform:'uppercase', marginBottom:2 }}>Order Details</p>
                  <h2 style={{ fontFamily:'var(--font-display)', fontSize:20, color:'var(--gold)' }}>{selected.id}</h2>
                </div>
                <button onClick={() => setSelected(null)} style={{ width:32, height:32, borderRadius:6, background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--text2)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>✕</button>
              </div>
              
              <div style={{ padding:16 }}>
                
                {/* 🎯 قـسـم تـتـبـع الـطـلـب الـجـديـد (Tracking Link) */}
                <div style={{ background: 'rgba(212, 175, 55, 0.05)', border: '1px solid rgba(212, 175, 55, 0.2)', borderRadius: 6, padding: 14, marginBottom: 16 }}>
                  <p style={{ fontSize: 11, color: 'var(--gold)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    🔗 Customer Tracking Link
                  </p>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input 
                      type="text" 
                      readOnly 
                      value={selected.tracking_url || trackingLinkFor(selected.id)} 
                      style={{ flex: 1, padding: '8px 10px', fontSize: 11, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text2)', fontFamily: 'monospace' }} 
                    />
                    <button 
                      onClick={() => handleCopyLink(selected.tracking_url || trackingLinkFor(selected.id))}
                      style={{ padding: '8px 12px', background: copied ? '#27ae60' : 'var(--gold)', color: copied ? 'white' : 'var(--bg)', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600, transition: 'all 0.2s', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}
                    >
                      {copied ? 'Copied!' : 'Copy Link'}
                    </button>
                  </div>
                </div>

                <div style={{ marginBottom:20, overflowX: 'auto', paddingBottom: 8 }}>
                  <p style={{ fontSize:11, color:'var(--text3)', letterSpacing:1, textTransform:'uppercase', marginBottom:12 }}>Status Timeline</p>
                  <div style={{ display:'flex', alignItems:'center', minWidth: 360 }}>
                    {STATUS_FLOW.map((s, i) => {
                      const reached = STATUS_FLOW.indexOf(selected.status) >= i;
                      return (
                        <React.Fragment key={s}>
                          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
                            <div style={{ width:22, height:22, borderRadius:'50%', background: reached ? STATUS_COLORS[s] : 'var(--bg3)', border:`2px solid ${reached ? STATUS_COLORS[s] : 'var(--border)'}`, display:'flex', alignItems:'center', justifyContent:'center' }}>
                              {reached && <span style={{ fontSize:9, color:'white' }}>✓</span>}
                            </div>
                            <p style={{ fontSize:8, color: reached ? STATUS_COLORS[s] : 'var(--text3)', textAlign:'center', whiteSpace:'nowrap' }}>{s}</p>
                          </div>
                          {i < STATUS_FLOW.length-1 && (
                            <div style={{ flex:1, height:2, background: STATUS_FLOW.indexOf(selected.status) > i ? 'var(--gold)' : 'var(--border)', marginBottom:14 }} />
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>

                <div style={{ background:'var(--bg3)', borderRadius:6, padding:12, marginBottom:16 }}>
                  <p style={{ fontSize:11, color:'var(--text3)', marginBottom:10, letterSpacing:1, textTransform:'uppercase' }}>Customer</p>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap:10 }}>
                    {[
                      ['Name', selected.customer],
                      ['Phone', selected.phone],
                      ['Alternate Phone', selected.phoneAlt || '—'],
                      ['City', selected.city || '—'],
                      ['Email', selected.email||'—'],
                      ['Date', selected.date],
                      ['Address', selected.address]
                    ].map(([k,v]) => (
                      <div key={k} style={{ gridColumn: k === 'Address' ? '1 / -1' : 'auto' }}>
                        <p style={{ fontSize:10, color:'var(--text3)', marginBottom:2 }}>{k}</p>
                        <p style={{ fontSize: 12, color: 'var(--text1)', wordBreak:'break-word' }}>{v}</p>                     
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ marginBottom:16 }}>
                  <p style={{ fontSize:11, color:'var(--text3)', marginBottom:10, letterSpacing:1, textTransform:'uppercase' }}>Items</p>
                  {selected.items?.map((item, i) => (
                    <div key={i} style={{ display:'flex', gap:10, padding:'10px 0', borderBottom:'1px solid var(--border)' }}>
                      {item.image && <img src={item.image} alt={item.name} style={{ width:44, height:56, objectFit:'cover', borderRadius:3, flexShrink:0 }} />}
                      <div style={{ flex:1, minWidth:0 }}>
                        <p style={{ fontSize:12, fontWeight:500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{item.name}</p>
                        <p style={{ fontSize:11, color:'var(--text3)' }}>{item.size} · {item.color} · Qty: {item.qty}</p>
                      </div>
                      <p style={{ color:'var(--gold)', fontSize:12, fontWeight:600, flexShrink:0 }}>EGP {item.price?.toLocaleString()}</p>
                    </div>
                  ))}
                </div>

                <div style={{ background:'var(--bg3)', borderRadius:6, padding:14 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                    <span style={{ color:'var(--text3)', fontSize:12 }}>Subtotal</span>
                    <span style={{ fontSize:12 }}>EGP {selected.subtotal?.toLocaleString()}</span>
                  </div>
                  {selected.discount > 0 && (
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                      <span style={{ color:'#27ae60', fontSize:12 }}>Discount ({selected.discountCode})</span>
                      <span style={{ color:'#27ae60', fontSize:12 }}>-EGP {selected.discount?.toLocaleString()}</span>
                    </div>
                  )}
                  <div style={{ display:'flex', justifyContent:'space-between', borderTop:'1px solid var(--border)', paddingTop:8 }}>
                    <strong style={{ fontSize:13 }}>Total</strong>
                    <strong style={{ color:'var(--gold)', fontFamily:'var(--font-display)', fontSize:16 }}>EGP {selected.total?.toLocaleString()}</strong>
                  </div>
                </div>

                {canEdit && (
                  <div style={{ marginTop:16 }}>
                    <p style={{ fontSize:11, color:'var(--text3)', marginBottom:8, letterSpacing:1, textTransform:'uppercase' }}>Update Status</p>
                    <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                      {STATUS_FLOW.concat(['Cancelled']).filter(s => s !== selected.status).map(s => (
                        <button key={s} onClick={() => { handleStatusChange(selected.id, s); }}
                          style={{ padding:'6px 10px', borderRadius:4, background:`${STATUS_COLORS[s]}1a`, border:`1px solid ${STATUS_COLORS[s]}`, color:STATUS_COLORS[s], cursor:'pointer', fontSize:11, fontWeight:600 }}>
                          → {s}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── PRODUCTS PANEL ───────────────────────────────────────────────────────────
const PRODUCT_CATEGORIES = [
  'T-Shirts', 'Polo Shirts', 'Shirts', 'Henleys',
  'Pants', 'Jeans', 'Shorts', 'Joggers',
  'Sweatpants', 'Sweatshirts', 'Hoodies', 'Crewnecks',
  'Jackets', 'Coats', 'Blazers', 'Suits', 'Tracksuits',
  'Dresses', 'Skirts', 'Jumpsuits', 'Waistcoats',
  'Vests', 'Baselayers', 'Socks', 'Underwear',
];
const EMPTY_PRODUCT_FORM = {
  name:'', category:'', price:'', salePrice:'', stock:'', sizes:'S,M,L,XL', colors:'Black,White',
  label:'', description:'', sku:'', images:[], active:true, variantStock:{}, sizeRecommendations:{}
};

function ProductsPanel({ canEdit, preOpenNew, onNewOpened }) {
  const { products, addProduct, updateProduct, deleteProduct, bulkDeleteProducts } = useStore();
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [productToDelete, setProductToDelete] = useState(null);
  const [confirmBulk, setConfirmBulk] = useState(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [page, setPage] = useState(1);

  // تتبّع الصور المرفوعة خلال الجلسة الحالية فقط (مسارات داخل bucket products)
  // حتى يمكن حذف ملفاتها الفعلية من Storage عند الحذف/الإلغاء دون لمس صور محفوظة.
  const tempUploadsRef = useRef(new Set());
  const cancelInFlightRef = useRef(false);

  useEffect(() => {
    if (!preOpenNew) return;
    setEditing(null);
    setForm({ ...EMPTY_PRODUCT_FORM });
    setFormErrors({});
    tempUploadsRef.current = new Set();
    cancelInFlightRef.current = false;
    setShowForm(true);
    if (onNewOpened) onNewOpened();
  }, [preOpenNew, onNewOpened]);

  const [form, setForm] = useState(EMPTY_PRODUCT_FORM);
  const [formErrors, setFormErrors] = useState({});
  const PER_PAGE = 16;

  const filtered = products.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.sku?.includes(search) || p.category.toLowerCase().includes(search.toLowerCase()));
  const paginated = paginate(filtered, page, PER_PAGE);

  // تسجيل مسارات الصور الجديدة المرفوعة للسيرفر أثناء هذه الجلسة. لا نحذف أي
  // مسار من المجموعة عند إزالة الصورة من النموذج: يُترك ليتولّى الأب تنظيفه
  // (عند الإلغاء لكل ما رُفع في الجلسة، وعند الحفظ لما لم يعد مرجّحاً).
  const trackTempUploads = (prevImages, prevGuide, nextImages, nextGuide) => {
    (nextImages || []).forEach(u => {
      const ph = storagePathFromUrl(u);
      const alreadyKnown = (prevImages || []).includes(u) || (prevGuide && prevGuide === u);
      if (ph && !alreadyKnown) tempUploadsRef.current.add(ph);
    });
    if (nextGuide && nextGuide !== prevGuide) {
      const ph = storagePathFromUrl(nextGuide);
      if (ph) tempUploadsRef.current.add(ph);
    }
  };

  const update = (k, v) => {
    if ((k === 'images' || k === 'sizeGuide') && !showForm) return;
    setForm(f => {
      if (k === 'images') trackTempUploads(f.images, f.sizeGuide, v, f.sizeGuide);
      if (k === 'sizeGuide') trackTempUploads(f.images, f.sizeGuide, f.images, v);
      return { ...f, [k]: v };
    });
    setFormErrors(e => ({ ...e, [k]: null }));
  };

  // إلغاء فتح المنتج: يقفل الـ drawer بأمان وينظف أي صور مؤقتة من Storage
  // (أفضل مجهود — أي فشل يظهر تنبيه فقط ولا يكسر الواجهة أبداً).
  const handleCancel = async () => {
    if (cancelInFlightRef.current) return;
    cancelInFlightRef.current = true;

    const pending = Array.from(tempUploadsRef.current);
    tempUploadsRef.current = new Set();

    setEditing(null);
    setShowForm(false);
    setForm({ ...EMPTY_PRODUCT_FORM });
    setFormErrors({});

    try {
      if (pending.length) {
        let failed = false;
        await Promise.all(pending.map(async (path) => {
          try {
            await deleteStorageFile(path);
          } catch (err) {
            console.error('Cancel cleanup delete failed:', err && err.message);
            failed = true;
          }
        }));
        if (failed) toast.error('تعذر حذف بعض الصور المؤقتة من التخزين، أعد المحاولة لاحقاً.');
      }
    } finally {
      cancelInFlightRef.current = false;
    }
  };

  // حذف منتج واحد: يُغلق المودال أولاً ثم ينفذ الحذف، ويعرض نتيجة دقيقة
  // (ناجح بالكامل، أو ناجح مع فشل تنظيف بعض الصور).
  const confirmSingleDelete = async () => {
    const target = productToDelete;
    if (!target || !target.id) return;
    setProductToDelete(null);
    try {
      const payload = await deleteProduct(target.id);
      const failed = (payload && payload.cleanup && payload.cleanup.failed) || [];
      if (failed.length) {
        toast.error(`تم حذف المنتج، لكن فشل تنظيف ${failed.length} صورة من التخزين. حاول مرة أخرى لاحقاً.`);
      } else {
        toast.success('تم حذف المنتج بنجاح');
      }
    } catch (err) {
      console.error('confirmSingleDelete failed:', err && err.message);
      toast.error('تعذر حذف المنتج، حاول مرة أخرى.');
    }
  };

  // حذف جماعي: نفس القواعد، بنتيجة دقيقة لكل عملية.
  const confirmBulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    clearSelect();
    setConfirmBulk(null);
    try {
      const payload = await bulkDeleteProducts(ids);
      const failed = (payload && payload.cleanup && payload.cleanup.failed) || [];
      if (failed.length) {
        toast.error(`تم حذف المنتجات، لكن فشل تنظيف ${failed.length} صورة من التخزين. حاول مرة أخرى لاحقاً.`);
      } else {
        toast.success('تم حذف المنتجات بنجاح');
      }
    } catch (err) {
      console.error('confirmBulkDelete failed:', err && err.message);
      toast.error('تعذر حذف المنتجات، حاول مرة أخرى.');
    }
  };

  const openNew = () => {
    setEditing(null);
    setForm({ ...EMPTY_PRODUCT_FORM });
    setFormErrors({});
    tempUploadsRef.current = new Set();
    cancelInFlightRef.current = false;
    setShowForm(true);
  };

  const openEdit = (p) => {
    setEditing(p);
    setForm({ 
      ...p, 
      salePrice: p.salePrice || '', 
      sizes: Array.isArray(p.sizes) ? p.sizes.join(',') : (p.sizes || ''), 
      colors: Array.isArray(p.colors) ? p.colors.join(',') : (p.colors || ''),
      variantStock: p.variantStock || {},
      sizeRecommendations: p.sizeRecommendations && typeof p.sizeRecommendations === 'object' ? p.sizeRecommendations : {},
      label: p.label || ''
    });
    setFormErrors({});
    tempUploadsRef.current = new Set();
    cancelInFlightRef.current = false;
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name || form.name.trim() === '') {
      toast.error('⚠️ عذراً، يرجى إدخال اسم المنتج أولاً قبل الحفظ.');
      return;
    }

    if (!form.category || form.category.trim() === '') {
      toast.error('⚠️ عذراً، يرجى اختيار أو كتابة القسم (Category) أولاً.');
      return;
    }

    const parsedPrice = parseFloat(form.price);
    if (!form.price || isNaN(parsedPrice) || parsedPrice <= 0) {
      toast.error('⚠️ عذراً، يجب إدخال سعر صحيح للمنتج (يكون أكبر من صفر).');
      return;
    }

    if (!form.images || !Array.isArray(form.images) || form.images.length === 0 || form.images[0]?.trim() === '') {
      toast.error('⚠️ عذراً، يرجى رفع صورة واحدة على الأقل للمنتج قبل إضافته.');
      return;
    }

    const cleanSizes = typeof form.sizes === 'string' 
      ? form.sizes.split(',').map(s => s.trim()).filter(Boolean) 
      : (Array.isArray(form.sizes) ? form.sizes : []);

    const cleanColors = typeof form.colors === 'string' 
      ? form.colors.split(',').map(c => c.trim()).filter(Boolean) 
      : (Array.isArray(form.colors) ? form.colors : []);
    
    // Process and validate size recommendations
    const sizeRecs = {};
    if (form.sizeRecommendations && typeof form.sizeRecommendations === 'object') {
      for (const size of cleanSizes) {
        const rec = form.sizeRecommendations[size];
        if (!rec) continue;
        const hasAny = (rec.heightMin !== '' && rec.heightMin !== undefined && rec.heightMin !== null) ||
                       (rec.heightMax !== '' && rec.heightMax !== undefined && rec.heightMax !== null) ||
                       (rec.weightMin !== '' && rec.weightMin !== undefined && rec.weightMin !== null) ||
                       (rec.weightMax !== '' && rec.weightMax !== undefined && rec.weightMax !== null);
        if (!hasAny) continue;
        const allPresent = (rec.heightMin !== '' && rec.heightMin !== undefined && rec.heightMin !== null) &&
                           (rec.heightMax !== '' && rec.heightMax !== undefined && rec.heightMax !== null) &&
                           (rec.weightMin !== '' && rec.weightMin !== undefined && rec.weightMin !== null) &&
                           (rec.weightMax !== '' && rec.weightMax !== undefined && rec.weightMax !== null);
        if (!allPresent) {
          toast.error(`Incomplete recommendation range for size "${size}": fill all four values or leave all blank`);
          return;
        }
        const hMin = Number(rec.heightMin);
        const hMax = Number(rec.heightMax);
        const wMin = Number(rec.weightMin);
        const wMax = Number(rec.weightMax);
        if (!Number.isFinite(hMin) || !Number.isFinite(hMax) || !Number.isFinite(wMin) || !Number.isFinite(wMax)) {
          toast.error(`Invalid numeric values for size "${size}" in recommendations`);
          return;
        }
        if (hMin < 0 || wMin < 0 || hMax < 0 || wMax < 0) {
          toast.error(`Invalid values for size "${size}" in recommendations`);
          return;
        }
        if (hMin > hMax || wMin > wMax) {
          toast.error(`Minimum values must not exceed maximum values for size "${size}"`);
          return;
        }
        sizeRecs[size] = {
          heightMin: Math.round(hMin),
          heightMax: Math.round(hMax),
          weightMin: Math.round(wMin),
          weightMax: Math.round(wMax)
        };
      }
    }

    const finalVariantStock = form.variantStock || {};
    const calculatedTotalStock = Object.keys(finalVariantStock).reduce((sum, key) => {
      const [sz, col] = key.split('-');
      if (cleanSizes.includes(sz) && cleanColors.includes(col)) {
        return sum + (parseInt(finalVariantStock[key]) || 0);
      }
      return sum;
    }, 0);

    const finalLabel = typeof form.label === 'string' ? form.label.trim() : "";
    const finalSizeGuide = form.sizeGuide || null;

    const productData = {
      name: form.name.trim(),
      category: form.category.trim(), 
      sku: form.sku || null,
      tags: form.tags || null,
      description: form.description || '',
      active: form.active ?? true,
      price: parsedPrice,
      salePrice: form.salePrice ? parseFloat(form.salePrice) : null,
      stock: calculatedTotalStock, 
      sizes: cleanSizes,       
      colors: cleanColors,     
      variantStock: finalVariantStock, 
      sizeRecommendations: Object.keys(sizeRecs).length > 0 ? sizeRecs : null,
      images: form.images,     
      sizeGuide: finalSizeGuide, 
      label: finalLabel          
    };

    try {
      if (editing && editing.id) {
        await updateProduct(editing.id, productData);
        toast.success('تم تعديل المنتج ومزامنة المخزون بنجاح! 🔄');
      } else {
        await addProduct(productData);
        toast.success('تم إضافة المنتج الجديد للمتجر بنجاح! 🚀');
      }

      // نظّف من Storage الملفات التي لم تعد مرجّحة من المنتج: صور رُفعت في هذه
      // الجلسة ثم أُزيلت، وصور أصلية محفوظة حُذفت من النموذج. أفضل مجهود — فشل
      // التنظيف لا يلغي حفظ المنتج.
      try {
        const finalPaths = new Set();
        (productData.images || []).forEach(u => { const ph = storagePathFromUrl(u); if (ph) finalPaths.add(ph); });
        const guidePh = storagePathFromUrl(productData.sizeGuide || '');
        if (guidePh) finalPaths.add(guidePh);

        const orphaned = new Set();
        tempUploadsRef.current.forEach(ph => { if (!finalPaths.has(ph)) orphaned.add(ph); });
        const originalUrls = [
          ...((editing && editing.images) || []),
          ...((editing && editing.sizeGuide) ? [editing.sizeGuide] : []),
        ];
        originalUrls.forEach(u => { const ph = storagePathFromUrl(u); if (ph && !finalPaths.has(ph)) orphaned.add(ph); });

        if (orphaned.size) {
          await Promise.all([...orphaned].map(ph =>
            deleteStorageFile(ph).catch(err => console.error('Save cleanup delete failed:', err && err.message))
          ));
        }
      } catch (e) {
        console.error('Save cleanup failed:', e && e.message);
      }

      tempUploadsRef.current = new Set();
      if (form._isAddingNewCat) update('_isAddingNewCat', false);
      setShowForm(false);
    } catch (err) {
      console.error("❌ [HandleSave Error]:", err);
      toast.error("حدث خطأ أثناء الاتصال بقاعدة البيانات.");
    }
  };

  const toggleSelect = (id) => {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const selectAll = () => setSelected(new Set(paginated.items.map(p => p.id)));
  const clearSelect = () => setSelected(new Set());

  return (
    <div>
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap', alignItems:'center' }}>
        <div style={{ position:'relative', flex:1, minWidth:200 }}>
          <Search size={13} style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', color:'var(--text3)' }} />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search products..." style={{ width:'100%', paddingLeft:34 }} />
        </div>
        <div style={{ display:'flex', gap:6, width: '100%', justifyContent:'flex-end', flexWrap:'wrap' }}>
          {selected.size > 0 && (
            <button 
              onClick={() => setConfirmBulk(selected.size)}
              style={{ display:'flex', gap:6, alignItems:'center', padding:'8px 14px', background:'rgba(192,57,43,0.1)', border:'1px solid rgba(192,57,43,0.3)', color:'var(--red)', borderRadius:6, cursor:'pointer', fontSize:12, transition:'all 0.2s ease-in-out' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--gold)'; e.currentTarget.style.borderColor = 'var(--gold)'; e.currentTarget.style.color = '#111'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(192,57,43,0.1)'; e.currentTarget.style.borderColor = 'rgba(192,57,43,0.3)'; e.currentTarget.style.color = 'var(--red)'; }}
            >
              <Trash2 size={13} /> Delete {selected.size}
            </button>
          )}
          {canEdit && <>
            <button onClick={() => setShowImport(true)}
              style={{ display:'flex', gap:6, alignItems:'center', padding:'8px 14px', background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--text2)', borderRadius:6, cursor:'pointer', fontSize:12 }}>
              <Upload size={13} /> Import
            </button>
            <button className="gold-btn" style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 16px' }} onClick={openNew}>
              <Plus size={14} /> Add Product
            </button>
          </>}
        </div>
      </div>

      {paginated.items.length > 0 && (
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12 }}>
          <label style={{ display:'flex', gap:6, alignItems:'center', cursor:'pointer', fontSize:12, color:'var(--text3)' }}>
            <input type="checkbox" checked={selected.size === paginated.items.length && paginated.items.length > 0}
              onChange={e => e.target.checked ? selectAll() : clearSelect()}
              style={{ accentColor:'var(--gold)' }} />
            Select all
          </label>
          <span style={{ color:'var(--text3)', fontSize:12 }}>{filtered.length} total</span>
        </div>
      )}

      {paginated.items.length === 0 && (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10 }}>
          <DashEmpty
            icon={Package}
            title={search ? 'لا توجد منتجات مطابقة' : 'لا توجد منتجات بعد'}
            hint={search ? 'جرّب كلمة بحث أخرى.' : 'ابدأ بإضافة أول منتج لمتجرك.'}
            action={(!search && canEdit) ? (
              <button className="gold-btn" style={{ marginTop:12, display:'inline-flex', alignItems:'center', gap:8, padding:'8px 16px' }} onClick={openNew}>
                <Plus size={14} /> إضافة منتج
              </button>
            ) : null}
          />
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(140px, 1fr))', gap:12 }}>
        {paginated.items.map(p => (
          <motion.div key={p.id} initial={{ opacity:0, scale:0.97 }} animate={{ opacity:1, scale:1 }}
            style={{ background:'var(--surface)', border:`2px solid ${selected.has(p.id) ? 'var(--gold)' : 'var(--border)'}`, borderRadius:6, overflow:'hidden', transition:'border-color 0.15s', position:'relative' }}>
            <div style={{ position:'absolute', top:8, left:8, zIndex:1 }}>
              <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)}
                style={{ accentColor:'var(--gold)', width:16, height:16 }} />
            </div>
            
            <div style={{ position:'relative', aspectRatio:'3/4', overflow:'hidden' }} className="product-card-img-wrapper">
              <img src={p.images?.[0]} alt={p.name} loading="lazy" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
              {p.stock <= 5 && (
                <div style={{ position:'absolute', top:8, right:8, background: p.stock === 0 ? 'var(--red)' : '#f39c12', color:'white', fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:2 }}>
                  {p.stock === 0 ? 'OUT' : `${p.stock} left`}
                </div>
              )}
              
              <div className="product-card-actions" style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.4)', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                {canEdit && (
                  <>
                    <button onClick={() => openEdit(p)} style={{ width:32, height:32, borderRadius:'50%', background:'var(--gold)', border:'none', color:'#000000', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}><Edit size={12} /></button>
                    <button 
                      onClick={() => setProductToDelete(p)} 
                      style={{ width:32, height:32, borderRadius:'50%', background:'#111111', border:'1px solid #333333', color:'#ffffff', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', transition:'all 0.2s' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--gold)'; e.currentTarget.style.borderColor = 'var(--gold)'; e.currentTarget.style.color = '#111'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = '#111111'; e.currentTarget.style.borderColor = '#333333'; e.currentTarget.style.color = '#ffffff'; }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            </div>
            <div style={{ padding:'10px' }}>
              <p style={{ fontSize:10, color:'var(--text3)', marginBottom:2, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{p.category}</p>
              <p style={{ fontSize:12, fontWeight:600, marginBottom:4, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{p.name}</p>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap' }}>
                <span style={{ color:'var(--gold)', fontSize:11, fontWeight:600 }}>EGP {(p.salePrice||p.price).toLocaleString()}</span>
                <span style={{ fontSize:9, color: p.stock > 5 ? '#27ae60' : p.stock > 0 ? '#f39c12' : 'var(--red)', fontWeight:500 }}>Qty: {p.stock}</span>
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      {paginated.totalPages > 1 && (
        <div style={{ display:'flex', justifyContent:'center', gap:8, marginTop:24 }}>
          <button onClick={() => setPage(p => Math.max(1,p-1))} disabled={!paginated.hasPrev}
            style={{ padding:'6px 12px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, color:'var(--text2)', cursor:'pointer', fontSize:12, opacity: paginated.hasPrev ? 1 : 0.4 }}>← Prev</button>
          <span style={{ padding:'6px 8px', fontSize:12, color:'var(--text2)' }}>{page} / {paginated.totalPages}</span>
          <button onClick={() => setPage(p => Math.min(paginated.totalPages,p+1))} disabled={!paginated.hasNext}
            style={{ padding:'6px 12px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, color:'var(--text2)', cursor:'pointer', fontSize:12, opacity: paginated.hasNext ? 1 : 0.4 }}>Next →</button>
        </div>
      )}

      {showForm && (
          <>
            <div onClick={handleCancel}
              style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2000 }} />
            <div
              style={{ position:'fixed', right:0, top:0, bottom:0, width:'100%', maxWidth:520, background:'var(--bg2)', borderLeft:'1px solid var(--border)', zIndex:2001, display:'flex', flexDirection:'column', overflow:'hidden' }}>
              <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0 }}>
                <h2 style={{ fontFamily:'var(--font-display)', fontSize:20 }}>{editing ? 'Edit Product' : 'New Product'}</h2>
                <button onClick={handleCancel} style={{ color:'var(--text3)', background:'none', border:'none', cursor:'pointer', fontSize:20 }}>✕</button>
              </div>
              <div style={{ flex:1, overflowY:'auto', padding:'16px' }}>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, marginBottom: 12 }}>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }}>Product Name *</label>
                    <input type="text" required value={form.name || ''} onChange={e => update('name', e.target.value)} placeholder="e.g., Basic T-Shirt" style={{ width: '100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }}>SKU / Code</label>
                    <input type="text" value={form.sku || ''} onChange={e => update('sku', e.target.value)} placeholder="TSH-BSC-01" style={{ width: '100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, marginBottom: 12 }}>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }}>Category *</label>
                    {form._isAddingNewCat ? (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input 
                          type="text" required value={form.category || ''} onChange={e => update('category', e.target.value)} placeholder="Write new category name..." 
                          style={{ flex: 1, padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} 
                        />
                        <button 
                          type="button" onClick={() => { update('_isAddingNewCat', false); update('category', ''); }}
                          style={{ padding: '0 12px', background: 'none', border: '1px solid var(--border)', color: 'var(--text3)', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <select
                        required value={form.category || ''}
                        onChange={e => {
                          if (e.target.value === '___NEW_CAT___') {
                            update('_isAddingNewCat', true); update('category', '');
                          } else {
                            update('category', e.target.value);
                          }
                        }}
                        style={{ width: '100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: form.category ? 'var(--text)' : 'var(--text3)', cursor: 'pointer', height: '37px' }}
                      >
                        <option value="">Select a category</option>
                        {(() => {
                          const existing = Array.isArray(products) ? [...new Set(products.map(p => p.category).filter(Boolean))] : [];
                          const all = [...new Set([...PRODUCT_CATEGORIES, ...existing])];
                          return all.map(cat => <option key={cat} value={cat}>{cat}</option>);
                        })()}
                        <option value="___NEW_CAT___" style={{ color: 'var(--gold)', fontWeight: '600' }}>➕ + Add New Category</option>
                      </select>
                    )}
                  </div>

                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }}>Tags / Collection</label>
                    <input type="text" value={form.tags || ''} onChange={e => update('tags', e.target.value)} placeholder="Summer26, Cotton" style={{ width: '100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }}>Product Label (Filter) 🎯</label>
                    <select 
                      value={form.label || ''} onChange={e => update('label', e.target.value)}
                      style={{ width: '100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: form.label ? 'var(--gold)' : 'var(--text)', cursor: 'pointer', height: '37px' }}
                    >
                      <option value="">None (Standard)</option>
                      <option value="New Arrival">New Arrival</option>
                      <option value="Best Seller">Best Seller</option>
                      <option value="Featured">Featured</option>
                      <option value="Limited Edition">Limited Edition</option>
                    </select>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: form.salePrice && form.price && Number(form.salePrice) > Number(form.price) ? 6 : 12 }}>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }}>Price (EGP) *</label>
                    <input type="number" required min="0" value={form.price || ''} onChange={e => update('price', Number(e.target.value) || 0)} placeholder="700" style={{ width: '100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }}>Sale Price</label>
                    <input type="number" min="0" value={form.salePrice || ''} onChange={e => update('salePrice', e.target.value ? Number(e.target.value) : null)} placeholder="500" style={{ width: '100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                </div>

                {form.salePrice && form.price && Number(form.salePrice) > Number(form.price) && (
                  <p style={{ color: '#ef4444', fontSize: 11, marginTop: 0, marginBottom: 12, direction: 'rtl', textAlign: 'right' }}>* سعر الخصم لا يمكن أن يكون أكبر من السعر الأصلي.</p>
                )}
                
                <div style={{ display:'grid', gridTemplateColumns:'1fr', gap:12, marginTop:12 }}>
                  <div>
                    <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, letterSpacing:1, textTransform:'uppercase' }}>Sizes (comma-separated)</label>
                    <input value={form.sizes||''} onChange={e => update('sizes', e.target.value)} placeholder="S,M,L,XL" style={{ width:'100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                  <div>
                    <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, letterSpacing:1, textTransform:'uppercase' }}>Colors (comma-separated)</label>
                    <input value={form.colors||''} onChange={e => update('colors', e.target.value)} placeholder="Black,White" style={{ width:'100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                </div>

                <div style={{ marginTop:16, padding:12, background:'var(--bg3)', borderRadius:6, border:'1px solid var(--border)' }}>
                  <label style={{ fontSize:11, color:'var(--gold)', display:'block', marginBottom:12, letterSpacing:1, textTransform:'uppercase', fontWeight:600 }}>🎨 Size & Color Stock Matrix *</label>
                  <div style={{ display:'grid', gap:8 }}>
                    {(() => {
                      const currentSizes = typeof form.sizes === 'string' ? form.sizes.split(',').map(s => s.trim()).filter(Boolean) : (Array.isArray(form.sizes) ? form.sizes : []);
                      const currentColors = typeof form.colors === 'string' ? form.colors.split(',').map(c => c.trim()).filter(Boolean) : (Array.isArray(form.colors) ? form.colors : []);
                      
                      if (currentSizes.length === 0 || currentColors.length === 0) {
                        return <p style={{ fontSize:11, color:'var(--text3)', textAlign:'center', padding:'10px 0' }}>Enter sizes and colors above to generate stock fields</p>;
                      }

                      const commitVariantStock = (matrixKey, qty) => {
                        const safeQty = Math.max(0, Number.isFinite(Number(qty)) ? Number(qty) : 0);
                        const updatedMatrix = { ...(form.variantStock || {}), [matrixKey]: safeQty };
                        update('variantStock', updatedMatrix);
                        const totalStock = Object.keys(updatedMatrix).reduce((sum, key) => {
                          const [sz, col] = key.split('-');
                          if (currentSizes.includes(sz) && currentColors.includes(col)) {
                            return sum + (updatedMatrix[key] || 0);
                          }
                          return sum;
                        }, 0);
                        update('stock', totalStock);
                      };

                      const rows = [];
                      currentSizes.forEach(size => {
                        currentColors.forEach(color => {
                          const matrixKey = `${size}-${color}`;
                          const currentStock = form.variantStock ? (form.variantStock[matrixKey] || 0) : 0;
                          
                          rows.push(
                            <div key={matrixKey} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:8, background:'var(--surface)', padding:'8px 12px', borderRadius:4, border:'1px solid var(--border)' }}>
                              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                                <span style={{ fontSize:11, fontWeight:600, color:'var(--text)', background:'var(--bg)', padding:'2px 6px', borderRadius:4 }}>{size}</span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color.toLowerCase() === 'white' ? '#ffffff' : color.toLowerCase(), border: '1px solid #888' }} />
                                  <span style={{ fontSize: 11, color: 'var(--text2)', textTransform: 'capitalize' }}>{color}</span>
                                </div>
                              </div>
                              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                                <button type="button" onClick={() => commitVariantStock(matrixKey, currentStock - 1)} aria-label={`Decrease ${size} ${color} stock`} style={{ width:32, height:32, flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', background:'var(--bg)', color:'var(--text2)', border:'1px solid var(--border)', borderRadius:4, cursor:'pointer', fontSize:18, lineHeight:1, padding:0, WebkitTapHighlightColor:'transparent', touchAction:'manipulation' }}>-</button>
                                <input type="number" min="0" value={currentStock} onChange={e => commitVariantStock(matrixKey, parseInt(e.target.value) || 0)} style={{ width:55, padding:'4px', textAlign:'center', borderRadius:4, border:'1px solid var(--border)', background:'var(--bg)', color:'var(--text)', fontSize:12 }} />
                                <button type="button" onClick={() => commitVariantStock(matrixKey, currentStock + 1)} aria-label={`Increase ${size} ${color} stock`} style={{ width:32, height:32, flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', background:'var(--gold)', color:'var(--bg)', border:'none', borderRadius:4, cursor:'pointer', fontSize:18, lineHeight:1, padding:0, WebkitTapHighlightColor:'transparent', touchAction:'manipulation' }}>+</button>
                              </div>
                            </div>
                          );
                        });
                      });
                      return rows;
                    })()}
                  </div>
                  <div style={{ marginTop:12, textAlign:'right', fontSize:12, color:'var(--text2)' }}>
                    Total Stock: <strong style={{ color:'var(--gold)' }}>{form.stock || 0}</strong> pcs
                  </div>
                </div>

                <div style={{ marginTop:12 }}>
                  <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, letterSpacing:1, textTransform:'uppercase' }}>Description</label>
                  <textarea value={form.description||''} onChange={e => update('description', e.target.value)} rows={3} style={{ width:'100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                </div>

                <div style={{ marginTop:14, border:'1px dashed var(--border)', padding:12, borderRadius:4 }}>
                  <label style={{ fontSize:10, color:'var(--gold)', display:'block', marginBottom:8, textTransform:'uppercase', fontWeight:600 }}>Size Guide Chart Image</label>
                  <ImageUploader maxImages={1} images={form.sizeGuide ? [form.sizeGuide] : []} onChange={imgs => update('sizeGuide', imgs[0] || null)} />
                </div>

                {/* Smart Size Recommendations */}
                <div style={{ marginTop:16, padding:12, background:'var(--bg3)', borderRadius:6, border:'1px solid var(--border)' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                    <label style={{ fontSize:11, color:'var(--gold)', letterSpacing:1, textTransform:'uppercase', fontWeight:600 }}>Smart Size Recommendations</label>
                    <span style={{ fontSize:9, color:'var(--text3)' }}>Optional</span>
                  </div>
                  {(() => {
                    const currentSizes = typeof form.sizes === 'string' 
                      ? form.sizes.split(',').map(s => s.trim()).filter(Boolean) 
                      : (Array.isArray(form.sizes) ? form.sizes : []);
                    
                    if (currentSizes.length === 0) {
                      return <p style={{ fontSize:11, color:'var(--text3)', textAlign:'center', padding:'10px 0' }}>Enter sizes above to configure recommendations</p>;
                    }
                    
                    const recs = form.sizeRecommendations && typeof form.sizeRecommendations === 'object' ? form.sizeRecommendations : {};
                    const updateRec = (size, field, value) => {
                      const updated = { ...(form.sizeRecommendations || {}) };
                      if (!updated[size]) updated[size] = {};
                      updated[size] = { ...updated[size], [field]: value };
                      update('sizeRecommendations', updated);
                    };
                    
                    return (
                      <div style={{ display:'grid', gap:10 }}>
                        <p style={{ fontSize:10, color:'var(--text3)', marginBottom:4 }}>Configure height and weight ranges (cm/kg) for each size</p>
                        {currentSizes.map(size => (
                          <div key={size} style={{ background:'var(--surface)', padding:'10px 12px', borderRadius:4, border:'1px solid var(--border)' }}>
                            <div style={{ fontSize:11, fontWeight:600, color:'var(--text)', marginBottom:8 }}>{size}</div>
                            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:6 }}>
                              <div>
                                <label style={{ fontSize:9, color:'var(--text3)', display:'block', marginBottom:3 }}>Height Min (cm)</label>
                                <input type="number" min="0" placeholder="e.g. 170" 
                                  value={recs[size]?.heightMin ?? ''} 
                                  onChange={e => updateRec(size, 'heightMin', e.target.value)}
                                  style={{ width:'100%', padding:'6px 8px', fontSize:11, borderRadius:4, border:'1px solid var(--border)', background:'var(--bg)', color:'var(--text)' }} />
                              </div>
                              <div>
                                <label style={{ fontSize:9, color:'var(--text3)', display:'block', marginBottom:3 }}>Height Max (cm)</label>
                                <input type="number" min="0" placeholder="e.g. 178" 
                                  value={recs[size]?.heightMax ?? ''} 
                                  onChange={e => updateRec(size, 'heightMax', e.target.value)}
                                  style={{ width:'100%', padding:'6px 8px', fontSize:11, borderRadius:4, border:'1px solid var(--border)', background:'var(--bg)', color:'var(--text)' }} />
                              </div>
                            </div>
                            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                              <div>
                                <label style={{ fontSize:9, color:'var(--text3)', display:'block', marginBottom:3 }}>Weight Min (kg)</label>
                                <input type="number" min="0" placeholder="e.g. 65" 
                                  value={recs[size]?.weightMin ?? ''} 
                                  onChange={e => updateRec(size, 'weightMin', e.target.value)}
                                  style={{ width:'100%', padding:'6px 8px', fontSize:11, borderRadius:4, border:'1px solid var(--border)', background:'var(--bg)', color:'var(--text)' }} />
                              </div>
                              <div>
                                <label style={{ fontSize:9, color:'var(--text3)', display:'block', marginBottom:3 }}>Weight Max (kg)</label>
                                <input type="number" min="0" placeholder="e.g. 75" 
                                  value={recs[size]?.weightMax ?? ''} 
                                  onChange={e => updateRec(size, 'weightMax', e.target.value)}
                                  style={{ width:'100%', padding:'6px 8px', fontSize:11, borderRadius:4, border:'1px solid var(--border)', background:'var(--bg)', color:'var(--text)' }} />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>

                <div style={{ marginTop:14 }}>
                  <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:10, textTransform:'uppercase' }}>Product Images</label>
                  <ImageUploader images={form.images||[]} onChange={imgs => update('images', imgs)} />
                </div>

                <div style={{ marginTop:14, display:'flex', alignItems:'center', gap:8 }}>
                  <input type="checkbox" id="active-toggle" checked={form.active} onChange={e => update('active', e.target.checked)} style={{ accentColor:'var(--gold)' }} />
                  <label htmlFor="active-toggle" style={{ fontSize:12, color:'var(--text2)', cursor:'pointer' }}>Active (visible in store)</label>
                </div>
              </div>
              <div style={{ padding:'12px 20px', borderTop:'1px solid var(--border)', display:'flex', gap:8, flexShrink:0 }}>
                <button 
                  className="gold-btn" 
                  style={{ flex:1, opacity: (form.salePrice && form.price && Number(form.salePrice) > Number(form.price)) ? 0.4 : 1, cursor: (form.salePrice && form.price && Number(form.salePrice) > Number(form.price)) ? 'not-allowed' : 'pointer' }} 
                  onClick={() => {
                    if (form.salePrice && form.price && Number(form.salePrice) > Number(form.price)) {
                      toast.error('عذراً، لا يمكن أن يكون سعر الخصم أكبر من السعر الأصلي'); return;
                    }
                    handleSave();
                  }}
                >
                  {editing ? 'Save' : 'Create'}
                </button>          
                <button className="outline-btn" onClick={handleCancel}>Cancel</button>
              </div>
            </div>
          </>
        )}

      <AnimatePresence>
        {showForm === false && showImport && (
          <>
            <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }} onClick={() => setShowImport(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2000 }} />
            <motion.div initial={{ opacity:0, scale:0.95 }} animate={{ opacity:1, scale:1 }} exit={{ opacity:0, scale:0.95 }} style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', width:540, maxWidth:'92vw', background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, padding:20, zIndex:2001, maxHeight:'85vh', overflowY:'auto' }}>
              <CSVImport onClose={() => setShowImport(false)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {productToDelete && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setProductToDelete(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.85)', zIndex: 3000, backdropFilter: 'blur(10px)' }} />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: "-50%", x: "-50%" }} animate={{ opacity: 1, scale: 1, y: "-50%", x: "-50%" }} exit={{ opacity: 0, scale: 0.9, y: "-50%", x: "-50%" }}
              transition={{ type: "spring", damping: 20, stiffness: 300 }}
              style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: '90%', maxWidth: 420, background: 'linear-gradient(180deg, #111111 0%, #000000 100%)', border: '1px solid rgba(201, 168, 76, 0.3)', borderRadius: 12, padding: '30px 20px', zIndex: 3001, textAlign: 'center' }}
            >
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(201, 168, 76, 0.08)', border: '1px solid rgba(201, 168, 76, 0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <Trash2 size={28} style={{ color: 'var(--gold)' }} />
              </div>
              <h3 style={{ color: '#ffffff', fontSize: 18, fontWeight: 500, marginBottom: 12, fontFamily: 'var(--font-display)', letterSpacing: 1 }}>تأكيد الحذف النهائي</h3>
              <p style={{ color: '#aaaaaa', fontSize: 13, marginBottom: 24, lineHeight: '1.6', direction: 'rtl' }}>هل أنت متأكد من حذف منتج <strong style={{ color: '#ffffff' }}>"{productToDelete.name}"</strong>؟ هذا الإجراء سيؤدي إلى إزالته نهائياً.</p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <button 
                  onClick={confirmSingleDelete}
                  style={{ flex: 1, padding: '10px 0', background: 'var(--gold)', border: 'none', color: '#000000', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}
                >
                  حذف
                </button>
                <button onClick={() => setProductToDelete(null)} style={{ flex: 1, padding: '10px 0', background: 'transparent', border: '1px solid #333333', color: '#ffffff', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>إلغاء</button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {confirmBulk !== null && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setConfirmBulk(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.85)', zIndex: 3000, backdropFilter: 'blur(10px)' }} />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: "-50%", x: "-50%" }} animate={{ opacity: 1, scale: 1, y: "-50%", x: "-50%" }} exit={{ opacity: 0, scale: 0.9, y: "-50%", x: "-50%" }}
              transition={{ type: "spring", damping: 20, stiffness: 300 }}
              style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: '90%', maxWidth: 420, background: 'linear-gradient(180deg, #111111 0%, #000000 100%)', border: '1px solid rgba(201, 168, 76, 0.3)', borderRadius: 12, padding: '30px 20px', zIndex: 3001, textAlign: 'center' }}
            >
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(201, 168, 76, 0.08)', border: '1px solid rgba(201, 168, 76, 0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <Trash2 size={28} style={{ color: 'var(--gold)' }} />
              </div>
              <h3 style={{ color: '#ffffff', fontSize: 18, fontWeight: 500, marginBottom: 12, fontFamily: 'var(--font-display)', letterSpacing: 1 }}>{confirmBulk === 1 ? 'تأكيد الحذف' : 'تأكيد الحذف الجماعي'}</h3>
              <p style={{ color: '#dddddd', fontSize: 13, marginBottom: 24, lineHeight: '1.6', direction: 'rtl' }}>
                {confirmBulk === 1
                  ? 'هل تريد حذف هذا المنتج؟'
                  : 'هل تريد حذف المنتجات التي اخترتها؟'}
              </p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <button 
                  onClick={confirmBulkDelete}
                  style={{ flex: 1, padding: '10px 0', background: 'var(--gold)', border: 'none', color: '#000000', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}
                >
                  Yes
                </button>
                <button onClick={() => setConfirmBulk(null)} style={{ flex: 1, padding: '10px 0', background: 'transparent', border: '1px solid #333333', color: '#ffffff', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>No</button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── DISCOUNTS PANEL ──────────────────────────────────────────────────────────
function DiscountsPanel({ canEdit }) {
  const { discounts, addDiscount, deleteDiscount, updateDiscount } = useStore();
  const [showForm, setShowForm] = useState(false);
  const [discountToDelete, setDiscountToDelete] = useState(null);
  const [form, setForm] = useState({ code:'', type:'percentage', value:'', startDate:'', endDate:'', usageLimit:100, description:'', active:true });
  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const tzOffset = (new Date()).getTimezoneOffset() * 60000;
  const today = (new Date(Date.now() - tzOffset)).toISOString().split('T')[0];

  const handleAdd = () => {
    if (!form.code || !form.code.trim()) { toast.error('يرجى إدخال كود الخصم.'); return; }
    const value = Number(form.value);
    if (!form.value || !Number.isFinite(value) || value <= 0) { toast.error('يرجى إدخال قيمة خصم صحيحة أكبر من صفر.'); return; }
    if (form.type === 'percentage' && value > 100) { toast.error('نسبة الخصم لا يمكن أن تتجاوز 100%.'); return; }
    if (!form.startDate || !form.endDate) { toast.error('يرجى تحديد تاريخ البداية والنهاية.'); return; }
    if (form.endDate < form.startDate) { toast.error('تاريخ النهاية يجب أن يكون بعد تاريخ البداية.'); return; }

    addDiscount({ 
      ...form, 
      value, 
      usageLimit: +form.usageLimit, 
      usageCount: 0, 
      code: form.code.trim().toUpperCase() 
    });
    
    setShowForm(false);
    setForm({ code:'', type:'percentage', value:'', startDate:'', endDate:'', usageLimit:100, description:'', active:true });
  };

  const handleDelete = (d) => setDiscountToDelete(d);

  const confirmDelete = async () => {
    if (!discountToDelete) return;
    const target = discountToDelete;
    setDiscountToDelete(null);
    try {
      await deleteDiscount(target.id);
      toast.success('تم حذف كود الخصم.');
    } catch (e) {
      toast.error('تعذر حذف كود الخصم، حاول مرة أخرى.');
    }
  };

  return (
    <div>
      {canEdit && (
        <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:16 }}>
          <button className="gold-btn" style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 16px' }} onClick={() => setShowForm(true)}>
            <Plus size={14} /> Create Discount
          </button>
        </div>
      )}
      <div style={{ display:'grid', gap:12 }}>
        {discounts.length === 0 && (
          <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10 }}>
            <DashEmpty
              icon={Tag}
              title="لا توجد كوبونات خصم"
              hint="أنشئ كود خصم لجذب المزيد من الطلبات."
              action={canEdit ? (
                <button className="gold-btn" style={{ marginTop:12, display:'inline-flex', alignItems:'center', gap:8, padding:'8px 16px' }} onClick={() => setShowForm(true)}>
                  <Plus size={14} /> إنشاء كود خصم
                </button>
              ) : null}
            />
          </div>
        )}
        {discounts.map(d => {
          const isActive = d.active && d.startDate <= today && d.endDate >= today;
          const currentUsage = d.usageCount || 0;
          const pct = d.usageLimit ? Math.round((currentUsage / d.usageLimit) * 100) : 0;
          
          const isExpiring = d.active && d.endDate && (new Date(d.endDate) - new Date()) < 7 * 24 * 60 * 60 * 1000 && (new Date(d.endDate) - new Date()) > 0;
          return (
            <motion.div key={d.id} initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }}
              style={{ background:'var(--surface)', border:`1px solid ${isActive ? 'var(--gold)' : 'var(--border)'}`, borderRadius:8, padding:'16px' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                  <code style={{ fontFamily:'monospace', fontSize:18, fontWeight:700, color: isActive ? 'var(--gold)' : 'var(--text3)', letterSpacing:2 }}>{d.code}</code>
                  <span style={{ padding:'2px 8px', borderRadius:10, fontSize:10, fontWeight:600, background: isActive ? 'rgba(39,174,96,0.12)' : 'rgba(100,100,100,0.1)', color: isActive ? '#27ae60' : 'var(--text3)' }}>
                    {isActive ? '● Active' : '○ Inactive'}
                  </span>
                  {isExpiring && <span style={{ padding:'2px 6px', borderRadius:10, fontSize:9, background:'rgba(243,156,18,0.15)', color:'#f39c12' }}>¼ Expiring</span>}
                </div>
                <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                  <span style={{ background:'rgba(201,168,76,0.1)', color:'var(--gold)', padding:'4px 10px', borderRadius:4, fontSize:12, fontWeight:700 }}>
                    {d.type === 'percentage' ? `${d.value}% OFF` : `EGP ${d.value}`}
                  </span>
                  {canEdit && (
                    <>
                      <button onClick={() => updateDiscount(d.id, { active: !d.active })}
                        style={{ padding:'4px 8px', background:'var(--bg4)', border:'1px solid var(--border)', color:'var(--text2)', borderRadius:4, cursor:'pointer', fontSize:11 }}>
                        Toggle
                      </button>
                      <button 
                        onClick={() => handleDelete(d)}
                        style={{ width:28, height:28, borderRadius:4, background:'rgba(192,57,43,0.1)', border:'1px solid rgba(192,57,43,0.2)', color:'var(--red)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', transition:'all 0.2s ease-in-out' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--gold)'; e.currentTarget.style.borderColor = 'var(--gold)'; e.currentTarget.style.color = '#111'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(192,57,43,0.1)'; e.currentTarget.style.borderColor = 'rgba(192,57,43,0.2)'; e.currentTarget.style.color = 'var(--red)'; }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </div>
              </div>
              {d.description && <p style={{ color:'var(--text3)', fontSize:12, marginTop:8 }}>{d.description}</p>}
              <div style={{ display:'flex', gap:16, marginTop:12, flexWrap:'wrap' }}>
                <span style={{ color:'var(--text3)', fontSize:11 }}>¼ {d.startDate} ➔ {d.endDate}</span>
                <span style={{ color:'var(--text3)', fontSize:11 }}>¼ {currentUsage}/{d.usageLimit} used</span>
              </div>
              <div style={{ marginTop:10, height:4, background:'var(--border)', borderRadius:3, overflow:'hidden' }}>
                <motion.div initial={{ width:0 }} animate={{ width:`${pct}%` }} transition={{ delay:0.2, duration:0.8 }}
                  style={{ height:'100%', background: pct > 80 ? '#e74c3c' : 'linear-gradient(to right, var(--gold-dark), var(--gold))', borderRadius:3 }} />
              </div>
            </motion.div>
          );
        })}
      </div>

      <AnimatePresence>
        {showForm && (
          <>
            <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }} onClick={() => setShowForm(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2000 }} />
            <motion.div 
              initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              style={{ position:'fixed', right:0, top:0, bottom:0, width:'100%', maxWidth:500, overflowY:'auto', background:'var(--bg2)', borderLeft:'1px solid var(--border)', padding:20, zIndex:2001, boxSizing:'border-box' }}
            >
              <h2 style={{ fontFamily:'var(--font-display)', fontSize:20, marginBottom:16 }}>Create Discount Code</h2>
              <div style={{ display:'grid', gap:12 }}>
                <div>
                  <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, textTransform:'uppercase' }}>Code *</label>
                  <input value={form.code} onChange={e => update('code', e.target.value.toUpperCase())} placeholder="SUMMER25" style={{ width:'100%', fontFamily:'monospace', letterSpacing:1 }} />
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr', gap:12 }}>
                  <div>
                    <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, textTransform:'uppercase' }}>Discount Type</label>
                    <select value={form.type} onChange={e => update('type', e.target.value)} style={{ width:'100%' }}>
                      <option value="percentage">Percentage (%)</option>
                      <option value="fixed">Fixed Amount (EGP)</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, textTransform:'uppercase' }}>Value *</label>
                    <input type="number" value={form.value} onChange={e => update('value', e.target.value)} style={{ width:'100%' }} placeholder="10" />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div>
                      <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, textTransform:'uppercase' }}>Start</label>
                      <input type="date" value={form.startDate} onChange={e => update('startDate', e.target.value)} style={{ width:'100%', fontSize:11 }} />
                    </div>
                    <div>
                      <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, textTransform:'uppercase' }}>End</label>
                      <input type="date" value={form.endDate} onChange={e => update('endDate', e.target.value)} style={{ width:'100%', fontSize:11 }} />
                    </div>
                  </div>
                </div>
                <div>
                  <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, textTransform:'uppercase' }}>Usage Limit</label>
                  <input type="number" value={form.usageLimit} onChange={e => update('usageLimit', e.target.value)} style={{ width:'100%' }} />
                </div>
                <div>
                  <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, textTransform:'uppercase' }}>Description</label>
                  <input value={form.description} onChange={e => update('description', e.target.value)} placeholder="Internal note" style={{ width:'100%' }} />
                </div>
              </div>
              <div style={{ display:'flex', gap:10, marginTop:20 }}>
                <button className="gold-btn" style={{ flex:1 }} onClick={handleAdd}>Create</button>
                <button className="outline-btn" onClick={() => setShowForm(false)}>Cancel</button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {discountToDelete && (
          <>
            <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }} onClick={() => setDiscountToDelete(null)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.85)', zIndex:3000, backdropFilter:'blur(10px)' }} />
            <motion.div
              initial={{ opacity:0, scale:0.9, y:'-50%', x:'-50%' }} animate={{ opacity:1, scale:1, y:'-50%', x:'-50%' }} exit={{ opacity:0, scale:0.9, y:'-50%', x:'-50%' }}
              transition={{ type:'spring', damping:20, stiffness:300 }}
              style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%, -50%)', width:'90%', maxWidth:420, background:'linear-gradient(180deg, #111111 0%, #000000 100%)', border:'1px solid rgba(201, 168, 76, 0.3)', borderRadius:12, padding:'30px 20px', zIndex:3001, textAlign:'center' }}
            >
              <div style={{ width:64, height:64, borderRadius:'50%', background:'rgba(201, 168, 76, 0.08)', border:'1px solid rgba(201, 168, 76, 0.2)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 16px' }}>
                <Trash2 size={28} style={{ color:'var(--gold)' }} />
              </div>
              <h3 style={{ color:'#ffffff', fontSize:18, fontWeight:500, marginBottom:12, fontFamily:'var(--font-display)', letterSpacing:1 }}>تأكيد حذف الكوبون</h3>
              <p style={{ color:'#aaaaaa', fontSize:13, marginBottom:24, lineHeight:'1.6', direction:'rtl' }}>هل أنت متأكد من حذف كود الخصم <strong style={{ color:'#ffffff' }}>"{discountToDelete.code}"</strong>؟ لا يمكن التراجع عن هذا الإجراء.</p>
              <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
                <button onClick={confirmDelete} style={{ flex:1, padding:'10px 0', background:'var(--gold)', border:'none', color:'#000000', borderRadius:6, fontWeight:600, cursor:'pointer', fontSize:13 }}>حذف</button>
                <button onClick={() => setDiscountToDelete(null)} style={{ flex:1, padding:'10px 0', background:'transparent', border:'1px solid #333333', color:'#ffffff', borderRadius:6, cursor:'pointer', fontSize:13 }}>إلغاء</button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── ANALYTICS PANEL ──────────────────────────────────────────────────────────
function AnalyticsPanel() {
  const { orders, products } = useStore();
  const [range, setRange] = useState('7d');

  const report = useMemo(
    () => computeAnalyticsReport(orders, products, range),
    [orders, products, range],
  );

  const rangeLabel = RANGE_OPTIONS.find((r) => r.key === range);
  const maxProductRevenue = useMemo(
    () => Math.max(...report.topProducts.map((p) => p.revenue), 1),
    [report.topProducts],
  );
  const maxCategoryRevenue = useMemo(
    () => Math.max(...report.categoryRevenue.map((c) => c.revenue), 1),
    [report.categoryRevenue],
  );
  const hasSeriesData = report.series.some((p) => p.value > 0 || p.orders > 0);

  const kpis = [
    { labelAr: 'إجمالي المبيعات', labelEn: 'Total Sales', value: fmtEGP(report.totalValue), sub: 'غير ملغي · COD', color: 'var(--gold)', icon: TrendingUp, delta: report.totalDeltaPct },
    { labelAr: 'الطلبات', labelEn: 'Orders', value: String(report.orderCount), sub: 'كل الحالات في الفترة', color: 'var(--text)', icon: ShoppingCart, delta: report.orderDeltaPct },
    { labelAr: 'متوسط قيمة الطلب', labelEn: 'Average Order Value', value: fmtEGP(report.aov), sub: 'Total Sales ÷ Orders', color: '#9b59b6', icon: BarChart2 },
    { labelAr: 'القطع المباعة', labelEn: 'Items Sold', value: report.itemsSold.toLocaleString('en-US'), sub: 'وحدات في الطلبات', color: '#3498db', icon: Package2 },
    { labelAr: 'عملاء مميزون', labelEn: 'Unique Customers', value: report.uniqueCustomers.toLocaleString('en-US'), sub: 'بـ رقم هاتف / اسم', color: '#16a085', icon: Users },
    { labelAr: 'معدل العملاء المتكررين', labelEn: 'Returning Customer Rate', value: `${report.returningRate}%`, sub: `${report.returningCustomers} بأكثر من طلب`, color: '#27ae60', icon: RefreshCw },
    { labelAr: 'معدل التسليم', labelEn: 'Fulfilment Rate', value: `${report.fulfilmentRate}%`, sub: `${report.fulfilledCount} delivered من ${report.orderCount}`, color: '#c9a84c', icon: CheckCircle },
    { labelAr: 'معدل الإلغاء', labelEn: 'Cancellation Rate', value: `${report.cancellationRate}%`, sub: `${report.cancelledCount} ملغي`, color: '#e74c3c', icon: XCircle },
  ];

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 2 }}>التحليلات</h2>
          <p style={{ fontSize: 11, color: 'var(--text3)' }}>
            Analytics · {rangeLabel ? `${rangeLabel.labelAr} (${rangeLabel.labelEn})` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 2, background: 'var(--bg)', padding: 2, borderRadius: 6, border: '1px solid var(--border)', overflowX: 'auto' }}>
          {RANGE_OPTIONS.map((r) => (
            <button key={r.key} onClick={() => setRange(r.key)}
              style={{ padding: '4px 10px', borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: 'pointer', border: 'none', background: range === r.key ? 'var(--gold)' : 'transparent', color: range === r.key ? 'var(--bg)' : 'var(--text3)', whiteSpace: 'nowrap' }}>
              {r.labelEn}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        {kpis.map(({ labelAr, labelEn, value, sub, color, icon: Icon, delta }, i) => (
          <motion.div key={labelEn} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 14px 12px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: `${color === 'var(--text)' ? '#2a2a2a' : color}1a`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon size={15} color={color === 'var(--text)' ? 'var(--text2)' : color} />
              </div>
              {delta !== undefined && <KpiDelta pct={delta} />}
            </div>
            <div dir="ltr" style={{ fontSize: 19, fontWeight: 600, fontFamily: 'var(--font-display)', color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
            <p style={{ fontSize: 12, fontWeight: 600, marginTop: 3 }}>{labelAr}</p>
            <p style={{ fontSize: 10, color: 'var(--text3)', marginTop: 1 }}>{labelEn} · {sub}</p>
          </motion.div>
        ))}
      </div>

      <Card title="المبيعات عبر الوقت" titleEn="Sales over time">
        <div style={{ width: '100%', height: 280 }}>
          {hasSeriesData ? (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={report.series} margin={{ left: -14, right: 4, top: 8 }}>
                <defs>
                  <linearGradient id="analyticsSalesGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#c9a84c" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#c9a84c" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: 'var(--text3)', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="left" orientation="left" tickFormatter={compactEGP} tick={{ fill: 'var(--text3)', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="right" orientation="right" allowDecimals={false} tick={{ fill: 'var(--text3)', fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip content={<SalesTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11, color: 'var(--text2)', marginTop: 8 }} iconType="circle" iconSize={7} />
                <Area yAxisId="left" type="monotone" dataKey="value" name="Sales (EGP)" stroke="#c9a84c" strokeWidth={2} fill="url(#analyticsSalesGrad)" dot={false} activeDot={{ r: 3 }} />
                <Bar yAxisId="right" dataKey="orders" name="Orders" fill="#3b82c4" radius={[3, 3, 0, 0]} barSize={Math.max(6, Math.min(30, Math.round(320 / (report.series.length || 1))))} />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <DashEmpty icon={BarChart2} title="لا توجد طلبات في هذه الفترة"
              hint="اختر نطاقًا زمنيًا آخر من الأعلى أو انتظر وصول أول طلب." />
          )}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text3)' }}>
          <span>Sales = إجمالي قيمة الطلبات غير الملغاة (COD — لا يُعدّ تحصيلًا نقديًا حتى التسليم).</span>
          <span style={{ color: 'var(--text2)', display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
            <span>المسلّم: <strong dir="ltr" style={{ color: '#27ae60' }}>{fmtEGP(report.deliveredSales)}</strong></span>
            <span>·</span>
            <span>بانتظار/معالجة: <strong dir="ltr" style={{ color: '#f39c12' }}>{fmtEGP(report.pendingValue)}</strong></span>
            <span>·</span>
            <span>ملغي: <strong dir="ltr" style={{ color: '#e74c3c' }}>{fmtEGP(report.cancelledValue)}</strong></span>
          </span>
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <Card title="الأكثر مبيعًا" titleEn="Top products by revenue">
          {report.topProducts.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text3)', padding: '8px 0' }}>لا توجد مبيعات في هذه الفترة.</p>
          ) : report.topProducts.map((p, i) => (
            <div key={`${p.name}-${i}`} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</p>
                  <p style={{ fontSize: 10, color: 'var(--text3)' }}>{p.category} · {p.count} sold</p>
                </div>
                <span dir="ltr" style={{ color: 'var(--gold)', fontSize: 12, flexShrink: 0 }}>{fmtEGP(p.revenue)}</span>
              </div>
              <div style={{ height: 4, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                <motion.div initial={{ width: 0 }} animate={{ width: `${(p.revenue / maxProductRevenue) * 100}%` }} transition={{ delay: 0.1 + i * 0.05, duration: 0.6 }}
                  style={{ height: '100%', background: 'linear-gradient(to right, var(--gold-dark), var(--gold))', borderRadius: 3 }} />
              </div>
            </div>
          ))}
        </Card>

        <Card title="الإيرادات حسب الفئة" titleEn="Revenue by category">
          {report.categoryRevenue.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text3)', padding: '8px 0' }}>لا توجد بيانات في هذه الفترة.</p>
          ) : report.categoryRevenue.map((c, i) => (
            <div key={`${c.name}-${i}`} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12 }}>{c.name}</span>
                <span dir="ltr" style={{ fontSize: 11, color: 'var(--text3)' }}>{fmtEGP(c.revenue)}</span>
              </div>
              <div style={{ height: 4, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                <motion.div initial={{ width: 0 }} animate={{ width: `${(c.revenue / maxCategoryRevenue) * 100}%` }} transition={{ delay: 0.1 + i * 0.05, duration: 0.6 }}
                  style={{ height: '100%', background: 'linear-gradient(to right, var(--gold-dark), var(--gold))', borderRadius: 3 }} />
              </div>
            </div>
          ))}
        </Card>
      </div>

      <Card title="حالة الطلبات" titleEn="Orders by status">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
          {report.statusBreakdown.map((s) => (
            <div key={s.status} style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLORS[s.status] || 'var(--text3)' }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)' }}>{s.status}</span>
              </div>
              <p style={{ fontSize: 18, fontWeight: 600, fontFamily: 'var(--font-display)', color: 'var(--text)' }}>{s.count}</p>
              <p dir="ltr" style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{fmtEGP(s.value)}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
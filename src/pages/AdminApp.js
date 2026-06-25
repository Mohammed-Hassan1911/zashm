import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard, Package, ShoppingCart, Tag, BarChart2,
  LogOut, Plus, Search, Edit, Trash2, Eye, Download, TrendingUp,
  AlertCircle, CheckCircle, Clock, Truck, XCircle, Bell, Users,
  Upload, Filter, RefreshCw, ChevronLeft, ChevronRight, Settings,
  ArrowUpRight, ArrowDownRight, Zap, Package2, Star, MoreVertical
} from 'lucide-react';
import { motion as m } from 'framer-motion';
import { useStore } from '../store';
import { useAuth } from '../lib/auth';
import { paginate, sanitizeInput, validateProductForm, setPageMeta } from '../lib/security';
import {
  computeLast7Days,
  computeDashboardStats,
  computeMonthlyPerformance,
  computeAnalyticsKPIs,
  computeTopProducts,
  computeCategoryRevenue,
} from '../lib/analytics';
import AdminLogin from '../components/admin/AdminLogin';
import ImageUploader from '../components/admin/ImageUploader';
import CSVImport from '../components/admin/CSVImport';
import UsersPanel from '../components/admin/UsersPanel';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area } from 'recharts';
import Papa from 'papaparse';
import { toast } from '../components/ui/BackToTop'; // استيراد الـ toast الفاخر الذكي مباشرة

const STATUS_COLORS = { Pending:'#f39c12', Confirmed:'#3498db', Processing:'#9b59b6', Shipped:'#c9a84c', Delivered:'#27ae60', Cancelled:'#e74c3c' };
const STATUS_FLOW = ['Pending','Confirmed','Processing','Shipped','Delivered'];
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
  const { adminPage, setAdminPage, setPage, orders, unreadOrderCount, markNotificationsRead, getNotifications, newOrderNotification } = useStore();
  const [collapsed, setCollapsed] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  useEffect(() => { setPageMeta({ title: 'Admin Panel', description: 'ZASHM Admin Dashboard' }); }, []);

  // Play sound on new order
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

  if (authLoading) return (
    <div style={{ height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--bg)' }}>
      <motion.div animate={{ rotate:360 }} transition={{ duration:1, repeat:Infinity, ease:'linear' }}
        style={{ width:32, height:32, border:'2px solid var(--border)', borderTopColor:'var(--gold)', borderRadius:'50%' }} />
    </div>
  );

  if (!session) return (
    <AdminLogin 
      onSuccess={(sessionData) => {
        console.log("🚀 [AdminApp] Authentication successful! Opening console via global state...");
      }} 
    />
  );

  const accessiblePages = SIDEBAR.filter(s => canAccess(s.id));
  const pendingCount = orders.filter(o => o.status === 'Pending').length;
  const notifications = getNotifications().slice(0, 8);

  return (
    <div style={{ display:'flex', minHeight:'100vh', background:'var(--bg)' }}>
      {/* Sidebar */}
      <motion.aside animate={{ width: collapsed ? 64 : 230 }}
        style={{ background:'var(--bg2)', borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', position:'sticky', top:0, height:'100vh', overflow:'hidden', flexShrink:0 }}>
        {/* Logo */}
        <div style={{ padding:'20px 14px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10, cursor:'pointer' }}
          onClick={() => setCollapsed(!collapsed)}>
          <div style={{ width:36, height:36, background:'linear-gradient(135deg, var(--gold-dark), var(--gold))', borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <span style={{ fontFamily:'var(--font-display)', fontSize:16, fontWeight:700, color:'var(--bg)' }}>Z</span>
          </div>
          {!collapsed && <div>
            <span style={{ fontFamily:'var(--font-display)', fontSize:17, fontWeight:600, letterSpacing:3 }} className="shimmer-text">ZASHM</span>
            <p style={{ fontSize:9, color:'var(--text3)', letterSpacing:1, textTransform:'uppercase' }}>Admin Console</p>
          </div>}
        </div>

        {/* Session Info */}
        {!collapsed && (
          <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--border)', background:'rgba(201,168,76,0.04)' }}>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <div style={{ width:28, height:28, borderRadius:'50%', background:'linear-gradient(135deg, var(--gold-dark), var(--gold))', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700, color:'var(--bg)', flexShrink:0 }}>
                {session.name[0]}
              </div>
              <div style={{ minWidth:0 }}>
                <p style={{ fontSize:12, fontWeight:500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{session.name}</p>
                <p style={{ fontSize:10, color:'var(--gold)', textTransform:'capitalize' }}>{session.role}</p>
              </div>
            </div>
          </div>
        )}

        {/* Nav */}
        <nav style={{ flex:1, padding:'10px 8px', overflowY:'auto' }}>
          {accessiblePages.map(({ id, label, icon:Icon, badge }) => {
            const active = adminPage === id;
            const badgeCount = badge === 'pending' ? pendingCount : 0;
            return (
              <motion.button key={id} onClick={() => setAdminPage(id)}
                style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding: collapsed ? '10px 14px' : '10px 12px', borderRadius:6, marginBottom:2, background: active ? 'rgba(201,168,76,0.12)' : 'transparent', color: active ? 'var(--gold)' : 'var(--text2)', border: `1px solid ${active ? 'rgba(201,168,76,0.2)' : 'transparent'}`, cursor:'pointer', transition:'all 0.15s', justifyContent: collapsed ? 'center' : 'flex-start', position:'relative' }}
                whileHover={{ color:'var(--gold)', background:'rgba(201,168,76,0.07)' }}>
                <Icon size={17} style={{ flexShrink:0 }} />
                {!collapsed && <span style={{ fontSize:13, fontWeight:500, whiteSpace:'nowrap' }}>{label}</span>}
                {!collapsed && badgeCount > 0 && <span style={{ marginLeft:'auto', background:'var(--gold)', color:'var(--bg)', borderRadius:10, padding:'1px 7px', fontSize:10, fontWeight:700 }}>{badgeCount}</span>}
                {collapsed && badgeCount > 0 && <span style={{ position:'absolute', top:6, right:6, width:8, height:8, background:'var(--gold)', borderRadius:'50%' }} />}
              </motion.button>
            );
          })}
        </nav>

        {/* Footer */}
        <div style={{ padding:'10px 8px', borderTop:'1px solid var(--border)' }}>
          <button onClick={() => setPage('home')} style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding: collapsed ? '10px 14px' : '10px 12px', borderRadius:6, color:'var(--text3)', background:'none', border:'none', cursor:'pointer', justifyContent: collapsed ? 'center' : 'flex-start' }}>
            <Package2 size={17} />
            {!collapsed && <span style={{ fontSize:13 }}>View Store</span>}
          </button>
          <button onClick={logout} style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding: collapsed ? '10px 14px' : '10px 12px', borderRadius:6, color:'var(--text3)', background:'none', border:'none', cursor:'pointer', justifyContent: collapsed ? 'center' : 'flex-start' }}>
            <LogOut size={17} />
            {!collapsed && <span style={{ fontSize:13 }}>Sign Out</span>}
          </button>
        </div>
      </motion.aside>

      {/* Main */}
      <main style={{ flex:1, overflow:'auto', minWidth:0 }}>
        {/* Top Bar */}
        <div style={{ position:'sticky', top:0, zIndex:100, background:'rgba(10,10,10,0.95)', backdropFilter:'blur(12px)', borderBottom:'1px solid var(--border)', padding:'14px 28px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <h1 style={{ fontFamily:'var(--font-display)', fontSize:22, fontWeight:500, textTransform:'capitalize' }}>{adminPage}</h1>
          </div>
          <div style={{ display:'flex', gap:10, alignItems:'center' }}>
            {/* New Order Alert */}
            <AnimatePresence>
              {newOrderNotification && (
                <motion.div initial={{ opacity:0, scale:0.8, x:20 }} animate={{ opacity:1, scale:1, x:0 }} exit={{ opacity:0, scale:0.8, x:20 }}
                  style={{ background:'rgba(201,168,76,0.1)', border:'1px solid var(--border-gold)', borderRadius:6, padding:'6px 12px', display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}
                  onClick={() => { setAdminPage('orders'); }}>
                  <motion.div animate={{ scale:[1,1.3,1] }} transition={{ repeat:2, duration:0.3 }} style={{ width:8, height:8, borderRadius:'50%', background:'var(--gold)' }} />
                  <span style={{ color:'var(--gold)', fontSize:12, fontWeight:600 }}>New order: {newOrderNotification.order?.id}</span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Notifications */}
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
                      style={{ position:'absolute', top:'100%', right:0, marginTop:8, width:320, background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, boxShadow:'0 12px 40px rgba(0,0,0,0.5)', zIndex:300, overflow:'hidden' }}>
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

        <div style={{ padding:28 }}>
          <AnimatePresence mode="wait">
            <motion.div key={adminPage} initial={{ opacity:0, y:12 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-12 }} transition={{ duration:0.25 }}>
              {adminPage === 'dashboard' && <Dashboard />}
              {adminPage === 'orders' && <OrdersPanel canEdit={canAccess('orders.write') || session?.role !== 'support'} />}
              {adminPage === 'products' && <ProductsPanel canEdit={canAccess('products.write')} />}
              {adminPage === 'discounts' && <DiscountsPanel canEdit={canAccess('discounts.write')} />}
              {adminPage === 'analytics' && <AnalyticsPanel />}
              {adminPage === 'users' && <UsersPanel />}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard() {
  const { orders, products, refreshOrders } = useStore();
  const [refreshing, setRefreshing] = useState(false);
  const [orderTab, setOrderTab] = useState('pending');

  const refresh = async () => {
    setRefreshing(true);
    await new Promise(r => setTimeout(r, 600));
    refreshOrders();
    setRefreshing(false);
  };

  const { totalRevenue, todayRevenue, todayOrders, pending, delivered, orderCount } = useMemo(
    () => computeDashboardStats(orders),
    [orders]
  );

  const lowStock = useMemo(
    () => (products || []).filter(p => (p.stock ?? 0) <= 5),
    [products]
  );

  const stats = useMemo(() => [
    { label:'Total Revenue', value:`EGP ${totalRevenue.toLocaleString()}`, sub:`+EGP ${todayRevenue.toLocaleString()} today`, icon:TrendingUp, color:'#27ae60', positive:true },
    { label:'Total Orders', value:orderCount, sub:`${todayOrders.length} today`, icon:ShoppingCart, color:'var(--gold)', positive:todayOrders.length > 0 },
    { label:'Pending', value:pending, sub:'Need attention', icon:Clock, color:'#f39c12', positive:false },
    { label:'Delivered', value:delivered, sub:`${Math.round(delivered/Math.max(orderCount,1)*100)}% completion`, icon:CheckCircle, color:'#27ae60', positive:true },
  ], [totalRevenue, todayRevenue, todayOrders, pending, delivered, orderCount]);

  const last7Days = useMemo(() => computeLast7Days(orders), [orders]);

  const filteredOrdersByTab = useMemo(() => {
    if (!orders) return [];
    if (orderTab === 'delivered') {
      return orders.filter(o => o.status === 'Delivered');
    }
    return orders.filter(o => o.status === 'Pending');
  }, [orders, orderTab]);

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:24 }}>
        <motion.button onClick={refresh} whileTap={{ scale:0.95 }}
          style={{ display:'flex', gap:6, alignItems:'center', padding:'8px 14px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:6, color:'var(--text2)', cursor:'pointer', fontSize:12 }}>
          <motion.div animate={{ rotate: refreshing ? 360 : 0 }} transition={{ duration:0.6, repeat: refreshing ? Infinity : 0, ease:'linear' }}>
            <RefreshCw size={13} />
          </motion.div>
          Refresh
        </motion.button>
      </div>

      {/* Stat Cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:16, marginBottom:28 }}>
        {stats.map(({ label, value, sub, icon:Icon, color, positive }, i) => (
          <motion.div key={label} initial={{ opacity:0, y:16 }} animate={{ opacity:1, y:0 }} transition={{ delay:i*0.07 }}
            style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:'20px 22px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:14 }}>
              <div style={{ width:40, height:40, borderRadius:8, background:`${color}1a`, display:'flex', alignItems:'center', justifyContent:'center' }}>
                <Icon size={18} color={color} />
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, color: positive ? '#27ae60' : 'var(--text3)' }}>
                {positive ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
              </div>
            </div>
            <p style={{ fontFamily:'var(--font-display)', fontSize:28, fontWeight:600, color, marginBottom:4 }}>{value}</p>
            <p style={{ color:'var(--text3)', fontSize:12, marginBottom:2 }}>{label}</p>
            <p style={{ color:'var(--text3)', fontSize:11 }}>{sub}</p>
          </motion.div>
        ))}
      </div>

      {/* Charts row */}
      <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:20, marginBottom:20 }}>
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:24 }}>
          <h3 style={{ fontSize:13, fontWeight:600, color:'var(--text2)', marginBottom:20 }}>7-Day Revenue & Orders</h3>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={last7Days}>
              <defs>
                <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--gold)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="var(--gold)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="day" tick={{ fill:'var(--text3)', fontSize:11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill:'var(--text3)', fontSize:11 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, color:'var(--text)', fontSize:12 }} />
              <Area type="monotone" dataKey="revenue" stroke="var(--gold)" strokeWidth={2} fill="url(#revenueGrad)" name="Revenue (EGP)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:24 }}>
          <h3 style={{ fontSize:13, fontWeight:600, color:'var(--text2)', marginBottom:16 }}>Order Status</h3>
          {['Pending','Confirmed','Processing','Shipped','Delivered','Cancelled'].map(s => {
            const count = (orders || []).filter(o => o.status === s).length;
            const pct = orderCount ? Math.round(count / orderCount * 100) : 0;
            return (
              <div key={s} style={{ marginBottom:10 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                  <span style={{ fontSize:11, color:STATUS_COLORS[s] }}>{s}</span>
                  <span style={{ fontSize:11, color:'var(--text3)' }}>{count} ({pct}%)</span>
                </div>
                <div style={{ height:4, background:'var(--border)', borderRadius:2, overflow:'hidden' }}>
                  <motion.div initial={{ width:0 }} animate={{ width:`${pct}%` }} transition={{ delay:0.3, duration:0.8 }}
                    style={{ height:'100%', background: STATUS_COLORS[s], borderRadius:2 }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom row */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:24 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, borderBottom:'1px solid var(--border)', paddingBottom:12, flexWrap:'wrap', gap:8 }}>
            <h3 style={{ fontSize:13, fontWeight:600, color:'var(--text2)' }}>Order Management</h3>
            <div style={{ display:'flex', gap:4, background:'var(--bg)', padding:2, borderRadius:4, border:'1px solid var(--border)' }}>
              <button onClick={() => setOrderTab('pending')}
                style={{ padding: '4px 12px', borderRadius: 3, fontSize: 10, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', cursor: 'pointer', border: 'none', background: orderTab === 'pending' ? 'var(--gold)' : 'transparent', color: orderTab === 'pending' ? 'var(--bg)' : 'var(--text3)', transition: 'all 0.2s' }}>
                Pending ({(orders || []).filter(o => o.status === 'Pending').length})
              </button>
              <button onClick={() => setOrderTab('delivered')}
                style={{ padding: '4px 12px', borderRadius: 3, fontSize: 10, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', cursor: 'pointer', border: 'none', background: orderTab === 'delivered' ? '#27ae60' : 'transparent', color: orderTab === 'delivered' ? 'white' : 'var(--text3)', transition: 'all 0.2s' }}>
                Delivered ({(orders || []).filter(o => o.status === 'Delivered').length})
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {filteredOrdersByTab.slice(0, 6).map(o => (
              <div key={o.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'9px 0', borderBottom:'1px solid var(--border)' }}>
                <div>
                  <p style={{ fontSize:12, fontWeight:600 }}>{o.customer}</p>
                  <p style={{ fontSize:10, color:'var(--text3)' }}>{o.id} · {o.date}</p>
                </div>
                <div style={{ textAlign:'right' }}>
                  <p style={{ color:'var(--gold)', fontSize:12 }}>EGP {o.total.toLocaleString()}</p>
                  <span style={{ fontSize:10, padding:'2px 7px', borderRadius:8, background:`${STATUS_COLORS[o.status]}1a`, color:STATUS_COLORS[o.status], fontWeight:600 }}>
                    {o.status === 'Delivered' ? '✓ Delivered' : o.status}
                  </span>
                </div>
              </div>
            ))}
            {filteredOrdersByTab.length === 0 && (
              <p style={{ color:'var(--text3)', textAlign:'center', fontSize:12, padding:'24px 0' }}>No {orderTab} orders found.</p>
            )}
          </div>
        </div>

        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:24 }}>
          <h3 style={{ fontSize:13, fontWeight:600, color:'var(--text2)', marginBottom:16 }}>
            Low Stock Alerts
            {lowStock.length > 0 && <span style={{ marginLeft:8, background:'rgba(243,156,18,0.15)', color:'#f39c12', padding:'2px 8px', borderRadius:8, fontSize:11 }}>{lowStock.length}</span>}
          </h3>
          {lowStock.length === 0 ? (
            <div style={{ textAlign:'center', padding:'24px 0' }}>
              <CheckCircle size={32} color="#27ae60" style={{ margin:'0 auto 8px', display:'block' }} />
              <p style={{ color:'#27ae60', fontSize:13 }}>All products well-stocked</p>
            </div>
          ) : lowStock.map(p => (
            <div key={p.id} style={{ display:'flex', justifyContent:'space-between', padding:'9px 0', borderBottom:'1px solid var(--border)', alignItems:'center' }}>
              <div>
                <p style={{ fontSize:12, fontWeight:500 }}>{p.name}</p>
                <p style={{ fontSize:10, color:'var(--text3)' }}>{p.sku || p.category}</p>
              </div>
              <span style={{ color: p.stock === 0 ? 'var(--red)' : '#f39c12', fontWeight:700, fontSize:12 }}>
                {p.stock === 0 ? 'OUT OF STOCK' : `${p.stock} left`}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── ORDERS PANEL ─────────────────────────────────────────────────────────────
function OrdersPanel({ canEdit }) {
  const { orders, updateOrderStatus } = useStore();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState(1);
  const PER_PAGE = 15;

  useEffect(() => {
    if (!selected) return;
    const updated = (orders || []).find(o => o.id === selected.id);
    if (updated) setSelected(updated);
  }, [orders, selected?.id]);

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
      <div style={{ display:'flex', gap:10, marginBottom:20, flexWrap:'wrap', alignItems:'center' }}>
        <div style={{ position:'relative', flex:1, minWidth:200 }}>
          <Search size={13} style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', color:'var(--text3)' }} />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search by name, ID, phone..." style={{ width:'100%', paddingLeft:34 }} />
        </div>
        <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
          {['All','Pending','Confirmed','Processing','Shipped','Delivered','Cancelled'].map(s => (
            <button key={s} onClick={() => { setStatusFilter(s); setPage(1); }}
              style={{ padding:'6px 12px', borderRadius:4, fontSize:11, fontWeight:500, background: statusFilter === s ? (s === 'All' ? 'var(--gold)' : STATUS_COLORS[s]) : 'var(--bg3)', color: statusFilter === s ? (s === 'All' ? 'var(--bg)' : 'white') : 'var(--text2)', border:'none', cursor:'pointer', transition:'all 0.15s', whiteSpace:'nowrap' }}>
              {s} {s !== 'All' && `(${orders.filter(o => o.status === s).length})`}
            </button>
          ))}
        </div>
        <button onClick={exportCSV}
          style={{ display:'flex', gap:6, alignItems:'center', padding:'8px 14px', background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--text2)', borderRadius:6, cursor:'pointer', fontSize:12, whiteSpace:'nowrap' }}>
          <Download size={13} /> Export CSV
        </button>
      </div>

      <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, overflow:'hidden' }}>
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ borderBottom:'1px solid var(--border)', background:'var(--bg3)' }}>
                {['Order ID','Customer','Items','Total','Status','Date','Actions'].map(h => (
                  <th key={h} style={{ padding:'11px 14px', textAlign:'left', fontSize:10, fontWeight:600, color:'var(--text3)', letterSpacing:1, textTransform:'uppercase', whiteSpace:'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginated.items.map(order => (
                <motion.tr key={order.id} initial={{ opacity:0 }} animate={{ opacity:1 }}
                  style={{ borderBottom:'1px solid var(--border)', transition:'background 0.1s' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <td style={{ padding:'11px 14px', fontSize:12, color:'var(--gold)', fontWeight:700, fontFamily:'monospace', verticalAlign: 'top' }}>{order.id}</td>
                  <td style={{ padding:'11px 14px', verticalAlign: 'top' }}>
                    <p style={{ fontSize:12, fontWeight:500 }}>{order.customer}</p>
                    <p style={{ fontSize:10, color:'var(--text3)' }}>📞 {order.phone}</p>
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

                  <td style={{ padding:'11px 14px', verticalAlign: 'top' }}>
                    <p style={{ fontSize:12, fontWeight:600 }}>EGP {order.total?.toLocaleString()}</p>
                    {order.discount > 0 && <p style={{ fontSize:10, color:'#27ae60', marginTop: 2 }}>-EGP {order.discount?.toLocaleString()}</p>}
                  </td>
                  <td style={{ padding:'11px 14px', verticalAlign: 'top' }}>
                    {canEdit ? (
                      <select value={order.status} onChange={e => updateOrderStatus(order.id, e.target.value)}
                        style={{ padding:'4px 8px', fontSize:11, background:'var(--bg3)', border:`1px solid ${STATUS_COLORS[order.status]}`, color:STATUS_COLORS[order.status], borderRadius:4, cursor:'pointer' }}>
                        {STATUS_FLOW.concat(['Cancelled']).map(s => <option key={s}>{s}</option>)}
                      </select>
                    ) : (
                      <span style={{ fontSize:11, padding:'3px 9px', borderRadius:10, background:`${STATUS_COLORS[order.status]}1a`, color:STATUS_COLORS[order.status], fontWeight:600 }}>
                        {order.status}
                      </span>
                    )}
                  </td>
                  <td style={{ padding:'11px 14px', fontSize:11, color:'var(--text3)', verticalAlign: 'top' }}>{order.date}</td>
                  <td style={{ padding:'11px 14px', verticalAlign: 'top' }}>
                    <button onClick={() => setSelected(order)}
                      style={{ width:28, height:28, borderRadius:4, background:'var(--bg4)', border:'1px solid var(--border)', color:'var(--text2)', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
                      <Eye size={12} />
                    </button>
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
        {paginated.totalPages > 1 && (
          <div style={{ padding:'12px 16px', borderTop:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <p style={{ color:'var(--text3)', fontSize:12 }}>Showing {(page-1)*PER_PAGE+1}–{Math.min(page*PER_PAGE, paginated.total)} of {paginated.total}</p>
            <div style={{ display:'flex', gap:6 }}>
              <button onClick={() => setPage(p => Math.max(1,p-1))} disabled={!paginated.hasPrev}
                style={{ width:30, height:30, borderRadius:4, background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--text2)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', opacity: paginated.hasPrev ? 1 : 0.4 }}>
                <ChevronLeft size={14} />
              </button>
              {[...Array(Math.min(5, paginated.totalPages))].map((_, i) => {
                const p = i + 1;
                return <button key={p} onClick={() => setPage(p)}
                  style={{ width:30, height:30, borderRadius:4, background: page === p ? 'var(--gold)' : 'var(--bg3)', border:'1px solid var(--border)', color: page === p ? 'var(--bg)' : 'var(--text2)', cursor:'pointer', fontSize:12 }}>{p}</button>;
              })}
              <button onClick={() => setPage(p => Math.min(paginated.totalPages,p+1))} disabled={!paginated.hasNext}
                style={{ width:30, height:30, borderRadius:4, background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--text2)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', opacity: paginated.hasNext ? 1 : 0.4 }}>
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Order Detail Modal */}
      <AnimatePresence>
        {selected && (
          <>
            <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }} onClick={() => setSelected(null)}
              style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2000, backdropFilter:'blur(4px)' }} />
            <motion.div initial={{ opacity:0, x:80 }} animate={{ opacity:1, x:0 }} exit={{ opacity:0, x:80 }}
              style={{ position:'fixed', right:0, top:0, bottom:0, width:480, background:'var(--bg2)', borderLeft:'1px solid var(--border)', zIndex:2001, overflow:'auto' }}>
              <div style={{ padding:'24px', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div>
                  <p style={{ fontSize:10, color:'var(--text3)', letterSpacing:2, textTransform:'uppercase', marginBottom:2 }}>Order Details</p>
                  <h2 style={{ fontFamily:'var(--font-display)', fontSize:22, color:'var(--gold)' }}>{selected.id}</h2>
                </div>
                <button onClick={() => setSelected(null)} style={{ width:32, height:32, borderRadius:6, background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--text2)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>✕</button>
              </div>
              <div style={{ padding:24 }}>
                <div style={{ marginBottom:24 }}>
                  <p style={{ fontSize:11, color:'var(--text3)', letterSpacing:1, textTransform:'uppercase', marginBottom:12 }}>Status Timeline</p>
                  <div style={{ display:'flex', alignItems:'center', gap:0 }}>
                    {STATUS_FLOW.map((s, i) => {
                      const reached = STATUS_FLOW.indexOf(selected.status) >= i;
                      return (
                        <React.Fragment key={s}>
                          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
                            <div style={{ width:24, height:24, borderRadius:'50%', background: reached ? STATUS_COLORS[s] : 'var(--bg3)', border:`2px solid ${reached ? STATUS_COLORS[s] : 'var(--border)'}`, display:'flex', alignItems:'center', justifyContent:'center' }}>
                              {reached && <span style={{ fontSize:9, color:'white' }}>✓</span>}
                            </div>
                            <p style={{ fontSize:8, color: reached ? STATUS_COLORS[s] : 'var(--text3)', textAlign:'center', whiteSpace:'nowrap' }}>{s}</p>
                          </div>
                          {i < STATUS_FLOW.length-1 && (
                            <div style={{ flex:1, height:2, background: STATUS_FLOW.indexOf(selected.status) > i ? 'var(--gold)' : 'var(--border)', marginBottom:16 }} />
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>

                <div style={{ background:'var(--bg3)', borderRadius:6, padding:16, marginBottom:16 }}>
                  <p style={{ fontSize:11, color:'var(--text3)', marginBottom:10, letterSpacing:1, textTransform:'uppercase' }}>Customer</p>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                    {[
                      ['Name', selected.customer],
                      ['Phone', selected.phone],
                      ['Alternate Phone', selected.phoneAlt || '—'], // عرض حقل الهاتف البديل هنا بوضوح 🎯
                      ['Email', selected.email||'—'],
                      ['Address', selected.address],
                      ['Date', selected.date]
                    ].map(([k,v]) => (
                      <div key={k} style={{ gridColumn: k === 'Address' ? 'span 2' : 'auto' }}>
                        <p style={{ fontSize:10, color:'var(--text3)', marginBottom:2 }}>{k}</p>
                       <p style={{ fontSize: 12, color: 'var(--text1)' }}>{v}</p>                     
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ marginBottom:16 }}>
                  <p style={{ fontSize:11, color:'var(--text3)', marginBottom:10, letterSpacing:1, textTransform:'uppercase' }}>Items</p>
                  {selected.items?.map((item, i) => (
                    <div key={i} style={{ display:'flex', gap:10, padding:'10px 0', borderBottom:'1px solid var(--border)' }}>
                      {item.image && <img src={item.image} alt={item.name} style={{ width:48, height:60, objectFit:'cover', borderRadius:3, flexShrink:0 }} />}
                      <div style={{ flex:1 }}>
                        <p style={{ fontSize:12, fontWeight:500 }}>{item.name}</p>
                        <p style={{ fontSize:11, color:'var(--text3)' }}>{item.size} · {item.color} · Qty: {item.qty}</p>
                      </div>
                      <p style={{ color:'var(--gold)', fontSize:12, fontWeight:600 }}>EGP {item.price?.toLocaleString()}</p>
                    </div>
                  ))}
                </div>

                <div style={{ background:'var(--bg3)', borderRadius:6, padding:16 }}>
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
                    <strong style={{ color:'var(--gold)', fontFamily:'var(--font-display)', fontSize:18 }}>EGP {selected.total?.toLocaleString()}</strong>
                  </div>
                </div>

                {canEdit && (
                  <div style={{ marginTop:16 }}>
                    <p style={{ fontSize:11, color:'var(--text3)', marginBottom:8, letterSpacing:1, textTransform:'uppercase' }}>Update Status</p>
                    <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                      {STATUS_FLOW.concat(['Cancelled']).filter(s => s !== selected.status).map(s => (
                        <button key={s} onClick={() => { updateOrderStatus(selected.id, s); }}
                          style={{ padding:'7px 14px', borderRadius:4, background:`${STATUS_COLORS[s]}1a`, border:`1px solid ${STATUS_COLORS[s]}`, color:STATUS_COLORS[s], cursor:'pointer', fontSize:11, fontWeight:600 }}>
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
function ProductsPanel({ canEdit }) {
  const { products, addProduct, updateProduct, deleteProduct, bulkDeleteProducts } = useStore();
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [productToDelete, setProductToDelete] = useState(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [page, setPage] = useState(1);
  const [form, setForm] = useState({ name:'',category:'',price:'',salePrice:'',stock:'',sizes:'S,M,L,XL',colors:'Black,White',label:'New Arrival',description:'',sku:'',images:[],active:true, variantStock:{} });
  const [formErrors, setFormErrors] = useState({});
  const PER_PAGE = 16;

  const filtered = products.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.sku?.includes(search) || p.category.toLowerCase().includes(search.toLowerCase()));
  const paginated = paginate(filtered, page, PER_PAGE);

  const update = (k, v) => { setForm(f => ({ ...f, [k]: v })); setFormErrors(e => ({ ...e, [k]: null })); };

  const openNew = () => {
    setEditing(null);
    setForm({ name:'',category:'',price:'',salePrice:'',stock:'',sizes:'S,M,L,XL',colors:'Black,White',label:'New Arrival',description:'',sku:'',images:[],active:true, variantStock:{} });
    setFormErrors({});
    setShowForm(true);
  };

  const openEdit = (p) => {
    setEditing(p);
    setForm({ 
      ...p, 
      salePrice: p.salePrice||'', 
      sizes: Array.isArray(p.sizes) ? p.sizes.join(',') : (p.sizes||''), 
      colors: Array.isArray(p.colors) ? p.colors.join(',') : (p.colors||''),
      variantStock: p.variantStock || {},
      label: p.label || ''
    });
    setFormErrors({});
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name || form.name.trim() === '') {
      toast.error('⚠️ عذراً، يرجى إدخال اسم المنتج أولاً قبل الحفظ.');
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

    const finalVariantStock = form.variantStock || {};
    const calculatedTotalStock = Object.keys(finalVariantStock).reduce((sum, key) => {
      const [sz, col] = key.split('-');
      if (cleanSizes.includes(sz) && cleanColors.includes(col)) {
        return sum + (parseInt(finalVariantStock[key]) || 0);
      }
      return sum;
    }, 0);

    const productData = {
      name: form.name.trim(),
      category: form.category || '',
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
      images: form.images,     
      sizeGuide: form.sizeGuide || null,
      label: form.label && form.label !== "" ? form.label : null
    };

    try {
      if (editing && editing.id) {
        await updateProduct(editing.id, productData);
        toast.success('تم تعديل المنتج ومزامنة المخزون بنجاح! 🔄');
      } else {
        await addProduct(productData);
        toast.success('تم إضافة المنتج الجديد للمتجر بنجاح! 🚀');
      }
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
      {/* Controls */}
      <div style={{ display:'flex', gap:10, marginBottom:20, flexWrap:'wrap', alignItems:'center' }}>
        <div style={{ position:'relative', flex:1, minWidth:200 }}>
          <Search size={13} style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', color:'var(--text3)' }} />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search by name, SKU, category..." style={{ width:'100%', paddingLeft:34 }} />
        </div>
        {selected.size > 0 && (
          <button onClick={() => { if(window.confirm(`Delete ${selected.size} products?`)) { bulkDeleteProducts([...selected]); clearSelect(); } }}
            style={{ display:'flex', gap:6, alignItems:'center', padding:'8px 14px', background:'rgba(192,57,43,0.1)', border:'1px solid rgba(192,57,43,0.3)', color:'var(--red)', borderRadius:6, cursor:'pointer', fontSize:12 }}>
            <Trash2 size={13} /> Delete {selected.size}
          </button>
        )}
        {canEdit && <>
          <button onClick={() => setShowImport(true)}
            style={{ display:'flex', gap:6, alignItems:'center', padding:'8px 14px', background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--text2)', borderRadius:6, cursor:'pointer', fontSize:12 }}>
            <Upload size={13} /> Import CSV
          </button>
          <button className="gold-btn" style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 18px' }} onClick={openNew}>
            <Plus size={14} /> Add Product
          </button>
        </>}
      </div>

      {/* Bulk select bar */}
      {paginated.items.length > 0 && (
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12 }}>
          <label style={{ display:'flex', gap:6, alignItems:'center', cursor:'pointer', fontSize:12, color:'var(--text3)' }}>
            <input type="checkbox" checked={selected.size === paginated.items.length && paginated.items.length > 0}
              onChange={e => e.target.checked ? selectAll() : clearSelect()}
              style={{ accentColor:'var(--gold)' }} />
            Select all on page
          </label>
          <span style={{ color:'var(--text3)', fontSize:12 }}>{filtered.length} products total</span>
        </div>
      )}

      {/* Product Grid */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(200px, 1fr))', gap:14 }}>
        {paginated.items.map(p => (
          <motion.div key={p.id} initial={{ opacity:0, scale:0.97 }} animate={{ opacity:1, scale:1 }}
            style={{ background:'var(--surface)', border:`2px solid ${selected.has(p.id) ? 'var(--gold)' : 'var(--border)'}`, borderRadius:6, overflow:'hidden', transition:'border-color 0.15s', position:'relative' }}>
            <div style={{ position:'absolute', top:8, left:8, zIndex:1 }}>
              <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)}
                style={{ accentColor:'var(--gold)', width:16, height:16 }} />
            </div>
            <div style={{ position:'relative', aspectRatio:'3/4', overflow:'hidden' }}>
              <img src={p.images?.[0]} alt={p.name} loading="lazy" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
              {p.stock <= 5 && (
                <div style={{ position:'absolute', top:8, right:8, background: p.stock === 0 ? 'var(--red)' : '#f39c12', color:'white', fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:2 }}>
                  {p.stock === 0 ? 'OUT' : `${p.stock} left`}
                </div>
              )}
              {canEdit && (
                <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.6)', display:'flex', alignItems:'center', justifyContent:'center', gap:10, opacity:0, transition:'opacity 0.2s' }}
                  onMouseEnter={e => e.currentTarget.style.opacity = 1} onMouseLeave={e => e.currentTarget.style.opacity = 0}>
                  
                  <button 
                    onClick={() => openEdit(p)} 
                    style={{ width:36, height:36, borderRadius:'50%', background:'var(--gold)', border:'none', color:'#000000', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', transition:'transform 0.2s' }}
                    onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.1)'}
                    onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                  >
                    <Edit size={14} />
                  </button>

                  <button 
                    onClick={() => setProductToDelete(p)} 
                    style={{ width:36, height:36, borderRadius:'50%', background:'#111111', border:'1px solid #333333', color:'#ffffff', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', transition:'all 0.2s' }}
                    onMouseEnter={e => {
                      e.currentTarget.style.transform = 'scale(1.1)';
                      e.currentTarget.style.borderColor = 'var(--gold)';
                      e.currentTarget.style.color = 'var(--gold)';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.transform = 'scale(1)';
                      e.currentTarget.style.borderColor = '#333333';
                      e.currentTarget.style.color = '#ffffff';
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
            <div style={{ padding:'10px 12px' }}>
              <p style={{ fontSize:11, color:'var(--text3)', marginBottom:2 }}>{p.category} · {p.sku}</p>
              <p style={{ fontSize:13, fontWeight:600, marginBottom:4, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{p.name}</p>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <span style={{ color:'var(--gold)', fontSize:12, fontWeight:600 }}>EGP {(p.salePrice||p.price).toLocaleString()}</span>
                <span style={{ fontSize:10, color: p.stock > 5 ? '#27ae60' : p.stock > 0 ? '#f39c12' : 'var(--red)', fontWeight:500 }}>
                  Stock: {p.stock}
                </span>
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Pagination */}
      {paginated.totalPages > 1 && (
        <div style={{ display:'flex', justifyContent:'center', gap:8, marginTop:24 }}>
          <button onClick={() => setPage(p => Math.max(1,p-1))} disabled={!paginated.hasPrev}
            style={{ padding:'7px 12px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, color:'var(--text2)', cursor:'pointer', opacity: paginated.hasPrev ? 1 : 0.4 }}>← Prev</button>
          <span style={{ padding:'7px 16px', fontSize:13, color:'var(--text2)' }}>Page {page} / {paginated.totalPages}</span>
          <button onClick={() => setPage(p => Math.min(paginated.totalPages,p+1))} disabled={!paginated.hasNext}
            style={{ padding:'7px 12px', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, color:'var(--text2)', cursor:'pointer', opacity: paginated.hasNext ? 1 : 0.4 }}>Next →</button>
        </div>
      )}

      {/* Product Form Modal */}
      <AnimatePresence>
        {showForm && (
          <>
            <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }} onClick={() => setShowForm(false)}
              style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2000, backdropFilter:'blur(4px)' }} />
            <motion.div initial={{ opacity:0, x:80 }} animate={{ opacity:1, x:0 }} exit={{ opacity:0, x:80 }}
              style={{ position:'fixed', right:0, top:0, bottom:0, width:560, background:'var(--bg2)', borderLeft:'1px solid var(--border)', zIndex:2001, display:'flex', flexDirection:'column', overflow:'hidden' }}>
              <div style={{ padding:'20px 24px', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0 }}>
                <h2 style={{ fontFamily:'var(--font-display)', fontSize:22 }}>{editing ? 'Edit Product' : 'New Product'}</h2>
                <button onClick={() => setShowForm(false)} style={{ color:'var(--text3)', background:'none', border:'none', cursor:'pointer', fontSize:20 }}>✕</button>
              </div>
              <div style={{ flex:1, overflowY:'auto', padding:'24px' }}>
                
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }}>Product Name *</label>
                    <input type="text" required value={form.name || ''} onChange={e => update('name', e.target.value)} placeholder="e.g., Basic T-Shirt" style={{ width: '100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }}>SKU / Code</label>
                    <input type="text" value={form.sku || ''} onChange={e => update('sku', e.target.value)} placeholder="TSH-BSC-01" style={{ width: '100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }}>Category *</label>
                    <input type="text" required value={form.category || ''} onChange={e => update('category', e.target.value)} placeholder="e.g., T-Shirts" style={{ width: '100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }}>Tags / Collection</label>
                    <input type="text" value={form.tags || ''} onChange={e => update('tags', e.target.value)} placeholder="Summer26, Cotton" style={{ width: '100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }}>Product Label (Filter) 🎯</label>
                    <select 
                      value={form.label || ''} 
                      onChange={e => update('label', e.target.value)}
                      style={{ width: '100%', padding: '9px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: form.label ? 'var(--gold)' : 'var(--text)', cursor: 'pointer', height: '37px' }}
                    >
                      <option value="">None (Standard)</option>
                      <option value="New Arrival">New Arrival</option>
                      <option value="Best Seller">Best Seller</option>
                      <option value="Featured">Featured</option>
                      <option value="Limited Edition">Limited Edition</option>
                    </select>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }}>Price (EGP) *</label>
                    <input type="number" required min="0" value={form.price || ''} onChange={e => update('price', Number(e.target.value) || 0)} placeholder="700" style={{ width: '100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }}>Sale Price (Optional)</label>
                    <input type="number" min="0" value={form.salePrice || ''} onChange={e => update('salePrice', e.target.value ? Number(e.target.value) : null)} placeholder="500" style={{ width: '100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                </div>
                
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginTop:14 }}>
                  <div>
                    <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, letterSpacing:1, textTransform:'uppercase' }}>Sizes (comma-separated)</label>
                    <input value={form.sizes||''} onChange={e => update('sizes', e.target.value)} placeholder="S,M,L,XL" style={{ width:'100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                  <div>
                    <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, letterSpacing:1, textTransform:'uppercase' }}>Colors (comma-separated)</label>
                    <input value={form.colors||''} onChange={e => update('colors', e.target.value)} placeholder="Black,White,Gold" style={{ width:'100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                  </div>
                </div>

                <div style={{ marginTop:20, padding:16, background:'var(--bg3)', borderRadius:6, border:'1px solid var(--border)' }}>
                  <label style={{ fontSize:11, color:'var(--gold)', display:'block', marginBottom:12, letterSpacing:1, textTransform:'uppercase', fontWeight:600 }}>🎨 Size & Color Stock Matrix *</label>
                  <div style={{ display:'grid', gap:10 }}>
                    {(() => {
                      const currentSizes = typeof form.sizes === 'string' ? form.sizes.split(',').map(s => s.trim()).filter(Boolean) : (Array.isArray(form.sizes) ? form.sizes : []);
                      const currentColors = typeof form.colors === 'string' ? form.colors.split(',').map(c => c.trim()).filter(Boolean) : (Array.isArray(form.colors) ? form.colors : []);
                      
                      if (currentSizes.length === 0 || currentColors.length === 0) {
                        return <p style={{ fontSize:11, color:'var(--text3)', textAlign:'center', padding:'10px 0' }}>Enter both sizes and colors above to generate stock fields</p>;
                      }

                      const rows = [];
                      currentSizes.forEach(size => {
                        currentColors.forEach(color => {
                          const matrixKey = `${size}-${color}`;
                          const currentStock = form.variantStock ? (form.variantStock[matrixKey] || 0) : 0;
                          
                          rows.push(
                            <div key={matrixKey} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', background:'var(--surface)', padding:'8px 12px', borderRadius:4, border:'1px solid var(--border)' }}>
                              <div style={{ display:'flex', gap:12, alignItems:'center' }}>
                                <span style={{ fontSize:12, fontWeight:600, color:'var(--text)', background:'var(--bg)', padding:'2px 6px', borderRadius:4 }}>{size}</span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: color.toLowerCase() === 'white' ? '#ffffff' : color.toLowerCase(), border: color.toLowerCase() === 'white' ? '1px solid #888' : '1px solid rgba(255,255,255,0.15)', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
                                  <span style={{ fontSize: 12, color: 'var(--text2)', textTransform: 'capitalize' }}>{color}</span>
                                </div>
                              </div>
                              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                                <span style={{ fontSize:11, color:'var(--text3)' }}>Stock:</span>
                                <input type="number" min="0" value={currentStock} onChange={e => {
                                  const qty = parseInt(e.target.value) || 0;
                                  const updatedMatrix = { ...(form.variantStock || {}), [matrixKey]: qty };
                                  update('variantStock', updatedMatrix);
                                  const totalStock = Object.keys(updatedMatrix).reduce((sum, key) => {
                                    const [sz, col] = key.split('-');
                                    if (currentSizes.includes(sz) && currentColors.includes(col)) {
                                      return sum + (updatedMatrix[key] || 0);
                                    }
                                    return sum;
                                  }, 0);
                                  update('stock', totalStock);
                                }} style={{ width:80, padding:'4px 8px', textAlign:'center', borderRadius:4, border:'1px solid var(--border)', background:'var(--bg)', color:'var(--text)' }} />
                              </div>
                            </div>
                          );
                        });
                      });
                      return rows;
                    })()}
                  </div>
                  <div style={{ marginTop:12, textAlign:'right', fontSize:12, color:'var(--text2)' }}>
                    Total Calculated Stock: <strong style={{ color:'var(--gold)' }}>{form.stock || 0}</strong> pcs
                  </div>
                </div>

                <div style={{ marginTop:14 }}>
                  <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, letterSpacing:1, textTransform:'uppercase' }}>Description</label>
                  <textarea value={form.description||''} onChange={e => update('description', e.target.value)} rows={3} style={{ width:'100%', padding: '8px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }} />
                </div>

                <div style={{ marginTop:16, border:'1px dashed var(--border)', padding:14, borderRadius:4, background:'rgba(255,255,255,0.01)' }}>
                  <label style={{ fontSize:10, color:'var(--gold)', display:'block', marginBottom:8, letterSpacing:1, textTransform:'uppercase', fontWeight:600 }}>Size Guide Chart Image</label>
                  <ImageUploader maxFiles={1} images={form.sizeGuide ? [form.sizeGuide] : []} onChange={imgs => update('sizeGuide', imgs[0] || null)} />
                </div>

                <div style={{ marginTop:16 }}>
                  <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:10, letterSpacing:1, textTransform:'uppercase' }}>Product Images</label>
                  <ImageUploader images={form.images||[]} onChange={imgs => update('images', imgs)} />
                </div>

                <div style={{ marginTop:14, display:'flex', alignItems:'center', gap:8 }}>
                  <input type="checkbox" id="active-toggle" checked={form.active} onChange={e => update('active', e.target.checked)} style={{ accentColor:'var(--gold)' }} />
                  <label htmlFor="active-toggle" style={{ fontSize:12, color:'var(--text2)', cursor:'pointer' }}>Active (visible in store)</label>
                </div>
              </div>
              <div style={{ padding:'16px 24px', borderTop:'1px solid var(--border)', display:'flex', gap:10, flexShrink:0 }}>
                <button className="gold-btn" style={{ flex:1 }} onClick={handleSave}>
                  {editing ? 'Save Changes' : 'Create Product'}
                </button>          
                <button className="outline-btn" onClick={() => setShowForm(false)}>Cancel</button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      
      {/* CSV Import Modal */}
      <AnimatePresence>
        {showForm === false && showImport && (
          <>
            <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }} onClick={() => setShowImport(false)}
              style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2000 }} />
            <motion.div initial={{ opacity:0, scale:0.95 }} animate={{ opacity:1, scale:1 }} exit={{ opacity:0, scale:0.95 }}
              style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', width:580, maxWidth:'90vw', background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, padding:32, zIndex:2001, maxHeight:'85vh', overflowY:'auto' }}>
              <CSVImport onClose={() => setShowImport(false)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* نافذة تأكيد الحذف الفاخرة */}
      <AnimatePresence>
        {productToDelete && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }} 
              onClick={() => setProductToDelete(null)}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.85)', zIndex: 3000, backdropFilter: 'blur(10px)' }} 
            />
            
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: "-50%", x: "-50%" }} 
              animate={{ opacity: 1, scale: 1, y: "-50%", x: "-50%" }} 
              exit={{ opacity: 0, scale: 0.9, y: "-50%", x: "-50%" }}
              transition={{ type: "spring", damping: 20, stiffness: 300 }}
              style={{ 
                position: 'fixed', 
                top: '50%', 
                left: '50%', 
                transform: 'translate(-50%, -50%)', 
                width: 450, 
                background: 'linear-gradient(180deg, #111111 0%, #000000 100%)', 
                border: '1px solid rgba(201, 168, 76, 0.3)', 
                borderRadius: 12, 
                padding: '40px 30px', 
                zIndex: 3001, 
                textAlign: 'center',
                boxShadow: '0 25px 60px rgba(0,0,0,0.8), 0 0 15px rgba(201, 168, 76, 0.1)'
              }}
            >
              <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'rgba(201, 168, 76, 0.08)', border: '1px solid rgba(201, 168, 76, 0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px' }}>
                <Trash2 size={36} strokeWidth={1.5} style={{ color: 'var(--gold)' }} />
              </div>

              <h3 style={{ color: '#ffffff', fontSize: 20, fontWeight: 500, marginBottom: 12, fontFamily: 'var(--font-display)', letterSpacing: 1.5, textTransform: 'uppercase' }}>
                تأكيد الحذف النهائي
              </h3>
              
              <p style={{ color: '#aaaaaa', fontSize: 14, marginBottom: 32, lineHeight: '1.8', padding: '0 10px', direction: 'rtl' }}>
                هل أنت متأكد من حذف منتج <strong style={{ color: '#ffffff', fontWeight: 600 }}>"{productToDelete.name}"</strong>
                <span style={{ color: 'var(--gold)', fontSize: 22, fontWeight: 700, marginRight: 4, marginLeft: 4, display: 'inline-block', transform: 'scaleX(-1)' }}>؟</span> 
                هذا الإجراء سيؤدي إلى إزالته نهائياً من المتجر، ولا يمكن التراجع عنه.
              </p>
              
              <div style={{ display: 'flex', gap: 15, justifyContent: 'center' }}>
                <motion.button 
                  whileHover={{ scale: 1.03, boxShadow: '0 5px 15px rgba(201, 168, 76, 0.2)' }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => {
                    deleteProduct(productToDelete.id);
                    setProductToDelete(null);
                    toast.success('تم حذف المنتج بنجاح');
                  }}
                  style={{ 
                    flex: 1, 
                    padding: '12px 0', 
                    background: 'var(--gold)', 
                    border: 'none', 
                    color: '#000000', 
                    borderRadius: 6, 
                    fontWeight: 600, 
                    cursor: 'pointer', 
                    fontSize: 14,
                    textTransform: 'uppercase',
                    letterSpacing: 1,
                    transition: 'background 0.2s'
                  }}
                >
                  حذف المنتج
                </motion.button>
                
                <motion.button 
                  whileHover={{ background: 'rgba(255, 255, 255, 0.05)' }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setProductToDelete(null)}
                  style={{ 
                    flex: 1, 
                    padding: '12px 0', 
                    background: 'transparent', 
                    border: '1px solid #333333', 
                    color: '#ffffff', 
                    borderRadius: 6, 
                    fontWeight: 500, 
                    cursor: 'pointer', 
                    fontSize: 14,
                    transition: 'border 0.2s'
                  }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = '#555555'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = '#333333'}
                >
                  إلغاء
                </motion.button>
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
  const [form, setForm] = useState({ code:'', type:'percentage', value:'', startDate:'', endDate:'', usageLimit:100, description:'', active:true });
  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const today = new Date().toISOString().split('T')[0];

  const handleAdd = () => {
    if (!form.code || !form.value || !form.startDate || !form.endDate) return;
    addDiscount({ ...form, value: +form.value, usageLimit: +form.usageLimit, code: form.code.toUpperCase() });
    setShowForm(false);
    setForm({ code:'', type:'percentage', value:'', startDate:'', endDate:'', usageLimit:100, description:'', active:true });
  };

  return (
    <div>
      {canEdit && (
        <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:20 }}>
          <button className="gold-btn" style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 20px' }} onClick={() => setShowForm(true)}>
            <Plus size={14} /> Create Discount
          </button>
        </div>
      )}
      <div style={{ display:'grid', gap:12 }}>
        {discounts.map(d => {
          const isActive = d.active && d.startDate <= today && d.endDate >= today;
          const pct = d.usageLimit ? Math.round((d.usageCount / d.usageLimit) * 100) : 0;
          const isExpiring = d.active && d.endDate && (new Date(d.endDate) - new Date()) < 7 * 24 * 60 * 60 * 1000 && (new Date(d.endDate) - new Date()) > 0;
          return (
            <motion.div key={d.id} initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }}
              style={{ background:'var(--surface)', border:`1px solid ${isActive ? 'var(--border-gold)' : 'var(--border)'}`, borderRadius:8, padding:'20px 24px' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12 }}>
                <div style={{ display:'flex', alignItems:'center', gap:14 }}>
                  <code style={{ fontFamily:'monospace', fontSize:20, fontWeight:700, color: isActive ? 'var(--gold)' : 'var(--text3)', letterSpacing:3 }}>{d.code}</code>
                  <span style={{ padding:'3px 10px', borderRadius:10, fontSize:11, fontWeight:600, background: isActive ? 'rgba(39,174,96,0.12)' : 'rgba(100,100,100,0.1)', color: isActive ? '#27ae60' : 'var(--text3)' }}>
                    {isActive ? '● Active' : '○ Inactive'}
                  </span>
                  {isExpiring && <span style={{ padding:'3px 8px', borderRadius:10, fontSize:10, background:'rgba(243,156,18,0.15)', color:'#f39c12' }}>⚠ Expiring soon</span>}
                </div>
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <span style={{ background:'rgba(201,168,76,0.1)', color:'var(--gold)', padding:'5px 14px', borderRadius:4, fontSize:14, fontWeight:700 }}>
                    {d.type === 'percentage' ? `${d.value}% OFF` : `EGP ${d.value} OFF`}
                  </span>
                  {canEdit && (
                    <>
                      <button onClick={() => updateDiscount(d.id, { active: !d.active })}
                        style={{ padding:'5px 10px', background:'var(--bg4)', border:'1px solid var(--border)', color:'var(--text2)', borderRadius:4, cursor:'pointer', fontSize:11 }}>
                        {d.active ? 'Disable' : 'Enable'}
                      </button>
                      <button onClick={() => deleteDiscount(d.id)}
                        style={{ width:30, height:30, borderRadius:4, background:'rgba(192,57,43,0.1)', border:'1px solid rgba(192,57,43,0.2)', color:'var(--red)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </div>
              </div>
              {d.description && <p style={{ color:'var(--text3)', fontSize:12, marginTop:8 }}>{d.description}</p>}
              <div style={{ display:'flex', gap:24, marginTop:12, flexWrap:'wrap' }}>
                <span style={{ color:'var(--text3)', fontSize:11 }}>📅 {d.startDate} → {d.endDate}</span>
                <span style={{ color:'var(--text3)', fontSize:11 }}>🎯 {d.usageCount}/{d.usageLimit} used</span>
              </div>
              <div style={{ marginTop:10, height:5, background:'var(--border)', borderRadius:3, overflow:'hidden' }}>
                <motion.div initial={{ width:0 }} animate={{ width:`${pct}%` }} transition={{ delay:0.2, duration:0.8 }}
                  style={{ height:'100%', background: pct > 80 ? '#e74c3c' : 'linear-gradient(to right, var(--gold-dark), var(--gold))', borderRadius:3 }} />
              </div>
              <p style={{ color:'var(--text3)', fontSize:10, marginTop:4 }}>{pct}% of usage limit reached</p>
            </motion.div>
          );
        })}
      </div>

      <AnimatePresence>
        {showForm && (
          <>
            <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }} onClick={() => setShowForm(false)}
              style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2000 }} />
            <motion.div initial={{ opacity:0, scale:0.95 }} animate={{ opacity:1, scale:1 }} exit={{ opacity:0, scale:0.95 }}
              style={{ position:'fixed', left:'50%', top:'5vh', transform:'translateX(-50%)', width:500, maxWidth:'90vw', maxHeight:'90vh', overflowY:'auto', background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, padding:32, zIndex:2001, boxSizing:'border-box' }}>
              <h2 style={{ fontFamily:'var(--font-display)', fontSize:22, marginBottom:24 }}>Create Discount Code</h2>
              <div style={{ display:'grid', gap:14 }}>
                <div>
                  <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, textTransform:'uppercase', letterSpacing:1 }}>Code *</label>
                  <input value={form.code} onChange={e => update('code', e.target.value.toUpperCase())} placeholder="SUMMER25" style={{ width:'100%', fontFamily:'monospace', letterSpacing:2, fontSize:15 }} />
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                  <div>
                    <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, textTransform:'uppercase', letterSpacing:1 }}>Discount Type</label>
                    <select value={form.type} onChange={e => update('type', e.target.value)} style={{ width:'100%' }}>
                      <option value="percentage">Percentage (%)</option>
                      <option value="fixed">Fixed Amount (EGP)</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, textTransform:'uppercase', letterSpacing:1 }}>Value *</label>
                    <input type="number" value={form.value} onChange={e => update('value', e.target.value)} style={{ width:'100%' }} placeholder={form.type === 'percentage' ? '10' : '150'} />
                  </div>
                  <div>
                    <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, textTransform:'uppercase', letterSpacing:1 }}>Start Date *</label>
                    <input type="date" value={form.startDate} onChange={e => update('startDate', e.target.value)} style={{ width:'100%' }} />
                  </div>
                  <div>
                    <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, textTransform:'uppercase', letterSpacing:1 }}>End Date *</label>
                    <input type="date" value={form.endDate} onChange={e => update('endDate', e.target.value)} style={{ width:'100%' }} />
                  </div>
                </div>
                <div>
                  <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, textTransform:'uppercase', letterSpacing:1 }}>Usage Limit</label>
                  <input type="number" value={form.usageLimit} onChange={e => update('usageLimit', e.target.value)} style={{ width:'100%' }} />
                </div>
                <div>
                  <label style={{ fontSize:10, color:'var(--text3)', display:'block', marginBottom:5, textTransform:'uppercase', letterSpacing:1 }}>Description</label>
                  <input value={form.description} onChange={e => update('description', v => update('description', e.target.value))} placeholder="Internal note" style={{ width:'100%' }} />
                </div>
              </div>
              <div style={{ display:'flex', gap:10, marginTop:20 }}>
                <button className="gold-btn" style={{ flex:1 }} onClick={handleAdd}>Create Discount</button>
                <button className="outline-btn" onClick={() => setShowForm(false)}>Cancel</button>
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
  const monthly = useMemo(() => computeMonthlyPerformance(orders), [orders]);
  const { totalRevenue, avgOrderValue, uniqueCustomers, convRate } = useMemo(() => computeAnalyticsKPIs(orders), [orders]);
  const topProducts = useMemo(() => computeTopProducts(orders, products), [orders, products]);
  const catRevenue = useMemo(() => computeCategoryRevenue(orders, products), [orders, products]);
  const maxRevenue = useMemo(() => Math.max(...catRevenue.map(c => c.revenue), 1), [catRevenue]);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 14 }}>
        {[
          { label: 'Avg Order Value', value: `EGP ${avgOrderValue.toLocaleString()}`, color: 'var(--gold)' },
          { label: 'Total Revenue', value: `EGP ${totalRevenue.toLocaleString()}`, color: '#27ae60' },
          { label: 'Unique Customers', value: uniqueCustomers, color: '#3498db' },
          { label: 'Conversion Rate', value: `${convRate}%`, color: '#9b59b6' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '18px 20px' }}>
            <p style={{ fontSize: 24, fontWeight: 600, color, marginBottom: 4 }}>{value}</p>
            <p style={{ color: 'var(--text3)', fontSize: 11 }}>{label}</p>
          </div>
        ))}
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 24 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 20 }}>Monthly Performance</h3>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={monthly}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="m" />
            <YAxis />
            <Tooltip contentStyle={{ background: '#1e1e1e', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }} itemStyle={{ color: '#ffffff' }} labelStyle={{ color: 'var(--gold)', fontWeight: 'bold' }} />
            <Bar dataKey="revenue" fill="var(--gold)" />
            <Bar dataKey="customers" fill="rgba(201,168,76,0.25)" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 24 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>Top Products (Real Sales)</h3>
          {topProducts.map((p, i) => (
            <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: i < topProducts.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div>
                <p style={{ fontSize: 12, fontWeight: 500 }}>{p.name}</p>
                <p style={{ fontSize: 10, color: 'var(--text3)' }}>{p.category}</p>
              </div>
              <span style={{ color: 'var(--gold)', fontSize: 12 }}>EGP {p.revenue.toLocaleString()}</span>
            </div>
          ))}
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 24 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>Revenue by Category</h3>
          {catRevenue.map((c, i) => (
            <div key={c.name} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12 }}>{c.name}</span>
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>EGP {c.revenue.toLocaleString()}</span>
              </div>
              <div style={{ height: 5, background: 'var(--border)', borderRadius: 3 }}>
                <motion.div initial={{ width: 0 }} animate={{ width: `${(c.revenue / maxRevenue) * 100}%` }} style={{ height: '100%', background: 'linear-gradient(to right, var(--gold-dark), var(--gold))', borderRadius: 3 }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
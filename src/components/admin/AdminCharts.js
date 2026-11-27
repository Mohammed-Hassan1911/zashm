import React from 'react';
import {
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Area, Legend,
} from 'recharts';
import { fmtEGP, compactEGP } from '../../lib/analytics';

function SalesTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 11, fontFamily: 'var(--font-body)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
      <p style={{ color: 'var(--text3)', marginBottom: 4 }}>{label}</p>
      {payload.map((p) => (
        <p key={String(p.dataKey)} style={{ color: p.color || 'var(--text)', display: 'flex', justifyContent: 'space-between', gap: 14 }}>
          <span>{p.name}</span>
          <strong>{String(p.dataKey) === 'value' ? fmtEGP(p.value) : `${p.value} order${p.value === 1 ? '' : 's'}`}</strong>
        </p>
      ))}
    </div>
  );
}

// Kept behind a dynamic import so the Orders, Products and Discounts screens
// never download the charting library. Named recharts exports stay available to
// any future caller through this wrapper.
export { ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, Legend };

export default function AdminCharts({ series = [], gradientId = 'salesGrad' }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={series} margin={{ left: -14, right: 4, top: 8 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--gold)" stopOpacity={0.35} />
            <stop offset="95%" stopColor="var(--gold)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="label" tick={{ fill: 'var(--text3)', fontSize: 11, fontFamily: 'var(--font-body)' }} axisLine={false} tickLine={false} />
        <YAxis yAxisId="left" orientation="left" tickFormatter={compactEGP} tick={{ fill: 'var(--text3)', fontSize: 11, fontFamily: 'var(--font-body)' }} axisLine={false} tickLine={false} />
        <YAxis yAxisId="right" orientation="right" allowDecimals={false} tick={{ fill: 'var(--text3)', fontSize: 11, fontFamily: 'var(--font-body)' }} axisLine={false} tickLine={false} />
        <Tooltip content={<SalesTooltip />} />
        <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'var(--font-body)', color: 'var(--text2)', marginTop: 8 }} iconType="circle" iconSize={7} />
        <Area yAxisId="left" type="monotone" dataKey="value" name="Sales (EGP)" stroke="var(--gold)" strokeWidth={2} fill={`url(#${gradientId})`} dot={false} activeDot={{ r: 3 }} />
        <Bar yAxisId="right" dataKey="orders" name="Orders" fill="rgba(201,168,76,0.62)" radius={[3, 3, 0, 0]} barSize={Math.max(6, Math.min(30, Math.round(320 / (series.length || 1))))} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
